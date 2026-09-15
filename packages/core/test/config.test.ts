import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseConfigFile, ConfigError } from "../src/index.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "roost-config-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeUser(json: unknown): string {
  const p = join(root, "user-config.json");
  writeFileSync(p, JSON.stringify(json));
  return p;
}

function writeProject(projectRoot: string, json: unknown): void {
  const dir = join(projectRoot, ".roost");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(json));
}

describe("config", () => {
  it("defaults when no files exist", () => {
    const { config, sources } = loadConfig({
      userConfigPath: join(root, "missing.json"),
      projectRoot: join(root, "noproj"),
    });
    expect(config.provider).toBe("claude-cli");
    expect(config.branchPrefix).toBe("roost");
    expect(config.permissionMode).toBe("acceptEdits");
    expect(sources.provider).toBe("default");
    expect(sources.worktreesDir).toBe("default");
  });

  it("merges with precedence project > user > defaults", () => {
    const userPath = writeUser({
      provider: "fake",
      model: "user-model",
      branchPrefix: "user-br",
      permissionMode: "manual",
    });
    const projectRoot = join(root, "proj");
    writeProject(projectRoot, { branchPrefix: "proj-br", model: "proj-model" });

    const { config, sources } = loadConfig({ userConfigPath: userPath, projectRoot });

    expect(config.branchPrefix).toBe("proj-br");
    expect(sources.branchPrefix).toBe("project");
    expect(config.model).toBe("proj-model");
    expect(sources.model).toBe("project");
    expect(config.provider).toBe("fake");
    expect(sources.provider).toBe("user");
    expect(config.permissionMode).toBe("manual");
    expect(sources.permissionMode).toBe("user");
    expect(sources.worktreesDir).toBe("default");
  });

  it("rejects unknown keys with an explicit error", () => {
    const userPath = writeUser({ bogus: true });
    expect(() => loadConfig({ userConfigPath: userPath })).toThrow(ConfigError);
    expect(() => loadConfig({ userConfigPath: userPath })).toThrow(/unrecognized/i);
  });

  it("rejects an invalid permissionMode value", () => {
    const userPath = writeUser({ permissionMode: "bypassPermissions" });
    expect(() => loadConfig({ userConfigPath: userPath })).toThrow(/invalid/i);
  });

  it("rejects malformed JSON", () => {
    const p = join(root, "bad.json");
    writeFileSync(p, "{ not json");
    expect(() => loadConfig({ userConfigPath: p })).toThrow(/invalid JSON/i);
  });

  it("parseConfigFile surfaces the offending file path", () => {
    expect(() => parseConfigFile('{"nope": 1}', "/x/config.json")).toThrow(/\/x\/config\.json/);
  });
});
