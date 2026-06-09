import type {
  ApprovalPolicy,
  BackendNotification,
  BackendServerRequest,
  Json,
  Personality,
  SandboxMode,
  StartAgentOptions,
} from "../domain/types";
import type { Unsubscribe } from "../domain/events";

export type SendTurnOptions = {
  cwd?: string | undefined;
  model?: string | undefined;
  approvalPolicy?: ApprovalPolicy | undefined;
  sandbox?: SandboxMode | undefined;
  personality?: Personality | undefined;
};

export interface CodexBackend {
  connect(): Promise<void>;
  close(): Promise<void>;
  onNotification(listener: (notification: BackendNotification) => void): Unsubscribe;
  onServerRequest(listener: (request: BackendServerRequest) => void): Unsubscribe;

  initialize(): Promise<Json>;
  startThread(options: StartAgentOptions): Promise<Json>;
  resumeThread(threadId: string, options?: StartAgentOptions): Promise<Json>;
  listThreads(options?: {
    cwd?: string | undefined;
    archived?: boolean | undefined;
    limit?: number | undefined;
    searchTerm?: string | undefined;
  }): Promise<Json>;
  readThread(threadId: string, includeTurns?: boolean): Promise<Json>;
  setThreadName(threadId: string, name: string): Promise<Json>;
  setThreadGoal(threadId: string, goal: string): Promise<Json>;
  archiveThread(threadId: string): Promise<Json>;
  unarchiveThread(threadId: string): Promise<Json>;
  startTurn(threadId: string, input: string, options?: SendTurnOptions): Promise<Json>;
  steerTurn(threadId: string, expectedTurnId: string, input: string): Promise<Json>;
  interruptTurn(threadId: string, turnId: string): Promise<Json>;
  listModels(): Promise<Json>;
  respond(requestId: string | number, result: Json): Promise<void>;
}
