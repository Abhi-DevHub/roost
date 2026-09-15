import { ClaudeCodeAdapter } from "./claude.js";
import { CodexCliAdapter } from "./codex.js";
import { FakeProvider, ProviderRegistry, UnknownProviderError, type ProviderAdapter } from "./provider.js";
import { NativeProvider } from "./native.js";
import type { Skill } from "./skills.js";
import type { HostConfig, McpServerConfig, LspServerConfig } from "./config.js";
import type { Host } from "./hosts.js";

// ---------------------------------------------------------------------------
// Build the daemon's provider registry: register all four adapters and mark
// the configured provider as the default. Unknown / unusable default is an
// explicit error, never a silent fallback.
// ---------------------------------------------------------------------------

export interface BuildRegistryInput {
  provider: string;
  model?: string;
  permissionMode: "acceptEdits" | "manual";
  agentsDir?: string;
  skills?: Skill[];
  hosts?: HostConfig[];
  mcpServers?: Record<string, McpServerConfig>;
  lspServers?: LspServerConfig[];
  /** Resolve the execution host for a thread (overrides hosts-based lookup). */
  hostResolver?: (threadId: string) => Host;
  /** Post-edit diagnostics callback (overrides lspServers-based lookup). */
  diagnostics?: (filePath: string) => Promise<string>;
}

export function buildProviderRegistry(input: BuildRegistryInput): ProviderRegistry {
  const registry = new ProviderRegistry();
  const add = (adapter: ProviderAdapter) =>
    registry.register(adapter, { default: adapter.provider === input.provider });

  add(new FakeProvider());
  add(new ClaudeCodeAdapter({ model: input.model, permissionMode: input.permissionMode }));
  add(new CodexCliAdapter({ model: input.model }));
  if (input.model) {
    add(
      new NativeProvider({
        model: input.model,
        agentsDir: input.agentsDir,
        skills: input.skills,
        hostResolver: input.hostResolver,
        diagnostics: input.diagnostics,
        mcpServers: input.mcpServers,
      }),
    );
  }

  if (!registry.has(input.provider)) {
    if (input.provider === "native") {
      throw new UnknownProviderError(
        'native provider requires a model: set "model": "provider:modelId" in config',
      );
    }
    throw new UnknownProviderError(input.provider);
  }
  return registry;
}
