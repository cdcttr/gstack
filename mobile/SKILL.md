---
name: gstack-mobile
description: Flutter mobile app automation for Claude — inspect widgets, tap, fill, screenshot, hot reload
---

# /mobile — Flutter App Automation

You have access to a mobile automation tool that can control a Flutter app running on an Android emulator or device. Use it for QA, testing, debugging, and development workflows.

## Setup

Find the binary:
```bash
# Check project-local first, then global
if [ -f "$_ROOT/.claude/skills/gstack/mobile/dist/mobile" ]; then
  M="$_ROOT/.claude/skills/gstack/mobile/dist/mobile"
elif [ -f "$HOME/.claude/skills/gstack/mobile/dist/mobile" ]; then
  M="$HOME/.claude/skills/gstack/mobile/dist/mobile"
else
  echo "Mobile binary not found. Run gstack setup." >&2
  exit 1
fi
```

## Commands

### Reading (inspect state)

| Command | Description | Example |
|---------|-------------|---------|
| `snapshot` | Widget tree with @w refs | `$M snapshot` |
| `snapshot -v` | Full widget tree (verbose) | `$M snapshot -v` |
| `snapshot -s` | Semantics/accessibility tree | `$M snapshot -s` |
| `snapshot -D` | Diff vs previous snapshot | `$M snapshot -D` |
| `text` | All visible text | `$M text` |
| `widgets <query>` | Find widgets by type/name | `$M widgets Button` |
| `eval <expr>` | Evaluate Dart expression | `$M eval "1+1"` |
| `console` | Recent Dart print output | `$M console` |
| `network` | Recent HTTP requests | `$M network` |
| `perf` | Frame timing stats | `$M perf` |
| `storage` | SharedPreferences contents | `$M storage` |
| `is <condition>` | Check if widget exists | `$M is button labeled Submit` |

### Interaction (mutate state)

| Command | Description | Example |
|---------|-------------|---------|
| `tap <@ref\|label>` | Tap a widget | `$M tap @w3` |
| `fill <@ref> <text>` | Fill text field | `$M fill @w2 test@example.com` |
| `scroll <up\|down>` | Scroll the screen | `$M scroll down` |
| `press <key>` | Press a key | `$M press enter` |
| `longpress <@ref>` | Long press a widget | `$M longpress @w5` |
| `back` | System back button | `$M back` |
| `reload` | Hot reload (preserves state) | `$M reload` |
| `restart` | Hot restart (resets state) | `$M restart` |
| `permission <grant\|revoke> <perm>` | App permission | `$M permission grant android.permission.CAMERA` |
| `deeplink <uri>` | Open deep link | `$M deeplink myapp://profile/123` |

### Visual & Device

| Command | Description | Example |
|---------|-------------|---------|
| `screenshot [path]` | Capture screen | `$M screenshot /tmp/screen.png` |
| `devices` | List connected devices | `$M devices` |
| `device <id>` | Switch device | `$M device emulator-5554` |
| `rotate <portrait\|landscape>` | Change orientation | `$M rotate landscape` |

### System UI (for dialogs outside Flutter)

| Command | Description | Example |
|---------|-------------|---------|
| `sysui` | Dump system UI with @s refs | `$M sysui` |
| `systrap <@sN>` | Tap system UI element | `$M systrap @s1` |

### Server

| Command | Description |
|---------|-------------|
| `status` | Health check |
| `stop` | Shutdown server |
| `restart-app` | Full app restart |
| `chain` | Run commands from JSON stdin |
| `diff` | Diff current vs last snapshot |

## Workflow Examples

### Login flow test
```bash
$M snapshot
# Find the email field, password field, and sign in button refs
$M fill @w2 test@example.com
$M fill @w3 secretpass123
$M tap @w4
$M snapshot -D
# Verify navigation happened
```

### Check if a widget exists
```bash
$M is button labeled Submit
# Returns: Yes — found ElevatedButton "Submit" at @w5
# Or: No — no widget matching "Submit" found
```

### Handle a permission dialog
```bash
# A permission dialog appears (outside Flutter)
$M sysui
# Shows: @s1 [Button] "Allow" (720,1250)
#        @s2 [Button] "Deny" (360,1250)
$M systrap @s1
```

### Hot reload after code change
```bash
# After editing lib/some_file.dart:
$M reload
$M snapshot -D
# See what changed in the widget tree
```

### QA screenshot workflow
```bash
$M snapshot
$M screenshot /tmp/login-screen.png
$M fill @w2 test@example.com
$M fill @w3 password
$M tap @w4
$M screenshot /tmp/after-login.png
```

### Deep link testing
```bash
$M deeplink myapp://settings/profile
$M snapshot
$M text
```

## Notes

- The server starts automatically on first command (launches `flutter run --machine`)
- First command may take 15-30 seconds while Flutter builds and starts
- @w refs are invalidated on navigation and hot reload — run `snapshot` again
- @s refs (system UI) are separate from @w refs (Flutter widgets)
- `eval` requires managed mode (server started the Flutter process)
- Set `MOBILE_FLUTTER_ARGS` env var for custom flutter run args (e.g., `--flavor staging`)
- Set `MOBILE_DEVICE_ID` to target a specific device
