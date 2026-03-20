# Flutter Mobile Module (`mobile/`) — Design Spec

**Date**: 2026-03-19
**Status**: Draft
**Author**: Claude + djohnson

## Overview

A `mobile/` module for gstack that enables the full gstack skill workflow (QA, review, ship, etc.) for Flutter mobile app development. Mirrors the `browse/` module's persistent daemon architecture, replacing Playwright/Chromium with Flutter VM Service + `adb`.

**Primary target**: Android (emulator + physical device)
**Secondary target**: iOS Simulator (future, via `xcrun simctl` replacing `adb`)

## Goals

1. Functional parity with `browse/` so existing gstack skills (QA, review, ship) work for mobile apps
2. Same developer experience — Claude runs a binary, gets plain text back
3. No additional dependencies beyond Flutter SDK and Android SDK (already present in a Flutter dev environment)
4. Managed Flutter process by default, with attach-to-existing as a fallback

## Architecture

```
Claude ──runs──▶ mobile binary (thin CLI proxy)
                      │
                 reads .gstack/mobile.json (pid, port, token)
                      │
                 POST /command ──▶ mobile-server (localhost, token auth)
                      │
                      ├── FlutterManager (flutter run --machine, VM Service WebSocket)
                      ├── ADB Bridge (device ops, system UI, logcat)
                      └── Circular buffers (console, network, widget events)
```

### Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Daemon pattern | Persistent server with state file | Matches browse/, amortizes Flutter startup cost |
| Flutter communication | VM Service Protocol (WebSocket) | Same protocol DevTools uses; direct access to widget tree, hot reload, eval |
| Device operations | `adb` shell commands | Handles system UI, permissions, input — no extra dependencies |
| Language/runtime | Bun + TypeScript | Consistent with browse/, shared build pipeline |
| Ref system | `@w` refs from semantic tree | Mirrors browse/'s `@e` refs from ARIA tree |

### What's Different from browse/

- Manages a `flutter run` subprocess instead of Chromium
- Maintains a WebSocket connection to Dart VM Service (instead of Playwright API)
- Uses `adb` for device-level operations outside Flutter's render tree
- Widget tree / semantic tree instead of DOM / ARIA tree
- `@s` refs (system UI) as a second ref namespace for non-Flutter UI

## Command Model

### READ Commands (inspect state, no side effects)

| Command | Description | Mechanism |
|---|---|---|
| `snapshot` | Widget inspector summary tree with `@w` refs | `ext.flutter.inspector.getRootWidgetSummaryTree` with `objectGroup` param (see Spike Results) |
| `snapshot -v` | Full widget tree as text (verbose) | `ext.flutter.debugDumpApp` |
| `snapshot -s` | Semantics/accessibility tree (requires TalkBack) | `ext.flutter.debugDumpSemanticsTreeInTraversalOrder` |
| `snapshot -D` | Diff against last snapshot | `diff` library |
| `text` | All visible text on screen | Semantic tree text nodes |
| `widgets` | List widgets matching a type/key | VM Service widget inspector |
| `eval` | Evaluate Dart expression in app context | VM Service `evaluate` |
| `console` | Recent Dart print/log output | Flutter process stdout + VM Service logging stream |
| `network` | Recent HTTP requests/responses | VM Service `ext.dart.io.getHttpProfile` |
| `perf` | Frame timing, jank stats | VM Service performance overlay data |
| `storage` | SharedPreferences / secure storage | `eval` wrapper around storage APIs |
| `is` | Assert condition (e.g., "is there a button labeled Login?") | Semantic tree search, returns yes/no with context |

### WRITE Commands (mutate app state)

| Command | Description | Mechanism |
|---|---|---|
| `tap` | Tap widget by `@w` ref or label | See Tap Resolution section below; fallback: `adb input tap x,y` |
| `fill` | Enter text in a text field | See Text Input section below |
| `scroll` | Scroll a scrollable widget | `SemanticsAction.scrollForward/scrollBackward`; fallback: `adb input swipe` |
| `press` | Press a key (back, home, enter) | `adb shell input keyevent` |
| `longpress` | Long press a widget | `SemanticsAction.longPress`; fallback: `adb input swipe` (hold) |
| `back` | System back navigation | `adb shell input keyevent KEYCODE_BACK` |
| `reload` | Hot reload | VM Service `reloadSources` |
| `restart` | Hot restart | VM Service `hotRestart` |
| `permission` | Grant/revoke app permission | `adb shell pm grant/revoke` |
| `deeplink` | Open a deep link in the app | `adb shell am start -a android.intent.action.VIEW -d <uri>` |

