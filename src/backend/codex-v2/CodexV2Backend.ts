import type { ClientNotification } from "../../../bindings/codex-v2/ClientNotification";
import type { InitializeParams } from "../../../bindings/codex-v2/InitializeParams";
import type { Personality as WirePersonality } from "../../../bindings/codex-v2/Personality";
import type { AskForApproval } from "../../../bindings/codex-v2/v2/AskForApproval";
import type { SandboxMode as WireSandboxMode } from "../../../bindings/codex-v2/v2/SandboxMode";
import type { ThreadListParams } from "../../../bindings/codex-v2/v2/ThreadListParams";
import type { ThreadReadParams } from "../../../bindings/codex-v2/v2/ThreadReadParams";
import type { ThreadResumeParams } from "../../../bindings/codex-v2/v2/ThreadResumeParams";
import type { ThreadSetNameParams } from "../../../bindings/codex-v2/v2/ThreadSetNameParams";
import type { ThreadStartParams } from "../../../bindings/codex-v2/v2/ThreadStartParams";
import type { TurnInterruptParams } from "../../../bindings/codex-v2/v2/TurnInterruptParams";
import type { TurnStartParams } from "../../../bindings/codex-v2/v2/TurnStartParams";
import type { TurnSteerParams } from "../../../bindings/codex-v2/v2/TurnSteerParams";
import type { UserInput } from "../../../bindings/codex-v2/v2/UserInput";
import type { CodexBackend, SendTurnOptions } from "../CodexBackend";
import type { Json, StartAgentOptions } from "../../domain/types";
import { DEFAULT_SERVICE_TIER } from "../../config";
import { JsonRpcProcess } from "./JsonRpcProcess";

export type CodexV2BackendOptions = {
  command?: string;
  args?: string[];
  cwd?: string;
};

export class CodexV2Backend implements CodexBackend {
  private readonly rpc: JsonRpcProcess;

  constructor(options: CodexV2BackendOptions = {}) {
    this.rpc = new JsonRpcProcess({
      command: options.command ?? "codex",
      args: options.args ?? ["app-server", "proxy"],
      cwd: options.cwd,
    });
  }

  connect() {
    return this.rpc.connect();
  }

  close() {
    return this.rpc.close();
  }

  onNotification(listener: Parameters<CodexBackend["onNotification"]>[0]) {
    return this.rpc.onNotification(listener);
  }

  onServerRequest(listener: Parameters<CodexBackend["onServerRequest"]>[0]) {
    return this.rpc.onServerRequest(listener);
  }

  async initialize(): Promise<Json> {
    const params: InitializeParams = {
      clientInfo: {
        name: "orchestra",
        title: "Orchestra",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
      },
    };
    const result = await this.rpc.request("initialize", params as Json);
    const notification: ClientNotification = { method: "initialized" };
    this.rpc.notify(notification.method);
    return result;
  }

  startThread(options: StartAgentOptions): Promise<Json> {
    const params: ThreadStartParams = {
      cwd: options.cwd ?? null,
      model: options.model ?? null,
      serviceTier: options.serviceTier ?? DEFAULT_SERVICE_TIER,
      approvalPolicy: (options.approvalPolicy ?? "never") as AskForApproval,
      sandbox: (options.sandbox ?? "danger-full-access") as WireSandboxMode,
      personality: (options.personality ?? "friendly") as WirePersonality,
      baseInstructions: options.baseInstructions ?? null,
      developerInstructions: options.developerInstructions ?? null,
      threadSource: "user",
    };
    return this.rpc.request("thread/start", params as Json);
  }

  resumeThread(threadId: string, options: StartAgentOptions = {}): Promise<Json> {
    const params: ThreadResumeParams = {
      threadId,
      cwd: options.cwd ?? null,
      model: options.model ?? null,
      serviceTier: options.serviceTier ?? DEFAULT_SERVICE_TIER,
      approvalPolicy: (options.approvalPolicy ?? null) as AskForApproval | null,
      sandbox: (options.sandbox ?? null) as WireSandboxMode | null,
      personality: (options.personality ?? null) as WirePersonality | null,
      baseInstructions: options.baseInstructions ?? null,
      developerInstructions: options.developerInstructions ?? null,
    };
    return this.rpc.request("thread/resume", params as Json);
  }

  listThreads(
    options: { cwd?: string | undefined; archived?: boolean | undefined; limit?: number | undefined; searchTerm?: string | undefined } = {},
  ): Promise<Json> {
    const params: ThreadListParams = {
      cwd: options.cwd ?? null,
      archived: options.archived ?? null,
      limit: options.limit ?? 50,
      searchTerm: options.searchTerm ?? null,
      sourceKinds: [],
    };
    return this.rpc.request("thread/list", params as Json);
  }

  readThread(threadId: string, includeTurns = true): Promise<Json> {
    const params: ThreadReadParams = { threadId, includeTurns };
    return this.rpc.request("thread/read", params as Json);
  }

  setThreadName(threadId: string, name: string): Promise<Json> {
    const params: ThreadSetNameParams = { threadId, name };
    return this.rpc.request("thread/name/set", params as Json);
  }

  setThreadGoal(threadId: string, goal: string): Promise<Json> {
    return this.rpc.request("thread/goal/set", { threadId, goal } as Json);
  }

  archiveThread(threadId: string): Promise<Json> {
    return this.rpc.request("thread/archive", { threadId } as Json);
  }

  unarchiveThread(threadId: string): Promise<Json> {
    return this.rpc.request("thread/unarchive", { threadId } as Json);
  }

  startTurn(threadId: string, input: string, options: SendTurnOptions = {}): Promise<Json> {
    const params: TurnStartParams = {
      threadId,
      input: [textInput(input)],
      cwd: options.cwd ?? null,
      model: options.model ?? null,
      serviceTier: options.serviceTier ?? DEFAULT_SERVICE_TIER,
      approvalPolicy: (options.approvalPolicy ?? null) as AskForApproval | null,
      personality: (options.personality ?? null) as WirePersonality | null,
    };
    return this.rpc.request("turn/start", params as Json);
  }

  steerTurn(threadId: string, expectedTurnId: string, input: string): Promise<Json> {
    const params: TurnSteerParams = {
      threadId,
      expectedTurnId,
      input: [textInput(input)],
    };
    return this.rpc.request("turn/steer", params as Json);
  }

  interruptTurn(threadId: string, turnId: string): Promise<Json> {
    const params: TurnInterruptParams = { threadId, turnId };
    return this.rpc.request("turn/interrupt", params as Json);
  }

  listModels(): Promise<Json> {
    return this.rpc.request("model/list", {});
  }

  readRateLimits(): Promise<Json> {
    return this.rpc.request("account/rateLimits/read", {});
  }

  async respond(requestId: string | number, result: Json): Promise<void> {
    this.rpc.respond(requestId, result);
  }
}

function textInput(text: string): UserInput {
  return {
    type: "text",
    text,
    text_elements: [],
  };
}
