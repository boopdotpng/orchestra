import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexV2Backend } from "../src/backend/codex-v2/CodexV2Backend";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("CodexV2Backend", () => {
  test("forces default service tier on app-server thread and turn requests", async () => {
    const root = tempRoot();
    const capture = join(root, "requests.jsonl");
    const server = join(root, "fake-app-server.cjs");
    writeFileSync(server, fakeJsonRpcServer());

    const backend = new CodexV2Backend({
      command: "node",
      args: [server],
      cwd: root,
    });
    process.env.ORCHESTRA_CAPTURE = capture;

    await backend.connect();
    await backend.startThread({ cwd: root, model: "gpt-5.5" });
    await backend.resumeThread("thread-1", { cwd: root, model: "gpt-5.5" });
    await backend.startTurn("thread-1", "do the thing", { model: "gpt-5.5" });
    await backend.close();

    const messages = readFileSync(capture, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method: string; params: { approvalPolicy?: string; sandbox?: string; serviceTier?: string } });
    expect(messages.find((message) => message.method === "thread/start")?.params.serviceTier).toBe("default");
    expect(messages.find((message) => message.method === "thread/start")?.params.approvalPolicy).toBe("never");
    expect(messages.find((message) => message.method === "thread/start")?.params.sandbox).toBe("danger-full-access");
    expect(messages.find((message) => message.method === "thread/resume")?.params.serviceTier).toBe("default");
    expect(messages.find((message) => message.method === "turn/start")?.params.serviceTier).toBe("default");
  });

  test("passes configured priority service tier to app-server requests", async () => {
    const root = tempRoot();
    const capture = join(root, "requests.jsonl");
    const server = join(root, "fake-app-server.cjs");
    writeFileSync(server, fakeJsonRpcServer());

    const backend = new CodexV2Backend({
      command: "node",
      args: [server],
      cwd: root,
    });
    process.env.ORCHESTRA_CAPTURE = capture;

    await backend.connect();
    await backend.startThread({ cwd: root, model: "gpt-5.5", serviceTier: "priority" });
    await backend.resumeThread("thread-1", { cwd: root, model: "gpt-5.5", serviceTier: "priority" });
    await backend.startTurn("thread-1", "do the thing", { model: "gpt-5.5", serviceTier: "priority" });
    await backend.close();

    const messages = readFileSync(capture, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method: string; params: { serviceTier?: string } });
    expect(messages.find((message) => message.method === "thread/start")?.params.serviceTier).toBe("priority");
    expect(messages.find((message) => message.method === "thread/resume")?.params.serviceTier).toBe("priority");
    expect(messages.find((message) => message.method === "turn/start")?.params.serviceTier).toBe("priority");
  });

  test("surfaces child stderr when the app-server exits", async () => {
    const root = tempRoot();
    const server = join(root, "broken-app-server.cjs");
    writeFileSync(server, 'process.stderr.write("Error: failed to connect to socket at control.sock\\n");process.exit(1);\n');

    const backend = new CodexV2Backend({
      command: "node",
      args: [server],
      cwd: root,
    });

    await backend.connect();
    await expect(backend.initialize()).rejects.toThrow(/exited \(1\).*failed to connect to socket at control\.sock/s);
  });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "orchestra-backend-test-"));
  roots.push(root);
  return root;
}

function fakeJsonRpcServer(): string {
  return `
const fs = require("node:fs");
const readline = require("node:readline");
const capture = process.env.ORCHESTRA_CAPTURE;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  fs.appendFileSync(capture, line + "\\n");
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  let result = {};
  if (message.method === "thread/start" || message.method === "thread/resume") {
    result = { thread: { id: "thread-1", sessionId: "session-1", cwd: message.params.cwd || "", preview: "", status: { type: "idle" } } };
  } else if (message.method === "turn/start") {
    result = { turn: { id: "turn-1", status: "inProgress" } };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
});
`;
}
