# HANDOFF — Roost build state

**Saved:** 2026-09-14 · **Repo:** `D:\Projects\project agents`

> ⚠️ **Git note:** there is **no usable git repo for this project**. `git status` resolves to a stray repo rooted at **`D:\`** (branch `fix/artifact-image-overflow-v2`, zero commits) — do NOT commit there (it would sweep the whole drive). To version Roost, `git init` **inside** `D:\Projects\project agents` first.

---

## Status

| Phase | State | Evidence |
|---|---|---|
| 0 — Foundations | ✅ done | event log + receipts + atomic commit, worktree manager, fastify RPC server, CLI |
| 1 — Core loop | ✅ done | provider abstraction, thread/turn, Claude CLI adapter, git reactor, ink TUI |
| Option 3 — Phase 1 polish | ✅ done | real Claude approvals (stream-json control protocol), TUI diff pane, `.roost/config.json` |
| 2a — Tier-1 native loop | ✅ done | own agent loop + AI SDK model layer + tools + permissions + agent config |
| 2b — skills/session/fanout | ✅ done | skills, session tree, compaction, fan-out, Codex adapter, JSON/RPC run modes |
| 3a — daemon + client | ✅ done | `roost serve` daemon, thin CLI client, HTTP/WS replay (daemon tests green) |
| 3b — SSH/MCP/LSP/commands | ✅ done | host route union + `SshHost`, MCP client, LSP client, custom slash commands |

**Test suite right now:** `pnpm build` ✅ 0 errors · `pnpm test` ✅ **143/143** · `pnpm smoke` ✅ OK.

---

## Phase 3a — what exists, what's broken

**Goal:** extract the orchestrator into a persistent daemon; CLI becomes a client; turns survive client close and replay on reattach.

**Files added**
- `packages/core/src/registry.ts`
- `packages/core/src/client.ts`
- `apps/server/src/daemon.ts`
- `apps/cli/src/daemon.ts`
- `apps/server/test/daemon.test.ts` ← the 3 failing tests

**Files modified**
- `packages/contracts/src/index.ts`
- `packages/core/src/{config,engine,reactor,runmodes,index}.ts`
- `apps/server/src/index.ts`, `apps/server/package.json`
- `apps/cli/src/index.ts`, `apps/cli/package.json`
- `vitest.config.ts`

**The 3 failures** (all `apps/server/test/daemon.test.ts`):
1. `dispatches over HTTP, streams events over WS, and /state reflects the read model` → `waitFor timeout`
2. `replays earlier events when subscribing from a past sequence (reattach)` → `expected [] to deeply equal [Array(1)]`
3. `isolates engines per directory (two dirs → two read models)` → `TypeError: Cannot read properties of undefined (reading 'messages')`

**Diagnosis:** the daemon compiles but the HTTP `POST /rpc/dispatch` → WS `GET /events` plumbing isn't delivering events, and the `/state` response shape doesn't match what the tests expect (`readModel.threads[].messages`). Most likely: (a) the WS subscription is attached to a different engine instance than the one `dispatch` writes to (per-request engine cache vs. subscription-time instance), or (b) `/state` returns a wrapper object instead of the read model.

**Resume instructions**
```powershell
cd "D:\Projects\project agents"
pnpm build
pnpm vitest run apps/server/test/daemon.test.ts   # reproduce the 3 failures
```
Then fix the dispatch→subscribe wiring in `apps/server/src/daemon.ts` / `index.ts`, and the `/state` shape, until `pnpm test` is 108/108.

> **Resolved:** the daemon dispatch→WS→state plumbing was fixed during Phase 3b (all 3 daemon tests now green).

---

## Phase 3b — SSH execution host, MCP, LSP, custom commands

**Goal:** execution-host route union (BUILD-PLAN B6), an SSH execution host over `ssh2`, an MCP client, LSP integration, and custom slash commands.

**Files added**
- `packages/core/src/hosts.ts` — `Host` interface, `HostRoute` union, `resolveHost`, `connectHost`, `LocalHost`, `UnresolvableHostError`/`UnsupportedHostKindError`.
- `packages/core/src/ssh/index.ts` — `SshHost` (SFTP read/write/listDir, `runCommand`, git runner) over an injectable ssh2 client with lazy reconnect.
- `packages/core/src/mcp.ts` — MCP client (stdio + streamable HTTP), `discoverMcpTools`, namespaced `mcp__<server>__<tool>` tools.
- `packages/core/src/lsp.ts` — `matchLspServer`, `LspClient` (`diagnostics(path)` with timeout), `formatDiagnostics`.
- `packages/core/src/commands.ts` — `.roost/commands/*.md` loading, `$ARGUMENTS`/`$1..$9` expansion.
- tests: `hosts.test.ts`, `ssh.test.ts`, `mcp.test.ts`, `lsp.test.ts`, `commands.test.ts`, `config-3b.test.ts`.

**Files modified**
- `packages/contracts/src/index.ts` — `thread.create.hostId`, `ThreadCreatedEvent.hostId`, `Thread.hostId` (all optional, default `local`).
- `packages/core/src/{config,decider,native,reactor,registry,index}.ts` — config gains `hosts`/`mcpServers`/`lspServers` (Zod strict); thread routes file/git/tool ops through the resolved host; native loop gains MCP tools + post-edit diagnostics.
- `packages/core/src/tools/{index,read,write,edit,ls,bash}.ts` — route through `ctx.host` (default local).
- `apps/server/src/daemon.ts` — builds host resolver + LSP client + MCP per project directory.
- `apps/cli/src/index.ts` — `command list`/`command run`, `run --host`.
- `pnpm-workspace.yaml` — `allowBuilds` placeholders set to real booleans (`ssh2`/`cpu-features` → `false`).

**How to configure**

```jsonc
// .roost/config.json
{
  "provider": "native", "model": "anthropic:claude-sonnet-4-5",
  "hosts": [{ "id": "vps", "kind": "ssh", "host": "1.2.3.4", "user": "dev", "keyPath": "C:\\...\\id_ed25519" }],
  "mcpServers": { "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] } },
  "lspServers": [{ "name": "ts", "command": "typescript-language-server", "args": ["--stdio"], "extensions": ["ts", "tsx"] }]
}
```

```powershell
node apps/cli/dist/index.js run --project <id> --host ssh:vps --prompt "fix the bug"
node apps/cli/dist/index.js command list
node apps/cli/dist/index.js command run summarize --project <id> --args "the login flow"
```

**Deviations**
- `wsl:`/`runtime:` host routes parse and `resolveHost`/`connectHost` recognize them, but `connectHost` throws `UnsupportedHostKindError` (no provider yet); only `local` + `ssh` are implemented.
- `grep`/`glob` tools remain local-walkers (pure-JS recursive walk); `read`/`write`/`edit`/`ls`/`bash` route through the host. Git actions route through the host via `GitReactor`.
- LSP runs locally (not over SSH); remote worktree materialization (`git worktree add` on the remote host) is out of scope for 3b — an `ssh` thread treats its worktree path as a remote path.
- CLI adapters (`claude-cli`/`codex-cli`) still run in the local worktree; host routing covers the native loop + git reactor only.

---

## How to run what works today (phases 0–2b)

```powershell
pnpm install
pnpm build
pnpm test            # 105/105 if you set aside the WIP daemon test
pnpm smoke

# native agent turn (bring an API key) — no Claude Code needed
$env:ANTHROPIC_API_KEY = "..."
node apps/cli/dist/index.js project add D:\path\to\repo
node apps/cli/dist/index.js worktree create my-task --project <projectId>
node apps/cli/dist/index.js run --project <projectId> --provider native --model "anthropic:claude-sonnet-4-5" --agent build

# CLI-provider turn (needs `claude auth`)
node apps/cli/dist/index.js run --project <projectId> --prompt "fix the bug"

# fan-out 3 agents
node apps/cli/dist/index.js fanout exp --project <projectId> --count 3 --prompt "..." --provider native --model "anthropic:claude-sonnet-4-5"

# non-interactive modes
node apps/cli/dist/index.js run --project <projectId> --provider fake --prompt "hi" --format json
```

Providers: `fake`, `claude-cli`, `native` (AI SDK: anthropic/openai/deepseek/openrouter), `codex-cli`.
API keys via env: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY`.

---

## Next steps (in order)

1. **Phase 4** — remote relay + X25519 pairing, push notifications, session share.
2. Flesh out `wsl:`/`runtime:` host providers and remote worktree materialization.
3. Optional: `git init` inside the project + first commit; add `windows-latest` + `ubuntu-latest` CI.

## Known deviations (recorded in BUILD-PLAN.md)
- TUI is **ink**, not OpenTUI (Windows robustness).
- Claude adapter hand-rolls the `stream-json` control protocol (the Agent SDK pulls zod v4, conflicting with contracts' zod v3).
- Native loop uses **AI SDK v7** (`system` option; tools without `execute` need `outputSchema`).
- Reactor-originated commands (`thread.message.append`, etc.) are an extension required so reactors can feed provider output through the event log.
- SSH execution uses **`ssh2`** (persistent connection, no shelling out to `ssh`); `ssh2`/`cpu-features` native build scripts are disabled (`allowBuilds: false`) — ssh2 falls back to pure JS crypto.

See `BUILD-PLAN.md` for the full requirements + architecture.
