import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
        name: "ship workspace",
        dir: repo,
        count: 1,
        prompt: "ship it",
        model: "gpt-5.5",
      }),
    );
    expect(createResponse.status).toBe(200);
    const created = (await createResponse.json()) as { agents: Array<{ id: string; status: string; workspaceName: string }> };
    expect(created.agents[0]?.id).toMatch(/^[0-9a-f]{4}$/);
    expect(created.agents[0]?.workspaceName).toBe("ship workspace");

    const statusResponse = await handler(new Request("http://127.0.0.1/status"));
    const status = (await statusResponse.json()) as { agents: unknown[]; approvals: unknown[] };
    expect(status.agents).toHaveLength(1);
    expect(status.approvals).toHaveLength(0);

    store.close();
  });

  test("filters status and standouts by exact workspace name", async () => {
    const root = tempRoot();
    const repo = join(root, "repo");
    initGitRepo(repo);

    const store = new OrchestraStore(join(root, "orchestra.db"));
    const manager = new AgentManager(new FakeBackend(), { store });
    const workspace = new WorkspaceManager(store, manager);
    const handler = createOrchestraHandler({ store, manager, workspace, cwd: root });

    const targetResponse = await handler(
      jsonRequest("http://127.0.0.1/agents", {
        name: "target workspace",
        dir: repo,
        count: 1,
        prompt: "ship it",
      }),
    );
    const otherResponse = await handler(
      jsonRequest("http://127.0.0.1/agents", {
        name: "other workspace",
        dir: repo,
        count: 1,
        prompt: "ship it",
      }),
    );
    const target = (await targetResponse.json()) as { agents: Array<{ id: string; cwd: string }> };
    const other = (await otherResponse.json()) as { agents: Array<{ id: string; cwd: string }> };
    writeFileSync(join(target.agents[0]!.cwd, "target.ts"), "export const target = true;\n");
    writeFileSync(join(other.agents[0]!.cwd, "other.ts"), "export const other = true;\n");

    const statusResponse = await handler(new Request("http://127.0.0.1/status?workspace=TARGET%20WORKSPACE"));
    const status = (await statusResponse.json()) as { agents: Array<{ id: string }>; approvals: unknown[] };
    expect(status.agents.map((agent) => agent.id)).toEqual([target.agents[0]!.id]);
    expect(status.approvals).toHaveLength(0);

    const standoutsResponse = await handler(new Request("http://127.0.0.1/standouts?workspace=target%20workspace"));
    const standouts = await standoutsResponse.text();
    expect(standouts).toContain(target.agents[0]!.id);
    expect(standouts).not.toContain(other.agents[0]!.id);

    store.close();
  });

  test("creates focused agents from shared prompt request", async () => {
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
        name: "focused pass",
        dir: repo,
        sharedPrompt: "Second focused pass",
        agents: [{ focus: "Fix reg 4" }, { focus: "Add tracepoints" }],
      }),
    );

    expect(createResponse.status).toBe(200);
    const created = (await createResponse.json()) as { agents: Array<{ id: string; workspaceName: string }> };
    expect(created.agents).toHaveLength(2);
    expect(created.agents.map((agent) => agent.workspaceName)).toEqual(["focused pass", "focused pass"]);
    expect(backend.startedTurns.map((turn) => turn.input).sort()).toEqual(
      ["Second focused pass\n\nFocus:\nAdd tracepoints", "Second focused pass\n\nFocus:\nFix reg 4"].sort(),
    );

    store.close();
  });

  test("creates explore agents from a non-git folder through HTTP", async () => {
    const root = tempRoot();
    const source = join(root, "notes");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "README.md"), "# notes\n");
    const store = new OrchestraStore(join(root, "orchestra.db"));
    const backend = new FakeBackend();
    const manager = new AgentManager(backend, { store });
    const workspace = new WorkspaceManager(store, manager);
    const handler = createOrchestraHandler({ store, manager, workspace, cwd: root });

    const createResponse = await handler(
      jsonRequest("http://127.0.0.1/agents", {
        name: "explore notes",
        dir: source,
        explore: true,
        count: 2,
        prompt: "inspect only",
      }),
    );

    expect(createResponse.status).toBe(200);
    const created = (await createResponse.json()) as { agents: Array<{ id: string; cwd: string; branch: string; explore: boolean }> };
    expect(created.agents).toHaveLength(2);
    expect(created.agents.every((agent) => agent.explore)).toBe(true);
    expect(created.agents.every((agent) => agent.cwd === source)).toBe(true);
    expect(created.agents.every((agent) => agent.branch === "explore")).toBe(true);
    expect(backend.startedThreads.every((thread) => thread.sandbox === "read-only")).toBe(true);

    const diffResponse = await handler(new Request(`http://127.0.0.1/agents/${created.agents[0]!.id}/diff`));
    expect(await diffResponse.text()).toContain("explore agent");

    store.close();
  });

  test("broadcasts guidance to a workspace and explicit agent ids", async () => {
    const root = tempRoot();
    const repo = join(root, "repo");
    initGitRepo(repo);

    const store = new OrchestraStore(join(root, "orchestra.db"));
    const backend = new FakeBackend();
    const manager = new AgentManager(backend, { store });
    const workspace = new WorkspaceManager(store, manager);
    const handler = createOrchestraHandler({ store, manager, workspace, cwd: root });

    const targetResponse = await handler(
      jsonRequest("http://127.0.0.1/agents", {
        name: "target workspace",
        dir: repo,
        count: 2,
        prompt: "start",
      }),
    );
    const otherResponse = await handler(
      jsonRequest("http://127.0.0.1/agents", {
        name: "other workspace",
        dir: repo,
        prompt: "start",
      }),
    );
    const target = (await targetResponse.json()) as { agents: Array<{ id: string; threadId: string }> };
    const other = (await otherResponse.json()) as { agents: Array<{ id: string; threadId: string }> };

    const broadcastResponse = await handler(
      jsonRequest("http://127.0.0.1/broadcast", {
        workspace: "TARGET WORKSPACE",
        agents: [other.agents[0]!.id, target.agents[0]!.id, "ffff"],
        input: "same steer",
      }),
    );

    expect(broadcastResponse.status).toBe(200);
    const body = (await broadcastResponse.json()) as { results: Array<{ id: string; ok: boolean; error?: string }> };
    const okIds = body.results.filter((result) => result.ok).map((result) => result.id).sort();
    expect(okIds).toEqual([...target.agents.map((agent) => agent.id), other.agents[0]!.id].sort());
    expect(body.results.filter((result) => result.id === target.agents[0]!.id)).toHaveLength(1);
    expect(body.results.find((result) => result.id === "ffff")?.error).toContain("unknown agent id");
    expect(backend.steeredTurns.map((turn) => turn.input)).toEqual(["same steer", "same steer", "same steer"]);
    expect(backend.steeredTurns.map((turn) => turn.threadId).sort()).toEqual([...target.agents.map((agent) => agent.threadId), other.agents[0]!.threadId].sort());

    const rejectedResponse = await handler(jsonRequest("http://127.0.0.1/broadcast", { input: "nobody" }));
    expect(rejectedResponse.status).toBe(500);
    const rejected = (await rejectedResponse.json()) as { error: string };
    expect(rejected.error).toContain("broadcast requires workspace or agents");

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
        name: "teardown workspace",
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

  test("tears down managed agents by workspace name", async () => {
    const root = tempRoot();
    const repo = join(root, "repo");
    initGitRepo(repo);

    const store = new OrchestraStore(join(root, "orchestra.db"));
    const manager = new AgentManager(new FakeBackend(), { store });
    const workspace = new WorkspaceManager(store, manager);
    const handler = createOrchestraHandler({ store, manager, workspace, cwd: root });

    const targetResponse = await handler(
      jsonRequest("http://127.0.0.1/agents", {
        name: "blackhole-py",
        dir: repo,
        prompt: "work",
      }),
    );
    const otherResponse = await handler(
      jsonRequest("http://127.0.0.1/agents", {
        name: "trace work",
        dir: repo,
        prompt: "work",
      }),
    );
    const target = (await targetResponse.json()) as { agents: Array<{ id: string; cwd: string }> };
    const other = (await otherResponse.json()) as { agents: Array<{ id: string; cwd: string }> };

    const teardownResponse = await handler(jsonRequest("http://127.0.0.1/teardown", { workspace: "blackhole-py" }));
    expect(teardownResponse.status).toBe(200);
    const tornDown = (await teardownResponse.json()) as { agents: Array<{ id: string; cwd: string }> };
    expect(tornDown.agents.map((agent) => agent.id)).toEqual(target.agents.map((agent) => agent.id));
    expect(existsSync(target.agents[0]!.cwd)).toBe(false);
    expect(existsSync(other.agents[0]!.cwd)).toBe(true);

    const agentsResponse = await handler(new Request("http://127.0.0.1/agents"));
    const remaining = (await agentsResponse.json()) as { agents: Array<{ id: string }> };
    expect(remaining.agents.map((agent) => agent.id)).toEqual(other.agents.map((agent) => agent.id));

    store.close();
  });

  test("tears down selected managed agents by id list", async () => {
    const root = tempRoot();
    const repo = join(root, "repo");
    initGitRepo(repo);

    const store = new OrchestraStore(join(root, "orchestra.db"));
    const manager = new AgentManager(new FakeBackend(), { store });
    const workspace = new WorkspaceManager(store, manager);
    const handler = createOrchestraHandler({ store, manager, workspace, cwd: root });

    const createResponse = await handler(
      jsonRequest("http://127.0.0.1/agents", {
        name: "agent-list teardown",
        dir: repo,
        count: 3,
        prompt: "work",
      }),
    );
    const created = (await createResponse.json()) as { agents: Array<{ id: string; cwd: string }> };

    const teardownResponse = await handler(
      jsonRequest("http://127.0.0.1/teardown", {
        agents: [created.agents[0]!.id, created.agents[2]!.id],
      }),
    );
    expect(teardownResponse.status).toBe(200);
    const tornDown = (await teardownResponse.json()) as { agents: Array<{ id: string; cwd: string }> };
    expect(tornDown.agents.map((agent) => agent.id)).toEqual([created.agents[0]!.id, created.agents[2]!.id]);
    expect(existsSync(created.agents[0]!.cwd)).toBe(false);
    expect(existsSync(created.agents[1]!.cwd)).toBe(true);
    expect(existsSync(created.agents[2]!.cwd)).toBe(false);

    const agentsResponse = await handler(new Request("http://127.0.0.1/agents"));
    const remaining = (await agentsResponse.json()) as { agents: Array<{ id: string }> };
    expect(remaining.agents.map((agent) => agent.id)).toEqual([created.agents[1]!.id]);

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
        name: "remove workspace",
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
        name: "missing prompt",
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
        name: "history workspace",
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

  test("resumes an agent event stream from a cursor, replaying only the gap", async () => {
    const root = tempRoot();
    const repo = join(root, "repo");
    initGitRepo(repo);

    const store = new OrchestraStore(join(root, "orchestra.db"));
    const manager = new AgentManager(new FakeBackend(), { store });
    const workspace = new WorkspaceManager(store, manager);
    const handler = createOrchestraHandler({ store, manager, workspace, cwd: root });

    const created = (await (
      await handler(jsonRequest("http://127.0.0.1/agents", { name: "resume", dir: repo, count: 1, prompt: "go" }))
    ).json()) as { agents: Array<{ id: string; threadId: string }> };
    const { id, threadId } = created.agents[0]!;

    for (const delta of ["a", "b", "c"]) {
      store.applyEvent({ type: "stream.agent", threadId, turnId: "turn-1", itemId: "item-1", delta });
    }
    // Cursor at the "a" event, after the agent-creation events on the same thread.
    const aEvent = store.listEvents(threadId).find((e) => (e as { delta?: string }).delta === "a") as { seq: number };
    const firstSeq = aEvent.seq;

    const response = await handler(
      new Request(`http://127.0.0.1/agents/${id}/events?since=${firstSeq}`, { headers: { accept: "text/event-stream" } }),
    );
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");

    const frames = await readSseFrames(response, 3); // hello + the two missed events
    expect(frames[0]).toContain('"type":"hello"');
    const deltas = frames.slice(1).map((f) => (JSON.parse(f.split("data: ")[1]!) as { delta: string }).delta);
    expect(deltas).toEqual(["b", "c"]); // "a" was before the cursor and is not replayed

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
          reasoningEffort: "high",
        },
        "PATCH",
      ),
    );
    expect(updateResponse.status).toBe(200);
    const config = (await updateResponse.json()) as { model: string; serviceTier: string; fastMode: boolean; reasoningEffort?: string; sources: string[] };
    expect(config.model).toBe("gpt-6");
    expect(config.serviceTier).toBe("priority");
    expect(config.reasoningEffort).toBe("high");
    expect(readFileSync(join(home, ".orchestra", "config.toml"), "utf8")).toContain('model = "gpt-6"');
    expect(readFileSync(join(home, ".orchestra", "config.toml"), "utf8")).toContain('reasoning_effort = "high"');

    const configResponse = await handler(new Request("http://127.0.0.1/config"));
    const effective = (await configResponse.json()) as { model: string; serviceTier: string; reasoningEffort?: string };
    expect(effective.model).toBe("gpt-6");
    expect(effective.serviceTier).toBe("priority");
    expect(effective.reasoningEffort).toBe("high");

    const modelsResponse = await handler(new Request("http://127.0.0.1/models"));
    const models = (await modelsResponse.json()) as { data: Array<{ id: string; serviceTiers: string[] }> };
    expect(models.data[0]?.serviceTiers).toContain("priority");

    store.close();
  });
});

