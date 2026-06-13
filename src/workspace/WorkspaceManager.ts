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
  reasoningEffort?: StartAgentOptions["reasoningEffort"] | undefined;
  approvalPolicy?: StartAgentOptions["approvalPolicy"] | undefined;
  sandbox?: StartAgentOptions["sandbox"] | undefined;
};

export type CreateAgentsOptions = WorkspaceManagerOptions & {
  workspaceName: string;
  count?: number | undefined;
  concurrency?: number | undefined;
  prompt?: string | undefined;
  sharedPrompt?: string | undefined;
  promptTemplate?: string | undefined;
  agents?: CreateAgentPrompt[] | undefined;
  onComplete?: string | undefined;
};

export type CreateAgentPrompt = {
  focus: string;
};

export type BroadcastOptions = WorkspaceManagerOptions & {
  workspaceName?: string | undefined;
  agentIds?: string[] | undefined;
};

export type BroadcastAgentResult =
  | {
      id: string;
      workspaceName: string;
      ok: true;
      result: unknown;
    }
  | {
      id: string;
      workspaceName?: string | undefined;
      ok: false;
      error: string;
    };

export type BroadcastResponse = {
  results: BroadcastAgentResult[];
};

type ResolvedAgentPrompt =
  | {
      type: "prompt";
      prompt: string;
      index: number;
      count: number;
    }
  | {
      type: "focused";
      sharedPrompt: string;
      focus: string;
      promptTemplate?: string | undefined;
      index: number;
      count: number;
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
    private defaults: Pick<WorkspaceManagerOptions, "model" | "serviceTier" | "reasoningEffort"> = {},
  ) {
    manager.onEvent((event) => {
      if (event.type === "turn.completed") {
        this.runCompletionHook(event.threadId);
      }
    });
  }

  updateDefaults(defaults: Pick<WorkspaceManagerOptions, "model" | "serviceTier" | "reasoningEffort">): void {
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
    const workspaceName = options.workspaceName.trim();
    if (!workspaceName) {
      throw new Error("name is required");
    }
    const source = this.resolveCreateSource(dir);
    const prompts = resolveAgentPrompts(options);
    const runsRoot = expandHome(options.runsRoot ?? process.env.ORCHESTRA_RUNS ?? join(homedir(), ".orchestra", "runs"));
    const repoRunsRoot = join(runsRoot, basename(source.repo.path));
    const reservedIds = new Set(this.store.listManagedAgents().map((agent) => agent.id));
    const tasks = prompts.map((prompt) => {
      const id = uniqueAgentId((candidate) => !reservedIds.has(candidate) && !existsSync(join(repoRunsRoot, candidate)));
      reservedIds.add(id);
      return { id, prompt };
    });
    return mapWithConcurrency(tasks, resolveCreateConcurrency(options.concurrency, tasks.length), (task) =>
      this.createOne(source, { ...options, workspaceName }, task.prompt, task.id),
    );
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
            reasoningEffort: options.reasoningEffort ?? this.defaults.reasoningEffort,
            approvalPolicy: options.approvalPolicy,
            sandbox: options.sandbox,
            personality: "friendly",
          });
    return turn;
  }

  async broadcast(input: string, options: BroadcastOptions): Promise<BroadcastResponse> {
    const targets = this.broadcastTargets(options.workspaceName, options.agentIds);
    const results: BroadcastAgentResult[] = [];
    for (const target of targets) {
      if (!target.agent) {
        results.push({ id: target.id, ok: false, error: `unknown agent id: ${target.id}` });
        continue;
      }
      try {
        results.push({
          id: target.agent.id,
          workspaceName: target.agent.workspaceName,
          ok: true,
          result: await this.steer(target.agent.id, input, options),
        });
      } catch (error) {
        results.push({
          id: target.agent.id,
          workspaceName: target.agent.workspaceName,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { results };
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

  standouts(workspaceName?: string | undefined): string {
    const summaries = this.store
      .listManagedAgentSummaries()
      .filter((agent) => workspaceName === undefined || sameWorkspaceName(agent.workspaceName, workspaceName));
    if (!summaries.length) {
      return workspaceName ? `no agents matching workspace ${workspaceName}` : "no agents";
    }
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

  private broadcastTargets(workspaceName?: string, agentIds: string[] = []): Array<{ id: string; agent?: ManagedAgent | undefined }> {
    const workspace = workspaceName?.trim();
    const ids = agentIds.map((id) => id.trim().toLowerCase()).filter(Boolean);
    if (!workspace && !ids.length) {
      throw new Error("broadcast requires workspace or agents");
    }

    const targets = new Map<string, { id: string; agent?: ManagedAgent | undefined }>();
    if (workspace) {
      for (const agent of this.store.listManagedAgents()) {
        if (sameWorkspaceName(agent.workspaceName, workspace)) {
          targets.set(agent.id, { id: agent.id, agent });
        }
      }
    }
    for (const id of ids) {
      if (!targets.has(id)) {
        targets.set(id, { id, agent: this.store.getManagedAgent(id) });
      }
    }
    if (!targets.size) {
      throw new Error(workspace ? `no agents matching workspace ${workspace}` : "no broadcast targets");
    }
    return [...targets.values()];
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

  async teardownWorkspace(workspaceName: string): Promise<ManagedAgent[]> {
    const trimmed = workspaceName.trim();
    if (!trimmed) {
      throw new Error("workspace name is required");
    }
    const agents = this.store.listManagedAgents().filter((agent) => sameWorkspaceName(agent.workspaceName, trimmed));
    for (const agent of agents) {
      await this.remove(agent.id);
    }
    return agents;
  }

  async teardownAgents(agentIds: string[]): Promise<ManagedAgent[]> {
    const ids = [...new Set(agentIds.map((id) => id.trim().toLowerCase()).filter(Boolean))];
    if (!ids.length) {
      throw new Error("agents array is required");
    }
    for (const id of ids) {
      if (!/^[0-9a-f]{4}$/.test(id)) {
        throw new Error(`invalid agent id: ${id}`);
      }
    }
    const agents = ids.map((id) => this.requiredAgent(id));
    for (const agent of agents) {
      await this.remove(agent.id);
    }
    return agents;
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

  private async createOne(source: CreateSource, options: CreateAgentsOptions, promptSpec: ResolvedAgentPrompt, id: string): Promise<ManagedAgent> {
    const runsRoot = expandHome(options.runsRoot ?? process.env.ORCHESTRA_RUNS ?? join(homedir(), ".orchestra", "runs"));
    const cwd = join(runsRoot, basename(source.repo.path), id);
    mkdirSync(dirname(cwd), { recursive: true });
    await copyReflink(source.sourcePath, cwd);
    await asyncGit(cwd, ["switch", "-c", `orchestra/${id}`, source.baseCommit]);
    const orchestraBaseCommit = await createOrchestraBaseCommit(cwd);

    const thread = await this.manager.startAgent({
      cwd,
      name: options.workspaceName,
      model: options.model ?? this.defaults.model ?? DEFAULT_MODEL,
      serviceTier: options.serviceTier ?? this.defaults.serviceTier ?? DEFAULT_SERVICE_TIER,
      reasoningEffort: options.reasoningEffort ?? this.defaults.reasoningEffort,
      approvalPolicy: options.approvalPolicy ?? "never",
      sandbox: options.sandbox ?? "danger-full-access",
      personality: "friendly",
    });
    const managed: ManagedAgent = {
      id,
      repoId: source.repo.id,
      workspaceName: options.workspaceName,
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
    const turn = await this.manager.startTurn(thread.threadId, renderAgentPrompt(promptSpec, { id, cwd, branch: managed.branch, dir: source.sourcePath, workspaceName: options.workspaceName }), {
      cwd,
      model: options.model ?? this.defaults.model ?? DEFAULT_MODEL,
      serviceTier: options.serviceTier ?? this.defaults.serviceTier ?? DEFAULT_SERVICE_TIER,
      reasoningEffort: options.reasoningEffort ?? this.defaults.reasoningEffort,
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

async function createOrchestraBaseCommit(cwd: string): Promise<string> {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Orchestra",
    GIT_AUTHOR_EMAIL: "orchestra@example.invalid",
    GIT_COMMITTER_NAME: "Orchestra",
    GIT_COMMITTER_EMAIL: "orchestra@example.invalid",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
  };
  await asyncGit(cwd, ["add", "-A"], { env });
  await asyncGit(cwd, ["commit", "--allow-empty", "--no-gpg-sign", "-m", "orchestra base commit"], { env });
  return asyncGit(cwd, ["rev-parse", "HEAD"]);
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

function resolveAgentPrompts(options: CreateAgentsOptions): ResolvedAgentPrompt[] {
  if (options.agents !== undefined) {
    if (!Array.isArray(options.agents)) {
      throw new Error("agents must be an array");
    }
    if (!options.agents.length) {
      throw new Error("agents must include at least one entry");
    }
    if (options.prompt !== undefined) {
      throw new Error("prompt cannot be combined with agents");
    }
    if (options.count !== undefined && options.count !== options.agents.length) {
      throw new Error("count must match agents length when agents are provided");
    }
    const sharedPrompt = requiredNonEmpty(options.sharedPrompt, "sharedPrompt");
    return options.agents.map((agent, index) => ({
      type: "focused",
      sharedPrompt,
      focus: requiredNonEmpty(agent.focus, "agents.focus"),
      promptTemplate: options.promptTemplate,
      index,
      count: options.agents!.length,
    }));
  }

  const prompt = requiredNonEmpty(options.prompt, "prompt");
  const count = options.count ?? 1;
  if (!Number.isInteger(count) || count < 1) {
    throw new Error("count must be a positive integer");
  }
  return Array.from({ length: count }, (_, index) => ({
    type: "prompt",
    prompt,
    index,
    count,
  }));
}

function renderAgentPrompt(prompt: ResolvedAgentPrompt, context: { id: string; cwd: string; branch: string; dir: string; workspaceName: string }): string {
  if (prompt.type === "prompt") {
    return prompt.prompt;
  }
  const template = prompt.promptTemplate ?? "{sharedPrompt}\n\nFocus:\n{focus}";
  const values = new Map([
    ["sharedPrompt", prompt.sharedPrompt],
    ["focus", prompt.focus],
    ["index", String(prompt.index + 1)],
    ["count", String(prompt.count)],
    ["workspace", context.workspaceName],
    ["dir", context.dir],
    ["id", context.id],
    ["cwd", context.cwd],
    ["branch", context.branch],
  ]);
  return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match, key: string) => values.get(key) ?? match);
}

function requiredNonEmpty(value: string | undefined, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function sameWorkspaceName(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
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

async function copyReflink(source: string, dest: string): Promise<void> {
  if (existsSync(dest)) {
    throw new Error(`workspace already exists: ${dest}`);
  }
  const args = ["-a", "--reflink=auto", `${source}/.`, dest];
  let result = await run(["cp", ...args], { allowFailure: true });
  if (result.exitCode !== 0) {
    result = await run(["cp", "-a", `${source}/.`, dest], { allowFailure: true });
  }
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `failed to copy ${source}`);
  }
}

async function asyncGit(cwd: string, args: string[], options: { allowFailure?: boolean; trim?: boolean; env?: Record<string, string | undefined> } = {}): Promise<string> {
  const runOptions: { cwd: string; env?: Record<string, string | undefined>; allowFailure?: boolean } = { cwd };
  if (options.env !== undefined) {
    runOptions.env = options.env;
  }
  if (options.allowFailure !== undefined) {
    runOptions.allowFailure = options.allowFailure;
  }
  const result = await run(["git", ...args], runOptions);
  const output = options.trim === false ? result.stdout : result.stdout.trim();
  if (result.exitCode !== 0 && !options.allowFailure) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result.exitCode === 0 ? output : `${output}${result.stderr}`;
}

async function run(
  cmd: string[],
  options: { cwd?: string | undefined; env?: Record<string, string | undefined>; allowFailure?: boolean } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const spawnOptions: { cwd?: string; stdout: "pipe"; stderr: "pipe"; env?: Record<string, string | undefined> } = {
    stdout: "pipe",
    stderr: "pipe",
  };
  if (options.cwd !== undefined) {
    spawnOptions.cwd = options.cwd;
  }
  if (options.env !== undefined) {
    spawnOptions.env = options.env;
  }
  const proc = Bun.spawn(cmd, spawnOptions);
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0 && !options.allowFailure) {
    throw new Error(stderr.trim() || `${cmd.join(" ")} failed`);
  }
  return { exitCode, stdout, stderr };
}

async function mapWithConcurrency<T, U>(values: T[], concurrency: number, mapper: (value: T, index: number) => Promise<U>): Promise<U[]> {
  const results = new Array<U>(values.length);
  let next = 0;
  const workerCount = Math.min(concurrency, values.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= values.length) {
          return;
        }
        results[index] = await mapper(values[index]!, index);
      }
    }),
  );
  return results;
}

function resolveCreateConcurrency(value: number | undefined, count: number): number {
  const raw = value ?? numberFromEnv(process.env.ORCHESTRA_CREATE_CONCURRENCY) ?? 8;
  if (!Number.isFinite(raw) || raw < 1) {
    throw new Error("concurrency must be a positive number");
  }
  return Math.min(Math.floor(raw), Math.max(count, 1));
}

function numberFromEnv(value: string | undefined): number | undefined {
  if (value === undefined || !value.trim()) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
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
