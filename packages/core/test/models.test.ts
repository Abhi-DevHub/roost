import { describe, it, expect } from "vitest";
import {
  parseModelRef,
  apiKeyEnv,
  resolveModel,
  UnknownModelProviderError,
  MissingModelProviderError,
} from "../src/index.js";

describe("parseModelRef", () => {
  it("splits provider:modelId", () => {
    expect(parseModelRef("anthropic:claude-sonnet-4-5")).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
    });
  });

  it("splits on the first colon only", () => {
    expect(parseModelRef("openrouter:anthropic/claude-sonnet-4-5")).toEqual({
      provider: "openrouter",
      modelId: "anthropic/claude-sonnet-4-5",
    });
  });

  it("rejects a ref without a provider", () => {
    expect(() => parseModelRef("gpt-4o")).toThrow(MissingModelProviderError);
    expect(() => parseModelRef("anthropic:")).toThrow(MissingModelProviderError);
    expect(() => parseModelRef(":gpt-4o")).toThrow(MissingModelProviderError);
  });
});

describe("apiKeyEnv", () => {
  it("maps known providers to their env var", () => {
    expect(apiKeyEnv("anthropic")).toBe("ANTHROPIC_API_KEY");
    expect(apiKeyEnv("openai")).toBe("OPENAI_API_KEY");
    expect(apiKeyEnv("deepseek")).toBe("DEEPSEEK_API_KEY");
    expect(apiKeyEnv("openrouter")).toBe("OPENROUTER_API_KEY");
  });

  it("rejects an unknown provider", () => {
    expect(() => apiKeyEnv("nope")).toThrow(UnknownModelProviderError);
  });
});

describe("resolveModel", () => {
  it("rejects an unknown provider with an explicit error (no silent fallback)", async () => {
    await expect(resolveModel({ provider: "nope", modelId: "x" })).rejects.toThrow(
      UnknownModelProviderError,
    );
  });
});