async function readSseFrames(response: Response, count: number): Promise<string[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const frames: string[] = [];
  let buffer = "";
  try {
    while (frames.length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        frames.push(buffer.slice(0, sep));
        buffer = buffer.slice(sep + 2);
      }
    }
  } finally {
    await reader.cancel();
  }
  return frames;
}

class FakeBackend implements CodexBackend {
  notifications = new EventBus<BackendNotification>();
  requests = new EventBus<BackendServerRequest>();
  startedThreads: Array<{ cwd?: string | undefined; approvalPolicy?: string | undefined; sandbox?: string | undefined }> = [];
  startedTurns: Array<{ threadId: string; input: string }> = [];
  steeredTurns: Array<{ threadId: string; turnId: string; input: string }> = [];
  private threadCount = 0;
  private turnCount = 0;

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
  async startThread(options: { cwd?: string | undefined; approvalPolicy?: string | undefined; sandbox?: string | undefined }) {
    this.threadCount += 1;
    this.startedThreads.push(options);
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
  async startTurn(threadId: string, input: string) {
    this.turnCount += 1;
    this.startedTurns.push({ threadId, input });
    return { turn: { id: `turn-${this.turnCount}`, status: "inProgress" } };
  }
  async steerTurn(threadId: string, turnId: string, input: string) {
    this.steeredTurns.push({ threadId, turnId, input });
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
  async readRateLimits() {
    return {
      rateLimits: {
        primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: null },
        secondary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: null },
        planType: "plus",
      },
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
