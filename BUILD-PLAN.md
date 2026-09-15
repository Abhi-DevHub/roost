# ADE — Build Plan & Requirements

> A local-first **Agent Development Environment (ADE)**: run parallel coding agents each in its own isolated git worktree, with an IDE-grade review surface, controllable from desktop, TUI, and (later) phone.
>
> Synthesized from **four** reference projects: **T3 Code**, **Orca**, **OpenCode**, and **Pi**. This is the "best of all four" merged plan.

**Status:** draft v2 · **Repo:** `D:\Projects\project agents`

---

## 0. Executive summary (read this first)

There are **two architectures** in the references, and the winning design combines them:

- **T3 Code / Orca = control planes over external CLI agents.** They spawn `claude`, `codex`, etc. as child processes and never call an LLM API themselves. Strength: BYO-subscription, instant multi-provider. Weakness: limited by the CLIs' interfaces.
- **OpenCode / Pi = native agent harnesses.** They call the LLM API directly with their own tool loop. Strength: full control, provider-agnostic, embeddable. Weakness: you must build the loop, tools, and model layer.

**The merged design is two-tier:**

```
                    ┌──────────────────────────────────────┐
                    │  Orchestrator (event-sourced core)     │
                    │  from T3 Code                          │
                    └───────────────┬──────────────────────┘
                                    │
              ┌─────────────────────┴─────────────────────┐
              │        ProviderAdapter (one interface)     │
              └───────┬───────────────────────────┬───────┘
                      │                           │
        TIER 1: NATIVE AGENT            TIER 2: CLI AGENT
        (OpenCode + Pi)                 (T3 Code + Orca)
        · call LLM directly             · spawn external CLI
        · Vercel AI SDK, 25+ providers  · Claude Code, Codex…
        · Pi's minimal ~700-LOC loop    · BYO subscription
        · full control, embeddable      · provider's own auth
```

Everything else layers on top:

| Concern | Take from | Why |
|---|---|---|
| Event-sourced orchestration (decider/projector/receipts) | **T3 Code** | Idempotent, crash-safe, atomic |
| Two-tier provider adapter | **T3** (CLI) + **OpenCode** (native) | Control plane *and* native agents |
| Provider-agnostic model layer (Vercel AI SDK) | **OpenCode** | 25+ providers for free |
| Minimal native agent loop + run modes | **Pi** | ~700 LOC, 4 modes (TUI/JSON/RPC/SDK) |
| Multi-tenant headless server | **OpenCode** | One server, N worktrees via header |
| Declarative agent config + permission rulesets | **OpenCode** | "Agent as data" |
| Skills (Claude-Code-compatible `SKILL.md`) | **OpenCode + Pi** | Reuses the whole skills ecosystem |
| Context files (`AGENTS.md` hierarchy) | **Pi** | Prompt-cache-friendly progressive disclosure |
| Session tree + compaction | **Pi** | Branching history, custom summarizer |
| Execution-host route union (local/WSL/SSH) | **Orca** | Remote is first-class |
| Worktree UX + fan-out | **Orca** | The killer feature |
| Rich surface (Monaco, xterm splits, diff annotate) | **Orca** | IDE-grade |
| X25519 pairing + byte-pipe relay | **Orca** | Simpler than DPoP |
| Plugin/extension hooks API | **OpenCode + Pi** | Extend without forking |
| LSP + MCP + ACP | **OpenCode** | Table stakes for a real harness |
| Git snapshots / revert | **OpenCode + T3** | Cheap undo |

**Recommended first milestone (MVP):** Tier-2 only (wrap Claude Code) + parallel worktrees + streaming chat + diff + commit→PR, all local. Add the Tier-1 native loop in Phase 2 — it's the differentiator but not needed to ship.

**The single biggest risk is scope.** Four reference apps is a lot of surface. The phase gate is the guardrail.

---

# Part A — Requirements

## A1. Product definition

An ADE is a control plane that:

1. Runs **two kinds of agents** behind one interface: **native** (its own loop, calls models directly) and **CLI** (wraps `claude`/`codex`/…, BYO subscription).
2. Isolates each task in a **git worktree**.
3. Records every intent as an **event** (idempotent, recoverable).
4. Provides an **IDE-grade review surface** and a **TUI**.
5. Is **remote-capable** (execution host = laptop, VPS, WSL).
6. Is **embeddable** — drivable by a human, another program (RPC), or a library (SDK).

**Business model:** BYO-subscription for CLI agents; optional bring-your-own-key for native agents. No resold tokens, no billing.

## A2. Use cases

