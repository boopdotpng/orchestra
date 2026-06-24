import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexBackend } from "../src/backend/CodexBackend";
import { EventBus } from "../src/domain/events";
import type { BackendNotification, BackendServerRequest, Json, ManagedAgent } from "../src/domain/types";
import { AgentManager } from "../src/manager/AgentManager";
import { createOrchestraHandler } from "../src/server/http";
import { OrchestraStore } from "../src/store/OrchestraStore";
import { WorkspaceManager } from "../src/workspace/WorkspaceManager";

const roots: string[] = [];
const SPEED_MULTIPLIER = Number(process.env.ORCHESTRA_SPEED_BUDGET_MULTIPLIER ?? "1");

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("MCP call path speed checks", () => {
  test("status and list_workspaces source path stay bounded with many managed agents and events", async () => {
    const { store, handler } = seededFixture({ agentCount: 96, eventsPerAgent: 600, workspaceCount: 4 });

    const { elapsedMs: filteredMs, value: filtered } = await measureAsync(() => json(handler(new Request("http://127.0.0.1/status?workspace=speed-1"))));
    const { elapsedMs: allMs, value: all } = await measureAsync(() => json(handler(new Request("http://127.0.0.1/status"))));

    expect((filtered as { agents: unknown[] }).agents).toHaveLength(24);
    expect((all as { agents: unknown[] }).agents).toHaveLength(96);
    expectFast("MCP status(workspace)", filteredMs, 140);
    expectFast("MCP list_workspaces source /status", allMs, 280);

    store.close();
  });

  test("main MCP tools avoid obviously slow behavior", async () => {
    const root = tempRoot();
    const source = join(root, "source");
    const runs = join(root, "runs");
    initGitRepo(source);
    const store = new OrchestraStore(join(root, "orchestra.db"));
    const backend = new SpeedBackend();
    const manager = new AgentManager(backend, { store });
    const workspace = new WorkspaceManager(store, manager);
    const handler = createOrchestraHandler({ store, manager, workspace, cwd: root });

    const created = await timedJson("MCP create", 260, () =>
      handler(
        jsonRequest("http://127.0.0.1/agents", {
          name: "mcp speed",
          dir: source,
          count: 4,
          prompt: "speed",
        }),
      ),
    ) as { agents: ManagedAgent[] };
    expect(created.agents).toHaveLength(4);
    for (const agent of created.agents) {
      writeFileSync(join(agent.cwd, `${agent.id}.txt`), `change ${agent.id}\n`);
    }

    await timedJson("MCP status", 80, () => handler(new Request("http://127.0.0.1/status?workspace=mcp%20speed")));
    await timedText("MCP diff compare", 180, () => handler(jsonRequest("http://127.0.0.1/diff", { agents: created.agents.map((agent) => agent.id) })));
    await timedText("MCP standouts", 220, () => handler(new Request("http://127.0.0.1/standouts?workspace=mcp%20speed")));
    const execResult = await timedJson("MCP exec", 40, () =>
      handler(jsonRequest(`http://127.0.0.1/agents/${created.agents[0]!.id}/exec`, { cmd: "printf ok" })),
    ) as { output: string };
    expect(execResult.output).toBe("ok");

    backend.steerDelayMs = 10;
    await timedJson("MCP steer", 80, () =>
      handler(jsonRequest(`http://127.0.0.1/agents/${created.agents[0]!.id}/steer`, { input: "one" })),
    );
    await timedJson("MCP broadcast", 140, () =>
      handler(jsonRequest("http://127.0.0.1/broadcast", { workspace: "mcp speed", input: "all" })),
    );
    expect(backend.maxConcurrentSteers).toBeGreaterThanOrEqual(4);
    await timedJson("MCP interrupt", 80, () => handler(jsonRequest(`http://127.0.0.1/agents/${created.agents[1]!.id}/interrupt`, {})));
    const tornDown = await timedJson("MCP teardown", 180, () =>
      handler(jsonRequest("http://127.0.0.1/teardown", { workspace: "mcp speed" })),
    ) as { agents: ManagedAgent[] };
    expect(tornDown.agents).toHaveLength(4);
    expect(created.agents.every((agent) => !existsSync(agent.cwd))).toBe(true);

    const exploreSource = join(root, "plain-folder");
    mkdirSync(exploreSource, { recursive: true });
    writeFileSync(join(exploreSource, "notes.txt"), "inspect me\n");
    const explored = await timedJson("MCP explore create", 120, () =>
      handler(
        jsonRequest("http://127.0.0.1/agents", {
          name: "mcp explore",
          dir: exploreSource,
          explore: true,
          count: 3,
          prompt: "report",
        }),
      ),
    ) as { agents: ManagedAgent[] };
    expect(explored.agents).toHaveLength(3);
    expect(explored.agents.every((agent) => agent.explore && agent.cwd === exploreSource)).toBe(true);
    await timedJson("MCP explore status", 80, () => handler(new Request("http://127.0.0.1/status?workspace=mcp%20explore")));
    const exploreDiff = await timedText("MCP explore diff", 60, () => handler(jsonRequest("http://127.0.0.1/diff", { agent: explored.agents[0]!.id })));
    expect(exploreDiff).toContain("explore agent");
    const exploredTornDown = await timedJson("MCP explore teardown", 120, () =>
      handler(jsonRequest("http://127.0.0.1/teardown", { workspace: "mcp explore" })),
    ) as { agents: ManagedAgent[] };
    expect(exploredTornDown.agents).toHaveLength(3);
    expect(existsSync(exploreSource)).toBe(true);

    store.close();
  });

  test("read transcript stays compact with noisy event history", async () => {
    const { store, handler } = seededFixture({ agentCount: 1, eventsPerAgent: 1 });
    const insertEvent = store.db.query(
      "INSERT INTO events (thread_id, turn_id, method, payload_json, created_at_ms) VALUES (?, ?, ?, ?, ?)",
    );
    const noise = "internal noise ".repeat(40);
    const seedNoise = store.db.transaction(() => {
      for (let index = 0; index < 900; index += 1) {
        const type = index % 2 === 0 ? "stream.reasoning" : "stream.command";
        insertEvent.run(
          "thread-0",
          "turn-0",
          type,
          JSON.stringify({ type, threadId: "thread-0", turnId: "turn-0", itemId: `noise-${index}`, delta: noise }),
          index + 2,
        );
      }
      insertEvent.run(
        "thread-0",
        "turn-0",
        "item.completed",
        JSON.stringify({
          type: "item.completed",
          threadId: "thread-0",
          turnId: "turn-0",
          itemId: "user-1",
          item: { type: "userMessage", content: [{ type: "inputText", text: "Please summarize the result." }] },
        }),
        902,
      );
      insertEvent.run(
        "thread-0",
        "turn-0",
        "item.completed",
        JSON.stringify({
          type: "item.completed",
          threadId: "thread-0",
          turnId: "turn-0",
          itemId: "agent-1",
          item: { type: "agentMessage", id: "agent-1", text: "Done. The change is ready." },
        }),
        903,
      );
    });
    seedNoise();

    const result = (await timedJson("MCP read", 90, () => handler(jsonRequest("http://127.0.0.1/agents/a000/read", {})))) as { path: string };
    const transcript = readFileSync(result.path, "utf8");
    expect(transcript).toContain("Please summarize the result.");
    expect(transcript).toContain("Done. The change is ready.");
    expect(transcript).not.toContain("internal noise");
    expect(transcript.length).toBeLessThan(800);

    store.close();
  });
});

