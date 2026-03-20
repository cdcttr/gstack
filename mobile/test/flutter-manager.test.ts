/**
 * Integration tests for FlutterManager.
 *
 * These tests connect to a running Flutter test fixture app.
 * Requires: emulator running + test_app launched via `flutter run --machine`.
 *
 * The VM Service URI is discovered from adb logcat.
 * Port forwarding must be set up: adb forward tcp:<port> tcp:<port>
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { VmServiceClient } from "../src/vm-service";

/**
 * Discover VM Service URI.
 *
 * The DDS (Dart Development Service) port is only available from `flutter run --machine`
 * output (app.debugPort event). The logcat shows the device-internal port which is not
 * directly accessible from the host.
 *
 * Set VM_SERVICE_URI env var to the wsUri from flutter run --machine output.
 * Example: VM_SERVICE_URI="ws://127.0.0.1:63872/L_chr7SIj_E=/ws" bun test ...
 */
async function discoverVmServiceUri(): Promise<string> {
  if (process.env.VM_SERVICE_URI) return process.env.VM_SERVICE_URI;

  // Fallback: try to find DDS-forwarded port from adb forward list
  const proc = Bun.spawn(["adb", "-s", "emulator-5554", "forward", "--list"], { stdout: "pipe", stderr: "pipe" });
  const output = await new Response(proc.stdout).text();
  await proc.exited;

  // DDS forwards look like: emulator-5554 tcp:<host_port> tcp:<device_port>
  // We need to try each forwarded port to find one that responds to VM Service
  const forwards = output.trim().split("\n").filter(Boolean);
  for (const line of forwards) {
    const match = line.match(/tcp:(\d+)\s+tcp:\d+/);
    if (!match) continue;
    const port = match[1];

    // Try to connect and see if it's a VM Service
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
      const text = await resp.text();
      // VM Service returns an HTML page mentioning Dart or has a specific path pattern
      if (text.includes("Dart") || text.includes("vm-service")) {
        // Try to find the secret from the response or known patterns
        // For now, require explicit URI
        continue;
      }
    } catch {
      continue;
    }
  }

  throw new Error(
    "VM_SERVICE_URI env var required. Launch the test app with:\n" +
    "  cd mobile/test/test_app && flutter run -d emulator-5554 --machine\n" +
    "Then set VM_SERVICE_URI to the wsUri from the app.debugPort event."
  );
}

describe("FlutterManager integration", () => {
  let vmService: VmServiceClient;
  let vmUri: string;

  beforeAll(async () => {
    vmUri = await discoverVmServiceUri();
    vmService = new VmServiceClient();
    await vmService.connect(vmUri);
    await vmService.getVM();
    await vmService.getIsolate();
  }, 30_000);

  afterAll(() => {
    vmService?.close();
  });

  test("connects to VM Service and gets isolate", () => {
    expect(vmService.connected).toBe(true);
    expect(vmService.isolateId).toBeTruthy();
    expect(vmService.rootLibId).toBeTruthy();
  });

  test("widget tree is ready", async () => {
    const ready = await vmService.isWidgetTreeReady();
    expect(ready).toBe(true);
  });

  test("gets root widget summary tree", async () => {
    const tree = await vmService.getRootWidgetSummaryTree("test-group", 4);
    const root = tree?.result || tree;
    expect(root).toBeDefined();
    expect(root.description).toBe("[root]");
    expect(root.children?.length).toBeGreaterThan(0);
  });

  test("finds test fixture app widgets in tree", async () => {
    const tree = await vmService.getRootWidgetSummaryTree("test-group-2", 6);
    const root = tree?.result || tree;

    // Walk tree to find our app widgets
    function findByType(node: any, type: string): any[] {
      const results: any[] = [];
      if (node.widgetRuntimeType === type) results.push(node);
      if (node.children) for (const c of node.children) results.push(...findByType(c, type));
      return results;
    }

    const testFixtureApps = findByType(root, "TestFixtureApp");
    expect(testFixtureApps.length).toBe(1);

    const scaffolds = findByType(root, "Scaffold");
    expect(scaffolds.length).toBeGreaterThan(0);
  });

  test("gets children of a node", async () => {
    const tree = await vmService.getRootWidgetSummaryTree("test-children", 2);
    const root = tree?.result || tree;
    const rootId = root.valueId;

    const children = await vmService.getChildrenSummaryTree("test-children", rootId);
    const result = children?.result || children;
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });

  test("dumps full widget tree as text", async () => {
    const dump = await vmService.dumpWidgetTree();
    expect(dump.length).toBeGreaterThan(100);
    expect(dump).toContain("TestFixtureApp");
    expect(dump).toContain("Scaffold");
  });

  test("dumps render tree", async () => {
    const dump = await vmService.dumpRenderTree();
    expect(dump.length).toBeGreaterThan(100);
    expect(dump).toContain("RenderView");
  });

  test("hot reload succeeds", async () => {
    const result = await vmService.reassemble();
    expect(result).toBeDefined();
  });

  test("gets HTTP profile", async () => {
    const profile = await vmService.getHttpProfile();
    expect(profile).toBeDefined();
    expect(profile.type).toBe("HttpProfile");
  });

  test("disposes object group", async () => {
    // Create a group by fetching tree
    await vmService.getRootWidgetSummaryTree("dispose-test", 2);
    // Dispose it — should not throw
    await vmService.disposeGroup("dispose-test");
  });

  test("inspector screenshot returns base64 PNG", async () => {
    const tree = await vmService.getRootWidgetSummaryTree("screenshot-test", 2);
    const root = tree?.result || tree;
    const rootId = root.valueId;

    const base64 = await vmService.inspectorScreenshot(rootId, 200, 400);
    // Should be a base64 string starting with PNG header bytes
    expect(typeof base64).toBe("string");
    expect(base64.length).toBeGreaterThan(100);
    // Base64 of PNG starts with iVBOR
    expect(base64.startsWith("iVBOR")).toBe(true);

    await vmService.disposeGroup("screenshot-test");
  });
});
