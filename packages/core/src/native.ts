import { randomUUID } from "node:crypto";
import {
  streamText,
  stepCountIs,
  tool as aiTool,
  type LanguageModel,
  type ModelMessage,
  type TextPart,
  type ToolCallPart,
  type ToolResultPart,
  type ToolSet,
} from "ai";
import { z } from "zod";
import type { ApprovalDecision, ProviderRuntimeEvent } from "@roost/contracts";
import {
  AsyncQueue,
  type DistributiveOmit,
  type ProviderAdapter,
  type ProviderCapabilities,
  type SendTurnInput,
  type StartSessionInput,
} from "./provider.js";
import { parseModelRef, resolveModel } from "./models.js";
import { builtinTools, runTool, resolvePath, ToolRegistry } from "./tools/index.js";
import { evaluate, type Ruleset } from "./permissions.js";
import { loadContext } from "./context.js";
import { getAgent, loadAgents, type Agent } from "./agents.js";
import { formatSkillsForPrompt, skillTool, type Skill } from "./skills.js";
import { LocalHost, type Host } from "./hosts.js";
import { createMcpSession, mcpTool, type McpSession } from "./mcp.js";
import type { McpServerConfig } from "./config.js";

// ---------------------------------------------------------------------------
// NativeProvider — the Tier-1 loop. Calls a model directly via the Vercel AI
// SDK, streams text deltas, extracts tool calls, executes them (parallel by
// default, gated by the agent's permission ruleset), appends results, and
// loops until the model stops calling tools. One native adapter serves every
// AI-SDK provider (the provider is config, not code).
// ---------------------------------------------------------------------------

export interface NativeProviderOptions {
  /** `"provider:modelId"`, e.g. `"anthropic:claude-sonnet-4-5"`. */
  model: string;
  /** Agent name (built-in or from `.roost/agents`). Defaults to `"build"`. */
  agent?: string;
  /** Explicit API key; otherwise the provider's standard env var is used. */
  apiKey?: string;
  /** Directory holding `.md` agent definitions (merged over built-ins). */
  agentsDir?: string;
  /** Override the tool set (tests). */
  tools?: ToolRegistry;
  /** Pre-resolved model (tests); bypasses `resolveModel`. */
  languageModel?: LanguageModel;
  /** Discovered skills; their name+description go into the system prompt. */
  skills?: Skill[];
  /** Resolve the execution host for a thread (defaults to local). */
  hostResolver?: (threadId: string) => Host;
  /** Post-edit diagnostics: (absolute path) → formatted string or "". */
  diagnostics?: (filePath: string) => Promise<string>;
  /** MCP servers whose tools surface as `mcp__<server>__<tool>`. */
  mcpServers?: Record<string, McpServerConfig>;
}

interface Session {
  cwd: string;
  host: Host;
  /** Conversation history (user/assistant text) for this thread. */
  history: { role: "user" | "assistant"; text: string }[];
  model?: LanguageModel;
  agent?: Agent;
  abort: boolean;
  controller: AbortController | null;
  activeTurnId: string | null;
}

