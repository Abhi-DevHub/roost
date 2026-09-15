# Roost

A local-first **Agent Development Environment (ADE)**. Run parallel coding agents,
each in its own isolated git worktree, with an event-sourced core that never
loses intent.

**Phase 1** ships the MVP core loop on top of the Phase 0 foundation: a
two-tier provider abstraction with a real Claude Code adapter, the thread/turn
lifecycle (event-sourced), a git commit → push → PR reactor, and a streaming
TUI. **Phase 2b** adds the rest of Phase 2: skills (progressive disclosure), a
session tree (`thread.fork` + lineage), compaction, fan-out, a Codex CLI
adapter, and non-interactive JSON/RPC run modes. **Phase 3a** extracts the
orchestrator into a standalone **daemon** (`roost serve`); the CLI becomes a
thin client that talks to it over HTTP/WebSocket, so a turn keeps running
server-side when the client closes and replays from the event log on reattach.
**Phase 3b** adds the execution-host route union (`local`/`wsl`/`ssh`/`runtime`
with no silent fallback), an SSH execution host (`readFile`/`writeFile`/
`listDir`/`runCommand`/`git` over `ssh2`, routed per-thread via
`thread.create.hostId`), an MCP client (stdio + streamable HTTP, tools surfaced
as `mcp__<server>__<tool>`), LSP integration (`diagnostics(path)` surfaced after
edits), and custom slash commands (`.roost/commands/*.md`).
Everything stays local-first and event-sourced.

## Layout

```
packages/contracts   Zod schemas + inferred types (Command, Event, ReadModel, Thread, ProviderRuntimeEvent, RPC)
packages/core        event store (SQLite), pure decider/projector, orchestration engine, worktree manager,
                     provider layer (ProviderAdapter/Registry/FakeProvider/ClaudeCodeAdapter/CodexCliAdapter),
                     reactors (TurnReactor/GitReactor/WorktreeReactor), skills, compaction, fan-out, run modes,
                     hosts (HostRoute/SshHost), MCP client, LSP client, commands, DaemonClient
apps/server          `roost serve` daemon — fastify + WebSocket, multi-tenant per `x-roost-directory`
apps/cli             `roost` CLI + ink streaming TUI (a thin client of the daemon)
scripts/smoke.ts     end-to-end smoke: register → create → list → remove → replay
```

## Requirements

- Node ≥ 22
- pnpm ≥ 10
- `git` on PATH

## Install / build / test

```powershell
pnpm install
pnpm build      # tsc, strict, zero type errors
pnpm test       # vitest
pnpm smoke      # build + end-to-end smoke (creates a real git worktree)
```

## Run

The CLI is a thin client of a persistent daemon. Start the daemon first
(`roost serve`), or just run any command — if no daemon is reachable at the
configured URL the CLI auto-spawns a detached one and waits for health, then
fails with a clear message if it never comes up (never a silent in-process
fallback). Stop it with `roost stop`.

### Daemon (`serve` / `stop` / `attach`)

```powershell
pnpm build

# start the daemon in the foreground (the bound port is logged)
node apps/cli/dist/index.js serve            # default http://127.0.0.1:4318
node apps/cli/dist/index.js serve --port 4321

# point any command at a specific daemon
node apps/cli/dist/index.js --server http://127.0.0.1:4321 thread list

# stop the daemon (graceful shutdown)
node apps/cli/dist/index.js stop
```

The daemon resolves the project directory per request from the
`x-roost-directory` header, so **one daemon serves many projects** — each
directory lazily builds its own engine (SQLite under `<dir>/.roost/roost.db`),
provider registry, and reactors. Reattach to a running turn with
`roost run --thread <threadId>`: the client subscribes from the last-seen
sequence, a turn started before the client attached keeps running server-side,
and its events replay from the event log.

### CLI (client)

```powershell
pnpm build

# register a project (prints the projectId — use it below)
node apps/cli/dist/index.js project add D:\path\to\repo

# list projects
node apps/cli/dist/index.js project list

# create a worktree (branch `roost/<name>`; materialized by the daemon)
node apps/cli/dist/index.js worktree create my-task --project <projectId>

# list worktrees
node apps/cli/dist/index.js worktree list

# remove a worktree (never loses unmerged commits)
node apps/cli/dist/index.js worktree remove <worktreeId>

# write a starter .roost/config.json in the current directory
node apps/cli/dist/index.js config init

# print the merged effective config and the source of each field
node apps/cli/dist/index.js config show [directory]
```

The CLI keeps a small registry of registered projects in
`$ROOST_HOME/projects.json` (projectId → directory). Orchestration state itself
lives in each project's `.roost/roost.db`, owned by the daemon.

### Chat with an agent (streaming TUI)

Requires the `claude` CLI on PATH and authenticated (`claude auth`). The chat
runs in a worktree; you review the diff and commit/push/PR after.

