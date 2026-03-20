/**
 * WRITE command handlers — mutate app state.
 *
 * Tap and fill use evaluate() to get precise widget bounding boxes
 * via RenderBox.localToGlobal(), then dispatch taps via adb at the
 * exact physical pixel coordinates. This handles keyboard shifts,
 * scroll offsets, and any layout changes.
 */

import type { FlutterManager } from "./flutter-manager";
import type { AdbBridge } from "./adb-bridge";

// ── Exported helpers (unit-testable) ──

const KEYCODE_MAP: Record<string, string> = {
  back: "KEYCODE_BACK",
  home: "KEYCODE_HOME",
  enter: "KEYCODE_ENTER",
  tab: "KEYCODE_TAB",
  escape: "KEYCODE_ESCAPE",
  delete: "KEYCODE_DEL",
  space: "KEYCODE_SPACE",
  up: "KEYCODE_DPAD_UP",
  down: "KEYCODE_DPAD_DOWN",
  left: "KEYCODE_DPAD_LEFT",
  right: "KEYCODE_DPAD_RIGHT",
  volumeup: "KEYCODE_VOLUME_UP",
  volumedown: "KEYCODE_VOLUME_DOWN",
  menu: "KEYCODE_MENU",
};

export function resolveKeycode(key: string): string {
  if (key.startsWith("KEYCODE_")) return key;
  return KEYCODE_MAP[key.toLowerCase()] || `KEYCODE_${key.toUpperCase()}`;
}

export function buildTapExpression(semanticsId: number): string {
  return `WidgetsBinding.instance.pipelineOwner.semanticsOwner!.performAction(${semanticsId}, SemanticsAction.tap)`;
}

export function buildFillExpression(text: string): string {
  const escaped = text.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return `(() { final state = WidgetsBinding.instance.focusManager.primaryFocus?.context?.findAncestorStateOfType<EditableTextState>(); if (state != null) { state.widget.controller.text = '${escaped}'; state.widget.controller.selection = TextSelection.collapsed(offset: ${text.length}); } })()`;
}

/**
 * Build a Dart expression that finds a widget by its Key string and returns
 * its global bounding box as "x,y,w,h" in logical pixels.
 *
 * Uses RenderBox.localToGlobal(Offset.zero) for the position and
 * RenderBox.size for dimensions — recalculated on every call so it
 * handles keyboard shifts, scrolling, and layout changes.
 */
export function buildBoundsExpression(keySubstring: string): string {
  const escaped = keySubstring.replace(/"/g, '\\"');
  return `(() { RenderBox? found; void visit(Element el) { if (el.widget.key?.toString().contains("${escaped}") == true && el.renderObject is RenderBox) found = el.renderObject as RenderBox; el.visitChildren(visit); } WidgetsBinding.instance.rootElement?.visitChildren(visit); if (found == null) return "not_found"; final o = found!.localToGlobal(Offset.zero); final s = found!.size; return "\${o.dx},\${o.dy},\${s.width},\${s.height}"; })()`;
}

/**
 * Parse bounds string "x,y,w,h" from evaluate result into an object.
 */
export function parseBoundsResult(value: string): { x: number; y: number; w: number; h: number } | null {
  if (!value || value === "not_found") return null;
  const parts = value.split(",").map(Number);
  if (parts.length !== 4 || parts.some(isNaN)) return null;
  return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
}

// ── Device pixel ratio ──

/** Get the device pixel ratio via evaluate */
async function getDevicePixelRatio(fm: FlutterManager): Promise<number> {
  try {
    const result = await fm.evaluate("WidgetsBinding.instance.platformDispatcher.views.first.devicePixelRatio.toString()");
    const dpr = parseFloat(result);
    if (!isNaN(dpr) && dpr > 0) return dpr;
  } catch {}
  return 2.625; // reasonable default for most emulators
}

// ── Widget bounds resolution ──

interface WidgetBounds {
  x: number;
  y: number;
  w: number;
  h: number;
  centerX: number;
  centerY: number;
  physicalX: number;
  physicalY: number;
}

/**
 * Get the precise bounding box of a widget referenced by @w ref.
 * Uses evaluate() to call localToGlobal on the RenderBox, then
 * converts logical pixels to physical pixels for adb tap.
 */
async function resolveWidgetBounds(fm: FlutterManager, target: string): Promise<WidgetBounds | null> {
  const ref = fm.refs.getWidgetRef(target);
  if (!ref) return null;

  // Extract the Key string from the description (format: "WidgetType-[<'key_name'>]")
  const keyMatch = ref.description.match(/<'([^']+)'>/);
  if (!keyMatch) return null;

  const keyStr = keyMatch[1];
  const expr = buildBoundsExpression(keyStr);

  try {
    const result = await fm.evaluate(expr);
    const bounds = parseBoundsResult(result);
    if (!bounds) return null;

    const dpr = await getDevicePixelRatio(fm);
    const centerX = bounds.x + bounds.w / 2;
    const centerY = bounds.y + bounds.h / 2;

    return {
      ...bounds,
      centerX,
      centerY,
      physicalX: Math.round(centerX * dpr),
      physicalY: Math.round(centerY * dpr),
    };
  } catch {
    return null;
  }
}

