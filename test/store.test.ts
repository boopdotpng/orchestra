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

  test("exposes a monotonic event cursor and replays only the gap", () => {
    const store = new OrchestraStore(dbPath);
    const mk = (delta: string) =>
      store.applyEvent({ type: "stream.agent", threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta });

    mk("a");
    mk("b");
    mk("c");

    const all = store.listEvents("thread-1");
    expect(all).toHaveLength(3);
    // Every persisted event carries a strictly increasing seq cursor.
    const seqs = all.map((e) => (e as { seq: number }).seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(new Set(seqs).size).toBe(3);

    // Resuming from the first cursor backfills only the two later events.
    const gap = store.listEventsSince("thread-1", seqs[0]!);
    expect(gap.map((e) => (e as { delta: string }).delta)).toEqual(["b", "c"]);
    // Resuming from the newest cursor yields nothing.
    expect(store.listEventsSince("thread-1", seqs[2]!)).toHaveLength(0);

    store.close();
  });

  test("mirrors turn state into managed agents", () => {
    const store = new OrchestraStore(dbPath);
    const repo = store.upsertRepo({ path: "/repo", baseCommit: "abc", baseBranch: "main" });
    store.insertManagedAgent({
      id: "a3f1",
      repoId: repo.id,
      workspaceName: "store test",
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

  test("returns managed agent to running after approval resolves during active turn", () => {
    const store = new OrchestraStore(dbPath);
    const repo = store.upsertRepo({ path: "/repo", baseCommit: "abc", baseBranch: "main" });
    store.insertManagedAgent({
      id: "a3f1",
      repoId: repo.id,
      workspaceName: "approval test",
      cwd: "/run/a3f1",
      branch: "orchestra/a3f1",
      threadId: "thread-1",
      activeTurnId: "turn-1",
      status: "running",
      createdAt: 1,
    });

    store.applyEvent({
      type: "approval.requested",
      approval: {
        requestId: 7,
        method: "mcpServer/elicitation/request",
        kind: "mcpElicitation",
        threadId: "thread-1",
        turnId: "turn-1",
        params: {},
        createdAtMs: 1,
      },
    });
    expect(store.getManagedAgent("a3f1")?.status).toBe("waiting_approval");

    store.applyEvent({ type: "approval.resolved", requestId: 7, raw: { decision: "accept" } });
    expect(store.getManagedAgent("a3f1")?.status).toBe("running");

    store.close();
  });

  test("keeps managed agents but clears transient runtime state on startup", () => {
    const store = new OrchestraStore(dbPath);
    const repo = store.upsertRepo({ path: "/repo", baseCommit: "abc", baseBranch: "main" });
    store.insertManagedAgent({
      id: "a3f1",
      repoId: repo.id,
      workspaceName: "startup test",
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

  test("managed summaries only parse bounded recent events", () => {
    const store = new OrchestraStore(dbPath);
    const repo = store.upsertRepo({ path: "/repo", baseCommit: "abc", baseBranch: "main" });
    store.insertManagedAgent({
      id: "a3f1",
      repoId: repo.id,
      workspaceName: "summary test",
      cwd: "/run/a3f1",
      branch: "orchestra/a3f1",
      threadId: "thread-1",
      activeTurnId: "turn-1",
      status: "running",
      createdAt: 1,
    });
    store.db
      .query("INSERT INTO events (thread_id, turn_id, method, payload_json, created_at_ms) VALUES (?, ?, ?, ?, ?)")
      .run("thread-1", "turn-1", "bad.old", "{", 1);
    store.applyEvent({
      type: "turn.started",
      threadId: "thread-1",
      turn: { threadId: "thread-1", turnId: "turn-1", status: "inProgress" },
    });
    for (let index = 0; index < 250; index += 1) {
      store.applyEvent({
        type: "stream.agent",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: "x",
      });
    }

    const summary = store.listManagedAgentSummaries()[0];

    expect(summary?.turnCount).toBe(1);
    expect(summary?.lastTurnSummary).toContain("inProgress");
    expect(summary?.lastTurnSummary).toContain("turn-1");
    expect(summary?.lastAssistantMessageTail).toContain("x");

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

  test("stores command metadata without persisting command output", () => {
    const store = new OrchestraStore(dbPath);
    const output = "a".repeat(1_000_128);

    store.applyEvent({
      type: "item.started",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "cmd-1",
      item: {
        type: "commandExecution",
        id: "cmd-1",
        command: "rg noisy",
        cwd: "/repo",
        status: "inProgress",
        aggregatedOutput: output,
      },
    });
    store.applyEvent({
      type: "stream.command",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "cmd-1",
      delta: output,
    });
    store.applyEvent({
      type: "item.completed",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "cmd-1",
      item: {
        type: "commandExecution",
        id: "cmd-1",
        command: "rg noisy",
        cwd: "/repo",
        status: "completed",
        exitCode: 0,
        aggregatedOutput: output,
      },
    });

    const events = store.listEvents("thread-1");
    expect(events).toHaveLength(2);
    expect(events.map((event) => (event as { type: string }).type)).toEqual(["item.started", "item.completed"]);
    expect(JSON.stringify(events)).toContain("rg noisy");
    expect(JSON.stringify(events)).not.toContain(output);

    const row = store.db
      .query("SELECT text, raw_json FROM items WHERE thread_id = ? AND turn_id = ? AND item_id = ?")
      .get("thread-1", "turn-1", "cmd-1") as { text: string | null; raw_json: string };
    expect(row.text).toBeNull();
    expect(row.raw_json).toContain("rg noisy");
    expect(row.raw_json).toContain('"exitCode":0');
    expect(row.raw_json).not.toContain(output);

    store.close();
  });

  test("deleting a managed agent clears its persisted runtime state", () => {
    const store = new OrchestraStore(dbPath);
    const repo = store.upsertRepo({ path: "/repo", baseCommit: "abc", baseBranch: "main" });
    store.insertManagedAgent({
      id: "a3f1",
      repoId: repo.id,
      workspaceName: "cleanup test",
      cwd: "/run/a3f1",
      branch: "orchestra/a3f1",
      threadId: "thread-1",
      activeTurnId: "turn-1",
      status: "running",
      createdAt: 1,
    });
    store.applyEvent({
      type: "agent.started",
      agent: { threadId: "thread-1", status: "active", activeTurnId: "turn-1" },
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
        params: {},
        createdAtMs: 1,
      },
    });

    store.deleteManagedAgent("a3f1");

    expect(store.getManagedAgent("a3f1")).toBeUndefined();
    expect(store.getAgent("thread-1")).toBeUndefined();
    expect(store.getTurn("turn-1")).toBeUndefined();
    expect(store.listEvents("thread-1")).toHaveLength(0);
    expect(store.listPendingApprovals()).toHaveLength(0);
    expect(store.listRepos()).toHaveLength(0);

    store.close();
  });
});
