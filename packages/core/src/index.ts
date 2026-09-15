export {
  decide,
  projectEvent,
  emptyReadModel,
  DecideError,
  type DecideEnv,
} from "./decider.js";

export { EventStore } from "./store.js";

export {
  OrchestrationEngine,
  CommandConflictError,
  CommandRejectedError,
  type RoostEngine,
  type EngineOptions,
  type DispatchResult,
} from "./engine.js";

export {
  WorktreeManager,
  type WorktreeInfo,
  type RemoveResult,
} from "./worktree.js";

export {
  AsyncQueue,
  FakeProvider,
  ProviderRegistry,
  UnknownProviderError,
  defaultFakeScript,
  type ProviderAdapter,
  type ProviderCapabilities,
  type FakeScript,
  type FakeScriptContext,
  type FakeProviderOptions,
  type StartSessionInput,
  type SendTurnInput,
} from "./provider.js";

export {
  ClaudeCodeAdapter,
  parseControlRequest,
  type ClaudeCodeAdapterOptions,
} from "./claude.js";

export {
  ConfigError,
  RoostConfigFileSchema,
  loadConfig,
  parseConfigFile,
  projectConfigPath,
  roostHome,
  userConfigPath,
  type ConfigLayer,
  type ConfigSources,
  type LoadConfigInput,
  type ResolvedConfig,
  type RoostConfig,
  type RoostConfigFile,
  type HostConfig,
  type McpServerConfig,
  type LspServerConfig,
} from "./config.js";

export { TurnReactor, GitReactor, WorktreeReactor, worktreePathFor } from "./reactor.js";

export {
  resolveModel,
  parseModelRef,
  apiKeyEnv,
  UnknownModelProviderError,
  MissingModelProviderError,
  type ModelRef,
  type ResolveModelInput,
} from "./models.js";

export {
  NativeProvider,
  type NativeProviderOptions,
} from "./native.js";

export {
  ToolRegistry,
  ToolError,
  UnknownToolError,
  builtinTools,
  runTool,
  resolvePath,
  displayPath,
  type Tool,
  type ToolContext,
} from "./tools/index.js";

export {
  evaluate,
  allowAll,
  readOnly,
  type Permission,
  type PermissionRule,
  type Ruleset,
} from "./permissions.js";

export {
  builtinAgents,
  loadAgents,
  getAgent,
  UnknownAgentError,
  InvalidAgentError,
  type Agent,
  type LoadAgentsInput,
} from "./agents.js";

export { loadContext, type LoadContextInput } from "./context.js";

export {
  discoverSkills,
  skillTool,
  formatSkillsForPrompt,
  UnknownSkillError,
  InvalidSkillError,
  type Skill,
  type SkillsResult,
  type DiscoverSkillsInput,
} from "./skills.js";

export {
  estimateTokens,
  truncateHandoff,
  splitMessages,
  compactMessages,
  type Summarizer,
  type CompactionOptions,
} from "./compaction.js";

export {
  fanout,
  FanoutError,
  type FanoutEntry,
  type FanoutInput,
} from "./fanout.js";

export {
  CodexCliAdapter,
  normalizeCodexEvent,
  type CodexCliAdapterOptions,
} from "./codex.js";

export {
  runTurnAndWait,
  formatEventLine,
  type RunTurnAndWaitInput,
  type RunTurnAndWaitResult,
} from "./runmodes.js";

export {
  buildProviderRegistry,
  type BuildRegistryInput,
} from "./registry.js";

export {
  DaemonClient,
  type DaemonClientOptions,
} from "./client.js";

export {
  resolveHost,
  connectHost,
  LocalHost,
  UnresolvableHostError,
  UnsupportedHostKindError,
  type Host,
  type HostRoute,
  type DirEntry,
  type CommandResult,
} from "./hosts.js";

export {
  SshHost,
  SshUnreachableError,
  type SshHostOptions,
} from "./ssh/index.js";

export {
  createMcpSession,
  discoverMcpTools,
  mcpTool,
  McpConnectionError,
  type McpSession,
  type McpToolDef,
} from "./mcp.js";

export {
  LspClient,
  matchLspServer,
  formatDiagnostics,
  type LspDiagnostic,
  type LspClientOptions,
  type LspConnection,
} from "./lsp.js";

export {
  discoverCommands,
  expandCommand,
  commandPrompt,
  commandsDirFor,
  parseCommandFile,
  InvalidCommandError,
  type CommandDef,
} from "./commands.js";
