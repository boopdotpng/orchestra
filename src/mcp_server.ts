#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DEFAULT_MODEL, DEFAULT_SERVICE_TIER } from "./config";
import { get, getText, post } from "./mcp/client";

const server = new McpServer({
  name: "orchestra",
  version: "0.1.0",
});

server.tool(
  "register",
  "Pin a source repository base commit for future Orchestra agents.",
  { dir: z.string().describe("Path inside the source git repository to register.") },
  async ({ dir }) => text(await post("/repos/register", { dir })),
);

server.tool(
  "teardown",
  "Remove Orchestra-managed agents and workspaces for a registered source repository. Pass a path inside the source repo; returns JSON { agents: [...] } for the removed agents. Active turns are interrupted before their workspace directories are deleted.",
  { dir: z.string().describe("Path inside the registered source git repository whose managed agent workspaces should be removed.") },
  async ({ dir }) => text(await post("/repos/teardown", { dir })),
);

server.tool(
  "create",
  [
    "Create one or more isolated Codex agent workspaces.",
    "Return shape is always a JSON object with an agents array, never a bare id: { agents: [ManagedAgent, ...] }.",
    "Each ManagedAgent includes id, repoId, repoPath, baseCommit, cwd, branch, threadId, optional activeTurnId, status, and createdAt.",
    "The id is a 4-character lowercase hex string, and the branch is orchestra/<id>.",
    "When n is 1, agents has one element. When n > 1, agents has n elements, each with its own isolated workspace and id.",
    `Defaults: model ${DEFAULT_MODEL} and serviceTier ${DEFAULT_SERVICE_TIER} from service config unless overridden; approvalPolicy defaults to never and sandbox defaults to danger-full-access unless request fields override them.`,
    "Managed agent records persist in Orchestra's SQLite store across MCP/client sessions and service restarts until removed with remove or teardown.",
  ].join(" "),
  {
    dir: z.string().describe("Path inside the source git repository to copy into isolated agent workspaces."),
    n: z.number().int().positive().default(1).describe("Number of agents to create. Values greater than 1 fan out and return multiple ids in agents[]."),
    prompt: z.string().optional().describe("Optional first-turn prompt. If omitted, the agent is created idle and can be started with steer."),
    model: z.string().optional().describe(`Model override for created agents and optional first turns. Omit to use service config, defaulting to ${DEFAULT_MODEL}.`),
    serviceTier: z
      .enum(["default", "priority"])
      .optional()
      .describe(`Service tier override. Omit to use service config, defaulting to ${DEFAULT_SERVICE_TIER}.`),
    approvalPolicy: z
      .enum(["untrusted", "on-failure", "on-request", "never"])
      .optional()
      .describe("Approval policy for new agents. Omit to use Orchestra's default of never."),
    sandbox: z
      .enum(["read-only", "workspace-write", "danger-full-access"])
      .optional()
      .describe("Sandbox mode for new agents. Omit to use Orchestra's default of danger-full-access."),
  },
  async ({ dir, n, prompt, model, serviceTier, approvalPolicy, sandbox }) =>
    text(await post("/agents", { dir, count: n, prompt, model, serviceTier, approvalPolicy, sandbox })),
);

server.tool("ls", "List Orchestra agents.", {}, async () => text(await get("/agents")));
server.tool("status", "Show agents and pending approvals.", {}, async () => text(await get("/status")));

server.tool("remove", "Remove one Orchestra-managed agent by id. If it has an active turn, that turn is interrupted first. Deletes the agent workspace directory and removes the managed-agent record. Returns JSON { agent: ManagedAgent } for the removed agent.", { id: z.string().describe("4-character lowercase hex agent id returned by create.") }, async ({ id }) =>
  text(await post(`/agents/${encodeURIComponent(id)}/remove`, {})),
);

server.tool("turn", "Show current turn state and recent events for an agent.", { id: z.string().describe("4-character lowercase hex agent id returned by create.") }, async ({ id }) =>
  text(await get(`/agents/${encodeURIComponent(id)}/turn`)),
);

server.tool("diff", "Get git diff for an agent workspace.", { id: z.string().describe("4-character lowercase hex agent id returned by create.") }, async ({ id }) => ({
  content: [{ type: "text", text: await getText(`/agents/${encodeURIComponent(id)}/diff`) }],
}));

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

server.tool("read", "Write an agent transcript to /tmp/orchestra and return its path.", { id: z.string().describe("4-character lowercase hex agent id returned by create."), json: z.boolean().default(false).describe("Write JSON instead of Markdown.") }, async ({
  id,
  json,
}) => text(await post(`/agents/${encodeURIComponent(id)}/read`, { json })));

server.tool("approvals", "List pending approvals across all agents.", {}, async () => text(await get("/approvals")));

server.tool(
  "approve",
  "Approve a pending command or file-change request.",
  {
    requestId: z.string().describe("Request id from approvals or status."),
    decision: z.enum(["accept", "acceptForSession", "decline", "cancel"]).default("accept"),
  },
  async ({ requestId, decision }) => text(await post(`/approvals/${encodeURIComponent(requestId)}/respond`, { decision })),
);

server.tool("deny", "Deny a pending approval request.", { requestId: z.string().describe("Request id from approvals or status.") }, async ({ requestId }) =>
  text(await post(`/approvals/${encodeURIComponent(requestId)}/deny`)),
);

await server.connect(new StdioServerTransport());

function text(value: unknown) {
  return {
    content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  };
}
