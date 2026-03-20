/**
 * META command handlers — lifecycle, screenshots, device management.
 */

import * as fs from "fs";
import * as path from "path";
import type { FlutterManager } from "./flutter-manager";
import { AdbBridge, type AdbDevice, type UiElement } from "./adb-bridge";
import type { SysUiRef } from "./flutter-manager";
import { handleSnapshot, diffSnapshots } from "./snapshot";

// ── Exported helpers (unit-testable) ──

export function parseChainInput(input: string): string[][] {
  let parsed: any;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error("Invalid JSON. Expected array of [command, ...args] arrays.");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Expected a JSON array of command arrays.");
  }
  for (const item of parsed) {
    if (!Array.isArray(item) || item.length === 0) {
      throw new Error("Each entry must be a non-empty array: [command, ...args]");
    }
  }
  return parsed;
}

export function formatStatus(info: {
  pid: number;
  uptime: number;
  deviceId: string;
  deviceName: string;
  appState: string;
  vmServiceUri: string | null;
}): string {
  const uptimeMin = Math.floor(info.uptime / 60);
  const uptimeSec = info.uptime % 60;
  const uptimeStr = uptimeMin > 0 ? `${uptimeMin}m ${uptimeSec}s` : `${uptimeSec}s`;
  return [
    `Status: ${info.appState}`,
    `Device: ${info.deviceId} (${info.deviceName})`,
    `Uptime: ${uptimeStr}`,
    `VM Service: ${info.vmServiceUri || "not connected"}`,
    `PID: ${info.pid}`,
  ].join("\n");
}

export function formatDeviceList(devices: AdbDevice[], currentId: string): string {
  if (devices.length === 0) return "No devices connected.";
  return devices
    .map((d) => {
      const marker = d.id === currentId ? " *" : "";
      return `  ${d.id} (${d.type})${marker}`;
    })
    .join("\n");
}

// ── Command handlers ──

export async function handleMetaCommand(
  fm: FlutterManager,
  adb: AdbBridge,
  command: string,
  args: string[],
  executeCommand?: (cmd: string, cmdArgs: string[]) => Promise<string>,
): Promise<string> {
  switch (command) {
    case "screenshot": return handleScreenshot(fm, adb, args);
    case "devices": return handleDevices(fm);
    case "device": return handleDevice(args);
    case "status": return handleStatus(fm);
    case "stop": return handleStop(fm);
    case "restart-app": return handleRestartApp(fm);
    case "rotate": return handleRotate(adb, args);
    case "chain": return handleChain(args, executeCommand);
    case "diff": return handleDiff(fm);
    case "sysui": return handleSysui(fm, adb);
    case "systrap": return handleSystrap(fm, adb, args);
    default:
      throw new Error(`Unknown meta command: ${command}`);
  }
}

async function handleScreenshot(fm: FlutterManager, adb: AdbBridge, args: string[]): Promise<string> {
  const outputPath = args.find((a) => !a.startsWith("-")) || `/tmp/mobile-screenshot-${Date.now()}.png`;

  const pngData = await adb.screencap();
  fs.writeFileSync(outputPath, pngData);
  return `Screenshot saved to ${outputPath} (${pngData.length} bytes)`;
}

async function handleDevices(fm: FlutterManager): Promise<string> {
  const devices = await AdbBridge.listDevices();
  return formatDeviceList(devices, fm.deviceId);
}

async function handleDevice(args: string[]): Promise<string> {
  if (!args[0]) return "Usage: device <id>";
  return `Switching to device ${args[0]} requires server restart. Use: stop, then relaunch with MOBILE_DEVICE_ID=${args[0]}`;
}

async function handleStatus(fm: FlutterManager): Promise<string> {
  return formatStatus({
    pid: process.pid,
    uptime: Math.floor(process.uptime()),
    deviceId: fm.deviceId,
    deviceName: fm.deviceName || fm.deviceId,
    appState: fm.appState.status,
    vmServiceUri: fm.vmService.uri,
  });
}

async function handleStop(fm: FlutterManager): Promise<string> {
  // Run full teardown synchronously before returning.
  // The HTTP response will be slightly delayed but the teardown completes fully.
  await fm.close();
  // Schedule exit after response sends
  setTimeout(() => process.exit(0), 100);
  return "Server stopped. App and emulator shut down.";
}

async function handleRestartApp(fm: FlutterManager): Promise<string> {
  const result = await fm.hotRestart();
  return result.message;
}

async function handleRotate(adb: AdbBridge, args: string[]): Promise<string> {
  const orientation = args[0]?.toLowerCase();
  if (orientation === "portrait") {
    await adb.setRotation(0);
    return "Rotated to portrait";
  } else if (orientation === "landscape") {
    await adb.setRotation(1);
    return "Rotated to landscape";
  }
  return "Usage: rotate <portrait|landscape>";
}

async function handleChain(
  args: string[],
  executeCommand?: (cmd: string, cmdArgs: string[]) => Promise<string>,
): Promise<string> {
  const input = args[0] || (typeof Bun !== "undefined" ? await Bun.stdin.text() : "");
  const commands = parseChainInput(input);

  if (!executeCommand) {
    return "Chain execution requires a command dispatcher (internal error).";
  }

  const results: string[] = [];
  for (const [cmd, ...cmdArgs] of commands) {
    try {
      const result = await executeCommand(cmd, cmdArgs);
      results.push(`[${cmd}] ${result}`);
    } catch (e: any) {
      results.push(`[${cmd}] ERROR: ${e.message}`);
      return results.join("\n\n") + "\n\nChain stopped on error.";
    }
  }
  return results.join("\n\n");
}

async function handleDiff(fm: FlutterManager): Promise<string> {
  // Take a fresh snapshot and diff against last
  const currentSnapshot = await handleSnapshot(fm, []);
  const previous = fm.refs.lastSnapshot;
  if (!previous) return "No previous snapshot to diff against. This is the first snapshot.";
  const diff = diffSnapshots(currentSnapshot, previous);
  return diff || "No changes.";
}

async function handleSysui(fm: FlutterManager, adb: AdbBridge): Promise<string> {
  const xml = await adb.uiautomatorDump();
  const elements = AdbBridge.parseUiAutomatorXml(xml);

  const refs = new Map<string, SysUiRef>();
  const lines: string[] = [];
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    const ref = `@s${i + 1}`;
    refs.set(ref, { text: el.text, className: el.className, bounds: el.bounds });
    lines.push(`  ${ref} [${el.className.split(".").pop()}] "${el.text}" (${el.bounds.x},${el.bounds.y})`);
  }

  fm.refs.setSysUiRefs(refs);

  if (lines.length === 0) return "No interactive system UI elements found.";
  return lines.join("\n");
}

async function handleSystrap(fm: FlutterManager, adb: AdbBridge, args: string[]): Promise<string> {
  const target = args[0];
  if (!target || !target.startsWith("@s")) return "Usage: systrap <@sN>";

  const ref = fm.refs.getSysUiRef(target);
  if (!ref) return `Ref ${target} not found. Run sysui to refresh system UI refs.`;

  await adb.tap(ref.bounds.x, ref.bounds.y);
  return `Tapped ${target} ("${ref.text}" at ${ref.bounds.x},${ref.bounds.y})`;
}
