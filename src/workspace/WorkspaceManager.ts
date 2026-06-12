import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { AgentManager } from "../manager/AgentManager";
import { DEFAULT_MODEL, DEFAULT_SERVICE_TIER } from "../config";
import type { ManagedAgent, RepoRegistration, StartAgentOptions } from "../domain/types";
import { OrchestraStore } from "../store/OrchestraStore";

export type WorkspaceManagerOptions = {
  runsRoot?: string | undefined;
  model?: string | undefined;
  serviceTier?: StartAgentOptions["serviceTier"] | undefined;
  approvalPolicy?: StartAgentOptions["approvalPolicy"] | undefined;
  sandbox?: StartAgentOptions["sandbox"] | undefined;
};

export type CreateAgentsOptions = WorkspaceManagerOptions & {
  count?: number | undefined;
  prompt: string;
  onComplete?: string | undefined;
};

export class WorkspaceManager {
  constructor(
    private readonly store: OrchestraStore,
    private readonly manager: AgentManager,
    private defaults: Pick<WorkspaceManagerOptions, "model" | "serviceTier"> = {},
  ) {
    manager.onEvent((event) => {
      if (event.type === "turn.completed") {
        this.runCompletionHook(event.threadId);
      }
    });
  }

  updateDefaults(defaults: Pick<WorkspaceManagerOptions, "model" | "serviceTier">): void {
    this.defaults = defaults;
  }

  register(dir: string): RepoRegistration {
    const repoPath = gitRoot(dir);
    return this.store.upsertRepo({
      path: repoPath,
      baseCommit: git(repoPath, ["rev-parse", "HEAD"]),
      baseBranch: git(repoPath, ["branch", "--show-current"]) || "HEAD",
    });
  }

  async create(dir: string, options: CreateAgentsOptions): Promise<ManagedAgent[]> {
    const repo = this.register(dir);
    const count = options.count ?? 1;
    const agents: ManagedAgent[] = [];
    for (let index = 0; index < count; index += 1) {
      const agent = await this.createOne(repo, options);
      agents.push(agent);
    }
    return agents;
  }

  async steer(id: string, input: string, options: WorkspaceManagerOptions = {}) {
    const agent = this.requiredAgent(id);
    const turn =
      agent.status === "running" && agent.activeTurnId
        ? await this.manager.steer(agent.threadId, agent.activeTurnId, input)
        : await this.manager.send(agent.threadId, input, {
            cwd: agent.cwd,
            model: options.model ?? this.defaults.model ?? DEFAULT_MODEL,
            serviceTier: options.serviceTier ?? this.defaults.serviceTier ?? DEFAULT_SERVICE_TIER,
            approvalPolicy: options.approvalPolicy,
            sandbox: options.sandbox,
            personality: "friendly",
          });
    return turn;
  }

  async interrupt(id: string) {
    const agent = this.requiredAgent(id);
    return this.manager.interrupt(agent.threadId, agent.activeTurnId);
  }

  diff(id: string): string {
    const agent = this.requiredAgent(id);
    const baseCommit = agent.baseCommit ?? git(agent.cwd, ["merge-base", "HEAD", agent.branch]);
    return git(agent.cwd, ["diff", `${baseCommit}..HEAD`], { allowFailure: true });
  }

