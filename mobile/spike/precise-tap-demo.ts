import { VmServiceClient } from "../src/vm-service";
import { AdbBridge } from "../src/adb-bridge";
import * as fs from "fs";

const uri = process.argv[2] || "ws://127.0.0.1:63872/L_chr7SIj_E=/ws";

const vm = new VmServiceClient();
await vm.connect(uri);
await vm.getVM();
await vm.getIsolate();

const adb = new AdbBridge("emulator-5554");

// Helper: find a widget's global bounding box by its Key string
async function getWidgetBounds(keyStr: string): Promise<{ x: number; y: number; w: number; h: number } | null> {
  const expr = `(() { RenderBox? found; void visit(Element el) { if (el.widget.key?.toString().contains("${keyStr}") == true && el.renderObject is RenderBox) found = el.renderObject as RenderBox; el.visitChildren(visit); } WidgetsBinding.instance.rootElement?.visitChildren(visit); if (found == null) return "not_found"; final o = found!.localToGlobal(Offset.zero); final s = found!.size; return "\${o.dx},\${o.dy},\${s.width},\${s.height}"; })()`;

  const result = await vm.evaluate(expr);
  const value = result?.valueAsString;
  if (!value || value === "not_found") return null;

  const [x, y, w, h] = value.split(",").map(Number);
  return { x, y, w, h };
}

// Device pixel ratio (from render tree: 2.625 for this emulator)
const DPR = 2.625;

function toPhysical(logicalX: number, logicalY: number): { px: number; py: number } {
  return { px: Math.round(logicalX * DPR), py: Math.round(logicalY * DPR) };
}

console.log("=== Getting precise widget positions via evaluate() ===\n");

const widgets = ["email_field", "password_field", "sign_in_button", "welcome_text", "forgot_password_button", "bottom_nav"];
const positions: Record<string, { x: number; y: number; w: number; h: number; cx: number; cy: number; px: number; py: number }> = {};

for (const key of widgets) {
  const bounds = await getWidgetBounds(key);
  if (!bounds) {
    console.log(`  ${key}: not found`);
    continue;
  }
  const cx = bounds.x + bounds.w / 2;
  const cy = bounds.y + bounds.h / 2;
  const { px, py } = toPhysical(cx, cy);
  positions[key] = { ...bounds, cx, cy, px, py };
  console.log(`  @w ${key}: (${bounds.x.toFixed(0)},${bounds.y.toFixed(0)}) ${bounds.w.toFixed(0)}x${bounds.h.toFixed(0)} → tap ${px},${py}`);
}

// Dismiss any keyboard first
await adb.keyevent("KEYCODE_BACK");
await new Promise(r => setTimeout(r, 300));

// Re-get positions after keyboard dismiss (layout may shift)
for (const key of ["email_field", "password_field", "sign_in_button"]) {
  const bounds = await getWidgetBounds(key);
  if (bounds) {
    const cx = bounds.x + bounds.w / 2;
    const cy = bounds.y + bounds.h / 2;
    const { px, py } = toPhysical(cx, cy);
    positions[key] = { ...bounds, cx, cy, px, py };
  }
}

// Take "before" screenshot
const before = await adb.screencap();
fs.writeFileSync("/tmp/precise-before.png", before);
console.log("\nBefore screenshot: /tmp/precise-before.png");

console.log("\n=== LIVE DEMO: @w ref precise tapping ===\n");

// Step 1: Tap email field precisely
console.log("1. tap @w(email_field) →", positions.email_field.px, positions.email_field.py);
await adb.tap(positions.email_field.px, positions.email_field.py);
await new Promise(r => setTimeout(r, 600));

// Step 2: Type email
console.log("2. fill @w(email_field) 'hello@gstack.dev'");
await adb.inputText("hello@gstack.dev");
await new Promise(r => setTimeout(r, 400));

// Step 3: Tap password field (re-calculate position since keyboard is now up)
const pwBounds = await getWidgetBounds("password_field");
if (pwBounds) {
  const cx = pwBounds.x + pwBounds.w / 2;
  const cy = pwBounds.y + pwBounds.h / 2;
  const { px, py } = toPhysical(cx, cy);
  console.log("3. tap @w(password_field) →", px, py, "(recalculated with keyboard)");
  await adb.tap(px, py);
  await new Promise(r => setTimeout(r, 600));
} else {
  console.log("3. password_field not found, using stored position");
  await adb.tap(positions.password_field.px, positions.password_field.py);
  await new Promise(r => setTimeout(r, 600));
}

// Step 4: Type password
console.log("4. fill @w(password_field) 'MyS3cret!'");
await adb.inputText("MyS3cret!");
await new Promise(r => setTimeout(r, 400));

// Step 5: Dismiss keyboard
await adb.keyevent("KEYCODE_BACK");
await new Promise(r => setTimeout(r, 400));

// Step 6: Re-get sign in button position (layout shifts when keyboard dismissed)
const btnBounds = await getWidgetBounds("sign_in_button");
if (btnBounds) {
  const cx = btnBounds.x + btnBounds.w / 2;
  const cy = btnBounds.y + btnBounds.h / 2;
  const { px, py } = toPhysical(cx, cy);
  console.log("5. tap @w(sign_in_button) →", px, py);
  await adb.tap(px, py);
} else {
  console.log("5. sign_in_button not found");
}
await new Promise(r => setTimeout(r, 1000));

// Take "after" screenshot
const after = await adb.screencap();
fs.writeFileSync("/tmp/precise-after.png", after);
console.log("\nAfter screenshot: /tmp/precise-after.png");
console.log("\nDone! Check the emulator — email and password should be filled, snackbar showing.");

vm.close();
process.exit(0);
