import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  test("registers a repo and creates an isolated branched agent workspace", async () => {
    const root = tempRoot();
    const source = join(root, "source");
    const runs = join(root, "runs");
    const store = new OrchestraStore(join(root, "orchestra.db"));
    const backend = new FakeBackend();
    const manager = new AgentManager(backend, { store });
    const workspace = new WorkspaceManager(store, manager, {
      model: "gpt-6",
      serviceTier: "priority",
      reasoningEffort: "high",
    });
    initGitRepo(source);

    const repo = workspace.register(source);
    const agents = await workspace.create(source, {
      workspaceName: "source cleanup",
      runsRoot: runs,
      prompt: "hello agent",
    });

    expect(repo.path).toBe(source);
    expect(agents).toHaveLength(1);
    const agent = agents[0]!;
    expect(agent.id).toMatch(/^[0-9a-f]{4}$/);
    expect(agent.workspaceName).toBe("source cleanup");
    expect(agent.cwd.startsWith(runs)).toBe(true);
    expect(git(agent.cwd, ["branch", "--show-current"])).toBe(`orchestra/${agent.id}`);
    expect(backend.startedThreads[0]?.model).toBe("gpt-6");
    expect(backend.startedThreads[0]?.serviceTier).toBe("priority");
    expect(backend.startedThreads[0]?.reasoningEffort).toBe("high");
    expect(backend.startedThreads[0]?.approvalPolicy).toBe("never");
    expect(backend.startedThreads[0]?.sandbox).toBe("danger-full-access");
    expect(backend.threadNames[0]).toEqual({ threadId: "thread-1", name: "source cleanup" });
    expect(store.getManagedAgent(agent.id)?.activeTurnId).toBe("turn-1");
    expect(backend.startedTurns[0]?.input).toBe("hello agent");

    store.close();
  });

  test("creates focused agents from shared prompt and per-agent focus", async () => {
    const root = tempRoot();
    const source = join(root, "source");
    const runs = join(root, "runs");
    const store = new OrchestraStore(join(root, "orchestra.db"));
    const backend = new FakeBackend();
    const manager = new AgentManager(backend, { store });
    const workspace = new WorkspaceManager(store, manager);
    initGitRepo(source);

    const agents = await workspace.create(source, {
      workspaceName: "focused pass",
      runsRoot: runs,
      sharedPrompt: "Shared context",
      promptTemplate: "{sharedPrompt}\n\nAgent {index}/{count}\nWorkspace {workspace}\nBranch {branch}\nCWD {cwd}\nFocus: {focus}",
      agents: [{ focus: "Fix reg 4" }, { focus: "Add tracepoints" }],
    });

    expect(agents).toHaveLength(2);
    expect(agents.every((agent) => agent.workspaceName === "focused pass")).toBe(true);
    const turnsByThread = new Map(backend.startedTurns.map((turn) => [turn.threadId, turn.input]));
    expect(turnsByThread.get(agents[0]!.threadId)).toBe(
      `Shared context\n\nAgent 1/2\nWorkspace focused pass\nBranch orchestra/${agents[0]!.id}\nCWD ${agents[0]!.cwd}\nFocus: Fix reg 4`,
    );
    expect(turnsByThread.get(agents[1]!.threadId)).toBe(
      `Shared context\n\nAgent 2/2\nWorkspace focused pass\nBranch orchestra/${agents[1]!.id}\nCWD ${agents[1]!.cwd}\nFocus: Add tracepoints`,
    );

    store.close();
  });

  test("creates multiple agents with bounded concurrency", async () => {
    const root = tempRoot();
    const source = join(root, "source");
    const runs = join(root, "runs");
    const store = new OrchestraStore(join(root, "orchestra.db"));
    const backend = new FakeBackend();
    backend.startThreadDelayMs = 30;
    const manager = new AgentManager(backend, { store });
    const workspace = new WorkspaceManager(store, manager);
    initGitRepo(source);

    const agents = await workspace.create(source, {
      workspaceName: "parallel create",
      runsRoot: runs,
      count: 4,
      concurrency: 2,
      prompt: "hello agent",
    });

    expect(agents).toHaveLength(4);
    expect(new Set(agents.map((agent) => agent.id)).size).toBe(4);
    expect(backend.maxConcurrentStartThreads).toBe(2);
    expect(agents.every((agent) => existsSync(agent.cwd))).toBe(true);

    store.close();
  });

  test("broadcast steers target agents concurrently", async () => {
    const root = tempRoot();
    const source = join(root, "source");
    const runs = join(root, "runs");
    const store = new OrchestraStore(join(root, "orchestra.db"));
    const backend = new FakeBackend();
    backend.steerDelayMs = 30;
    const manager = new AgentManager(backend, { store });
    const workspace = new WorkspaceManager(store, manager);
    initGitRepo(source);

    const agents = await workspace.create(source, {
      workspaceName: "broadcast test",
      runsRoot: runs,
      count: 3,
      prompt: "hello agent",
    });

    const response = await workspace.broadcast("shared update", { workspaceName: "broadcast test" });

    expect(response.results.every((result) => result.ok)).toBe(true);
    expect(backend.steeredTurns.map((turn) => turn.input)).toEqual(["shared update", "shared update", "shared update"]);
    expect(backend.maxConcurrentSteers).toBe(3);
    expect(response.results.map((result) => result.id)).toEqual(agents.map((agent) => agent.id));

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
      workspaceName: "completion hook",
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

  test("creates from the latest source HEAD while preserving dirty working tree state", async () => {
    const root = tempRoot();
    const source = join(root, "source");
    const runs = join(root, "runs");
    const store = new OrchestraStore(join(root, "orchestra.db"));
    const backend = new FakeBackend();
    const manager = new AgentManager(backend, { store });
    const workspace = new WorkspaceManager(store, manager);
    initGitRepo(source);

    const firstBase = workspace.register(source).baseCommit;
    writeFileSync(join(source, "README.md"), "# test\n\ncommitted update\n");
    git(source, ["add", "README.md"]);
    git(source, ["commit", "-m", "update readme"]);
    const latestBase = git(source, ["rev-parse", "HEAD"]);
    expect(latestBase).not.toBe(firstBase);
    writeFileSync(join(source, "README.md"), "# test\n\ncommitted update\n\nlocal edit\n");
    writeFileSync(join(source, "scratch.txt"), "local scratch\n");

    const agents = await workspace.create(source, {
      workspaceName: "dirty tree",
      runsRoot: runs,
      prompt: "hello agent",
    });

    const agent = agents[0]!;
    expect(agent.baseCommit).toBeDefined();
    expect(agent.baseCommit).not.toBe(latestBase);
    expect(git(agent.cwd, ["rev-parse", "HEAD"])).toBe(agent.baseCommit!);
    expect(git(agent.cwd, ["rev-parse", "HEAD^"])).toBe(latestBase);
    expect(git(agent.cwd, ["branch", "--show-current"])).toBe(`orchestra/${agent.id}`);
    expect(readFileSync(join(agent.cwd, "README.md"), "utf8")).toContain("local edit");
    expect(readFileSync(join(agent.cwd, "scratch.txt"), "utf8")).toBe("local scratch\n");
    expect(workspace.diff(agent.id)).toBe("");

    store.close();
  });

  test("diff includes tracked and non-ignored untracked worktree changes without mutating the index", async () => {
    const root = tempRoot();
    const source = join(root, "source");
    const runs = join(root, "runs");
    const store = new OrchestraStore(join(root, "orchestra.db"));
    const backend = new FakeBackend();
    const manager = new AgentManager(backend, { store });
    const workspace = new WorkspaceManager(store, manager);
    initGitRepo(source);

    const [agent] = await workspace.create(source, {
      workspaceName: "diff test",
      runsRoot: runs,
      prompt: "hello agent",
    });
    expect(agent).toBeDefined();
    writeFileSync(join(agent!.cwd, "README.md"), "# test\n\nagent edit\n");
    writeFileSync(join(agent!.cwd, "new-file.txt"), "new file\n");
    writeFileSync(join(agent!.cwd, ".gitignore"), "*.log\n");
    writeFileSync(join(agent!.cwd, "ignored.log"), "ignored\n");
    const statusBefore = git(agent!.cwd, ["status", "--porcelain"]);

    const diff = workspace.diff(agent!.id);

    expect(diff).toContain("diff --git a/README.md b/README.md");
    expect(diff).toContain("diff --git a/new-file.txt b/new-file.txt");
    expect(diff).toContain("diff --git a/.gitignore b/.gitignore");
    expect(diff).not.toContain("ignored.log");
    expect(git(agent!.cwd, ["status", "--porcelain"])).toBe(statusBefore);

    store.close();
  });

  test("diffAgents compares multiple agent diffs instead of dumping patches", async () => {
    const root = tempRoot();
    const source = join(root, "source");
    const runs = join(root, "runs");
    const store = new OrchestraStore(join(root, "orchestra.db"));
    const backend = new FakeBackend();
    const manager = new AgentManager(backend, { store });
    const workspace = new WorkspaceManager(store, manager);
    initGitRepo(source);

    const agents = await workspace.create(source, {
      workspaceName: "compare diffs",
      count: 2,
      runsRoot: runs,
      prompt: "hello agent",
    });
    const [left, right] = agents;
    expect(left).toBeDefined();
    expect(right).toBeDefined();
    writeFileSync(join(left!.cwd, "README.md"), "# test\n\nleft edit\n");
    mkdirSync(join(left!.cwd, "src"));
    writeFileSync(join(left!.cwd, "src", "left.ts"), "export const left = true;\n");
    writeFileSync(join(right!.cwd, "README.md"), "# test\n\nright edit\n");
    mkdirSync(join(right!.cwd, "docs"));
    writeFileSync(join(right!.cwd, "docs", "right.md"), "right docs\n");

    const text = workspace.diffAgents([left!.id, right!.id]);

    expect(text).toContain(`Compared 2 agents`);
    expect(text).toContain(`${left!.id}: +`);
    expect(text).toContain(`${right!.id}: +`);
    expect(text).toContain("README.md: ");
    expect(text).toContain(`${left!.id}, ${right!.id}`);
    expect(text).toContain("unique files:");
    expect(text).toContain("src/left.ts");
    expect(text).toContain("docs/right.md");
    expect(text).not.toContain("diff --git");

    store.close();
  });

  test("standouts reports top mechanical markers", async () => {
    const root = tempRoot();
    const source = join(root, "source");
    const runs = join(root, "runs");
    const store = new OrchestraStore(join(root, "orchestra.db"));
    const backend = new FakeBackend();
    const manager = new AgentManager(backend, { store });
    const workspace = new WorkspaceManager(store, manager);
    initGitRepo(source);

    const agents = await workspace.create(source, {
      workspaceName: "standouts",
      count: 3,
      runsRoot: runs,
      prompt: "hello agent",
    });
    const [code, middle, broad] = agents;
    expect(code).toBeDefined();
    expect(middle).toBeDefined();
    expect(broad).toBeDefined();

    mkdirSync(join(code!.cwd, "src"));
    writeFileSync(join(code!.cwd, "src", "code.ts"), Array.from({ length: 8 }, (_, index) => `export const v${index} = ${index};`).join("\n") + "\n");
    mkdirSync(join(middle!.cwd, "docs"));
    writeFileSync(join(middle!.cwd, "docs", "note.md"), "note\n");
    for (const dir of ["src", "test", "docs"]) {
      mkdirSync(join(broad!.cwd, dir));
      writeFileSync(join(broad!.cwd, dir, `${dir}.txt`), `${dir}\n`);
    }

    backend.notifications.emit({
      method: "turn/completed",
      params: { threadId: code!.threadId, turn: { id: code!.activeTurnId, status: "completed" } },
    });
    await Bun.sleep(5);
    backend.notifications.emit({
      method: "turn/completed",
      params: { threadId: middle!.threadId, turn: { id: middle!.activeTurnId, status: "completed" } },
    });
    await Bun.sleep(5);
    backend.notifications.emit({
      method: "turn/completed",
      params: { threadId: broad!.threadId, turn: { id: broad!.activeTurnId, status: "completed" } },
    });
    const [other] = await workspace.create(source, {
      workspaceName: "other standouts",
      count: 1,
      runsRoot: runs,
      prompt: "hello other agent",
    });
    expect(other).toBeDefined();
    mkdirSync(join(other!.cwd, "src"));
    writeFileSync(join(other!.cwd, "src", "other.ts"), Array.from({ length: 20 }, (_, index) => `export const other${index} = ${index};`).join("\n") + "\n");

    const text = workspace.standouts("standouts");

    expect(text).toContain("Standouts are mechanical signals");
    expect(text).toContain(`most code written:\n  ${code!.id}: +8 -0`);
    expect(text).toContain(`finished last:\n  ${broad!.id}: idle`);
    expect(text).toContain(`broadest surface area:\n  ${broad!.id}: 3 surfaces`);
    expect(text).not.toContain(other!.id);
    expect(workspace.standouts("missing")).toBe("no agents matching workspace missing");

    store.close();
  });

  test("tracks agents created from managed workspaces as nested children of the original repo", async () => {
    const root = tempRoot();
    const source = join(root, "blackhole-py");
    const runs = join(root, "runs");
    const store = new OrchestraStore(join(root, "orchestra.db"));
    const backend = new FakeBackend();
    const manager = new AgentManager(backend, { store });
    const workspace = new WorkspaceManager(store, manager);
    initGitRepo(source);

    const [parent] = await workspace.create(source, {
      workspaceName: "parent workspace",
      runsRoot: runs,
      prompt: "parent agent",
    });
    expect(parent).toBeDefined();
    writeFileSync(join(parent!.cwd, "README.md"), "# test\n\nparent commit\n");
    git(parent!.cwd, ["add", "README.md"]);
    git(parent!.cwd, ["commit", "-m", "parent workspace commit"]);
    const parentHead = git(parent!.cwd, ["rev-parse", "HEAD"]);

    const [child] = await workspace.create(parent!.cwd, {
      workspaceName: "child workspace",
      runsRoot: runs,
      prompt: "child agent",
    });

    expect(child).toBeDefined();
    expect(child!.repoPath).toBe(source);
    expect(child!.sourcePath).toBe(parent!.cwd);
    expect(child!.parentAgentId).toBe(parent!.id);
    expect(child!.baseCommit).not.toBe(parentHead);
    expect(git(child!.cwd, ["rev-parse", "HEAD^"])).toBe(parentHead);
    expect(child!.cwd.startsWith(join(runs, "blackhole-py"))).toBe(true);
    expect(readFileSync(join(child!.cwd, "README.md"), "utf8")).toContain("parent commit");
    expect(store.listManagedAgentsForRepo(parent!.repoId).map((agent) => agent.id).sort()).toEqual([child!.id, parent!.id].sort());

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
      workspaceName: "teardown",
      runsRoot: runs,
      prompt: "hello agent",
    });
    const agent = agents[0]!;
    rmSync(source, { recursive: true, force: true });

    const removed = await workspace.teardownTarget("bh-tournament");

    expect(removed.map((candidate) => candidate.id)).toEqual([agent.id]);
    expect(store.getManagedAgent(agent.id)).toBeUndefined();
    expect(existsSync(agent.cwd)).toBe(false);
    expect(existsSync(join(runs, "bh-tournament"))).toBe(false);
    expect(existsSync(runs)).toBe(false);

    store.close();
  });

  test("tears down only agents with the matching workspace name", async () => {
    const root = tempRoot();
    const source = join(root, "blackhole-py");
    const runs = join(root, "runs");
    const store = new OrchestraStore(join(root, "orchestra.db"));
    const backend = new FakeBackend();
    const manager = new AgentManager(backend, { store });
    const workspace = new WorkspaceManager(store, manager);
    initGitRepo(source);

    const target = await workspace.create(source, {
      workspaceName: "blackhole-py",
      runsRoot: runs,
      prompt: "hello agent",
    });
    const other = await workspace.create(source, {
      workspaceName: "trace work",
      runsRoot: runs,
      prompt: "hello agent",
    });

    const removed = await workspace.teardownWorkspace("BLACKHOLE-PY");

    expect(removed.map((candidate) => candidate.id)).toEqual(target.map((agent) => agent.id));
    expect(store.getManagedAgent(target[0]!.id)).toBeUndefined();
    expect(store.getManagedAgent(other[0]!.id)).toBeDefined();
    expect(existsSync(target[0]!.cwd)).toBe(false);
    expect(existsSync(other[0]!.cwd)).toBe(true);

    store.close();
  });

  test("tears down selected agents by id", async () => {
    const root = tempRoot();
    const source = join(root, "blackhole-py");
    const runs = join(root, "runs");
    const store = new OrchestraStore(join(root, "orchestra.db"));
    const backend = new FakeBackend();
    const manager = new AgentManager(backend, { store });
    const workspace = new WorkspaceManager(store, manager);
    initGitRepo(source);

    const agents = await workspace.create(source, {
      workspaceName: "blackhole-py",
      runsRoot: runs,
      count: 3,
      prompt: "hello agent",
    });

    const removed = await workspace.teardownAgents([agents[0]!.id.toUpperCase(), agents[1]!.id, agents[0]!.id]);

    expect(removed.map((candidate) => candidate.id)).toEqual([agents[0]!.id, agents[1]!.id]);
    expect(store.getManagedAgent(agents[0]!.id)).toBeUndefined();
    expect(store.getManagedAgent(agents[1]!.id)).toBeUndefined();
    expect(store.getManagedAgent(agents[2]!.id)).toBeDefined();
    expect(existsSync(agents[0]!.cwd)).toBe(false);
    expect(existsSync(agents[1]!.cwd)).toBe(false);
    expect(existsSync(agents[2]!.cwd)).toBe(true);

    store.close();
  });
});

