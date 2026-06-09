import type { CodexBackend, SendTurnOptions } from "../backend/CodexBackend";
import { EventBus } from "../domain/events";
import type {
  Agent,
  AgentEvent,
  Approval,
  ApprovalKind,
  BackendNotification,
  BackendServerRequest,
  Json,
  RuntimeStatus,
  StartAgentOptions,
  Turn,
  TurnStatus,
} from "../domain/types";
import type { OrchestraStore } from "../store/OrchestraStore";

export type AgentManagerOptions = {
  store?: OrchestraStore;
  autoPersist?: boolean;
};

export class AgentManager {
  private readonly events = new EventBus<AgentEvent>();
  private initialized = false;

  constructor(
    private readonly backend: CodexBackend,
    private readonly options: AgentManagerOptions = {},
  ) {
    backend.onNotification((notification) => {
      this.handleNotification(notification);
    });
    backend.onServerRequest((request) => {
      this.handleServerRequest(request);
    });
    if (options.autoPersist !== false && options.store) {
      this.events.on((event) => options.store?.applyEvent(event));
    }
  }

  onEvent(listener: (event: AgentEvent) => void) {
    return this.events.on(listener);
  }

  async connect(): Promise<void> {
    await this.backend.connect();
    if (!this.initialized) {
      await this.backend.initialize();
      this.initialized = true;
    }
  }

  close(): Promise<void> {
    return this.backend.close();
  }

  async startAgent(options: StartAgentOptions): Promise<Agent> {
    await this.connect();
    const result = await this.backend.startThread(options);
    const agent = agentFromThreadResponse(result, options.model);
    this.emit({ type: "agent.started", agent });
    if (options.name) {
      await this.backend.setThreadName(agent.threadId, options.name);
    }
    return agent;
  }

  async listAgents(options: Parameters<CodexBackend["listThreads"]>[0] = {}): Promise<Agent[]> {
    await this.connect();
    const result = await this.backend.listThreads(options);
    const threads = asArray(asRecord(result)?.data);
    return threads.map((thread) => agentFromThread(thread)).filter((agent): agent is Agent => Boolean(agent));
  }

  async readThread(threadId: string): Promise<Json> {
    await this.connect();
    return this.backend.readThread(threadId, true);
  }

  async listModels(): Promise<Json> {
    await this.connect();
    return this.backend.listModels();
  }

  async send(threadId: string, input: string, options: SendTurnOptions = {}): Promise<Turn> {
    await this.connect();
    await this.backend.resumeThread(threadId, options);
    const result = await this.backend.startTurn(threadId, input, options);
    const turn = turnFromTurnResponse(threadId, result);
    this.emit({ type: "turn.started", threadId, turn });
    return turn;
  }

  async startTurn(threadId: string, input: string, options: SendTurnOptions = {}): Promise<Turn> {
    await this.connect();
    const result = await this.backend.startTurn(threadId, input, options);
    const turn = turnFromTurnResponse(threadId, result);
    this.emit({ type: "turn.started", threadId, turn });
    return turn;
  }

  async steer(threadId: string, turnId: string, input: string): Promise<Json> {
    await this.connect();
    return this.backend.steerTurn(threadId, turnId, input);
  }

  async interrupt(threadId: string, turnId?: string): Promise<Json> {
    await this.connect();
    const activeTurnId = turnId ?? this.options.store?.getAgent(threadId)?.activeTurnId;
    if (!activeTurnId) {
      throw new Error("No active turn id provided or found in the local store");
    }
    return this.backend.interruptTurn(threadId, activeTurnId);
  }

  async approve(requestId: string | number, decision: "accept" | "acceptForSession" | "decline" | "cancel" = "accept"): Promise<void> {
    await this.backend.respond(requestId, { decision });
    this.emit({ type: "approval.resolved", requestId, raw: { decision } });
  }

  async deny(requestId: string | number): Promise<void> {
    await this.approve(requestId, "decline");
  }

  async respondRaw(requestId: string | number, result: Json): Promise<void> {
    await this.backend.respond(requestId, result);
    this.emit({ type: "approval.resolved", requestId, raw: result });
  }

