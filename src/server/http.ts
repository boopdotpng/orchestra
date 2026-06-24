import { join } from "node:path";
import type { AgentManager } from "../manager/AgentManager";
import type { OrchestraStore } from "../store/OrchestraStore";
import type { WorkspaceManager } from "../workspace/WorkspaceManager";
import type { AgentEvent, Approval, Json, ManagedAgentSummary } from "../domain/types";
import { loadOrchestraConfig, normalizeReasoningEffort, normalizeServiceTier, writeOrchestraConfig, type ConfigScope } from "../config";
import { ORCHESTRA_API_ROUTES } from "./api";

const UI_FILE = join(import.meta.dir, "..", "ui", "index.html");

export type OrchestraHttpDeps = {
  store: OrchestraStore;
  manager: AgentManager;
  workspace: WorkspaceManager;
  cwd?: string | undefined;
};

export function createOrchestraHandler(deps: OrchestraHttpDeps) {
  return async (request: Request): Promise<Response> => {
    try {
      return await route(request, deps);
    } catch (error) {
      return jsonResponse(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        500,
      );
    }
  };
}

async function route(request: Request, deps: OrchestraHttpDeps): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/ui" || url.pathname === "/ui/")) {
    const file = Bun.file(UI_FILE);
    if (await file.exists()) {
      return new Response(file, {
        headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders() },
      });
    }
    return textResponse("UI not found", 404);
  }

  if (request.method === "GET" && url.pathname === "/health") {
    return jsonResponse({ ok: true });
  }

  if (request.method === "GET" && url.pathname === "/routes") {
    return jsonResponse({ routes: ORCHESTRA_API_ROUTES });
  }

  if (request.method === "GET" && url.pathname === "/status") {
    const workspace = workspaceNameParam(url);
    const agents = deps.store.listManagedAgentSummaries(workspace);
    const approvals = workspace ? deps.store.listPendingApprovals(agents.map((agent) => agent.threadId)) : deps.store.listPendingApprovals();
    return jsonResponse({
      agents,
      approvals: filterApprovalsByAgents(approvals, agents, workspace),
      rateLimits: deps.manager.rateLimits ?? null,
    });
  }

  if (request.method === "GET" && url.pathname === "/config") {
    return jsonResponse(loadOrchestraConfig({ cwd: deps.cwd }));
  }

  if (request.method === "PATCH" && url.pathname === "/config") {
    const body = await readBody(request);
    const config = writeOrchestraConfig(
      {
        model: typeof body.model === "string" ? body.model : undefined,
        fastMode: typeof body.fastMode === "boolean" ? body.fastMode : typeof body.fast_mode === "boolean" ? body.fast_mode : undefined,
        serviceTier: serviceTier(body.serviceTier ?? body.service_tier),
        reasoningEffort: reasoningEffortPatch(body.reasoningEffort ?? body.reasoning_effort ?? body.model_reasoning_effort),
      },
      {
        scope: configScope(body.scope),
        cwd: deps.cwd,
      },
    );
    deps.workspace.updateDefaults({
      model: config.model,
      serviceTier: config.serviceTier,
      reasoningEffort: config.reasoningEffort,
    });
    return jsonResponse(config);
  }

  if (request.method === "GET" && url.pathname === "/models") {
    return jsonResponse(await deps.manager.listModels());
  }

  if (request.method === "GET" && url.pathname === "/events") {
    return eventStream(request, deps);
  }

  if (request.method === "POST" && url.pathname === "/repos/register") {
    const body = await readBody(request);
    return jsonResponse(deps.workspace.register(requiredString(body.dir, "dir")));
  }

  if (request.method === "POST" && url.pathname === "/repos/teardown") {
    const body = await readBody(request);
    const agents = await deps.workspace.teardown(requiredString(body.dir, "dir"));
    return jsonResponse({ agents });
  }

  if (request.method === "POST" && url.pathname === "/teardown") {
    const body = await readBody(request);
    const workspace = workspaceNameBody(body);
    const agents = teardownAgentIds(body);
    if (workspace && agents.length) {
      throw new Error("teardown requires workspace or agents, not both");
    }
    if (workspace) {
      return jsonResponse({ agents: await deps.workspace.teardownWorkspace(workspace) });
    }
    return jsonResponse({ agents: await deps.workspace.teardownAgents(agents) });
  }

  if (request.method === "POST" && url.pathname === "/diff") {
    const body = await readBody(request);
    return textResponse(deps.workspace.diffAgents(agentIds(body)));
  }

  if (request.method === "GET" && url.pathname === "/standouts") {
    return textResponse(deps.workspace.standouts(workspaceNameParam(url)));
  }

  if (request.method === "POST" && url.pathname === "/broadcast") {
    const body = await readBody(request);
    return jsonResponse(
      await deps.workspace.broadcast(requiredString(body.input, "input"), {
        workspaceName: workspaceNameBody(body),
        agentIds: optionalAgentIds(body),
        model: typeof body.model === "string" ? body.model : undefined,
        serviceTier: serviceTier(body.serviceTier ?? body.service_tier),
        reasoningEffort: reasoningEffort(body.reasoningEffort ?? body.reasoning_effort ?? body.model_reasoning_effort),
        approvalPolicy: approvalPolicy(body.approvalPolicy),
        sandbox: sandboxMode(body.sandbox),
      }),
    );
  }

  if (request.method === "GET" && url.pathname === "/agents") {
    return jsonResponse({ agents: deps.store.listManagedAgents() });
  }

  if (request.method === "POST" && url.pathname === "/agents") {
    const body = await readBody(request);
    const name = requiredString(body.name, "name");
    const agents = await deps.workspace.create(requiredString(body.dir, "dir"), {
      workspaceName: name,
      explore: body.explore === true,
      count: typeof body.count === "number" ? body.count : undefined,
      concurrency: typeof body.concurrency === "number" ? body.concurrency : undefined,
      prompt: typeof body.prompt === "string" ? body.prompt : undefined,
      sharedPrompt: typeof body.sharedPrompt === "string" ? body.sharedPrompt : typeof body.shared_prompt === "string" ? body.shared_prompt : undefined,
      promptTemplate: typeof body.promptTemplate === "string" ? body.promptTemplate : typeof body.prompt_template === "string" ? body.prompt_template : undefined,
      agents: focusedAgents(body.agents),
      onComplete: typeof body.onComplete === "string" ? body.onComplete : typeof body.on_complete === "string" ? body.on_complete : undefined,
      model: typeof body.model === "string" ? body.model : undefined,
      serviceTier: serviceTier(body.serviceTier ?? body.service_tier),
      reasoningEffort: reasoningEffort(body.reasoningEffort ?? body.reasoning_effort ?? body.model_reasoning_effort),
      approvalPolicy: approvalPolicy(body.approvalPolicy),
      sandbox: sandboxMode(body.sandbox),
    });
    return jsonResponse({ agents });
  }

  if (parts[0] === "agents" && parts[1]) {
    const id = parts[1];
    if (request.method === "GET" && parts.length === 2) {
      return jsonResponse(deps.workspace.requiredAgent(id));
    }
    if (request.method === "GET" && parts[2] === "events") {
      return eventStream(request, deps, id);
    }
    if (request.method === "POST" && parts[2] === "steer") {
      const body = await readBody(request);
      return jsonResponse(await deps.workspace.steer(id, requiredString(body.input, "input"), {
        model: typeof body.model === "string" ? body.model : undefined,
        serviceTier: serviceTier(body.serviceTier ?? body.service_tier),
        reasoningEffort: reasoningEffort(body.reasoningEffort ?? body.reasoning_effort ?? body.model_reasoning_effort),
        approvalPolicy: approvalPolicy(body.approvalPolicy),
        sandbox: sandboxMode(body.sandbox),
      }));
    }
    if (request.method === "POST" && parts[2] === "interrupt") {
      return jsonResponse(await deps.workspace.interrupt(id));
    }
    if (request.method === "POST" && parts[2] === "remove") {
      return jsonResponse({ agent: await deps.workspace.remove(id) });
    }
    if (request.method === "GET" && parts[2] === "turn") {
      return jsonResponse(deps.workspace.turn(id));
    }
    if (request.method === "GET" && parts[2] === "history") {
      return jsonResponse(deps.workspace.history(id));
    }
    if (request.method === "GET" && parts[2] === "thread") {
      return jsonResponse(await deps.workspace.readThread(id));
    }
    if (request.method === "GET" && parts[2] === "diff") {
      return textResponse(deps.workspace.diff(id));
    }
    if (request.method === "POST" && parts[2] === "exec") {
      const body = await readBody(request);
      return jsonResponse(deps.workspace.exec(id, requiredString(body.cmd, "cmd")));
    }
    if (request.method === "POST" && parts[2] === "read") {
      const body = await readBody(request);
      return jsonResponse({ path: deps.workspace.readTranscript(id, Boolean(body.json)) });
    }
  }

  if (request.method === "GET" && url.pathname === "/approvals") {
    return jsonResponse({ approvals: deps.store.listPendingApprovals() });
  }

  if (request.method === "POST" && parts[0] === "approvals" && parts[1] && parts[2] === "respond") {
    const body = await readBody(request);
    const result = body.result ?? (typeof body.decision === "string" ? { decision: body.decision } : { decision: "accept" });
    await deps.manager.respondRaw(parts[1], result as Json);
    return jsonResponse({ ok: true });
  }

  if (request.method === "POST" && parts[0] === "approvals" && parts[1] && parts[2] === "approve") {
    await deps.manager.approve(parts[1], "accept");
    return jsonResponse({ ok: true });
  }

  if (request.method === "POST" && parts[0] === "approvals" && parts[1] && parts[2] === "deny") {
    await deps.manager.deny(parts[1]);
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ error: "not found" }, 404);
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-length") === "0") {
    return {};
  }
  const text = await request.text();
  if (!text) {
    return {};
  }
  return JSON.parse(text) as Record<string, unknown>;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function textResponse(text: string, status = 200): Response {
  return new Response(text, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", ...corsHeaders() },
  });
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function agentIds(body: Record<string, unknown>): string[] {
  if (Array.isArray(body.agents)) {
    return body.agents.map((value) => (typeof value === "string" ? value : "")).filter(Boolean);
  }
  if (Array.isArray(body.ids)) {
    return body.ids.map((value) => (typeof value === "string" ? value : "")).filter(Boolean);
  }
  if (typeof body.agent === "string") {
    return [body.agent];
  }
  if (typeof body.id === "string") {
    return [body.id];
  }
  throw new Error("agent id or agents array is required");
}

