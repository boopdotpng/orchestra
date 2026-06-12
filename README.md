# Orchestra

Codex multi-agent orchestration over `codex app-server` protocol v2.

Orchestra creates short-lived, isolated Codex agent workspaces from a registered Git repository, keeps state in SQLite, exposes a local HTTP service, and provides an MCP wrapper for Codex or Claude Code.

## What Works

- Workspace-aware CLI with short agent ids.
- Reflink workspace creation under `~/.orchestra/runs/<repo>/<id>`.
- Git branch isolation as `orchestra/<id>` from a pinned base commit.
- SQLite state in `~/.orchestra/orchestra.db`.
- Codex app-server JSON-RPC transport isolated behind `CodexBackend`.
- Local HTTP service for long-lived control.
- Web dashboard for creating, steering, and watching agents live.
- MCP stdio wrapper over the HTTP service.

## Install

```bash
git clone https://github.com/boopdotpng/orchestra.git
cd orchestra
./install.sh
```

The default installer:

- runs `bun install`
- writes `~/.orchestra/config.toml` if it does not already exist
- enables Codex app-server daemon remote control when available
- installs `orchestra.service` (HTTP API) as a systemd user service
- installs `orchestra-ui.service` (web dashboard) as a systemd user service
- prints the dashboard URL and MCP registration commands without changing agent config

Useful variants:

```bash
./install.sh --codex
./install.sh --claude
./install.sh --all
./install.sh --no-service --codex --claude
./install.sh --no-deps --no-service --codex
```

Installer options:

- `--codex`: register the Orchestra MCP server in Codex.
- `--claude`: register the Orchestra MCP server in Claude Code user config.
- `--all`: register both Codex and Claude Code MCP servers.
- `--no-service`: skip installing and starting the systemd user service.
- `--no-deps`: skip `bun install`.

The systemd unit is saved in this repo as `orchestra.service` and installs to `~/.config/systemd/user/orchestra.service`.

```bash
systemctl --user status orchestra orchestra-ui
systemctl --user restart orchestra orchestra-ui
journalctl --user -u orchestra -f
journalctl --user -u orchestra-ui -f
```

The HTTP service defaults to `http://127.0.0.1:5751`. Override with `ORCHESTRA_HOST` and `ORCHESTRA_PORT`.

## Dashboard

`orchestra-ui.service` runs a small web dashboard for managing agents from a browser. It listens on `0.0.0.0` so it is reachable from other machines on your network, on the port directly adjacent to the HTTP API (API port + 1, so `5752` by default).

```
http://<host>:5752
```

The dashboard server serves the static UI (`src/ui/index.html`) and reverse-proxies every API call — including the SSE event streams — to the loopback HTTP API. This keeps the control-plane API bound to `127.0.0.1` while the browser only ever talks to a single same-origin port.

The dashboard is a per-workdir monitor. Pick a workdir from the top-left dropdown (populated from the repos that currently have agents — create them from the CLI or MCP) and you get a live grid of that workdir's agents, each card showing status and the agent's most recent output, refreshed every 10s and streamed in between over SSE. Click an agent to open its detail view: live conversation, the workspace diff, and lightweight controls to steer the agent, run a shell command in its workspace, interrupt the active turn, or write a transcript. Agent creation and repo registration are intentionally not in the UI — do those from the CLI or MCP.

Run it standalone with `bun run ui` (or `bun run src/ui_server.ts`). Override binding with:

- `ORCHESTRA_UI_HOST`: dashboard bind address (default `0.0.0.0`).
- `ORCHESTRA_UI_PORT`: dashboard port (default `ORCHESTRA_PORT + 1`).
- `ORCHESTRA_API_HOST` / `ORCHESTRA_PORT`: where the dashboard proxies API calls (default `127.0.0.1:5751`).

The HTTP API server also serves the same dashboard at `/` for direct local access on port `5751`.

## Config

Orchestra loads a small TOML config for defaults used by the CLI, HTTP service, and MCP server. Lookup order:

