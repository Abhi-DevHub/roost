import type { LanguageModel } from "ai";

// ---------------------------------------------------------------------------
// Model layer — provider-agnostic via the Vercel AI SDK. Providers are lazy
// dynamic imports; `resolveModel` is the single place a (provider, modelId)
// pair becomes a `LanguageModel`. Unknown provider → explicit error, never a
// silent fallback.
// ---------------------------------------------------------------------------

export interface ModelRef {
  provider: string;
  modelId: string;
}

export class UnknownModelProviderError extends Error {
  constructor(provider: string) {
    super(`unknown model provider: ${provider} (expected one of anthropic, openai, deepseek, openrouter)`);
    this.name = "UnknownModelProviderError";
  }
}

export class MissingModelProviderError extends Error {
  constructor(ref: string) {
    super(`model ref must be "provider:modelId" (e.g. "anthropic:claude-sonnet-4-5"), got "${ref}"`);
    this.name = "MissingModelProviderError";
  }
}

/** Parse `"anthropic:claude-sonnet-4-5"` into `{ provider, modelId }`. */
export function parseModelRef(ref: string): ModelRef {
  const idx = ref.indexOf(":");
  if (idx <= 0 || idx === ref.length - 1) {
    throw new MissingModelProviderError(ref);
  }
  return { provider: ref.slice(0, idx), modelId: ref.slice(idx + 1) };
}

/** Environment variable holding the API key for a provider. */
export function apiKeyEnv(provider: string): string {
  switch (provider) {
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "openai":
      return "OPENAI_API_KEY";
    case "deepseek":
      return "DEEPSEEK_API_KEY";
    case "openrouter":
      return "OPENROUTER_API_KEY";
    default:
      throw new UnknownModelProviderError(provider);
  }
}

interface ModelFactory {
  createModel(modelId: string, apiKey?: string): LanguageModel;
}

/**
 * Lazy per-provider factories. Each dynamic-imports its provider package on
 * first use so the others are never loaded into a process that doesn't need
 * them.
 */
const BUNDLED_PROVIDERS: Record<string, () => Promise<ModelFactory>> = {
  anthropic: async () => {
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    return { createModel: (modelId, apiKey) => createAnthropic({ apiKey })(modelId) };
  },
  openai: async () => {
    const { createOpenAI } = await import("@ai-sdk/openai");
    return { createModel: (modelId, apiKey) => createOpenAI({ apiKey })(modelId) };
  },
  deepseek: async () => {
    const { createDeepSeek } = await import("@ai-sdk/deepseek");
    return { createModel: (modelId, apiKey) => createDeepSeek({ apiKey })(modelId) };
  },
  openrouter: async () => {
    const { createOpenRouter } = await import("@openrouter/ai-sdk-provider");
    return { createModel: (modelId, apiKey) => createOpenRouter({ apiKey })(modelId) };
  },
};

export interface ResolveModelInput {
  provider: string;
  modelId: string;
  /** Explicit key wins; otherwise the provider's standard env var is used. */
  apiKey?: string;
}

/** Resolve a `(provider, modelId)` pair to a `LanguageModel`. */
export async function resolveModel(input: ResolveModelInput): Promise<LanguageModel> {
  const loader = BUNDLED_PROVIDERS[input.provider];
  if (!loader) throw new UnknownModelProviderError(input.provider);
  const apiKey = input.apiKey ?? process.env[apiKeyEnv(input.provider)];
  const factory = await loader();
  return factory.createModel(input.modelId, apiKey);
}