  exec(id: string, command: string): { exitCode: number; output: string } {
    const agent = this.requiredAgent(id);
    const proc = Bun.spawnSync(["bash", "-lc", command], {
      cwd: agent.cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: proc.exitCode,
      output: `${proc.stdout.toString()}${proc.stderr.toString()}`,
    };
  }

  readTranscript(id: string, asJson = false): string {
    const agent = this.requiredAgent(id);
    const events = this.store.listEvents(agent.threadId, 1000);
    const dir = join("/tmp", "orchestra");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${id}-${events.length}.${asJson ? "json" : "md"}`);
    if (asJson) {
      writeFileSync(path, JSON.stringify({ agent, events }, null, 2));
    } else {
      writeFileSync(path, transcriptMarkdown(agent, events));
    }
    return path;
  }

  async readThread(id: string): Promise<unknown> {
    const agent = this.requiredAgent(id);
    return this.manager.readThread(agent.threadId);
  }

  history(id: string): unknown {
    const agent = this.requiredAgent(id);
    return {
      agent,
      events: this.store.listEvents(agent.threadId),
    };
  }

  turn(id: string): unknown {
    const agent = this.requiredAgent(id);
    return {
      agent,
      recent: this.store.listEvents(agent.threadId, 50),
    };
  }

  async teardown(dir: string): Promise<ManagedAgent[]> {
    const repoPath = gitRoot(dir);
    const repo = this.store.getRepoByPath(repoPath);
    if (!repo) {
      return [];
    }
    return this.teardownRepo(repo);
  }

  async teardownTarget(target: string): Promise<ManagedAgent[]> {
    const trimmed = target.trim();
    if (trimmed === "all") {
      const agents = this.store.listManagedAgents();
      for (const agent of agents) {
        await this.remove(agent.id);
      }
      return agents;
    }
    if (/^[0-9a-f]{4}$/i.test(trimmed) && this.store.getManagedAgent(trimmed.toLowerCase())) {
      return [await this.remove(trimmed.toLowerCase())];
    }
    const storedPath = this.store.getRepoByPath(expandHome(trimmed));
    if (storedPath) {
      return this.teardownRepo(storedPath);
    }
    if (isBareRepoName(trimmed)) {
      const matches = this.store.listRepos().filter((repo) => basename(repo.path) === trimmed);
      if (matches.length === 1) {
        return this.teardownRepo(matches[0]!);
      }
      if (matches.length > 1) {
        throw new Error(`ambiguous repo name: ${trimmed} matches ${matches.map((repo) => repo.path).join(", ")}`);
      }
    }
    return this.teardown(trimmed);
  }

  async remove(id: string): Promise<ManagedAgent> {
    const agent = this.requiredAgent(id);
    if (agent.activeTurnId) {
      await this.manager.interrupt(agent.threadId, agent.activeTurnId).catch(() => undefined);
    }
    rmSync(agent.cwd, { recursive: true, force: true });
    this.store.deleteManagedAgent(agent.id);
    return agent;
  }

  requiredAgent(id: string): ManagedAgent {
    const agent = this.store.getManagedAgent(id);
    if (!agent) {
      throw new Error(`unknown agent id: ${id}`);
    }
    return agent;
  }

  private async teardownRepo(repo: RepoRegistration): Promise<ManagedAgent[]> {
    const agents = this.store.listManagedAgentsForRepo(repo.id);
    for (const agent of agents) {
      await this.remove(agent.id);
    }
    return agents;
  }

  private async createOne(repo: RepoRegistration, options: CreateAgentsOptions): Promise<ManagedAgent> {
    const id = uniqueAgentId((candidate) => !this.store.getManagedAgent(candidate));
    const runsRoot = expandHome(options.runsRoot ?? process.env.ORCHESTRA_RUNS ?? join(homedir(), ".orchestra", "runs"));
    const cwd = join(runsRoot, basename(repo.path), id);
    mkdirSync(dirname(cwd), { recursive: true });
    copyReflink(repo.path, cwd);
    git(cwd, ["switch", "-c", `orchestra/${id}`, repo.baseCommit]);

    const thread = await this.manager.startAgent({
      cwd,
      model: options.model ?? this.defaults.model ?? DEFAULT_MODEL,
      serviceTier: options.serviceTier ?? this.defaults.serviceTier ?? DEFAULT_SERVICE_TIER,
      approvalPolicy: options.approvalPolicy ?? "never",
      sandbox: options.sandbox ?? "danger-full-access",
      personality: "friendly",
    });
    const managed: ManagedAgent = {
      id,
      repoId: repo.id,
      repoPath: repo.path,
      baseCommit: repo.baseCommit,
      cwd,
      branch: `orchestra/${id}`,
      threadId: thread.threadId,
      activeTurnId: undefined,
      status: "idle",
      createdAt: Math.floor(Date.now() / 1000),
      onComplete: options.onComplete,
    };
    this.store.insertManagedAgent(managed);
    const turn = await this.manager.startTurn(thread.threadId, options.prompt, {
      cwd,
      model: options.model ?? this.defaults.model ?? DEFAULT_MODEL,
      serviceTier: options.serviceTier ?? this.defaults.serviceTier ?? DEFAULT_SERVICE_TIER,
      approvalPolicy: options.approvalPolicy,
      sandbox: options.sandbox,
      personality: "friendly",
    });
    this.store.insertManagedAgent({ ...managed, activeTurnId: turn.turnId, status: "running" });
    return this.store.getManagedAgent(id) ?? managed;
  }

  private runCompletionHook(threadId: string): void {
    const agent = this.store.listManagedAgents().find((candidate) => candidate.threadId === threadId);
    if (!agent?.onComplete) {
      return;
    }
    const hook = agent.onComplete;
    const value = (input: string) =>
      input
        .replaceAll("<id>", agent.id)
        .replaceAll("{id}", agent.id)
        .replaceAll("$ORCHESTRA_AGENT_ID", agent.id)
        .replaceAll("$ORCHESTRA_THREAD_ID", agent.threadId);
    if (/^https?:\/\//i.test(hook)) {
      void fetch(value(hook), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: agent.id, threadId: agent.threadId, cwd: agent.cwd, status: agent.status }),
      }).catch(() => undefined);
      return;
    }
    void Bun.spawn(["bash", "-lc", value(hook)], {
      cwd: agent.cwd,
      env: {
        ...process.env,
        ORCHESTRA_AGENT_ID: agent.id,
        ORCHESTRA_THREAD_ID: agent.threadId,
        ORCHESTRA_AGENT_CWD: agent.cwd,
      },
      stdout: "ignore",
      stderr: "ignore",
    }).exited.catch(() => undefined);
  }
}

export function readPromptFile(path: string): string {
  return readFileSync(resolve(path), "utf8");
}

export function expandHome(path: string): string {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  return resolve(path);
}

function gitRoot(dir: string): string {
  return git(expandHome(dir), ["rev-parse", "--show-toplevel"]);
}

function isBareRepoName(target: string): boolean {
  return target.length > 0 && target !== "." && target !== ".." && !target.includes("/") && !target.startsWith("~");
}

function git(cwd: string, args: string[], options: { allowFailure?: boolean } = {}): string {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = proc.stdout.toString().trim();
  if (proc.exitCode !== 0 && !options.allowFailure) {
    throw new Error(proc.stderr.toString().trim() || `git ${args.join(" ")} failed`);
  }
  return proc.exitCode === 0 ? output : `${output}${proc.stderr.toString()}`;
}

function copyReflink(source: string, dest: string): void {
  if (existsSync(dest)) {
    throw new Error(`workspace already exists: ${dest}`);
  }
  const args = ["-a", "--reflink=auto", `${source}/.`, dest];
  let proc = Bun.spawnSync(["cp", ...args], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    proc = Bun.spawnSync(["cp", "-a", `${source}/.`, dest], { stdout: "pipe", stderr: "pipe" });
  }
  if (proc.exitCode !== 0) {
    throw new Error(proc.stderr.toString().trim() || `failed to copy ${source}`);
  }
}

function uniqueAgentId(isAvailable: (id: string) => boolean): string {
  for (let attempts = 0; attempts < 1000; attempts += 1) {
    const id = randomBytes(2).toString("hex");
    if (isAvailable(id)) {
      return id;
    }
  }
  throw new Error("could not allocate a unique agent id");
}

function transcriptMarkdown(agent: ManagedAgent, events: unknown[]): string {
  return [
    `# Orchestra Agent ${agent.id}`,
    "",
    `- thread: ${agent.threadId}`,
    `- cwd: ${agent.cwd}`,
    `- branch: ${agent.branch}`,
    "",
    "```json",
    JSON.stringify(events, null, 2),
    "```",
    "",
  ].join("\n");
}
