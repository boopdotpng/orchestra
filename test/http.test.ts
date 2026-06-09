import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexBackend } from "../src/backend/CodexBackend";
import { EventBus } from "../src/domain/events";
import type { BackendNotification, BackendServerRequest, Json } from "../src/domain/types";
import { AgentManager } from "../src/manager/AgentManager";
import { createOrchestraHandler } from "../src/server/http";
import { OrchestraStore } from "../src/store/OrchestraStore";
import { WorkspaceManager } from "../src/workspace/WorkspaceManager";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Orchestra HTTP handler", () => {
  test("creates agents and reports service status", async () => {
    const root = tempRoot();
    const repo = join(root, "repo");
    initGitRepo(repo);

    const store = new OrchestraStore(join(root, "orchestra.db"));
    const manager = new AgentManager(new FakeBackend(), { store });
    const workspace = new WorkspaceManager(store, manager);
    const handler = createOrchestraHandler({ store, manager, workspace });

    const createResponse = await handler(
      jsonRequest("http://127.0.0.1/agents", {
        dir: repo,
        count: 1,
        prompt: "ship it",
        model: "gpt-5.5",
      }),
    );
    expect(createResponse.status).toBe(200);
    const created = (await createResponse.json()) as { agents: Array<{ id: string; status: string }> };
    expect(created.agents[0]?.id).toMatch(/^[0-9a-f]{4}$/);

    const statusResponse = await handler(new Request("http://127.0.0.1/status"));
    const status = (await statusResponse.json()) as { agents: unknown[]; approvals: unknown[] };
    expect(status.agents).toHaveLength(1);
    expect(status.approvals).toHaveLength(0);

    store.close();
  });
});

class FakeBackend implements CodexBackend {
  notifications = new EventBus<BackendNotification>();
  requests = new EventBus<BackendServerRequest>();
  private threadCount = 0;

  async connect() {}
  async close() {}
  onNotification(listener: (notification: BackendNotification) => void) {
    return this.notifications.on(listener);
  }
  onServerRequest(listener: (request: BackendServerRequest) => void) {
    return this.requests.on(listener);
  }
  async initialize() {
    return {};
  }
  async startThread(options: { cwd?: string | undefined }) {
    this.threadCount += 1;
    return {
      thread: {
        id: `thread-${this.threadCount}`,
        sessionId: `session-${this.threadCount}`,
        cwd: options.cwd ?? "",
        preview: "",
        status: { type: "idle" },
      },
    };
  }
  async resumeThread() {
    return {};
  }
  async listThreads() {
    return { data: [] };
  }
  async readThread() {
    return {};
  }
  async setThreadName() {
    return {};
  }
  async setThreadGoal() {
    return {};
  }
  async archiveThread() {
    return {};
  }
  async unarchiveThread() {
    return {};
  }
  async startTurn() {
    return { turn: { id: "turn-1", status: "inProgress" } };
  }
  async steerTurn() {
    return {};
  }
  async interruptTurn() {
    return {};
  }
  async listModels() {
    return {};
  }
  async respond(_requestId: string | number, _result: Json) {}
}

function jsonRequest(url: string, body: Record<string, unknown>): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "orchestra-http-test-"));
  roots.push(root);
  return root;
}

function initGitRepo(path: string): void {
  run(["mkdir", "-p", path]);
  git(path, ["init", "-b", "main"]);
  git(path, ["config", "user.email", "test@example.com"]);
  git(path, ["config", "user.name", "Test User"]);
  writeFileSync(join(path, "README.md"), "# test\n");
  git(path, ["add", "README.md"]);
  git(path, ["commit", "-m", "initial"]);
}

function git(cwd: string, args: string[]): string {
  return run(["git", ...args], cwd);
}

function run(cmd: string[], cwd?: string): string {
  const proc = Bun.spawnSync(cmd, cwd ? { cwd, stdout: "pipe", stderr: "pipe" } : { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(proc.stderr.toString());
  }
  return proc.stdout.toString().trim();
}
