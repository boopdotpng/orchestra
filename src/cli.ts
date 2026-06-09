#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { CodexV2Backend } from "./backend/codex-v2/CodexV2Backend";
import { AgentManager } from "./manager/AgentManager";
import { OrchestraStore } from "./store/OrchestraStore";
import { readPromptFile, WorkspaceManager } from "./workspace/WorkspaceManager";
import { DEFAULT_MODEL, loadOrchestraConfig, normalizeServiceTier, type OrchestraConfig } from "./config";
import type { AgentEvent, Approval, ApprovalPolicy, SandboxMode, StartAgentOptions } from "./domain/types";

type ParsedArgs = {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
};

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  if (args.command === "help" || args.command === "--help" || args.command === "-h") {
    printHelp();
    return;
  }

  if (args.command === "daemon") {
    await runDaemonCommand(args.positionals[0] ?? "status");
    return;
  }

  const config = loadOrchestraConfig({
    path: typeof args.flags.config === "string" ? args.flags.config : undefined,
  });
  const store = new OrchestraStore(typeof args.flags.db === "string" ? args.flags.db : undefined);
  const backend = new CodexV2Backend({
    args: transportArgs(args),
    cwd: process.cwd(),
  });
  const manager = new AgentManager(backend, { store });
  const workspace = new WorkspaceManager(store, manager, {
    model: config.model,
    serviceTier: config.serviceTier,
  });

  try {
    switch (args.command) {
      case "register":
        register(workspace, args);
        break;
      case "create":
        await create(workspace, args, config);
        break;
      case "teardown":
        await teardown(workspace, args);
        break;
      case "ls":
        ls(store);
        break;
      case "diff":
        diff(workspace, args);
        break;
      case "exec":
        execAgent(workspace, args);
        break;
      case "turn":
        turn(workspace, args);
        break;
      case "tail":
        await tail(manager, workspace, args);
        break;
      case "run":
        await run(manager, args, config);
        break;
      case "start":
        await start(manager, args, config);
        break;
      case "send":
        await send(manager, args, config);
        break;
      case "list":
        await list(manager, args);
        break;
      case "read":
        read(workspace, args);
        break;
      case "interrupt":
        await interrupt(workspace, args);
        break;
      case "steer":
        await steer(workspace, args, config);
        break;
      case "thread-read":
        await threadRead(manager, args);
        break;
      case "thread-interrupt":
        await threadInterrupt(manager, args);
        break;
      case "thread-steer":
        await threadSteer(manager, args);
        break;
      case "models":
        await models(backend);
        break;
      case "approvals":
        printApprovals(store.listPendingApprovals());
        break;
      default:
        printHelp();
        process.exitCode = 1;
    }
  } finally {
    await manager.close();
    store.close();
  }
}

function register(workspace: WorkspaceManager, args: ParsedArgs): void {
  const dir = required(args.positionals[0], "dir");
  console.log(JSON.stringify(workspace.register(dir), null, 2));
}

async function create(workspace: WorkspaceManager, args: ParsedArgs, config: OrchestraConfig): Promise<void> {
  const dir = required(args.positionals[0], "dir");
  const prompt = promptFlag(args);
  const createOptions = {
    count: flagNumber(args.flags.n) ?? 1,
    model: modelFlag(args, config),
    serviceTier: serviceTierFlag(args, config),
    approvalPolicy: approvalPolicy(args.flags.approval),
    sandbox: sandboxMode(args.flags.sandbox),
  };
  const agents = await workspace.create(dir, prompt ? { ...createOptions, prompt } : createOptions);
  for (const agent of agents) {
    console.log(`${agent.id}\t${agent.status}\t${agent.cwd}\t${agent.threadId}`);
  }
}

async function teardown(workspace: WorkspaceManager, args: ParsedArgs): Promise<void> {
  const dir = required(args.positionals[0], "dir");
  const agents = await workspace.teardown(dir);
  for (const agent of agents) {
    console.log(`removed ${agent.id}\t${agent.cwd}`);
  }
}

function ls(store: OrchestraStore): void {
  for (const agent of store.listManagedAgents()) {
    console.log(`${agent.id}\t${agent.status}\t${agent.repoPath ?? ""}\t${agent.branch}\t${agent.cwd}`);
  }
}

