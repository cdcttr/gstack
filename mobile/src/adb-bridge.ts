/**
 * Thin wrapper around adb commands.
 *
 * All commands use explicit argument arrays via Bun.spawn —
 * no shell interpolation, no injection risk.
 */

export interface AdbDevice {
  id: string;
  type: "emulator" | "device";
}

export interface UiElement {
  text: string;
  className: string;
  bounds: { x: number; y: number };
  rawBounds: string;
}

export class AdbBridge {
  constructor(private deviceId: string) {}

  buildArgs(...args: string[]): string[] {
    return ["adb", "-s", this.deviceId, ...args];
  }

  async exec(...args: string[]): Promise<string> {
    const fullArgs = this.buildArgs(...args);
    const proc = Bun.spawn(fullArgs, { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`adb command failed (exit ${exitCode}): ${fullArgs.join(" ")}\n${stderr}`);
    }
    return stdout.trim();
  }

  async tap(x: number, y: number): Promise<void> {
    await this.exec("shell", "input", "tap", String(Math.round(x)), String(Math.round(y)));
  }

  async swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number = 300): Promise<void> {
    await this.exec("shell", "input", "swipe",
      String(Math.round(x1)), String(Math.round(y1)),
      String(Math.round(x2)), String(Math.round(y2)),
      String(durationMs));
  }

  async inputText(text: string): Promise<void> {
    await this.exec("shell", "input", "text", AdbBridge.escapeInputText(text));
  }

  async keyevent(keycode: string): Promise<void> {
    await this.exec("shell", "input", "keyevent", keycode);
  }

  async screencap(): Promise<Buffer> {
    const fullArgs = this.buildArgs("exec-out", "screencap", "-p");
    const proc = Bun.spawn(fullArgs, { stdout: "pipe", stderr: "pipe" });
    const chunks: Uint8Array[] = [];
    const reader = proc.stdout.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    await proc.exited;
    return Buffer.concat(chunks);
  }

  async uiautomatorDump(): Promise<string> {
    await this.exec("shell", "uiautomator", "dump", "/sdcard/window_dump.xml");
    return await this.exec("shell", "cat", "/sdcard/window_dump.xml");
  }

  async grantPermission(pkg: string, permission: string): Promise<void> {
    await this.exec("shell", "pm", "grant", pkg, permission);
  }

  async revokePermission(pkg: string, permission: string): Promise<void> {
    await this.exec("shell", "pm", "revoke", pkg, permission);
  }

  async setRotation(rotation: 0 | 1 | 2 | 3): Promise<void> {
    await this.exec("shell", "settings", "put", "system", "accelerometer_rotation", "0");
    await this.exec("shell", "settings", "put", "system", "user_rotation", String(rotation));
  }

  async openDeepLink(uri: string): Promise<void> {
    await this.exec("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", uri);
  }

  async enableAccessibility(): Promise<void> {
    await this.exec("shell", "settings", "put", "secure", "accessibility_enabled", "1");
  }

  static async listDevices(): Promise<AdbDevice[]> {
    const proc = Bun.spawn(["adb", "devices"], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    return AdbBridge.parseDeviceList(stdout);
  }

  /** List available emulator AVDs (not running, just configured) */
  static async listEmulators(): Promise<string[]> {
    const proc = Bun.spawn(["flutter", "emulators"], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    return AdbBridge.parseEmulatorList(stdout);
  }

  static parseEmulatorList(output: string): string[] {
    const names: string[] = [];
    for (const line of output.split("\n")) {
      // Lines look like: "flutter_emulator    • flutter emulator • Google       • android"
      // Skip header line ("Id • Name • ...") and non-android entries
      const match = line.match(/^\s*(\S+)\s+•.*•\s*android\s*$/);
      if (match && match[1] !== "Id") names.push(match[1]);
    }
    return names;
  }

  /**
   * Launch an Android emulator by AVD name.
   * Returns the device ID (e.g., "emulator-5554") once it's booted.
   * The emulator process is backgrounded — caller is responsible for shutdown.
   */
  static async launchEmulator(avdName?: string): Promise<{ deviceId: string; process: ReturnType<typeof Bun.spawn> }> {
    // If no AVD specified, pick the first available
    if (!avdName) {
      const avds = await AdbBridge.listEmulators();
      if (avds.length === 0) {
        throw new Error("No Android emulators configured. Create one in Android Studio → Device Manager.");
      }
      avdName = avds[0];
    }

    // Record existing emulators so we can detect the new one
    const existingDevices = (await AdbBridge.listDevices())
      .filter(d => d.type === "emulator")
      .map(d => d.id);

    // Launch the emulator
    const emulatorProc = Bun.spawn(["flutter", "emulators", "--launch", avdName], {
      stdout: "pipe",
      stderr: "pipe",
    });

    // Wait for a new emulator device to appear in adb
    const timeout = 60_000; // 60 seconds for cold boot
    const start = Date.now();
    while (Date.now() - start < timeout) {
      await new Promise(r => setTimeout(r, 2000));
      const devices = await AdbBridge.listDevices();
      const newEmulator = devices.find(d => d.type === "emulator" && !existingDevices.includes(d.id));
      if (newEmulator) {
        // Wait for boot to complete
        await AdbBridge.waitForBoot(newEmulator.id);
        return { deviceId: newEmulator.id, process: emulatorProc };
      }
    }

    emulatorProc.kill();
    throw new Error(`Emulator "${avdName}" did not start within 60 seconds.`);
  }

  /** Wait for an emulator to finish booting (sys.boot_completed=1) */
  static async waitForBoot(deviceId: string, timeoutMs: number = 60_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const proc = Bun.spawn(
          ["adb", "-s", deviceId, "shell", "getprop", "sys.boot_completed"],
          { stdout: "pipe", stderr: "pipe" },
        );
        const stdout = await new Response(proc.stdout).text();
        await proc.exited;
        if (stdout.trim() === "1") return;
      } catch {}
      await new Promise(r => setTimeout(r, 1000));
    }
    throw new Error(`Emulator ${deviceId} did not finish booting within ${timeoutMs / 1000}s`);
  }

  /** Kill an emulator via adb emu kill */
  static async killEmulator(deviceId: string): Promise<void> {
    const proc = Bun.spawn(["adb", "-s", deviceId, "emu", "kill"], { stdout: "pipe", stderr: "pipe" });
    await proc.exited;
  }

  static parseDeviceList(output: string): AdbDevice[] {
    return output
      .split("\n")
      .slice(1)
      .filter((line) => line.includes("\tdevice"))
      .map((line) => {
        const id = line.split("\t")[0];
        return { id, type: AdbBridge.isEmulator(id) ? "emulator" : "device" };
      });
  }

  static isEmulator(deviceId: string): boolean {
    return deviceId.startsWith("emulator-");
  }

  static escapeInputText(text: string): string {
    return text.replace(/ /g, "%s");
  }

  static parseUiAutomatorXml(xml: string): UiElement[] {
    const elements: UiElement[] = [];
    const nodeRegex = /<node[^>]*?clickable="true"[^>]*?>/g;
    let match;
    while ((match = nodeRegex.exec(xml)) !== null) {
      const node = match[0];
      const text = node.match(/text="([^"]*)"/)?.[1] || "";
      const className = node.match(/class="([^"]*)"/)?.[1] || "";
      const rawBounds = node.match(/bounds="([^"]*)"/)?.[1] || "";
      const boundsMatch = rawBounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
      if (boundsMatch) {
        const [, x1, y1, x2, y2] = boundsMatch.map(Number);
        elements.push({
          text,
          className,
          bounds: { x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) },
          rawBounds,
        });
      }
    }
    return elements;
  }
}
