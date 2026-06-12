import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrchestraStore } from "../src/store/OrchestraStore";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

type RecordedRequest = { method: string; path: string; body: unknown };

let server: ReturnType<typeof Bun.serve> | undefined;
const roots: string[] = [];

afterEach(() => {
  server?.stop(true);
  server = undefined;
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

// SAFETY: these tests spawn the real CLI. The CLI falls back to local
// execution against the real ~/.orchestra state when the server URL is
// unreachable, so every invocation MUST use an isolated --db and a live
// (async-served) stub. Never use Bun.spawnSync here: it blocks the event
// loop, the in-process stub can never respond, and the CLI falls back.
describe("orchestra CLI daemon routing", () => {
  test("routes create with required workspace name and dir", async () => {
    const requests: RecordedRequest[] = [];
    const baseUrl = startStubServer(requests, {
      "POST /agents": { agents: [{ id: "ab12", status: "running", cwd: "/tmp/runs/repo/ab12", threadId: "thread-1" }] },
    });
    const root = mkdtempSync(join(tmpdir(), "orchestra-cli-source-"));
    roots.push(root);

    const proc = await runCli(["create", "auth cleanup", root, "--prompt", "ship it", "-n", "2", "--url", baseUrl]);
    expect(proc.stderr).toBe("");
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout).toContain("created 1 agent");
    expect(proc.stdout).toContain("ab12");
    expect(proc.stdout).toContain("running");
    expect(proc.stdout).toContain("/tmp/runs/repo/ab12");
    const create = requests.find((request) => request.path === "/agents");
    expect(create?.body).toMatchObject({ name: "auth cleanup", dir: root, prompt: "ship it", count: 2 });
  });

  test("routes interrupt through a reachable orchestra server", async () => {
    const requests: RecordedRequest[] = [];
    const baseUrl = startStubServer(requests, {
      "POST /agents/ab12/interrupt": { ok: true, turnId: "turn-1" },
    });

    const proc = await runCli(["interrupt", "ab12", "--url", baseUrl]);
    expect(proc.stderr).toBe("");
    expect(proc.exitCode).toBe(0);
    expect(JSON.parse(proc.stdout) as unknown).toEqual({ ok: true, turnId: "turn-1" });
    expect(requests.map(({ method, path }) => ({ method, path }))).toContainEqual({
      method: "POST",
      path: "/agents/ab12/interrupt",
    });
  });

  test("routes steer with explicit overrides only", async () => {
    const requests: RecordedRequest[] = [];
    const baseUrl = startStubServer(requests, {
      "POST /agents/ab12/steer": { turnId: "turn-2" },
    });

    const proc = await runCli(["steer", "ab12", "focus", "on", "tests", "--model", "gpt-5.5", "--url", baseUrl]);
    expect(proc.exitCode).toBe(0);
    const steer = requests.find((request) => request.path === "/agents/ab12/steer");
    expect(steer?.body).toEqual({ input: "focus on tests", model: "gpt-5.5" });
  });

  test("routes teardown of one agent id through the orchestra server", async () => {
    const requests: RecordedRequest[] = [];
    const baseUrl = startStubServer(requests, {
      "POST /teardown": { agents: [{ id: "ab12", cwd: "/tmp/runs/repo/ab12" }] },
    });

    const proc = await runCli(["teardown", "ab12", "--url", baseUrl]);
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout).toContain("removed 1 agent");
    expect(proc.stdout).toContain("ab12");
    expect(proc.stdout).toContain("/tmp/runs/repo/ab12");
    const teardown = requests.find((request) => request.path === "/teardown");
    expect(teardown?.body).toEqual({ target: "ab12" });
  });

  test("routes teardown of a bare repo name without resolving it as a path", async () => {
    const requests: RecordedRequest[] = [];
    const baseUrl = startStubServer(requests, {
      "POST /teardown": { agents: [{ id: "ab12", cwd: "/tmp/runs/bh-tournament/ab12" }] },
    });

    const proc = await runCli(["teardown", "bh-tournament", "--url", baseUrl]);
    expect(proc.exitCode).toBe(0);
    const teardown = requests.find((request) => request.path === "/teardown");
    expect(teardown?.body).toEqual({ target: "bh-tournament" });
  });

  test("prints the server error message on failure", async () => {
    const requests: RecordedRequest[] = [];
    const baseUrl = startStubServer(requests, {});

    const proc = await runCli(["interrupt", "abcd", "--url", baseUrl]);
    expect(proc.exitCode).toBe(1);
    expect(proc.stderr).toContain("unknown agent id: abcd");
  });
});