function diff(workspace: WorkspaceManager, args: ParsedArgs): void {
  const id = required(args.positionals[0], "agent id");
  const text = workspace.diff(id);
  if (typeof args.flags.out === "string") {
    writeFileSync(resolve(args.flags.out), text);
    console.log(resolve(args.flags.out));
  } else {
    process.stdout.write(text);
  }
}

function execAgent(workspace: WorkspaceManager, args: ParsedArgs): void {
  const id = required(args.positionals[0], "agent id");
  const command = args.positionals.slice(1).join(" ");
  if (!command) {
    throw new Error("exec requires a command");
  }
  const result = workspace.exec(id, command);
  process.stdout.write(result.output);
  process.exitCode = result.exitCode;
}

async function steer(workspace: WorkspaceManager, args: ParsedArgs, config: OrchestraConfig): Promise<void> {
  const id = required(args.positionals[0], "agent id");
  const prompt = args.positionals.slice(1).join(" ");
  if (!prompt) {
    throw new Error("steer requires guidance text");
  }
  const result = await workspace.steer(id, prompt, {
    model: modelFlag(args, config),
    serviceTier: serviceTierFlag(args, config),
    approvalPolicy: approvalPolicy(args.flags.approval),
    sandbox: sandboxMode(args.flags.sandbox),
  });
  console.log(JSON.stringify(result, null, 2));
}

async function interrupt(workspace: WorkspaceManager, args: ParsedArgs): Promise<void> {
  const id = required(args.positionals[0], "agent id");
  const result = await workspace.interrupt(id);
  console.log(JSON.stringify(result, null, 2));
}

function turn(workspace: WorkspaceManager, args: ParsedArgs): void {
  const id = required(args.positionals[0], "agent id");
  console.log(JSON.stringify(workspace.turn(id), null, 2));
}

function read(workspace: WorkspaceManager, args: ParsedArgs): void {
  const id = required(args.positionals[0], "agent id");
  console.log(workspace.readTranscript(id, Boolean(args.flags.json)));
}

async function tail(manager: AgentManager, workspace: WorkspaceManager, args: ParsedArgs): Promise<void> {
  const id = required(args.positionals[0], "agent id");
  const agent = workspace.requiredAgent(id);
  const events = workspace.turn(id);
  console.log(JSON.stringify(events, null, 2));
  if (agent.activeTurnId) {
    await manager.connect();
    await waitForTurnCompletion(manager, { stream: true, autoApprove: Boolean(args.flags.yes) });
  }
}

async function run(manager: AgentManager, args: ParsedArgs, config: OrchestraConfig): Promise<void> {
  const prompt = promptFrom(args);
  const options = startOptions(args, config);
  const autoApprove = Boolean(args.flags.yes);
  const agent = await manager.startAgent(options);
  console.log(`thread ${agent.threadId}`);

  const turnDone = waitForTurnCompletion(manager, {
    stream: true,
    autoApprove,
  });
  const turn = await manager.startTurn(agent.threadId, prompt, options);
  console.log(`turn ${turn.turnId}\n`);
  await turnDone;
}

async function start(manager: AgentManager, args: ParsedArgs, config: OrchestraConfig): Promise<void> {
  const agent = await manager.startAgent(startOptions(args, config));
  console.log(JSON.stringify(agent, null, 2));
}

async function send(manager: AgentManager, args: ParsedArgs, config: OrchestraConfig): Promise<void> {
  const threadId = required(args.positionals[0], "thread id");
  const prompt = args.positionals.slice(1).join(" ");
  if (!prompt) {
    throw new Error("send requires a prompt");
  }
  const autoApprove = Boolean(args.flags.yes);
  const turnDone = waitForTurnCompletion(manager, {
    stream: true,
    autoApprove,
  });
  const turn = await manager.send(threadId, prompt, sendOptions(args, config));
  console.log(`turn ${turn.turnId}\n`);
  await turnDone;
}

async function list(manager: AgentManager, args: ParsedArgs): Promise<void> {
  const agents = await manager.listAgents({
    cwd: typeof args.flags.cwd === "string" ? resolve(args.flags.cwd) : undefined,
    archived: Boolean(args.flags.archived),
    limit: flagNumber(args.flags.limit) ?? 50,
    searchTerm: typeof args.flags.search === "string" ? args.flags.search : undefined,
  });
  for (const agent of agents) {
    console.log(`${agent.threadId}\t${agent.status}\t${agent.cwd ?? ""}\t${agent.name ?? agent.preview ?? ""}`);
  }
}

