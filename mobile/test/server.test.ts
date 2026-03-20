import { describe, test, expect } from "bun:test";
import { routeCommand, wrapError } from "../src/server";
import { READ_COMMANDS, WRITE_COMMANDS, META_COMMANDS } from "../src/commands";

describe("routeCommand", () => {
  test("routes read commands correctly", () => {
    for (const cmd of READ_COMMANDS) {
      expect(routeCommand(cmd)).toBe("read");
    }
  });

  test("routes write commands correctly", () => {
    for (const cmd of WRITE_COMMANDS) {
      expect(routeCommand(cmd)).toBe("write");
    }
  });

  test("routes meta commands correctly", () => {
    for (const cmd of META_COMMANDS) {
      expect(routeCommand(cmd)).toBe("meta");
    }
  });

  test("returns null for unknown commands", () => {
    expect(routeCommand("unknown")).toBeNull();
    expect(routeCommand("")).toBeNull();
  });
});

describe("wrapError", () => {
  test("translates VM_SERVICE_DISCONNECTED to user message", () => {
    const result = wrapError(new Error("VM_SERVICE_DISCONNECTED"));
    expect(result.error).toContain("crashed");
    expect(result.hint).toContain("console");
  });

  test("translates timeout to user message", () => {
    const result = wrapError(new Error("Timeout waiting for response"));
    expect(result.error).toContain("timed out");
  });

  test("translates expression compilation error", () => {
    const result = wrapError(new Error("Expression compilation error: no service"));
    expect(result.error).toContain("evaluation failed");
    expect(result.hint).toContain("managed mode");
  });

  test("passes through unknown errors", () => {
    const result = wrapError(new Error("Something weird"));
    expect(result.error).toBe("Something weird");
    expect(result.hint).toBeUndefined();
  });
});
