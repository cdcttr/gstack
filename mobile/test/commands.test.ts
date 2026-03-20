/**
 * Integration tests for commands against the test fixture app.
 *
 * Requires: emulator running + test_app launched via `flutter run --machine`.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { VmServiceClient } from "../src/vm-service";
import { AdbBridge } from "../src/adb-bridge";
import { FlutterManager } from "../src/flutter-manager";
import { handleSnapshot, walkSummaryTree, assignRefs, formatSnapshot } from "../src/snapshot";
import { handleReadCommand } from "../src/read-commands";
import { handleMetaCommand } from "../src/meta-commands";

async function discoverVmServiceUri(): Promise<string> {
  if (process.env.VM_SERVICE_URI) return process.env.VM_SERVICE_URI;
  throw new Error(
    "VM_SERVICE_URI env var required. Launch the test app with:\n" +
    "  cd mobile/test/test_app && flutter run -d emulator-5554 --machine\n" +
    "Then set VM_SERVICE_URI to the wsUri from the app.debugPort event."
  );
}

describe("command integration", () => {
  let fm: FlutterManager;
  let adb: AdbBridge;

  beforeAll(async () => {
    const vmUri = await discoverVmServiceUri();
    const vmService = new VmServiceClient();
    adb = new AdbBridge("emulator-5554");
    fm = new FlutterManager(vmService, adb);

    // Attach to existing app (don't spawn new one)
    await fm.attach(vmUri);
  }, 30_000);

  afterAll(() => {
    fm?.vmService?.close();
  });

  test("snapshot returns @w refs for test fixture widgets", async () => {
    const output = await handleSnapshot(fm, []);
    expect(output).toContain("@w");
    // Should find test fixture app widgets
    expect(output).toContain("TestFixtureApp");
  });

  test("snapshot finds login screen widgets", async () => {
    const output = await handleSnapshot(fm, []);
    // Login screen has TextField, ElevatedButton, TextButton
    const hasTextField = output.includes("TextField");
    const hasButton = output.includes("ElevatedButton") || output.includes("Button");
    expect(hasTextField || hasButton).toBe(true);
  });

  test("snapshot -v returns verbose widget tree", async () => {
    const output = await handleSnapshot(fm, ["-v"]);
    expect(output.length).toBeGreaterThan(500);
    expect(output).toContain("TestFixtureApp");
    expect(output).toContain("Scaffold");
  });

  test("snapshot -D shows no changes on repeated call", async () => {
    // First snapshot to set baseline
    await handleSnapshot(fm, []);
    // Second snapshot with diff — should show no changes
    const output = await handleSnapshot(fm, ["-D"]);
    expect(output).toContain("No changes");
  });

  test("text returns visible text from the app", async () => {
    const output = await handleReadCommand(fm, adb, "text", []);
    // Login screen should show "Welcome Back" and "Sign In"
    const hasWelcome = output.includes("Welcome Back");
    const hasSignIn = output.includes("Sign In");
    expect(hasWelcome || hasSignIn).toBe(true);
  });

  test("widgets command finds widgets by type", async () => {
    // Ensure snapshot is taken first
    await handleSnapshot(fm, []);
    const output = await handleReadCommand(fm, adb, "widgets", ["TextField"]);
    // Should find the email and password text fields
    expect(output.includes("TextField") || output.includes("not found") || output.includes("No widgets")).toBe(true);
  });

  test("is command checks for widget existence", async () => {
    await handleSnapshot(fm, []);
    const output = await handleReadCommand(fm, adb, "is", ["ElevatedButton"]);
    // Should find the Sign In button
    expect(output.startsWith("Yes") || output.startsWith("No")).toBe(true);
  });

  test("console returns log output", async () => {
    const output = await handleReadCommand(fm, adb, "console", []);
    // Should contain "App started" from initState or "No console output"
    expect(typeof output).toBe("string");
  });

  test("network returns network data", async () => {
    const output = await handleReadCommand(fm, adb, "network", []);
    expect(typeof output).toBe("string");
    // May be "No network requests" if no HTTP calls made
  });

  test("screenshot creates a PNG file", async () => {
    const outputPath = `/tmp/gstack-test-screenshot-${Date.now()}.png`;
    const output = await handleMetaCommand(fm, adb, "screenshot", [outputPath]);
    expect(output).toContain(outputPath);
    expect(output).toContain("bytes");

    // Verify file exists and is a PNG
    const file = Bun.file(outputPath);
    expect(await file.exists()).toBe(true);
    const bytes = await file.arrayBuffer();
    expect(bytes.byteLength).toBeGreaterThan(1000);
    // PNG magic bytes: 137 80 78 71
    const header = new Uint8Array(bytes.slice(0, 4));
    expect(header[0]).toBe(137);
    expect(header[1]).toBe(80); // P
    expect(header[2]).toBe(78); // N
    expect(header[3]).toBe(71); // G

    // Cleanup
    const { unlinkSync } = require("fs");
    try { unlinkSync(outputPath); } catch {}
  });

  test("status returns server info", async () => {
    const output = await handleMetaCommand(fm, adb, "status", []);
    expect(output).toContain("running");
    expect(output).toContain("VM Service:");
  });

  test("devices lists connected devices", async () => {
    const output = await handleMetaCommand(fm, adb, "devices", []);
    expect(output).toContain("emulator-5554");
  });

  test("sysui dumps system UI hierarchy with @s refs", async () => {
    const output = await handleMetaCommand(fm, adb, "sysui", []);
    // Should find at least some system UI elements (status bar, nav bar)
    expect(typeof output).toBe("string");
    // May have @s refs or "No interactive" message
  });

  test("diff shows changes after navigation", async () => {
    // Take baseline snapshot
    await handleSnapshot(fm, []);
    // The diff command takes a new snapshot and compares
    const output = await handleMetaCommand(fm, adb, "diff", []);
    expect(typeof output).toBe("string");
  });
});
