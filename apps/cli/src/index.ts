#!/usr/bin/env node
import { Command } from "commander";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { createElement } from "react";
import { render } from "ink";
import {
  DaemonClient,
  loadConfig,
  compactMessages,
  runTurnAndWait,
  formatEventLine,
  discoverCommands,
  commandsDirFor,
  commandPrompt,
} from "@roost/core";
import { CommandSchema, type Command as RoostCommand, type Event, type ReadModel } from "@roost/contracts";
import { startDaemon } from "@roost/server";
import { ChatApp } from "./tui.js";
import {
  ensureDaemon,
  stopDaemon,
  loadRegistry,
  saveRegistry,
  resolveProjectDir,
} from "./daemon.js";

function now(): string {
  return new Date().toISOString();
}

const program = new Command();
program
  .name("roost")
  .description("Roost — agent development environment")
  .version("0.0.0")
  .option("--server <url>", "daemon base URL (default from config serverUrl)");

function resolveServer(projectRoot?: string): string {
  const flag = program.opts().server as string | undefined;
  if (flag) return flag;
  return loadConfig(projectRoot ? { projectRoot } : {}).config.serverUrl;
}

function makeClient(directory: string, server: string): DaemonClient {
  return new DaemonClient({ serverUrl: server, directory });
}

async function findDirectory(server: string, pred: (rm: ReadModel) => boolean): Promise<string | null> {
  for (const { workspaceRoot } of Object.values(loadRegistry())) {
    if (pred(await makeClient(workspaceRoot, server).fetchState())) return workspaceRoot;
  }
  return null;
}

async function resolveThreadDirectory(server: string, threadId: string): Promise<string> {
  const dir = await findDirectory(server, (rm) => rm.threads.some((t) => t.threadId === threadId));
  if (!dir) throw new Error(`unknown thread: ${threadId}`);
  return dir;
}

// ---------------------------------------------------------------------------
// serve / stop
// ---------------------------------------------------------------------------

