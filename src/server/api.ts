import type { AgentEvent, Json, ManagedAgent, RepoRegistration, ServiceTier } from "../domain/types";

export type OrchestraApiRoute = {
  method: "GET" | "POST" | "PATCH";
  path: string;
  description: string;
};

export const ORCHESTRA_API_ROUTES = [
  { method: "GET", path: "/health", description: "Service health check." },
  { method: "GET", path: "/routes", description: "List HTTP API routes." },
  { method: "GET", path: "/status", description: "List agents and pending approvals." },
  { method: "GET", path: "/config", description: "Read effective config and source files." },
  { method: "PATCH", path: "/config", description: "Update global or local config." },
  { method: "GET", path: "/models", description: "List available Codex models and service tiers." },
  { method: "GET", path: "/events", description: "Server-sent event stream for live agent events." },
  { method: "POST", path: "/repos/register", description: "Register a source repository." },
  { method: "POST", path: "/repos/teardown", description: "Remove managed agents and workspaces for a source repository." },
  { method: "GET", path: "/agents", description: "List managed agents." },
  { method: "POST", path: "/agents", description: "Create one or more managed agents." },
  { method: "GET", path: "/agents/:id", description: "Read one managed agent." },
  { method: "GET", path: "/agents/:id/events", description: "Server-sent event stream for one agent." },
  { method: "POST", path: "/agents/:id/steer", description: "Send guidance to an agent." },
  { method: "POST", path: "/agents/:id/interrupt", description: "Interrupt an active agent turn." },
  { method: "POST", path: "/agents/:id/remove", description: "Remove one managed agent and its workspace." },
  { method: "GET", path: "/agents/:id/turn", description: "Read current turn state and recent events." },
  { method: "GET", path: "/agents/:id/diff", description: "Read agent workspace diff." },
  { method: "POST", path: "/agents/:id/exec", description: "Run a command in an agent workspace." },
  { method: "POST", path: "/agents/:id/read", description: "Write an agent transcript and return its path." },
  { method: "GET", path: "/approvals", description: "List pending approvals." },
  { method: "POST", path: "/approvals/:id/respond", description: "Respond to an approval." },
  { method: "POST", path: "/approvals/:id/approve", description: "Approve a request." },
  { method: "POST", path: "/approvals/:id/deny", description: "Deny a request." },
] as const satisfies readonly OrchestraApiRoute[];

export type ConfigResponse = {
  model: string;
  fastMode: boolean;
  serviceTier: ServiceTier;
  sources: string[];
};

export type ConfigUpdateRequest = {
  model?: string;
  fastMode?: boolean;
  serviceTier?: ServiceTier;
  scope?: "global" | "local";
};

export type CreateAgentsRequest = {
  dir: string;
  count?: number;
  prompt?: string;
  model?: string;
  serviceTier?: ServiceTier;
  approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
};

export type CreateAgentsResponse = {
  agents: ManagedAgent[];
};

export type RemoveAgentResponse = {
  agent: ManagedAgent;
};

export type RegisterRepoRequest = {
  dir: string;
};

export type RegisterRepoResponse = RepoRegistration;

export type TeardownRepoRequest = {
  dir: string;
};

export type TeardownRepoResponse = {
  agents: ManagedAgent[];
};

export type AgentsResponse = {
  agents: ManagedAgent[];
};

export type StatusResponse = AgentsResponse & {
  approvals: unknown[];
};

export type ModelsResponse = Json;

export type EventStreamMessage = AgentEvent | { type: "hello"; scope: "all" | "agent"; agentId?: string | undefined };
