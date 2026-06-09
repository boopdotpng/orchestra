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

  test("mirrors turn state into managed agents", () => {
    const store = new OrchestraStore(dbPath);
    const repo = store.upsertRepo({ path: "/repo", baseCommit: "abc", baseBranch: "main" });
    store.insertManagedAgent({
      id: "a3f1",
      repoId: repo.id,
      cwd: "/run/a3f1",
      branch: "orchestra/a3f1",
      threadId: "thread-1",
      status: "idle",
      createdAt: 1,
    });

    store.applyEvent({
      type: "turn.started",
      threadId: "thread-1",
      turn: { threadId: "thread-1", turnId: "turn-1", status: "inProgress" },
    });
    expect(store.getManagedAgent("a3f1")?.status).toBe("running");
    expect(store.getManagedAgent("a3f1")?.activeTurnId).toBe("turn-1");

    store.applyEvent({
      type: "turn.completed",
      threadId: "thread-1",
      turn: { threadId: "thread-1", turnId: "turn-1", status: "completed" },
    });
    expect(store.getManagedAgent("a3f1")?.status).toBe("idle");
    expect(store.getManagedAgent("a3f1")?.activeTurnId).toBeUndefined();

    store.close();
  });

  test("keeps managed agents but clears transient runtime state on startup", () => {
    const store = new OrchestraStore(dbPath);
    const repo = store.upsertRepo({ path: "/repo", baseCommit: "abc", baseBranch: "main" });
    store.insertManagedAgent({
      id: "a3f1",
      repoId: repo.id,
      cwd: "/run/a3f1",
      branch: "orchestra/a3f1",
      threadId: "thread-1",
      activeTurnId: "turn-1",
      status: "running",
      createdAt: 1,
    });
    store.applyEvent({
      type: "agent.started",
      agent: {
        threadId: "thread-1",
        sessionId: "session-1",
        cwd: "/run/a3f1",
        status: "active",
        activeTurnId: "turn-1",
      },
    });

    store.resetTransientRuntimeState();

    const agent = store.getManagedAgent("a3f1");
    expect(agent?.status).toBe("idle");
    expect(agent?.activeTurnId).toBeUndefined();
    expect(agent?.threadId).toBe("thread-1");
    expect(agent?.cwd).toBe("/run/a3f1");

    store.close();
  });

  test("indexes generic notification events by nested params thread id", () => {
    const store = new OrchestraStore(dbPath);
    store.applyEvent({
      type: "notification",
      method: "item/mcpToolCall/progress",
      params: {
        threadId: "thread-tool",
        turnId: "turn-tool",
        itemId: "item-tool",
        delta: "tool output",
      },
    });

    const events = store.listEvents("thread-tool", 10);
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0])).toContain("item/mcpToolCall/progress");

    store.close();
  });
});