### META Commands (lifecycle and tools)

| Command | Description | Mechanism |
|---|---|---|
| `screenshot` | Capture current screen | Primary: `adb screencap` (full screen); `--flutter-only` flag: `evaluate()` → `RepaintBoundary.toImage()` for Flutter surface only |
| `screenshot -a` | Annotated screenshot with `@w` ref overlays | Screenshot + overlay rendering |
| `devices` | List available devices/emulators | `flutter devices` / `adb devices` |
| `device` | Switch active device | Restart `flutter run` targeting new device |
| `status` | Server status, device info, app state | Health endpoint data |
| `stop` | Kill daemon and Flutter process | Graceful shutdown |
| `restart-app` | Full app restart (not hot restart) | Kill and relaunch via `flutter run` |
| `rotate` | Change device orientation | `adb shell settings` for rotation |
| `chain` | Execute multiple commands in sequence | JSON array of `[command, ...args]`; stops on first error, returns results collected so far plus the error |
| `diff` | Diff current vs last snapshot | Same as browse/ |
| `sysui` | Dump system UI hierarchy | `adb shell uiautomator dump` → `@s` refs |
| `systrap` | Tap system UI element | `adb shell input tap` with coordinates from `sysui` |

### Commands NOT Mapped from browse/

`goto`, `forward`, `cookies`, `cookie-import`, `header`, `useragent`, `pdf`, `html`, `css`, `attrs`, `links`, `forms`, `handoff`/`resume` — these are web-specific and have no mobile equivalent.

## Spike Results (2026-03-19)

Implementation spike validated against a real Flutter app (DropItApp on Android emulator, Dart VM 3.8.1, Flutter 3.x). Key findings:

### What works

| API | Status | Notes |
|-----|--------|-------|
| `ext.flutter.inspector.getRootWidgetSummaryTree` | Works | Requires `objectGroup` param (string). Returns structured JSON: `{description, valueId, widgetRuntimeType, children[], creationLocation}` |
| `ext.flutter.inspector.getChildrenSummaryTree` | Works | Drills into children by `valueId` |
| `ext.flutter.inspector.screenshot` | Works | Returns base64 PNG of a widget by `id` (valueId). Takes `width`/`height` params |
| `ext.flutter.debugDumpApp` | Works | Full widget tree as text (can be 50K+ chars) |
| `ext.flutter.debugDumpRenderTree` | Works | Render tree with sizes and positions |
| `ext.flutter.reassemble` | Works | Hot reload |
| `ext.dart.io.getHttpProfile` | Works | Network request profiling |
| `ext.flutter.inspector.isWidgetTreeReady` | Works | Returns `{result: true}` |

### What needs workarounds

| API | Issue | Workaround |
|-----|-------|------------|
| `evaluate()` | "No compilation service available" over raw WebSocket | Must connect via `flutter run --machine` which provides the DDS compilation service. Direct WebSocket connections bypass DDS. |
| `debugDumpSemanticsTreeInTraversalOrder` | "Semantics not generated" — requires accessibility enabled on device | Enable via `adb shell settings put secure enabled_accessibility_services com.google.android.marvin.talkback/...` and `accessibility_enabled 1`. Alternative: use widget inspector tree instead. |
| `getRootWidgetTree` | Null check error | Use `getRootWidgetSummaryTree` instead (works fine) |

### Design Implications

**Primary `@w` ref source: Widget Inspector Summary Tree** (not semantics tree). The `getRootWidgetSummaryTree` API returns reliable structured JSON without requiring accessibility to be enabled. Each node has a `valueId` that can be used for `getChildrenSummaryTree`, `screenshot`, and `getDetailsSubtree`.

**Semantics tree as secondary**: When accessibility is enabled, `debugDumpSemanticsTreeInTraversalOrder` provides the accessibility tree with semantic actions. The daemon should enable accessibility on the emulator at startup via `adb`, but fall back to the widget inspector tree if semantics aren't available.

