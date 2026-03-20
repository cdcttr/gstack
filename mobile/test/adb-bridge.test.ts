import { describe, test, expect } from "bun:test";
import { AdbBridge } from "../src/adb-bridge";

describe("AdbBridge", () => {
  test("constructs correct adb command with device ID", () => {
    const bridge = new AdbBridge("emulator-5554");
    const args = bridge.buildArgs("shell", "input", "tap", "100", "200");
    expect(args).toEqual([
      "adb", "-s", "emulator-5554", "shell", "input", "tap", "100", "200",
    ]);
  });

  test("parses adb devices output", () => {
    const output = [
      "List of devices attached",
      "emulator-5554\tdevice",
      "R5CR1234567\tdevice",
      "",
    ].join("\n");
    const devices = AdbBridge.parseDeviceList(output);
    expect(devices).toEqual([
      { id: "emulator-5554", type: "emulator" },
      { id: "R5CR1234567", type: "device" },
    ]);
  });

  test("identifies emulators vs physical devices", () => {
    expect(AdbBridge.isEmulator("emulator-5554")).toBe(true);
    expect(AdbBridge.isEmulator("R5CR1234567")).toBe(false);
  });

  test("parses uiautomator XML into interactive elements", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy>
  <node class="android.widget.Button" text="Allow" bounds="[540,1200][900,1300]" clickable="true" />
  <node class="android.widget.Button" text="Deny" bounds="[180,1200][540,1300]" clickable="true" />
  <node class="android.widget.TextView" text="Allow access?" bounds="[180,1100][900,1150]" clickable="false" />
</hierarchy>`;
    const elements = AdbBridge.parseUiAutomatorXml(xml);
    expect(elements.length).toBe(2);
    expect(elements[0].text).toBe("Allow");
    expect(elements[0].bounds).toEqual({ x: 720, y: 1250 });
    expect(elements[1].text).toBe("Deny");
  });

  test("escapes text for adb input", () => {
    expect(AdbBridge.escapeInputText("hello world")).toBe("hello%sworld");
    expect(AdbBridge.escapeInputText("test@email.com")).toBe("test@email.com");
  });

  test("handles empty device list", () => {
    const output = "List of devices attached\n\n";
    const devices = AdbBridge.parseDeviceList(output);
    expect(devices).toEqual([]);
  });

  test("parses uiautomator XML with no clickable elements", () => {
    const xml = `<hierarchy><node class="android.widget.TextView" text="Hello" bounds="[0,0][100,50]" clickable="false" /></hierarchy>`;
    const elements = AdbBridge.parseUiAutomatorXml(xml);
    expect(elements).toEqual([]);
  });

  test("parses flutter emulators output", () => {
    const output = [
      "3 available emulators:",
      "",
      "Id                  • Name             • Manufacturer • Platform",
      "",
      "apple_ios_simulator • iOS Simulator    • Apple        • ios",
      "flutter_emulator    • flutter emulator • Google       • android",
      "tv_1080p            • tv 1080p         • Google       • android",
      "",
      "To run an emulator, run 'flutter emulators --launch <emulator id>'.",
    ].join("\n");
    const emulators = AdbBridge.parseEmulatorList(output);
    expect(emulators).toEqual(["flutter_emulator", "tv_1080p"]);
  });

  test("filters out iOS emulators", () => {
    const output = "apple_ios_simulator • iOS Simulator • Apple • ios";
    const emulators = AdbBridge.parseEmulatorList(output);
    expect(emulators).toEqual([]);
  });

  test("parses empty emulators list", () => {
    const output = "No emulators available.\n\nTo create a new emulator, run 'avdmanager create avd'.";
    const emulators = AdbBridge.parseEmulatorList(output);
    expect(emulators).toEqual([]);
  });
});
