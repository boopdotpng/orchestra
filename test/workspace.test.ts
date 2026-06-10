import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexBackend } from "../src/backend/CodexBackend";
import { EventBus } from "../src/domain/events";
import type { BackendNotification, BackendServerRequest, Json } from "../src/domain/types";
import { AgentManager } from "../src/manager/AgentManager";
import { OrchestraStore } from "../src/store/OrchestraStore";
import { WorkspaceManager } from "../src/workspace/WorkspaceManager";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("WorkspaceManager", () => {
  test("registers a pinned repo and creates an isolated branched agent workspace", async () => {
    const root = tempRoot();
    const source = join(root, "source");
    const runs = join(root, "runs");
    const store = new OrchestraStore(join(root, "orchestra.db"));
    const backend = new FakeBackend();
    const manager = new AgentManager(backend, { store });
    const workspace = new WorkspaceManager(store, manager, {
      model: "gpt-6",
      serviceTier: "priority",
    });
    initGitRepo(source);

    const repo = workspace.register(source);
    const agents = await workspace.create(source, {
      runsRoot: runs,
      prompt: "hello agent",
    });

    expect(repo.path).toBe(source);
    expect(agents).toHaveLength(1);
    const agent = agents[0]!;
    expect(agent.id).toMatch(/^[0-9a-f]{4}$/);
    expect(agent.cwd.startsWith(runs)).toBe(true);
    expect(git(agent.cwd, ["branch", "--show-current"])).toBe(`orchestra/${agent.id}`);
    expect(backend.startedThreads[0]?.model).toBe("gpt-6");
    expect(backend.startedThreads[0]?.serviceTier).toBe("priority");
    expect(backend.startedThreads[0]?.approvalPolicy).toBe("never");
    expect(backend.startedThreads[0]?.sandbox).toBe("danger-full-access");
    expect(store.getManagedAgent(agent.id)?.activeTurnId).toBe("turn-1");
    expect(backend.startedTurns[0]?.input).toBe("hello agent");

    store.close();
  });

  test("runs completion hook when a managed turn completes", async () => {
    const root = tempRoot();
    const source = join(root, "source");
    const runs = join(root, "runs");
    const done = join(root, "done");
    const store = new OrchestraStore(join(root, "orchestra.db"));
    const backend = new FakeBackend();
    const manager = new AgentManager(backend, { store });
    const workspace = new WorkspaceManager(store, manager);
    initGitRepo(source);

    const agents = await workspace.create(source, {
      runsRoot: runs,
      prompt: "hello agent",
      onComplete: `mkdir -p ${done} && touch ${done}/{id}`,
    });
    const agent = agents[0]!;
    backend.notifications.emit({
      method: "turn/completed",
      params: { threadId: agent.threadId, turn: { id: agent.activeTurnId, status: "completed" } },
    });

    await waitFor(() => existsSync(join(done, agent.id)));

    store.close();
  });

  test("tears down agents by repo folder name after source repo is deleted", async () => {
    const root = tempRoot();
    const source = join(root, "bh-tournament");
    const runs = join(root, "runs");
    const store = new OrchestraStore(join(root, "orchestra.db"));
    const backend = new FakeBackend();
    const manager = new AgentManager(backend, { store });
    const workspace = new WorkspaceManager(store, manager);
    initGitRepo(source);

    const agents = await workspace.create(source, {
      runsRoot: runs,
      prompt: "hello agent",
    });
    const agent = agents[0]!;
    rmSync(source, { recursive: true, force: true });

    const removed = await workspace.teardownTarget("bh-tournament");

    expect(removed.map((candidate) => candidate.id)).toEqual([agent.id]);
    expect(store.getManagedAgent(agent.id)).toBeUndefined();
    expect(existsSync(agent.cwd)).toBe(false);

    store.close();
  });
});

class FakeBackend implements CodexBackend {
  notifications = new EventBus<BackendNotification>();
  requests = new EventBus<BackendServerRequest>();
  startedThreads: Array<{
    cwd?: string | undefined;
    model?: string | undefined;
    serviceTier?: string | undefined;
    approvalPolicy?: string | undefined;
    sandbox?: string | undefined;
  }> = [];
  startedTurns: Array<{ threadId: string; input: string; model?: string | undefined; serviceTier?: string | undefined }> = [];
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
  async startThread(options: {
    cwd?: string | undefined;
    model?: string | undefined;
    serviceTier?: string | undefined;
    approvalPolicy?: string | undefined;
    sandbox?: string | undefined;
  }) {
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
  async startTurn(threadId: string, input: string, options: { model?: string | undefined; serviceTier?: string | undefined } = {}) {
    this.startedTurns.push({ threadId, input, model: options.model, serviceTier: options.serviceTier });
    return { turn: { id: `turn-${this.startedTurns.length}`, status: "inProgress" } };
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
  async readRateLimits() {
    return {};
  }
  async respond(_requestId: string | number, _result: Json) {}
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "orchestra-test-"));
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

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Bun.sleep(20);
  }
  throw new Error("timed out waiting for predicate");
}
