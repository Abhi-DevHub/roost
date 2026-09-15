import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Roost configuration. Merged with precedence project > user > defaults.
// Unknown keys and invalid values are an explicit error (never silently
// ignored). Missing files fall back to defaults.
//
//   project: <projectRoot>/.roost/config.json
//   user:    ~/.config/roost/config.json        (Linux/macOS)
//            %APPDATA%\roost\config.json        (Windows)
// ---------------------------------------------------------------------------

/** A configured SSH execution host. */
export const HostConfigSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal("ssh"),
    host: z.string().min(1),
    user: z.string().min(1),
    port: z.number().int().positive().optional(),
    keyPath: z.string().min(1).optional(),
  })
  .strict();

export type HostConfig = z.infer<typeof HostConfigSchema>;

/** An MCP server: a stdio `command`/`args`/`env` OR a streamable-HTTP `url`. */
export const McpServerConfigSchema = z.union([
  z
    .object({
      command: z.string().min(1),
      args: z.array(z.string()).optional(),
      env: z.record(z.string(), z.string()).optional(),
    })
    .strict(),
  z.object({ url: z.string().min(1) }).strict(),
]);

export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

/** A language server: spawn `command args` and diagnose files with matching extensions. */
export const LspServerConfigSchema = z
  .object({
    name: z.string().min(1),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    extensions: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type LspServerConfig = z.infer<typeof LspServerConfigSchema>;

export const RoostConfigFileSchema = z
  .object({
    /** Default provider adapter name (e.g. `"claude-cli"` or `"fake"`). */
    provider: z.string().min(1).optional(),
    /** Model for the Claude adapter (`--model`); omitted → Claude's default. */
    model: z.string().min(1).optional(),
    /** Branch prefix for planned worktree branches. */
    branchPrefix: z.string().min(1).optional(),
    /** Absolute directory under which worktrees are materialized. */
    worktreesDir: z.string().min(1).optional(),
    /** `"acceptEdits"` auto-accepts file edits; `"manual"` prompts for everything. */
    permissionMode: z.enum(["acceptEdits", "manual"]).optional(),
    /** Reserved for Phase 2 (native agents). */
    agentsDir: z.string().min(1).optional(),
    /** Reserved for Phase 2 (skills). */
    skillsDir: z.string().min(1).optional(),
    /** Base URL of the Roost daemon the CLI talks to. */
    serverUrl: z.string().min(1).optional(),
    /** SSH execution hosts (resolved by `ssh:<id>` host routes). */
    hosts: z.array(HostConfigSchema).optional(),
    /** MCP servers by name (their tools surface as `mcp__<server>__<tool>`). */
    mcpServers: z.record(z.string().min(1), McpServerConfigSchema).optional(),
    /** Language servers for `diagnostics(path)`. */
    lspServers: z.array(LspServerConfigSchema).optional(),
  })
  .strict();

export type RoostConfigFile = z.infer<typeof RoostConfigFileSchema>;

/** The fully-merged effective config, with optional fields left unset. */
export interface RoostConfig {
  provider: string;
  model?: string;
  branchPrefix: string;
  worktreesDir: string;
  permissionMode: "acceptEdits" | "manual";
  agentsDir?: string;
  skillsDir?: string;
  serverUrl: string;
  hosts: HostConfig[];
  mcpServers: Record<string, McpServerConfig>;
  lspServers: LspServerConfig[];
}

export type ConfigLayer = "default" | "user" | "project";

/** Which layer resolved each field of the merged config. */
export type ConfigSources = { [K in keyof RoostConfig]: ConfigLayer };

export interface ResolvedConfig {
  config: RoostConfig;
  sources: ConfigSources;
}

/** A config file could not be read or failed validation. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Roost state home: `$ROOST_HOME` or `~/.roost`. */
export function roostHome(): string {
  return process.env.ROOST_HOME ?? join(homedir(), ".roost");
}

/** User config path, platform-aware. */
export function userConfigPath(): string {
  if (process.platform === "win32") {
    const base = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(base, "roost", "config.json");
  }
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "roost", "config.json");
}

/** Project config path for a project root. */
export function projectConfigPath(projectRoot: string): string {
  return join(projectRoot, ".roost", "config.json");
}

function defaults(): RoostConfig {
  return {
    provider: "claude-cli",
    branchPrefix: "roost",
    worktreesDir: join(roostHome(), "worktrees"),
    permissionMode: "acceptEdits",
    serverUrl: "http://127.0.0.1:4318",
    hosts: [],
    mcpServers: {},
    lspServers: [],
  };
}

/** Parse + validate a config file's JSON. Throws `ConfigError` on bad JSON, invalid values, or unknown keys. */
export function parseConfigFile(json: string, source: string): RoostConfigFile {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new ConfigError(
      `invalid JSON in ${source}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const result = RoostConfigFileSchema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
      .join("; ");
    throw new ConfigError(`invalid config in ${source}: ${detail}`);
  }
  return result.data;
}

export interface LoadConfigInput {
  /** Project root; its `<root>/.roost/config.json` becomes the top layer. */
  projectRoot?: string;
  /** Override the user config path (tests / pre-resolved paths). */
  userConfigPath?: string;
}

const ALL_KEYS: (keyof RoostConfig)[] = [
  "provider",
  "model",
  "branchPrefix",
  "worktreesDir",
  "permissionMode",
  "agentsDir",
  "skillsDir",
  "serverUrl",
  "hosts",
  "mcpServers",
  "lspServers",
];

/** Load and merge config with precedence project > user > defaults. */
export function loadConfig(input: LoadConfigInput = {}): ResolvedConfig {
  const config = defaults();
  const sources = {} as ConfigSources;
  for (const k of ALL_KEYS) sources[k] = "default";

  const userPath = input.userConfigPath ?? userConfigPath();
  if (existsSync(userPath)) {
    applyLayer(config, sources, "user", parseConfigFile(readFileSync(userPath, "utf8"), userPath));
  }

  if (input.projectRoot) {
    const projPath = projectConfigPath(input.projectRoot);
    if (existsSync(projPath)) {
      applyLayer(config, sources, "project", parseConfigFile(readFileSync(projPath, "utf8"), projPath));
    }
  }

  return { config, sources };
}

function applyLayer(
  config: RoostConfig,
  sources: ConfigSources,
  layer: ConfigLayer,
  values: RoostConfigFile,
): void {
  if (values.provider !== undefined) {
    config.provider = values.provider;
    sources.provider = layer;
  }
  if (values.model !== undefined) {
    config.model = values.model;
    sources.model = layer;
  }
  if (values.branchPrefix !== undefined) {
    config.branchPrefix = values.branchPrefix;
    sources.branchPrefix = layer;
  }
  if (values.worktreesDir !== undefined) {
    config.worktreesDir = values.worktreesDir;
    sources.worktreesDir = layer;
  }
  if (values.permissionMode !== undefined) {
    config.permissionMode = values.permissionMode;
    sources.permissionMode = layer;
  }
  if (values.agentsDir !== undefined) {
    config.agentsDir = values.agentsDir;
    sources.agentsDir = layer;
  }
  if (values.skillsDir !== undefined) {
    config.skillsDir = values.skillsDir;
    sources.skillsDir = layer;
  }
  if (values.serverUrl !== undefined) {
    config.serverUrl = values.serverUrl;
    sources.serverUrl = layer;
  }
  if (values.hosts !== undefined) {
    config.hosts = values.hosts;
    sources.hosts = layer;
  }
  if (values.mcpServers !== undefined) {
    config.mcpServers = values.mcpServers;
    sources.mcpServers = layer;
  }
  if (values.lspServers !== undefined) {
    config.lspServers = values.lspServers;
    sources.lspServers = layer;
  }
}
