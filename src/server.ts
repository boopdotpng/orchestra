#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CodexV2Backend } from "./backend/codex-v2/CodexV2Backend";
import { AgentManager } from "./manager/AgentManager";
import { createOrchestraHandler } from "./server/http";
import { OrchestraStore } from "./store/OrchestraStore";
import { WorkspaceManager } from "./workspace/WorkspaceManager";

const host = process.env.ORCHESTRA_HOST ?? "127.0.0.1";
const port = Number(process.env.ORCHESTRA_PORT ?? "5751");

const store = new OrchestraStore();
const backend = new CodexV2Backend({ cwd: process.cwd(), args: codexAppServerArgs() });
const manager = new AgentManager(backend, { store });
const workspace = new WorkspaceManager(store, manager);

await manager.connect();

const server = Bun.serve({
  hostname: host,
  port,
  fetch: createOrchestraHandler({ store, manager, workspace }),
});

console.log(`orchestra listening on http://${server.hostname}:${server.port}`);

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function shutdown() {
  server.stop();
  await manager.close();
  store.close();
  process.exit(0);
}

function codexAppServerArgs(): string[] {
  const transport = process.env.ORCHESTRA_CODEX_TRANSPORT ?? "auto";
  if (transport === "stdio") {
    return ["app-server", "--stdio"];
  }
  if (transport === "proxy") {
    return ["app-server", "proxy"];
  }
  const socket = join(homedir(), ".codex", "app-server-control", "app-server-control.sock");
  return existsSync(socket) ? ["app-server", "proxy"] : ["app-server", "--stdio"];
}