/**
 * Find a widget by label search and resolve its bounds.
 */
async function resolveWidgetBoundsByLabel(fm: FlutterManager, label: string): Promise<{ ref: string; bounds: WidgetBounds } | null> {
  const refMap = fm.refs.widgetRefs;
  for (const [refName, widget] of refMap) {
    if (widget.description.toLowerCase().includes(label.toLowerCase())) {
      const bounds = await resolveWidgetBounds(fm, refName);
      if (bounds) return { ref: refName, bounds };
    }
  }
  return null;
}

// ── Command handlers ──

export async function handleWriteCommand(
  fm: FlutterManager,
  adb: AdbBridge,
  command: string,
  args: string[],
): Promise<string> {
  switch (command) {
    case "tap": return handleTap(fm, adb, args);
    case "fill": return handleFill(fm, adb, args);
    case "scroll": return handleScroll(fm, adb, args);
    case "press": return handlePress(adb, args);
    case "longpress": return handleLongpress(fm, adb, args);
    case "back": return handleBack(adb);
    case "reload": return handleReload(fm);
    case "restart": return handleRestart(fm);
    case "permission": return handlePermission(adb, args);
    case "deeplink": return handleDeeplink(adb, args);
    default:
      throw new Error(`Unknown write command: ${command}`);
  }
}

async function handleTap(fm: FlutterManager, adb: AdbBridge, args: string[]): Promise<string> {
  const target = args[0];
  if (!target) return "Usage: tap <@wN|label>";

  if (target.startsWith("@w")) {
    const ref = fm.refs.getWidgetRef(target);
    if (!ref) return `Ref ${target} not found. Run snapshot to refresh refs.`;

    // Get precise bounding box via evaluate + localToGlobal
    const bounds = await resolveWidgetBounds(fm, target);
    if (bounds) {
      await adb.tap(bounds.physicalX, bounds.physicalY);
      return `Tapped ${target} [${ref.type}] "${ref.description}" at (${bounds.physicalX},${bounds.physicalY})`;
    }

    // Fallback: if evaluate fails or key not found, report the issue
    return `Could not resolve position for ${target} [${ref.type}] "${ref.description}". ` +
      `Widget may not have a Key, or evaluate() is unavailable (attach mode). ` +
      `Try using managed mode (let the server start flutter run).`;
  }

  // Label-based tap — search refs by description
  const result = await resolveWidgetBoundsByLabel(fm, target);
  if (result) {
    const ref = fm.refs.getWidgetRef(result.ref)!;
    await adb.tap(result.bounds.physicalX, result.bounds.physicalY);
    return `Tapped ${result.ref} [${ref.type}] "${ref.description}" at (${result.bounds.physicalX},${result.bounds.physicalY})`;
  }

  return `No widget matching "${target}" found. Run snapshot first.`;
}

