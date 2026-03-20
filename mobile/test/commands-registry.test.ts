import { describe, test, expect } from "bun:test";
import {
  READ_COMMANDS,
  WRITE_COMMANDS,
  META_COMMANDS,
  ALL_COMMANDS,
  COMMAND_DESCRIPTIONS,
} from "../src/commands";

describe("command registry", () => {
  test("ALL_COMMANDS is union of READ + WRITE + META", () => {
    const union = new Set([...READ_COMMANDS, ...WRITE_COMMANDS, ...META_COMMANDS]);
    expect(ALL_COMMANDS).toEqual(union);
  });

  test("no command appears in multiple sets", () => {
    const sets = [READ_COMMANDS, WRITE_COMMANDS, META_COMMANDS];
    for (let i = 0; i < sets.length; i++) {
      for (let j = i + 1; j < sets.length; j++) {
        const overlap = [...sets[i]].filter((c) => sets[j].has(c));
        expect(overlap).toEqual([]);
      }
    }
  });

  test("every command has a description", () => {
    for (const cmd of ALL_COMMANDS) {
      expect(COMMAND_DESCRIPTIONS[cmd]).toBeDefined();
      expect(COMMAND_DESCRIPTIONS[cmd].category).toBeTruthy();
      expect(COMMAND_DESCRIPTIONS[cmd].description).toBeTruthy();
    }
  });

  test("no extra descriptions exist", () => {
    for (const key of Object.keys(COMMAND_DESCRIPTIONS)) {
      expect(ALL_COMMANDS.has(key)).toBe(true);
    }
  });

  test("expected READ commands exist", () => {
    for (const cmd of ["snapshot", "text", "widgets", "eval", "console", "network", "perf", "storage", "is"]) {
      expect(READ_COMMANDS.has(cmd)).toBe(true);
    }
  });

  test("expected WRITE commands exist", () => {
    for (const cmd of ["tap", "fill", "scroll", "press", "longpress", "back", "reload", "restart", "permission", "deeplink"]) {
      expect(WRITE_COMMANDS.has(cmd)).toBe(true);
    }
  });

  test("expected META commands exist", () => {
    for (const cmd of ["screenshot", "devices", "device", "status", "stop", "chain", "diff", "sysui", "systrap"]) {
      expect(META_COMMANDS.has(cmd)).toBe(true);
    }
  });
});
