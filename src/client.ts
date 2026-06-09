import type {
  AgentsResponse,
  AgentHistoryResponse,
  ConfigResponse,
  ConfigUpdateRequest,
  CreateAgentsRequest,
  CreateAgentsResponse,
  ModelsResponse,
  RegisterRepoRequest,
  RegisterRepoResponse,
  RemoveAgentResponse,
  StatusResponse,
  TeardownRepoRequest,
  TeardownRepoResponse,
} from "./server/api";

export class OrchestraClient {
  constructor(private readonly baseUrl = "http://127.0.0.1:5751") {}

  health(): Promise<{ ok: true }> {
    return this.get("/health");
  }

  routes() {
    return this.get("/routes");
  }

  status(): Promise<StatusResponse> {
    return this.get("/status");
  }

  config(): Promise<ConfigResponse> {
    return this.get("/config");
  }

  updateConfig(input: ConfigUpdateRequest): Promise<ConfigResponse> {
    return this.patch("/config", input);
  }

  models(): Promise<ModelsResponse> {
    return this.get("/models");
  }

  register(input: RegisterRepoRequest): Promise<RegisterRepoResponse> {
    return this.post("/repos/register", input);
  }

  teardown(input: TeardownRepoRequest): Promise<TeardownRepoResponse> {
    return this.post("/repos/teardown", input);
  }

  agents(): Promise<AgentsResponse> {
    return this.get("/agents");
  }

  createAgents(input: CreateAgentsRequest): Promise<CreateAgentsResponse> {
    return this.post("/agents", input);
  }

  agent(id: string) {
    return this.get(`/agents/${encodeURIComponent(id)}`);
  }

  turn(id: string) {
    return this.get(`/agents/${encodeURIComponent(id)}/turn`);
  }

  history(id: string): Promise<AgentHistoryResponse> {
    return this.get(`/agents/${encodeURIComponent(id)}/history`);
  }

  thread(id: string) {
    return this.get(`/agents/${encodeURIComponent(id)}/thread`);
  }

  diff(id: string): Promise<string> {
    return this.text(`/agents/${encodeURIComponent(id)}/diff`);
  }

  steer(id: string, input: Omit<CreateAgentsRequest, "dir" | "count" | "prompt"> & { input: string }) {
    return this.post(`/agents/${encodeURIComponent(id)}/steer`, input);
  }

  interrupt(id: string) {
    return this.post(`/agents/${encodeURIComponent(id)}/interrupt`, {});
  }

  remove(id: string): Promise<RemoveAgentResponse> {
    return this.post(`/agents/${encodeURIComponent(id)}/remove`, {});
  }

  exec(id: string, cmd: string) {
    return this.post(`/agents/${encodeURIComponent(id)}/exec`, { cmd });
  }

  read(id: string, json = false): Promise<{ path: string }> {
    return this.post(`/agents/${encodeURIComponent(id)}/read`, { json });
  }

  approvals() {
    return this.get("/approvals");
  }

  respondApproval(requestId: string, result: unknown) {
    return this.post(`/approvals/${encodeURIComponent(requestId)}/respond`, { result });
  }

  approve(requestId: string) {
    return this.post(`/approvals/${encodeURIComponent(requestId)}/approve`, {});
  }

  deny(requestId: string) {
    return this.post(`/approvals/${encodeURIComponent(requestId)}/deny`, {});
  }

  eventSource(path = "/events"): EventSource {
    return new EventSource(new URL(path, this.baseUrl).toString());
  }

  private get<T>(path: string): Promise<T> {
    return this.request(path, { method: "GET" });
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.request(path, { method: "POST", body: JSON.stringify(body) });
  }

  private patch<T>(path: string, body: unknown): Promise<T> {
    return this.request(path, { method: "PATCH", body: JSON.stringify(body) });
  }

  private async text(path: string): Promise<string> {
    const response = await fetch(new URL(path, this.baseUrl), { method: "GET" });
    if (!response.ok) {
      throw new Error(await response.text());
    }
    return response.text();
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(new URL(path, this.baseUrl), {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    if (!response.ok) {
      throw new Error(await response.text());
    }
    return response.json() as Promise<T>;
  }
}
