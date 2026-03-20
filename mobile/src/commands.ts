/**
 * Command registry — single source of truth for all mobile commands.
 *
 * Dependency graph:
 *   commands.ts ──▶ server.ts (runtime dispatch)
 *                ──▶ gen-skill-docs.ts (doc generation)
 *
 * Zero side effects. Safe to import from build scripts and tests.
 */

export const READ_COMMANDS = new Set([
  "snapshot", "text", "widgets", "eval",
  "console", "network", "perf", "storage", "is",
]);

export const WRITE_COMMANDS = new Set([
  "tap", "fill", "scroll", "press", "longpress",
  "back", "reload", "restart",
  "permission", "deeplink",
]);

export const META_COMMANDS = new Set([
  "screenshot", "devices", "device",
  "status", "stop", "restart-app",
  "rotate", "chain", "diff",
  "sysui", "systrap",
]);

export const ALL_COMMANDS = new Set([...READ_COMMANDS, ...WRITE_COMMANDS, ...META_COMMANDS]);

export const COMMAND_DESCRIPTIONS: Record<string, { category: string; description: string; usage?: string }> = {
  // Reading
  "snapshot":   { category: "Reading", description: "Widget inspector tree with @w refs. Flags: -v verbose, -s semantics, -D diff vs previous, -a annotated screenshot", usage: "snapshot [flags]" },
  "text":       { category: "Reading", description: "All visible text on screen" },
  "widgets":    { category: "Reading", description: "List widgets matching a type or key", usage: "widgets <type|key>" },
  "eval":       { category: "Reading", description: "Evaluate Dart expression in app context", usage: "eval <expr>" },
  "console":    { category: "Reading", description: "Recent Dart print/log output", usage: "console [--clear]" },
  "network":    { category: "Reading", description: "Recent HTTP requests/responses", usage: "network [--clear]" },
  "perf":       { category: "Reading", description: "Frame timing and jank stats" },
  "storage":    { category: "Reading", description: "SharedPreferences contents as JSON" },
  "is":         { category: "Reading", description: "Assert condition (e.g., is there a button labeled Login?)", usage: "is <condition>" },
  // Interaction
  "tap":        { category: "Interaction", description: "Tap widget by @w ref or semantics label", usage: "tap <@ref|label>" },
  "fill":       { category: "Interaction", description: "Fill text field", usage: "fill <@ref> <text>" },
  "scroll":     { category: "Interaction", description: "Scroll a scrollable widget", usage: "scroll <@ref> <up|down>" },
  "press":      { category: "Interaction", description: "Press key (back, home, enter, etc.)", usage: "press <key>" },
  "longpress":  { category: "Interaction", description: "Long press widget", usage: "longpress <@ref|label>" },
  "back":       { category: "Interaction", description: "System back navigation" },
  "reload":     { category: "Interaction", description: "Hot reload (preserves state)" },
  "restart":    { category: "Interaction", description: "Hot restart (resets state)" },
  "permission": { category: "Interaction", description: "Grant or revoke app permission", usage: "permission <grant|revoke> <permission>" },
  "deeplink":   { category: "Interaction", description: "Open deep link in app", usage: "deeplink <uri>" },
  // Visual
  "screenshot": { category: "Visual", description: "Capture current screen", usage: "screenshot [--flutter-only] [path]" },
  // Device
  "devices":    { category: "Device", description: "List available devices and emulators" },
  "device":     { category: "Device", description: "Switch active device", usage: "device <id>" },
  "rotate":     { category: "Device", description: "Change device orientation", usage: "rotate <portrait|landscape>" },
  // Server
  "status":     { category: "Server", description: "Health check with device info and app state" },
  "stop":       { category: "Server", description: "Shutdown server and Flutter process" },
  "restart-app": { category: "Server", description: "Full app restart (not hot restart)" },
  // Meta
  "chain":      { category: "Meta", description: "Run commands from JSON stdin. Stops on first error.", usage: "chain" },
  "diff":       { category: "Meta", description: "Diff current vs last snapshot" },
  // System UI
  "sysui":      { category: "System", description: "Dump system UI hierarchy with @s refs (for permission dialogs, notifications)", usage: "sysui" },
  "systrap":    { category: "System", description: "Tap system UI element by @s ref", usage: "systrap <@sN>" },
};

// Load-time validation: descriptions must cover exactly the command sets
const allCmds = new Set([...READ_COMMANDS, ...WRITE_COMMANDS, ...META_COMMANDS]);
const descKeys = new Set(Object.keys(COMMAND_DESCRIPTIONS));
for (const cmd of allCmds) {
  if (!descKeys.has(cmd)) throw new Error(`COMMAND_DESCRIPTIONS missing entry for: ${cmd}`);
}
for (const key of descKeys) {
  if (!allCmds.has(key)) throw new Error(`COMMAND_DESCRIPTIONS has unknown command: ${key}`);
}