function optionalAgentIds(body: Record<string, unknown>): string[] {
  const ids: string[] = [];
  if (Array.isArray(body.agents)) {
    ids.push(...body.agents.map((value) => (typeof value === "string" ? value : "")).filter(Boolean));
  }
  if (Array.isArray(body.ids)) {
    ids.push(...body.ids.map((value) => (typeof value === "string" ? value : "")).filter(Boolean));
  }
  if (typeof body.agent === "string") {
    ids.push(body.agent);
  }
  if (typeof body.id === "string") {
    ids.push(body.id);
  }
  return ids;
}

function teardownAgentIds(body: Record<string, unknown>): string[] {
  if (body.agents === undefined) {
    return [];
  }
  if (!Array.isArray(body.agents)) {
    throw new Error("agents must be an array");
  }
  return body.agents.map((value, index) => {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`agents[${index}] must be a 4-digit agent id`);
    }
    return value;
  });
}

function workspaceNameBody(body: Record<string, unknown>): string | undefined {
  return typeof body.workspace === "string" ? body.workspace : typeof body.workspaceName === "string" ? body.workspaceName : undefined;
}

function focusedAgents(value: unknown): Array<{ focus: string }> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("agents must be an array");
  }
  return value.map((agent, index) => {
    if (!agent || typeof agent !== "object" || !("focus" in agent) || typeof agent.focus !== "string") {
      throw new Error(`agents[${index}].focus is required`);
    }
    return { focus: agent.focus };
  });
}