```powershell
# open a project + thread and chat (creates a thread, sends an optional prompt)
node apps/cli/dist/index.js run --project <projectId> [--worktree <worktreeId>] [--prompt "fix the bug"]

# resume / reattach an existing thread (replays the turn from the event log)
node apps/cli/dist/index.js run --thread <threadId>

# list / inspect threads
node apps/cli/dist/index.js thread list
node apps/cli/dist/index.js thread show <threadId>

# review the agent's changes in the worktree
node apps/cli/dist/index.js diff <threadId>

# git actions (run by the git reactor in the thread's worktree)
node apps/cli/dist/index.js git commit --thread <threadId> -m "agent: fix bug"
node apps/cli/dist/index.js git push   --thread <threadId>
node apps/cli/dist/index.js git createPr --thread <threadId> -m "PR title"
```

In the chat view: type a prompt and Enter to send; Ctrl+C interrupts a running
turn (or quits when idle); approval prompts are answered with `y` (allow) / `n`
(deny). Press `d` to toggle a diff pane showing the thread worktree's changes
(`git diff HEAD`, working tree + staged) with `+`/`-` coloring; `↑`/`↓` scrolls
it and `d` closes it.

### Native agent (Tier-1, no Claude Code required)

The provider is chosen by the project's config (`.roost/config.json`), not a
per-run flag. Set `"provider": "native"` and a `"model"` ref, then:

```powershell
node apps/cli/dist/index.js run --project <projectId> --prompt "fix the bug"
```

Example `.roost/config.json`:

```jsonc
{ "provider": "native", "model": "anthropic:claude-sonnet-4-5", "agent": "build" }
```

The API key comes from the provider's env var: `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, or `OPENROUTER_API_KEY`. Agents
(`build` = full access, `plan`/`explore` = read-only) load from
`.roost/agents/*.md` (YAML frontmatter + prompt) over the built-ins; each
carries a wildcard `permission` ruleset.

Real approvals: the adapter runs `claude` in `--input-format stream-json
--output-format stream-json --permission-mode` mode, so permission requests
surface as approval prompts you answer in the TUI. With `permissionMode:
"acceptEdits"` (default) file edits are auto-accepted and only dangerous
operations (Bash, WebFetch, …) prompt; `"manual"` prompts for every tool.

### Codex CLI agent (Tier-2)

Set `"provider": "codex-cli"` in `.roost/config.json`, then:

```powershell
node apps/cli/dist/index.js run --project <projectId> --prompt "fix the bug"
```

Runs one `codex exec --json <prompt>` process per turn and normalizes its JSONL
output to canonical runtime events. If `codex` isn't on PATH the failure
surfaces as an explicit `turn.failed`, never a crash.

### Skills (progressive disclosure)

`SKILL.md` files are discovered from `.roost/skills/**`, `.claude/skills/**`,
`.agents/skills/**` (project) and `~/.roost/skills/**` (user). Only each
skill's `name` + `description` go into the native agent's system prompt; the
body loads on demand via the `skill` tool (`skill({ name })`). Duplicate names:
project wins over user, with an explicit warning.

### Session tree, compaction, fan-out

```powershell
# clone a thread into a new thread (same worktree), optionally up to a message
node apps/cli/dist/index.js thread fork <threadId> [--up-to <messageId>] [--title "…"]
node apps/cli/dist/index.js thread tree <threadId>   # print lineage (root → leaf)

# summarize older messages into a handoff, keep the recent tail
node apps/cli/dist/index.js thread compact <threadId> [--max-tokens 4000] [--keep-tokens 1000]

# N worktrees (distinct branches) + N threads, same prompt in each
node apps/cli/dist/index.js fanout <name> --project <projectId> --count N --prompt "…"
```

Compaction is threshold-triggered with an injectable summarizer (default:
ask the configured model; fallback: deterministic truncation with an explicit
marker) and never drops the last user message.

### Non-interactive run modes

```powershell
# emit committed events as JSON lines, exit at turn end
# (with "provider": "fake" set in the project's .roost/config.json)
node apps/cli/dist/index.js run --project <projectId> --prompt "hi" --format json

# JSONL over stdio: read {command} lines, write {event} lines
echo '{"type":"thread.message.append",...}' | node apps/cli/dist/index.js run --project <projectId> --mode rpc
```

The interactive ink TUI remains the default when neither flag is set.

### SSH execution hosts (remote-first)

Configure hosts in `.roost/config.json` (`hosts: [{id, kind:"ssh", host, user,
port?, keyPath?}]`), then target a host per thread:

```powershell
# run a native-agent turn on the remote host `vps` (thread.create hostId)
node apps/cli/dist/index.js run --project <projectId> --host ssh:vps --prompt "fix the bug"
```

`hostId` routes are `local` (default), `wsl:<distro>`, `ssh:<id>`, and
`runtime:<id>`. An unknown id is an explicit `UnresolvableHostError` — never a
silent fall back to local. File/git/tool operations for an `ssh` thread route
through the SSH host (`readFile`/`writeFile`/`listDir` over SFTP, `runCommand`,
and a git runner) over a persistent `ssh2` connection with reconnect; an
unreachable host is a graceful explicit error. `wsl:`/`runtime:` parse but have
no provider yet.

### MCP servers

Configured `mcpServers` (stdio `{command,args,env}` or streamable-HTTP `{url}`)
are connected lazily at turn time; their tools surface to the **native** agent
as `mcp__<server>__<tool>`. A server that fails to connect is reported
explicitly (a warning in the system prompt), never silently dropped.

