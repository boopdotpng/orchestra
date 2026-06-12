#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DEFAULT_MODEL, DEFAULT_SERVICE_TIER } from "./config";
import { get, getText, post, postText } from "./mcp/client";

const server = new McpServer({
  name: "orchestra",
  version: "0.1.0",
});

server.tool(
  "create",
  [
    "Create one or more isolated Codex agent workspaces.",
    "Return shape is always a JSON object with an agents array, never a bare id: { agents: [ManagedAgent, ...] }.",
    "Each ManagedAgent includes id, repoId, workspaceName, repoPath, baseCommit, sourcePath, optional parentAgentId, cwd, branch, threadId, optional activeTurnId, status, and createdAt.",
    "The id is a 4-character lowercase hex string, and the branch is orchestra/<id>.",
    "When n is 1, agents has one element. When n > 1, agents has n elements, each with its own isolated workspace and id.",
    "Either provide prompt with optional n, or provide sharedPrompt with agents[{focus}] to start focused agents in one call.",
    "create always starts the first turn so no dead idle agents are created.",
    "Concurrent setup is bounded by concurrency, or ORCHESTRA_CREATE_CONCURRENCY when omitted, defaulting to 8.",
    `Defaults: model ${DEFAULT_MODEL} and serviceTier ${DEFAULT_SERVICE_TIER} from service config unless overridden.`,
    "Managed agent records persist in Orchestra's SQLite store across MCP/client sessions and service restarts until removed with teardown.",
  ].join(" "),
  {
    name: z.string().min(1).describe("Required workspace/run name used to group these agents in the UI and status output."),
    dir: z.string().describe("Path inside the source git repository to copy into isolated agent workspaces."),
    n: z.number().int().positive().optional().describe("Number of agents to create when using prompt. Values greater than 1 fan out and return multiple ids in agents[]."),
    concurrency: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Maximum number of agents to set up and start at once. Omit to use ORCHESTRA_CREATE_CONCURRENCY or the built-in default of 8."),
    prompt: z.string().min(1).optional().describe("First-turn prompt used for every created agent. Mutually exclusive with agents."),
    sharedPrompt: z.string().min(1).optional().describe("Shared instructions used with agents[{focus}] focused fan-out."),
    promptTemplate: z
      .string()
      .min(1)
      .optional()
      .describe("Optional template for focused fan-out. Placeholders: {sharedPrompt}, {focus}, {index}, {count}, {workspace}, {dir}, {id}, {cwd}, {branch}."),
    agents: z
      .array(
        z.object({
          focus: z.string().min(1).describe("Per-agent focus appended to sharedPrompt or inserted into promptTemplate."),
        }),
      )
      .optional()
      .describe("Focused agents to create in one call. Length determines count when provided."),
    onComplete: z.string().optional().describe("Optional shell command or webhook URL to run when each turn completes. The placeholders {id} and <id> are replaced with the agent id."),
    model: z.string().optional().describe(`Model override. Omit to use service config, defaulting to ${DEFAULT_MODEL}.`),
    serviceTier: z
      .enum(["default", "priority"])
      .optional()
      .describe(`Service tier override. Omit to use service config, defaulting to ${DEFAULT_SERVICE_TIER}.`),
  },
  async ({ name, dir, n, concurrency, prompt, sharedPrompt, promptTemplate, agents, onComplete, model, serviceTier }) =>
    text(await post("/agents", { name, dir, count: n, concurrency, prompt, sharedPrompt, promptTemplate, agents, onComplete, model, serviceTier })),
);

server.tool(
  "status",
  [
    "Show enriched status for agents in one workspace, including last message tail, turn counts, token usage, last activity, and any pending approvals.",
    "For Claude Code monitoring, run `orchestra monitor <agent-id>` for one agent or `orchestra monitor <workdir>` to wait for every agent in a workdir.",
    "That monitor command prints only completion lines: once for a single agent, or once per agent completion in a watched workdir.",
  ].join(" "),
  {
    workspace: z.string().min(1).describe("Required exact workspace/run name to show."),
  },
  async ({ workspace }) => text(await get(`/status?workspace=${encodeURIComponent(workspace)}`)),
);

server.tool(
  "list_workspaces",
  [
    "List Orchestra workspaces with full, untruncated workspace names.",
    "Use this before workspace-scoped tools such as status, standouts, broadcast, or teardown when you need the exact workspace/run name.",
    "Returns each workspace name with agent ids, status counts, repo paths, and workdirs.",
  ].join(" "),
  {},
  async () => text(listWorkspaces(await get("/status"))),
);

server.tool(
  "teardown",
  "Destroy Orchestra-managed agents and their workspaces for an exact workspace/run name.",
  { workspace: z.string().min(1).describe("Required exact workspace/run name to remove.") },
  async ({ workspace }) => text(await post("/teardown", { workspace })),
);

