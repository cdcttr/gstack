/**
 * Flutter process lifecycle manager.
 *
 * Analogous to browse/src/browser-manager.ts. Manages:
 * - Spawning `flutter run --machine` (managed mode)
 * - Attaching to existing apps (attach mode)
 * - VM Service connection via VmServiceClient
 * - Ref map storage (@w and @s namespaces)
 * - App state tracking
 */

import { VmServiceClient, type FlutterMachineEvent } from "./vm-service";
import { AdbBridge } from "./adb-bridge";
import { consoleBuffer, type LogEntry } from "./buffers";

// ── Event parsing (re-exported from VmServiceClient for convenience) ──

export function parseFlutterMachineEvent(line: string): FlutterMachineEvent | null {
  return VmServiceClient.parseFlutterMachineEvent(line);
}

export function extractVmServiceUri(event: FlutterMachineEvent): string | null {
  return VmServiceClient.extractVmServiceUri(event);
}

// ── App state machine ──

export class FlutterAppState {
  private _status: "launching" | "connecting" | "running" | "stopped" = "launching";

  get status(): string { return this._status; }

  handleEvent(event: FlutterMachineEvent): void {
    switch (event.event) {
      case "app.debugPort":
        this._status = "connecting";
        break;
      case "app.started":
        this._status = "running";
        break;
      case "app.stop":
        this._status = "stopped";
        break;
    }
  }
}

// ── Ref types ──

export interface WidgetRef {
  valueId: string;
  type: string;
  description: string;
  creationLocation: { file: string; line: number; column: number; name?: string } | null;
}

export interface SysUiRef {
  text: string;
  className: string;
  bounds: { x: number; y: number };
}

// ── Ref store ──

export class RefStore {
  private _widgetRefs = new Map<string, WidgetRef>();
  private _sysUiRefs = new Map<string, SysUiRef>();
  private _lastSnapshot: string | null = null;
  private _groupCounter = 0;
  private _currentGroup: string | null = null;

  setWidgetRefs(refs: Map<string, WidgetRef>): void { this._widgetRefs = refs; }
  getWidgetRef(id: string): WidgetRef | undefined { return this._widgetRefs.get(id); }
  get widgetRefs(): Map<string, WidgetRef> { return this._widgetRefs; }
  clearWidgetRefs(): void { this._widgetRefs.clear(); }

  setSysUiRefs(refs: Map<string, SysUiRef>): void { this._sysUiRefs = refs; }
  getSysUiRef(id: string): SysUiRef | undefined { return this._sysUiRefs.get(id); }
  clearSysUiRefs(): void { this._sysUiRefs.clear(); }

  get lastSnapshot(): string | null { return this._lastSnapshot; }
  set lastSnapshot(text: string | null) { this._lastSnapshot = text; }

  nextObjectGroup(): string {
    this._groupCounter++;
    this._currentGroup = `mobile-snapshot-${this._groupCounter}`;
    return this._currentGroup;
  }

  get currentObjectGroup(): string | null { return this._currentGroup; }
}

// ── Flutter Manager ──

export class FlutterManager {
  readonly vmService: VmServiceClient;
  adb: AdbBridge;
  readonly refs = new RefStore();
  readonly appState = new FlutterAppState();

  private flutterProc: ReturnType<typeof Bun.spawn> | null = null;
  private emulatorProc: ReturnType<typeof Bun.spawn> | null = null;
  private _managed = false;
  private _emulatorManaged = false;
  private _deviceId: string = "";
  private _deviceName: string = "";
  private _packageName: string = "";
  private _exitCallbacks: (() => void)[] = [];

  constructor(vmService: VmServiceClient, adb?: AdbBridge) {
    this.vmService = vmService;
    this.adb = adb || new AdbBridge("placeholder");
  }

  get deviceId(): string { return this._deviceId; }
  get deviceName(): string { return this._deviceName; }
  get packageName(): string { return this._packageName; }
  get managed(): boolean { return this._managed; }

  onExit(callback: () => void): void {
    this._exitCallbacks.push(callback);
  }

  private _fireExit(): void {
    for (const cb of this._exitCallbacks) cb();
  }

