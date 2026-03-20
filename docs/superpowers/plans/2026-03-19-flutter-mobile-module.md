# Flutter Mobile Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a `mobile/` module for gstack that enables the full gstack skill workflow (QA, review, ship) for Flutter mobile app development, mirroring the browse/ module's architecture.

**Architecture:** Persistent Bun/TypeScript daemon with thin CLI proxy. The daemon manages a `flutter run --machine` process, communicates with it via the Dart VM Service Protocol (JSON-RPC 2.0 over WebSocket), and supplements with `adb` for device-level operations. Claude interacts through a compiled binary that POSTs commands to the daemon.

**Tech Stack:** Bun, TypeScript, Dart VM Service Protocol, adb, Flutter SDK

**Spec:** `docs/superpowers/specs/2026-03-19-flutter-mobile-module-design.md`

---

## File Map

| File | Responsibility |
|------|----------------|
| `mobile/src/commands.ts` | Command registry (READ/WRITE/META sets + descriptions). Zero side effects. |
| `mobile/src/config.ts` | Path resolution, state file read/write, git root detection. Mirrors `browse/src/config.ts`. |
| `mobile/src/buffers.ts` | CircularBuffer + entry types for console/network/widget events. Mirrors `browse/src/buffers.ts`. |
| `mobile/src/vm-service.ts` | JSON-RPC 2.0 WebSocket client for Dart VM Service Protocol. Request ID management, response correlation, typed methods, auto-reconnect. |
| `mobile/src/adb-bridge.ts` | Thin wrapper around `adb` commands. `execAdb(...args)` via `Bun.spawn` with explicit arg arrays. |
| `mobile/src/flutter-manager.ts` | Flutter process lifecycle (spawn, attach, shutdown), VM Service connection, ref map storage, app state tracking. Analogous to `browse/src/browser-manager.ts`. |
| `mobile/src/snapshot.ts` | Semantic tree → `@w` refs, widget tree (verbose), diff, annotated screenshots. Analogous to `browse/src/snapshot.ts`. |
| `mobile/src/read-commands.ts` | Handlers for: text, widgets, eval, console, network, perf, storage, is. |
| `mobile/src/write-commands.ts` | Handlers for: tap, fill, scroll, press, longpress, back, reload, restart, permission, deeplink. |
| `mobile/src/meta-commands.ts` | Handlers for: screenshot, devices, device, status, stop, restart-app, rotate, chain, diff, sysui, systrap. |
| `mobile/src/server.ts` | HTTP daemon on localhost. Routes `/command` (POST, Bearer auth), `/health` (GET, no auth). Idle timeout, buffer flush. |
| `mobile/src/cli.ts` | Thin CLI proxy. Reads state file, health check, starts server if needed, POSTs command, prints result. |
| `mobile/package.json` | Dependencies (diff), scripts (build, test, dev). |
| `mobile/test/vm-service.test.ts` | Unit: JSON-RPC message building, response correlation, reconnect (mocked WebSocket). |
| `mobile/test/adb-bridge.test.ts` | Unit: command construction, output parsing (mocked Bun.spawn). |
| `mobile/test/snapshot.test.ts` | Unit: semantic tree parsing, `@w` ref assignment, diff, filtering. |
| `mobile/test/config.test.ts` | Unit: path resolution, state file read/write. |
| `mobile/test/test-app/` | Minimal Flutter app fixture (login, list, detail, settings screens). |
| `mobile/test/commands.test.ts` | Integration: all commands against test fixture app (requires emulator). |
| `mobile/test/flutter-manager.test.ts` | Integration: process start, hot reload, crash recovery, attach mode. |
| `mobile/SKILL.md.tmpl` | Prompt template for Claude — command docs with worked examples. |
| `mobile/SKILL.md` | Generated from template via `bun run gen:skill-docs`. |

---

## Task 0: Implementation Spike — VM Service Protocol Validation

**Why:** The spec calls out that exact VM Service API signatures need runtime validation before implementation. This spike removes the biggest technical risk first.

**Files:**
- Create: `mobile/spike/vm-service-spike.ts`

- [ ] **Step 1: Create spike directory and script**

```bash
mkdir -p mobile/spike
```

```typescript
// mobile/spike/vm-service-spike.ts
// Run against a Flutter app with: bun run mobile/spike/vm-service-spike.ts <vm-service-uri>
//
// Start a Flutter app first:
//   flutter run --machine 2>&1 | grep "app.debugPort"
// Copy the wsUri from the JSON event.

const uri = process.argv[2];
if (!uri) {
  console.error("Usage: bun run mobile/spike/vm-service-spike.ts <ws://...>");
  process.exit(1);
}

let requestId = 0;
function nextId() { return ++requestId; }

const ws = new WebSocket(uri);

function send(method: string, params?: Record<string, any>): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = nextId();
    const handler = (event: MessageEvent) => {
      const data = JSON.parse(event.data as string);
      if (data.id === id) {
        ws.removeEventListener("message", handler);
        if (data.error) reject(new Error(JSON.stringify(data.error)));
        else resolve(data.result);
      }
    };
    ws.addEventListener("message", handler);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}

ws.addEventListener("open", async () => {
  try {
    console.log("=== 1. Get VM info ===");
    const vm = await send("getVM");
    console.log("VM version:", vm.version);
    const mainIsolate = vm.isolates?.[0];
    console.log("Main isolate:", mainIsolate?.id);

    console.log("\n=== 2. Get isolate details ===");
    const isolate = await send("getIsolate", { isolateId: mainIsolate.id });
    const extensions = isolate.extensionRPCs || [];
    console.log("Available extensions:", extensions.filter((e: string) => e.includes("flutter")).join(", "));

    console.log("\n=== 3. Try semantics tree dump ===");
    try {
      const semResult = await send("ext.flutter.debugDumpSemanticsTreeInTraversalOrder", { isolateId: mainIsolate.id });
      console.log("Semantics tree (first 500 chars):", JSON.stringify(semResult).substring(0, 500));
    } catch (e: any) {
      console.log("debugDumpSemanticsTreeInTraversalOrder failed:", e.message);
    }

    console.log("\n=== 4. Try widget inspector tree ===");
    try {
      const widgetResult = await send("ext.flutter.inspector.getRootWidgetSummaryTree", {
        isolateId: mainIsolate.id,
        subtreeDepth: 3,
      });
      console.log("Widget tree (first 500 chars):", JSON.stringify(widgetResult).substring(0, 500));
    } catch (e: any) {
      console.log("getRootWidgetSummaryTree failed:", e.message);
    }

    console.log("\n=== 5. Try evaluate ===");
    try {
      const evalResult = await send("evaluate", {
        isolateId: mainIsolate.id,
        targetId: isolate.rootLib?.id,
        expression: "WidgetsBinding.instance.toString()",
      });
      console.log("Evaluate result:", JSON.stringify(evalResult).substring(0, 300));
    } catch (e: any) {
      console.log("evaluate failed:", e.message);
    }

    console.log("\n=== 6. Try hot reload ===");
    try {
      const reloadResult = await send("ext.flutter.reassemble", { isolateId: mainIsolate.id });
      console.log("Hot reload result:", JSON.stringify(reloadResult));
    } catch (e: any) {
      console.log("Hot reload failed:", e.message);
    }

    console.log("\n=== 7. Try screenshot ===");
    try {
      const screenshotResult = await send("ext.flutter.debugDumpRenderTree", { isolateId: mainIsolate.id });
      console.log("Render tree (first 500 chars):", JSON.stringify(screenshotResult).substring(0, 500));
    } catch (e: any) {
      console.log("Render tree dump failed:", e.message);
    }

    console.log("\n=== 8. List all flutter extensions ===");
    for (const ext of extensions) {
      if (ext.includes("flutter") || ext.includes("dart")) {
        console.log(" ", ext);
      }
    }

    console.log("\nSpike complete. Review output and update spec with actual method names.");
  } catch (e) {
    console.error("Spike failed:", e);
  } finally {
    ws.close();
    process.exit(0);
  }
});
```

- [ ] **Step 2: Run the spike against a real Flutter app**

Start a Flutter app in one terminal:
```bash
cd <your-flutter-project> && flutter run --machine 2>&1 | tee /tmp/flutter-machine.log
```

Extract the VM service URI from the output (look for `app.debugPort` JSON event with `wsUri` field), then:
```bash
bun run mobile/spike/vm-service-spike.ts "ws://127.0.0.1:XXXXX/YYYYY=/ws"
```

- [ ] **Step 3: Document findings**

Update the spike file with comments noting:
- Which extension methods exist and their exact names
- Parameter shapes for each method
- Response formats
- Any methods that don't exist and need alternatives

- [ ] **Step 4: Update spec if needed**

If the spike reveals that method names in the spec are wrong, update `docs/superpowers/specs/2026-03-19-flutter-mobile-module-design.md` with the correct names.

