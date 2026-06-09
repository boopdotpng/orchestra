#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { get, getText, post } from "./mcp/client";

const server = new McpServer({
  name: "orchestra",
  version: "0.1.0",
});

server.tool(
  "register",
  "Pin a source repository base commit for future Orchestra agents.",
  { dir: z.string() },
  async ({ dir }) => text(await post("/repos/register", { dir })),
);

server.tool(
  "create",
  "Create one or more isolated Codex agent workspaces. Uses service config defaults unless model/serviceTier are provided.",
  {
    dir: z.string(),
    n: z.number().int().positive().default(1),
    prompt: z.string().optional(),
    model: z.string().optional(),
    serviceTier: z.enum(["default", "priority"]).optional(),
    approvalPolicy: z.enum(["untrusted", "on-failure", "on-request", "never"]).optional(),
    sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
  },
  async ({ dir, n, prompt, model, serviceTier, approvalPolicy, sandbox }) =>
    text(await post("/agents", { dir, count: n, prompt, model, serviceTier, approvalPolicy, sandbox })),
);

server.tool("ls", "List Orchestra agents.", {}, async () => text(await get("/agents")));
server.tool("status", "Show agents and pending approvals.", {}, async () => text(await get("/status")));

server.tool("turn", "Show current turn state and recent events for an agent.", { id: z.string() }, async ({ id }) =>
  text(await get(`/agents/${encodeURIComponent(id)}/turn`)),
);

server.tool("diff", "Get git diff for an agent workspace.", { id: z.string() }, async ({ id }) => ({
  content: [{ type: "text", text: await getText(`/agents/${encodeURIComponent(id)}/diff`) }],
}));

server.tool(
  "exec",
  "Run a shell command in an agent workspace.",
  { id: z.string(), cmd: z.string() },
  async ({ id, cmd }) => text(await post(`/agents/${encodeURIComponent(id)}/exec`, { cmd })),
);

server.tool(
  "steer",
  "Send guidance to an agent. Starts a new turn when idle, steers when running. Uses service config defaults unless model/serviceTier are provided.",
  { id: z.string(), input: z.string(), model: z.string().optional(), serviceTier: z.enum(["default", "priority"]).optional() },
  async ({ id, input, model, serviceTier }) => text(await post(`/agents/${encodeURIComponent(id)}/steer`, { input, model, serviceTier })),
);

server.tool("interrupt", "Interrupt an agent's active turn.", { id: z.string() }, async ({ id }) =>
  text(await post(`/agents/${encodeURIComponent(id)}/interrupt`)),
);

server.tool("read", "Write an agent transcript to /tmp/orchestra and return its path.", { id: z.string(), json: z.boolean().default(false) }, async ({
  id,
  json,
}) => text(await post(`/agents/${encodeURIComponent(id)}/read`, { json })));

server.tool("approvals", "List pending approvals across all agents.", {}, async () => text(await get("/approvals")));

server.tool(
  "approve",
  "Approve a pending command or file-change request.",
  { requestId: z.string(), decision: z.enum(["accept", "acceptForSession", "decline", "cancel"]).default("accept") },
  async ({ requestId, decision }) => text(await post(`/approvals/${encodeURIComponent(requestId)}/respond`, { decision })),
);

server.tool("deny", "Deny a pending approval request.", { requestId: z.string() }, async ({ requestId }) =>
  text(await post(`/approvals/${encodeURIComponent(requestId)}/deny`)),
);

await server.connect(new StdioServerTransport());

function text(value: unknown) {
  return {
    content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  };
}