| # | Use case | Success |
|---|----------|---------|
| UC-1 | "Fix this bug across the repo" | Agent runs in a worktree; review diff; merge in-app |
| UC-2 | "Try 3 approaches in parallel" | 3 agents, 3 worktrees, compare, merge winner |
| UC-3 | "Keep working while I'm away" | Agent survives app close; phone notification |
| UC-4 | "Run on my beefy remote box" | Same UI over SSH/relay |
| UC-5 | "Review this PR with AI" | Open PR, annotate diff, send back to agent |
| UC-6 | "Script my agents" | Drive a run over RPC/JSON from CI or another program |
| UC-7 | "Use my DeepSeek/OpenAI key directly" | Native agent with any of 25+ providers |

## A3. Functional requirements

Priority: **P0 = MVP**, **P1 = V1**, **P2 = later**, **W = won't (yet)**.

### Core loop
- **FR-1 (P0)** Register projects (local repo paths).
- **FR-2 (P0)** Create a **worktree per agent task** (isolated branch + path).
- **FR-3 (P0)** Spawn a **CLI provider** (Claude Code first, Codex second) in that worktree.
- **FR-4 (P0)** Stream agent output (tokens, tool calls, results) to the UI.
- **FR-5 (P0)** Follow-up turns; interrupt a running turn.
- **FR-6 (P0)** Show the **turn diff** with syntax highlighting.
- **FR-7 (P0)** Commit → push → PR with generated title/body.
- **FR-8 (P0)** List/select/delete worktrees; never lose unmerged commits.
- **FR-9 (P0)** **Event log** + idempotent replay by `commandId`.
- **FR-10 (P0)** Agents keep running if the UI closes; reattach on reopen.

### Two-tier agents
- **FR-11 (P1)** **Native agent loop**: own tool loop (read/write/edit/bash/grep/glob), calls LLM directly via a provider-agnostic model layer (Vercel AI SDK).
- **FR-12 (P1)** **Provider-agnostic models**: 25+ providers (OpenAI, Anthropic, Google, DeepSeek, xAI, Groq, OpenRouter, local/Ollama), lazy-loaded.
- **FR-13 (P1)** **Four run modes**: interactive TUI · print/JSON · RPC (JSONL over stdio) · SDK (embed).
- **FR-14 (P1)** **Agent modes as config**: build / plan (read-only) / subagents, each with a permission ruleset + model binding.
- **FR-15 (P1)** **Permission rulesets**: wildcard allow/ask/deny, per-session "always", pending requests.
- **FR-16 (P1)** Multi-agent fan-out: N agents, N worktrees, same prompt.

### Context & extensibility
- **FR-17 (P1)** **Skills**: `SKILL.md` with frontmatter, discovered from `.claude/skills`, `.agents/skills`, `{skill,skills}/**` (Claude-Code compatible).
- **FR-18 (P1)** **Context files**: `AGENTS.md` hierarchy (global → parents → cwd), `SYSTEM.md` / `APPEND_SYSTEM.md` overrides.
- **FR-19 (P1)** **MCP client** (stdio / SSE / streamable HTTP + OAuth).
- **FR-20 (P1)** **Custom slash commands** with `$ARGUMENTS`/`$1` hints.
- **FR-21 (P2)** **Plugin/extension API**: hooks (tools, commands, events, auth, TUI slots), npm-installable, with a client handle to the server.
- **FR-22 (P2)** **LSP integration** (diagnostics, symbols).
- **FR-23 (P2)** **ACP** (Agent Client Protocol) server so IDEs can drive us.

### Session & review
- **FR-24 (P1)** **Session tree**: branching history (fork/clone/navigate).
- **FR-25 (P1)** **Compaction**: automatic on context overflow, customizable summarizer.
- **FR-26 (P1)** **Snapshots/revert**: git-based, patch hashes, pruned retention.
- **FR-27 (P1)** Inline **diff comments** batched back to the agent.
- **FR-28 (P1)** File explorer + Monaco editor + autosave; Markdown/image previews.
- **FR-29 (P2)** GitHub/GitLab native; **FR-30 (P2)** Linear/Jira.
- **FR-31 (P2)** Session **share** (export/import, share links).
- **FR-32 (P2)** Usage/cost tracking per session and per provider.

### Interfaces & remote
- **FR-33 (P1)** **TUI** client (OpenTUI + SolidJS) as an alternative to the GUI.
- **FR-34 (P2)** **Multi-tenant server**: one headless server, instances resolved per request via a directory header; `attach <url>` to a remote server.
- **FR-35 (P2)** SSH execution host.
- **FR-36 (P2)** Relay + X25519 pairing → phone control; **FR-37 (P2)** Expo mobile app.
- **FR-38 (W)** Computer-use; **FR-39 (W)** emulator; **FR-40 (W)** voice.