- [ ] **Step 5: Commit**

```bash
git add mobile/spike/
git commit -m "spike: validate VM Service Protocol APIs for mobile module"
```

---

## Task 1: Project Scaffolding + Command Registry

**Files:**
- Create: `mobile/package.json`
- Create: `mobile/src/commands.ts`
- Create: `mobile/test/commands-registry.test.ts`

- [ ] **Step 1: Write the command registry test**

```typescript
// mobile/test/commands-registry.test.ts
import { describe, test, expect } from "bun:test";
import {
  READ_COMMANDS,
  WRITE_COMMANDS,
  META_COMMANDS,
  ALL_COMMANDS,
  COMMAND_DESCRIPTIONS,
} from "../src/commands";

describe("command registry", () => {
  test("ALL_COMMANDS is union of READ + WRITE + META", () => {
    const union = new Set([...READ_COMMANDS, ...WRITE_COMMANDS, ...META_COMMANDS]);
    expect(ALL_COMMANDS).toEqual(union);
  });

  test("no command appears in multiple sets", () => {
    const sets = [READ_COMMANDS, WRITE_COMMANDS, META_COMMANDS];
    for (let i = 0; i < sets.length; i++) {
      for (let j = i + 1; j < sets.length; j++) {
        const overlap = [...sets[i]].filter((c) => sets[j].has(c));
        expect(overlap).toEqual([]);
      }
    }
  });

  test("every command has a description", () => {
    for (const cmd of ALL_COMMANDS) {
      expect(COMMAND_DESCRIPTIONS[cmd]).toBeDefined();
      expect(COMMAND_DESCRIPTIONS[cmd].category).toBeTruthy();
      expect(COMMAND_DESCRIPTIONS[cmd].description).toBeTruthy();
    }
  });

  test("no extra descriptions exist", () => {
    for (const key of Object.keys(COMMAND_DESCRIPTIONS)) {
      expect(ALL_COMMANDS.has(key)).toBe(true);
    }
  });

  test("expected READ commands exist", () => {
    for (const cmd of ["snapshot", "text", "widgets", "eval", "console", "network", "perf", "storage", "is"]) {
      expect(READ_COMMANDS.has(cmd)).toBe(true);
    }
  });

  test("expected WRITE commands exist", () => {
    for (const cmd of ["tap", "fill", "scroll", "press", "longpress", "back", "reload", "restart", "permission", "deeplink"]) {
      expect(WRITE_COMMANDS.has(cmd)).toBe(true);
    }
  });

  test("expected META commands exist", () => {
    for (const cmd of ["screenshot", "devices", "device", "status", "stop", "chain", "diff", "sysui", "systrap"]) {
      expect(META_COMMANDS.has(cmd)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd mobile && bun test test/commands-registry.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Create package.json**

```json
{
  "name": "gstack-mobile",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "build": "bun build --compile src/cli.ts --outfile dist/mobile && git rev-parse HEAD > dist/.version",
    "dev": "bun run src/cli.ts",
    "server": "bun run src/server.ts",
    "test": "bun test test/ --ignore test/commands.test.ts --ignore test/flutter-manager.test.ts",
    "test:unit": "bun test test/ --ignore test/commands.test.ts --ignore test/flutter-manager.test.ts",
    "test:integration": "bun test test/commands.test.ts test/flutter-manager.test.ts"
  },
  "dependencies": {
    "diff": "^7.0.0"
  }
}
```

- [ ] **Step 4: Write the command registry**

```typescript
// mobile/src/commands.ts
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
  "snapshot":   { category: "Reading", description: "Semantic tree with @w refs for widget selection. Flags: -v verbose widget tree, -D diff vs previous, -a annotated screenshot", usage: "snapshot [flags]" },
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
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd mobile && bun test test/commands-registry.test.ts
```
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add mobile/package.json mobile/src/commands.ts mobile/test/commands-registry.test.ts
git commit -m "feat(mobile): scaffold project and command registry"
```

---

## Task 2: Config + Buffers (shared infrastructure)

**Files:**
- Create: `mobile/src/config.ts`
- Create: `mobile/src/buffers.ts`
- Create: `mobile/test/config.test.ts`

- [ ] **Step 1: Write config tests**

```typescript
// mobile/test/config.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { resolveConfig, ensureStateDir } from "../src/config";

describe("resolveConfig", () => {
  test("derives paths from MOBILE_STATE_FILE env", () => {
    const config = resolveConfig({
      MOBILE_STATE_FILE: "/tmp/test-project/.gstack/mobile.json",
    });
    expect(config.stateFile).toBe("/tmp/test-project/.gstack/mobile.json");
    expect(config.stateDir).toBe("/tmp/test-project/.gstack");
    expect(config.projectDir).toBe("/tmp/test-project");
  });

  test("log file paths are in state dir", () => {
    const config = resolveConfig({
      MOBILE_STATE_FILE: "/tmp/proj/.gstack/mobile.json",
    });
    expect(config.consoleLog).toBe("/tmp/proj/.gstack/mobile-console.log");
    expect(config.networkLog).toBe("/tmp/proj/.gstack/mobile-network.log");
  });
});

describe("ensureStateDir", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-config-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("creates .gstack directory", () => {
    const config = resolveConfig({
      MOBILE_STATE_FILE: path.join(tmpDir, ".gstack", "mobile.json"),
    });
    ensureStateDir(config);
    expect(fs.existsSync(config.stateDir)).toBe(true);
  });

  test("adds .gstack/ to .gitignore if not present", () => {
    const gitignorePath = path.join(tmpDir, ".gitignore");
    fs.writeFileSync(gitignorePath, "node_modules/\n");
    const config = resolveConfig({
      MOBILE_STATE_FILE: path.join(tmpDir, ".gstack", "mobile.json"),
    });
    ensureStateDir(config);
    const content = fs.readFileSync(gitignorePath, "utf-8");
    expect(content).toContain(".gstack/");
  });

  test("does not duplicate .gstack/ in .gitignore", () => {
    const gitignorePath = path.join(tmpDir, ".gitignore");
    fs.writeFileSync(gitignorePath, ".gstack/\nnode_modules/\n");
    const config = resolveConfig({
      MOBILE_STATE_FILE: path.join(tmpDir, ".gstack", "mobile.json"),
    });
    ensureStateDir(config);
    const content = fs.readFileSync(gitignorePath, "utf-8");
    const matches = content.match(/\.gstack\//g);
    expect(matches?.length).toBe(1);
  });
});
```

- [ ] **Step 2: Write buffers smoke test**

```typescript
// mobile/test/buffers.test.ts
import { describe, test, expect } from "bun:test";
import { CircularBuffer } from "../src/buffers";

describe("CircularBuffer", () => {
  test("push and toArray", () => {
    const buf = new CircularBuffer<number>(3);
    buf.push(1); buf.push(2); buf.push(3);
    expect(buf.toArray()).toEqual([1, 2, 3]);
  });

  test("overwrites oldest when full", () => {
    const buf = new CircularBuffer<number>(3);
    buf.push(1); buf.push(2); buf.push(3); buf.push(4);
    expect(buf.toArray()).toEqual([2, 3, 4]);
    expect(buf.totalAdded).toBe(4);
  });

  test("last(n) returns most recent entries", () => {
    const buf = new CircularBuffer<number>(5);
    buf.push(1); buf.push(2); buf.push(3);
    expect(buf.last(2)).toEqual([2, 3]);
  });

  test("clear preserves totalAdded", () => {
    const buf = new CircularBuffer<number>(5);
    buf.push(1); buf.push(2);
    buf.clear();
    expect(buf.length).toBe(0);
    expect(buf.totalAdded).toBe(2);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd mobile && bun test test/config.test.ts test/buffers.test.ts
```
Expected: FAIL — modules not found.

- [ ] **Step 4: Write config.ts**

Mirror `browse/src/config.ts` pattern exactly, changing `BROWSE_STATE_FILE` → `MOBILE_STATE_FILE`, `browse.json` → `mobile.json`, and log file prefixes from `browse-` → `mobile-`.

