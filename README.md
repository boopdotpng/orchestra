# Orchestra

Codex multi-agent orchestration over `codex app-server` protocol v2.

## What Works

- Workspace-aware CLI with short agent ids.
- Reflink workspace creation under `~/.orchestra/runs/<repo>/<id>`.
- Git branch isolation as `orchestra/<id>` from a pinned base commit.
- SQLite state in `~/.orchestra/orchestra.db`.
- Codex app-server JSON-RPC transport isolated behind `CodexBackend`.
- Local HTTP service for long-lived control.
- MCP stdio wrapper over the HTTP service.

## CLI

```bash
bun run src/cli.ts register <dir>
bun run src/cli.ts create <dir> -n 4 --prompt "try four approaches"
bun run src/cli.ts ls
bun run src/cli.ts steer <id> "run tests and fix failures"
bun run src/cli.ts turn <id>
bun run src/cli.ts read <id>
bun run src/cli.ts diff <id>
bun run src/cli.ts interrupt <id>
bun run src/cli.ts teardown <dir>
```

`--model` defaults to `gpt-5.5`.

## Service + MCP

```bash
./install.sh
```

The installer:

- runs `bun install`
- starts Codex app-server daemon remote control
- installs `orchestra.service` as a systemd user service
- prints MCP registration commands

Manual MCP command:

```bash
bun run /path/to/orchestra/src/mcp_server.ts
```

Manual service command:

```bash
bun run /path/to/orchestra/src/server.ts
```

The HTTP service defaults to `127.0.0.1:5751`.

## License

MIT
