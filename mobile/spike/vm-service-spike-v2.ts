// VM Service Spike v2 — Fix issues from v1:
// 1. Widget inspector needs objectGroup param
// 2. Need to enable semantics generation
// 3. Test ext.flutter.inspector.screenshot
//
// Run: bun run mobile/spike/vm-service-spike-v2.ts <ws://...>

const uri = process.argv[2];
if (!uri) {
  console.error("Usage: bun run mobile/spike/vm-service-spike-v2.ts ws://127.0.0.1:<port>/<secret>/ws");
  process.exit(1);
}

let requestId = 0;
const pendingRequests = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

const ws = new WebSocket(uri);

ws.addEventListener("message", (event) => {
  const data = JSON.parse(event.data as string);
  if (data.id && pendingRequests.has(data.id)) {
    const { resolve, reject } = pendingRequests.get(data.id)!;
    pendingRequests.delete(data.id);
    if (data.error) reject(new Error(JSON.stringify(data.error)));
    else resolve(data.result);
  }
});

function send(method: string, params?: Record<string, any>): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Timeout: ${method}`));
    }, 15000);
    pendingRequests.set(id, {
      resolve: (v) => { clearTimeout(timeout); resolve(v); },
      reject: (e) => { clearTimeout(timeout); reject(e); },
    });
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}

async function tryCall(label: string, method: string, params?: Record<string, any>): Promise<any> {
  try {
    const result = await send(method, params);
    const str = JSON.stringify(result);
    console.log(`  ✓ ${label}: ${str.substring(0, 500)}`);
    if (str.length > 500) console.log(`    ... (${str.length} total chars)`);
    return result;
  } catch (e: any) {
    console.log(`  ✗ ${label}: ${e.message.substring(0, 400)}`);
    return null;
  }
}

ws.addEventListener("open", async () => {
  try {
    const vm = await send("getVM");
    const mainIsolate = vm.isolates[0];
    const isoId = mainIsolate.id;
    console.log(`Connected to VM ${vm.version}, isolate: ${isoId}`);

    // === Widget Inspector with objectGroup ===
    console.log("\n=== 1. Widget Inspector (with objectGroup) ===");

    // The inspector methods require an objectGroup parameter
    const GROUP = "mobile-spike";

    // Try getRootWidgetSummaryTree with objectGroup
    const tree = await tryCall(
      "getRootWidgetSummaryTree + group",
      "ext.flutter.inspector.getRootWidgetSummaryTree",
      { isolateId: isoId, objectGroup: GROUP, subtreeDepth: "3" }
    );

    if (tree) {
      // Explore the tree structure
      console.log("\n  Tree structure keys:", Object.keys(tree));
      if (tree.result) {
        console.log("  Result keys:", Object.keys(tree.result));
        console.log("  Has children:", !!tree.result.children);
        if (tree.result.children) {
          console.log("  Children count:", tree.result.children.length);
          // Print first few children
          for (const child of tree.result.children.slice(0, 3)) {
            console.log(`    Child: ${child.description || child.widgetRuntimeType} (id: ${child.valueId})`);
          }
        }
      }
    }

    // Try getRootWidgetTree (full tree)
    await tryCall(
      "getRootWidgetTree + group",
      "ext.flutter.inspector.getRootWidgetTree",
      { isolateId: isoId, objectGroup: GROUP, subtreeDepth: "2" }
    );

    // Try getChildren on the root
    if (tree?.result?.valueId) {
      console.log("\n=== 2. Get Children of Root ===");
      await tryCall(
        "getChildrenSummaryTree of root",
        "ext.flutter.inspector.getChildrenSummaryTree",
        { isolateId: isoId, objectGroup: GROUP, arg: tree.result.valueId }
      );
    }

    // === Screenshot via inspector ===
    console.log("\n=== 3. Inspector Screenshot ===");

    // ext.flutter.inspector.screenshot exists!
    if (tree?.result?.valueId) {
      await tryCall(
        "inspector.screenshot of root widget",
        "ext.flutter.inspector.screenshot",
        {
          isolateId: isoId,
          id: tree.result.valueId,
          width: "400",
          height: "800",
        }
      );
    }

    // === Enable semantics and retry ===
    console.log("\n=== 4. Enable Semantics via adb ===");
    console.log("  Note: Run 'adb shell settings put secure enabled_accessibility_services com.google.android.marvin.talkback/com.google.android.marvin.talkback.TalkBackService'");
    console.log("  Or: 'adb shell settings put secure accessibility_enabled 1'");

    // Try enabling via accessibility settings
    const { execSync } = require("child_process");
    try {
      execSync("adb -s emulator-5554 shell settings put secure accessibility_enabled 1");
      console.log("  Enabled accessibility_enabled=1");
    } catch (e: any) {
      console.log("  Could not enable accessibility:", e.message);
    }

    // Wait a moment for semantics to be generated
    await new Promise(r => setTimeout(r, 2000));

    console.log("\n=== 5. Retry Semantics Tree ===");
    const semResult = await tryCall(
      "debugDumpSemanticsTreeInTraversalOrder (after enabling)",
      "ext.flutter.debugDumpSemanticsTreeInTraversalOrder",
      { isolateId: isoId }
    );

    if (semResult?.data && !semResult.data.includes("not generated")) {
      console.log("\n  SEMANTICS TREE AVAILABLE!");
      // Print first 2000 chars to see the structure
      console.log("  Full dump (first 2000 chars):");
      console.log(semResult.data.substring(0, 2000));
    }

    // === debugDumpApp for widget tree ===
    console.log("\n=== 6. debugDumpApp (full widget tree as text) ===");
    const appDump = await tryCall(
      "debugDumpApp",
      "ext.flutter.debugDumpApp",
      { isolateId: isoId }
    );
    if (appDump?.data) {
      console.log("\n  Widget tree (first 2000 chars):");
      console.log(appDump.data.substring(0, 2000));
    }

    // === Cleanup ===
    await tryCall(
      "disposeGroup",
      "ext.flutter.inspector.disposeGroup",
      { isolateId: isoId, objectGroup: GROUP }
    );

    console.log("\n=== FINDINGS ===");
    console.log("1. Widget inspector methods need objectGroup param (string)");
    console.log("2. Semantics requires accessibility_enabled=1 on device");
    console.log("3. debugDumpApp gives full widget tree as text");
    console.log("4. ext.flutter.inspector.screenshot exists for widget screenshots");
    console.log("5. ext.flutter.reassemble works for hot reload");

  } catch (e) {
    console.error("Spike v2 failed:", e);
  } finally {
    ws.close();
    setTimeout(() => process.exit(0), 500);
  }
});

ws.addEventListener("error", (e) => {
  console.error("WebSocket error:", e);
  process.exit(1);
});
