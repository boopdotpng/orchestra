import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
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

type AgentDiffStats = {
  id: string;
  additions: number;
  deletions: number;
  files: string[];
  surfaces: string[];
};

type CreateSource = {
  repo: RepoRegistration;
  sourcePath: string;
  baseCommit: string;
  parentAgentId?: string | undefined;
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
    const source = this.resolveCreateSource(dir);
    const count = options.count ?? 1;
    const agents: ManagedAgent[] = [];
    for (let index = 0; index < count; index += 1) {
      const agent = await this.createOne(source, options);
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
    return this.withDiffIndex(agent.cwd, (env) => {
      const baseCommit = agent.baseCommit ?? git(agent.cwd, ["merge-base", "HEAD", agent.branch]);
      return git(agent.cwd, ["diff", baseCommit], { allowFailure: true, env });
    });
  }

  diffAgents(ids: string[]): string {
    const normalized = ids.map((id) => id.trim().toLowerCase()).filter(Boolean);
    if (normalized.length === 0) {
      throw new Error("at least one agent id is required");
    }
    if (normalized.length === 1) {
      return this.diff(normalized[0]!);
    }

    const stats = normalized.map((id) => this.diffStats(id));
    const fileOwners = new Map<string, string[]>();
    for (const agent of stats) {
      for (const file of agent.files) {
        const owners = fileOwners.get(file) ?? [];
        owners.push(agent.id);
        fileOwners.set(file, owners);
      }
    }
    const overlaps = [...fileOwners.entries()]
      .filter(([, owners]) => owners.length > 1)
      .sort(([left], [right]) => left.localeCompare(right));

    return [
      `Compared ${stats.length} agents against their Orchestra baselines.`,
      "",
      "summary:",
      ...stats.map((agent) => `  ${agent.id}: +${agent.additions} -${agent.deletions}, ${plural(agent.files.length, "file")}, ${surfaceSummary(agent.surfaces)}`),
      "",
      "changed file overlap:",
      ...(overlaps.length ? overlaps.map(([file, owners]) => `  ${file}: ${owners.join(", ")}`) : ["  none"]),
      "",
      "unique files:",
      ...stats.flatMap((agent) => {
        const unique = agent.files.filter((file) => fileOwners.get(file)?.length === 1);
        return [`  ${agent.id}:`, ...(unique.length ? unique.map((file) => `    ${file}`) : ["    none"])];
      }),
    ].join("\n");
  }

  standouts(): string {
    const summaries = this.store.listManagedAgentSummaries();
    const stats = summaries.map((agent) => ({ agent, stats: this.diffStats(agent.id) }));
    const byCodeWritten = [...stats].sort((left, right) => right.stats.additions - left.stats.additions || left.agent.id.localeCompare(right.agent.id));
    const finished = [...stats]
      .filter(({ agent }) => agent.status === "idle" || agent.status === "error")
      .sort((left, right) => (right.agent.lastActivityAt ?? right.agent.createdAt * 1000) - (left.agent.lastActivityAt ?? left.agent.createdAt * 1000));
    const bySurface = [...stats].sort(
      (left, right) => right.stats.surfaces.length - left.stats.surfaces.length || right.stats.files.length - left.stats.files.length || left.agent.id.localeCompare(right.agent.id),
    );

    return [
      "Standouts are mechanical signals, not quality scores.",
      "",
      "most code written:",
      ...top3(byCodeWritten).map(({ stats }) => `  ${stats.id}: +${stats.additions} -${stats.deletions}, ${plural(stats.files.length, "file")}`),
      "",
      "finished last:",
      ...(finished.length ? top3(finished).map(({ agent }) => `  ${agent.id}: ${agent.status}, ${formatTimestamp(agent.lastActivityAt ?? agent.createdAt * 1000)}`) : ["  none"]),
      "",
      "broadest surface area:",
      ...top3(bySurface).map(({ stats }) => `  ${stats.id}: ${plural(stats.surfaces.length, "surface")}, ${surfaceSummary(stats.surfaces)}`),
    ].join("\n");
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

  private resolveCreateSource(dir: string): CreateSource {
    const sourcePath = gitRoot(dir);
    const baseCommit = git(sourcePath, ["rev-parse", "HEAD"]);
    const baseBranch = git(sourcePath, ["branch", "--show-current"]) || "HEAD";
    const parentAgent = this.findContainingAgent(sourcePath);
    if (parentAgent?.repoPath) {
      const repo = this.store.getRepoByPath(parentAgent.repoPath);
      if (repo) {
        return {
          repo,
          sourcePath,
          baseCommit,
          parentAgentId: parentAgent.id,
        };
      }
    }
    return {
      repo: this.store.upsertRepo({
        path: sourcePath,
        baseCommit,
        baseBranch,
      }),
      sourcePath,
      baseCommit,
    };
  }

  private findContainingAgent(sourcePath: string): ManagedAgent | undefined {
    const normalizedSource = resolve(sourcePath);
    return this.store
      .listManagedAgents()
      .filter((agent) => isSameOrChildPath(resolve(agent.cwd), normalizedSource))
      .sort((left, right) => right.cwd.length - left.cwd.length)[0];
  }

  private async createOne(source: CreateSource, options: CreateAgentsOptions): Promise<ManagedAgent> {
    const id = uniqueAgentId((candidate) => !this.store.getManagedAgent(candidate));
    const runsRoot = expandHome(options.runsRoot ?? process.env.ORCHESTRA_RUNS ?? join(homedir(), ".orchestra", "runs"));
    const cwd = join(runsRoot, basename(source.repo.path), id);
    mkdirSync(dirname(cwd), { recursive: true });
    copyReflink(source.sourcePath, cwd);
    git(cwd, ["switch", "-c", `orchestra/${id}`, source.baseCommit]);
    const orchestraBaseCommit = createOrchestraBaseCommit(cwd);

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
      repoId: source.repo.id,
      repoPath: source.repo.path,
      baseCommit: orchestraBaseCommit,
      sourcePath: source.sourcePath,
      parentAgentId: source.parentAgentId,
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

  private diffStats(id: string): AgentDiffStats {
    const agent = this.requiredAgent(id);
    return this.withDiffIndex(agent.cwd, (env) => {
      const baseCommit = agent.baseCommit ?? git(agent.cwd, ["merge-base", "HEAD", agent.branch]);
      const output = git(agent.cwd, ["diff", "--numstat", baseCommit], { allowFailure: true, env });
      const files: string[] = [];
      let additions = 0;
      let deletions = 0;
      for (const line of output.split("\n").filter(Boolean)) {
        const [added, deleted, ...pathParts] = line.split("\t");
        const path = pathParts.join("\t");
        if (!path) {
          continue;
        }
        files.push(path);
        additions += parseNumstatCount(added);
        deletions += parseNumstatCount(deleted);
      }
      return {
        id: agent.id,
        additions,
        deletions,
        files: files.sort((left, right) => left.localeCompare(right)),
        surfaces: [...new Set(files.map(surfaceForFile))].sort((left, right) => left.localeCompare(right)),
      };
    });
  }

  private withDiffIndex<T>(cwd: string, callback: (env: Record<string, string | undefined>) => T): T {
    const tmp = mkdtempSync(join(tmpdir(), "orchestra-diff-"));
    const tempIndex = join(tmp, "index");
    const env = { ...process.env, GIT_INDEX_FILE: tempIndex };
    try {
      const indexPath = gitPath(cwd, "index");
      if (existsSync(indexPath)) {
        copyFileSync(indexPath, tempIndex);
      } else {
        git(cwd, ["read-tree", "HEAD"], { env });
      }
      const untracked = git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"], { trim: false, env });
      const files = untracked.split("\0").filter(Boolean);
      if (files.length > 0) {
        git(cwd, ["add", "-N", "--", ...files], { env });
      }
      return callback(env);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
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

function isSameOrChildPath(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

function git(cwd: string, args: string[], options: { allowFailure?: boolean; trim?: boolean; env?: Record<string, string | undefined> } = {}): string {
  const spawnOptions: { cwd: string; stdout: "pipe"; stderr: "pipe"; env?: Record<string, string | undefined> } = {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  };
  if (options.env) {
    spawnOptions.env = options.env;
  }
  const proc = Bun.spawnSync(["git", ...args], spawnOptions);
  const rawOutput = proc.stdout.toString();
  const output = options.trim === false ? rawOutput : rawOutput.trim();
  if (proc.exitCode !== 0 && !options.allowFailure) {
    throw new Error(proc.stderr.toString().trim() || `git ${args.join(" ")} failed`);
  }
  return proc.exitCode === 0 ? output : `${output}${proc.stderr.toString()}`;
}

function gitPath(cwd: string, path: string): string {
  const value = git(cwd, ["rev-parse", "--git-path", path]);
  return isAbsolute(value) ? value : join(cwd, value);
}

function createOrchestraBaseCommit(cwd: string): string {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Orchestra",
    GIT_AUTHOR_EMAIL: "orchestra@example.invalid",
    GIT_COMMITTER_NAME: "Orchestra",
    GIT_COMMITTER_EMAIL: "orchestra@example.invalid",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
  };
  git(cwd, ["add", "-A"], { env });
  git(cwd, ["commit", "--allow-empty", "--no-gpg-sign", "-m", "orchestra base commit"], { env });
  return git(cwd, ["rev-parse", "HEAD"]);
}

function parseNumstatCount(value: string | undefined): number {
  return value && /^\d+$/.test(value) ? Number(value) : 0;
}

function surfaceForFile(path: string): string {
  const [first, second] = path.split("/");
  return second ? `${first}/` : path;
}

function surfaceSummary(surfaces: string[]): string {
  return surfaces.length ? surfaces.join(", ") : "no changed surfaces";
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function top3<T>(values: T[]): T[] {
  return values.slice(0, 3);
}

function formatTimestamp(ms: number): string {
  return new Date(ms).toISOString();
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