async function threadInterrupt(manager: AgentManager, args: ParsedArgs): Promise<void> {
  const threadId = required(args.positionals[0], "thread id");
  const turnId = args.positionals[1];
  const result = await manager.interrupt(threadId, turnId);
  console.log(JSON.stringify(result, null, 2));
}

async function threadSteer(manager: AgentManager, args: ParsedArgs): Promise<void> {
  const threadId = required(args.positionals[0], "thread id");
  const turnId = required(args.positionals[1], "turn id");
  const prompt = args.positionals.slice(2).join(" ");
  if (!prompt) {
    throw new Error("steer requires guidance text");
  }
  const result = await manager.steer(threadId, turnId, prompt);
  console.log(JSON.stringify(result, null, 2));
}

async function models(backend: CodexV2Backend): Promise<void> {
  await backend.connect();
  await backend.initialize();
  const result = await backend.listModels();
  console.log(JSON.stringify(result, null, 2));
}

async function threadRead(manager: AgentManager, args: ParsedArgs): Promise<void> {
  const threadId = required(args.positionals[0], "thread id");
  const result = await manager.readThread(threadId);
  console.log(JSON.stringify(result, null, 2));
}

function waitForTurnCompletion(
  manager: AgentManager,
  options: { stream: boolean; autoApprove: boolean },
): Promise<void> {
  let seenTurn = false;
  return new Promise((resolve, reject) => {
    const unsubscribe = manager.onEvent((event) => {
      void handleLiveEvent(manager, event, options).catch(reject);
      if (event.type === "turn.started") {
        seenTurn = true;
      }
      if (seenTurn && event.type === "turn.completed") {
        unsubscribe();
        if (event.turn.status === "failed") {
          reject(new Error("turn failed"));
        } else {
          resolve();
        }
      }
      if (event.type === "error") {
        unsubscribe();
        reject(new Error(JSON.stringify(event.raw)));
      }
    });
  });
}

async function handleLiveEvent(
  manager: AgentManager,
  event: AgentEvent,
  options: { stream: boolean; autoApprove: boolean },
): Promise<void> {
  if (options.stream) {
    if (event.type === "stream.agent") {
      process.stdout.write(event.delta);
    }
    if (event.type === "stream.command") {
      process.stderr.write(event.delta);
    }
  }

  if (event.type === "approval.requested") {
    if (options.autoApprove && (event.approval.kind === "command" || event.approval.kind === "fileChange")) {
      await manager.approve(event.approval.requestId);
      return;
    }
    await promptForApproval(manager, event.approval);
  }
}

async function promptForApproval(manager: AgentManager, approval: Approval): Promise<void> {
  console.error(`\napproval requested: ${approval.kind}`);
  const params = approval.params && typeof approval.params === "object" && !Array.isArray(approval.params) ? approval.params : {};
  if (approval.kind === "userInput") {
    await promptForUserInput(manager, approval);
    return;
  }
  if (approval.kind === "mcpElicitation") {
    await promptForMcpElicitation(manager, approval);
    return;
  }
  if (approval.kind === "permissions") {
    await promptForPermissions(manager, approval);
    return;
  }

  const command = params.command;
  const cwd = params.cwd;
  const reason = params.reason;
  if (typeof cwd === "string") {
    console.error(`cwd: ${cwd}`);
  }
  if (typeof command === "string") {
    console.error(`command: ${command}`);
  }
  if (typeof reason === "string") {
    console.error(`reason: ${reason}`);
  }

  const rl = createInterface({ input, output });
  const answer = (await rl.question("approve? [y]es/[s]ession/[n]o/[c]ancel: ")).trim().toLowerCase();
  rl.close();
  if (answer === "y" || answer === "yes" || answer === "") {
    await manager.approve(approval.requestId, "accept");
  } else if (answer === "s" || answer === "session") {
    await manager.approve(approval.requestId, "acceptForSession");
  } else if (answer === "c" || answer === "cancel") {
    await manager.approve(approval.requestId, "cancel");
  } else {
    await manager.deny(approval.requestId);
  }
}