```typescript
// mobile/src/config.ts
/**
 * Shared config for mobile CLI + server.
 *
 * Resolution:
 *   1. MOBILE_STATE_FILE env → derive stateDir from parent
 *   2. git rev-parse --show-toplevel → projectDir/.gstack/
 *   3. process.cwd() fallback (non-git environments)
 */

import * as fs from "fs";
import * as path from "path";

export interface MobileConfig {
  projectDir: string;
  stateDir: string;
  stateFile: string;
  consoleLog: string;
  networkLog: string;
}

export function getGitRoot(): string | null {
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 2_000,
    });
    if (proc.exitCode !== 0) return null;
    return proc.stdout.toString().trim() || null;
  } catch {
    return null;
  }
}

export function resolveConfig(
  env: Record<string, string | undefined> = process.env,
): MobileConfig {
  let stateFile: string;
  let stateDir: string;
  let projectDir: string;

  if (env.MOBILE_STATE_FILE) {
    stateFile = env.MOBILE_STATE_FILE;
    stateDir = path.dirname(stateFile);
    projectDir = path.dirname(stateDir);
  } else {
    projectDir = getGitRoot() || process.cwd();
    stateDir = path.join(projectDir, ".gstack");
    stateFile = path.join(stateDir, "mobile.json");
  }

  return {
    projectDir,
    stateDir,
    stateFile,
    consoleLog: path.join(stateDir, "mobile-console.log"),
    networkLog: path.join(stateDir, "mobile-network.log"),
  };
}

export function ensureStateDir(config: MobileConfig): void {
  try {
    fs.mkdirSync(config.stateDir, { recursive: true });
  } catch (err: any) {
    if (err.code === "EACCES") {
      throw new Error(`Cannot create state directory ${config.stateDir}: permission denied`);
    }
    if (err.code === "ENOTDIR") {
      throw new Error(`Cannot create state directory ${config.stateDir}: a file exists at that path`);
    }
    throw err;
  }

  const gitignorePath = path.join(config.projectDir, ".gitignore");
  try {
    const content = fs.readFileSync(gitignorePath, "utf-8");
    if (!content.match(/^\.gstack\/?$/m)) {
      const separator = content.endsWith("\n") ? "" : "\n";
      fs.appendFileSync(gitignorePath, `${separator}.gstack/\n`);
    }
  } catch (err: any) {
    if (err.code !== "ENOENT") {
      const logPath = path.join(config.stateDir, "mobile-server.log");
      try {
        fs.appendFileSync(logPath, `[${new Date().toISOString()}] Warning: could not update .gitignore: ${err.message}\n`);
      } catch {}
    }
  }
}

export function readVersionHash(execPath: string = process.execPath): string | null {
  try {
    const versionFile = path.resolve(path.dirname(execPath), ".version");
    return fs.readFileSync(versionFile, "utf-8").trim() || null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Write buffers.ts**

Copy `browse/src/buffers.ts` and adjust entry types for mobile (replace `DialogEntry` with `WidgetEventEntry`):

```typescript
// mobile/src/buffers.ts
/**
 * Shared buffers — extracted to break circular dependency
 * between server.ts and flutter-manager.ts.
 *
 * CircularBuffer<T>: O(1) insert ring buffer with fixed capacity.
 */

export class CircularBuffer<T> {
  private buffer: (T | undefined)[];
  private head: number = 0;
  private _size: number = 0;
  private _totalAdded: number = 0;
  readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.buffer = new Array(capacity);
  }

  push(entry: T): void {
    const index = (this.head + this._size) % this.capacity;
    this.buffer[index] = entry;
    if (this._size < this.capacity) {
      this._size++;
    } else {
      this.head = (this.head + 1) % this.capacity;
    }
    this._totalAdded++;
  }

  toArray(): T[] {
    const result: T[] = [];
    for (let i = 0; i < this._size; i++) {
      result.push(this.buffer[(this.head + i) % this.capacity] as T);
    }
    return result;
  }

  last(n: number): T[] {
    const count = Math.min(n, this._size);
    const result: T[] = [];
    const start = (this.head + this._size - count) % this.capacity;
    for (let i = 0; i < count; i++) {
      result.push(this.buffer[(start + i) % this.capacity] as T);
    }
    return result;
  }

  get length(): number { return this._size; }
  get totalAdded(): number { return this._totalAdded; }

  clear(): void {
    this.head = 0;
    this._size = 0;
  }

  get(index: number): T | undefined {
    if (index < 0 || index >= this._size) return undefined;
    return this.buffer[(this.head + index) % this.capacity];
  }

  set(index: number, entry: T): void {
    if (index < 0 || index >= this._size) return;
    this.buffer[(this.head + index) % this.capacity] = entry;
  }
}

export interface LogEntry {
  timestamp: number;
  level: string;
  text: string;
}

export interface NetworkEntry {
  timestamp: number;
  method: string;
  url: string;
  status?: number;
  duration?: number;
  size?: number;
}

const HIGH_WATER_MARK = 50_000;

export const consoleBuffer = new CircularBuffer<LogEntry>(HIGH_WATER_MARK);
export const networkBuffer = new CircularBuffer<NetworkEntry>(HIGH_WATER_MARK);
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd mobile && bun test test/config.test.ts test/buffers.test.ts
```
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add mobile/src/config.ts mobile/src/buffers.ts mobile/test/config.test.ts mobile/test/buffers.test.ts
git commit -m "feat(mobile): add config and circular buffer infrastructure"
```

---

## Task 3: ADB Bridge

**Files:**
- Create: `mobile/src/adb-bridge.ts`
- Create: `mobile/test/adb-bridge.test.ts`

- [ ] **Step 1: Write adb bridge tests**