program
  .command("serve")
  .description("Run the Roost daemon (persistent orchestrator)")
  .option("--port <n>", "port to bind", (v: string) => Number(v))
  .option("--host <h>", "host to bind", "127.0.0.1")
  .action(async (opts: { port?: number; host: string }) => {
    const daemon = await startDaemon({
      host: opts.host ?? process.env.ROOST_HOST ?? "127.0.0.1",
      port: opts.port ?? Number(process.env.ROOST_PORT ?? 4318),
    });
    console.log(`roost daemon listening on ${daemon.url}`);
    const shutdown = () => {
      void daemon.close().then(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

program
  .command("stop")
  .description("Stop the running Roost daemon")
  .action(async () => {
    const server = resolveServer();
    const ok = await stopDaemon(server);
    if (ok) console.log(`stopped daemon at ${server}`);
    else {
      console.error(`no daemon running at ${server}`);
      process.exitCode = 1;
    }
  });

// ---------------------------------------------------------------------------
// project
// ---------------------------------------------------------------------------

const project = program.command("project").description("Manage projects");

project
  .command("add <path>")
  .description("Register a project directory")
  .action(async (path: string) => {
    const server = resolveServer();
    const workspaceRoot = resolve(path);
    if (!existsSync(workspaceRoot)) throw new Error(`path does not exist: ${workspaceRoot}`);
    await ensureDaemon(server);
    const projectId = randomUUID();
    const title = basename(workspaceRoot);
    const result = await makeClient(workspaceRoot, server).dispatch({
      type: "project.create",
      projectId,
      title,
      workspaceRoot,
      commandId: randomUUID(),
      createdAt: now(),
    });
    const reg = loadRegistry();
    reg[projectId] = { workspaceRoot, title };
    saveRegistry(reg);
    console.log(JSON.stringify({ projectId, title, workspaceRoot, sequence: result.sequence }));
  });

project
  .command("list")
  .description("List registered projects")
  .action(() => {
    const projects = Object.entries(loadRegistry()).map(([projectId, e]) => ({
      projectId,
      title: e.title,
      workspaceRoot: e.workspaceRoot,
    }));
    console.log(JSON.stringify(projects, null, 2));
  });

// ---------------------------------------------------------------------------
// worktree
// ---------------------------------------------------------------------------

const worktree = program.command("worktree").description("Manage worktrees");

worktree
  .command("create <name>")
  .description("Create a worktree (branch) for a project")
  .requiredOption("--project <id>", "project id")
  .option("--base <ref>", "base ref to branch from", "HEAD")
  .action(async (name: string, opts: { project: string; base: string }) => {
    const server = resolveServer();
    const dir = resolveProjectDir(opts.project);
    await ensureDaemon(server);
    const client = makeClient(dir, server);
    const worktreeId = randomUUID();
    const result = await client.dispatch({
      type: "worktree.create",
      worktreeId,
      projectId: opts.project,
      name,
      baseRef: opts.base,
      commandId: randomUUID(),
      createdAt: now(),
    });
    const w = (await client.fetchState()).worktrees.find((x) => x.worktreeId === worktreeId);
    if (!w) throw new Error("worktree.create produced no worktree in the read model");
    console.log(JSON.stringify({ worktreeId: w.worktreeId, branch: w.branch, path: w.path, sequence: result.sequence }));
  });

worktree
  .command("list")
  .description("List worktrees across all registered projects")
  .action(async () => {
    const server = resolveServer();
    await ensureDaemon(server);
    const worktrees = [];
    for (const { workspaceRoot } of Object.values(loadRegistry())) {
      worktrees.push(...(await makeClient(workspaceRoot, server).fetchState()).worktrees);
    }
    console.log(JSON.stringify(worktrees, null, 2));
  });

worktree
  .command("remove <id>")
  .description("Remove a worktree (never loses unmerged commits)")
  .action(async (id: string) => {
    const server = resolveServer();
    await ensureDaemon(server);
    const dir = await findDirectory(server, (rm) => rm.worktrees.some((w) => w.worktreeId === id));
    if (!dir) throw new Error(`unknown worktree: ${id}`);
    const result = await makeClient(dir, server).dispatch({
      type: "worktree.remove",
      worktreeId: id,
      commandId: randomUUID(),
      createdAt: now(),
    });
    console.log(JSON.stringify({ worktreeId: id, sequence: result.sequence, removed: true }));
  });

// ---------------------------------------------------------------------------
// thread
// ---------------------------------------------------------------------------

const thread = program.command("thread").description("Manage threads");

thread
  .command("list")
  .description("List threads across all registered projects")
  .action(async () => {
    const server = resolveServer();
    await ensureDaemon(server);
    const threads = [];
    for (const { workspaceRoot } of Object.values(loadRegistry())) {
      for (const t of (await makeClient(workspaceRoot, server).fetchState()).threads) {
        threads.push({
          threadId: t.threadId,
          projectId: t.projectId,
          title: t.title,
          status: t.session.status,
          messages: t.messages.length,
        });
      }
    }
    console.log(JSON.stringify(threads, null, 2));
  });

thread
  .command("show <id>")
  .description("Show a thread's messages")
  .action(async (id: string) => {
    const server = resolveServer();
    await ensureDaemon(server);
    const dir = await resolveThreadDirectory(server, id);
    const t = (await makeClient(dir, server).fetchState()).threads.find((x) => x.threadId === id);
    if (!t) throw new Error(`unknown thread: ${id}`);
    console.log(`# ${t.title}  [${t.session.status}]`);
    for (const m of t.messages) console.log(`[${m.role}] ${m.text}`);
  });

thread
  .command("fork <id>")
  .description("Clone a thread into a new thread pointing at the same worktree")
  .option("--up-to <messageId>", "copy messages up to and including this message id")
  .option("--title <title>", "new thread title")
  .action(async (id: string, opts: { upTo?: string; title?: string }) => {
    const server = resolveServer();
    await ensureDaemon(server);
    const dir = await resolveThreadDirectory(server, id);
    const client = makeClient(dir, server);
    const parent = (await client.fetchState()).threads.find((t) => t.threadId === id);
    if (!parent) throw new Error(`unknown thread: ${id}`);
    const threadId = randomUUID();
    const title = opts.title ?? `${parent.title} (fork)`;
    await client.dispatch({
      type: "thread.fork",
      threadId,
      parentThreadId: id,
      title,
      upToMessageId: opts.upTo,
      commandId: randomUUID(),
      createdAt: now(),
    });
    const forked = (await client.fetchState()).threads.find((t) => t.threadId === threadId);
    console.log(
      JSON.stringify({ threadId, parentThreadId: id, title, messages: forked?.messages.length ?? 0 }),
    );
  });

thread
  .command("tree <id>")
  .description("Print the lineage of a thread (root → leaf)")
  .action(async (id: string) => {
    const server = resolveServer();
    await ensureDaemon(server);
    const dir = await resolveThreadDirectory(server, id);
    const threads = (await makeClient(dir, server).fetchState()).threads;
    let cur = threads.find((t) => t.threadId === id);
    if (!cur) throw new Error(`unknown thread: ${id}`);
    const lineage: { threadId: string; title: string; status: string }[] = [];
    const seen = new Set<string>();
    while (cur && !seen.has(cur.threadId)) {
      seen.add(cur.threadId);
      lineage.push({ threadId: cur.threadId, title: cur.title, status: cur.session.status });
      const parentId: string | null | undefined = cur.parentThreadId;
      cur = parentId ? threads.find((t) => t.threadId === parentId) : undefined;
    }
    lineage.reverse();
    lineage.forEach((t, i) => {
      console.log(`${"  ".repeat(i)}${t.threadId === id ? "●" : "·"} ${t.title}  [${t.status}]  ${t.threadId}`);
    });
  });

thread
  .command("compact <id>")
  .description("Summarize older messages into a handoff (compact the history)")
  .option("--max-tokens <n>", "token threshold", (v: string) => Number(v), 4000)
  .option("--keep-tokens <n>", "recent tokens to keep", (v: string) => Number(v), 1000)
  .action(async (id: string, opts: { maxTokens: number; keepTokens: number }) => {
    const server = resolveServer();
    await ensureDaemon(server);
    const dir = await resolveThreadDirectory(server, id);
    const client = makeClient(dir, server);
    const t = (await client.fetchState()).threads.find((x) => x.threadId === id);
    if (!t) throw new Error(`unknown thread: ${id}`);
    const messages = await compactMessages(t.messages, {
      maxTokens: opts.maxTokens,
      keepTokens: opts.keepTokens,
    });
    if (!messages) {
      console.log(JSON.stringify({ compacted: false, reason: "under threshold" }));
      return;
    }
    await client.dispatch({
      type: "thread.compact",
      threadId: id,
      messages,
      commandId: randomUUID(),
      createdAt: now(),
    });
    console.log(JSON.stringify({ compacted: true, messages: messages.length }));
  });

// ---------------------------------------------------------------------------
// fanout
// ---------------------------------------------------------------------------

program
  .command("fanout <name>")
  .description("Create N worktrees + threads and start the same prompt in each")
  .requiredOption("--project <id>", "project id")
  .requiredOption("--count <n>", "number of agents", (v: string) => Number(v))
  .requiredOption("--prompt <prompt>", "prompt for each agent")
  .action(async (name: string, opts: { project: string; count: number; prompt: string }) => {
    if (opts.count < 1) throw new Error("count must be >= 1");
    const server = resolveServer();
    const dir = resolveProjectDir(opts.project);
    await ensureDaemon(server);
    const client = makeClient(dir, server);
    const pending: { worktreeId: string; threadId: string }[] = [];
    for (let n = 0; n < opts.count; n++) {
      const worktreeId = randomUUID();
      await client.dispatch({
        type: "worktree.create",
        worktreeId,
        projectId: opts.project,
        name,
        baseRef: "HEAD",
        commandId: randomUUID(),
        createdAt: now(),
      });
      const threadId = randomUUID();
      await client.dispatch({
        type: "thread.create",
        threadId,
        projectId: opts.project,
        worktreeId,
        title: `${name} #${n + 1}`,
        commandId: randomUUID(),
        createdAt: now(),
      });
      await client.dispatch({
        type: "thread.turn.start",
        threadId,
        turnId: randomUUID(),
        prompt: opts.prompt,
        commandId: randomUUID(),
        createdAt: now(),
      });
      pending.push({ worktreeId, threadId });
    }
    const rm = await client.fetchState();
    const entries = pending.map(({ worktreeId, threadId }) => {
      const w = rm.worktrees.find((x) => x.worktreeId === worktreeId);
      return { worktreeId, branch: w?.branch ?? "", path: w?.path ?? "", threadId, status: "running" as const };
    });
    console.log(JSON.stringify(entries, null, 2));
  });

// ---------------------------------------------------------------------------
// run (TUI / json / rpc)
// ---------------------------------------------------------------------------

async function resolveThreadId(
  client: DaemonClient,
  opts: { project?: string; worktree?: string; thread?: string; title?: string; host?: string },
): Promise<string> {
  const rm = client.getReadModel();
  if (opts.thread) {
    if (!rm.threads.some((x) => x.threadId === opts.thread)) {
      throw new Error(`unknown thread: ${opts.thread}`);
    }
    return opts.thread;
  }
  const projectId = opts.project;
  if (!projectId) throw new Error("--project is required unless --thread is given");
  let worktreeId = opts.worktree;
  if (!worktreeId) {
    const first = rm.worktrees.find((w) => w.projectId === projectId);
    if (!first) {
      throw new Error(`no worktrees for project; run: roost worktree create <name> --project ${projectId}`);
    }
    worktreeId = first.worktreeId;
  }
  const threadId = randomUUID();
  const result = await client.dispatch({
    type: "thread.create",
    threadId,
    projectId,
    worktreeId,
    title: opts.title ?? "chat",
    hostId: opts.host,
    commandId: randomUUID(),
    createdAt: now(),
  });
  await client.waitForSequence(result.sequence);
  return threadId;
}

async function runJson(
  client: DaemonClient,
  opts: { project?: string; worktree?: string; thread?: string; title?: string; host?: string },
  prompt: string,
): Promise<void> {
  const threadId = await resolveThreadId(client, opts);
  const write = (e: Event) => process.stdout.write(formatEventLine(e) + "\n");
  client.on("event", write);
  try {
    const result = await runTurnAndWait({ engine: client, threadId, prompt });
    if (!result.ok) process.exitCode = 1;
  } finally {
    client.off("event", write);
    client.close();
  }
}

async function runRpc(client: DaemonClient): Promise<void> {
  const write = (e: Event) => process.stdout.write(formatEventLine(e) + "\n");
  client.on("event", write);
  try {
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let command: RoostCommand;
      try {
        command = CommandSchema.parse(JSON.parse(line));
      } catch (err) {
        process.stdout.write(
          JSON.stringify({ error: `invalid command: ${err instanceof Error ? err.message : String(err)}` }) + "\n",
        );
        continue;
      }
      try {
        await client.dispatch(command);
      } catch (err) {
        process.stdout.write(
          JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) + "\n",
        );
      }
    }
  } finally {
    client.off("event", write);
    client.close();
  }
}

program
  .command("run")
  .description("Chat with the agent: streaming TUI (default), --format json, or --mode rpc")
  .option("--project <id>", "project id (required unless --thread is given)")
  .option("--worktree <id>", "worktree id (defaults to the project's first worktree)")
  .option("--thread <id>", "resume an existing thread")
  .option("--title <title>", "thread title (new threads)")
  .option("--prompt <prompt>", "initial prompt to send")
  .option("--format <format>", "non-interactive: emit committed events as JSON lines")
  .option("--mode <mode>", "rpc: JSONL commands on stdin, events on stdout")
  .option("--host <hostId>", "execution host route (local | ssh:<id>)")
  .action(
    async (opts: {
      project?: string;
      worktree?: string;
      thread?: string;
      title?: string;
      prompt?: string;
      format?: string;
      mode?: string;
      host?: string;
    }) => {
      const server = resolveServer();
      await ensureDaemon(server);
      const dir = opts.thread
        ? await resolveThreadDirectory(server, opts.thread)
        : resolveProjectDir(opts.project ?? "");
      const client = makeClient(dir, server);
      await client.connect();

      if (opts.mode === "rpc") return runRpc(client);
      if (opts.format === "json") {
        const prompt = opts.prompt;
        if (!prompt) throw new Error("--format json requires --prompt");
        return runJson(client, opts, prompt);
      }

      const threadId = await resolveThreadId(client, opts);
      try {
        const instance = render(
          createElement(ChatApp, { engine: client, threadId, initialPrompt: opts.prompt }),
          { exitOnCtrlC: false },
        );
        await instance.waitUntilExit();
      } finally {
        client.close();
      }
    },
  );

// ---------------------------------------------------------------------------
// diff / git
// ---------------------------------------------------------------------------

program
  .command("diff <threadId>")
  .description("Show the git diff for a thread's worktree (vs HEAD)")
  .action(async (threadId: string) => {
    const server = resolveServer();
    await ensureDaemon(server);
    const dir = await resolveThreadDirectory(server, threadId);
    const rm = await makeClient(dir, server).fetchState();
    const t = rm.threads.find((x) => x.threadId === threadId);
    if (!t) throw new Error(`unknown thread: ${threadId}`);
    const w = rm.worktrees.find((x) => x.worktreeId === t.worktreeId);
    if (!w) throw new Error(`unknown worktree: ${t.worktreeId}`);
    const status = execFileSync("git", ["status", "--short"], { cwd: w.path, encoding: "utf8", windowsHide: true });
    const diff = execFileSync("git", ["diff", "HEAD"], { cwd: w.path, encoding: "utf8", windowsHide: true });
    process.stdout.write(`Changes (${w.path}):\n${status}\n`);
    process.stdout.write(`\nDiff (vs HEAD):\n${diff || "(clean working tree)"}\n`);
  });

program
  .command("git <action>")
  .description("Run a git action (commit | push | createPr) in a thread's worktree")
  .requiredOption("--thread <id>", "thread id")
  .option("-m, --message <text>", "commit message or PR title")
  .action(async (action: string, opts: { thread: string; message?: string }) => {
    if (action !== "commit" && action !== "push" && action !== "createPr") {
      throw new Error(`unknown git action: ${action} (expected commit|push|createPr)`);
    }
    const server = resolveServer();
    await ensureDaemon(server);
    const dir = await resolveThreadDirectory(server, opts.thread);
    const client = makeClient(dir, server);
    await client.connect();
    try {
      const result = await client.dispatch({
        type: "thread.git.action",
        threadId: opts.thread,
        action: action as "commit" | "push" | "createPr",
        message: opts.message,
        commandId: randomUUID(),
        createdAt: now(),
      });
      const completed = await client.waitForEvent(
        (e) => e.type === "thread.git.completed" && e.aggregateId === opts.thread && e.sequence > result.sequence,
        60_000,
      );
      if (completed.type === "thread.git.completed") {
        const { ok, summary } = completed.payload;
        console.log(JSON.stringify({ action, ok, summary }));
        if (!ok) process.exitCode = 1;
      }
    } finally {
      client.close();
    }
  });

// ---------------------------------------------------------------------------
// command (custom slash commands in .roost/commands)
// ---------------------------------------------------------------------------

const command = program.command("command").description("Custom slash commands (.roost/commands/*.md)");

command
  .command("list [directory]")
  .description("List custom commands")
  .action((directory?: string) => {
    const root = resolve(directory ?? process.cwd());
    const cmds = discoverCommands(commandsDirFor(root));
    console.log(
      JSON.stringify(
        cmds.map((c) => ({ name: c.name, description: c.description })),
        null,
        2,
      ),
    );
  });

command
  .command("run <name>")
  .description("Run a custom command as an agent turn (expands $ARGUMENTS/$1..$9)")
  .requiredOption("--project <id>", "project id")
  .option("--args <text>", "space-separated arguments")
  .action(async (name: string, opts: { project: string; args?: string }) => {
    const server = resolveServer();
    const dir = resolveProjectDir(opts.project);
    const def = discoverCommands(commandsDirFor(dir)).find((c) => c.name === name);
    if (!def) throw new Error(`unknown command: ${name}`);
    const args = opts.args ? opts.args.split(/\s+/).filter(Boolean) : [];
    const prompt = commandPrompt(def, args);
    await ensureDaemon(server);
    const client = makeClient(dir, server);
    await client.connect();
    await runJson(client, { project: opts.project }, prompt);
  });

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

const configCmd = program.command("config").description("Inspect or initialize Roost config");

configCmd
  .command("show [directory]")
  .description("Print the merged effective config and the source of each field")
  .action((directory?: string) => {
    const projectRoot = directory ? resolve(directory) : process.cwd();
    const resolved = loadConfig({ projectRoot });
    console.log(JSON.stringify({ config: resolved.config, sources: resolved.sources }, null, 2));
  });

configCmd
  .command("init [directory]")
  .description("Write a starter .roost/config.json (refuses to overwrite)")
  .action((directory?: string) => {
    const root = resolve(directory ?? process.cwd());
    const roostDir = join(root, ".roost");
    const file = join(roostDir, "config.json");
    if (existsSync(file)) {
      console.log(`config already exists: ${file}`);
      return;
    }
    mkdirSync(roostDir, { recursive: true });
    const starter = {
      provider: "claude-cli",
      branchPrefix: "roost",
      permissionMode: "acceptEdits",
    };
    writeFileSync(file, `${JSON.stringify(starter, null, 2)}\n`);
    console.log(`wrote ${file}`);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`error: ${message}`);
  process.exit(1);
});
