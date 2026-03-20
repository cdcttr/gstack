/**
 * HTTP daemon for the mobile module.
 *
 * Mirrors browse/src/server.ts:
 * - POST /command (Bearer auth) → dispatch to READ/WRITE/META handler
 * - GET /health (no auth) → status JSON
 * - Idle timeout, buffer flush, error wrapping
 */

import * as fs from "fs";
import * as path from "path";
import { resolveConfig, ensureStateDir, readVersionHash, type MobileConfig } from "./config";
import { READ_COMMANDS, WRITE_COMMANDS, META_COMMANDS } from "./commands";
import { FlutterManager } from "./flutter-manager";
import { VmServiceClient } from "./vm-service";
import { AdbBridge } from "./adb-bridge";
import { handleSnapshot } from "./snapshot";
import { handleReadCommand } from "./read-commands";
import { handleWriteCommand } from "./write-commands";
import { handleMetaCommand } from "./meta-commands";
import { consoleBuffer, networkBuffer } from "./buffers";

// ── Routing ──

export function routeCommand(command: string): "read" | "write" | "meta" | null {
  if (command === "snapshot") return "read"; // snapshot is in READ_COMMANDS but handled separately
  if (READ_COMMANDS.has(command)) return "read";
  if (WRITE_COMMANDS.has(command)) return "write";
  if (META_COMMANDS.has(command)) return "meta";
  return null;
}

// ── Error wrapping ──

export function wrapError(err: Error): { error: string; hint?: string } {
  const msg = err.message;

  if (msg.includes("VM_SERVICE_DISCONNECTED")) {
    return {
      error: "App may have crashed or the VM Service connection was lost.",
      hint: "Check `console` for crash details, or restart the server.",
    };
  }

  if (msg.includes("Timeout")) {
    return {
      error: `Command timed out: ${msg}`,
      hint: "The app may be unresponsive. Try `status` to check app state.",
    };
  }

  if (msg.includes("Expression compilation error")) {
    return {
      error: `Dart evaluation failed: ${msg}`,
      hint: "evaluate() requires managed mode (flutter run --machine). In attach mode, some eval features may not work.",
    };
  }

  return { error: msg };
}

// ── Server ──

const IDLE_TIMEOUT_MS = parseInt(process.env.MOBILE_IDLE_TIMEOUT || "1800000", 10); // 30 min