server.tool(
  "diff",
  [
    "Read Orchestra agent diffs.",
    "Pass one agent id using `id`/`agent` or a one-item `agents` array to get the raw git-diff-formatted patch from that agent's Orchestra baseline to its current worktree.",
    "Pass two or more ids in `agents` to automatically compare the diffs, showing per-agent size, changed-file overlap, unique files, and surface area instead of dumping full patches.",
    "Diffs include tracked edits and non-ignored untracked files, and exclude files ignored by the workspace .gitignore.",
  ].join(" "),
  {
    id: z.string().optional().describe("Single 4-character lowercase hex agent id returned by create."),
    agent: z.string().optional().describe("Alias for id when reading one agent diff."),
    agents: z.array(z.string()).optional().describe("One or more 4-character lowercase hex agent ids. Two or more ids produce a comparison view."),
  },
  async ({ id, agent, agents }) => {
    const ids = agents && agents.length ? agents : [id ?? agent].filter((value): value is string => typeof value === "string");
    return { content: [{ type: "text", text: await postText("/diff", { agents: ids }) }] };
  },
);

server.tool(
  "standouts",
  "Show top-3 mechanical standout markers within one workspace: most code written, finished last, and broadest surface area. These are interesting signals, not quality scores.",
  {
    workspace: z.string().min(1).describe("Required exact workspace/run name to inspect."),
  },
  async ({ workspace }) => ({ content: [{ type: "text", text: await getText(`/standouts?workspace=${encodeURIComponent(workspace)}`) }] }),
);

server.tool(
  "exec",
  "Run a shell command in an agent workspace. This is independent of the agent's Codex turn; it runs immediately in the workspace cwd and does not steer or block the agent's active turn.",
  {
    id: z.string().describe("4-character lowercase hex agent id returned by create."),
    cmd: z.string().describe("Shell command to run with bash -lc in the agent workspace."),
  },
  async ({ id, cmd }) => text(await post(`/agents/${encodeURIComponent(id)}/exec`, { cmd })),
);

server.tool(
  "steer",
  [
    "Send guidance to an agent.",
    "If the agent is idle, starts a new turn. If the agent is running, sends turn/steer into the tracked active turn.",
    "Steering a running turn is interleaved with that turn rather than queued as a later turn. Shell exec calls are separate workspace commands and can run while a turn is active.",
    `New idle turns use service config defaults unless model/serviceTier are provided; defaults are model ${DEFAULT_MODEL} and serviceTier ${DEFAULT_SERVICE_TIER}.`,
  ].join(" "),
  {
    id: z.string().describe("4-character lowercase hex agent id returned by create."),
    input: z.string().describe("Guidance text to start a new turn or steer the active turn."),
    model: z.string().optional().describe(`Model override for a new idle turn. Ignored when steering an already-running turn. Omit to use service config, defaulting to ${DEFAULT_MODEL}.`),
    serviceTier: z
      .enum(["default", "priority"])
      .optional()
      .describe(`Service tier override for a new idle turn. Ignored when steering an already-running turn. Omit to use service config, defaulting to ${DEFAULT_SERVICE_TIER}.`),
  },
  async ({ id, input, model, serviceTier }) => text(await post(`/agents/${encodeURIComponent(id)}/steer`, { input, model, serviceTier })),
);

server.tool("interrupt", "Interrupt an agent's active turn.", { id: z.string().describe("4-character lowercase hex agent id returned by create.") }, async ({ id }) =>
  text(await post(`/agents/${encodeURIComponent(id)}/interrupt`)),
);

await server.connect(new StdioServerTransport());

function text(value: unknown) {
  return {
    content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  };
}

type WorkspaceListing = {
  name: string;
  agentCount: number;
  agentIds: string[];
  statuses: Record<string, number>;
  repoPaths: string[];
  workdirs: string[];
};

function listWorkspaces(status: unknown): { workspaces: WorkspaceListing[] } {
  const data = asRecord(status);
  const agents = Array.isArray(data.agents) ? data.agents : [];
  const byName = new Map<string, WorkspaceListing>();

  for (const value of agents) {
    const agent = asRecord(value);
    const name = readString(agent, "workspaceName") ?? readString(agent, "workspace");
    if (!name) {
      continue;
    }

    const listing =
      byName.get(name) ??
      ({
        name,
        agentCount: 0,
        agentIds: [],
        statuses: {},
        repoPaths: [],
        workdirs: [],
      } satisfies WorkspaceListing);
    listing.agentCount += 1;

    const id = readString(agent, "id");
    if (id) {
      listing.agentIds.push(id);
    }
    const status = readString(agent, "status");
    if (status) {
      listing.statuses[status] = (listing.statuses[status] ?? 0) + 1;
    }
    appendUnique(listing.repoPaths, readString(agent, "repoPath"));
    appendUnique(listing.workdirs, readString(agent, "cwd"));
    byName.set(name, listing);
  }

  return {
    workspaces: [...byName.values()].sort((left, right) => left.name.localeCompare(right.name)),
  };
}

function appendUnique(values: string[], value: string | undefined): void {
  if (value && !values.includes(value)) {
    values.push(value);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