1. `--config PATH` for CLI commands
2. `ORCHESTRA_CONFIG=/path/to/orchestra.toml`
3. `~/.orchestra/config.toml`
4. workdir-local `.orchestra`
5. workdir-local `.orchestra.toml`
6. workdir-local `.orchestra/config.toml`

Global config is installed to `~/.orchestra/config.toml`:

```toml
model = "gpt-5.5"
fast_mode = false
```

Workdir-local config is merged on top of global config, so a project can override your global defaults with a tiny `.orchestra` file:

```toml
model = "gpt-5.5"
fast_mode = true
```

Config keys:

- `model`: default model for new agents and turns.
- `fast_mode`: `false` sends app-server `serviceTier: "default"`; `true` sends `serviceTier: "priority"`.

You can also use `service_tier = "default"` or `service_tier = "priority"` if you want the app-server value to be explicit. CLI `--model` and `--service-tier` override the config for that command. MCP `create` and `steer` can also pass `model` or `serviceTier`; when omitted, the service config is used.

Orchestra's own default permission posture is automatic and full-access: new agents use `approvalPolicy: "never"` and `sandbox: "danger-full-access"` unless a CLI flag or API request explicitly overrides them.

## HTTP API

The local service is intentionally UI-friendly. Useful endpoints:

- `GET /routes`: OpenAPI-ish route map.
- `GET /config`: read effective config and source files.
- `PATCH /config`: update global config by default; pass `{ "scope": "local" }` for the workdir `.orchestra` file.
- `GET /models`: proxy Codex `model/list`, including service tiers.
- `GET /events`: server-sent event stream for all live agent events.
- `GET /agents/:id/events`: server-sent event stream for one agent.

There is also a typed client in `src/client.ts` and route/type definitions in `src/server/api.ts`.

## MCP

The project MCP template is `.mcp.json`. It runs:

```bash
bun run /path/to/orchestra/src/mcp_server.ts
```

The MCP server talks to the local Orchestra HTTP service, so the systemd service should normally be running first. The MCP `read` tool writes a transcript file under `/tmp/orchestra` and returns the path instead of dumping the entire context into the tool result. That file includes agent messages, turn events, tool calls, and tool call results captured from app-server notifications.

MCP tools:

- `register`: pin a source repo base commit.
- `teardown`: remove Orchestra-managed agents and workspaces by exact workspace/run name.
- `create`: create one or more isolated agent workspaces under a required workspace name. Always returns `{ "agents": [ManagedAgent, ...] }`, never a bare id; each `ManagedAgent` includes `id`, `repoId`, `workspaceName`, `repoPath`, `baseCommit`, `sourcePath`, optional `parentAgentId`, `cwd`, `branch`, `threadId`, optional `activeTurnId`, `status`, and `createdAt`. Agent ids are 4-character lowercase hex strings, and `n > 1` returns multiple ids in the same `agents` array.
- `ls`: list managed agents.
- `status`: show agents and pending approvals.
- `remove`: remove one managed agent and its workspace by id.
- `turn`: show current turn state and recent events for one agent.
- `read`: write an agent transcript to `/tmp/orchestra` and return the path.
- `diff`: return the Git diff for an agent workspace.
- `exec`: run a shell command inside an agent workspace.
- `steer`: send guidance to an agent.
- `interrupt`: interrupt an active turn.
- `approvals`: list pending approvals.
- `approve`: approve a pending request.
- `deny`: deny a pending request.

Agents persist in Orchestra's SQLite store across MCP/client sessions and service restarts until removed with `remove` or `teardown`. The default MCP-backed service config is `model = "gpt-5.5"` and `serviceTier = "default"` unless config files override it; new agents default to `approvalPolicy: "never"` and `sandbox: "danger-full-access"` unless the request overrides them. `steer` starts a new turn when the agent is idle, or interleaves guidance into the tracked active turn when it is running; `exec` is a separate workspace shell command and can run while a turn is active.