async function main() {
  const config = resolveConfig();
  ensureStateDir(config);

  // Delete old logs
  for (const logFile of [config.consoleLog, config.networkLog]) {
    try { fs.unlinkSync(logFile); } catch {}
  }

  // Find available port
  const port = await findPort();
  const token = crypto.randomUUID();

  // Detect Flutter project directory
  const projectDir = process.env.MOBILE_PROJECT_DIR || config.projectDir;
  const pubspecPath = path.join(projectDir, "pubspec.yaml");
  if (!fs.existsSync(pubspecPath)) {
    console.error(`No pubspec.yaml found at ${projectDir}. Set MOBILE_PROJECT_DIR to your Flutter project root.`);
    process.exit(1);
  }

  // Create manager — it will ensure an emulator is running
  const vmService = new VmServiceClient();
  const fm = new FlutterManager(vmService);

  // Ensure emulator is running (launches one if needed, sets fm.adb)
  const preferredDevice = process.env.MOBILE_DEVICE_ID;
  const resolvedDeviceId = await fm.ensureEmulator(preferredDevice);
  fm.adb = new AdbBridge(resolvedDeviceId);
  const adb = fm.adb;

  // Build flutter args from env
  const flutterArgs: string[] = [];
  const extraArgs = process.env.MOBILE_FLUTTER_ARGS;
  if (extraArgs) flutterArgs.push(...extraArgs.split(/\s+/).filter(Boolean));

  console.log(`Launching flutter run on ${resolvedDeviceId} in ${projectDir}...`);
  await fm.launch(resolvedDeviceId, flutterArgs, projectDir);
  console.log(`Flutter app running. VM Service connected.`);

  fm.onExit(() => {
    console.log("Flutter process exited. Shutting down server.");
    process.exit(1);
  });

  // Track activity for idle timeout
  let lastActivity = Date.now();
  let consecutiveFailures = 0;

  // Command dispatcher (used by chain)
  async function executeCommand(command: string, args: string[]): Promise<string> {
    if (command === "snapshot") return handleSnapshot(fm, args);
    const route = routeCommand(command);
    switch (route) {
      case "read": return handleReadCommand(fm, adb, command, args);
      case "write": return handleWriteCommand(fm, adb, command, args);
      case "meta": return handleMetaCommand(fm, adb, command, args, executeCommand);
      default: throw new Error(`Unknown command: ${command}`);
    }
  }

  // Start HTTP server
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const url = new URL(req.url);
      lastActivity = Date.now();

      // Health check — no auth
      if (req.method === "GET" && url.pathname === "/health") {
        return Response.json({
          status: "ok",
          uptime: Math.floor(process.uptime()),
          device: resolvedDeviceId,
          appState: fm.appState.status,
        });
      }

      // Command endpoint — requires auth
      if (req.method === "POST" && url.pathname === "/command") {
        const authHeader = req.headers.get("authorization");
        if (authHeader !== `Bearer ${token}`) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        let body: { command: string; args: string[] };
        try {
          body = await req.json();
        } catch {
          return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }

        const { command, args } = body;
        if (!command) {
          return Response.json({ error: "Missing 'command' field" }, { status: 400 });
        }

        try {
          const result = await executeCommand(command, args || []);
          consecutiveFailures = 0;
          return new Response(result.endsWith("\n") ? result : result + "\n", {
            headers: { "Content-Type": "text/plain" },
          });
        } catch (err: any) {
          consecutiveFailures++;
          const wrapped = wrapError(err);
          if (consecutiveFailures >= 3) {
            wrapped.hint = (wrapped.hint || "") + " Multiple consecutive failures — consider restarting the server.";
          }
          return Response.json(wrapped, { status: 500 });
        }
      }

      return Response.json({ error: "Not found" }, { status: 404 });
    },
  });

  // Write state file atomically
  const stateData = JSON.stringify({
    pid: process.pid,
    port,
    token,
    deviceId: resolvedDeviceId,
    deviceName: resolvedDeviceId,
    vmServiceUri: vmService.uri,
    flutterPid: null, // TODO: expose from FlutterManager
    startedAt: new Date().toISOString(),
    binaryVersion: readVersionHash() || "dev",
  });
  const tmpFile = config.stateFile + ".tmp";
  fs.writeFileSync(tmpFile, stateData);
  fs.renameSync(tmpFile, config.stateFile);

  console.log(`Mobile server listening on http://127.0.0.1:${port}`);
  console.log(`State file: ${config.stateFile}`);

  // Idle timeout check
  setInterval(() => {
    if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
      console.log("Idle timeout reached. Shutting down.");
      fm.close().then(() => process.exit(0));
    }
  }, 60_000);

  // Buffer flush
  let lastConsoleFlushed = 0;
  let lastNetworkFlushed = 0;
  setInterval(() => {
    if (consoleBuffer.totalAdded > lastConsoleFlushed) {
      const entries = consoleBuffer.toArray().slice(lastConsoleFlushed);
      const text = entries.map((e) => `${new Date(e.timestamp).toISOString()} [${e.level}] ${e.text}`).join("\n");
      if (text) fs.appendFileSync(config.consoleLog, text + "\n");
      lastConsoleFlushed = consoleBuffer.totalAdded;
    }
    if (networkBuffer.totalAdded > lastNetworkFlushed) {
      const entries = networkBuffer.toArray().slice(lastNetworkFlushed);
      const text = entries.map((e) => `${e.method} ${e.url} ${e.status || "pending"}`).join("\n");
      if (text) fs.appendFileSync(config.networkLog, text + "\n");
      lastNetworkFlushed = networkBuffer.totalAdded;
    }
  }, 1_000);
}

async function findPort(): Promise<number> {
  const envPort = process.env.MOBILE_PORT;
  if (envPort) return parseInt(envPort, 10);

  // Try random ports until one works
  for (let i = 0; i < 20; i++) {
    const port = 10000 + Math.floor(Math.random() * 50000);
    try {
      const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("") });
      server.stop();
      return port;
    } catch {
      continue;
    }
  }
  throw new Error("Could not find available port");
}

// Only run when executed directly, not when imported for testing
if (import.meta.main) {
  main().catch((err) => {
    console.error("Server startup failed:", err);
    process.exit(1);
  });
}
