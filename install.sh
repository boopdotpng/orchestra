#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
BUN_BIN="${BUN_BIN:-$HOME/.bun/bin/bun}"
INSTALL_CODEX=0
INSTALL_CLAUDE=0
INSTALL_SERVICE=1
INSTALL_DEPS=1

usage() {
  cat <<EOF
Usage: ./install.sh [options]

Options:
  --codex        Register the Orchestra MCP server in Codex.
  --claude       Register the Orchestra MCP server in Claude Code user config.
  --all          Register both Codex and Claude MCP servers.
  --no-service   Do not install/start the systemd user service.
  --no-deps      Do not run bun install.
  -h, --help     Show this help.

By default, installs dependencies and the systemd user service, then prints MCP
registration commands without changing Codex or Claude config.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --codex)
      INSTALL_CODEX=1
      ;;
    --claude)
      INSTALL_CLAUDE=1
      ;;
    --all)
      INSTALL_CODEX=1
      INSTALL_CLAUDE=1
      ;;
    --no-service)
      INSTALL_SERVICE=0
      ;;
    --no-deps)
      INSTALL_DEPS=0
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if [[ ! -x "$BUN_BIN" ]]; then
  if command -v bun >/dev/null 2>&1; then
    BUN_BIN="$(command -v bun)"
  else
    echo "bun not found. Install Bun or set BUN_BIN=/path/to/bun." >&2
    exit 1
  fi
fi

echo "=== orchestra installer ==="
echo "Repo: $REPO_DIR"
echo "Bun:  $BUN_BIN"
echo ""

cd "$REPO_DIR"

if [[ "$INSTALL_DEPS" -eq 1 ]]; then
  echo "[1/5] Installing Bun dependencies..."
  "$BUN_BIN" install
else
  echo "[1/5] Skipping dependency install."
fi

mkdir -p "$HOME/.orchestra"
if [[ ! -f "$HOME/.orchestra/config.toml" ]]; then
  cat > "$HOME/.orchestra/config.toml" <<'EOF'
model = "gpt-5.5"
fast_mode = false
EOF
  echo "  -> wrote default config: $HOME/.orchestra/config.toml"
else
  echo "  -> config already exists: $HOME/.orchestra/config.toml"
fi

echo "[2/5] Enabling Codex app-server remote control when available..."
if command -v codex >/dev/null 2>&1; then
  codex app-server daemon enable-remote-control || true
else
  echo "  -> codex not found; Orchestra service will still use app-server stdio fallback."
fi

if [[ "$INSTALL_SERVICE" -eq 1 ]]; then
  echo "[3/5] Installing systemd user services..."
  mkdir -p ~/.config/systemd/user
  cp "$REPO_DIR/orchestra.service" ~/.config/systemd/user/
  cp "$REPO_DIR/orchestra-ui.service" ~/.config/systemd/user/
  systemctl --user daemon-reload
  systemctl --user enable --now orchestra
  systemctl --user enable --now orchestra-ui
  API_PORT="${ORCHESTRA_PORT:-5751}"
  UI_PORT="${ORCHESTRA_UI_PORT:-$((API_PORT + 1))}"
  echo "  -> orchestra.service (API) enabled on 127.0.0.1:${API_PORT}"
  echo "  -> orchestra-ui.service (dashboard) enabled on 0.0.0.0:${UI_PORT}"
else
  echo "[3/5] Skipping systemd service install."
fi

echo "[4/5] Registering requested MCP servers..."
if [[ "$INSTALL_CODEX" -eq 1 ]]; then
  if command -v codex >/dev/null 2>&1; then
    codex mcp remove orchestra >/dev/null 2>&1 || true
    codex mcp add orchestra -- "$BUN_BIN" run "$REPO_DIR/src/mcp_server.ts"
    echo "  -> registered Codex MCP server: orchestra"
  else
    echo "  -> codex not found; skipped Codex MCP registration."
  fi
else
  echo "  -> Codex MCP registration skipped. Use --codex or --all."
fi

if [[ "$INSTALL_CLAUDE" -eq 1 ]]; then
  if command -v claude >/dev/null 2>&1; then
    claude mcp remove -s user orchestra >/dev/null 2>&1 || true
    claude mcp add -s user orchestra -- "$BUN_BIN" run "$REPO_DIR/src/mcp_server.ts"
    echo "  -> registered Claude Code MCP server: orchestra"
  else
    echo "  -> claude not found; skipped Claude MCP registration."
  fi
else
  echo "  -> Claude MCP registration skipped. Use --claude or --all."
fi

echo "[5/5] Done!"
echo ""
if [[ "$INSTALL_SERVICE" -eq 1 ]]; then
  API_PORT="${ORCHESTRA_PORT:-5751}"
  UI_PORT="${ORCHESTRA_UI_PORT:-$((API_PORT + 1))}"
  HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  echo "=== Dashboard ==="
  echo "  Local:   http://127.0.0.1:${UI_PORT}"
  [[ -n "$HOST_IP" ]] && echo "  Network: http://${HOST_IP}:${UI_PORT}"
  echo ""
fi
echo "=== Register the MCP server with your agent ==="
echo ""
echo "Codex:"
echo "  ./install.sh --codex"
echo "  codex mcp add orchestra -- $BUN_BIN run $REPO_DIR/src/mcp_server.ts"
echo ""
echo "Claude Code:"
echo "  ./install.sh --claude"
echo "  claude mcp add -s user orchestra -- $BUN_BIN run $REPO_DIR/src/mcp_server.ts"
echo ""
echo "Project .mcp.json:"
echo "  .mcp.json is already present in this repo."
