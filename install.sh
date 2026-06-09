#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== orchestra installer ==="
echo "Repo: $REPO_DIR"
echo ""

echo "[1/4] Installing Bun dependencies..."
cd "$REPO_DIR"
bun install

echo "[2/4] Starting Codex app-server daemon..."
codex app-server daemon start || true
codex app-server daemon enable-remote-control || true

echo "[3/4] Installing systemd user service..."
mkdir -p ~/.config/systemd/user
cp "$REPO_DIR/orchestra.service" ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now orchestra
echo "  -> orchestra.service enabled and started"

echo "[4/4] Done!"
echo ""
echo "=== Register the MCP server with your agent ==="
echo ""
echo "Codex:"
echo "  codex mcp add orchestra -- bun run $REPO_DIR/src/mcp_server.ts"
echo ""
echo "Claude Code:"
echo "  claude mcp add -s user orchestra -- bun run $REPO_DIR/src/mcp_server.ts"
echo ""
echo "Project .mcp.json:"
echo "  {\"mcpServers\":{\"orchestra\":{\"command\":\"bun\",\"args\":[\"run\",\"$REPO_DIR/src/mcp_server.ts\"],\"cwd\":\"$REPO_DIR\",\"timeout\":300}}}"