async function promptForUserInput(manager: AgentManager, approval: Approval): Promise<void> {
  const params = approval.params && typeof approval.params === "object" && !Array.isArray(approval.params) ? approval.params : {};
  const questions = Array.isArray(params.questions) ? params.questions : [];
  const rl = createInterface({ input, output });
  const answers: Record<string, { answers: string[] }> = {};
  for (const question of questions) {
    if (!question || typeof question !== "object" || Array.isArray(question)) {
      continue;
    }
    const id = typeof question.id === "string" ? question.id : "";
    if (!id) {
      continue;
    }
    const text = typeof question.question === "string" ? question.question : id;
    const options = Array.isArray(question.options) ? question.options : [];
    if (options.length > 0) {
      console.error(text);
      options.forEach((option, index) => {
        if (option && typeof option === "object" && !Array.isArray(option)) {
          console.error(`  ${index + 1}. ${String(option.label)} ${String(option.description ?? "")}`);
        }
      });
    }
    const answer = await rl.question(`${text}: `);
    answers[id] = { answers: [answer] };
  }
  rl.close();
  await manager.respondRaw(approval.requestId, { answers });
}

async function promptForMcpElicitation(manager: AgentManager, approval: Approval): Promise<void> {
  const params = approval.params && typeof approval.params === "object" && !Array.isArray(approval.params) ? approval.params : {};
  const message = typeof params.message === "string" ? params.message : "MCP server requested input";
  const url = typeof params.url === "string" ? params.url : undefined;
  console.error(message);
  if (url) {
    console.error(url);
  }
  const rl = createInterface({ input, output });
  const answer = (await rl.question("accept? [y]es/[n]o/[c]ancel: ")).trim().toLowerCase();
  rl.close();
  const action = answer === "y" || answer === "yes" || answer === "" ? "accept" : answer === "c" || answer === "cancel" ? "cancel" : "decline";
  await manager.respondRaw(approval.requestId, { action, content: action === "accept" ? {} : null, _meta: null });
}

async function promptForPermissions(manager: AgentManager, approval: Approval): Promise<void> {
  const params = approval.params && typeof approval.params === "object" && !Array.isArray(approval.params) ? approval.params : {};
  console.error(typeof params.reason === "string" ? params.reason : "Agent requested extra permissions");
  const rl = createInterface({ input, output });
  const answer = (await rl.question("grant permissions for [t]urn/[s]ession/[n]o: ")).trim().toLowerCase();
  rl.close();
  if (answer === "t" || answer === "turn" || answer === "" || answer === "s" || answer === "session") {
    await manager.respondRaw(approval.requestId, {
      permissions: params.permissions && typeof params.permissions === "object" && !Array.isArray(params.permissions) ? params.permissions : {},
      scope: answer === "s" || answer === "session" ? "session" : "turn",
    });
  } else {
    await manager.respondRaw(approval.requestId, { permissions: {}, scope: "turn" });
  }
}

function startOptions(args: ParsedArgs, config: OrchestraConfig): StartAgentOptions {
  return {
    cwd: typeof args.flags.cwd === "string" ? resolve(args.flags.cwd) : process.cwd(),
    model: modelFlag(args, config),
    serviceTier: serviceTierFlag(args, config),
    name: typeof args.flags.name === "string" ? args.flags.name : undefined,
    approvalPolicy: approvalPolicy(args.flags.approval),
    sandbox: sandboxMode(args.flags.sandbox),
    personality: "friendly",
  };
}

function sendOptions(args: ParsedArgs, config: OrchestraConfig) {
  return {
    cwd: typeof args.flags.cwd === "string" ? resolve(args.flags.cwd) : undefined,
    model: modelFlag(args, config),
    serviceTier: serviceTierFlag(args, config),
    approvalPolicy: approvalPolicy(args.flags.approval),
    sandbox: sandboxMode(args.flags.sandbox),
    personality: "friendly" as const,
  };
}

function modelFlag(args: ParsedArgs, config: OrchestraConfig): string {
  return typeof args.flags.model === "string" ? args.flags.model : config.model;
}

function serviceTierFlag(args: ParsedArgs, config: OrchestraConfig): OrchestraConfig["serviceTier"] {
  return normalizeServiceTier(args.flags["service-tier"]) ?? config.serviceTier;
}

function promptFlag(args: ParsedArgs): string | undefined {
  if (typeof args.flags.prompt === "string" && typeof args.flags["prompt-file"] === "string") {
    throw new Error("--prompt and --prompt-file are mutually exclusive");
  }
  if (typeof args.flags.prompt === "string") {
    return args.flags.prompt;
  }
  if (typeof args.flags["prompt-file"] === "string") {
    return readPromptFile(args.flags["prompt-file"]);
  }
  return undefined;
}

