import { describe, test, expect } from "bun:test";
import { parseChainInput, formatStatus, formatDeviceList } from "../src/meta-commands";

describe("parseChainInput", () => {
  test("parses JSON array of command arrays", () => {
    const input = '[["tap","@w1"],["text"],["screenshot"]]';
    const commands = parseChainInput(input);
    expect(commands).toEqual([
      ["tap", "@w1"],
      ["text"],
      ["screenshot"],
    ]);
  });

  test("rejects invalid JSON", () => {
    expect(() => parseChainInput("not json")).toThrow();
  });

  test("rejects non-array input", () => {
    expect(() => parseChainInput('{"cmd":"tap"}')).toThrow();
  });

  test("rejects empty arrays within", () => {
    expect(() => parseChainInput('[["tap"],[]]')).toThrow();
  });
});

describe("formatStatus", () => {
  test("formats server status as text", () => {
    const status = {
      pid: 1234,
      uptime: 300,
      deviceId: "emulator-5554",
      deviceName: "Pixel 7",
      appState: "running",
      vmServiceUri: "ws://127.0.0.1:8181/abc=/ws",
    };
    const output = formatStatus(status);
    expect(output).toContain("emulator-5554");
    expect(output).toContain("running");
    expect(output).toContain("5m");
    expect(output).toContain("Pixel 7");
  });

  test("handles zero uptime", () => {
    const output = formatStatus({
      pid: 1, uptime: 0, deviceId: "d", deviceName: "d",
      appState: "launching", vmServiceUri: null,
    });
    expect(output).toContain("0s");
    expect(output).toContain("not connected");
  });
});

describe("formatDeviceList", () => {
  test("formats device list with current marker", () => {
    const devices = [
      { id: "emulator-5554", type: "emulator" as const },
      { id: "R5CR1234567", type: "device" as const },
    ];
    const output = formatDeviceList(devices, "emulator-5554");
    expect(output).toContain("emulator-5554");
    expect(output).toContain("*");
    expect(output).toContain("R5CR1234567");
  });

  test("handles empty device list", () => {
    expect(formatDeviceList([], "")).toContain("No devices");
  });

  test("no marker when no current device", () => {
    const devices = [{ id: "emulator-5554", type: "emulator" as const }];
    const output = formatDeviceList(devices, "other-device");
    expect(output).not.toContain("*");
  });
});
