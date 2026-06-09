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
- MCP stdio wrapper over the HTTP service.

## Install

```bash
git clone https://github.com/boopdotpng/orchestra.git
cd orchestra
./install.sh
```

The default installer:

- runs `bun install`
- enables Codex app-server daemon remote control when available
- installs `orchestra.service` as a systemd user service
- prints MCP registration commands without changing agent config

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
systemctl --user status orchestra
systemctl --user restart orchestra
journalctl --user -u orchestra -f
```

The HTTP service defaults to `http://127.0.0.1:5751`. Override with `ORCHESTRA_HOST` and `ORCHESTRA_PORT`.

## MCP

The project MCP template is `.mcp.json`. It runs:

```bash
bun run /path/to/orchestra/src/mcp_server.ts
```

The MCP server talks to the local Orchestra HTTP service, so the systemd service should normally be running first. The MCP `read` tool writes a transcript file under `/tmp/orchestra` and returns the path instead of dumping the entire context into the tool result. That file includes agent messages, turn events, tool calls, and tool call results captured from app-server notifications.

MCP tools:

- `register`: pin a source repo base commit.
- `create`: create one or more isolated agent workspaces.
- `ls`: list managed agents.
- `status`: show agents and pending approvals.
- `turn`: show current turn state and recent events for one agent.
- `read`: write an agent transcript to `/tmp/orchestra` and return the path.
- `diff`: return the Git diff for an agent workspace.
- `exec`: run a shell command inside an agent workspace.
- `steer`: send guidance to an agent.
- `interrupt`: interrupt an active turn.
- `approvals`: list pending approvals.
- `approve`: approve a pending request.
- `deny`: deny a pending request.

Manual registration commands:

```bash
codex mcp add orchestra -- /home/boop/.bun/bin/bun run /path/to/orchestra/src/mcp_server.ts
claude mcp add -s user orchestra -- /home/boop/.bun/bin/bun run /path/to/orchestra/src/mcp_server.ts
```

## CLI

Run commands with:

```bash
bun run src/cli.ts <command>
```

Global options:

- `--model MODEL`: model for new threads or turns. Default: `gpt-5.5`.
- `--transport proxy|stdio`: Codex app-server transport. Default: `proxy`.
- `--db PATH`: SQLite database path. Default: `~/.orchestra/orchestra.db`.
- `--approval POLICY`: `untrusted`, `on-failure`, `on-request`, or `never`.
- `--sandbox MODE`: `read-only`, `workspace-write`, or `danger-full-access`.

### Workspace Commands

These are the main commands for multi-agent work.

```bash
bun run src/cli.ts register <dir>
```

Pins a Git repository for Orchestra. The current commit becomes the base commit used when creating agent workspaces.

```bash
bun run src/cli.ts create <dir> -n 4 --prompt "try four approaches"
bun run src/cli.ts create <dir> --prompt-file prompt.md
```

Creates one or more isolated workspaces from the registered repo. Each agent gets a short id, its own worktree copy, and a branch named `orchestra/<id>`. If `--prompt` or `--prompt-file` is provided, Orchestra immediately starts a turn for each agent.

```bash
bun run src/cli.ts ls
```

Lists managed agents as `id`, status, repo path, branch, and workspace path.

```bash
bun run src/cli.ts steer <id> "run tests and fix failures"
```

Sends guidance to an agent. If the agent is idle, this starts a new turn. If the agent is already running, this steers the active turn.

```bash
bun run src/cli.ts turn <id>
```

Prints the current turn state and recent stored events for an agent as JSON.

```bash
bun run src/cli.ts read <id>
bun run src/cli.ts read <id> --json
```

Writes a readable transcript for the agent and prints the transcript file path. With `--json`, the transcript file contains structured JSON.

```bash
bun run src/cli.ts tail <id>
```

Prints current turn events and, if the agent has an active turn, streams output until that turn completes.

```bash
bun run src/cli.ts diff <id>
bun run src/cli.ts diff <id> --out patch.diff
```

Shows the Git diff for an agent workspace, or writes it to a file with `--out`.

```bash
bun run src/cli.ts exec <id> "bun test"
```

Runs a shell command inside the agent workspace and exits with the command exit code.

```bash
bun run src/cli.ts interrupt <id>
```

Interrupts the agent's active turn.

```bash
bun run src/cli.ts teardown <dir>
```

Removes Orchestra workspaces for a registered repo and marks the agents removed.

### Lower-Level Thread Commands

These commands operate closer to Codex app-server threads and do not create Orchestra-managed repo workspaces.

```bash
bun run src/cli.ts daemon start
bun run src/cli.ts daemon enable-remote-control
```

Pass-through helpers for `codex app-server daemon`.

```bash
bun run src/cli.ts run "fix the tests" --cwd . --approval on-request --sandbox workspace-write
```

Starts a Codex thread, sends one prompt, streams the turn, and exits when the turn completes. Add `--yes` to auto-approve command and file-change approvals.

```bash
bun run src/cli.ts start --cwd . --name "experiment"
```

Starts a Codex thread and prints its JSON metadata.

```bash
bun run src/cli.ts send THREAD_ID "next task"
```

Sends a prompt to an existing Codex thread and streams the response.

```bash
bun run src/cli.ts list --cwd .
```

Lists Codex threads, optionally filtered by cwd. Add `--archived` to include archived threads.

```bash
bun run src/cli.ts thread-read THREAD_ID
bun run src/cli.ts thread-steer THREAD_ID TURN_ID "guidance"
bun run src/cli.ts thread-interrupt THREAD_ID [TURN_ID]
```

Reads, steers, or interrupts app-server threads directly.

```bash
bun run src/cli.ts approvals
bun run src/cli.ts models
```

Lists pending approvals stored by Orchestra, or lists available Codex models and service tiers.

## Development

```bash
bun run typecheck
bun test
bun run src/server.ts
bun run src/mcp_server.ts
```

The app-server requests always send `serviceTier: "default"` so managed agents stay on the normal tier even when fast mode is available.

## License

MIT