## A4. Non-functional requirements

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-1 | **Local-first** | Fully offline; cloud optional |
| NFR-2 | **Idempotent commands** | Replay never double-applies |
| NFR-3 | **Crash-safe** | Kill mid-run → reopen → consistent |
| NFR-4 | **No silent fallback** | Unknown provider/host = explicit error |
| NFR-5 | **Version-independent clients** | Typed RPC + optional-with-default fields |
| NFR-6 | **Non-blocking UI** | All I/O off the render loop; startup < 2s |
| NFR-7 | **Cross-platform** | Windows, macOS, Linux (Windows tested early) |
| NFR-8 | **Secrets hashed/never logged** | — |
| NFR-9 | **Repo-safe** | Never delete unmerged branches; no silent force-push |
| NFR-10 | **Pure, testable core** | Decider + agent loop unit-testable without I/O |
| NFR-11 | **Prompt-cache-friendly context** | Stable system prompt; on-demand skill loading |

## A5. What each reference does BEST (the steal list)

| Capability | Best-in-class | Detail |
|---|---|---|
| Event-sourced core | **T3 Code** | `command → decide() → events → projections + receipt`, one transaction |
| CLI-agent provider adapter | **T3 Code** | Normalizes 6 CLIs behind one boundary; capability flags |
| Typed RPC contract | **T3 Code** | Client/server version independence |
| Checkpoints (hidden git refs) | **T3 Code** | Non-destructive revert |
| Native agent loop | **Pi** | ~725 LOC `runLoop`, parallel tool exec, streamed partials |
| Run modes (TUI/JSON/RPC/SDK) | **Pi** | Embeddable + scriptable — prerequisite for automation |
| Session tree + compaction | **Pi** | Branching JSONL, customizable summarizer |
| Context files + progressive skills | **Pi** | `AGENTS.md` hierarchy; load skills on demand |
| Minimal-core philosophy | **Pi** | Explicit "No" list; features are extension points |
| Provider-agnostic models | **OpenCode** | Vercel AI SDK v3, 25+ providers, lazy |
| Multi-tenant server | **OpenCode** | One server, N projects via `x-opencode-directory` |
| Agent config + permissions | **OpenCode** | Agent as data; wildcard ruleset, `findLast` evaluate |
| Plugin hooks API | **OpenCode** | npm-installable; plugins get a server SDK client |
| Skills compat | **OpenCode + Pi** | `SKILL.md`, `.claude/skills` discovery |
| LSP / MCP / ACP | **OpenCode** | Built-in, first-class |
| Snapshot/revert | **OpenCode** | Patch hashes, 7-day prune |
| Execution-host union | **Orca** | local / WSL / SSH / runtime, no silent fallback |
| Worktree UX + fan-out | **Orca** | N independent creates, compare, merge |
| Rich surface | **Orca** | Monaco, xterm splits, diff annotation, design mode |
| Pairing + relay | **Orca** | X25519 sealed-box, dumb byte-pipe, E2EE above |

---

# Part B — Architecture

## B1. Process model (T3's boundary + OpenCode's multi-tenant server)

```
┌──────────────────────────────────────────────────────────────────┐
│ Clients (all speak the same typed RPC)                            │
│   GUI (Electron/React) · TUI (OpenTUI/SolidJS) · CLI · SDK · Mobile│
└───────────────────────────────┬──────────────────────────────────┘
                                │  HTTP + WS   (per-request project dir header)
┌───────────────────────────────▼──────────────────────────────────┐
│ Orchestrator daemon (Node)                                        │
│  · event-sourced core (T3)         · multi-tenant instance resolver│
│  · provider adapter registry       · session store + tree          │
│  · worktree manager                · permission engine             │
│  · tool registry                   · MCP/LSP clients               │
│  · skill + context loader          · plugin host                   │
└───────────────┬───────────────────────────────┬──────────────────┘
                │                               │
      ┌─────────▼─────────┐           ┌─────────▼──────────┐
      │ TIER 1: Native    │           │ TIER 2: CLI agent  │
      │ loop + AI SDK     │           │ spawn claude/codex │
      └─────────┬─────────┘           └─────────┬──────────┘
                └───────────────┬───────────────┘
                                │
                ┌───────────────▼───────────────────┐
                │ Execution host (Orca route union) │
                │ local │ wsl │ ssh:<id> │ runtime  │
                └───────────────────────────────────┘
```

