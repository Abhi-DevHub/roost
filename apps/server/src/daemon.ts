import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import websocket from "@fastify/websocket";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  OrchestrationEngine,
  TurnReactor,
  GitReactor,
  WorktreeReactor,
  loadConfig,
  buildProviderRegistry,
  discoverSkills,
  connectHost,
  LspClient,
  formatDiagnostics,
  type Host,
  type ProviderRegistry,
  type RoostConfig,
} from "@roost/core";
import { DispatchRequestSchema, type Event } from "@roost/contracts";
import { WebSocket } from "ws";

// ---------------------------------------------------------------------------
// The Roost daemon: a multi-tenant Fastify server. Each project directory
// (resolved per-request from `x-roost-directory`) lazily builds its own
// OrchestrationEngine (SQLite under `<dir>/.roost/`), provider registry, and
// reactors. Reactors own all I/O so clients stay thin.
// ---------------------------------------------------------------------------

export interface DaemonOptions {
  host?: string;
  port?: number;
  now?: () => string;
  newId?: () => string;
  /** Override provider-registry construction (tests inject a scripted provider). */
  buildRegistry?: (config: RoostConfig, directory: string) => ProviderRegistry;
}

export interface Daemon {
  url: string;
  port: number;
  host: string;
  close(): Promise<void>;
}

interface Instance {
  engine: OrchestrationEngine;
  turnReactor: TurnReactor;
  gitReactor: GitReactor;
  worktreeReactor: WorktreeReactor;
  lsp: LspClient;
}

export async function startDaemon(opts: DaemonOptions = {}): Promise<Daemon> {
  const host = opts.host ?? process.env.ROOST_HOST ?? "127.0.0.1";
  const port = opts.port ?? Number(process.env.ROOST_PORT ?? 4318);
  const instances = new Map<string, Instance>();

  function defaultRegistry(
    config: RoostConfig,
    directory: string,
    extra: { hostResolver: (threadId: string) => Host; diagnostics: (filePath: string) => Promise<string> },
  ): ProviderRegistry {
    const agentsDir = config.agentsDir ?? join(directory, ".roost", "agents");
    const skills = config.provider === "native" ? discoverSkills({ cwd: directory }).skills : [];
    return buildProviderRegistry({
      provider: config.provider,
      model: config.model,
      permissionMode: config.permissionMode,
      agentsDir,
      skills,
      hosts: config.hosts,
      mcpServers: config.mcpServers,
      lspServers: config.lspServers,
      hostResolver: extra.hostResolver,
      diagnostics: extra.diagnostics,
    });
  }

  function instanceFor(directory: string): Instance {
    const key = resolve(directory);
    let inst = instances.get(key);
    if (!inst) {
      const config = loadConfig({ projectRoot: key }).config;
      const roostDir = join(key, ".roost");
      mkdirSync(roostDir, { recursive: true });
      const engine = new OrchestrationEngine({
        dbPath: join(roostDir, "roost.db"),
        worktreesDir: config.worktreesDir,
        branchPrefix: config.branchPrefix,
        now: opts.now,
        newId: opts.newId,
      });
      const hostResolver = (threadId: string): Host => {
        const thread = engine.getReadModel().threads.find((t) => t.threadId === threadId);
        return connectHost(thread?.hostId ?? "local", config.hosts);
      };
      const lsp = new LspClient({ servers: config.lspServers });
      const diagnostics = async (filePath: string): Promise<string> =>
        formatDiagnostics(await lsp.diagnostics(filePath));
      const registry = opts.buildRegistry
        ? opts.buildRegistry(config, key)
        : defaultRegistry(config, key, { hostResolver, diagnostics });
      const turnReactor = new TurnReactor(engine, registry);
      const gitReactor = new GitReactor(engine, hostResolver);
      const worktreeReactor = new WorktreeReactor(engine);
      turnReactor.start();
      gitReactor.start();
      worktreeReactor.start();
      inst = { engine, turnReactor, gitReactor, worktreeReactor, lsp };
      instances.set(key, inst);
    }
    return inst;
  }

  function resolveDirectory(req: FastifyRequest): string | null {
    const header = req.headers["x-roost-directory"];
    if (typeof header === "string" && header.length > 0) return header;
    if (Array.isArray(header) && typeof header[0] === "string" && header[0].length > 0) return header[0];
    const query = req.query as Record<string, unknown> | undefined;
    const directory = query?.["directory"];
    if (typeof directory === "string" && directory.length > 0) return directory;
    return null;
  }

  const app = Fastify({ logger: false });
  await app.register(websocket);

  app.get("/health", async () => ({ ok: true }));

  app.get("/state", async (req: FastifyRequest, reply: FastifyReply) => {
    const directory = resolveDirectory(req);
    if (!directory) {
      return reply.code(400).send({ ok: false, error: "missing x-roost-directory header" });
    }
    return reply.send({ readModel: instanceFor(directory).engine.getReadModel() });
  });

  app.post("/rpc/dispatch", async (req: FastifyRequest, reply: FastifyReply) => {
    const directory = resolveDirectory(req);
    if (!directory) {
      return reply.code(400).send({ ok: false, error: "missing x-roost-directory header" });
    }
    const parsed = DispatchRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: `invalid command: ${parsed.error.message}` });
    }
    const command = parsed.data.command;
    const engine = instanceFor(directory).engine;
    try {
      await engine.dispatch(command);
      const receipt = engine.getReceipt(command.commandId);
      return reply.send({ ok: true, receipt });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(409).send({ ok: false, error: message });
    }
  });

  app.get("/events", { websocket: true }, (socket, req) => {
    const directory = resolveDirectory(req);
    if (!directory) {
      socket.close(4000, "missing x-roost-directory header");
      return;
    }
    const engine = instanceFor(directory).engine;
    const fromSequence = Number((req.query as Record<string, unknown> | undefined)?.fromSequence ?? 0) || 0;

    for (const event of engine.readEventsAfter(fromSequence)) {
      socket.send(JSON.stringify({ event }));
    }

    const handler = (event: Event) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ event }));
      }
    };
    engine.on("event", handler);
    socket.on("close", () => engine.off("event", handler));
  });

  app.post("/shutdown", async (_req: FastifyRequest, reply: FastifyReply) => {
    reply.send({ ok: true });
    setImmediate(() => {
      void closeAll().then(() => process.exit(0));
    });
  });

  async function closeAll(): Promise<void> {
    for (const inst of instances.values()) {
      inst.turnReactor.stop();
      inst.gitReactor.stop();
      inst.worktreeReactor.stop();
      await inst.lsp.close();
      inst.engine.close();
    }
    instances.clear();
    await app.close();
  }

  await app.listen({ port, host });
  const address = app.server.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : port;

  return {
    url: `http://${host}:${actualPort}`,
    port: actualPort,
    host,
    close: closeAll,
  };
}