async function handleFill(fm: FlutterManager, adb: AdbBridge, args: string[]): Promise<string> {
  if (args.length < 2) return "Usage: fill <@wN> <text>";
  const [target, ...textParts] = args;
  const text = textParts.join(" ");

  // Tap to focus first (with precise positioning)
  const tapResult = await handleTap(fm, adb, [target]);
  await new Promise(r => setTimeout(r, 300)); // Wait for focus animation

  // Try evaluate-based fill (set controller text directly)
  try {
    await fm.evaluate(buildFillExpression(text));
    return `Filled ${target} with "${text}" (via controller)`;
  } catch {
    // Fallback: adb input text (simulates IME keystrokes)
    await adb.inputText(text);
    return `Filled ${target} with "${text}" (via adb input)`;
  }
}

async function handleScroll(fm: FlutterManager, adb: AdbBridge, args: string[]): Promise<string> {
  const direction = args[args.length - 1]?.toLowerCase() || "down";

  // Get screen dimensions via evaluate for precise scrolling
  let screenWidth = 1080;
  let screenHeight = 1920;
  try {
    const result = await fm.evaluate("WidgetsBinding.instance.platformDispatcher.views.first.physicalSize.toString()");
    const match = result?.match?.(/Size\(([\d.]+),\s*([\d.]+)\)/);
    if (match) {
      screenWidth = parseFloat(match[1]);
      screenHeight = parseFloat(match[2]);
    }
  } catch {}

  const centerX = Math.round(screenWidth / 2);
  const quarterH = Math.round(screenHeight / 4);

  if (direction === "up") {
    await adb.swipe(centerX, quarterH, centerX, quarterH * 3, 300);
  } else {
    await adb.swipe(centerX, quarterH * 3, centerX, quarterH, 300);
  }
  return `Scrolled ${direction}`;
}

async function handlePress(adb: AdbBridge, args: string[]): Promise<string> {
  const key = args[0];
  if (!key) return "Usage: press <key>";
  const keycode = resolveKeycode(key);
  await adb.keyevent(keycode);
  return `Pressed ${key} (${keycode})`;
}

async function handleLongpress(fm: FlutterManager, adb: AdbBridge, args: string[]): Promise<string> {
  const target = args[0];
  if (!target) return "Usage: longpress <@wN|label>";

  if (target.startsWith("@w")) {
    const bounds = await resolveWidgetBounds(fm, target);
    if (bounds) {
      // Long press = swipe with duration at same point
      await adb.swipe(bounds.physicalX, bounds.physicalY, bounds.physicalX, bounds.physicalY, 1000);
      const ref = fm.refs.getWidgetRef(target)!;
      return `Long pressed ${target} [${ref.type}] "${ref.description}" at (${bounds.physicalX},${bounds.physicalY})`;
    }
  }

  // Label-based
  const result = await resolveWidgetBoundsByLabel(fm, target);
  if (result) {
    await adb.swipe(result.bounds.physicalX, result.bounds.physicalY, result.bounds.physicalX, result.bounds.physicalY, 1000);
    const ref = fm.refs.getWidgetRef(result.ref)!;
    return `Long pressed ${result.ref} [${ref.type}] "${ref.description}"`;
  }

  return `No widget matching "${target}" found. Run snapshot first.`;
}

async function handleBack(adb: AdbBridge): Promise<string> {
  await adb.keyevent("KEYCODE_BACK");
  return "Navigated back";
}

async function handleReload(fm: FlutterManager): Promise<string> {
  const result = await fm.reloadSources();
  fm.refs.clearWidgetRefs();
  return result.message;
}

async function handleRestart(fm: FlutterManager): Promise<string> {
  const result = await fm.hotRestart();
  return result.message;
}

async function handlePermission(adb: AdbBridge, args: string[]): Promise<string> {
  if (args.length < 2) return "Usage: permission <grant|revoke> <permission> [package]";
  const [action, permission, pkg] = args;
  const packageName = pkg || "com.example.app";

  if (action === "grant") {
    await adb.grantPermission(packageName, permission);
    return `Granted ${permission} to ${packageName}`;
  } else if (action === "revoke") {
    await adb.revokePermission(packageName, permission);
    return `Revoked ${permission} from ${packageName}`;
  }
  return "Usage: permission <grant|revoke> <permission>";
}

async function handleDeeplink(adb: AdbBridge, args: string[]): Promise<string> {
  const uri = args[0];
  if (!uri) return "Usage: deeplink <uri>";
  await adb.openDeepLink(uri);
  return `Opened deep link: ${uri}`;
}