function seededFixture(options: { agentCount: number; eventsPerAgent: number; status?: ManagedAgent["status"]; workspaceCount?: number | undefined }) {
  const root = mkdtempSync(join(tmpdir(), "orchestra-speed-"));
  roots.push(root);
  const store = new OrchestraStore(join(root, "orchestra.db"));
  const backend = new SpeedBackend();
  const manager = new AgentManager(backend, { store });
  const workspace = new WorkspaceManager(store, manager);
  const handler = createOrchestraHandler({ store, manager, workspace, cwd: root });
  const repo = store.upsertRepo({ path: join(root, "repo"), baseCommit: "abc", baseBranch: "main" });

  const insertAgent = store.db.query(
    "INSERT INTO agents (thread_id, status, active_turn_id, token_usage_json, stored_at_ms) VALUES (?, ?, ?, ?, ?)",
  );
  const insertTurn = store.db.query(
    "INSERT INTO turns (turn_id, thread_id, status, updated_at_ms) VALUES (?, ?, ?, ?)",
  );
  const insertEvent = store.db.query(
    "INSERT INTO events (thread_id, turn_id, method, payload_json, created_at_ms) VALUES (?, ?, ?, ?, ?)",
  );

  const seed = store.db.transaction(() => {
    for (let agentIndex = 0; agentIndex < options.agentCount; agentIndex += 1) {
      const id = `a${agentIndex.toString(16).padStart(3, "0")}`;
      const threadId = `thread-${agentIndex}`;
      const turnId = `turn-${agentIndex}`;
      const cwd = join(root, "runs", id);
      const workspaceName = `speed-${agentIndex % (options.workspaceCount ?? 1)}`;
      mkdirSync(cwd, { recursive: true });
      store.insertManagedAgent({
        id,
        repoId: repo.id,
        workspaceName,
        cwd,
        branch: `orchestra/${id}`,
        threadId,
        activeTurnId: options.status === "running" ? turnId : undefined,
        status: options.status ?? "idle",
        createdAt: 1,
      });
      insertAgent.run(threadId, options.status === "running" ? "active" : "idle", options.status === "running" ? turnId : null, JSON.stringify({ totalTokens: agentIndex }), 1);
      insertTurn.run(turnId, threadId, options.status === "running" ? "inProgress" : "completed", 1);
      insertEvent.run(
        threadId,
        turnId,
        "turn.started",
        JSON.stringify({ type: "turn.started", threadId, turn: { threadId, turnId, status: "inProgress" } }),
        1,
      );
      for (let eventIndex = 1; eventIndex < options.eventsPerAgent; eventIndex += 1) {
        insertEvent.run(
          threadId,
          turnId,
          "stream.agent",
          JSON.stringify({ type: "stream.agent", threadId, turnId, itemId: "item-1", delta: "x" }),
          eventIndex + 1,
        );
      }
    }
  });
  seed();

  return { store, backend, manager, workspace, handler, root };
}