```typescript
// mobile/test/adb-bridge.test.ts
import { describe, test, expect, mock, beforeEach } from "bun:test";
import { AdbBridge } from "../src/adb-bridge";

describe("AdbBridge", () => {
  test("constructs correct adb command with device ID", () => {
    const bridge = new AdbBridge("emulator-5554");
    // Test the command builder (not the actual execution)
    const args = bridge.buildArgs("shell", "input", "tap", "100", "200");
    expect(args).toEqual([
      "adb", "-s", "emulator-5554", "shell", "input", "tap", "100", "200",
    ]);
  });

  test("parses adb devices output", () => {
    const output = [
      "List of devices attached",
      "emulator-5554\tdevice",
      "R5CR1234567\tdevice",
      "",
    ].join("\n");
    const devices = AdbBridge.parseDeviceList(output);
    expect(devices).toEqual([
      { id: "emulator-5554", type: "emulator" },
      { id: "R5CR1234567", type: "device" },
    ]);
  });

  test("identifies emulators vs physical devices", () => {
    expect(AdbBridge.isEmulator("emulator-5554")).toBe(true);
    expect(AdbBridge.isEmulator("R5CR1234567")).toBe(false);
  });

  test("parses uiautomator XML into interactive elements", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy>
  <node class="android.widget.Button" text="Allow" bounds="[540,1200][900,1300]" clickable="true" />
  <node class="android.widget.Button" text="Deny" bounds="[180,1200][540,1300]" clickable="true" />
  <node class="android.widget.TextView" text="Allow access?" bounds="[180,1100][900,1150]" clickable="false" />
</hierarchy>`;
    const elements = AdbBridge.parseUiAutomatorXml(xml);
    expect(elements.length).toBe(2); // only clickable
    expect(elements[0].text).toBe("Allow");
    expect(elements[0].bounds).toEqual({ x: 720, y: 1250 }); // center
    expect(elements[1].text).toBe("Deny");
  });

  test("escapes text for adb input", () => {
    expect(AdbBridge.escapeInputText("hello world")).toBe("hello%sworld");
    expect(AdbBridge.escapeInputText("test@email.com")).toBe("test@email.com");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd mobile && bun test test/adb-bridge.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Write adb-bridge.ts**

```typescript
// mobile/src/adb-bridge.ts
/**
 * Thin wrapper around adb commands.
 *
 * All commands use explicit argument arrays via Bun.spawn —
 * no shell interpolation, no injection risk.
 */

export interface AdbDevice {
  id: string;
  type: "emulator" | "device";
}

export interface UiElement {
  text: string;
  className: string;
  bounds: { x: number; y: number };
  rawBounds: string;
}

export class AdbBridge {
  constructor(private deviceId: string) {}

  /** Build the full adb command array (for testing without execution) */
  buildArgs(...args: string[]): string[] {
    return ["adb", "-s", this.deviceId, ...args];
  }

  /** Execute an adb command and return stdout */
  async exec(...args: string[]): Promise<string> {
    const fullArgs = this.buildArgs(...args);
    const proc = Bun.spawn(fullArgs, { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`adb command failed (exit ${exitCode}): ${fullArgs.join(" ")}\n${stderr}`);
    }
    return stdout.trim();
  }

  async tap(x: number, y: number): Promise<void> {
    await this.exec("shell", "input", "tap", String(Math.round(x)), String(Math.round(y)));
  }

  async swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number = 300): Promise<void> {
    await this.exec("shell", "input", "swipe",
      String(Math.round(x1)), String(Math.round(y1)),
      String(Math.round(x2)), String(Math.round(y2)),
      String(durationMs));
  }

  async inputText(text: string): Promise<void> {
    await this.exec("shell", "input", "text", AdbBridge.escapeInputText(text));
  }

  async keyevent(keycode: string): Promise<void> {
    await this.exec("shell", "input", "keyevent", keycode);
  }

  async screencap(): Promise<Buffer> {
    const fullArgs = this.buildArgs("exec-out", "screencap", "-p");
    const proc = Bun.spawn(fullArgs, { stdout: "pipe", stderr: "pipe" });
    const chunks: Uint8Array[] = [];
    const reader = proc.stdout.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    await proc.exited;
    return Buffer.concat(chunks);
  }

  async uiautomatorDump(): Promise<string> {
    await this.exec("shell", "uiautomator", "dump", "/sdcard/window_dump.xml");
    return await this.exec("shell", "cat", "/sdcard/window_dump.xml");
  }

  async grantPermission(pkg: string, permission: string): Promise<void> {
    await this.exec("shell", "pm", "grant", pkg, permission);
  }

  async revokePermission(pkg: string, permission: string): Promise<void> {
    await this.exec("shell", "pm", "revoke", pkg, permission);
  }

  async setRotation(rotation: 0 | 1 | 2 | 3): Promise<void> {
    await this.exec("shell", "settings", "put", "system", "accelerometer_rotation", "0");
    await this.exec("shell", "settings", "put", "system", "user_rotation", String(rotation));
  }

  async openDeepLink(uri: string): Promise<void> {
    await this.exec("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", uri);
  }

  static async listDevices(): Promise<AdbDevice[]> {
    const proc = Bun.spawn(["adb", "devices"], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    return AdbBridge.parseDeviceList(stdout);
  }

  static parseDeviceList(output: string): AdbDevice[] {
    return output
      .split("\n")
      .slice(1) // skip header
      .filter((line) => line.includes("\tdevice"))
      .map((line) => {
        const id = line.split("\t")[0];
        return { id, type: AdbBridge.isEmulator(id) ? "emulator" : "device" };
      });
  }

  static isEmulator(deviceId: string): boolean {
    return deviceId.startsWith("emulator-");
  }

  static escapeInputText(text: string): string {
    // adb shell input text treats spaces as separators — use %s
    return text.replace(/ /g, "%s");
  }

  static parseUiAutomatorXml(xml: string): UiElement[] {
    const elements: UiElement[] = [];
    const nodeRegex = /<node[^>]*?clickable="true"[^>]*?>/g;
    let match;
    while ((match = nodeRegex.exec(xml)) !== null) {
      const node = match[0];
      const text = node.match(/text="([^"]*)"/)?.[1] || "";
      const className = node.match(/class="([^"]*)"/)?.[1] || "";
      const rawBounds = node.match(/bounds="([^"]*)"/)?.[1] || "";
      const boundsMatch = rawBounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
      if (boundsMatch) {
        const [, x1, y1, x2, y2] = boundsMatch.map(Number);
        elements.push({
          text,
          className,
          bounds: { x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) },
          rawBounds,
        });
      }
    }
    return elements;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd mobile && bun test test/adb-bridge.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add mobile/src/adb-bridge.ts mobile/test/adb-bridge.test.ts
git commit -m "feat(mobile): add adb bridge with device management and system UI parsing"
```

---

## Task 4: VM Service Client

**Files:**
- Create: `mobile/src/vm-service.ts`
- Create: `mobile/test/vm-service.test.ts`

- [ ] **Step 1: Write VM service tests**

```typescript
// mobile/test/vm-service.test.ts
import { describe, test, expect } from "bun:test";
import { VmServiceClient } from "../src/vm-service";

describe("VmServiceClient", () => {
  test("builds correct JSON-RPC 2.0 request", () => {
    const msg = VmServiceClient.buildRequest(1, "getVM", {});
    expect(msg).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "getVM",
      params: {},
    });
  });

  test("builds request with isolateId param", () => {
    const msg = VmServiceClient.buildRequest(2, "evaluate", {
      isolateId: "isolates/123",
      expression: "1+1",
    });
    expect(msg.params.isolateId).toBe("isolates/123");
    expect(msg.params.expression).toBe("1+1");
  });

  test("increments request IDs", () => {
    const client = new VmServiceClient();
    expect(client.nextRequestId()).toBe(1);
    expect(client.nextRequestId()).toBe(2);
    expect(client.nextRequestId()).toBe(3);
  });

  test("parses VM Service error response", () => {
    const response = {
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32600, message: "Invalid Request", data: { details: "missing isolateId" } },
    };
    const err = VmServiceClient.parseError(response);
    expect(err).toContain("Invalid Request");
    expect(err).toContain("missing isolateId");
  });

  test("parses successful response", () => {
    const response = {
      jsonrpc: "2.0",
      id: 1,
      result: { type: "VM", version: "3.0" },
    };
    expect(VmServiceClient.isSuccess(response)).toBe(true);
    expect(VmServiceClient.isError(response)).toBe(false);
  });

  test("parses flutter machine JSON events", () => {
    const lines = [
      '[{"event":"app.debugPort","params":{"port":8181,"wsUri":"ws://127.0.0.1:8181/abc=/ws"}}]',
      '[{"event":"app.started"}]',
      '[{"event":"app.log","params":{"log":"hello"}}]',
    ];
    const events = lines.map(VmServiceClient.parseFlutterMachineEvent);
    expect(events[0]?.event).toBe("app.debugPort");
    expect(events[0]?.params?.wsUri).toBe("ws://127.0.0.1:8181/abc=/ws");
    expect(events[1]?.event).toBe("app.started");
    expect(events[2]?.event).toBe("app.log");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd mobile && bun test test/vm-service.test.ts
```
Expected: FAIL

- [ ] **Step 3: Write vm-service.ts**

Implement the JSON-RPC 2.0 client with:
- Static helpers for message building/parsing (unit-testable without WebSocket)
- Request ID management
- Flutter machine event parsing
- `connect(uri)`, `send(method, params)`, `close()` methods for runtime use
- Pending request map with timeout
- Auto-reconnect (one attempt)

The implementation should follow the patterns discovered in the Task 0 spike. Key methods:
- `getVM()` → `send("getVM")`
- `getIsolate(isolateId)` → `send("getIsolate", { isolateId })`
- `evaluate(isolateId, targetId, expression)` → `send("evaluate", { isolateId, targetId, expression })`
- `callExtension(method, params)` → `send(method, params)`
- `reloadSources(isolateId)` → `send("ext.flutter.reassemble", { isolateId })`
- `hotRestart()` → `send("ext.flutter.hotRestart", { isolateId })`

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd mobile && bun test test/vm-service.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add mobile/src/vm-service.ts mobile/test/vm-service.test.ts
git commit -m "feat(mobile): add VM Service Protocol JSON-RPC client"
```

---

## Task 5: Flutter Manager — Process Lifecycle

**Files:**
- Create: `mobile/src/flutter-manager.ts`
- Create: `mobile/test/flutter-manager-unit.test.ts`

This is the most complex module. Split into two sub-tasks: process lifecycle (5a) and ref map / state (5b).

### Task 5a: Process Spawn + VM Service Connection

- [ ] **Step 1: Write unit tests for Flutter machine event parsing and state**

```typescript
// mobile/test/flutter-manager-unit.test.ts
import { describe, test, expect } from "bun:test";
import {
  parseFlutterMachineEvent,
  extractVmServiceUri,
  FlutterAppState,
} from "../src/flutter-manager";

describe("parseFlutterMachineEvent", () => {
  test("parses app.debugPort event", () => {
    const line = '[{"event":"app.debugPort","params":{"port":8181,"wsUri":"ws://127.0.0.1:8181/abc=/ws"}}]';
    const event = parseFlutterMachineEvent(line);
    expect(event?.event).toBe("app.debugPort");
    expect(event?.params?.wsUri).toBe("ws://127.0.0.1:8181/abc=/ws");
  });

  test("parses app.started event", () => {
    const line = '[{"event":"app.started"}]';
    const event = parseFlutterMachineEvent(line);
    expect(event?.event).toBe("app.started");
  });

  test("parses app.log event", () => {
    const line = '[{"event":"app.log","params":{"log":"Hello from Dart","stackTrace":null}}]';
    const event = parseFlutterMachineEvent(line);
    expect(event?.event).toBe("app.log");
    expect(event?.params?.log).toBe("Hello from Dart");
  });

  test("returns null for non-JSON lines", () => {
    expect(parseFlutterMachineEvent("Flutter run key commands:")).toBeNull();
    expect(parseFlutterMachineEvent("")).toBeNull();
  });
});

describe("extractVmServiceUri", () => {
  test("extracts URI from debugPort event", () => {
    const event = { event: "app.debugPort", params: { port: 8181, wsUri: "ws://127.0.0.1:8181/abc=/ws" } };
    expect(extractVmServiceUri(event)).toBe("ws://127.0.0.1:8181/abc=/ws");
  });

  test("returns null for non-debugPort events", () => {
    expect(extractVmServiceUri({ event: "app.started" })).toBeNull();
  });
});

describe("FlutterAppState", () => {
  test("initial state is 'launching'", () => {
    const state = new FlutterAppState();
    expect(state.status).toBe("launching");
  });

  test("transitions to 'running' on app.started", () => {
    const state = new FlutterAppState();
    state.handleEvent({ event: "app.started" });
    expect(state.status).toBe("running");
  });

  test("transitions to 'stopped' on app.stop", () => {
    const state = new FlutterAppState();
    state.handleEvent({ event: "app.started" });
    state.handleEvent({ event: "app.stop" });
    expect(state.status).toBe("stopped");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd mobile && bun test test/flutter-manager-unit.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Write flutter-manager.ts — event parsing and state tracking**

Implement the exported functions/classes tested above:
- `parseFlutterMachineEvent(line: string)`: Parse `flutter run --machine` JSON stdout
- `extractVmServiceUri(event)`: Pull `wsUri` from `app.debugPort` event
- `FlutterAppState`: State machine (launching → running → stopped)

Also stub the `FlutterManager` class with:
- `constructor(vmService: VmServiceClient, adbBridge: AdbBridge)`
- `async launch(deviceId: string, flutterArgs?: string[])`: Spawn `flutter run -d <deviceId> --machine` (plus `MOBILE_FLUTTER_ARGS` env), parse stdout, connect VM Service, register `app.log` handler to push to `consoleBuffer`
- `async attach(vmServiceUri: string)`: Connect without owning process
- `async close()`: Graceful shutdown — `app.stop` for managed mode, disconnect for attach mode, 5s timeout then kill
- `onExit(callback)`: Register exit handler
- `isManaged(): boolean`: Whether we own the process

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd mobile && bun test test/flutter-manager-unit.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add mobile/src/flutter-manager.ts mobile/test/flutter-manager-unit.test.ts
git commit -m "feat(mobile): add Flutter process manager — event parsing and lifecycle"
```

### Task 5b: Ref Map + VM Service Wrappers

- [ ] **Step 6: Add ref map and convenience methods to FlutterManager**

Extend `FlutterManager` with:
- `setRefMap(map: Map<string, WidgetRef>)` / `getRef(id: string): WidgetRef | undefined` / `clearRefs()`
- `setSysUiRefs(map: Map<string, SysUiRef>)` / `getSysUiRef(id: string): SysUiRef | undefined`
- `setLastSnapshot(text: string)` / `getLastSnapshot(): string | null`
- `async evaluate(expression: string): Promise<string>`: Wrapper — gets isolateId (cached), calls `vmService.evaluate()`
- `async reloadSources(): Promise<{ success: boolean; message: string }>`: Wrapper around `ext.flutter.reassemble`
- `async hotRestart(): Promise<{ success: boolean; message: string }>`: Wrapper around `ext.flutter.hotRestart`
- `getDeviceId(): string` / `getAppState(): string`

Ref types:
```typescript
export interface WidgetRef {
  semanticsId: number;
  type: string;
  label: string;
  rect: { x: number; y: number; w: number; h: number };
  actions: string[];
}

export interface SysUiRef {
  text: string;
  className: string;
  bounds: { x: number; y: number };
}
```

Handle `MOBILE_DEVICE_ID` env var in device selection.

- [ ] **Step 7: Add ref map unit tests**

```typescript
// Append to mobile/test/flutter-manager-unit.test.ts
describe("FlutterManager ref map", () => {
  test("stores and retrieves @w refs", () => {
    // Use a mock FlutterManager or test the ref map methods directly
    const refMap = new Map([
      ["@w1", { semanticsId: 1, type: "Button", label: "OK", rect: { x: 0, y: 0, w: 100, h: 50 }, actions: ["tap"] }],
    ]);
    // Test that getRef("@w1") returns the stored ref
  });

  test("clearRefs empties the map", () => {
    // Set refs, clear, verify empty
  });

  test("@w and @s namespaces are independent", () => {
    // Set both @w and @s refs, verify no collision
  });
});
```

- [ ] **Step 8: Run tests, verify pass**

```bash
cd mobile && bun test test/flutter-manager-unit.test.ts
```
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add mobile/src/flutter-manager.ts mobile/test/flutter-manager-unit.test.ts
git commit -m "feat(mobile): add ref map management and VM Service convenience wrappers"
```

---

## Task 6: Snapshot + Ref System

**Files:**
- Create: `mobile/src/snapshot.ts`
- Create: `mobile/test/snapshot.test.ts`

- [ ] **Step 1: Write snapshot tests**

```typescript
// mobile/test/snapshot.test.ts
import { describe, test, expect } from "bun:test";
import { parseSemanticsTree, formatSnapshot, assignRefs, diffSnapshots } from "../src/snapshot";

describe("parseSemanticsTree", () => {
  test("parses semantic dump into structured nodes", () => {
    // The exact format depends on Task 0 spike results.
    const nodes = parseSemanticsTree(SAMPLE_SEMANTICS_DUMP);
    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes[0]).toHaveProperty("semanticsId");
    expect(nodes[0]).toHaveProperty("label");
    expect(nodes[0]).toHaveProperty("actions");
  });

  test("filters out non-semantic nodes", () => {
    const nodes = parseSemanticsTree(SAMPLE_SEMANTICS_DUMP);
    // Should not include layout-only nodes
    for (const node of nodes) {
      expect(node.label).toBeTruthy();
    }
  });
});

describe("assignRefs", () => {
  test("assigns @w refs to semantic nodes", () => {
    const nodes = [
      { semanticsId: 1, type: "ElevatedButton", label: "Sign In", rect: { x: 100, y: 200, w: 200, h: 50 }, actions: ["tap"] },
      { semanticsId: 2, type: "TextField", label: "Email", rect: { x: 100, y: 100, w: 200, h: 50 }, actions: ["tap"] },
    ];
    const refMap = assignRefs(nodes);
    expect(refMap.get("@w1")).toBeDefined();
    expect(refMap.get("@w2")).toBeDefined();
    expect(refMap.get("@w1")!.label).toBe("Sign In");
  });

  test("refs start at @w1 and increment", () => {
    const nodes = Array.from({ length: 5 }, (_, i) => ({
      semanticsId: i + 1, type: "Button", label: `Btn ${i}`,
      rect: { x: 0, y: i * 50, w: 100, h: 50 }, actions: ["tap"],
    }));
    const refMap = assignRefs(nodes);
    expect(refMap.has("@w1")).toBe(true);
    expect(refMap.has("@w5")).toBe(true);
    expect(refMap.has("@w6")).toBe(false);
  });
});

describe("formatSnapshot", () => {
  test("formats ref map as indented text", () => {
    const refMap = new Map([
      ["@w1", { semanticsId: 1, type: "AppBar", label: "My App", rect: { x: 0, y: 0, w: 400, h: 56 }, actions: [] }],
      ["@w2", { semanticsId: 2, type: "ElevatedButton", label: "Sign In", rect: { x: 100, y: 200, w: 200, h: 50 }, actions: ["tap"] }],
    ]);
    const output = formatSnapshot(refMap);
    expect(output).toContain('@w1 [AppBar] "My App"');
    expect(output).toContain('@w2 [ElevatedButton] "Sign In"');
  });
});

describe("diffSnapshots", () => {
  test("returns empty string when identical", () => {
    const text = '@w1 [Button] "OK"';
    expect(diffSnapshots(text, text)).toBe("");
  });

  test("shows added lines", () => {
    const prev = '@w1 [Button] "OK"';
    const curr = '@w1 [Button] "OK"\n@w2 [Button] "Cancel"';
    const result = diffSnapshots(curr, prev);
    expect(result).toContain("Cancel");
  });
});

// Placeholder — replace with actual dump format after spike
const SAMPLE_SEMANTICS_DUMP = `SemanticsNode#1
  label: "My App"
  Rect.fromLTWH(0.0, 0.0, 400.0, 56.0)
  actions: []
  SemanticsNode#2
    label: "Sign In"
    Rect.fromLTWH(100.0, 200.0, 200.0, 50.0)
    actions: [tap]`;
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd mobile && bun test test/snapshot.test.ts
```
Expected: FAIL

- [ ] **Step 3: Write snapshot.ts**

Implement:
- `parseSemanticsTree(dump: string): SemanticsNode[]` — Parse the tree dump into structured nodes
- `assignRefs(nodes: SemanticsNode[]): Map<string, WidgetRef>` — Assign `@w1`, `@w2`, ...
- `formatSnapshot(refMap: Map<string, WidgetRef>): string` — Indented text output
- `diffSnapshots(current: string, previous: string): string` — Use `diff` library
- `handleSnapshot(fm: FlutterManager, args: string[]): Promise<string>` — Full handler: call VM service, parse, assign, store, format. Handle flags: `-v` (verbose), `-D` (diff), `-a` (annotated screenshot)

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd mobile && bun test test/snapshot.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add mobile/src/snapshot.ts mobile/test/snapshot.test.ts
git commit -m "feat(mobile): add semantic tree snapshot with @w ref system"
```

---

## Task 7: Read Commands

**Files:**
- Create: `mobile/src/read-commands.ts`
- Create: `mobile/test/read-commands.test.ts`

- [ ] **Step 1: Write unit tests for read commands**

```typescript
// mobile/test/read-commands.test.ts
import { describe, test, expect } from "bun:test";
import { formatConsoleEntries, formatNetworkEntries, matchIsCondition } from "../src/read-commands";

describe("formatConsoleEntries", () => {
  test("formats log entries with timestamps and levels", () => {
    const entries = [
      { timestamp: 1710835200000, level: "info", text: "App started" },
      { timestamp: 1710835201000, level: "warning", text: "Low memory" },
    ];
    const output = formatConsoleEntries(entries);
    expect(output).toContain("[info] App started");
    expect(output).toContain("[warning] Low memory");
  });

  test("returns empty message when no entries", () => {
    expect(formatConsoleEntries([])).toContain("No console output");
  });
});

describe("formatNetworkEntries", () => {
  test("formats network entries as method/url/status/duration", () => {
    const entries = [
      { timestamp: 1710835200000, method: "GET", url: "https://api.example.com/data", status: 200, duration: 150 },
    ];
    const output = formatNetworkEntries(entries);
    expect(output).toContain("GET");
    expect(output).toContain("https://api.example.com/data");
    expect(output).toContain("200");
  });
});

describe("matchIsCondition", () => {
  test("matches button by label", () => {
    const refMap = new Map([
      ["@w1", { semanticsId: 1, type: "ElevatedButton", label: "Sign In", rect: { x: 0, y: 0, w: 100, h: 50 }, actions: ["tap"] }],
    ]);
    const result = matchIsCondition("button labeled Sign In", refMap);
    expect(result.found).toBe(true);
    expect(result.ref).toBe("@w1");
  });

  test("returns not found for missing widget", () => {
    const refMap = new Map();
    const result = matchIsCondition("button labeled Submit", refMap);
    expect(result.found).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd mobile && bun test test/read-commands.test.ts
```
Expected: FAIL

- [ ] **Step 3: Write read-commands.ts**

Implement handlers. Each handler takes `(flutterManager, adbBridge, args)` and returns a plain text string:

- `text`: Call `evaluate()` to dump all semantic text nodes
- `widgets`: Call widget inspector API with type/key filter
- `eval`: Pass expression to `evaluate()`, return string result
- `console`: Return `consoleBuffer.last(N)` via `formatConsoleEntries()`; `--clear` resets buffer
- `network`: Return `networkBuffer.last(N)` via `formatNetworkEntries()`; `--clear` resets
- `perf`: Call `ext.flutter.inspector` performance APIs
- `storage`: Call `evaluate()` with `SharedPreferences.getInstance()`
- `is`: Call `matchIsCondition()` against current ref map

Export `formatConsoleEntries`, `formatNetworkEntries`, `matchIsCondition` for unit testing.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd mobile && bun test test/read-commands.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add mobile/src/read-commands.ts mobile/test/read-commands.test.ts
git commit -m "feat(mobile): add read command handlers with unit tests"
```

---

## Task 8: Write Commands

**Files:**
- Create: `mobile/src/write-commands.ts`
- Create: `mobile/test/write-commands.test.ts`

- [ ] **Step 1: Write unit tests for write command helpers**

```typescript
// mobile/test/write-commands.test.ts
import { describe, test, expect } from "bun:test";
import { resolveKeycode, buildTapExpression, buildFillExpression } from "../src/write-commands";

describe("resolveKeycode", () => {
  test("maps common key names to Android keycodes", () => {
    expect(resolveKeycode("back")).toBe("KEYCODE_BACK");
    expect(resolveKeycode("home")).toBe("KEYCODE_HOME");
    expect(resolveKeycode("enter")).toBe("KEYCODE_ENTER");
    expect(resolveKeycode("tab")).toBe("KEYCODE_TAB");
  });

  test("passes through KEYCODE_ prefixed values", () => {
    expect(resolveKeycode("KEYCODE_VOLUME_UP")).toBe("KEYCODE_VOLUME_UP");
  });
});

describe("buildTapExpression", () => {
  test("builds performAction evaluate expression for tap", () => {
    const expr = buildTapExpression(42);
    expect(expr).toContain("performAction");
    expect(expr).toContain("42");
    expect(expr).toContain("SemanticsAction.tap");
  });
});

describe("buildFillExpression", () => {
  test("builds controller text set expression", () => {
    const expr = buildFillExpression("hello world");
    expect(expr).toContain("hello world");
    expect(expr).toContain("TextEditingController");
  });

  test("escapes quotes in text", () => {
    const expr = buildFillExpression('say "hi"');
    expect(expr).not.toContain('"hi"'); // should be escaped
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd mobile && bun test test/write-commands.test.ts
```
Expected: FAIL

- [ ] **Step 3: Write write-commands.ts**

Implement handlers for all WRITE commands. Export helper functions for unit testing:

- `resolveKeycode(key: string): string` — map friendly names to Android keycodes
- `buildTapExpression(semanticsId: number): string` — Dart expression for `performAction`
- `buildFillExpression(text: string): string` — Dart expression for controller text set
- Handler functions for: tap, fill, scroll, press, longpress, back, reload, restart, permission, deeplink

Tap resolution: look up `@w` ref → semanticsId → evaluate `performAction`. Fallback: bounding box → `adbBridge.tap()`.
Fill: tap to focus, evaluate controller access, fallback to `adbBridge.inputText()`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd mobile && bun test test/write-commands.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add mobile/src/write-commands.ts mobile/test/write-commands.test.ts
git commit -m "feat(mobile): add write command handlers with unit tests"
```

---

## Task 9: Meta Commands

**Files:**
- Create: `mobile/src/meta-commands.ts`
- Create: `mobile/test/meta-commands.test.ts`

### Task 9a: Chain + Diff + Status (pure logic)

- [ ] **Step 1: Write unit tests for chain and status**

```typescript
// mobile/test/meta-commands.test.ts
import { describe, test, expect } from "bun:test";
import { parseChainInput, formatStatus, formatDeviceList } from "../src/meta-commands";

describe("parseChainInput", () => {
  test("parses JSON array of command arrays", () => {
    const input = '[["tap","@w1"],["text"],["screenshot"]]';
    const commands = parseChainInput(input);
    expect(commands).toEqual([
      ["tap", "@w1"],
      ["text"],
      ["screenshot"],
    ]);
  });

  test("rejects invalid JSON", () => {
    expect(() => parseChainInput("not json")).toThrow();
  });

  test("rejects non-array input", () => {
    expect(() => parseChainInput('{"cmd":"tap"}')).toThrow();
  });
});

describe("formatStatus", () => {
  test("formats server status as text", () => {
    const status = {
      pid: 1234,
      uptime: 300,
      deviceId: "emulator-5554",
      deviceName: "Pixel 7",
      appState: "running",
      vmServiceUri: "ws://127.0.0.1:8181/abc=/ws",
    };
    const output = formatStatus(status);
    expect(output).toContain("emulator-5554");
    expect(output).toContain("running");
    expect(output).toContain("5m"); // 300s = 5m
  });
});

describe("formatDeviceList", () => {
  test("formats device list with current marker", () => {
    const devices = [
      { id: "emulator-5554", type: "emulator" as const },
      { id: "R5CR1234567", type: "device" as const },
    ];
    const output = formatDeviceList(devices, "emulator-5554");
    expect(output).toContain("emulator-5554");
    expect(output).toContain("*"); // current device marker
    expect(output).toContain("R5CR1234567");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd mobile && bun test test/meta-commands.test.ts
```
Expected: FAIL

- [ ] **Step 3: Write meta-commands.ts**

Implement all META command handlers. Export pure helper functions for unit testing:
- `parseChainInput(input: string): string[][]`
- `formatStatus(info): string`
- `formatDeviceList(devices, currentId): string`

Handler implementations:
- `screenshot`: `adbBridge.screencap()` → write PNG, return path. `--flutter-only` via evaluate.
- `screenshot -a`: Overlay ref labels on screenshot
- `devices`: `AdbBridge.listDevices()` → `formatDeviceList()`
- `device`: Restart Flutter with new `-d` target
- `status`: Collect info → `formatStatus()`
- `stop`: `flutterManager.close()` → `process.exit(0)`
- `restart-app`: Kill and relaunch Flutter process
- `rotate`: `adbBridge.setRotation()` — map `portrait`→0, `landscape`→1
- `chain`: `parseChainInput()` → execute sequentially, stop on first error
- `diff`: `diffSnapshots(current, last)`
- `sysui`: `adbBridge.uiautomatorDump()` → `parseUiAutomatorXml()` → assign `@s` refs → format
- `systrap`: Look up `@s` ref → `adbBridge.tap()`

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd mobile && bun test test/meta-commands.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add mobile/src/meta-commands.ts mobile/test/meta-commands.test.ts
git commit -m "feat(mobile): add meta command handlers with unit tests"
```

---

## Task 10: HTTP Server

**Files:**
- Create: `mobile/src/server.ts`
- Create: `mobile/test/server.test.ts`

- [ ] **Step 1: Write server unit tests**

```typescript
// mobile/test/server.test.ts
import { describe, test, expect } from "bun:test";
import { routeCommand, wrapError } from "../src/server";
import { READ_COMMANDS, WRITE_COMMANDS, META_COMMANDS } from "../src/commands";

describe("routeCommand", () => {
  test("routes read commands correctly", () => {
    for (const cmd of READ_COMMANDS) {
      if (cmd === "snapshot") continue; // snapshot is in META via snapshot.ts
      expect(routeCommand(cmd)).toBe("read");
    }
  });

  test("routes write commands correctly", () => {
    for (const cmd of WRITE_COMMANDS) {
      expect(routeCommand(cmd)).toBe("write");
    }
  });

  test("routes meta commands correctly", () => {
    for (const cmd of META_COMMANDS) {
      expect(routeCommand(cmd)).toBe("meta");
    }
  });

  test("returns null for unknown commands", () => {
    expect(routeCommand("unknown")).toBeNull();
  });
});

describe("wrapError", () => {
  test("translates VM_SERVICE_DISCONNECTED to user message", () => {
    const result = wrapError(new Error("VM_SERVICE_DISCONNECTED"));
    expect(result.error).toContain("App may have crashed");
    expect(result.hint).toContain("console");
  });

  test("translates timeout to user message", () => {
    const result = wrapError(new Error("Timeout waiting for response"));
    expect(result.error).toContain("timed out");
  });

  test("passes through unknown errors", () => {
    const result = wrapError(new Error("Something weird"));
    expect(result.error).toContain("Something weird");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd mobile && bun test test/server.test.ts
```
Expected: FAIL

- [ ] **Step 3: Write server.ts**

Mirror `browse/src/server.ts` structure:

1. **Startup**: `resolveConfig()` → `ensureStateDir()` → delete old logs → `findPort()` → create `FlutterManager` → `launch()` → `Bun.serve()` → write state file atomically (`.tmp` then `rename`)
2. **Routes**: `POST /command` (Bearer auth required) → `routeCommand()` → dispatch to handler → `200 text/plain` or `400/500 application/json`. `GET /health` (no auth) → JSON status.
3. **Auth**: `crypto.randomUUID()` at startup
4. **Idle timeout**: 30 min default (`MOBILE_IDLE_TIMEOUT` env), 60s check interval
5. **Buffer flush**: 1s interval, delta-based (track `totalAdded` vs `lastFlushed`)
6. **Error wrapping**: `wrapError()` translates known error types. After 3 consecutive failures, append hint.
7. **Flutter exit**: `flutterManager.onExit(() => process.exit(1))`

Export `routeCommand()` and `wrapError()` for unit testing.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd mobile && bun test test/server.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add mobile/src/server.ts mobile/test/server.test.ts
git commit -m "feat(mobile): add HTTP daemon with command routing, auth, and error handling"
```

---

## Task 11: CLI Proxy

**Files:**
- Create: `mobile/src/cli.ts`
- Create: `mobile/test/cli.test.ts`

- [ ] **Step 1: Write CLI unit tests**

```typescript
// mobile/test/cli.test.ts
import { describe, test, expect } from "bun:test";
import { parseStateFile, generateHelpText } from "../src/cli";

describe("parseStateFile", () => {
  test("parses valid state JSON", () => {
    const json = JSON.stringify({
      pid: 1234, port: 5678, token: "abc-123",
      deviceId: "emulator-5554", flutterPid: 1235,
      startedAt: "2026-03-19T10:00:00Z", binaryVersion: "abc123",
    });
    const state = parseStateFile(json);
    expect(state.pid).toBe(1234);
    expect(state.port).toBe(5678);
    expect(state.token).toBe("abc-123");
  });

  test("throws on invalid JSON", () => {
    expect(() => parseStateFile("not json")).toThrow();
  });

  test("throws on missing required fields", () => {
    expect(() => parseStateFile(JSON.stringify({ pid: 1234 }))).toThrow();
  });
});

describe("generateHelpText", () => {
  test("includes all command categories", () => {
    const help = generateHelpText();
    expect(help).toContain("Reading");
    expect(help).toContain("Interaction");
    expect(help).toContain("Visual");
    expect(help).toContain("Device");
    expect(help).toContain("Server");
    expect(help).toContain("Meta");
    expect(help).toContain("System");
  });

  test("includes snapshot command", () => {
    const help = generateHelpText();
    expect(help).toContain("snapshot");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd mobile && bun test test/cli.test.ts
```
Expected: FAIL

- [ ] **Step 3: Write cli.ts**

Mirror `browse/src/cli.ts`:

1. `readState()` / `parseStateFile()`: Read and validate `.gstack/mobile.json`
2. `isProcessAlive(pid)`: `process.kill(pid, 0)` zero-signal check
3. `ensureServer()`: Read state → check PID → health check → start if needed. Binary version check: if `binaryVersion` in state file doesn't match current `.version`, kill and restart
4. `startServer()`: Spawn `bun run server.ts` detached with `proc.unref()`. Pass `MOBILE_STATE_FILE` env. Poll for state file every 100ms, 15s timeout (Flutter is slow to start)
5. `sendCommand()`: `POST /command` with 60s timeout. Retry once on `ECONNREFUSED` (restart). Retry once on 401 (re-read token)
6. `chain` stdin: When `command === "chain"` and no args, read `Bun.stdin.text()`
7. `generateHelpText()`: Format `COMMAND_DESCRIPTIONS` grouped by category
8. Output: stdout (plain text) on success, stderr (parsed JSON error) on failure

Export `parseStateFile()` and `generateHelpText()` for unit testing.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd mobile && bun test test/cli.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add mobile/src/cli.ts mobile/test/cli.test.ts
git commit -m "feat(mobile): add CLI proxy with server lifecycle and help text"
```

---

## Task 12: Build + Smoke Test

**Files:**
- Modify: `mobile/package.json`
- Modify: `gstack/package.json`

- [ ] **Step 1: Install dependencies**

```bash
cd mobile && bun install
```

- [ ] **Step 2: Run all unit tests**

```bash
cd mobile && bun run test:unit
```
Expected: All unit tests pass (commands, config, buffers, adb-bridge, vm-service, snapshot, flutter-manager, read-commands, write-commands, meta-commands, server, cli).

- [ ] **Step 3: Build the binary**

```bash
cd mobile && bun run build
```
Expected: `mobile/dist/mobile` binary created, `mobile/dist/.version` written.

- [ ] **Step 4: Verify binary runs help**

```bash
./mobile/dist/mobile help
```
Expected: Prints help text with all command categories.

- [ ] **Step 5: Update gstack package.json — add mobile binary**

Add to `"bin"`:
```json
"bin": {
  "browse": "./browse/dist/browse",
  "mobile": "./mobile/dist/mobile"
}
```

Update `"build"` script to include mobile compilation:
```json
"build": "bun run gen:skill-docs && bun run gen:skill-docs --host codex && bun build --compile browse/src/cli.ts --outfile browse/dist/browse && bun build --compile browse/src/find-browse.ts --outfile browse/dist/find-browse && bun build --compile mobile/src/cli.ts --outfile mobile/dist/mobile && git rev-parse HEAD > browse/dist/.version && git rev-parse HEAD > mobile/dist/.version && rm -f .*.bun-build || true"
```

Update `"test"` script to include mobile unit tests:
```json
"test": "bun test browse/test/ mobile/test/ test/ --ignore test/skill-e2e.test.ts --ignore test/skill-llm-eval.test.ts --ignore test/skill-routing-e2e.test.ts --ignore test/codex-e2e.test.ts --ignore mobile/test/commands.test.ts --ignore mobile/test/flutter-manager.test.ts"
```

- [ ] **Step 6: Add `mobile/dist/` to .gitignore**

Compiled binaries should not be committed. Ensure `.gitignore` includes:
```
mobile/dist/
```

- [ ] **Step 7: Commit**

```bash
git add mobile/package.json gstack/package.json .gitignore
git commit -m "feat(mobile): build pipeline — binary compilation and test integration"
```

---

## Task 13: Test Fixture App

**Files:**
- Create: `mobile/test/test-app/` (Flutter project)

- [ ] **Step 1: Create the Flutter test app**

```bash
cd mobile/test && flutter create test-app --org com.gstack.test
```

- [ ] **Step 2: Replace lib/main.dart with test fixture screens**

Create a minimal app with four screens and bottom navigation:

- `LoginScreen`: `TextField` with `Key('email_field')` and `Semantics(label: 'Email')`, `TextField` with `Key('password_field')` and `Semantics(label: 'Password')`, `ElevatedButton` with `Key('sign_in_button')` and text "Sign In"
- `ListScreen`: `ListView.builder` with 10 `ListTile` items, each `Key('item_$i')` and `Semantics(label: 'Item $i')`
- `DetailScreen`: `AppBar` with title, `Text` showing item details, back navigation
- `SettingsScreen`: `Switch` with `Key('dark_mode_switch')` and `Semantics(label: 'Dark mode')`, `DropdownButton`

All widgets must have explicit `Key` values and `Semantics` labels.

Add a `print('App started')` in `initState` to verify console capture.

- [ ] **Step 3: Verify the test app builds**

```bash
cd mobile/test/test-app && flutter build apk --debug
```
Expected: APK builds successfully.

- [ ] **Step 4: Commit**

```bash
git add mobile/test/test-app/
git commit -m "feat(mobile): add Flutter test fixture app for integration tests"
```

---

## Task 14: Integration Tests

**Files:**
- Create: `mobile/test/commands.test.ts`
- Create: `mobile/test/flutter-manager.test.ts`

- [ ] **Step 1: Write flutter-manager integration test**

```typescript
// mobile/test/flutter-manager.test.ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { FlutterManager } from "../src/flutter-manager";
import { VmServiceClient } from "../src/vm-service";
import { AdbBridge } from "../src/adb-bridge";

describe("FlutterManager integration", () => {
  let fm: FlutterManager;

  beforeAll(async () => {
    const devices = await AdbBridge.listDevices();
    if (devices.length === 0) throw new Error("No emulator running — skip integration tests");
    const deviceId = devices[0].id;
    const vmService = new VmServiceClient();
    const adb = new AdbBridge(deviceId);
    fm = new FlutterManager(vmService, adb);
    await fm.launch(deviceId);
  }, 60_000); // Flutter startup can take up to 60s

  afterAll(async () => {
    await fm?.close();
  });

  test("app state is running after launch", () => {
    expect(fm.getAppState()).toBe("running");
  });

  test("can evaluate Dart expression", async () => {
    const result = await fm.evaluate("1 + 1");
    expect(result).toContain("2");
  });

  test("hot reload succeeds", async () => {
    const result = await fm.reloadSources();
    expect(result.success).toBe(true);
  });

  test("hot restart succeeds", async () => {
    const result = await fm.hotRestart();
    expect(result.success).toBe(true);
  }, 30_000);
});
```

- [ ] **Step 2: Write commands integration test**

```typescript
// mobile/test/commands.test.ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
// Import handlers and FlutterManager setup similar to above

describe("command integration", () => {
  // Setup: launch Flutter app on emulator

  test("snapshot returns @w refs for login screen", async () => {
    const output = await handleSnapshot(fm, []);
    expect(output).toContain("@w");
    expect(output).toContain("Sign In");
    expect(output).toContain("Email");
  });

  test("text returns visible text", async () => {
    const output = await handleReadCommand(fm, adb, "text", []);
    expect(output).toContain("Sign In");
  });

  test("tap triggers button interaction", async () => {
    // First snapshot to get refs
    await handleSnapshot(fm, []);
    // Find the sign in button ref and tap it
    // Verify navigation or state change
  });

  test("fill enters text in field", async () => {
    await handleSnapshot(fm, []);
    // Fill email field, verify text was entered
  });

  test("screenshot creates a PNG file", async () => {
    const output = await handleMetaCommand(fm, adb, "screenshot", ["/tmp/test-screenshot.png"]);
    expect(output).toContain("/tmp/test-screenshot.png");
    const exists = await Bun.file("/tmp/test-screenshot.png").exists();
    expect(exists).toBe(true);
  });

  test("console captures Dart print output", async () => {
    const output = await handleReadCommand(fm, adb, "console", []);
    expect(output).toContain("App started"); // from initState print
  });

  test("back navigates back", async () => {
    await handleWriteCommand(fm, adb, "back", []);
    // Verify we're back on previous screen
  });

  test("sysui dumps system UI", async () => {
    const output = await handleMetaCommand(fm, adb, "sysui", []);
    expect(output).toContain("@s");
  });
});
```

- [ ] **Step 3: Run integration tests**

```bash
cd mobile && bun run test:integration
```
Expected: All pass (requires running Android emulator with test app).

- [ ] **Step 4: Commit**

```bash
git add mobile/test/commands.test.ts mobile/test/flutter-manager.test.ts
git commit -m "feat(mobile): add integration tests for flutter manager and commands"
```

---

## Task 15: SKILL.md Template + gen-skill-docs Update

**Files:**
- Create: `mobile/SKILL.md.tmpl`
- Modify: `scripts/gen-skill-docs.ts` (add mobile command import)

- [ ] **Step 1: Write the skill template**

Model after `browse/SKILL.md.tmpl`. The template teaches Claude:

1. How to find the binary: check `$_ROOT/.claude/skills/gstack/mobile/dist/mobile` first, then `~/.claude/skills/gstack/mobile/dist/mobile`
2. How to invoke: `$M <command> [args...]`
3. Full command vocabulary with categories (auto-generated from `commands.ts`)
4. Worked examples:
   - Login flow: `snapshot` → `fill @w3 test@example.com` → `fill @w4 password` → `tap @w5` → `snapshot`
   - Widget check: `is button labeled Submit`
   - Annotated screenshot: `screenshot -a`
   - Permission dialog: `sysui` → `systrap @s1`
   - Deep link: `deeplink myapp://settings/profile`
   - Hot reload: `reload`
   - System back: `back`

- [ ] **Step 2: Update gen-skill-docs.ts to handle mobile commands**

Modify `scripts/gen-skill-docs.ts` to:
- Import from `mobile/src/commands.ts` (in addition to `browse/src/commands.ts`)
- Process `mobile/SKILL.md.tmpl` → `mobile/SKILL.md`
- Also generate `mobile/.agents/skills/gstack-mobile/SKILL.md` for Codex agents

- [ ] **Step 3: Generate SKILL.md**

```bash
bun run gen:skill-docs
```
Expected: `mobile/SKILL.md` generated from template.

- [ ] **Step 4: Commit**

```bash
git add mobile/SKILL.md.tmpl mobile/SKILL.md scripts/gen-skill-docs.ts
git commit -m "feat(mobile): add SKILL.md template and update gen-skill-docs"
```

---

## Task 16: Setup Script Integration

**Files:**
- Modify: `setup`

- [ ] **Step 1: Add mobile module to the setup script**

Add a section after the browse build that:
1. Runs `cd mobile && bun install && bun run build`
2. Symlinks `mobile/` into `.claude/skills/gstack/mobile/` and `.agents/skills/gstack-mobile/`
3. Prints: "Mobile module built. Use `$M <command>` in Flutter projects."

- [ ] **Step 2: Test setup end-to-end**

```bash
./setup
```
Expected: Both browse and mobile binaries built and symlinked.

- [ ] **Step 3: Commit**

```bash
git add setup
git commit -m "feat(mobile): integrate mobile module into gstack setup"
```

---

## Dependency Order

```
Task 0 (spike)               — no deps, do FIRST to validate APIs
Task 1 (commands)             — no deps
Task 2 (config + buffers)     — no deps
Task 3 (adb bridge)           — no deps
Task 4 (vm service)           — depends on Task 0 (spike informs API names)
Task 5a (flutter manager - lifecycle) — depends on Tasks 2, 3, 4
Task 5b (flutter manager - refs)      — depends on Task 5a
Task 6 (snapshot)             — depends on Task 5b
Task 7 (read commands)        — depends on Tasks 5b, 6
Task 8 (write commands)       — depends on Tasks 3, 5b, 6
Task 9 (meta commands)        — depends on Tasks 3, 5b, 6
Task 10 (server)              — depends on Tasks 1, 2, 5b, 7, 8, 9
Task 11 (CLI)                 — depends on Tasks 1, 2, 10
Task 12 (build)               — depends on Tasks 10, 11
Task 13 (test fixture app)    — no code deps, can parallel with Tasks 5-12
Task 14 (integration tests)   — depends on Tasks 12, 13
Task 15 (SKILL.md + gen-docs) — depends on Task 1, needs scripts/gen-skill-docs.ts update
Task 16 (setup script)        — depends on Task 12
```

**Parallelizable groups:**
- Tasks 1, 2, 3 can run in parallel
- Task 13 can run in parallel with Tasks 5-12
- Task 15 can start in parallel once Task 1 is done (but gen-docs update needs Task 1 commands)