Manual registration commands:

```bash
codex mcp add orchestra -- /home/boop/.bun/bin/bun run /path/to/orchestra/src/mcp_server.ts
claude mcp add -s user orchestra -- /home/boop/.bun/bin/bun run /path/to/orchestra/src/mcp_server.ts
```

## CLI

Run commands with:

```bash
orchestra <command>
```

Global options:

- `--model MODEL`: model for new threads or turns. Default: `gpt-5.5`.
- `--service-tier TIER`: app-server service tier, `default` or `priority`.
- `--config PATH`: load config from a specific TOML file.
- `--transport proxy|stdio`: Codex app-server transport. Default: `proxy`.
- `--db PATH`: SQLite database path. Default: `~/.orchestra/orchestra.db`.

### Workspace Commands

These are the main commands for multi-agent work.

```bash
orchestra create "auth cleanup" <dir> -n 4 --prompt "try four approaches"
orchestra create "dashboard polish" <dir> --prompt-file prompt.md
```

Creates one or more isolated workspaces from the repo under the required workspace name. Each agent gets a short id, its own worktree copy, and a branch named `orchestra/<id>`. A prompt is required so every created agent has an initial turn. The dashboard groups agents by workspace name first, with the source repo path shown as context.

```bash
orchestra status
```

Prints enriched status for all managed agents, including last assistant tail, turn count, token usage, last activity, and pending approvals.

The table stays compact and prints recent assistant output below it, so long summaries do not stretch every row.

```bash
orchestra teardown <workspace-name>
```

Destroys all agents in the exact workspace/run name. To remove a single agent, use `orchestra remove <id>`.

```bash
orchestra steer <id> "run tests and fix failures"
```

Sends guidance to an agent. If the agent is idle, this starts a new turn. If the agent is already running, this steers the active turn.

```bash
orchestra diff <id>
orchestra diff <id> --out patch.diff
```

Shows the Git diff for an agent workspace, or writes it to a file with `--out`.

```bash
orchestra exec <id> "bun test"
```

Runs a shell command inside the agent workspace and exits with the command exit code.

```bash
orchestra interrupt <id>
```

Interrupts the agent's active turn.

```bash
orchestra ls
orchestra remove <id>
orchestra standouts
orchestra approvals
```

Lists managed agents, removes one agent, prints mechanical standout signals, or lists pending approvals.

```bash
orchestra monitor <id>
orchestra monitor <workdir>
orchestra monitor <workdir> --follow
```

With an agent id, waits for that agent to finish and prints one completion line. With a workdir, prints one completion line for each agent in that workdir and exits when all matching agents are idle. Add `--follow` to keep watching for later turns.

### Debug Commands

These commands are kept for local debugging and app-server plumbing; the MCP tool surface does not expose them.

```bash
orchestra daemon start
orchestra daemon enable-remote-control
```

Pass-through helpers for `codex app-server daemon`.

```bash
orchestra run "fix the tests" --cwd .
```

Starts a Codex thread, sends one prompt, streams the turn, and exits when the turn completes.

```bash
orchestra start --cwd . --name "experiment"
```

Starts a Codex thread and prints its JSON metadata.

```bash
orchestra send THREAD_ID "next task"
```

Sends a prompt to an existing Codex thread and streams the response.

```bash
orchestra list --cwd .
```

Lists Codex threads, optionally filtered by cwd. Add `--archived` to include archived threads.

```bash
orchestra thread-read THREAD_ID
orchestra thread-steer THREAD_ID TURN_ID "guidance"
orchestra thread-interrupt THREAD_ID [TURN_ID]
```

Reads, steers, or interrupts app-server threads directly.

```bash
orchestra models
```

Lists available Codex models and service tiers.

## Development

```bash
bun run typecheck
bun test
bun run src/server.ts
bun run src/ui_server.ts
bun run src/mcp_server.ts
```

The app-server requests use `serviceTier: "default"` unless config or request overrides select `priority`.

## License

MIT
