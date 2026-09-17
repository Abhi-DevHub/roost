# HANDOFF — Roost

**Repo:** https://github.com/Abhi-DevHub/roost (private) · **Branch:** `main` · **CI:** green on ubuntu-latest + windows-latest (node 22)

---

## Status: phases 0–3b complete

| Phase | Delivered |
|---|---|
| 0 — Foundations | event-sourced core (command → pure decider → events → projections + receipts, one SQLite tx), worktree manager, RPC server, CLI |
| 1 — Core loop | `ProviderAdapter` boundary, thread/turn lifecycle, Claude CLI adapter, git reactor, ink TUI |
| Polish | real Claude approvals (stream-json control protocol), TUI diff pane, `.roost/config.json` |
| 2a — Native agents | own Tier-1 loop, Vercel AI SDK model layer, 7 tools, permission rulesets, agent config |
| 2b — Depth | skills, session tree, compaction, fan-out, Codex adapter, JSON/RPC run modes |
| 3a — Daemon | persistent daemon, CLI-as-client, reattach, multi-tenant per directory |
| 3b — Reach | SSH execution host, MCP client, LSP diagnostics, custom commands |

**Evidence:** `pnpm build` 0 errors · `pnpm test` **143/143** (25 files) · `pnpm smoke` OK.

## Layout

```
packages/contracts   Zod schemas: commands, events, read model, RPC
packages/core        engine, worktree, providers, models, tools, permissions,
                     agents, skills, compaction, fan-out, hosts, ssh, mcp, lsp, commands
apps/server          daemon: engines + reactors, multi-tenant per directory
apps/cli             client + ink TUI, JSON/RPC run modes
.github/workflows    CI (ubuntu + windows)
```

## Run

```powershell
pnpm install; pnpm build; pnpm test; pnpm smoke

$env:ANTHROPIC_API_KEY = "..."      # native provider; or `claude auth` for claude-cli
node apps/cli/dist/index.js project add D:\path\to\repo
node apps/cli/dist/index.js worktree create task --project <id>
node apps/cli/dist/index.js run --project <id> --prompt "fix the bug"
node apps/cli/dist/index.js fanout exp --project <id> --count 3 --prompt "..."
node apps/cli/dist/index.js serve | stop | thread list | diff <id>
```

Config `.roost/config.json`: `provider`, `model`, `agent`, `branchPrefix`, `worktreesDir`,
`permissionMode`, `hosts`, `mcpServers`, `lspServers`. User layer: `%APPDATA%\roost\config.json`.

## Known limitations

- `wsl:` / `runtime:` host routes parse but throw (`UnsupportedHostKindError`) — only `local` + `ssh` implemented.
- `grep`/`glob` and LSP run locally; remote worktree materialization over SSH is out of scope.
- SSH / MCP / LSP are tested against mocks, not real services.
- Real Claude turns need `claude auth`; the native path needs an API key.
- CI emits a Node-20-deprecation warning for `actions/*@v4` (informational; GitHub auto-runs them on Node 24).

## Not built (from BUILD-PLAN.md)

- **Phase 4** — relay + X25519 pairing + Expo mobile app.
- **Phase 5** — GitHub/GitLab/Linear native, AI Vault (session search), automations, more CLI providers.

## Gotchas

- This folder is its own git repo (`D:\Projects\project agents\.git`). Do not run `git` expecting a parent repo.
- Line endings are normalized via `.gitattributes` (`* text=auto eol=lf`).
