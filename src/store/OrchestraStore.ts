import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  Agent,
  AgentEvent,
  Approval,
  Json,
  ManagedAgent,
  ManagedAgentSummary,
  ManagedAgentStatus,
  RepoRegistration,
  RuntimeStatus,
  Turn,
} from "../domain/types";

type Row = Record<string, unknown>;

export class OrchestraStore {
  readonly db: Database;

  constructor(path = defaultDbPath()) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        thread_id TEXT PRIMARY KEY,
        session_id TEXT,
        name TEXT,
        preview TEXT,
        cwd TEXT,
        model TEXT,
        status TEXT NOT NULL,
        active_turn_id TEXT,
        token_usage_json TEXT,
        created_at INTEGER,
        updated_at INTEGER,
        raw_json TEXT,
        stored_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS turns (
        turn_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        status TEXT NOT NULL,
        diff TEXT,
        plan_json TEXT,
        raw_json TEXT,
        started_at INTEGER,
        completed_at INTEGER,
        updated_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS items (
        item_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        kind TEXT,
        status TEXT,
        text TEXT,
        raw_json TEXT,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (thread_id, turn_id, item_id)
      );

      CREATE TABLE IF NOT EXISTS approvals (
        request_id TEXT PRIMARY KEY,
        thread_id TEXT,
        turn_id TEXT,
        item_id TEXT,
        method TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        params_json TEXT,
        response_json TEXT,
        created_at_ms INTEGER NOT NULL,
        resolved_at_ms INTEGER
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT,
        turn_id TEXT,
        method TEXT NOT NULL,
        payload_json TEXT,
        created_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS repos (
        id INTEGER PRIMARY KEY,
        path TEXT UNIQUE NOT NULL,
        base_commit TEXT NOT NULL,
        base_branch TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS managed_agents (
        id TEXT PRIMARY KEY,
        repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        workspace_name TEXT,
        source_path TEXT,
        parent_agent_id TEXT,
        base_commit TEXT,
        cwd TEXT NOT NULL,
        branch TEXT NOT NULL,
        thread_id TEXT NOT NULL UNIQUE,
        active_turn_id TEXT,
        status TEXT NOT NULL,
        on_complete TEXT,
        created_at INTEGER NOT NULL
      );
    `);
    this.addColumnIfMissing("managed_agents", "on_complete", "TEXT");
    this.addColumnIfMissing("managed_agents", "workspace_name", "TEXT");
    this.addColumnIfMissing("managed_agents", "source_path", "TEXT");
    this.addColumnIfMissing("managed_agents", "parent_agent_id", "TEXT");
    this.addColumnIfMissing("managed_agents", "base_commit", "TEXT");
  }

  applyEvent(event: AgentEvent): void {
    this.recordEvent(event.type, event);

    switch (event.type) {
      case "agent.started":
        this.upsertAgent(event.agent);
        break;
      case "agent.status":
        this.updateAgentStatus(event.threadId, event.status, event.raw);
        this.updateManagedAgentStatus(event.threadId, managedStatusFromRuntime(event.status));
        break;
      case "agent.name":
        this.updateAgentName(event.threadId, event.name);
        break;
      case "agent.tokenUsage":
        this.updateTokenUsage(event.threadId, event.tokenUsage);
        break;
      case "turn.started":
      case "turn.completed":
        this.upsertTurn(event.turn);
        this.updateActiveTurn(event.threadId, event.type === "turn.started" ? event.turn.turnId : null);
        this.updateManagedAgentTurn(
          event.threadId,
          event.type === "turn.started" ? event.turn.turnId : null,
          event.type === "turn.started" ? "running" : managedStatusFromTurn(event.turn.status),
        );
        break;
      case "turn.diff":
        this.updateTurnDiff(event.turnId, event.diff);
        break;
      case "turn.plan":
        this.updateTurnPlan(event.turnId, event.plan);
        break;
      case "item.started":
      case "item.completed":
        this.upsertItem(event.threadId, event.turnId, event.itemId, event.item, event.type);
        break;
      case "stream.agent":
      case "stream.reasoning":
      case "stream.command":
        this.appendItemText(event.threadId, event.turnId, event.itemId, event.delta);
        break;
      case "approval.requested":
        this.insertApproval(event.approval);
        if (event.approval.threadId) {
          this.updateManagedAgentStatus(event.approval.threadId, "waiting_approval");
        }
        break;
      case "approval.resolved":
        if (event.requestId !== undefined) {
          this.resolveApproval(event.requestId, event.raw);
          this.resumeManagedAgentAfterResolvedApproval(event.requestId);
        }
        break;
    }
  }

  upsertAgent(agent: Agent): void {
    this.db
      .query(`
        INSERT INTO agents (
          thread_id, session_id, name, preview, cwd, model, status, active_turn_id,
          token_usage_json, created_at, updated_at, raw_json, stored_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET
          session_id = excluded.session_id,
          name = excluded.name,
          preview = excluded.preview,
          cwd = excluded.cwd,
          model = COALESCE(excluded.model, agents.model),
          status = excluded.status,
          active_turn_id = COALESCE(excluded.active_turn_id, agents.active_turn_id),
          token_usage_json = COALESCE(excluded.token_usage_json, agents.token_usage_json),
          created_at = COALESCE(excluded.created_at, agents.created_at),
          updated_at = excluded.updated_at,
          raw_json = excluded.raw_json,
          stored_at_ms = excluded.stored_at_ms
      `)
      .run(
        agent.threadId,
        agent.sessionId ?? null,
        agent.name ?? null,
        agent.preview ?? null,
        agent.cwd ?? null,
        agent.model ?? null,
        agent.status,
        agent.activeTurnId ?? null,
        stringifyOrNull(agent.tokenUsage),
        agent.createdAt ?? null,
        agent.updatedAt ?? null,
        stringifyOrNull(agent.raw),
        Date.now(),
      );
  }

  listAgents(): Agent[] {
    const rows = this.db.query("SELECT * FROM agents ORDER BY updated_at DESC, stored_at_ms DESC").all() as Row[];
    return rows.map(agentFromRow);
  }

  listPendingApprovals(): Approval[] {
    const rows = this.db.query("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at_ms ASC").all() as Row[];
    return rows.map(approvalFromRow);
  }

  getAgent(threadId: string): Agent | undefined {
    const row = this.db.query("SELECT * FROM agents WHERE thread_id = ?").get(threadId) as Row | undefined;
    return row ? agentFromRow(row) : undefined;
  }

  upsertRepo(input: { path: string; baseCommit: string; baseBranch: string; createdAt?: number }): RepoRegistration {
    const createdAt = input.createdAt ?? nowSeconds();
    this.db
      .query(
        `INSERT INTO repos (path, base_commit, base_branch, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
          base_commit = excluded.base_commit,
          base_branch = excluded.base_branch
        `,
      )
      .run(input.path, input.baseCommit, input.baseBranch, createdAt);
    const row = this.db.query("SELECT * FROM repos WHERE path = ?").get(input.path) as Row;
    return repoFromRow(row);
  }

  getRepoByPath(path: string): RepoRegistration | undefined {
    const row = this.db.query("SELECT * FROM repos WHERE path = ?").get(path) as Row | undefined;
    return row ? repoFromRow(row) : undefined;
  }

  listRepos(): RepoRegistration[] {
    return (this.db.query("SELECT * FROM repos ORDER BY created_at DESC").all() as Row[]).map(repoFromRow);
  }

  insertManagedAgent(agent: ManagedAgent): void {
    this.db
      .query(
        `INSERT INTO managed_agents (
          id, repo_id, workspace_name, source_path, parent_agent_id, base_commit, cwd, branch,
          thread_id, active_turn_id, status, on_complete, created_at
        )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          repo_id = excluded.repo_id,
          workspace_name = excluded.workspace_name,
          source_path = excluded.source_path,
          parent_agent_id = excluded.parent_agent_id,
          base_commit = excluded.base_commit,
          cwd = excluded.cwd,
          branch = excluded.branch,
          thread_id = excluded.thread_id,
          active_turn_id = excluded.active_turn_id,
          status = excluded.status,
          on_complete = excluded.on_complete`,
      )
      .run(
        agent.id,
        agent.repoId,
        agent.workspaceName,
        agent.sourcePath ?? null,
        agent.parentAgentId ?? null,
        agent.baseCommit ?? null,
        agent.cwd,
        agent.branch,
        agent.threadId,
        agent.activeTurnId ?? null,
        agent.status,
        agent.onComplete ?? null,
        agent.createdAt,
      );
  }

  getManagedAgent(id: string): ManagedAgent | undefined {
    const row = this.db
      .query(
        `SELECT managed_agents.*, repos.path AS repo_path, COALESCE(managed_agents.base_commit, repos.base_commit) AS base_commit
         FROM managed_agents JOIN repos ON repos.id = managed_agents.repo_id
         WHERE managed_agents.id = ?`,
      )
      .get(id) as Row | undefined;
    return row ? managedAgentFromRow(row) : undefined;
  }

  listManagedAgents(): ManagedAgent[] {
    const rows = this.db
      .query(
        `SELECT managed_agents.*, repos.path AS repo_path, COALESCE(managed_agents.base_commit, repos.base_commit) AS base_commit
         FROM managed_agents JOIN repos ON repos.id = managed_agents.repo_id
         ORDER BY managed_agents.created_at DESC`,
      )
      .all() as Row[];
    return rows.map(managedAgentFromRow);
  }

  listManagedAgentSummaries(): ManagedAgentSummary[] {
    const pending = new Map<string, Approval[]>();
    for (const approval of this.listPendingApprovals()) {
      if (!approval.threadId) {
        continue;
      }
      const approvals = pending.get(approval.threadId) ?? [];
      approvals.push(approval);
      pending.set(approval.threadId, approvals);
    }
    return this.listManagedAgents().map((agent) => {
      const agentRow = this.getAgent(agent.threadId);
      const events = this.listEvents(agent.threadId);
      return {
        ...agent,
        lastTurnSummary: lastTurnSummary(events),
        lastAssistantMessageTail: tail(lastAssistantMessage(events)),
        turnCount: this.turnCount(agent.threadId, events),
        tokensUsed: tokensUsed(agentRow?.tokenUsage),
        lastActivityAt: this.lastActivityAt(agent.threadId) ?? agent.createdAt * 1000,
        pendingApprovals: pending.get(agent.threadId) ?? [],
      };
    });
  }

  listManagedAgentsForRepo(repoId: number): ManagedAgent[] {
    const rows = this.db
      .query(
        `SELECT managed_agents.*, repos.path AS repo_path, COALESCE(managed_agents.base_commit, repos.base_commit) AS base_commit
         FROM managed_agents JOIN repos ON repos.id = managed_agents.repo_id
         WHERE repo_id = ?
         ORDER BY managed_agents.created_at DESC`,
      )
      .all(repoId) as Row[];
    return rows.map(managedAgentFromRow);
  }

  deleteManagedAgent(id: string): void {
    this.db.query("DELETE FROM managed_agents WHERE id = ?").run(id);
  }

  resetTransientRuntimeState(): void {
    this.db
      .query("UPDATE managed_agents SET active_turn_id = NULL, status = 'idle' WHERE status IN ('running', 'waiting_approval')")
      .run();
    this.db.query("UPDATE agents SET active_turn_id = NULL, status = 'idle' WHERE active_turn_id IS NOT NULL OR status = 'active'").run();
  }

  listEvents(threadId: string, limit?: number): Json[] {
    const rows =
      typeof limit === "number"
        ? (this.db.query("SELECT payload_json FROM events WHERE thread_id = ? ORDER BY id DESC LIMIT ?").all(threadId, limit) as Row[]).reverse()
        : (this.db.query("SELECT payload_json FROM events WHERE thread_id = ? ORDER BY id ASC").all(threadId) as Row[]);
    return rows.map((row) => parseJson(row.payload_json) ?? {});
  }

  getTurn(turnId: string): Turn | undefined {
    const row = this.db.query("SELECT * FROM turns WHERE turn_id = ?").get(turnId) as Row | undefined;
    if (!row) {
      return undefined;
    }
    return {
      turnId,
      threadId: String(row.thread_id),
      status: (optionalString(row.status) ?? "inProgress") as Turn["status"],
      diff: optionalString(row.diff),
      plan: parseJson(row.plan_json),
      raw: parseJson(row.raw_json),
    };
  }

  recordEvent(method: string, payload: Json): void {
    const threadId =
      readString(payload, "threadId") ??
      readNestedString(payload, "agent", "threadId") ??
      readNestedString(payload, "params", "threadId");
    const turnId =
      readString(payload, "turnId") ?? readNestedString(payload, "turn", "turnId") ?? readNestedString(payload, "params", "turnId");
    this.db
      .query("INSERT INTO events (thread_id, turn_id, method, payload_json, created_at_ms) VALUES (?, ?, ?, ?, ?)")
      .run(threadId ?? null, turnId ?? null, method, JSON.stringify(payload), Date.now());
  }

  private updateAgentStatus(threadId: string, status: RuntimeStatus, raw: Json): void {
    this.db
      .query("UPDATE agents SET status = ?, raw_json = COALESCE(raw_json, ?), stored_at_ms = ? WHERE thread_id = ?")
      .run(status, JSON.stringify(raw), Date.now(), threadId);
  }

  private updateAgentName(threadId: string, name: string | null): void {
    this.db.query("UPDATE agents SET name = ?, stored_at_ms = ? WHERE thread_id = ?").run(name, Date.now(), threadId);
  }

  private updateTokenUsage(threadId: string, tokenUsage: Json): void {
    this.db
      .query("UPDATE agents SET token_usage_json = ?, stored_at_ms = ? WHERE thread_id = ?")
      .run(JSON.stringify(tokenUsage), Date.now(), threadId);
  }

  private updateActiveTurn(threadId: string, turnId: string | null): void {
    this.db.query("UPDATE agents SET active_turn_id = ?, stored_at_ms = ? WHERE thread_id = ?").run(turnId, Date.now(), threadId);
  }

  private updateManagedAgentTurn(threadId: string, turnId: string | null, status: ManagedAgentStatus): void {
    this.db
      .query("UPDATE managed_agents SET active_turn_id = ?, status = ? WHERE thread_id = ?")
      .run(turnId, status, threadId);
  }

  private updateManagedAgentStatus(threadId: string, status: ManagedAgentStatus): void {
    this.db.query("UPDATE managed_agents SET status = ? WHERE thread_id = ?").run(status, threadId);
  }

  private upsertTurn(turn: Turn): void {
    const raw = asRecord(turn.raw);
    this.db
      .query(`
        INSERT INTO turns (turn_id, thread_id, status, diff, plan_json, raw_json, started_at, completed_at, updated_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(turn_id) DO UPDATE SET
          thread_id = excluded.thread_id,
          status = excluded.status,
          diff = COALESCE(excluded.diff, turns.diff),
          plan_json = COALESCE(excluded.plan_json, turns.plan_json),
          raw_json = excluded.raw_json,
          started_at = COALESCE(excluded.started_at, turns.started_at),
          completed_at = COALESCE(excluded.completed_at, turns.completed_at),
          updated_at_ms = excluded.updated_at_ms
      `)
      .run(
        turn.turnId,
        turn.threadId,
        turn.status,
        turn.diff ?? null,
        stringifyOrNull(turn.plan),
        stringifyOrNull(turn.raw),
        typeof raw?.startedAt === "number" ? raw.startedAt : null,
        typeof raw?.completedAt === "number" ? raw.completedAt : null,
        Date.now(),
      );
  }

  private updateTurnDiff(turnId: string, diff: string): void {
    this.db.query("UPDATE turns SET diff = ?, updated_at_ms = ? WHERE turn_id = ?").run(diff, Date.now(), turnId);
  }

  private updateTurnPlan(turnId: string, plan: Json): void {
    this.db.query("UPDATE turns SET plan_json = ?, updated_at_ms = ? WHERE turn_id = ?").run(JSON.stringify(plan), Date.now(), turnId);
  }

  private upsertItem(threadId: string, turnId: string, itemId: string | undefined, item: Json, eventType: string): void {
    const id = itemId ?? readString(item, "id") ?? `${eventType}:${Date.now()}`;
    const kind = readString(item, "type");
    const status = readString(item, "status");
    const text = readString(item, "text");
    this.db
      .query(`
        INSERT INTO items (item_id, thread_id, turn_id, kind, status, text, raw_json, updated_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(thread_id, turn_id, item_id) DO UPDATE SET
          kind = COALESCE(excluded.kind, items.kind),
          status = COALESCE(excluded.status, items.status),
          text = COALESCE(excluded.text, items.text),
          raw_json = excluded.raw_json,
          updated_at_ms = excluded.updated_at_ms
      `)
      .run(id, threadId, turnId, kind ?? null, status ?? null, text ?? null, JSON.stringify(item), Date.now());
  }

  private appendItemText(threadId: string, turnId: string, itemId: string, delta: string): void {
    this.db
      .query(`
        INSERT INTO items (item_id, thread_id, turn_id, text, updated_at_ms)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(thread_id, turn_id, item_id) DO UPDATE SET
          text = COALESCE(items.text, '') || excluded.text,
          updated_at_ms = excluded.updated_at_ms
      `)
      .run(itemId, threadId, turnId, delta, Date.now());
  }

  private insertApproval(approval: Approval): void {
    this.db
      .query(`
        INSERT INTO approvals (
          request_id, thread_id, turn_id, item_id, method, kind, status,
          params_json, response_json, created_at_ms, resolved_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL, ?, NULL)
        ON CONFLICT(request_id) DO UPDATE SET
          status = 'pending',
          params_json = excluded.params_json
      `)
      .run(
        String(approval.requestId),
        approval.threadId ?? null,
        approval.turnId ?? null,
        approval.itemId ?? null,
        approval.method,
        approval.kind,
        JSON.stringify(approval.params),
        approval.createdAtMs,
      );
  }

  private resolveApproval(requestId: string | number, response: Json): void {
    this.db
      .query("UPDATE approvals SET status = 'resolved', response_json = ?, resolved_at_ms = ? WHERE request_id = ?")
      .run(JSON.stringify(response), Date.now(), String(requestId));
  }

  private resumeManagedAgentAfterResolvedApproval(requestId: string | number): void {
    const row = this.db
      .query("SELECT thread_id FROM approvals WHERE request_id = ?")
      .get(String(requestId)) as Row | null;
    const threadId = optionalString(row?.thread_id);
    if (!threadId) {
      return;
    }
    const pending = this.db
      .query("SELECT COUNT(*) AS count FROM approvals WHERE thread_id = ? AND status = 'pending'")
      .get(threadId) as Row | null;
    if (Number(pending?.count ?? 0) > 0) {
      return;
    }
    this.db
      .query("UPDATE managed_agents SET status = 'running' WHERE thread_id = ? AND active_turn_id IS NOT NULL AND status = 'waiting_approval'")
      .run(threadId);
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const columns = new Set((this.db.query(`PRAGMA table_info(${table})`).all() as Row[]).map((row) => String(row.name)));
    if (!columns.has(column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  private turnCount(threadId: string, events: Json[]): number {
    const row = this.db.query("SELECT COUNT(*) AS count FROM turns WHERE thread_id = ?").get(threadId) as Row | undefined;
    const count = typeof row?.count === "number" ? row.count : Number(row?.count ?? 0);
    if (count > 0) {
      return count;
    }
    return new Set(events.map((event) => readNestedString(event, "turn", "turnId") ?? readString(event, "turnId")).filter(Boolean)).size;
  }

  private lastActivityAt(threadId: string): number | undefined {
    const row = this.db.query("SELECT MAX(created_at_ms) AS last_activity_at FROM events WHERE thread_id = ?").get(threadId) as Row | undefined;
    return optionalNumber(row?.last_activity_at);
  }
}

function defaultDbPath(): string {
  return process.env.ORCHESTRA_DB ?? join(homedir(), ".orchestra", "orchestra.db");
}

function stringifyOrNull(value: Json | undefined): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function parseJson(value: unknown): Json | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  return JSON.parse(value) as Json;
}

function agentFromRow(row: Row): Agent {
  return {
    threadId: String(row.thread_id),
    sessionId: optionalString(row.session_id),
    name: optionalString(row.name),
    preview: optionalString(row.preview),
    cwd: optionalString(row.cwd),
    model: optionalString(row.model),
    status: (optionalString(row.status) ?? "notLoaded") as RuntimeStatus,
    activeTurnId: optionalString(row.active_turn_id),
    tokenUsage: parseJson(row.token_usage_json),
    createdAt: optionalNumber(row.created_at),
    updatedAt: optionalNumber(row.updated_at),
    raw: parseJson(row.raw_json),
  };
}

function repoFromRow(row: Row): RepoRegistration {
  return {
    id: Number(row.id),
    path: String(row.path),
    baseCommit: String(row.base_commit),
    baseBranch: String(row.base_branch),
    createdAt: Number(row.created_at),
  };
}

function managedAgentFromRow(row: Row): ManagedAgent {
  return {
    id: String(row.id),
    repoId: Number(row.repo_id),
    workspaceName: optionalString(row.workspace_name) ?? legacyWorkspaceName(row),
    repoPath: optionalString(row.repo_path),
    baseCommit: optionalString(row.base_commit),
    sourcePath: optionalString(row.source_path),
    parentAgentId: optionalString(row.parent_agent_id),
    cwd: String(row.cwd),
    branch: String(row.branch),
    threadId: String(row.thread_id),
    activeTurnId: optionalString(row.active_turn_id),
    status: (optionalString(row.status) ?? "notLoaded") as ManagedAgentStatus,
    createdAt: Number(row.created_at),
    onComplete: optionalString(row.on_complete),
  };
}

function legacyWorkspaceName(row: Row): string {
  const repoPath = optionalString(row.repo_path);
  const cwd = optionalString(row.cwd);
  return basename(repoPath ?? cwd ?? "workspace");
}

function managedStatusFromRuntime(status: RuntimeStatus): ManagedAgentStatus {
  if (status === "active") {
    return "running";
  }
  if (status === "systemError") {
    return "error";
  }
  if (status === "idle") {
    return "idle";
  }
  return "notLoaded";
}

function managedStatusFromTurn(status: Turn["status"]): ManagedAgentStatus {
  if (status === "inProgress") {
    return "running";
  }
  if (status === "failed") {
    return "error";
  }
  return "idle";
}

function approvalFromRow(row: Row): Approval {
  const params = parseJson(row.params_json) ?? {};
  return {
    requestId: String(row.request_id),
    method: String(row.method),
    kind: String(row.kind) as Approval["kind"],
    threadId: optionalString(row.thread_id),
    turnId: optionalString(row.turn_id),
    itemId: optionalString(row.item_id),
    params,
    createdAtMs: optionalNumber(row.created_at_ms) ?? Date.now(),
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function asRecord(value: Json | undefined): Record<string, Json | undefined> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function readString(value: Json | undefined, key: string): string | undefined {
  const record = asRecord(value);
  const nested = record?.[key];
  return typeof nested === "string" ? nested : undefined;
}

function readNestedString(value: Json | undefined, objectKey: string, key: string): string | undefined {
  const record = asRecord(value);
  const nested = asRecord(record?.[objectKey]);
  const result = nested?.[key];
  return typeof result === "string" ? result : undefined;
}

function lastAssistantMessage(events: Json[]): string | undefined {
  const streams = new Map<string, string>();
  let latest = "";
  for (const event of events) {
    const type = readString(event, "type");
    if (type === "stream.agent") {
      const itemId = readString(event, "itemId");
      const delta = readString(event, "delta") ?? "";
      if (itemId) {
        const next = (streams.get(itemId) ?? "") + delta;
        streams.set(itemId, next);
        latest = next;
      }
      continue;
    }
    if (type === "item.completed") {
      const item = asRecord(asRecord(event)?.item);
      if (readString(item, "type") === "agentMessage") {
        latest = readString(item, "text") ?? latest;
      }
    }
  }
  return latest || undefined;
}

function lastTurnSummary(events: Json[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const type = readString(event, "type");
    if (type !== "turn.started" && type !== "turn.completed") {
      continue;
    }
    const turn = asRecord(asRecord(event)?.turn);
    const status = readString(turn, "status") ?? (type === "turn.started" ? "inProgress" : "completed");
    const turnId = readString(turn, "turnId");
    const message = tail(lastAssistantMessage(events.slice(0, index + 1)), 160);
    return [type === "turn.started" ? "started" : "completed", status, turnId, message].filter(Boolean).join(" · ");
  }
  return undefined;
}

function tail(text: string | undefined, max = 500): string | undefined {
  if (!text) {
    return undefined;
  }
  const trimmed = text.trim();
  return trimmed.length > max ? trimmed.slice(-max) : trimmed;
}

function tokensUsed(value: Json | undefined): number | undefined {
  const total = findTokenTotal(value);
  return total === undefined || !Number.isFinite(total) ? undefined : total;
}

function findTokenTotal(value: Json | undefined): number | undefined {
  if (value === undefined || value === null || typeof value !== "object") {
    return undefined;
  }
  if (Array.isArray(value)) {
    const nested = value.map(findTokenTotal).filter((n): n is number => typeof n === "number");
    return nested.length ? nested.reduce((sum, n) => sum + n, 0) : undefined;
  }
  const record = value as Record<string, Json | undefined>;
  for (const key of ["totalTokens", "total_tokens", "tokensUsed", "tokens_used"]) {
    if (typeof record[key] === "number") {
      return record[key];
    }
  }
  const nested = Object.values(record).map(findTokenTotal).filter((n): n is number => typeof n === "number");
  return nested.length ? nested.reduce((sum, n) => sum + n, 0) : undefined;
}