### LSP diagnostics

Configured `lspServers` spawn a language server and expose
`diagnostics(path)`, which the native loop surfaces after `write`/`edit` tool
calls. No matching server → empty (not an error); a slow server never blocks
the turn (bounded timeout).

### Custom slash commands

Drop `*.md` files in `.roost/commands/` with YAML frontmatter (`description`)
and a body supporting `$ARGUMENTS`, `$1`…`$9`:

```markdown
---
description: summarize the current diff
---
Run \`git diff\` and summarize the changes. Focus: $ARGUMENTS
```

```powershell
node apps/cli/dist/index.js command list
node apps/cli/dist/index.js command run summarize --project <projectId> --args "the login flow"
```

`command run` expands the body (substituting `$ARGUMENTS`/`$N`) and sends it as
a turn prompt to the agent.

State lives in `$ROOST_HOME` (default `~/.roost`) for the client-side project
registry (`projects.json`) and default `worktrees/`; the event-sourced
orchestration state is per-project in `<project>/.roost/roost.db` (owned by the
daemon).

## Configuration

Config is merged with precedence **project > user > defaults**. Unknown keys and
invalid values are an explicit error (never silently ignored); missing files
fall back to defaults.

| Layer | Path |
|---|---|
| project | `<projectRoot>/.roost/config.json` |
| user | `~/.config/roost/config.json` (Linux/macOS) · `%APPDATA%\roost\config.json` (Windows) |

Fields (all optional):

```jsonc
{
  "provider": "claude-cli",        // adapter: "claude-cli" | "codex-cli" | "native" | "fake"
  "model": "sonnet",               // passed as `--model`; omit for Claude's default
  "branchPrefix": "roost",         // worktree branch prefix
  "worktreesDir": "C:\\Users\\you\\.roost\\worktrees",
  "permissionMode": "acceptEdits", // "acceptEdits" | "manual"
  "agentsDir": "…",                // reserved (Phase 2)
  "skillsDir": "…",                // reserved (Phase 2)
  "serverUrl": "http://127.0.0.1:4318", // daemon the CLI talks to (default)

  // SSH execution hosts, resolved by `ssh:<id>` host routes.
  "hosts": [
    { "id": "vps", "kind": "ssh", "host": "1.2.3.4", "user": "dev", "port": 22, "keyPath": "C:\\...\\id_ed25519" }
  ],

  // MCP servers (stdio command OR streamable-HTTP url). Tools surface as `mcp__<name>__<tool>`.
  "mcpServers": {
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
    "remote":     { "url": "https://example.com/mcp" }
  },

  // Language servers for `diagnostics(path)` after edits.
  "lspServers": [
    { "name": "ts", "command": "typescript-language-server", "args": ["--stdio"], "extensions": ["ts", "tsx"] }
  ]
}
```

Defaults: `provider: "claude-cli"`, `branchPrefix: "roost"`,
`permissionMode: "acceptEdits"`, `worktreesDir: $ROOST_HOME/worktrees`,
`serverUrl: "http://127.0.0.1:4318"`, `hosts: []`, `mcpServers: {}`,
`lspServers: []`.
`roost config show` prints the merged config plus the source of each field.

### Server / daemon (HTTP + WebSocket)

```powershell
pnpm build
node apps/cli/dist/index.js serve          # or node apps/server/dist/index.js
```

The daemon resolves the project directory from the `x-roost-directory` header
(multi-tenant: one process, many directories, each with its own SQLite under
`<dir>/.roost/` and its own engine + reactors).

- `POST /rpc/dispatch` — body is `{ command }`, header `x-roost-directory`
  points at the project dir. Returns `{ ok: true, receipt }` or
  `{ ok: false, error }`.
- `GET /events` — WebSocket; streams committed events as `{ event }` JSON.
  Optional `?fromSequence=N` (and `?directory=…`) to replay from a sequence.
- `GET /state` — the read-model snapshot for the directory.
- `GET /health` — `{ ok: true }` when alive.
- `POST /shutdown` — graceful stop (used by `roost stop`).

## Design notes (see `BUILD-PLAN.md` Part B2/B3)

`command → decide() → events → projections + receipt`, committed in one SQLite
transaction. `decide` is pure (injected clock/id only); the worktree manager
shells out to the `git` CLI (no isomorphic-git), and Windows (PowerShell) is a
first-class target.

Providers sit behind one `ProviderAdapter` interface (BUILD-PLAN B3). The Phase 1
adapter runs one long-lived `claude` process per thread in `--input-format
stream-json --output-format stream-json --permission-mode` mode and normalizes
its stream to canonical `ProviderRuntimeEvent`s — including permission
`control_request`s, which surface as `approval.requested` and resolve via a
`control_response` on stdin. Reactors subscribe to committed events, do I/O
(spawn the CLI / run `git`), then `dispatch()` new commands — never mutating
state outside a command, so the feedback loop stays idempotent and replayable.
Unknown thread/worktree/provider is always an explicit error, never a silent
fallback.
