import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { EventBus } from "../../domain/events";
import type { BackendNotification, BackendServerRequest, Json } from "../../domain/types";

type JsonRpcId = string | number;

type JsonRpcError = {
  code: number;
  message: string;
  data?: Json;
};

type JsonRpcMessage = {
  jsonrpc?: "2.0";
  id?: JsonRpcId;
  method?: string;
  params?: Json;
  result?: Json;
  error?: JsonRpcError;
};

type PendingRequest = {
  resolve: (result: Json) => void;
  reject: (error: Error) => void;
};

export type JsonRpcProcessOptions = {
  command: string;
  args: string[];
  cwd?: string | undefined;
};

export class JsonRpcProcess {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly notifications = new EventBus<BackendNotification>();
  private readonly serverRequests = new EventBus<BackendServerRequest>();

  constructor(private readonly options: JsonRpcProcessOptions) {}

  onNotification(listener: (notification: BackendNotification) => void) {
    return this.notifications.on(listener);
  }

  onServerRequest(listener: (request: BackendServerRequest) => void) {
    return this.serverRequests.on(listener);
  }

  async connect(): Promise<void> {
    if (this.child) {
      return;
    }

    this.child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.once("exit", (code, signal) => {
      const message = `Codex app-server exited (${signal ?? code ?? "unknown"})`;
      for (const pending of this.pending.values()) {
        pending.reject(new Error(message));
      }
      this.pending.clear();
      this.child = undefined;
    });

    this.child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text.length > 0) {
        this.notifications.emit({ method: "transport/stderr", params: { text } });
      }
    });

    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      this.handleLine(line);
    });
  }

  request(method: string, params: Json = null): Promise<Json> {
    const id = this.nextId++;
    this.write({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  notify(method: string, params: Json = null): void {
    const message: JsonRpcMessage = params === null ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params };
    this.write(message);
  }

  respond(id: JsonRpcId, result: Json): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) {
      return;
    }
    child.kill();
    this.child = undefined;
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }

    let message: JsonRpcMessage;
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      this.notifications.emit({ method: "transport/unparseable", params: { line: trimmed } });
      return;
    }

    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result ?? null);
      }
      return;
    }

    if (message.id !== undefined && message.method) {
      this.serverRequests.emit({
        id: message.id,
        method: message.method,
        params: message.params,
      });
      return;
    }

    if (message.method) {
      this.notifications.emit({
        method: message.method,
        params: message.params,
      });
    }
  }

  private write(message: JsonRpcMessage): void {
    if (!this.child) {
      throw new Error("Codex app-server transport is not connected");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
}