async function timedJson(label: string, budgetMs: number, fn: () => Promise<Response>): Promise<unknown> {
  const { elapsedMs, value } = await measureAsync(() => json(fn()));
  expectFast(label, elapsedMs, budgetMs);
  return value;
}

async function timedText(label: string, budgetMs: number, fn: () => Promise<Response>): Promise<string> {
  const { elapsedMs, value } = await measureAsync(() => text(fn()));
  expectFast(label, elapsedMs, budgetMs);
  return value;
}

async function json(responsePromise: Promise<Response>): Promise<unknown> {
  const response = await responsePromise;
  expect(response.status).toBe(200);
  return response.json();
}

async function text(responsePromise: Promise<Response>): Promise<string> {
  const response = await responsePromise;
  expect(response.status).toBe(200);
  return response.text();
}

async function measureAsync<T>(fn: () => Promise<T>): Promise<{ elapsedMs: number; value: T }> {
  const started = performance.now();
  const value = await fn();
  return { elapsedMs: performance.now() - started, value };
}

function expectFast(label: string, elapsedMs: number, budgetMs: number): void {
  const multiplier = Number.isFinite(SPEED_MULTIPLIER) && SPEED_MULTIPLIER > 0 ? SPEED_MULTIPLIER : 1;
  expect(elapsedMs, `${label} took ${elapsedMs.toFixed(2)}ms`).toBeLessThan(budgetMs * multiplier);
}

class SpeedBackend implements CodexBackend {
  readonly notifications = new EventBus<BackendNotification>();
  readonly requests = new EventBus<BackendServerRequest>();
  steerDelayMs = 0;
  private concurrentSteers = 0;
  maxConcurrentSteers = 0;
  private threadCount = 0;
  private turnCount = 0;

  async connect() {}
  async initialize() {
    return {};
  }
  async close() {}
  onNotification(listener: (notification: BackendNotification) => void) {
    return this.notifications.on(listener);
  }
  onServerRequest(listener: (request: BackendServerRequest) => void) {
    return this.requests.on(listener);
  }
  async startThread() {
    this.threadCount += 1;
    return { thread: { id: `thread-new-${this.threadCount}`, status: { type: "idle" } } };
  }
  async resumeThread() {
    return {};
  }
  async startTurn() {
    this.turnCount += 1;
    return { turn: { id: `turn-new-${this.turnCount}`, status: "inProgress" } };
  }
  async steerTurn() {
    this.concurrentSteers += 1;
    this.maxConcurrentSteers = Math.max(this.maxConcurrentSteers, this.concurrentSteers);
    try {
      if (this.steerDelayMs > 0) {
        await Bun.sleep(this.steerDelayMs);
      }
      return {};
    } finally {
      this.concurrentSteers -= 1;
    }
  }
  async interruptTurn() {
    return {};
  }
  async listThreads() {
    return { data: [] };
  }
  async readThread(): Promise<Json> {
    return {};
  }
  async listModels(): Promise<Json> {
    return { data: [] };
  }
  async readRateLimits(): Promise<Json> {
    return { rateLimits: {} };
  }
  async setThreadName(): Promise<Json> {
    return {};
  }
  async setThreadGoal(): Promise<Json> {
    return {};
  }
  async archiveThread(): Promise<Json> {
    return {};
  }
  async unarchiveThread(): Promise<Json> {
    return {};
  }
  async respond() {}
}

function jsonRequest(url: string, body: Record<string, unknown>, method = "POST"): Request {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "orchestra-speed-"));
  roots.push(root);
  return root;
}

function initGitRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "README.md"), "# speed\n");
  git(path, ["init"]);
  git(path, ["config", "user.email", "test@example.com"]);
  git(path, ["config", "user.name", "Test"]);
  git(path, ["add", "."]);
  git(path, ["commit", "-m", "init"]);
}

function git(cwd: string, args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(proc.stderr.toString());
  }
  return proc.stdout.toString().trim();
}
