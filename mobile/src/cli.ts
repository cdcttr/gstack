/**
 * Thin CLI proxy for the mobile module.
 *
 * Mirrors browse/src/cli.ts:
 * - Reads state file, health check, starts server if needed
 * - POSTs commands, prints results
 * - Manages server lifecycle
 */

import * as fs from "fs";
import * as path from "path";
import { resolveConfig, readVersionHash } from "./config";
import { COMMAND_DESCRIPTIONS, ALL_COMMANDS } from "./commands";

// ── State file parsing ──

export interface ServerState {
  pid: number;
  port: number;
  token: string;
  deviceId: string;
  flutterPid: number | null;
  startedAt: string;
  binaryVersion: string;
}

export function parseStateFile(json: string): ServerState {
  let data: any;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error("Invalid state file JSON");
  }

  if (!data.pid || !data.port || !data.token) {
    throw new Error("State file missing required fields (pid, port, token)");
  }

  return data as ServerState;
}

// ── Help text ──

export function generateHelpText(): string {
  const categories = new Map<string, string[]>();
  for (const [cmd, desc] of Object.entries(COMMAND_DESCRIPTIONS)) {
    const cat = desc.category;
    if (!categories.has(cat)) categories.set(cat, []);
    const usage = desc.usage ? `  ${desc.usage}` : "";
    categories.get(cat)!.push(`  ${cmd.padEnd(14)} ${desc.description}${usage ? "\n" + " ".repeat(16) + usage : ""}`);
  }

  const lines = ["gstack mobile — Flutter app automation for Claude\n", "Commands:\n"];
  for (const [cat, cmds] of categories) {
    lines.push(`  ${cat}:`);
    lines.push(...cmds);
    lines.push("");
  }
  return lines.join("\n");
}

// ── Server lifecycle ──

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readState(config: ReturnType<typeof resolveConfig>): ServerState | null {
  try {
    const json = fs.readFileSync(config.stateFile, "utf-8");
    return parseStateFile(json);
  } catch {
    return null;
  }
}

async function healthCheck(state: ServerState): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${state.port}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

function startServer(config: ReturnType<typeof resolveConfig>): void {
  const serverScript = path.resolve(path.dirname(import.meta.dir || __dirname), "src", "server.ts");

  const proc = Bun.spawn(["bun", "run", serverScript], {
    env: { ...process.env, MOBILE_STATE_FILE: config.stateFile },
    stdout: "ignore",
    stderr: "ignore",
  });

  proc.unref();
}

async function ensureServer(config: ReturnType<typeof resolveConfig>): Promise<ServerState> {
  let state = readState(config);

  if (state) {
    // Check binary version — restart if mismatched
    const currentVersion = readVersionHash();
    if (currentVersion && state.binaryVersion !== currentVersion && state.binaryVersion !== "dev") {
      try { process.kill(state.pid); } catch {}
      state = null;
    }
  }

  if (state && isProcessAlive(state.pid)) {
    const healthy = await healthCheck(state);
    if (healthy) return state;
  }

  // Start new server
  startServer(config);

  // Poll for state file (Flutter startup is slow)
  const timeout = 30_000;
  const interval = 200;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    await new Promise((r) => setTimeout(r, interval));
    state = readState(config);
    if (state && isProcessAlive(state.pid)) {
      const healthy = await healthCheck(state);
      if (healthy) return state;
    }
  }

  throw new Error("Timeout waiting for mobile server to start (30s). Check `flutter run` logs.");
}

async function sendCommand(state: ServerState, command: string, args: string[]): Promise<void> {
  const url = `http://127.0.0.1:${state.port}/command`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${state.token}`,
      },
      body: JSON.stringify({ command, args }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e: any) {
    if (e.name === "AbortError") {
      process.stderr.write(`Command timed out (60s): ${command}\n`);
      process.exit(1);
    }
    // Connection refused — server may have crashed
    process.stderr.write(`Connection failed: ${e.message}\n`);
    process.exit(1);
  }

  if (response.status === 401) {
    // Token mismatch — re-read state and retry once
    const config = resolveConfig();
    const newState = readState(config);
    if (newState && newState.token !== state.token) {
      return sendCommand(newState, command, args);
    }
    process.stderr.write("Authentication failed. Server may have restarted.\n");
    process.exit(1);
  }

  if (response.ok) {
    const text = await response.text();
    process.stdout.write(text.endsWith("\n") ? text : text + "\n");
  } else {
    try {
      const err = await response.json() as { error: string; hint?: string };
      process.stderr.write(err.error + "\n");
      if (err.hint) process.stderr.write(`Hint: ${err.hint}\n`);
    } catch {
      process.stderr.write(`Server error (${response.status})\n`);
    }
    process.exit(1);
  }
}

// ── Main ──

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const cmdArgs = args.slice(1);

  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(generateHelpText());
    return;
  }

  if (!ALL_COMMANDS.has(command) && command !== "help") {
    process.stderr.write(`Unknown command: ${command}\nRun 'mobile help' for usage.\n`);
    process.exit(1);
  }

  // Handle chain stdin
  if (command === "chain" && cmdArgs.length === 0) {
    const stdin = await Bun.stdin.text();
    cmdArgs.push(stdin);
  }

  const config = resolveConfig();
  const state = await ensureServer(config);
  await sendCommand(state, command, cmdArgs);
}

main().catch((err) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});