  private handleNotification(notification: BackendNotification): void {
    const params = notification.params ?? {};
    switch (notification.method) {
      case "thread/started": {
        const agent = agentFromThread(asRecord(params)?.thread);
        if (agent) {
          this.emit({ type: "agent.started", agent });
        }
        break;
      }
      case "thread/status/changed": {
        const threadId = readString(params, "threadId");
        if (threadId) {
          this.emit({
            type: "agent.status",
            threadId,
            status: statusFromWire(asRecord(params)?.status),
            raw: asRecord(params)?.status ?? {},
          });
        }
        break;
      }
      case "thread/name/updated": {
        const threadId = readString(params, "threadId");
        if (threadId) {
          this.emit({ type: "agent.name", threadId, name: readString(params, "name") ?? null });
        }
        break;
      }
      case "thread/tokenUsage/updated": {
        const threadId = readString(params, "threadId");
        if (threadId) {
          this.emit({
            type: "agent.tokenUsage",
            threadId,
            turnId: readString(params, "turnId"),
            tokenUsage: asRecord(params)?.tokenUsage ?? {},
          });
        }
        break;
      }
      case "turn/started": {
        const threadId = readString(params, "threadId");
        const turn = turnFromWire(threadId, asRecord(params)?.turn);
        if (threadId && turn) {
          this.emit({ type: "turn.started", threadId, turn });
        }
        break;
      }
      case "turn/completed": {
        const threadId = readString(params, "threadId");
        const turn = turnFromWire(threadId, asRecord(params)?.turn);
        if (threadId && turn) {
          this.emit({ type: "turn.completed", threadId, turn });
        }
        break;
      }
      case "turn/diff/updated": {
        const threadId = readString(params, "threadId");
        const turnId = readString(params, "turnId");
        if (threadId && turnId) {
          this.emit({ type: "turn.diff", threadId, turnId, diff: readString(params, "diff") ?? "" });
        }
        break;
      }
      case "turn/plan/updated": {
        const threadId = readString(params, "threadId");
        const turnId = readString(params, "turnId");
        if (threadId && turnId) {
          this.emit({
            type: "turn.plan",
            threadId,
            turnId,
            explanation: readString(params, "explanation") ?? null,
            plan: asRecord(params)?.plan ?? [],
          });
        }
        break;
      }
      case "item/started":
      case "item/completed": {
        const threadId = readString(params, "threadId");
        const turnId = readString(params, "turnId");
        const item = asRecord(params)?.item ?? {};
        const itemId = readString(item, "id");
        if (threadId && turnId) {
          if (notification.method === "item/started") {
            this.emit({ type: "item.started", threadId, turnId, itemId, item });
          } else {
            this.emit({ type: "item.completed", threadId, turnId, itemId, item });
          }
        }
        break;
      }
      case "item/agentMessage/delta":
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta":
      case "item/commandExecution/outputDelta": {
        const threadId = readString(params, "threadId");
        const turnId = readString(params, "turnId");
        const itemId = readString(params, "itemId");
        const delta = readString(params, "delta") ?? "";
        if (threadId && turnId && itemId) {
          const type =
            notification.method === "item/agentMessage/delta"
              ? "stream.agent"
              : notification.method === "item/commandExecution/outputDelta"
                ? "stream.command"
                : "stream.reasoning";
          this.emit({ type, threadId, turnId, itemId, delta });
        }
        break;
      }
      case "serverRequest/resolved": {
        this.emit({ type: "approval.resolved", requestId: readString(params, "requestId"), raw: params });
        break;
      }
      case "error":
        this.emit({ type: "error", raw: params });
        break;
      case "warning":
        this.emit({ type: "warning", raw: params });
        break;
      default:
        this.emit({ type: "notification", method: notification.method, params });
    }
  }

  private handleServerRequest(request: BackendServerRequest): void {
    const params = request.params ?? {};
    const approval: Approval = {
      requestId: request.id,
      method: request.method,
      kind: approvalKind(request.method),
      threadId: readString(params, "threadId"),
      turnId: readString(params, "turnId"),
      itemId: readString(params, "itemId"),
      params,
      createdAtMs: readNumber(params, "startedAtMs") ?? Date.now(),
    };
    this.emit({ type: "approval.requested", approval });
  }

  private emit(event: AgentEvent): void {
    this.events.emit(event);
  }
}

function agentFromThreadResponse(result: Json, model?: string): Agent {
  const record = asRecord(result);
  const agent = agentFromThread(record?.thread, model);
  if (!agent) {
    throw new Error("thread/start response did not include a thread");
  }
  return agent;
}

function agentFromThread(value: Json | undefined, model?: string): Agent | undefined {
  const thread = asRecord(value);
  const threadId = readString(thread, "id");
  if (!threadId) {
    return undefined;
  }
  return {
    threadId,
    sessionId: readString(thread, "sessionId"),
    name: readString(thread, "name"),
    preview: readString(thread, "preview"),
    cwd: readString(thread, "cwd"),
    model: model ?? readString(thread, "model"),
    status: statusFromWire(asRecord(thread?.status)),
    createdAt: readNumber(thread, "createdAt"),
    updatedAt: readNumber(thread, "updatedAt"),
    raw: thread,
  };
}

function turnFromTurnResponse(threadId: string, result: Json): Turn {
  const turn = turnFromWire(threadId, asRecord(asRecord(result)?.turn));
  if (!turn) {
    throw new Error("turn/start response did not include a turn");
  }
  return turn;
}

function turnFromWire(threadId: string | undefined, value: Json | undefined): Turn | undefined {
  const turn = asRecord(value);
  const id = readString(turn, "id");
  if (!threadId || !id) {
    return undefined;
  }
  return {
    threadId,
    turnId: id,
    status: (readString(turn, "status") ?? "inProgress") as TurnStatus,
    raw: turn,
  };
}

function statusFromWire(value: Json | undefined): RuntimeStatus {
  const status = asRecord(value);
  const type = readString(status, "type");
  if (type === "idle" || type === "systemError" || type === "active" || type === "notLoaded") {
    return type;
  }
  return "notLoaded";
}

function approvalKind(method: string): ApprovalKind {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "execCommandApproval":
      return method === "execCommandApproval" ? "legacyCommand" : "command";
    case "item/fileChange/requestApproval":
    case "applyPatchApproval":
      return method === "applyPatchApproval" ? "legacyPatch" : "fileChange";
    case "item/tool/requestUserInput":
      return "userInput";
    case "item/permissions/requestApproval":
      return "permissions";
    case "mcpServer/elicitation/request":
      return "mcpElicitation";
    case "item/tool/call":
      return "dynamicTool";
    case "account/chatgptAuthTokens/refresh":
      return "auth";
    case "attestation/generate":
      return "attestation";
    default:
      return "unknown";
  }
}

function asRecord(value: Json | undefined): Record<string, Json | undefined> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function asArray(value: Json | undefined): Json[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: Json | undefined, key: string): string | undefined {
  const record = asRecord(value);
  const nested = record?.[key];
  return typeof nested === "string" ? nested : undefined;
}

function readNumber(value: Json | undefined, key: string): number | undefined {
  const record = asRecord(value);
  const nested = record?.[key];
  return typeof nested === "number" ? nested : undefined;
}
