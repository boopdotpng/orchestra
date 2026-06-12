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
    "A name and prompt are required; create always starts the first turn so no dead idle agents are created.",
    `Defaults: model ${DEFAULT_MODEL} and serviceTier ${DEFAULT_SERVICE_TIER} from service config unless overridden.`,
    "Managed agent records persist in Orchestra's SQLite store across MCP/client sessions and service restarts until removed with teardown.",
  ].join(" "),
  {
    name: z.string().min(1).describe("Required workspace/run name used to group these agents in the UI and status output."),
    dir: z.string().describe("Path inside the source git repository to copy into isolated agent workspaces."),
    n: z.number().int().positive().default(1).describe("Number of agents to create. Values greater than 1 fan out and return multiple ids in agents[]."),
    prompt: z.string().min(1).describe("Required first-turn prompt."),
    onComplete: z.string().optional().describe("Optional shell command or webhook URL to run when each turn completes. The placeholders {id} and <id> are replaced with the agent id."),
    model: z.string().optional().describe(`Model override. Omit to use service config, defaulting to ${DEFAULT_MODEL}.`),
    serviceTier: z
      .enum(["default", "priority"])
      .optional()
      .describe(`Service tier override. Omit to use service config, defaulting to ${DEFAULT_SERVICE_TIER}.`),
  },
  async ({ name, dir, n, prompt, onComplete, model, serviceTier }) => text(await post("/agents", { name, dir, count: n, prompt, onComplete, model, serviceTier })),
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
  "teardown",
  "Destroy Orchestra-managed agents and their workspaces. Pass a 4-character agent id, repo folder name, source workdir path, or the literal target 'all' to remove every managed agent.",
  { target: z.string().describe("Agent id, repo folder name, source workdir path, or literal 'all'.") },
  async ({ target }) => text(await post("/teardown", { target })),
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
