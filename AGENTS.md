# Agent Notes

## Restarting Services After Code Changes

Orchestra runs directly from the TypeScript source files with Bun. Long-running
processes do not reload code automatically, so restart the relevant user services
after changing runtime code.

Restart the control-plane service after changes under:

- `src/server.ts`
- `src/server/`
- `src/workspace/`
- `src/store/`
- `src/manager/`
- `src/backend/`
- `src/config.ts`
- `src/client.ts`
- `src/mcp_server.ts`
- shared domain/types used by the service

Use:

```bash
systemctl --user restart orchestra.service
```

Restart the UI service after changes under:

- `src/ui_server.ts`
- `src/ui/`

Use:

```bash
systemctl --user restart orchestra-ui.service
```

If a change affects both API behavior and the dashboard, restart both:

```bash
systemctl --user restart orchestra.service orchestra-ui.service
```

Before restarting, check for active agent turns so you do not interrupt work in
progress:

```bash
bun run src/cli.ts status
```

After restarting, verify both services and the CLI path:

```bash
systemctl --user status orchestra.service orchestra-ui.service --no-pager
bun run src/cli.ts status
```

The MCP server is normally launched by the client as a stdio process and talks to
the local HTTP service. Restart `orchestra.service` for API/control-plane code
changes. If you change MCP tool definitions in `src/mcp_server.ts`, restart the
MCP client session as well so it starts a fresh MCP process.
