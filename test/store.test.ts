import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { OrchestraStore } from "../src/store/OrchestraStore";

const dbPath = ".orchestra/test.sqlite";

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
});

describe("OrchestraStore", () => {
  test("persists agent, turn, stream text, and approval state", () => {
    const store = new OrchestraStore(dbPath);

    store.applyEvent({
      type: "agent.started",
      agent: {
        threadId: "thread-1",
        sessionId: "session-1",
        cwd: "/repo",
        status: "idle",
        raw: { id: "thread-1", sessionId: "session-1", cwd: "/repo", status: { type: "idle" } },
      },
    });
    store.applyEvent({
      type: "turn.started",
      threadId: "thread-1",
      turn: { threadId: "thread-1", turnId: "turn-1", status: "inProgress" },
    });
    store.applyEvent({
      type: "stream.agent",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      delta: "hello",
    });
    store.applyEvent({
      type: "approval.requested",
      approval: {
        requestId: 7,
        method: "item/commandExecution/requestApproval",
        kind: "command",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-2",
        params: { command: "echo ok" },
        createdAtMs: 1,
      },
    });

    expect(store.listAgents()[0]?.activeTurnId).toBe("turn-1");
    expect(store.listPendingApprovals()[0]?.requestId).toBe("7");

    store.applyEvent({ type: "approval.resolved", requestId: 7, raw: { decision: "accept" } });
    expect(store.listPendingApprovals()).toHaveLength(0);

    store.close();
  });
});
