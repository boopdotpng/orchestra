#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { CodexV2Backend } from "./backend/codex-v2/CodexV2Backend";
import { OrchestraClient } from "./client";
import { AgentManager } from "./manager/AgentManager";
import { OrchestraStore } from "./store/OrchestraStore";
import { expandHome, readPromptFile, WorkspaceManager } from "./workspace/WorkspaceManager";
import { DEFAULT_MODEL, loadOrchestraConfig, normalizeServiceTier, type OrchestraConfig } from "./config";
import type { AgentEvent, Approval, ApprovalPolicy, ManagedAgent, ManagedAgentSummary, SandboxMode, StartAgentOptions } from "./domain/types";

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
  if (args.command === "monitor") {
    await monitor(args);
    return;
  }

  // Mutating commands need the daemon that owns the agent threads. Spawning a
  // fresh app-server here cannot interrupt or steer turns it does not own, so
  // route through the running orchestra server whenever it is reachable.
  if (DAEMON_ROUTED_COMMANDS.has(args.command) && !args.flags.local) {
    const baseUrl = orchestraUrl(args);
    const client = await connectDaemon(baseUrl);
    if (client) {
      await runViaDaemon(client, args);
      return;
    }
    if (args.command === "interrupt" || args.command === "steer") {
      console.error(
        `warning: no orchestra server reachable at ${baseUrl}; falling back to a local app-server, which cannot control turns owned by a running orchestra server`,
      );
    }
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
      case "status":
        status(store, args);
        break;
      case "teardown":
        await teardown(workspace, args);
        break;
      case "remove":
        await remove(workspace, args);
        break;
      case "ls":
        ls(store);
        break;
      case "standouts":
        console.log(workspace.standouts());
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

const DAEMON_ROUTED_COMMANDS = new Set(["create", "steer", "interrupt", "teardown", "remove"]);

async function connectDaemon(baseUrl: string): Promise<OrchestraClient | undefined> {
  try {
    const response = await fetch(new URL("/health", baseUrl), { signal: AbortSignal.timeout(1500) });
    return response.ok ? new OrchestraClient(baseUrl) : undefined;
  } catch {
    return undefined;
  }
}

async function runViaDaemon(client: OrchestraClient, args: ParsedArgs): Promise<void> {
  switch (args.command) {
    case "create": {
      // Resolve paths client-side: the daemon resolves relative paths against
      // its own cwd, not the caller's.
      const name = required(args.positionals[0], "name");
      const dir = expandHome(required(args.positionals[1], "dir"));
      const prompt = required(promptFlag(args), "prompt");
      const { agents } = await client.createAgents({
        name,
        dir,
        prompt,
        count: flagNumber(args.flags.n) ?? 1,
        ...turnOverrides(args),
      });
      printCreatedAgents(agents);
      return;
    }
    case "steer": {
      const id = required(args.positionals[0], "agent id");
      const input = args.positionals.slice(1).join(" ");
      if (!input) {
        throw new Error("steer requires guidance text");
      }
      console.log(JSON.stringify(await client.steer(id, { input, ...turnOverrides(args) }), null, 2));
      return;
    }
    case "interrupt": {
      const id = required(args.positionals[0], "agent id");
      console.log(JSON.stringify(await client.interrupt(id), null, 2));
      return;
    }
    case "teardown": {
      const target = required(args.positionals[0], "target");
      const resolved = target === "all" || /^[0-9a-f]{4}$/i.test(target) || !isPathLikeTarget(target) ? target : expandHome(target);
      const { agents } = await client.teardownTarget({ target: resolved });
      printRemovedAgents(agents);
      return;
    }
    case "remove": {
      const id = required(args.positionals[0], "agent id");
      const { agent } = await client.remove(id);
      printRemovedAgents([agent]);
      return;
    }
    default:
      throw new Error(`command ${args.command} cannot be routed to the orchestra server`);
  }
}

/**
 * Only explicit flags are forwarded; omitted options use the daemon's own
 * config defaults rather than this process's.
 */
function turnOverrides(args: ParsedArgs): {
  model?: string;
  serviceTier?: OrchestraConfig["serviceTier"];
  approvalPolicy?: ApprovalPolicy;
  sandbox?: SandboxMode;
} {
  const serviceTier = normalizeServiceTier(args.flags["service-tier"]);
  const approval = approvalPolicy(args.flags.approval);
  const sandbox = sandboxMode(args.flags.sandbox);
  return {
    ...(typeof args.flags.model === "string" ? { model: args.flags.model } : {}),
    ...(serviceTier ? { serviceTier } : {}),
    ...(approval ? { approvalPolicy: approval } : {}),
    ...(sandbox ? { sandbox } : {}),
  };
}

function register(workspace: WorkspaceManager, args: ParsedArgs): void {
  const dir = required(args.positionals[0], "dir");
  console.log(JSON.stringify(workspace.register(dir), null, 2));
}

async function create(workspace: WorkspaceManager, args: ParsedArgs, config: OrchestraConfig): Promise<void> {
  const name = required(args.positionals[0], "name");
  const dir = required(args.positionals[1], "dir");
  const prompt = required(promptFlag(args), "prompt");
  const createOptions = {
    workspaceName: name,
    count: flagNumber(args.flags.n) ?? 1,
    model: modelFlag(args, config),
    serviceTier: serviceTierFlag(args, config),
    approvalPolicy: approvalPolicy(args.flags.approval),
    sandbox: sandboxMode(args.flags.sandbox),
  };
  const agents = await workspace.create(dir, { ...createOptions, prompt });
  printCreatedAgents(agents);
}

async function teardown(workspace: WorkspaceManager, args: ParsedArgs): Promise<void> {
  const target = required(args.positionals[0], "target");
  const agents = await workspace.teardownTarget(target);
  printRemovedAgents(agents);
}

function status(store: OrchestraStore, args: ParsedArgs): void {
  const workspaceFilter = typeof args.flags.workspace === "string" ? args.flags.workspace : args.positionals[0];
  const agents = store
    .listManagedAgentSummaries()
    .filter((agent) => !workspaceFilter || agent.workspaceName.toLowerCase().includes(workspaceFilter.toLowerCase()))
    .sort(
      (left, right) =>
        left.workspaceName.localeCompare(right.workspaceName) ||
        shortPath(left.repoPath ?? left.cwd).localeCompare(shortPath(right.repoPath ?? right.cwd)) ||
        (left.createdAt ?? 0) - (right.createdAt ?? 0),
    );
  if (!agents.length) {
    console.log(workspaceFilter ? `no agents matching workspace ${workspaceFilter}` : "no agents");
    return;
  }
  const pending = store.listPendingApprovals();
  printStatusHeader(agents, pending.length);
  const rows = agents.map((agent) => ({
    id: agent.id,
    workspace: agent.workspaceName,
    status: agent.status,
    turns: String(agent.turnCount),
    tokens: agent.tokensUsed === undefined ? "-" : compactNumber(agent.tokensUsed),
    activity: relativeTime(agent.lastActivityAt),
    repo: shortPath(agent.repoPath ?? agent.cwd),
    workdir: shortPath(agent.cwd),
  }));
  printTable(rows, ["id", "workspace", "status", "turns", "tokens", "activity", "repo", "workdir"], {
    maxWidths: { workspace: 20, status: 16, repo: 26, workdir: 26 },
  });
  printLastOutput(agents);
  if (pending.length) {
    console.log(`\npending approvals: ${pending.length}`);
  }
}

async function remove(workspace: WorkspaceManager, args: ParsedArgs): Promise<void> {
  const id = required(args.positionals[0], "agent id");
  const agent = await workspace.remove(id);
  printRemovedAgents([agent]);
}

function ls(store: OrchestraStore): void {
  const agents = store.listManagedAgents();
  if (!agents.length) {
    console.log("no agents");
    return;
  }
  const rows = agents.map((agent) => ({
    id: agent.id,
    workspace: agent.workspaceName,
    status: agent.status,
    repo: shortPath(agent.repoPath ?? ""),
    branch: agent.branch,
    workdir: shortPath(agent.cwd),
  }));
  printTable(rows, ["id", "workspace", "status", "repo", "branch", "workdir"], {
    maxWidths: { workspace: 20, repo: 28, branch: 24, workdir: 28 },
  });
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
  if (!agents.length) {
    console.log("no threads");
    return;
  }
  const rows = agents.map((agent) => ({
    thread: agent.threadId,
    status: agent.status,
    cwd: shortPath(agent.cwd ?? ""),
    name: oneLine(agent.name ?? agent.preview ?? "-"),
  }));
  printTable(rows, ["thread", "status", "cwd", "name"], {
    maxWidths: { thread: 36, status: 12, cwd: 32, name: 56 },
  });
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

function isPathLikeTarget(target: string): boolean {
  return (
    target === "." ||
    target === ".." ||
    target === "~" ||
    target.startsWith("./") ||
    target.startsWith("../") ||
    target.startsWith("~/") ||
    target.startsWith("/") ||
    target.includes("/")
  );
}

function printApprovals(approvals: Approval[]): void {
  if (!approvals.length) {
    console.log("no pending approvals");
    return;
  }
  const rows = approvals.map((approval) => ({
    request: String(approval.requestId),
    kind: approval.kind,
    thread: approval.threadId ?? "-",
    turn: approval.turnId ?? "-",
    age: relativeTime(approval.createdAtMs),
  }));
  printTable(rows, ["request", "kind", "thread", "turn", "age"], {
    maxWidths: { request: 24, kind: 16, thread: 36, turn: 36 },
  });
}

type MonitorAgent = {
  id: string;
  repoPath?: string | undefined;
  threadId: string;
  status: string;
  lastAssistantMessageTail?: string | undefined;
};

type MonitorCompletion = {
  agent: MonitorAgent;
  status: string;
  turnId?: string | undefined;
};

async function monitor(args: ParsedArgs): Promise<void> {
  const baseUrl = orchestraUrl(args);
  const idFilter = typeof args.flags.id === "string" ? args.flags.id : args.positionals[0] && /^[0-9a-f]{4}$/i.test(args.positionals[0]) ? args.positionals[0] : undefined;
  const workdirFilter =
    typeof args.flags.workdir === "string"
      ? resolve(args.flags.workdir)
      : !idFilter && args.positionals[0] && args.positionals[0] !== "all"
        ? resolve(args.positionals[0])
        : undefined;
  const exitWhenIdle = args.flags.until === "never" || args.flags.follow === true ? false : true;
  const singleAgent = Boolean(idFilter);
  const agents = await fetchMonitorAgents(baseUrl, idFilter, workdirFilter);
  if (!agents.size) {
    console.error(`monitor no matching agents${idFilter ? ` id=${idFilter}` : ""}${workdirFilter ? ` workdir=${workdirFilter}` : ""}`);
    return;
  }
  if (exitWhenIdle && allMonitorAgentsIdle(agents)) {
    if (singleAgent) {
      const agent = [...agents.values()][0];
      if (agent) {
        printMonitorCompletion({ agent, status: agent.status });
      }
    }
    return;
  }

  const response = await fetch(new URL("/events", baseUrl));
  if (!response.ok || !response.body) {
    throw new Error(`monitor failed to connect to ${baseUrl}/events: ${response.status} ${await response.text()}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const completedAgents = new Set<string>();
  let buffer = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      return;
    }
    buffer += decoder.decode(chunk.value, { stream: true });
    let split = buffer.indexOf("\n\n");
    while (split >= 0) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const event = parseSseFrame(frame);
      if (event) {
        const result = handleMonitorEvent(event, agents);
        if (result?.startedAgentId) {
          completedAgents.delete(result.startedAgentId);
        }
        if (result?.completion && !completedAgents.has(result.completion.agent.id)) {
          printMonitorCompletion(result.completion);
          completedAgents.add(result.completion.agent.id);
        }
        if (exitWhenIdle && allMonitorAgentsIdle(agents)) {
          await reader.cancel();
          return;
        }
      }
      split = buffer.indexOf("\n\n");
    }
  }
}

async function fetchMonitorAgents(baseUrl: string, idFilter?: string, workdirFilter?: string): Promise<Map<string, MonitorAgent>> {
  const response = await fetch(new URL("/status", baseUrl));
  if (!response.ok) {
    throw new Error(`monitor failed to read status from ${baseUrl}: ${response.status} ${await response.text()}`);
  }
  const status = (await response.json()) as { agents?: MonitorAgent[] };
  const agents = new Map<string, MonitorAgent>();
  for (const agent of status.agents ?? []) {
    if (idFilter && agent.id !== idFilter) {
      continue;
    }
    if (workdirFilter && agent.repoPath !== workdirFilter) {
      continue;
    }
    agents.set(agent.id, agent);
  }
  return agents;
}

function handleMonitorEvent(
  event: Record<string, unknown>,
  agents: Map<string, MonitorAgent>,
): { completion?: MonitorCompletion | undefined; startedAgentId?: string | undefined } | undefined {
  const agent = [...agents.values()].find((candidate) => monitorEventThreadId(event) === candidate.threadId);
  if (!agent) {
    return;
  }
  const type = typeof event.type === "string" ? event.type : "";
  if (type === "turn.started") {
    agent.status = "running";
    return { startedAgentId: agent.id };
  }
  if (type === "turn.completed") {
    const status = monitorTurnStatus(event) ?? "completed";
    agent.status = status === "failed" ? "error" : "idle";
    return { completion: { agent, status, turnId: monitorTurnId(event) } };
  }
  if (type === "agent.status") {
    const previousStatus = agent.status;
    const status = typeof event.status === "string" ? event.status : "";
    agent.status = status === "active" ? "running" : status === "systemError" ? "error" : status;
    if (previousStatus !== agent.status && isMonitorAgentIdle(agent)) {
      return { completion: { agent, status: agent.status } };
    }
    return;
  }
  if (type === "approval.requested") {
    agent.status = "waiting_approval";
    return;
  }
  if (type === "item.completed") {
    const item = event.item && typeof event.item === "object" && !Array.isArray(event.item) ? (event.item as Record<string, unknown>) : {};
    const itemType = typeof item.type === "string" ? item.type : "";
    if (itemType === "agentMessage" && typeof item.text === "string") {
      agent.lastAssistantMessageTail = item.text;
    }
    return;
  }
  if (type === "error") {
    agent.status = "error";
    return { completion: { agent, status: "error" } };
  }
}

function parseSseFrame(frame: string): Record<string, unknown> | undefined {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(data) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function monitorEventThreadId(event: Record<string, unknown>): string | undefined {
  if (typeof event.threadId === "string") {
    return event.threadId;
  }
  const agent = event.agent && typeof event.agent === "object" && !Array.isArray(event.agent) ? (event.agent as Record<string, unknown>) : undefined;
  if (typeof agent?.threadId === "string") {
    return agent.threadId;
  }
  const approval = event.approval && typeof event.approval === "object" && !Array.isArray(event.approval) ? (event.approval as Record<string, unknown>) : undefined;
  return typeof approval?.threadId === "string" ? approval.threadId : undefined;
}

function monitorTurnId(event: Record<string, unknown>): string | undefined {
  const turn = event.turn && typeof event.turn === "object" && !Array.isArray(event.turn) ? (event.turn as Record<string, unknown>) : undefined;
  return typeof turn?.turnId === "string" ? turn.turnId : undefined;
}

function monitorTurnStatus(event: Record<string, unknown>): string | undefined {
  const turn = event.turn && typeof event.turn === "object" && !Array.isArray(event.turn) ? (event.turn as Record<string, unknown>) : undefined;
  return typeof turn?.status === "string" ? turn.status : undefined;
}

function allMonitorAgentsIdle(agents: Map<string, MonitorAgent>): boolean {
  return [...agents.values()].every(isMonitorAgentIdle);
}

function isMonitorAgentIdle(agent: MonitorAgent): boolean {
  return agent.status === "idle" || agent.status === "error" || agent.status === "notLoaded";
}

function printMonitorCompletion(completion: MonitorCompletion): void {
  console.log([completion.agent.id, completion.status, completion.turnId ?? ""].join("\t").trimEnd());
}

function oneLine(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length > 300 ? cleaned.slice(0, 300) : cleaned;
}

function printCreatedAgents(agents: ManagedAgent[]): void {
  console.log(`created ${plural(agents.length, "agent")}`);
  printTable(
    agents.map((agent) => ({
      id: agent.id,
      status: agent.status,
      workspace: agent.workspaceName,
      branch: agent.branch,
      workdir: agent.cwd,
      thread: agent.threadId,
    })),
    ["id", "status", "workspace", "branch", "workdir", "thread"],
    { maxWidths: { status: 16, workspace: 20, branch: 24, workdir: 56, thread: 36 } },
  );
}

function printRemovedAgents(agents: Array<Pick<ManagedAgent, "id" | "cwd">>): void {
  console.log(`removed ${plural(agents.length, "agent")}`);
  if (!agents.length) {
    return;
  }
  printTable(
    agents.map((agent) => ({
      id: agent.id,
      workdir: agent.cwd,
    })),
    ["id", "workdir"],
    { maxWidths: { workdir: 72 } },
  );
}

function printStatusHeader(agents: ManagedAgentSummary[], pendingApprovals: number): void {
  const counts = new Map<string, number>();
  for (const agent of agents) {
    counts.set(agent.status, (counts.get(agent.status) ?? 0) + 1);
  }
  const order = ["running", "waiting_approval", "idle", "error", "notLoaded"];
  const pieces = [`agents ${agents.length}`];
  for (const status of order) {
    const count = counts.get(status);
    if (count) {
      pieces.push(`${statusLabel(status)} ${count}`);
    }
  }
  if (pendingApprovals) {
    pieces.push(`approvals ${pendingApprovals}`);
  }
  console.log(pieces.join("  "));
  console.log("");
}

function printLastOutput(agents: ManagedAgentSummary[]): void {
  const rows = agents
    .map((agent) => ({
      id: agent.id,
      text: oneLine(agent.lastAssistantMessageTail ?? agent.lastTurnSummary ?? ""),
    }))
    .filter((row) => row.text.length > 0);
  if (!rows.length) {
    return;
  }
  const width = Math.max(48, Math.min(120, terminalColumns() - 8));
  console.log("\nlast output");
  for (const row of rows) {
    console.log(`  ${row.id}  ${ellipsize(row.text, width)}`);
  }
}

function statusLabel(status: string): string {
  return status === "waiting_approval" ? "approval" : status;
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function shortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 2 ? parts.slice(-2).join("/") : path;
}

function compactNumber(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }
  return String(value);
}

function relativeTime(ms: number | undefined): string {
  if (!ms) {
    return "-";
  }
  const delta = Date.now() - ms;
  if (delta < 0) {
    return "now";
  }
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours}h`;
  }
  return `${Math.floor(hours / 24)}d`;
}

type TableOptions = {
  maxWidths?: Record<string, number> | undefined;
};

function printTable(rows: Array<Record<string, string>>, columns: string[], options: TableOptions = {}): void {
  const widths = Object.fromEntries(columns.map((column) => [column, column.length]));
  for (const row of rows) {
    for (const column of columns) {
      const max = options.maxWidths?.[column] ?? 32;
      widths[column] = Math.max(widths[column] ?? 0, Math.min((row[column] ?? "").length, max));
    }
  }
  console.log(columns.map((column) => column.padEnd(widths[column] ?? column.length)).join("  "));
  console.log(columns.map((column) => "-".repeat(widths[column] ?? column.length)).join("  "));
  for (const row of rows) {
    console.log(
      columns
        .map((column) => {
          const limit = options.maxWidths?.[column] ?? 32;
          const text = ellipsize(row[column] ?? "", limit);
          return text.padEnd(widths[column] ?? column.length);
        })
        .join("  "),
    );
  }
}

function ellipsize(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  if (max <= 3) {
    return ".".repeat(Math.max(0, max));
  }
  return `${text.slice(0, max - 3)}...`;
}

function terminalColumns(): number {
  return process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : 120;
}

function orchestraUrl(args: ParsedArgs): string {
  if (typeof args.flags.url === "string") {
    return args.flags.url;
  }
  const host = process.env.ORCHESTRA_HOST ?? "127.0.0.1";
  const port = Number(process.env.ORCHESTRA_PORT ?? "5751");
  return process.env.ORCHESTRA_URL ?? `http://${host}:${port}`;
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
  orchestra create <name> <dir> [-n N] [--prompt TEXT | --prompt-file FILE]
  orchestra status [workspace-name|--workspace NAME]
  orchestra teardown <id|repo-name|workdir|all>
  orchestra remove <id>
  orchestra ls
  orchestra standouts
  orchestra diff <id> [--out FILE]
  orchestra exec <id> "cmd"
  orchestra steer <id> "guidance"
  orchestra interrupt <id>
  orchestra monitor <id|workdir> [--follow]
  orchestra approvals

Debug:
  orchestra run "prompt" [--cwd DIR]
  orchestra start [--cwd DIR] [--name NAME]
  orchestra send <thread-id> "prompt"
  orchestra list [--cwd DIR] [--archived] [--limit N]
  orchestra read <id> [--json]
  orchestra turn <id>
  orchestra tail <id>
  orchestra thread-read <thread-id>
  orchestra thread-steer <thread-id> <turn-id> "guidance"
  orchestra thread-interrupt <thread-id> [turn-id]
  orchestra models
  orchestra daemon <start|stop|status|enable-remote-control>

Options:
  --model MODEL             default: ${DEFAULT_MODEL}
  --service-tier TIER       default | priority
  --approval POLICY         untrusted | on-failure | on-request | never
  --sandbox MODE            read-only | workspace-write | danger-full-access
  --config PATH             default: ./orchestra.toml, then ~/.orchestra/config.toml
  --transport proxy|stdio   default: proxy (only used when no orchestra server is reachable)
  --db PATH                 default: ~/.orchestra/orchestra.db
  --url URL                 orchestra server, default: $ORCHESTRA_URL or http://127.0.0.1:5751
  --workspace NAME          filter status output by workspace name
  --local                   skip the orchestra server and use a direct codex app-server transport

create, steer, interrupt, teardown, and remove are sent to the running
orchestra server when one is reachable, since it owns the agent threads.
Pass --local to force the direct transport.
`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