**Rules:**
- The orchestrator owns all execution (processes, PTYs, git, files). Clients are thin.
- Start with the orchestrator in Electron's main process; extract to a **standalone daemon** in Phase 3 (needed for "keep running when app closes" + multi-tenant + remote attach).
- **Multi-tenant from the start** (OpenCode's trick): the server resolves the project/worktree from a per-request directory header, so one process serves many worktrees. This is what makes fan-out cheap.

## B2. Event-sourced core (T3) — unchanged, non-negotiable

```
command ─► decide(command, readModel) ─► events[]
   ┌───────────────────────────────────────────────────┐
   │ ONE transaction:                                   │
   │  1. append events    2. apply in-memory read model │
   │  3. write projections 4. upsert command receipt    │
   └───────────────────────────┬───────────────────────┘
                               │ after commit
                   publish ────┴───► reactors (I/O) → feed back as commands
```

**Invariants:** `decide` is pure; ack = intent committed; events+projections+receipt atomic; `commandId` dedups; one queue, one worker.

> **Merge note:** OpenCode has its own event-sourced `SyncEvent` layer (single-writer, `seq` numbers, projectors). T3's is more rigorous (receipts, atomic projections). **Use T3's model**, and borrow OpenCode's **`seq`-based sync** idea if/when you add multi-device.

## B3. Provider adapter — two tiers, one interface

```ts
interface ProviderAdapter {
  readonly provider: ProviderKind;   // "claude-cli" | "codex-cli" | "native:anthropic" | ...
  readonly tier: "cli" | "native";
  readonly capabilities: {
    sessionModelSwitch: "in-session" | "none";
    supportsRollback: boolean;
    supportsCompaction: boolean;
    supportsApproval: boolean;
  };
  startSession(input): Promise<ProviderSession>;
  sendTurn(input): Promise<TurnStartResult>;
  interruptTurn(threadId, turnId?): Promise<void>;
  respondToRequest(threadId, requestId, decision): Promise<void>;
  respondToUserInput(threadId, requestId, answers): Promise<void>;
  stopSession(threadId): Promise<void>;
  stopAll(): Promise<void>;
  readThread(threadId): Promise<ThreadSnapshot>;
  rollbackThread(threadId, n): Promise<ThreadSnapshot>;
  streamEvents(): AsyncIterable<ProviderRuntimeEvent>;
}
```

- **Tier 2 (CLI)** from T3: spawn the CLI, normalize its stream to canonical `ProviderRuntimeEvent`, handle quirks (hard interrupt, slash-command compaction, echo-based delivery).
- **Tier 1 (native)** from Pi + OpenCode: the adapter *is* the loop. It calls the model via the AI SDK, runs tools, streams events. **One** native adapter serves all AI-SDK providers (provider is config, not code).
- Rules: normalize at the boundary; declare capabilities; unknown = explicit error.

## B4. Native agent loop (Pi, ~725 LOC)

```
outer loop (follow-up messages):
  inner loop:
    stream assistant response
    if error/aborted → end
    extract toolCalls
    if toolCalls:
      if stopReason == "length" → fail all (truncated args unsafe)
      else executeToolCalls (parallel by default; sequential if tool opts in)
      push toolResults into context
    check shouldStopAfterTurn; poll steering messages
  poll follow-up messages; if any → loop
```

- Model boundary: internal `AgentMessage[]` → provider `Message[]` **only at the LLM call**.
- `beforeToolCall` / `afterToolCall` hooks = permission gates + result transforms.
- Tools: `read`, `write`, `edit` (with diff), `bash`, `grep`, `glob`, `ls` — schema-validated, stream partial results.
- Compaction: automatic on overflow/threshold; summarizer replaceable via extension.

## B5. Model layer (OpenCode → Vercel AI SDK v3)

- One `BUNDLED_PROVIDERS` map of **lazy dynamic imports**: OpenAI, Anthropic, Google/Vertex, Bedrock, Azure, xAI, Mistral, Groq, DeepSeek, Cerebras, Cohere, Together, Perplexity, OpenRouter, Alibaba, `openai-compatible`, local (Ollama/llama.cpp).
- Do **not** hand-roll provider clients. Standardize on `LanguageModelV3`.
- Providers are also npm-installable plugins (custom `getModel`/`discoverModels`).
- Model IDs are branded; provider transforms handle per-vendor quirks.

## B6. Execution-host layer (Orca)

```ts
type HostRoute =
  | { kind: "local"; hostId: "local" }
  | { kind: "wsl";   hostId: `wsl:${string}`; distro: string }
  | { kind: "ssh";   hostId: `ssh:${string}`; connectionId: string; provider: FsProvider | null }
  | { kind: "runtime"; hostId: `runtime:${string}`; environmentId: string };
```

Unknown id → **throw** (`UnresolvableHostError`); never fall back to local. `provider: null` = "remote unreachable", never "local". MVP implements `local` only; the union exists from day one.

## B7. Worktree manager (both)

```
create: git worktree add --no-track -b <branch> <path> <baseRef>
list:   git worktree list --porcelain -z     (--git-dir <commonDir>)
remove: git worktree remove [--force] <path>
prune:  git worktree prune
```
Branch `<prefix>/<name>` with `-2/-3` collision suffix; path `<worktreesDir>/<repo>/<branch-dashed>`; remove is idempotent (gone → no-op + prune); **never delete unmerged branches**; deferred directory deletion; reconcile after create.

## B8. Session, context & skills (Pi + OpenCode)

- **Session tree**: node graph (`id` + `parentId`); fork/clone/navigate in place. Rows in SQLite + a tree index.
- **Compaction**: first-class, customizable; keep the most recent ~N tokens, summarize older into a "handoff" chain.
- **Context files**: `AGENTS.md` global → parents → cwd; `SYSTEM.md` replaces, `APPEND_SYSTEM.md` appends.
- **Skills**: `SKILL.md` + frontmatter; discovery from `.claude/skills/**`, `.agents/skills/**`, `{skill,skills}/**`, `**/SKILL.md`. Loaded **on demand** (progressive disclosure) to protect the prompt cache.
- **Agents as config**: `{ name, description, mode: primary|subagent|all, model, permission: Ruleset, prompt, temperature, steps }`. Built-ins are permission merges (`build` full, `plan` read-only, `general`/`explore` subagents).
- **Permissions**: wildcard rules; `evaluate` = `findLast` over rulesets; default `ask`; per-session "always"; pending via `Deferred`.

## B9. Extensibility (OpenCode hooks + Pi extensions)

- **Plugin** = `(input) => Promise<Hooks>`; `input` gives a typed client to the running server, project, directory, worktree, a shell, and the workspace-adapter registry.
- Hooks: tools, commands, events, auth (OAuth), MCP, skills, filesystem, TUI slots, integrations.
- npm-installable + local files. Built-in auth providers are just plugins.
- **Pi alternative**: a TypeScript default-export receiving `ExtensionAPI` (`registerTool`, `registerCommand`, `on(event)`). Pick one model; don't ship both.

## B10. Persistence schema (SQLite, merged)

```sql
-- T3 event log (source of truth)
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  aggregate_kind TEXT NOT NULL, stream_id TEXT NOT NULL, stream_version INTEGER NOT NULL,
  type TEXT NOT NULL, occurred_at TEXT NOT NULL, command_id TEXT, causation_event_id TEXT,
  payload_json TEXT NOT NULL, UNIQUE (aggregate_kind, stream_id, stream_version)
);
CREATE TABLE command_receipts (
  command_id TEXT PRIMARY KEY, aggregate_kind TEXT NOT NULL, aggregate_id TEXT NOT NULL,
  accepted_at TEXT NOT NULL, result_sequence INTEGER NOT NULL, status TEXT NOT NULL, error TEXT
);
-- projections (rebuildable)
CREATE TABLE projects(...);
CREATE TABLE worktrees(id TEXT PRIMARY KEY, project_id TEXT, branch TEXT, path TEXT, base_ref TEXT, created_at TEXT);
CREATE TABLE sessions(id TEXT PRIMARY KEY, parent_id TEXT, project_id TEXT, worktree_id TEXT,
                      agent TEXT, model_json TEXT, title TEXT, share_url TEXT, revert_json TEXT, ...);
CREATE TABLE messages(...); CREATE TABLE parts(...); CREATE TABLE todos(...);
CREATE TABLE snapshots(id TEXT PRIMARY KEY, session_id TEXT, patch_hash TEXT, created_at TEXT);
CREATE TABLE projection_state(projector TEXT PRIMARY KEY, last_applied_sequence INTEGER, updated_at TEXT);
PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;
```

## B11. Interfaces

- **GUI**: Electron + React (Orca-style surface).
- **TUI**: OpenTUI + SolidJS (OpenCode) — a real framework, not a REPL.
- **CLI**: `run` (headless, `--format json`), `serve`, `attach <url>`.
- **SDK**: embed the agent session in another program.
- **ACP**: expose an Agent Client Protocol server so editors can drive the ADE.

## B12. Remote (later)

Start with **SSH** (Phase 3). Then **Orca-style** X25519 sealed-box pairing + a dumb byte-pipe relay with E2EE above it (Phase 4). DPoP/Clerk only if you go commercial.

---

# Part C — Tech stack decision

**Orca's mainstream base + T3's patterns + OpenCode's model layer + Pi's minimal loop.**

| Layer | Choose | Rejected |
|---|---|---|
| Language | TypeScript (stable 5.x) | T3/OpenCode's TS 7 / bleeding edge |
| Runtime | **Node ≥ 22** (Bun optional for speed) | — |
| Monorepo | pnpm workspaces | — |
| Desktop | Electron + electron-vite | Tauri |
| UI | React 19 + Tailwind 4 + shadcn/ui + Radix + Zustand | — |
| TUI | **ink** (React for CLIs) | OpenTUI (bleeding-edge; Windows risk) |
| Editor | Monaco | — |
| Terminal | xterm.js + node-pty | — |
| **Native agent loop** | **own (Pi-style, ~700 LOC)** | adopting OpenCode's whole core |
| **Model layer** | **Vercel AI SDK v3** | hand-rolled provider clients |
| Orchestration | plain TypeScript event-sourced core | **Effect 4** (skip) |
| Persistence | SQLite (`better-sqlite3`/`libsql`) | Postgres/PlanetScale |
| RPC | oRPC or tRPC + WS | hand-rolled Effect Schema RPC |
| Schemas | Zod | Effect Schema |
| Git | `git` CLI | isomorphic-git |
| LSP | `vscode-jsonrpc` + `vscode-languageserver-types` | — |
| MCP | `@modelcontextprotocol/sdk` | — |
| CLI providers | `@anthropic-ai/claude-agent-sdk`, Codex CLI | 27 providers |
| Mobile | Expo (Phase 4) | — |
| Relay | Node + ws (Phase 4) | Cloudflare Workers |

**Why not copy any single stack exactly?** T3's Effect+TS7 and OpenCode's Effect+Drizzle-RC are bets on team expertise; Orca's is mainstream but lacks the event core. Take the *ideas*, use *boring tools*.

---

# Part D — Build plan

Each phase ships independently. **Do not start a phase before the previous exit criteria pass.**

## Phase 0 — Foundations
- [ ] pnpm monorepo: `apps/desktop`, `apps/server`, `packages/contracts`, `packages/core`
- [ ] Electron + electron-vite + React + Tailwind + shadcn scaffold
- [ ] SQLite (WAL, migrations); event log + receipts; append + replay
- [ ] Command queue + single worker; `dispatch()` → ack
- [ ] Typed RPC (Zod + HTTP + WS); per-request **project-directory header** resolver
- [ ] `project.create/list` end-to-end
- [ ] Worktree manager (create/list/remove/prune) + commands

**Exit:** restart → projects + worktrees reload; replaying `worktree.create` twice creates one worktree.

## Phase 1 — Core loop (MVP, Tier-2 only)
- [ ] Provider adapter interface + **Claude Code adapter**
- [ ] Canonical `ProviderRuntimeEvent` + normalization
- [ ] `thread.create` / `turn.start` / `turn.interrupt` + events
- [ ] Streaming chat UI; terminal pane (xterm + node-pty)
- [ ] Turn diff view; approve/deny; answer questions
- [ ] Git actions: commit → push → PR (`gh`)
- [ ] One reactor proven (git/provider I/O after commit)

**Exit:** prompt Claude → watch → diff → "commit & PR" → PR exists. Kill mid-run → reopen → consistent.

## Phase 2 — Native agents + power surface
- [ ] **Tier-1 native loop** (Pi-style) + tool registry (read/write/edit/bash/grep/glob/ls)
- [ ] **Vercel AI SDK model layer** (start: Anthropic + OpenAI + DeepSeek + OpenRouter)
- [ ] **Agent config** + **permission rulesets** (build/plan/subagents)
- [ ] **Four run modes**: interactive, print/JSON, RPC (JSONL), SDK
- [ ] **Skills** (`SKILL.md`, `.claude/skills` discovery) + **`AGENTS.md`** context
- [ ] **Session tree** + **compaction**
- [ ] Fan-out: N agents, N worktrees; per-agent status/usage
- [ ] Diff annotation; Monaco + file explorer; previews
- [ ] **Codex CLI adapter** (proves the abstraction)

**Exit:** run 3 agents (mix of native + CLI) on 3 approaches, compare, merge one, discard the rest without losing commits.

## Phase 3 — Daemon + remote
- [ ] Extract orchestrator to a standalone **daemon**; reattach on reopen
- [ ] **Multi-tenant server** (many projects/worktrees, one process) + `attach <url>`
- [ ] Execution-host union: `local` + **`ssh`**; SSH fs/git/PTY providers
- [ ] **MCP** client; **LSP** integration; **custom commands**
- [ ] **TUI** client (OpenTUI)

**Exit:** start an agent on a VPS over SSH, close the app, reopen, stream the rest; drive a run from the TUI against the same server.

## Phase 4 — Cloud + mobile
- [ ] Relay (Node + ws) + X25519 pairing + byte-pipe splice
- [ ] Push (APNs/FCM); Expo mobile app (status, steer, notifications, terminal)
- [ ] Session share/export/import

**Exit:** scan a QR, watch a live run, get a push, send a follow-up.

## Phase 5 — Depth
- [ ] Plugin/extension API (npm-installable, server SDK)
- [ ] GitHub/GitLab native; Linear/Jira
- [ ] **ACP** server (editor integration)
- [ ] Automations; session-history search ("AI Vault")
- [ ] More CLI providers (Cursor, OpenCode, Grok…)

---

# Part E — Hard parts & de-risk

| Hard part | Risk | De-risk |
|---|---|---|
| Event-sourced core | Double-apply; projection ahead of log | Pure decider + unit tests; one-tx commit; copy T3 receipt semantics |
| **Two-tier abstraction** | Native loop and CLI adapters drift apart | Define canonical events first; make Tier-1 an adapter, not a special case |
| Provider normalization | Every CLI streams differently | One CLI + one native provider first; declare capabilities |
| **Model layer** | 25 providers × quirks | Use Vercel AI SDK; test 3–4 providers only |
| Worktrees on **Windows** | Path length, EDR, drive letters | Test Windows in Phase 0 |
| PTY supervision | Zombies, resize, scrollback | node-pty + daemon; kill process trees |
| Context/compaction | Blowing the prompt cache; losing context | Stable system prompt; on-demand skills; customizable summarizer |
| Permissions | Unsafe tool execution | Wildcard ruleset + `ask` default + `beforeToolCall` gate |
| Remote auth | Crypto + replay + tunnels | Defer to Phase 4; Orca's X25519; dumb relay |
| **Scope (4 apps!)** | Building everything, shipping nothing | The phase gate is the law |

---

# Part F — What NOT to build (YAGNI)

- **No resold tokens / billing.** BYO-subscription + BYO-key.
- **No 27 CLI providers.** Two CLIs + the AI SDK's 25 model providers is plenty.
- **No Effect, no TS 7, no Drizzle RC.** Boring tools.
- **No ORM.** Hand-written SQL (~15 tables).
- **No custom terminal renderer / TUI framework.** Use xterm.js + OpenTUI.
- **No plugin system, computer-use, emulator, voice** until the core loop is loved.
- **No cloud until Phase 4.**
- **No duplicate extension models.** Pick OpenCode's hooks **or** Pi's extensions — not both.

---

# Part G — Decisions I made for you (override any)

1. **Two-tier providers** (native + CLI) behind one adapter — the core differentiator vs any single reference.
2. **Stack**: mainstream Electron/React/SQLite + Vercel AI SDK; not Effect/TS7.
3. **Event core**: T3's model, from day one (retrofitting is painful).
4. **Native loop**: Pi's minimal design (~700 LOC), not OpenCode's whole core.
5. **Skills**: Claude-Code-compatible `SKILL.md` (reuse the ecosystem).
6. **Remote**: SSH first, then Orca-style X25519 relay; not DPoP.
7. **MVP**: Tier-2 only (wrap Claude Code), local, single-user, **TUI/CLI-first** (GUI in V1).

**Confirmed decisions (from you):**
- **Scope:** personal tool → no billing, no Clerk/DPoP. Phase 4 relay is **optional / self-hosted**; skip unless you want phone control.
- **Effect:** not known → **skip Effect entirely**, plain TypeScript. (Confirmed.)
- **OS:** **Windows + Linux** are the targets (macOS not a priority). Windows is **first-class** — test worktrees, long paths, and PTY there from Phase 0.
- **Audience:** both solo and team → keep the local-first `.ade/`-in-git model; **no multi-user server needed**. Team = shared repo config + git PRs.
- **Name:** `Roost` (pending npm/domain check).
- **Interface:** **TUI-first**, GUI in V1.

**Remaining question:**
- **Tier-1 priority:** native agents in Phase 2, or defer to Phase 3 and ship CLI-only sooner?

## Windows + Linux notes (personal, both OS)

- Use the `git` **CLI** (identical on both); never isomorphic-git.
- **Windows:** `node-pty` needs ConPTY; watch long paths (enable `core.longpaths`, use `\\?\` where needed); drive-letter/UNC handling in the worktree manager; PowerShell vs `cmd` shell abstraction; Defender/EDR can slow or block spawned CLIs — test early.
- **Linux:** standard, but test case-sensitive paths and no-drive-letter assumptions.
- **Shell abstraction:** one `Shell` interface (`bash` on Linux, `powershell`/`cmd` on Windows) — never hardcode `/bin/bash`.
- **CI:** run the test suite on both `windows-latest` and `ubuntu-latest`.

---

# Part H — Naming

Shortlist (short, pronounceable, CLI-friendly):

| Name | CLI | Metaphor | Notes |
|---|---|---|---|
| **Roost** | `roost` | A flock comes home to roost | Warm, distinctive; flock-of-agents |
| **Warren** | `warren` | A network of isolated burrows | = parallel worktrees; dev-distinctive |
| **Trellis** | `trellis` | Frame supporting many parallel branches | Strong worktree metaphor |
| **Baton** | `baton` | The conductor's baton; handoff | Orchestration/handoff |
| **Loom** | `loom` | Weaves parallel threads | Taken (loom.com) |
| **Perch** | `perch` | Where agents sit and watch | Light |

**Recommendation: `Roost`** — 5 chars, easy to type, memorable; metaphor *is* the product. Tagline: *"Where your agents come home."* Package names: `roost`, `@roost/cli`, `roost.dev`.
Alternates: **Warren** (worktree metaphor) or **Trellis**.

> Verify npm/domain/trademark before committing to a name.

---

# Part I — Interface strategy: CLI/TUI vs GUI

**Answer: ship both, but sequence CLI/TUI first, GUI second.** Preference is task-dependent:

| Task | Preference | Why |
|---|---|---|
| Driving one agent | **CLI/TUI** | Fast, keyboard-driven, composable, scriptable |
| Managing many agents | **GUI** | Status at a glance across N worktrees |
| Reviewing/merging diffs | **GUI** | Side-by-side visual comparison |
| CI / automation / scripting | **CLI/RPC** | Must be non-interactive |

Evidence: T3 Code + Orca bet GUI-first and won traction; OpenCode + Pi are TUI-first. Winners ship both.

**Build order:** (1) server — the real product, clients are thin; (2) **TUI** (`ink`) — ~half the effort of Electron, scriptable, what agent-native devs use; (3) **GUI** — the team/onboarding/review surface.

> **Decision:** MVP surface = **TUI-first**; GUI moves to V1. If the goal is mainstream adoption rather than personal productivity, GUI-first may win more users at 2–3× the cost.

---

# Part J — Solo → Team workflow

**Core principle: coordination lives in git; the ADE stays local-first.** No SaaS until Phase 4.

The repo is the **distribution channel** for agent config:

```
your-repo/
  AGENTS.md              # shared project context (all agents read this)
  .ade/
    config.json          # shared defaults: model, permissions
    agents/*.md          # shared agent definitions
    skills/**/SKILL.md   # shared skills
```
Personal overrides live in `~/.config/ade/` and are **never committed**.

| Stage | Workflow |
|---|---|
| **Solo** | `roost` → worktree + agent → work → review diff → merge → commit reusable agents/skills to `.ade/` |
| **Small team (2–5)** | Same flow; `.ade/` committed → **onboarding = `git clone`**. Collaborate via **git branches + PRs**, not the ADE. Optional shared **multi-tenant server** for remote/beefy runs; connect with `attach <url>`. Org defaults in `.ade/config.json`, personal overrides local. |
| **Larger team** | Central server + relay + per-user auth (Phase 4); shared agent library (npm pkg / submodule); usage/cost tracking; org-level permission policies. |

**Conflict model:** agents work in **isolated worktrees**, so parallel work never collides; humans merge via normal git. The ADE **never auto-merges** — that stays a human decision.

---

## Appendix — Reference commits

| Project | Repo | Commit |
|---|---|---|
| T3 Code | `pingdotgg/t3code` | `26894dda7b6d78c5863ccec6581caf0ec7f4843b` |
| Orca | `stablyai/orca` | `9aa0f7e77d366c23a3cc8de2da32ae550d397dc0` |
| OpenCode | `sst/opencode` → `anomalyco/opencode` | `a453386e9dd3cd5089714f1f0d4576002a96d30d` |
| Pi | `badlogic/pi-mono` | `71dca871bc80b6bc97be37f0ca3189399d651fff` |

Deep-dive notes available for: event-sourced orchestration, provider-adapter pattern, worktree orchestration, remote pairing handshake, OpenCode architecture, Pi agent loop (see session history).