**`evaluate()` works when managed**: When the daemon spawns `flutter run --machine` (managed mode), the DDS compilation service is available, so `evaluate()` works for tap dispatch, text input, and arbitrary Dart expression evaluation. In attach mode, `evaluate()` may not work if connecting directly to the VM service URI.

## Widget Inspector Tree vs Semantics Tree

**Widget inspector summary tree** (default `snapshot`): The primary tree for `@w` refs. Accessed via `ext.flutter.inspector.getRootWidgetSummaryTree` with params `{objectGroup: "<group>", subtreeDepth: "N"}`. Returns structured JSON with `valueId`, `description`, `widgetRuntimeType`, `children[]`, `creationLocation`. Filtered to "summary" nodes — skips internal framework widgets, showing only app-level widgets. Each node can be screenshotted via `ext.flutter.inspector.screenshot`.

**Semantics tree** (`snapshot -s` flag): The accessibility tree, when available. Accessed via `ext.flutter.debugDumpSemanticsTreeInTraversalOrder`. Contains semantic actions (tap, scroll, longPress) that enable direct interaction without coordinate-based fallback. Requires accessibility to be enabled on the device.

**Full widget tree** (`snapshot -v`): Complete hierarchy via `ext.flutter.debugDumpApp`. Returns plain text (not JSON). Very verbose — useful for debugging but too noisy for interaction.

### Tap Resolution

To tap a widget via its `@w` ref:

1. Look up the ref's `valueId` from the ref map
2. Use `ext.flutter.inspector.getDetailsSubtree` to get the widget's render object bounds
3. Primary: Use `evaluate()` to dispatch a tap gesture at the widget's center coordinates via `WidgetsBinding.instance.handlePointerEvent()` or `GestureBinding.instance.handlePointerEvent()`
4. Fallback: Use `adb shell input tap <x> <y>` at the center of the widget's bounding box

When semantics are available and the node has a `SemanticsAction.tap`, prefer dispatching via `evaluate()` calling `SemanticsOwner.performAction()`.

### Text Input

To fill a text field via its `@w` ref:

1. Tap the field first (using Tap Resolution above) to focus it
2. Primary mechanism: Use `evaluate()` to find the `EditableTextState` associated with the widget, access its `TextEditingController`, and call `controller.text = '<value>'` followed by `controller.selection = TextSelection.collapsed(offset: <value>.length)` and trigger `onChanged`
3. Fallback: If controller access fails (e.g., the field uses a custom input widget), use `adb shell input text '<escaped_value>'` which simulates IME keystrokes. This is slower for long text but universally compatible.

### Widget Inspector Object Groups

The widget inspector requires an `objectGroup` parameter (string) for all tree-fetching calls. Object groups manage the lifecycle of inspector references — all `valueId` refs belong to a group and are freed when the group is disposed. The daemon should:

1. Create a group per snapshot: `"mobile-snapshot-{N}"`
2. Dispose the previous group when a new snapshot is taken: `ext.flutter.inspector.disposeGroup`
3. Dispose all groups on shutdown: `ext.flutter.inspector.disposeAllGroups`

### Available VM Service Extensions (73 total)

Key extensions for the mobile module:
```
ext.flutter.inspector.getRootWidgetSummaryTree    # Primary tree source
ext.flutter.inspector.getChildrenSummaryTree       # Drill into children
ext.flutter.inspector.getDetailsSubtree            # Render object bounds
ext.flutter.inspector.screenshot                   # Widget screenshot (base64 PNG)
ext.flutter.inspector.isWidgetTreeReady            # Readiness check
ext.flutter.inspector.disposeGroup                 # Cleanup refs
ext.flutter.debugDumpSemanticsTreeInTraversalOrder # Semantics tree (when enabled)
ext.flutter.debugDumpApp                           # Full widget tree text
ext.flutter.debugDumpRenderTree                    # Render tree with sizes
ext.flutter.reassemble                             # Hot reload
ext.dart.io.getHttpProfile                         # Network profiling
ext.dart.io.httpEnableTimelineLogging              # Enable network logging
```

## Ref System

### `@w` Refs (Flutter widgets)