  /**
   * Ensure an emulator is running. If no devices are connected, launch one.
   * Returns the device ID to target.
   */
  async ensureEmulator(preferredDeviceId?: string): Promise<string> {
    const devices = await AdbBridge.listDevices();

    // If a specific device is requested, check if it's connected
    if (preferredDeviceId) {
      const found = devices.find(d => d.id === preferredDeviceId);
      if (found) return found.id;
      // Not found — if it looks like a physical device ID, error out
      if (!AdbBridge.isEmulator(preferredDeviceId)) {
        throw new Error(`Device ${preferredDeviceId} not connected. Connect it via USB and enable USB debugging.`);
      }
    }

    // If any emulator is already running, use it
    const existingEmulator = devices.find(d => d.type === "emulator");
    if (existingEmulator) return existingEmulator.id;

    // If a physical device is connected, use it
    if (devices.length > 0) return devices[0].id;

    // No devices at all — launch an emulator
    console.log("No devices connected. Launching Android emulator...");
    const avdName = process.env.MOBILE_EMULATOR_AVD;
    const { deviceId, process: proc } = await AdbBridge.launchEmulator(avdName);
    this.emulatorProc = proc;
    this._emulatorManaged = true;
    this.adb = new AdbBridge(deviceId);
    console.log(`Emulator started: ${deviceId}`);
    return deviceId;
  }