describe("orchestra CLI local formatting", () => {
  test("prints readable status without putting long output in the table", async () => {
    const proc = await runCli(["status"], (dbPath) => {
      const store = new OrchestraStore(dbPath);
      const repo = store.upsertRepo({
        path: "/tmp/repos/blackhole-py",
        baseCommit: "abcdef",
        baseBranch: "main",
        createdAt: 1,
      });
      store.insertManagedAgent({
        id: "ab12",
        repoId: repo.id,
        workspaceName: "trace work",
        repoPath: repo.path,
        baseCommit: repo.baseCommit,
        cwd: "/tmp/runs/blackhole-py/ab12",
        branch: "orchestra/ab12",
        threadId: "thread-1",
        status: "idle",
        createdAt: 1,
      });
      store.applyEvent({
        type: "agent.started",
        agent: {
          threadId: "thread-1",
          cwd: "/tmp/runs/blackhole-py/ab12",
          status: "idle",
        },
      });
      store.applyEvent({
        type: "agent.tokenUsage",
        threadId: "thread-1",
        tokenUsage: { totalTokens: 1_234_567 },
      });
      store.applyEvent({
        type: "turn.completed",
        threadId: "thread-1",
        turn: { threadId: "thread-1", turnId: "turn-1", status: "completed" },
      });
      store.applyEvent({
        type: "item.completed",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        item: {
          type: "agentMessage",
          text: "This is a deliberately long assistant tail that belongs below the table, where it can be scanned without widening every status column.",
        },
      });
      store.close();
    });

    expect(proc.stderr).toBe("");
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout).toContain("agents 1  idle 1");
    expect(proc.stdout).toContain("id    workspace");
    expect(proc.stdout).toContain("tokens");
    expect(proc.stdout).toContain("1.2M");
    expect(proc.stdout).toContain("last output");
    expect(proc.stdout).toContain("ab12  This is a deliberately long assistant tail");
  });
});

function startStubServer(requests: RecordedRequest[], routes: Record<string, unknown>): string {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === "POST" ? ((await request.json().catch(() => ({}))) as unknown) : undefined;
      requests.push({ method: request.method, path: url.pathname, body });
      if (request.method === "GET" && url.pathname === "/health") {
        return Response.json({ ok: true });
      }
      const route = routes[`${request.method} ${url.pathname}`];
      if (route !== undefined) {
        return Response.json(route);
      }
      return Response.json({ error: `unknown agent id: ${url.pathname.split("/")[2] ?? ""}` }, { status: 500 });
    },
  });
  return `http://127.0.0.1:${server.port}`;
}

async function runCli(args: string[], prepareDb?: (dbPath: string) => void): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const root = mkdtempSync(join(tmpdir(), "orchestra-cli-test-"));
  roots.push(root);
  const dbPath = join(root, "orchestra.db");
  prepareDb?.(dbPath);
  // Isolated --db and runs root so a fallback to local execution can never
  // touch real orchestra state.
  const proc = Bun.spawn(["bun", CLI, ...args, "--db", dbPath], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ORCHESTRA_URL: "", ORCHESTRA_RUNS: join(root, "runs"), HOME: root },
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, stdout, stderr };
}
