// VM Service Protocol Spike
// Run: bun run mobile/spike/vm-service-spike.ts <ws://...>
//
// Validates exact JSON-RPC method names, parameter shapes, and response formats.

const uri = process.argv[2];
if (!uri) {
  console.error("Usage: bun run mobile/spike/vm-service-spike.ts ws://127.0.0.1:<port>/<secret>/ws");
  process.exit(1);
}

let requestId = 0;
function nextId() { return ++requestId; }

const ws = new WebSocket(uri);

const pendingRequests = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

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
    const id = nextId();
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Timeout waiting for response to ${method} (id=${id})`));
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
    console.log(`  ✓ ${label}: ${JSON.stringify(result).substring(0, 400)}`);
    return result;
  } catch (e: any) {
    console.log(`  ✗ ${label}: ${e.message.substring(0, 300)}`);
    return null;
  }
}

ws.addEventListener("open", async () => {
  try {
    // 1. Basic VM info
    console.log("\n=== 1. VM Info ===");
    const vm = await send("getVM");
    console.log(`  VM version: ${vm.version}`);
    console.log(`  Isolates: ${vm.isolates?.length}`);
    const mainIsolate = vm.isolates?.[0];
    console.log(`  Main isolate: ${mainIsolate?.id} (${mainIsolate?.name})`);

    // 2. Isolate details — find available extensions
    console.log("\n=== 2. Available Service Extensions ===");
    const isolate = await send("getIsolate", { isolateId: mainIsolate.id });
    const extensions: string[] = isolate.extensionRPCs || [];
    const flutterExts = extensions.filter((e: string) => e.includes("flutter") || e.includes("dart"));
    console.log(`  Total extensions: ${extensions.length}`);
    console.log(`  Flutter/Dart extensions:`);
    for (const ext of flutterExts.sort()) {
      console.log(`    ${ext}`);
    }

    const rootLibId = isolate.rootLib?.id;
    console.log(`  Root library: ${rootLibId}`);

    // 3. Semantics tree
    console.log("\n=== 3. Semantics Tree ===");

    // 3a. Try debugDumpSemanticsTreeInTraversalOrder
    await tryCall(
      "debugDumpSemanticsTreeInTraversalOrder",
      "ext.flutter.debugDumpSemanticsTreeInTraversalOrder",
      { isolateId: mainIsolate.id }
    );

    // 3b. Try debugDumpSemanticsTreeInInverseHitTestOrder
    await tryCall(
      "debugDumpSemanticsTreeInInverseHitTestOrder",
      "ext.flutter.debugDumpSemanticsTreeInInverseHitTestOrder",
      { isolateId: mainIsolate.id }
    );

    // 3c. Try getting semantics via evaluate
    console.log("\n=== 4. Evaluate — Semantics Access ===");

    await tryCall(
      "WidgetsBinding.instance check",
      "evaluate",
      { isolateId: mainIsolate.id, targetId: rootLibId, expression: "import 'package:flutter/widgets.dart'; WidgetsBinding.instance.toString()" }
    );

    // Try simpler evaluate
    await tryCall(
      "Simple evaluate (1+1)",
      "evaluate",
      { isolateId: mainIsolate.id, targetId: rootLibId, expression: "1+1" }
    );

    // Try evaluate on isolate level
    await tryCall(
      "Evaluate on isolate",
      "evaluate",
      { isolateId: mainIsolate.id, expression: "1+1" }
    );

    // 4. Widget inspector
    console.log("\n=== 5. Widget Inspector ===");

    // 5a. Try getRootWidgetSummaryTree
    await tryCall(
      "getRootWidgetSummaryTree (depth 2)",
      "ext.flutter.inspector.getRootWidgetSummaryTree",
      { isolateId: mainIsolate.id, subtreeDepth: 2 }
    );

    // 5b. Try getRootWidget
    await tryCall(
      "getRootWidget",
      "ext.flutter.inspector.getRootWidget",
      { isolateId: mainIsolate.id }
    );

    // 5c. Try show
    await tryCall(
      "inspector.show",
      "ext.flutter.inspector.show",
      { isolateId: mainIsolate.id }
    );

    // 5d. Try structuredErrors
    await tryCall(
      "inspector.structuredErrors (enable)",
      "ext.flutter.inspector.structuredErrors",
      { isolateId: mainIsolate.id, enabled: "true" }
    );

    // 5e. Try isWidgetTreeReady
    await tryCall(
      "inspector.isWidgetTreeReady",
      "ext.flutter.inspector.isWidgetTreeReady",
      { isolateId: mainIsolate.id }
    );

    // 5f. Try getRootWidgetSummaryTreeWithPreviews
    await tryCall(
      "getRootWidgetSummaryTreeWithPreviews",
      "ext.flutter.inspector.getRootWidgetSummaryTreeWithPreviews",
      { isolateId: mainIsolate.id, subtreeDepth: 2 }
    );

    // 6. Hot reload / restart
    console.log("\n=== 6. Hot Reload / Restart ===");

    await tryCall(
      "reassemble (hot reload)",
      "ext.flutter.reassemble",
      { isolateId: mainIsolate.id }
    );

    // Don't actually hot restart — it disrupts the app
    console.log("  (Skipping hotRestart to avoid disrupting app)");

    // 7. Render tree
    console.log("\n=== 7. Debug Dumps ===");

    await tryCall(
      "debugDumpRenderTree",
      "ext.flutter.debugDumpRenderTree",
      { isolateId: mainIsolate.id }
    );

    await tryCall(
      "debugDumpLayerTree",
      "ext.flutter.debugDumpLayerTree",
      { isolateId: mainIsolate.id }
    );

    await tryCall(
      "debugDumpApp",
      "ext.flutter.debugDumpApp",
      { isolateId: mainIsolate.id }
    );

    // 8. Screenshot
    console.log("\n=== 8. Screenshot ===");

    await tryCall(
      "_flutter.screenshot",
      "ext.flutter.debugDumpSemanticsTreeInTraversalOrder",
      { isolateId: mainIsolate.id }
    );

    // Check if _flutter.screenshot exists
    const hasScreenshot = extensions.includes("ext.flutter.debugAllowBanner");
    console.log(`  ext.flutter.debugAllowBanner available: ${hasScreenshot}`);

    // 9. HTTP profiling
    console.log("\n=== 9. HTTP/Network Profiling ===");

    await tryCall(
      "getHttpProfile",
      "ext.dart.io.getHttpProfile",
      { isolateId: mainIsolate.id }
    );

    await tryCall(
      "httpEnableTimelineLogging",
      "ext.dart.io.httpEnableTimelineLogging",
      { isolateId: mainIsolate.id, enabled: true }
    );

    // 10. Summarize findings
    console.log("\n=== SUMMARY ===");
    console.log("All Flutter/Dart extensions available:");
    for (const ext of flutterExts.sort()) {
      console.log(`  ${ext}`);
    }

    console.log("\nSpike complete. Use output above to update spec and implementation.");
  } catch (e) {
    console.error("Spike failed:", e);
  } finally {
    ws.close();
    setTimeout(() => process.exit(0), 500);
  }
});

ws.addEventListener("error", (e) => {
  console.error("WebSocket error:", e);
  process.exit(1);
});