function summarize(input: unknown): string {
  if (input == null) return "";
  const s = JSON.stringify(input);
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

export class NativeProvider implements ProviderAdapter {
  readonly provider = "native";
  readonly tier = "native" as const;
  readonly capabilities: ProviderCapabilities = {
    sessionModelSwitch: "in-session",
    supportsRollback: false,
    supportsCompaction: false,
    supportsApproval: true,
  };

  private readonly queue = new AsyncQueue<ProviderRuntimeEvent>();
  private readonly sessions = new Map<string, Session>();
  private readonly approvals = new Map<string, { threadId: string; resolve: (d: ApprovalDecision) => void }>();
  private readonly tools: ToolRegistry;
  private readonly modelRef: string;
  private readonly agentName: string;
  private readonly apiKey?: string;
  private readonly agentsDir?: string;
  private readonly languageModel?: LanguageModel;
  private readonly skills: Skill[];
  private readonly hostResolver?: (threadId: string) => Host;
  private readonly diagnostics?: (filePath: string) => Promise<string>;
  private readonly mcpServers: Record<string, McpServerConfig>;
  private readonly mcpSessions: McpSession[] = [];
  private readonly mcpWarnings: string[] = [];
  private mcpReady = false;
  private modelPromise: Promise<LanguageModel> | null = null;

  constructor(opts: NativeProviderOptions) {
    this.modelRef = opts.model;
    this.agentName = opts.agent ?? "build";
    this.apiKey = opts.apiKey;
    this.agentsDir = opts.agentsDir;
    this.languageModel = opts.languageModel;
    this.skills = opts.skills ?? [];
    this.hostResolver = opts.hostResolver;
    this.diagnostics = opts.diagnostics;
    this.mcpServers = opts.mcpServers ?? {};
    this.tools = opts.tools ?? builtinTools();
    if (this.skills.length > 0) this.tools.register(skillTool(this.skills));
  }

  private emit(threadId: string, event: DistributiveOmit<ProviderRuntimeEvent, "threadId">): void {
    this.queue.push({ ...event, threadId } as ProviderRuntimeEvent);
  }

  private model(): Promise<LanguageModel> {
    if (this.languageModel) return Promise.resolve(this.languageModel);
    this.modelPromise ??= (async () => {
      const { provider, modelId } = parseModelRef(this.modelRef);
      return resolveModel({ provider, modelId, apiKey: this.apiKey });
    })();
    return this.modelPromise;
  }

  private agent(): Agent {
    const agents = loadAgents({ agentsDir: this.agentsDir });
    return getAgent(agents, this.agentName);
  }

  async startSession(input: StartSessionInput): Promise<void> {
    this.sessions.set(input.threadId, {
      cwd: input.cwd,
      host: this.hostResolver?.(input.threadId) ?? new LocalHost(),
      history: [],
      abort: false,
      controller: null,
      activeTurnId: null,
    });
    this.emit(input.threadId, { type: "session.started" });
  }

  async sendTurn(input: SendTurnInput): Promise<void> {
    const session = this.sessions.get(input.threadId);
    if (!session) {
      this.emit(input.threadId, { type: "turn.failed", error: "session not started" });
      return;
    }
    session.activeTurnId = input.turnId;
    session.abort = false;
    try {
      await this.runLoop(input.threadId, input.prompt, session);
    } finally {
      session.activeTurnId = null;
      session.controller = null;
    }
  }

  async interruptTurn(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session || session.activeTurnId === null) return;
    session.abort = true;
    session.controller?.abort();
  }

  async respondToRequest(
    threadId: string,
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    const pending = this.approvals.get(requestId);
    if (!pending || pending.threadId !== threadId) return;
    this.approvals.delete(requestId);
    pending.resolve(decision);
  }

  async stopSession(threadId: string): Promise<void> {
    this.sessions.delete(threadId);
    this.emit(threadId, { type: "session.ended" });
  }

  streamEvents(): AsyncIterable<ProviderRuntimeEvent> {
    return this.queue.drain();
  }

  private async runLoop(
    threadId: string,
    prompt: string,
    session: Session,
  ): Promise<void> {
    const agent = this.agent();
    let model: LanguageModel;
    try {
      model = await this.model();
    } catch (err) {
      this.emit(threadId, { type: "turn.failed", error: err instanceof Error ? err.message : String(err) });
      return;
    }

    await this.ensureMcpTools();

    const toolSet = this.toToolSet();
    const messages: ModelMessage[] = [
      ...session.history.map<ModelMessage>((m) => ({ role: m.role, content: m.text })),
      { role: "user", content: prompt },
    ];
    session.history.push({ role: "user", text: prompt });

    for (;;) {
      if (session.abort) {
        this.emit(threadId, { type: "turn.failed", error: "interrupted" });
        return;
      }
      const controller = new AbortController();
      session.controller = controller;

      const result = streamText({
        model,
        messages,
        system: this.systemPrompt(agent, session.cwd),
        tools: toolSet,
        stopWhen: stepCountIs(1),
        abortSignal: controller.signal,
        onError: () => {},
      });

      // Stream text deltas.
      let text = "";
      try {
        for await (const delta of result.textStream) {
          text += delta;
          this.emit(threadId, { type: "message.delta", text: delta });
        }
      } catch (err) {
        if (session.abort) {
          this.emit(threadId, { type: "turn.failed", error: "interrupted" });
        } else {
          this.emit(threadId, { type: "turn.failed", error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      // Final step (already consumed the stream): text + tool calls.
      let toolCalls: { toolCallId: string; toolName: string; input: unknown }[];
      try {
        const step = await result.finalStep;
        text = text || step.text;
        toolCalls = step.toolCalls.map((tc) => ({
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: tc.input,
        }));
      } catch (err) {
        if (session.abort) {
          this.emit(threadId, { type: "turn.failed", error: "interrupted" });
        } else {
          this.emit(threadId, { type: "turn.failed", error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      if (text) this.emit(threadId, { type: "message.completed", text });

      if (toolCalls.length === 0) {
        session.history.push({ role: "assistant", text });
        this.emit(threadId, { type: "turn.completed" });
        return;
      }

      const assistantContent: (TextPart | ToolCallPart)[] = [];
      if (text) assistantContent.push({ type: "text", text });
      for (const tc of toolCalls) {
        this.emit(threadId, { type: "tool.started", name: tc.toolName, inputSummary: summarize(tc.input) });
        assistantContent.push({
          type: "tool-call",
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: tc.input,
        });
      }

      // Execute in parallel (default), each gated by the permission ruleset.
      const results = await Promise.all(
        toolCalls.map((tc) => this.executeTool(threadId, tc, agent.permission, session.cwd)),
      );

      for (let i = 0; i < toolCalls.length; i++) {
        this.emit(threadId, { type: "tool.completed", name: toolCalls[i]!.toolName, ok: results[i]!.ok });
      }

      const toolResults: ToolResultPart[] = results.map((r, i) => ({
        type: "tool-result",
        toolCallId: toolCalls[i]!.toolCallId,
        toolName: toolCalls[i]!.toolName,
        output: { type: r.ok ? "text" : "error-text", value: r.text },
      }));

      messages.push({ role: "assistant", content: assistantContent });
      messages.push({ role: "tool", content: toolResults });
      session.history.push({ role: "assistant", text });

      if (session.abort) {
        this.emit(threadId, { type: "turn.failed", error: "interrupted" });
        return;
      }
    }
  }

  private async executeTool(
    threadId: string,
    tc: { toolCallId: string; toolName: string; input: unknown },
    ruleset: Ruleset,
    cwd: string,
  ): Promise<{ ok: boolean; text: string }> {
    const session = this.sessions.get(threadId);
    const tool = this.tools.get(tc.toolName);
    const permission = evaluate(tc.toolName, tc.input, ruleset);

    if (!tool) {
      return { ok: false, text: `unknown tool: ${tc.toolName}` };
    }
    if (permission === "deny") {
      return { ok: false, text: `tool "${tc.toolName}" denied by permission ruleset` };
    }
    if (permission === "ask") {
      const decision = await this.awaitApproval(threadId, tc.toolName, tc.input);
      if (decision !== "allow") {
        return { ok: false, text: `tool "${tc.toolName}" denied by user` };
      }
    }
    const host = session?.host ?? new LocalHost();
    const result = await runTool(tool, tc.input, { cwd, host });

    if (result.ok && (tc.toolName === "edit" || tc.toolName === "write") && this.diagnostics) {
      const filePath = (tc.input as { filePath?: unknown } | undefined)?.filePath;
      if (typeof filePath === "string") {
        const diags = await this.diagnostics(resolvePath(cwd, filePath));
        if (diags) result.text = `${result.text}\n${diags}`;
      }
    }
    return result;
  }

  private awaitApproval(
    threadId: string,
    toolName: string,
    input: unknown,
  ): Promise<ApprovalDecision> {
    const requestId = randomUUID();
    this.emit(threadId, {
      type: "approval.requested",
      requestId,
      summary: `${toolName} ${summarize(input)}`,
    });
    return new Promise<ApprovalDecision>((resolve) => {
      this.approvals.set(requestId, { threadId, resolve });
    });
  }

  private systemPrompt(agent: Agent, cwd: string): string {
    const context = loadContext({ cwd });
    const parts = [agent.prompt];
    if (this.skills.length > 0) {
      parts.push(
        `<skills>\nUse the \`skill\` tool to load a skill's full instructions on demand.\n${formatSkillsForPrompt(this.skills)}\n</skills>`,
      );
    }
    if (context) parts.push(`\n\n<context>\n${context}\n</context>`);
    if (this.mcpWarnings.length > 0) {
      parts.push(`\n<mcp-warnings>\n${this.mcpWarnings.join("\n")}\n</mcp-warnings>`);
    }
    return parts.join("\n");
  }

  private async ensureMcpTools(): Promise<void> {
    if (this.mcpReady) return;
    this.mcpReady = true;
    for (const [name, config] of Object.entries(this.mcpServers)) {
      try {
        const session = createMcpSession(name, config);
        this.mcpSessions.push(session);
        for (const def of await session.listTools()) {
          this.tools.register(mcpTool(name, session, def));
        }
      } catch (err) {
        this.mcpWarnings.push(
          `MCP server "${name}" unavailable: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private toToolSet(): ToolSet {
    const set = {} as ToolSet;
    for (const t of this.tools.all()) {
      set[t.name] = aiTool({
        description: t.description,
        inputSchema: t.inputSchema,
        outputSchema: z.object({ result: z.string() }),
      });
    }
    return set;
  }
}
