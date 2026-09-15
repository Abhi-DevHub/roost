#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { startDaemon } from "./daemon.js";

export { startDaemon } from "./daemon.js";
export type { DaemonOptions, Daemon } from "./daemon.js";

function arg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : fallback;
}

async function main(): Promise<void> {
  const daemon = await startDaemon({
    host: arg("--host", process.env.ROOST_HOST ?? "127.0.0.1"),
    port: Number(arg("--port", process.env.ROOST_PORT ?? "4318")),
  });
  console.log(`roost daemon listening on ${daemon.url}`);
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entry) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