1. `snapshot` calls `ext.flutter.inspector.getRootWidgetSummaryTree` with an `objectGroup` and `subtreeDepth`
2. Walks the returned JSON tree, filtering to app-level widgets (those with `createdByLocalProject: true` or interactive types)
3. Assigns `@w1`, `@w2`, `@w3`... to each relevant node
4. Stores ref map: `@w1 → { valueId, type (widgetRuntimeType), description, creationLocation }`
5. Previous object group is disposed via `ext.flutter.inspector.disposeGroup`

**Output format:**
```
  @w1 [AppBar] "My App"
  @w2 [IconButton] "Menu"
  @w3 [TextField] "Email" [focused]
  @w4 [TextField] "Password"
  @w5 [ElevatedButton] "Sign In"
  @w6 [Text] "Forgot password?"
  @w7 [TextButton] "Create account"
```

**Ref resolution priority:**
1. Semantics ID → dispatch `SemanticsAction` directly (most reliable)
2. Bounding box coordinates → `adb shell input tap x,y` (fallback for non-semantic widgets)

**Ref invalidation on:**
- Route navigation (push/pop)
- Hot reload / hot restart
- New `snapshot` call (replaces ref map)

### `@s` Refs (System UI)

For elements outside Flutter (permission dialogs, notifications, system settings):
1. `sysui` calls `adb shell uiautomator dump`
2. Parses XML hierarchy
3. Assigns `@s1`, `@s2`... to interactive elements
4. Refs resolve to screen coordinates for `adb shell input tap`

The `@w` and `@s` namespaces are independent; both can be active simultaneously. A `systrap @s3` command never conflicts with a `tap @w3` command.

## Flutter Process Management

### Managed Mode (default)

1. Daemon spawns `flutter run -d <deviceId> --machine` (plus any additional args from `MOBILE_FLUTTER_ARGS` env var, e.g., `--flavor staging --dart-define=ENV=dev`)
2. Parses JSON stdout to extract VM Service WebSocket URI (`app.debugPort` event)
3. Opens persistent WebSocket to `ws://127.0.0.1:<port>/<secret>/ws`
4. On shutdown: sends `app.stop`, waits 5 seconds, then kills

### Attach Mode

1. Discovers already-running Flutter app via `flutter attach --machine`
2. Same WebSocket connection
3. On shutdown: disconnects but does NOT kill the app
4. For physical devices, ensure port forwarding is configured: `adb forward tcp:<local_port> tcp:<vm_service_port>`. In managed mode, `flutter run` handles this automatically.

### Crash Recovery

