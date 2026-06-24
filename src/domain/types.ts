export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json | undefined };

export type RuntimeStatus = "notLoaded" | "idle" | "systemError" | "active";
export type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress";
export type ApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type Personality = "none" | "friendly" | "pragmatic";
export type ServiceTier = "default" | "priority";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

export type StartAgentOptions = {
  cwd?: string | undefined;
  model?: string | undefined;
  serviceTier?: ServiceTier | undefined;
  reasoningEffort?: ReasoningEffort | undefined;
  name?: string | undefined;
  approvalPolicy?: ApprovalPolicy | undefined;
  sandbox?: SandboxMode | undefined;
  personality?: Personality | undefined;
  baseInstructions?: string | undefined;
  developerInstructions?: string | undefined;
};

export type RepoRegistration = {
  id: number;
  path: string;
  baseCommit: string;
  baseBranch: string;
  createdAt: number;
};

export type ManagedAgentStatus = "idle" | "running" | "waiting_approval" | "error" | "notLoaded";

export type ManagedAgent = {
  id: string;
  repoId: number;
  workspaceName: string;
  explore?: boolean | undefined;
  repoPath?: string | undefined;
  baseCommit?: string | undefined;
  sourcePath?: string | undefined;
  parentAgentId?: string | undefined;
  cwd: string;
  branch: string;
  threadId: string;
  activeTurnId?: string | undefined;
  status: ManagedAgentStatus;
  createdAt: number;
  onComplete?: string | undefined;
};

export type ManagedAgentSummary = ManagedAgent & {
  lastTurnSummary?: string | undefined;
  lastAssistantMessageTail?: string | undefined;
  turnCount: number;
  tokensUsed?: number | undefined;
  lastActivityAt?: number | undefined;
  pendingApprovals: Approval[];
};

export type Agent = {
  threadId: string;
  sessionId?: string | undefined;
  name?: string | undefined;
  preview?: string | undefined;
  cwd?: string | undefined;
  model?: string | undefined;
  status: RuntimeStatus;
  activeTurnId?: string | undefined;
  tokenUsage?: Json | undefined;
  createdAt?: number | undefined;
  updatedAt?: number | undefined;
  raw?: Json | undefined;
};

export type Turn = {
  turnId: string;
  threadId: string;
  status: TurnStatus;
  diff?: string | undefined;
  plan?: Json | undefined;
  raw?: Json | undefined;
};

export type ApprovalKind =
  | "command"
  | "fileChange"
  | "userInput"
  | "permissions"
  | "mcpElicitation"
  | "dynamicTool"
  | "auth"
  | "attestation"
  | "legacyCommand"
  | "legacyPatch"
  | "unknown";

export type Approval = {
  requestId: string | number;
  method: string;
  kind: ApprovalKind;
  threadId?: string | undefined;
  turnId?: string | undefined;
  itemId?: string | undefined;
  params: Json;
  createdAtMs: number;
};

export type BackendNotification = {
  method: string;
  params?: Json | undefined;
};

export type BackendServerRequest = {
  id: string | number;
  method: string;
  params?: Json | undefined;
};

export type AgentEvent =
  | { type: "agent.started"; agent: Agent }
  | { type: "agent.status"; threadId: string; status: RuntimeStatus; raw: Json }
  | { type: "agent.name"; threadId: string; name: string | null }
  | { type: "agent.tokenUsage"; threadId: string; turnId?: string | undefined; tokenUsage: Json }
  | { type: "turn.started"; threadId: string; turn: Turn }
  | { type: "turn.completed"; threadId: string; turn: Turn }
  | { type: "turn.diff"; threadId: string; turnId: string; diff: string }
  | { type: "turn.plan"; threadId: string; turnId: string; plan: Json; explanation?: string | null }
  | { type: "item.started"; threadId: string; turnId: string; itemId?: string | undefined; item: Json }
  | { type: "item.completed"; threadId: string; turnId: string; itemId?: string | undefined; item: Json }
  | { type: "stream.agent"; threadId: string; turnId: string; itemId: string; delta: string }
  | { type: "stream.reasoning"; threadId: string; turnId: string; itemId: string; delta: string }
  | { type: "stream.command"; threadId: string; turnId: string; itemId: string; delta: string }
  | { type: "approval.requested"; approval: Approval }
  | { type: "approval.resolved"; requestId?: string | number | undefined; raw: Json }
  | { type: "account.rateLimits"; rateLimits: Json }
  | { type: "error"; raw: Json }
  | { type: "warning"; raw: Json }
  | { type: "notification"; method: string; params?: Json };

export type AgentSnapshot = {
  agents: Agent[];
  pendingApprovals: Approval[];
};
