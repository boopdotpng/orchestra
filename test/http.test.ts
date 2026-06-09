import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const originalHome = process.env.HOME;

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  process.env.HOME = originalHome;
});

describe("Orchestra HTTP handler", () => {
  test("creates agents and reports service status", async () => {
    const root = tempRoot();
    const repo = join(root, "repo");
    initGitRepo(repo);

    const store = new OrchestraStore(join(root, "orchestra.db"));
    const manager = new AgentManager(new FakeBackend(), { store });
    const workspace = new WorkspaceManager(store, manager);
    const handler = createOrchestraHandler({ store, manager, workspace, cwd: root });

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

  test("tears down managed agents for a repository", async () => {
    const root = tempRoot();
    const repo = join(root, "repo");
    initGitRepo(repo);

    const store = new OrchestraStore(join(root, "orchestra.db"));
    const manager = new AgentManager(new FakeBackend(), { store });
    const workspace = new WorkspaceManager(store, manager);
    const handler = createOrchestraHandler({ store, manager, workspace, cwd: root });

    const createResponse = await handler(
      jsonRequest("http://127.0.0.1/agents", {
        dir: repo,
        count: 2,
        prompt: "work",
      }),
    );
    expect(createResponse.status).toBe(200);
    const created = (await createResponse.json()) as { agents: Array<{ id: string; cwd: string }> };
    expect(created.agents).toHaveLength(2);
    for (const agent of created.agents) {
      expect(existsSync(agent.cwd)).toBe(true);
    }

    const teardownResponse = await handler(jsonRequest("http://127.0.0.1/repos/teardown", { dir: repo }));
    expect(teardownResponse.status).toBe(200);
    const tornDown = (await teardownResponse.json()) as { agents: Array<{ id: string; cwd: string }> };
    expect(tornDown.agents.map((agent) => agent.id).sort()).toEqual(created.agents.map((agent) => agent.id).sort());
    for (const agent of created.agents) {
      expect(existsSync(agent.cwd)).toBe(false);
    }

    const agentsResponse = await handler(new Request("http://127.0.0.1/agents"));
    const remaining = (await agentsResponse.json()) as { agents: unknown[] };
    expect(remaining.agents).toHaveLength(0);

    store.close();
  });

  test("removes one managed agent by id", async () => {
    const root = tempRoot();
    const repo = join(root, "repo");
    initGitRepo(repo);

    const store = new OrchestraStore(join(root, "orchestra.db"));
    const manager = new AgentManager(new FakeBackend(), { store });
    const workspace = new WorkspaceManager(store, manager);
    const handler = createOrchestraHandler({ store, manager, workspace, cwd: root });

    const createResponse = await handler(
      jsonRequest("http://127.0.0.1/agents", {
        dir: repo,
        count: 2,
        prompt: "work",
      }),
    );
    expect(createResponse.status).toBe(200);
    const created = (await createResponse.json()) as { agents: Array<{ id: string; cwd: string }> };
    expect(created.agents).toHaveLength(2);
    const removed = created.agents[0]!;
    const kept = created.agents[1]!;

    const removeResponse = await handler(jsonRequest(`http://127.0.0.1/agents/${removed.id}/remove`, {}));
    expect(removeResponse.status).toBe(200);
    const removedResponse = (await removeResponse.json()) as { agent: { id: string; cwd: string } };
    expect(removedResponse.agent.id).toBe(removed.id);
    expect(existsSync(removed.cwd)).toBe(false);
    expect(existsSync(kept.cwd)).toBe(true);

    const agentsResponse = await handler(new Request("http://127.0.0.1/agents"));
    const remaining = (await agentsResponse.json()) as { agents: Array<{ id: string }> };
    expect(remaining.agents.map((agent) => agent.id)).toEqual([kept.id]);

    store.close();
  });

  test("rejects managed agent creation without a prompt", async () => {
    const root = tempRoot();
    const repo = join(root, "repo");
    initGitRepo(repo);

    const store = new OrchestraStore(join(root, "orchestra.db"));
    const manager = new AgentManager(new FakeBackend(), { store });
    const workspace = new WorkspaceManager(store, manager);
    const handler = createOrchestraHandler({ store, manager, workspace, cwd: root });

    const createResponse = await handler(
      jsonRequest("http://127.0.0.1/agents", {
        dir: repo,
      }),
    );
    expect(createResponse.status).toBe(500);
    const body = (await createResponse.json()) as { error: string };
    expect(body.error).toContain("prompt is required");

    store.close();
  });

  test("returns full agent event history from oldest to newest", async () => {
    const root = tempRoot();
    const repo = join(root, "repo");
    initGitRepo(repo);

    const store = new OrchestraStore(join(root, "orchestra.db"));
    const backend = new FakeBackend();
    const manager = new AgentManager(backend, { store });
    const workspace = new WorkspaceManager(store, manager);
    const handler = createOrchestraHandler({ store, manager, workspace, cwd: root });

    const createResponse = await handler(
      jsonRequest("http://127.0.0.1/agents", {
        dir: repo,
        prompt: "ship it",
      }),
    );
    expect(createResponse.status).toBe(200);
    const created = (await createResponse.json()) as { agents: Array<{ id: string; threadId: string }> };
    const agent = created.agents[0]!;

    backend.notifications.emit({
      method: "item/agentMessage/delta",
      params: { threadId: agent.threadId, turnId: "turn-1", itemId: "item-1", delta: "hello" },
    });
    backend.notifications.emit({
      method: "item/completed",
      params: { threadId: agent.threadId, turnId: "turn-1", item: { type: "agentMessage", id: "item-1", text: "hello" } },
    });

    const historyResponse = await handler(new Request(`http://127.0.0.1/agents/${agent.id}/history`));
    expect(historyResponse.status).toBe(200);
    const history = (await historyResponse.json()) as { events: Array<{ type: string; delta?: string }> };
    expect(history.events.map((event) => event.type)).toEqual(["agent.started", "turn.started", "stream.agent", "item.completed"]);
    expect(history.events[2]?.delta).toBe("hello");

    store.close();
  });

  test("serves UI route map, config updates, and models", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    process.env.HOME = home;
    const store = new OrchestraStore(join(root, "orchestra.db"));
    const backend = new FakeBackend();
    const manager = new AgentManager(backend, { store });
    const workspace = new WorkspaceManager(store, manager);
    const handler = createOrchestraHandler({ store, manager, workspace, cwd: root });

    const routesResponse = await handler(new Request("http://127.0.0.1/routes"));
    const routes = (await routesResponse.json()) as { routes: Array<{ method: string; path: string }> };
    expect(routes.routes.some((route) => route.method === "GET" && route.path === "/events")).toBe(true);

    const updateResponse = await handler(
      jsonRequest(
        "http://127.0.0.1/config",
        {
          model: "gpt-6",
          fastMode: true,
        },
        "PATCH",
      ),
    );
    expect(updateResponse.status).toBe(200);
    const config = (await updateResponse.json()) as { model: string; serviceTier: string; fastMode: boolean; sources: string[] };
    expect(config.model).toBe("gpt-6");
    expect(config.serviceTier).toBe("priority");
    expect(readFileSync(join(home, ".orchestra", "config.toml"), "utf8")).toContain('model = "gpt-6"');

    const configResponse = await handler(new Request("http://127.0.0.1/config"));
    const effective = (await configResponse.json()) as { model: string; serviceTier: string };
    expect(effective.model).toBe("gpt-6");
    expect(effective.serviceTier).toBe("priority");

    const modelsResponse = await handler(new Request("http://127.0.0.1/models"));
    const models = (await modelsResponse.json()) as { data: Array<{ id: string; serviceTiers: string[] }> };
    expect(models.data[0]?.serviceTiers).toContain("priority");

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
    return {
      data: [
        {
          id: "gpt-5.5",
          serviceTiers: ["default", "priority"],
        },
      ],
    };
  }
  async respond(_requestId: string | number, _result: Json) {}
}

function jsonRequest(url: string, body: Record<string, unknown>, method = "POST"): Request {
  return new Request(url, {
    method,
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