- Flutter process exit → daemon exits (same as browse/'s `browser.on('disconnected')`)
- CLI detects stale PID on next command, restarts daemon
- VM Service WebSocket drop → one reconnect attempt before exit
- In-flight VM Service requests receive a rejection with error `VM_SERVICE_DISCONNECTED`. The command handler surfaces this to the CLI as a recoverable error with hint: "App may have crashed. Check `console` for details."

### Device Selection

1. `adb devices` on startup
2. One device → use it; multiple → prefer emulator unless `MOBILE_DEVICE_ID` env is set
3. `deviceId` stored in state file
4. `device` command switches by restarting `flutter run` with new `-d` target

## Server Implementation

### Directory Structure

```
gstack/
  mobile/
    src/
      server.ts           # HTTP daemon, routing, auth, idle timeout
      cli.ts              # Thin proxy — state file, lifecycle, command dispatch
      commands.ts          # Command vocabulary (READ/WRITE/META sets + descriptions)
      flutter-manager.ts   # Flutter process lifecycle, VM Service, hot reload
      adb-bridge.ts        # adb command execution, device management, system UI
      snapshot.ts          # Semantic tree → @w refs, diff, annotated screenshots
      read-commands.ts     # text, widgets, eval, console, network, perf, storage, is
      write-commands.ts    # tap, fill, scroll, press, longpress, back, reload, restart, permission, deeplink
      meta-commands.ts     # screenshot, devices, device, status, stop, restart-app, rotate, chain, diff, sysui, systrap
      buffers.ts           # CircularBuffer (reuse pattern from browse/)
      config.ts            # Path resolution, state file, device config
      vm-service.ts        # WebSocket client for Dart VM Service Protocol
    test/
      test-app/            # Minimal Flutter app fixture
      commands.test.ts
      snapshot.test.ts
      flutter-manager.test.ts
      adb-bridge.test.ts
      vm-service.test.ts
    SKILL.md
    SKILL.md.tmpl
    package.json
```

### State File: `.gstack/mobile.json`

```json
{
  "pid": 12345,
  "port": 34567,
  "token": "uuid-here",
  "deviceId": "emulator-5554",
  "deviceName": "Pixel 7 API 34",
  "vmServiceUri": "ws://127.0.0.1:8181/abc123=/ws",
  "flutterPid": 12346,
  "startedAt": "2026-03-19T10:00:00Z",
  "binaryVersion": "a1b2c3d"
}
```

### Key Implementation Notes

**`vm-service.ts`**: JSON-RPC 2.0 client over WebSocket. Manages request IDs, response correlation, typed methods (`getWidgetTree()`, `evaluate()`, `reloadSources()`, `hotRestart()`, `screenshot()`, `getHttpProfile()`). Auto-reconnects once on disconnect.

**`flutter-manager.ts`**: Analogous to `browser-manager.ts`. Spawns `flutter run --machine`, parses JSON events, holds the `VmService` instance, stores ref map, tracks device and app state.

**`adb-bridge.ts`**: Thin wrapper — `execAdb(...args)` runs `adb -s <deviceId> <args>` via `Bun.spawn` with explicit argument arrays (no shell interpolation).

**`buffers.ts`**: Same `CircularBuffer<T>` pattern as browse/. Captures Flutter console output, network requests (via `ext.dart.io.getHttpProfile`), and widget rebuild events.

## Skill Integration

### Project Detection

A Flutter project is detected when `pubspec.yaml` exists at the git root AND either contains `flutter:` in the `dependencies` section or the `android/` directory exists. This distinguishes Flutter projects from pure Dart packages (server-side, CLI tools) that also have `pubspec.yaml`.

### Skill Template Conditional

```
# If Flutter project detected (pubspec.yaml with flutter dependency + android/ dir):
  $M = resolved path to mobile binary
  Use $M <command> for app interaction
# Else if web project:
  $B = resolved path to browse binary
  Use $B <command> for browser interaction
```

### Command Parity

Commands are deliberately named close to browse/ so skills that say "run snapshot, find the login button, tap it, fill email, take a screenshot" work with either module. Mobile-specific commands (`deeplink`, `permission`, `rotate`, `sysui`, `systrap`, `reload`, `restart`) are additive.

### SKILL.md Generation

`mobile/SKILL.md.tmpl` → `mobile/SKILL.md` via `bun run gen:skill-docs`, documenting the full command vocabulary with worked examples.

## Testing Strategy

### Test Fixture

Minimal Flutter app in `mobile/test/test-app/`:
- Login screen (text fields, buttons, form validation)
- List screen (scrollable, tappable items)
- Detail screen (navigation, back)
- Settings screen (toggles, dropdowns, permissions)
- Named `Key` values on widgets for predictable ref resolution

### Unit Tests (no emulator required)

- `vm-service.test.ts` — JSON-RPC message building, response correlation, reconnect (mocked WebSocket)
- `adb-bridge.test.ts` — command construction, output parsing (mocked `Bun.spawn`)
- `snapshot.test.ts` — semantic tree parsing, `@w` ref assignment, diff, filtering
- `config.test.ts` — path resolution, state file read/write

### Integration Tests (require Android emulator)

- `commands.test.ts` — all READ/WRITE/META commands against test fixture app
- `flutter-manager.test.ts` — process start, hot reload, crash recovery, attach mode

### CI

- Integration tests use `reactivecircus/android-emulator-runner` on GitHub Actions
- Tests split into `test:unit` and `test:integration` scripts

## Future: iOS Support

iOS Simulator support would add:
- `xcrun simctl` replacing `adb` for device management, screenshots, input
- `ios-deploy` or `xcrun` for physical device support
- Same VM Service connection (Flutter's VM service works identically on iOS)
- `@s` refs would use Accessibility Inspector APIs instead of `uiautomator`
- Device selection logic extended to handle both Android and iOS targets
