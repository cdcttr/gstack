/**
 * READ command handlers — inspect state, no side effects.
 *
 * Each handler returns a plain text string for Claude.
 * snapshot is handled in snapshot.ts, not here.
 */

import type { FlutterManager } from "./flutter-manager";
import type { AdbBridge } from "./adb-bridge";
import type { WidgetRef } from "./flutter-manager";
import { consoleBuffer, networkBuffer, type LogEntry, type NetworkEntry } from "./buffers";

// ── Exported pure helpers (unit-testable) ──

export function formatConsoleEntries(entries: LogEntry[]): string {
  if (entries.length === 0) return "No console output.";
  return entries
    .map((e) => {
      const ts = new Date(e.timestamp).toISOString().substring(11, 23);
      return `${ts} [${e.level}] ${e.text}`;
    })
    .join("\n");
}

export function formatNetworkEntries(entries: NetworkEntry[]): string {
  if (entries.length === 0) return "No network requests recorded.";
  return entries
    .map((e) => {
      const status = e.status ?? "pending";
      const duration = e.duration != null ? `${e.duration}ms` : "...";
      const size = e.size != null ? ` (${e.size}B)` : "";
      return `${e.method} ${e.url} → ${status} ${duration}${size}`;
    })
    .join("\n");
}

export interface IsResult {
  found: boolean;
  ref?: string;
  description?: string;
}

export function matchIsCondition(condition: string, refMap: Map<string, WidgetRef>): IsResult {
  const lower = condition.toLowerCase();

  for (const [ref, widget] of refMap) {
    const descLower = widget.description.toLowerCase();
    const typeLower = widget.type.toLowerCase();

    // Match "button labeled X" or "X button" or just "X"
    if (descLower.includes(lower) || lower.includes(descLower)) {
      return { found: true, ref, description: `${widget.type} "${widget.description}"` };
    }

    // Match by type + label: "button labeled Sign In"
    const labeledMatch = lower.match(/(\w+)\s+labeled\s+(.+)/);
    if (labeledMatch) {
      const [, typeQuery, labelQuery] = labeledMatch;
      if (typeLower.includes(typeQuery) && descLower.includes(labelQuery.toLowerCase())) {
        return { found: true, ref, description: `${widget.type} "${widget.description}"` };
      }
    }
  }

  return { found: false };
}

// ── Command handlers ──

export async function handleReadCommand(
  fm: FlutterManager,
  adb: AdbBridge,
  command: string,
  args: string[],
): Promise<string> {
  switch (command) {
    case "text":
      return handleText(fm);
    case "widgets":
      return handleWidgets(fm, args);
    case "eval":
      return handleEval(fm, args);
    case "console":
      return handleConsole(args);
    case "network":
      return handleNetwork(args);
    case "perf":
      return handlePerf(fm);
    case "storage":
      return handleStorage(fm);
    case "is":
      return handleIs(fm, args);
    default:
      throw new Error(`Unknown read command: ${command}`);
  }
}

async function handleText(fm: FlutterManager): Promise<string> {
  // Use debugDumpApp and extract text-bearing widgets
  const dump = await fm.vmService.dumpWidgetTree();
  // Extract Text widget content from the dump
  const textLines: string[] = [];
  const regex = /Text\("([^"]+)"/g;
  let match;
  while ((match = regex.exec(dump)) !== null) {
    textLines.push(match[1]);
  }
  if (textLines.length === 0) return "No visible text found.";
  return textLines.join("\n");
}

async function handleWidgets(fm: FlutterManager, args: string[]): Promise<string> {
  const query = args.join(" ").toLowerCase();
  if (!query) return "Usage: widgets <type|key>";

  const refMap = fm.refs.widgetRefs;
  const matches: string[] = [];
  for (const [ref, widget] of refMap) {
    if (
      widget.type.toLowerCase().includes(query) ||
      widget.description.toLowerCase().includes(query)
    ) {
      matches.push(`${ref} [${widget.type}] "${widget.description}"`);
    }
  }

  if (matches.length === 0) return `No widgets matching "${query}" found. Run snapshot first.`;
  return matches.join("\n");
}

async function handleEval(fm: FlutterManager, args: string[]): Promise<string> {
  const expression = args.join(" ");
  if (!expression) return "Usage: eval <dart expression>";
  try {
    return await fm.evaluate(expression);
  } catch (e: any) {
    throw new Error(`Evaluate failed: ${e.message}`);
  }
}

function handleConsole(args: string[]): string {
  if (args.includes("--clear")) {
    consoleBuffer.clear();
    return "Console buffer cleared.";
  }
  const entries = consoleBuffer.last(100);
  return formatConsoleEntries(entries);
}

function handleNetwork(args: string[]): string {
  if (args.includes("--clear")) {
    networkBuffer.clear();
    return "Network buffer cleared.";
  }
  const entries = networkBuffer.last(50);
  return formatNetworkEntries(entries);
}

async function handlePerf(fm: FlutterManager): Promise<string> {
  try {
    const renderTree = await fm.vmService.dumpRenderTree();
    // Extract key metrics from the render tree header
    const lines = renderTree.split("\n").slice(0, 10);
    return `Render tree summary:\n${lines.join("\n")}`;
  } catch (e: any) {
    return `Performance data unavailable: ${e.message}`;
  }
}

async function handleStorage(fm: FlutterManager): Promise<string> {
  try {
    const result = await fm.evaluate(
      "import 'package:shared_preferences/shared_preferences.dart'; " +
      "(await SharedPreferences.getInstance()).getKeys().map((k) => '\"\$k\": \"\${(await SharedPreferences.getInstance()).get(k)}\"').join(', ')"
    );
    return `SharedPreferences: {${result}}`;
  } catch {
    return "SharedPreferences not available. Is the shared_preferences package installed?";
  }
}

function handleIs(fm: FlutterManager, args: string[]): string {
  const condition = args.join(" ");
  if (!condition) return "Usage: is <condition> (e.g., is button labeled Submit)";

  const refMap = fm.refs.widgetRefs;
  if (refMap.size === 0) return "No snapshot available. Run snapshot first.";

  const result = matchIsCondition(condition, refMap);
  if (result.found) {
    return `Yes — found ${result.description} at ${result.ref}`;
  }
  return `No — no widget matching "${condition}" found in current snapshot.`;
}