function approvalPolicy(value: unknown) {
  return value === "untrusted" || value === "on-failure" || value === "on-request" || value === "never" ? value : undefined;
}

function sandboxMode(value: unknown) {
  return value === "read-only" || value === "workspace-write" || value === "danger-full-access" ? value : undefined;
}

function serviceTier(value: unknown) {
  return normalizeServiceTier(value);
}

function reasoningEffort(value: unknown) {
  return normalizeReasoningEffort(value);
}

function reasoningEffortPatch(value: unknown) {
  return value === null ? null : normalizeReasoningEffort(value);
}

function configScope(value: unknown): ConfigScope {
  return value === "local" ? "local" : "global";
}

function workspaceNameParam(url: URL): string | undefined {
  return url.searchParams.get("workspace") ?? url.searchParams.get("workspaceName") ?? undefined;
}

function filterApprovalsByAgents(approvals: Approval[], agents: ManagedAgentSummary[], workspace: string | undefined): Approval[] {
  if (!workspace) {
    return approvals;
  }
  const threadIds = new Set(agents.map((agent) => agent.threadId));
  return approvals.filter((approval) => approval.threadId !== undefined && threadIds.has(approval.threadId));
}

function sameWorkspaceName(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function eventStream(request: Request, deps: OrchestraHttpDeps, agentId?: string): Response {
  const threadId = agentId ? deps.workspace.requiredAgent(agentId).threadId : undefined;
  const overview = !agentId && new URL(request.url).searchParams.get("overview") === "1";
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Map<string, AgentEvent>();

  const clearFlushTimer = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: unknown, type = "message") => {
        controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`));
      };
      const flush = () => {
        flushTimer = undefined;
        for (const event of pending.values()) {
          send(event);
        }
        pending.clear();
      };
      const sendOverview = (event: AgentEvent) => {
        const eventThread = eventThreadId(event);
        if (!eventThread) {
          send(event);
          return;
        }
        pending.set(eventThread, event);
        if (!flushTimer) {
          flushTimer = setTimeout(flush, 150);
        }
      };
      send({ type: "hello", scope: agentId ? "agent" : "all", agentId }, "hello");
      unsubscribe = deps.manager.onEvent((event) => {
        if (!threadId || eventThreadId(event) === threadId) {
          if (overview) {
            sendOverview(event);
          } else {
            send(event);
          }
        }
      });
      request.signal.addEventListener("abort", () => {
        unsubscribe?.();
        clearFlushTimer();
        pending.clear();
        controller.close();
      });
    },
    cancel() {
      unsubscribe?.();
      clearFlushTimer();
      pending.clear();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...corsHeaders(),
    },
  });
}

function eventThreadId(event: AgentEvent): string | undefined {
  if ("threadId" in event && typeof event.threadId === "string") {
    return event.threadId;
  }
  if (event.type === "agent.started") {
    return event.agent.threadId;
  }
  if (event.type === "approval.requested") {
    return event.approval.threadId;
  }
  return undefined;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
  };
}
