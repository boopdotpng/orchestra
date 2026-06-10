import { describe, expect, test } from "bun:test";
import type { CodexBackend } from "../src/backend/CodexBackend";
import { EventBus } from "../src/domain/events";
import type { BackendNotification, BackendServerRequest, Json } from "../src/domain/types";
import { AgentManager } from "../src/manager/AgentManager";

class FakeBackend implements CodexBackend {
  notifications = new EventBus<BackendNotification>();
  requests = new EventBus<BackendServerRequest>();
  responses: Array<{ requestId: string | number; result: Json }> = [];

  async connect() {}
  async close() {}
  onNotification(listener: (notification: BackendNotification) => void) {
    return this.notifications.on(listener);
  }
  onServerRequest(listener: (request: BackendServerRequest) => void) {
    return this.requests.on(listener);
  }
  async initialize() {
    return {};
  }
  async startThread() {
    return {
      thread: {
        id: "thread-1",
        sessionId: "session-1",
        cwd: "/repo",
        preview: "",
        status: { type: "idle" },
      },
    };
  }
  async resumeThread() {
    return {};
  }
  async listThreads() {
    return { data: [] };
  }
  async readThread() {
    return {};
  }
  async setThreadName() {
    return {};
  }
  async setThreadGoal() {
    return {};
  }
  async archiveThread() {
    return {};
  }
  async unarchiveThread() {
    return {};
  }
  async startTurn() {
    return { turn: { id: "turn-1", status: "inProgress" } };
  }
  async steerTurn() {
    return {};
  }
  async interruptTurn() {
    return {};
  }
  async listModels() {
    return {};
  }
  async readRateLimits() {
    return {};
  }
  async respond(requestId: string | number, result: Json) {
    this.responses.push({ requestId, result });
  }
}

describe("AgentManager", () => {
  test("maps notifications and approvals into UI-ready events", async () => {
    const backend = new FakeBackend();
    const manager = new AgentManager(backend);
    const events: string[] = [];
    manager.onEvent((event) => {
      events.push(event.type);
    });

    await manager.startAgent({ cwd: "/repo" });
    backend.notifications.emit({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "hi" },
    });
    backend.requests.emit({
      id: 9,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-2", command: "echo ok" },
    });
    await manager.approve(9);

    expect(events).toContain("agent.started");
    expect(events).toContain("stream.agent");
    expect(events).toContain("approval.requested");
    expect(backend.responses[0]).toEqual({ requestId: 9, result: { decision: "accept" } });
  });

  test("merges sparse rate limit updates and emits only on change", async () => {
    const backend = new FakeBackend();
    const manager = new AgentManager(backend);
    const snapshots: Json[] = [];
    manager.onEvent((event) => {
      if (event.type === "account.rateLimits") {
        snapshots.push(event.rateLimits);
      }
    });

    backend.notifications.emit({
      method: "account/rateLimits/updated",
      params: { rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: null }, planType: "plus" } },
    });
    // sparse update: null planType must not clear the previously observed value
    backend.notifications.emit({
      method: "account/rateLimits/updated",
      params: { rateLimits: { primary: { usedPercent: 14, windowDurationMins: 300, resetsAt: null }, planType: null } },
    });
    // identical payload: no new event
    backend.notifications.emit({
      method: "account/rateLimits/updated",
      params: { rateLimits: { primary: { usedPercent: 14, windowDurationMins: 300, resetsAt: null } } },
    });

    expect(snapshots).toHaveLength(2);
    expect(manager.rateLimits).toEqual({
      primary: { usedPercent: 14, windowDurationMins: 300, resetsAt: null },
      planType: "plus",
    });
  });
});