class FakeBackend implements CodexBackend {
  notifications = new EventBus<BackendNotification>();
  requests = new EventBus<BackendServerRequest>();
  startedThreads: Array<{
    cwd?: string | undefined;
    name?: string | undefined;
    model?: string | undefined;
    serviceTier?: string | undefined;
    reasoningEffort?: string | undefined;
    approvalPolicy?: string | undefined;
    sandbox?: string | undefined;
  }> = [];
  threadNames: Array<{ threadId: string; name: string }> = [];
  startedTurns: Array<{ threadId: string; input: string; model?: string | undefined; serviceTier?: string | undefined; reasoningEffort?: string | undefined }> = [];
  steeredTurns: Array<{ threadId: string; turnId: string; input: string }> = [];
  startThreadDelayMs = 0;
  steerDelayMs = 0;
  private concurrentStartThreads = 0;
  private concurrentSteers = 0;
  maxConcurrentStartThreads = 0;
  maxConcurrentSteers = 0;
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
    name?: string | undefined;
    model?: string | undefined;
    serviceTier?: string | undefined;
    reasoningEffort?: string | undefined;
    approvalPolicy?: string | undefined;
    sandbox?: string | undefined;
  }) {
    this.concurrentStartThreads += 1;
    this.maxConcurrentStartThreads = Math.max(this.maxConcurrentStartThreads, this.concurrentStartThreads);
    try {
      if (this.startThreadDelayMs > 0) {
        await Bun.sleep(this.startThreadDelayMs);
      }
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
    } finally {
      this.concurrentStartThreads -= 1;
    }
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
  async setThreadName(threadId: string, name: string) {
    this.threadNames.push({ threadId, name });
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
  async startTurn(threadId: string, input: string, options: { model?: string | undefined; serviceTier?: string | undefined; reasoningEffort?: string | undefined } = {}) {
    this.startedTurns.push({ threadId, input, model: options.model, serviceTier: options.serviceTier, reasoningEffort: options.reasoningEffort });
    return { turn: { id: `turn-${this.startedTurns.length}`, status: "inProgress" } };
  }
  async steerTurn(threadId: string, turnId: string, input: string) {
    this.concurrentSteers += 1;
    this.maxConcurrentSteers = Math.max(this.maxConcurrentSteers, this.concurrentSteers);
    try {
      if (this.steerDelayMs > 0) {
        await Bun.sleep(this.steerDelayMs);
      }
      this.steeredTurns.push({ threadId, turnId, input });
      return {};
    } finally {
      this.concurrentSteers -= 1;
    }
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