  /** Launch flutter run --machine and connect to VM Service */
  async launch(deviceId: string, flutterArgs: string[] = [], projectDir?: string): Promise<void> {
    this._managed = true;
    this._deviceId = deviceId;

    // Build flutter run command
    const args = ["flutter", "run", "-d", deviceId, "--machine", ...flutterArgs];

    // Add extra args from env
    const extraArgs = process.env.MOBILE_FLUTTER_ARGS;
    if (extraArgs) {
      args.push(...extraArgs.split(/\s+/).filter(Boolean));
    }

    // Resolve project directory: explicit param > env var > cwd
    const cwd = projectDir || process.env.MOBILE_PROJECT_DIR || process.cwd();

    // Detect package name from android build config
    this._packageName = await this._detectPackageName(cwd);

    this.flutterProc = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      cwd,
    });

    // Parse stdout line by line for machine events
    const vmServiceUri = await this._waitForVmService(this.flutterProc);

    // Connect VM Service
    await this.vmService.connect(vmServiceUri);
    await this.vmService.getVM();
    await this.vmService.getIsolate();

    // Enable HTTP profiling
    try {
      await this.vmService.enableHttpLogging();
    } catch {
      // Not critical
    }

    // Enable accessibility on emulator for semantics support
    if (AdbBridge.isEmulator(deviceId)) {
      try {
        await this.adb.enableAccessibility();
      } catch {
        // Not critical
      }
    }

    this.appState.handleEvent({ event: "app.started" });

    // Monitor process exit
    this.flutterProc.exited.then(() => {
      this.appState.handleEvent({ event: "app.stop" });
      this._fireExit();
    });
  }

  /** Attach to an already-running Flutter app */
  async attach(vmServiceUri: string): Promise<void> {
    this._managed = false;
    await this.vmService.connect(vmServiceUri);
    await this.vmService.getVM();
    await this.vmService.getIsolate();
    this.appState.handleEvent({ event: "app.started" });
  }

  /**
   * Graceful shutdown — full stack teardown:
   * 1. Force-stop the app on the device
   * 2. Kill the flutter run process
   * 3. Close VM Service connection
   * 4. Shut down the emulator (if we launched it)
   */
  async close(): Promise<void> {
    // 1. Force-stop the app on the device
    if (this._packageName) {
      try {
        await this.adb.exec("shell", "am", "force-stop", this._packageName);
      } catch {}
    }

    // 2. Kill flutter run first (before closing VM service, so no race)
    // Disable exit callbacks — this is an intentional shutdown, not a crash
    this._exitCallbacks = [];
    if (this._managed && this.flutterProc) {
      this.flutterProc.kill("SIGTERM");
      const exitPromise = this.flutterProc.exited;
      const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 5000));
      const result = await Promise.race([exitPromise, timeout]);
      if (result === "timeout") {
        this.flutterProc.kill("SIGKILL");
      }
      this.flutterProc = null;
    }

    // 3. Close VM Service
    this.vmService.close();

    // 4. Shut down emulator if we launched it
    if (this._emulatorManaged && this._deviceId) {
      console.log(`Shutting down emulator ${this._deviceId}...`);
      try {
        await AdbBridge.killEmulator(this._deviceId);
      } catch {}
      // Wait for emulator to actually disconnect (up to 15s)
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 500));
        try {
          const devices = await AdbBridge.listDevices();
          if (!devices.find(d => d.id === this._deviceId)) {
            console.log("Emulator stopped.");
            break;
          }
        } catch { break; }
      }
      if (this.emulatorProc) {
        this.emulatorProc.kill();
        this.emulatorProc = null;
      }
    }

    this.appState.handleEvent({ event: "app.stop" });
  }

  /** Evaluate a Dart expression */
  async evaluate(expression: string): Promise<string> {
    const result = await this.vmService.evaluate(expression);
    return result?.valueAsString ?? JSON.stringify(result);
  }

  /** Hot reload */
  async reloadSources(): Promise<{ success: boolean; message: string }> {
    try {
      await this.vmService.reassemble();
      return { success: true, message: "Hot reload successful" };
    } catch (e: any) {
      return { success: false, message: `Hot reload failed: ${e.message}` };
    }
  }

  /** Hot restart */
  async hotRestart(): Promise<{ success: boolean; message: string }> {
    try {
      await this.vmService.callExtension("ext.flutter.hotRestart");
      // Clear refs after restart since widget tree is rebuilt
      this.refs.clearWidgetRefs();
      return { success: true, message: "Hot restart successful" };
    } catch (e: any) {
      return { success: false, message: `Hot restart failed: ${e.message}` };
    }
  }

  // ── Private helpers ──

  /** Detect the Android package name from build.gradle or build.gradle.kts */
  private async _detectPackageName(projectDir: string): Promise<string> {
    const fs = await import("fs");
    const path = await import("path");

    for (const filename of ["build.gradle.kts", "build.gradle"]) {
      const filePath = path.join(projectDir, "android", "app", filename);
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        // Match: applicationId = "com.example.app" or applicationId "com.example.app"
        const match = content.match(/applicationId\s*[=]?\s*"([^"]+)"/);
        if (match) return match[1];
      } catch {
        continue;
      }
    }

    // Fallback: try to get from AndroidManifest.xml
    try {
      const manifestPath = path.join(projectDir, "android", "app", "src", "main", "AndroidManifest.xml");
      const content = fs.readFileSync(manifestPath, "utf-8");
      const match = content.match(/package="([^"]+)"/);
      if (match) return match[1];
    } catch {}

    return "";
  }

  private async _waitForVmService(proc: ReturnType<typeof Bun.spawn>): Promise<string> {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const timeout = setTimeout(() => {
      throw new Error("Timeout waiting for Flutter VM Service URI (15s)");
    }, 15_000);

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) throw new Error("Flutter process exited before providing VM Service URI");

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          // Log app output to console buffer
          const event = parseFlutterMachineEvent(line);
          if (event) {
            this.appState.handleEvent(event);

            if (event.event === "app.log" && event.params?.log) {
              consoleBuffer.push({
                timestamp: Date.now(),
                level: "info",
                text: event.params.log,
              });
            }

            const uri = extractVmServiceUri(event);
            if (uri) {
              // Release the reader so we can continue reading in background
              reader.releaseLock();
              this._startBackgroundStdoutReader(proc);
              return uri;
            }
          }
        }
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Continue reading stdout in the background for app.log events */
  private async _startBackgroundStdoutReader(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const event = parseFlutterMachineEvent(line);
          if (event) {
            this.appState.handleEvent(event);
            if (event.event === "app.log" && event.params?.log) {
              consoleBuffer.push({
                timestamp: Date.now(),
                level: "info",
                text: event.params.log,
              });
            }
          }
        }
      }
    } catch {
      // Process closed, expected
    }
  }
}
