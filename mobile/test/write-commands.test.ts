import { describe, test, expect } from "bun:test";
import {
  resolveKeycode,
  buildTapExpression,
  buildFillExpression,
  buildBoundsExpression,
  parseBoundsResult,
} from "../src/write-commands";

describe("resolveKeycode", () => {
  test("maps common key names to Android keycodes", () => {
    expect(resolveKeycode("back")).toBe("KEYCODE_BACK");
    expect(resolveKeycode("home")).toBe("KEYCODE_HOME");
    expect(resolveKeycode("enter")).toBe("KEYCODE_ENTER");
    expect(resolveKeycode("tab")).toBe("KEYCODE_TAB");
    expect(resolveKeycode("escape")).toBe("KEYCODE_ESCAPE");
  });

  test("case insensitive", () => {
    expect(resolveKeycode("Back")).toBe("KEYCODE_BACK");
    expect(resolveKeycode("ENTER")).toBe("KEYCODE_ENTER");
  });

  test("passes through KEYCODE_ prefixed values", () => {
    expect(resolveKeycode("KEYCODE_VOLUME_UP")).toBe("KEYCODE_VOLUME_UP");
  });

  test("constructs KEYCODE_ for unknown keys", () => {
    expect(resolveKeycode("power")).toBe("KEYCODE_POWER");
  });
});

describe("buildTapExpression", () => {
  test("builds performAction expression for tap", () => {
    const expr = buildTapExpression(42);
    expect(expr).toContain("performAction");
    expect(expr).toContain("42");
    expect(expr).toContain("SemanticsAction.tap");
  });
});

describe("buildFillExpression", () => {
  test("builds controller text set expression", () => {
    const expr = buildFillExpression("hello world");
    expect(expr).toContain("hello world");
    expect(expr).toContain("controller");
  });

  test("escapes single quotes in text", () => {
    const expr = buildFillExpression("it's a test");
    expect(expr).toContain("\\'");
  });

  test("escapes backslashes in text", () => {
    const expr = buildFillExpression("path\\to\\file");
    expect(expr).toContain("\\\\");
  });
});

describe("buildBoundsExpression", () => {
  test("builds expression that finds widget by key", () => {
    const expr = buildBoundsExpression("email_field");
    expect(expr).toContain("email_field");
    expect(expr).toContain("localToGlobal");
    expect(expr).toContain("RenderBox");
    expect(expr).toContain("Offset.zero");
  });

  test("escapes double quotes in key string", () => {
    const expr = buildBoundsExpression('key"with"quotes');
    expect(expr).toContain('\\"');
  });

  test("returns not_found when widget not found", () => {
    const expr = buildBoundsExpression("nonexistent_widget");
    expect(expr).toContain("not_found");
  });
});

describe("parseBoundsResult", () => {
  test("parses valid bounds string", () => {
    const result = parseBoundsResult("24.0,103.6,363.4,56.0");
    expect(result).toEqual({ x: 24, y: 103.6, w: 363.4, h: 56 });
  });

  test("returns null for not_found", () => {
    expect(parseBoundsResult("not_found")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseBoundsResult("")).toBeNull();
  });

  test("returns null for malformed input", () => {
    expect(parseBoundsResult("1,2,3")).toBeNull();
    expect(parseBoundsResult("a,b,c,d")).toBeNull();
  });

  test("handles integer values", () => {
    const result = parseBoundsResult("0,0,100,50");
    expect(result).toEqual({ x: 0, y: 0, w: 100, h: 50 });
  });
});
