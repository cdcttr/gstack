import { describe, test, expect } from "bun:test";
import { parseStateFile, generateHelpText } from "../src/cli";

describe("parseStateFile", () => {
  test("parses valid state JSON", () => {
    const json = JSON.stringify({
      pid: 1234, port: 5678, token: "abc-123",
      deviceId: "emulator-5554", flutterPid: 1235,
      startedAt: "2026-03-19T10:00:00Z", binaryVersion: "abc123",
    });
    const state = parseStateFile(json);
    expect(state.pid).toBe(1234);
    expect(state.port).toBe(5678);
    expect(state.token).toBe("abc-123");
    expect(state.deviceId).toBe("emulator-5554");
  });

  test("throws on invalid JSON", () => {
    expect(() => parseStateFile("not json")).toThrow();
  });

  test("throws on missing required fields", () => {
    expect(() => parseStateFile(JSON.stringify({ pid: 1234 }))).toThrow("missing required fields");
  });
});

describe("generateHelpText", () => {
  test("includes all command categories", () => {
    const help = generateHelpText();
    expect(help).toContain("Reading");
    expect(help).toContain("Interaction");
    expect(help).toContain("Visual");
    expect(help).toContain("Device");
    expect(help).toContain("Server");
    expect(help).toContain("Meta");
    expect(help).toContain("System");
  });

  test("includes snapshot command", () => {
    const help = generateHelpText();
    expect(help).toContain("snapshot");
  });

  test("includes tap command with usage", () => {
    const help = generateHelpText();
    expect(help).toContain("tap");
  });

  test("includes header", () => {
    const help = generateHelpText();
    expect(help).toContain("gstack mobile");
  });
});
