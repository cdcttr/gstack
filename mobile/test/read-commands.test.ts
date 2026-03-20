import { describe, test, expect } from "bun:test";
import { formatConsoleEntries, formatNetworkEntries, matchIsCondition } from "../src/read-commands";
import type { WidgetRef } from "../src/flutter-manager";

describe("formatConsoleEntries", () => {
  test("formats log entries with timestamps and levels", () => {
    const entries = [
      { timestamp: 1710835200000, level: "info", text: "App started" },
      { timestamp: 1710835201000, level: "warning", text: "Low memory" },
    ];
    const output = formatConsoleEntries(entries);
    expect(output).toContain("[info] App started");
    expect(output).toContain("[warning] Low memory");
  });

  test("returns empty message when no entries", () => {
    expect(formatConsoleEntries([])).toContain("No console output");
  });
});

describe("formatNetworkEntries", () => {
  test("formats network entries as method/url/status/duration", () => {
    const entries = [
      { timestamp: 1710835200000, method: "GET", url: "https://api.example.com/data", status: 200, duration: 150 },
    ];
    const output = formatNetworkEntries(entries);
    expect(output).toContain("GET");
    expect(output).toContain("https://api.example.com/data");
    expect(output).toContain("200");
    expect(output).toContain("150ms");
  });

  test("handles pending requests", () => {
    const entries = [
      { timestamp: 1710835200000, method: "POST", url: "https://api.example.com/submit" },
    ];
    const output = formatNetworkEntries(entries);
    expect(output).toContain("pending");
  });

  test("returns empty message when no entries", () => {
    expect(formatNetworkEntries([])).toContain("No network requests");
  });
});

describe("matchIsCondition", () => {
  const refMap = new Map<string, WidgetRef>([
    ["@w1", { valueId: "v1", type: "ElevatedButton", description: "Sign In", creationLocation: null }],
    ["@w2", { valueId: "v2", type: "TextField", description: "Email", creationLocation: null }],
    ["@w3", { valueId: "v3", type: "Text", description: "Welcome back", creationLocation: null }],
  ]);

  test("matches button by label", () => {
    const result = matchIsCondition("button labeled Sign In", refMap);
    expect(result.found).toBe(true);
    expect(result.ref).toBe("@w1");
  });

  test("matches by description substring", () => {
    const result = matchIsCondition("Welcome", refMap);
    expect(result.found).toBe(true);
    expect(result.ref).toBe("@w3");
  });

  test("returns not found for missing widget", () => {
    const result = matchIsCondition("button labeled Submit", new Map());
    expect(result.found).toBe(false);
  });

  test("case insensitive matching", () => {
    const result = matchIsCondition("sign in", refMap);
    expect(result.found).toBe(true);
  });
});
