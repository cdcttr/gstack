import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { resolveConfig, ensureStateDir } from "../src/config";

describe("resolveConfig", () => {
  test("derives paths from MOBILE_STATE_FILE env", () => {
    const config = resolveConfig({
      MOBILE_STATE_FILE: "/tmp/test-project/.gstack/mobile.json",
    });
    expect(config.stateFile).toBe("/tmp/test-project/.gstack/mobile.json");
    expect(config.stateDir).toBe("/tmp/test-project/.gstack");
    expect(config.projectDir).toBe("/tmp/test-project");
  });

  test("log file paths are in state dir", () => {
    const config = resolveConfig({
      MOBILE_STATE_FILE: "/tmp/proj/.gstack/mobile.json",
    });
    expect(config.consoleLog).toBe("/tmp/proj/.gstack/mobile-console.log");
    expect(config.networkLog).toBe("/tmp/proj/.gstack/mobile-network.log");
  });
});

describe("ensureStateDir", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-config-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("creates .gstack directory", () => {
    const config = resolveConfig({
      MOBILE_STATE_FILE: path.join(tmpDir, ".gstack", "mobile.json"),
    });
    ensureStateDir(config);
    expect(fs.existsSync(config.stateDir)).toBe(true);
  });

  test("adds .gstack/ to .gitignore if not present", () => {
    const gitignorePath = path.join(tmpDir, ".gitignore");
    fs.writeFileSync(gitignorePath, "node_modules/\n");
    const config = resolveConfig({
      MOBILE_STATE_FILE: path.join(tmpDir, ".gstack", "mobile.json"),
    });
    ensureStateDir(config);
    const content = fs.readFileSync(gitignorePath, "utf-8");
    expect(content).toContain(".gstack/");
  });

  test("does not duplicate .gstack/ in .gitignore", () => {
    const gitignorePath = path.join(tmpDir, ".gitignore");
    fs.writeFileSync(gitignorePath, ".gstack/\nnode_modules/\n");
    const config = resolveConfig({
      MOBILE_STATE_FILE: path.join(tmpDir, ".gstack", "mobile.json"),
    });
    ensureStateDir(config);
    const content = fs.readFileSync(gitignorePath, "utf-8");
    const matches = content.match(/\.gstack\//g);
    expect(matches?.length).toBe(1);
  });
});
