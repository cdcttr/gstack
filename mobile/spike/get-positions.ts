import { VmServiceClient } from "../src/vm-service";
import { AdbBridge } from "../src/adb-bridge";

const uri = process.argv[2] || "ws://127.0.0.1:63872/L_chr7SIj_E=/ws";

const vm = new VmServiceClient();
await vm.connect(uri);
await vm.getVM();
await vm.getIsolate();

console.log("Isolate:", vm.isolateId);
console.log("Root lib:", vm.rootLibId);

// Test basic evaluate first
console.log("\n=== Basic evaluate tests ===");
try {
  let r = await vm.evaluate("2 + 2");
  console.log("2+2 =", r?.valueAsString);

  r = await vm.evaluate('"hello world"');
  console.log("string =", r?.valueAsString);

  // Try accessing WidgetsBinding
  r = await vm.evaluate("WidgetsBinding.instance.toString()");
  console.log("WidgetsBinding:", r?.valueAsString?.substring(0, 80));
} catch (e: any) {
  console.log("Basic eval failed:", e.message.substring(0, 200));

  // Maybe we need to evaluate in a different context
  // Try evaluating on the isolate with a frame
  console.log("\nTrying to find a suitable evaluation target...");

  const isolate = await vm.send("getIsolate", { isolateId: vm.isolateId });
  console.log("Libraries:", isolate.libraries?.length);

  // Find the app's main library
  const mainLib = isolate.libraries?.find((l: any) => l.uri?.includes("main.dart"));
  console.log("Main lib:", mainLib?.uri, mainLib?.id);

  if (mainLib) {
    try {
      const r2 = await vm.send("evaluate", {
        isolateId: vm.isolateId,
        targetId: mainLib.id,
        expression: "WidgetsBinding.instance.toString()",
      });
      console.log("WidgetsBinding (via main.dart):", r2?.valueAsString?.substring(0, 100));
    } catch (e2: any) {
      console.log("Also failed:", e2.message.substring(0, 200));
    }
  }
}

// Alternative: find a widget by key using a simple expression
console.log("\n=== Try simple widget finding ===");
try {
  // First check if we can reference WidgetsBinding at all
  const r = await vm.send("evaluate", {
    isolateId: vm.isolateId,
    targetId: vm.rootLibId,
    expression: "WidgetsBinding.instance.runtimeType.toString()",
  });
  console.log("Binding type:", r?.valueAsString);

  // Now try to find a widget by key
  const findExpr = 'WidgetsBinding.instance.rootElement.toString()';
  const r2 = await vm.send("evaluate", {
    isolateId: vm.isolateId,
    targetId: vm.rootLibId,
    expression: findExpr,
  });
  console.log("Root element:", r2?.valueAsString?.substring(0, 100));

} catch (e: any) {
  console.log("Widget finding failed:", e.message.substring(0, 200));
}

// If evaluate works for simple things, try the position finder
// but as a single expression without multi-line lambdas
console.log("\n=== Position finder (single expression) ===");
try {
  // Step by step: first get the root element
  const r1 = await vm.evaluate("WidgetsBinding.instance.rootElement.runtimeType.toString()");
  console.log("Root type:", r1?.valueAsString);

  // Try a minimal closure
  const r2 = await vm.evaluate("(() => 42)()");
  console.log("Closure test:", r2?.valueAsString);

  // Try multi-statement closure
  const r3 = await vm.evaluate("(() { var x = 1; return x + 1; })()");
  console.log("Multi-statement:", r3?.valueAsString);

  // Try the full position finder
  const r4 = await vm.evaluate('(() { RenderBox? found; void visit(Element el) { if (el.widget.key?.toString().contains("email_field") == true && el.renderObject is RenderBox) found = el.renderObject as RenderBox; el.visitChildren(visit); } WidgetsBinding.instance.rootElement?.visitChildren(visit); if (found == null) return "not_found"; final o = found!.localToGlobal(Offset.zero); final s = found!.size; return "${o.dx},${o.dy},${s.width},${s.height}"; })()');
  console.log("Email field position:", r4?.valueAsString);

} catch (e: any) {
  console.log("Failed:", e.message.substring(0, 300));
}

vm.close();
process.exit(0);
