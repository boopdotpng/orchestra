import { join } from "node:path";
import type { AgentManager } from "../manager/AgentManager";
import type { OrchestraStore } from "../store/OrchestraStore";
import type { WorkspaceManager } from "../workspace/WorkspaceManager";
import type { AgentEvent, Json } from "../domain/types";
import { loadOrchestraConfig, normalizeServiceTier, writeOrchestraConfig, type ConfigScope } from "../config";
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
    return jsonResponse({
      agents: deps.store.listManagedAgentSummaries(),
      approvals: deps.store.listPendingApprovals(),
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
      },
      {
        scope: configScope(body.scope),
        cwd: deps.cwd,
      },
    );
    deps.workspace.updateDefaults({
      model: config.model,
      serviceTier: config.serviceTier,
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
    return jsonResponse({ agents: await deps.workspace.teardownTarget(requiredString(body.target, "target")) });
  }

  if (request.method === "GET" && url.pathname === "/agents") {
    return jsonResponse({ agents: deps.store.listManagedAgents() });
  }

  if (request.method === "POST" && url.pathname === "/agents") {
    const body = await readBody(request);
    const prompt = requiredString(body.prompt, "prompt");
    const agents = await deps.workspace.create(requiredString(body.dir, "dir"), {
      count: typeof body.count === "number" ? body.count : 1,
      prompt,
      onComplete: typeof body.onComplete === "string" ? body.onComplete : typeof body.on_complete === "string" ? body.on_complete : undefined,
      model: typeof body.model === "string" ? body.model : undefined,
      serviceTier: serviceTier(body.serviceTier ?? body.service_tier),
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

function approvalPolicy(value: unknown) {
  return value === "untrusted" || value === "on-failure" || value === "on-request" || value === "never" ? value : undefined;
}

function sandboxMode(value: unknown) {
  return value === "read-only" || value === "workspace-write" || value === "danger-full-access" ? value : undefined;
}

function serviceTier(value: unknown) {
  return normalizeServiceTier(value);
}

function configScope(value: unknown): ConfigScope {
  return value === "local" ? "local" : "global";
}

function eventStream(request: Request, deps: OrchestraHttpDeps, agentId?: string): Response {
  const threadId = agentId ? deps.workspace.requiredAgent(agentId).threadId : undefined;
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: unknown, type = "message") => {
        controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`));
      };
      send({ type: "hello", scope: agentId ? "agent" : "all", agentId }, "hello");
      unsubscribe = deps.manager.onEvent((event) => {
        if (!threadId || eventThreadId(event) === threadId) {
          send(event);
        }
      });
      request.signal.addEventListener("abort", () => {
        unsubscribe?.();
        controller.close();
      });
    },
    cancel() {
      unsubscribe?.();
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
