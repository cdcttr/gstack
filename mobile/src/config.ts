/**
 * Shared config for mobile CLI + server.
 *
 * Resolution:
 *   1. MOBILE_STATE_FILE env → derive stateDir from parent
 *   2. git rev-parse --show-toplevel → projectDir/.gstack/
 *   3. process.cwd() fallback (non-git environments)
 */

import * as fs from "fs";
import * as path from "path";

export interface MobileConfig {
  projectDir: string;
  stateDir: string;
  stateFile: string;
  consoleLog: string;
  networkLog: string;
}

export function getGitRoot(): string | null {
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 2_000,
    });
    if (proc.exitCode !== 0) return null;
    return proc.stdout.toString().trim() || null;
  } catch {
    return null;
  }
}

export function resolveConfig(
  env: Record<string, string | undefined> = process.env,
): MobileConfig {
  let stateFile: string;
  let stateDir: string;
  let projectDir: string;

  if (env.MOBILE_STATE_FILE) {
    stateFile = env.MOBILE_STATE_FILE;
    stateDir = path.dirname(stateFile);
    projectDir = path.dirname(stateDir);
  } else {
    projectDir = getGitRoot() || process.cwd();
    stateDir = path.join(projectDir, ".gstack");
    stateFile = path.join(stateDir, "mobile.json");
  }

  return {
    projectDir,
    stateDir,
    stateFile,
    consoleLog: path.join(stateDir, "mobile-console.log"),
    networkLog: path.join(stateDir, "mobile-network.log"),
  };
}

export function ensureStateDir(config: MobileConfig): void {
  try {
    fs.mkdirSync(config.stateDir, { recursive: true });
  } catch (err: any) {
    if (err.code === "EACCES") {
      throw new Error(`Cannot create state directory ${config.stateDir}: permission denied`);
    }
    if (err.code === "ENOTDIR") {
      throw new Error(`Cannot create state directory ${config.stateDir}: a file exists at that path`);
    }
    throw err;
  }

  const gitignorePath = path.join(config.projectDir, ".gitignore");
  try {
    const content = fs.readFileSync(gitignorePath, "utf-8");
    if (!content.match(/^\.gstack\/?$/m)) {
      const separator = content.endsWith("\n") ? "" : "\n";
      fs.appendFileSync(gitignorePath, `${separator}.gstack/\n`);
    }
  } catch (err: any) {
    if (err.code !== "ENOENT") {
      const logPath = path.join(config.stateDir, "mobile-server.log");
      try {
        fs.appendFileSync(logPath, `[${new Date().toISOString()}] Warning: could not update .gitignore: ${err.message}\n`);
      } catch {}
    }
  }
}

export function readVersionHash(execPath: string = process.execPath): string | null {
  try {
    const versionFile = path.resolve(path.dirname(execPath), ".version");
    return fs.readFileSync(versionFile, "utf-8").trim() || null;
  } catch {
    return null;
  }
}