function approvalPolicy(value: string | boolean | undefined): ApprovalPolicy | undefined {
  if (value === "untrusted" || value === "on-failure" || value === "on-request" || value === "never") {
    return value;
  }
  return undefined;
}

function sandboxMode(value: string | boolean | undefined): SandboxMode | undefined {
  if (value === "read-only" || value === "workspace-write" || value === "danger-full-access") {
    return value;
  }
  return undefined;
}

function promptFrom(args: ParsedArgs): string {
  const prompt = args.positionals.join(" ");
  if (!prompt) {
    throw new Error("run requires a prompt");
  }
  return prompt;
}

function printApprovals(approvals: Approval[]): void {
  for (const approval of approvals) {
    console.log(`${approval.requestId}\t${approval.kind}\t${approval.threadId ?? ""}\t${approval.turnId ?? ""}`);
  }
}

async function runDaemonCommand(command: string): Promise<void> {
  const args =
    command === "start"
      ? ["app-server", "daemon", "start"]
      : command === "enable-remote-control"
        ? ["app-server", "daemon", "enable-remote-control"]
        : command === "stop"
          ? ["app-server", "daemon", "stop"]
          : ["app-server", "daemon", "status"];
  const proc = Bun.spawn(["codex", ...args], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  const code = await proc.exited;
  process.exitCode = code;
}

function transportArgs(args: ParsedArgs): string[] {
  const transport = typeof args.flags.transport === "string" ? args.flags.transport : "proxy";
  if (transport === "stdio") {
    return ["app-server", "--stdio"];
  }
  return ["app-server", "proxy"];
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg) {
      continue;
    }
    if (arg === "-n") {
      const next = rest[index + 1];
      if (!next) {
        throw new Error("-n requires a value");
      }
      flags.n = next;
      index += 1;
      continue;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const withoutPrefix = arg.slice(2);
    const equalsIndex = withoutPrefix.indexOf("=");
    if (equalsIndex >= 0) {
      flags[withoutPrefix.slice(0, equalsIndex)] = withoutPrefix.slice(equalsIndex + 1);
      continue;
    }
    const next = rest[index + 1];
    if (next && !next.startsWith("--")) {
      flags[withoutPrefix] = next;
      index += 1;
    } else {
      flags[withoutPrefix] = true;
    }
  }

  return { command, positionals, flags };
}

function required(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`missing ${name}`);
  }
  return value;
}

function flagNumber(value: string | boolean | undefined): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function printHelp(): void {
  console.log(`orchestra

Usage:
  bun run src/cli.ts register <dir>
  bun run src/cli.ts create <dir> [-n N] [--prompt TEXT | --prompt-file FILE]
  bun run src/cli.ts teardown <dir>
  bun run src/cli.ts ls
  bun run src/cli.ts diff <id> [--out FILE]
  bun run src/cli.ts exec <id> "cmd"
  bun run src/cli.ts steer <id> "guidance"
  bun run src/cli.ts interrupt <id>
  bun run src/cli.ts turn <id>
  bun run src/cli.ts read <id> [--json]
  bun run src/cli.ts tail <id>

Lower-level thread commands:
  bun run src/cli.ts daemon start
  bun run src/cli.ts daemon enable-remote-control
  bun run src/cli.ts run "fix the tests" [--cwd .] [--model MODEL] [--approval on-request] [--sandbox workspace-write] [--yes]
  bun run src/cli.ts start [--cwd .] [--name NAME]
  bun run src/cli.ts send THREAD_ID "next task"
  bun run src/cli.ts list [--cwd .] [--archived]
  bun run src/cli.ts thread-read THREAD_ID
  bun run src/cli.ts thread-steer THREAD_ID TURN_ID "guidance"
  bun run src/cli.ts thread-interrupt THREAD_ID [TURN_ID]
  bun run src/cli.ts approvals
  bun run src/cli.ts models

Options:
  --model MODEL             default: ${DEFAULT_MODEL}
  --service-tier TIER       default | priority
  --config PATH             default: ./orchestra.toml, then ~/.orchestra/config.toml
  --transport proxy|stdio   default: proxy
  --db PATH                 default: ~/.orchestra/orchestra.db
  --approval POLICY         untrusted | on-failure | on-request | never
  --sandbox MODE            read-only | workspace-write | danger-full-access
`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
