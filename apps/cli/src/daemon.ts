import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { roostHome } from "@roost/core";

const HOME = roostHome();

// ---------------------------------------------------------------------------
// Client-side project registry (`projectId -> directory`) + daemon lifecycle
// (health check, detached spawn, stop). The daemon owns all orchestration
// state; the registry only remembers which directories the CLI has registered.
// ---------------------------------------------------------------------------

export interface RegistryEntry {
  workspaceRoot: string;
  title: string;
}

export function registryPath(): string {
  return join(HOME, "projects.json");
}

export function loadRegistry(): Record<string, RegistryEntry> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(registryPath(), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, RegistryEntry>;
    }
  } catch {
    // missing or corrupt → start empty
  }
  return {};
}

export function saveRegistry(reg: Record<string, RegistryEntry>): void {
  mkdirSync(HOME, { recursive: true });
  writeFileSync(registryPath(), `${JSON.stringify(reg, null, 2)}\n`);
}

export function resolveProjectDir(projectId: string): string {
  const entry = loadRegistry()[projectId];
  if (!entry) throw new Error(`unknown project: ${projectId}`);
  return entry.workspaceRoot;
}

async function health(serverUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean };
    return body?.ok === true;
  } catch {
    return false;
  }
}

function serverEntry(): string {
  return fileURLToPath(import.meta.resolve("@roost/server"));
}

function spawnDaemon(serverUrl: string): void {
  const url = new URL(serverUrl);
  const child = spawn(process.execPath, [serverEntry()], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      ROOST_PORT: url.port || "4318",
      ROOST_HOST: url.hostname || "127.0.0.1",
    },
  });
  child.unref();
}

export async function ensureDaemon(serverUrl: string, timeoutMs = 10_000): Promise<void> {
  if (await health(serverUrl)) return;
  spawnDaemon(serverUrl);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await health(serverUrl)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `no Roost daemon reachable at ${serverUrl}. Run "roost serve" to start one, or pass --server <url>.`,
  );
}

export async function stopDaemon(serverUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${serverUrl}/shutdown`, { method: "POST" });
    return res.ok;
  } catch {
    return false;
  }
}
