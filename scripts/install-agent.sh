#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.local.screenviewer"
PLIST_SRC="$ROOT/launchd/com.local.screenviewer.plist"
PLIST_DST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="$HOME/Library/Logs/screenviewer"

if [[ ! -f "$ROOT/.env" ]]; then
  echo "Missing $ROOT/.env — copy .env.example and set VIEWER_PASSWORD first."
  exit 1
fi

# shellcheck disable=SC1091
set -a
source "$ROOT/.env"
set +a

if [[ -z "${VIEWER_PASSWORD:-}" ]]; then
  echo "VIEWER_PASSWORD must be set in .env"
  exit 1
fi

NODE_BIN="$(command -v node)"
NPX_BIN="$(command -v npx)"
if [[ -z "$NODE_BIN" || -z "$NPX_BIN" ]]; then
  echo "node/npx not found on PATH"
  exit 1
fi

# Prefer local tsx binary for a stable ProgramArguments path
TSX_BIN="$ROOT/node_modules/.bin/tsx"
if [[ ! -x "$TSX_BIN" ]]; then
  echo "Installing dependencies…"
  (cd "$ROOT" && npm install)
fi
if [[ ! -x "$TSX_BIN" ]]; then
  echo "tsx not found at $TSX_BIN after npm install"
  exit 1
fi

mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"

PORT_VAL="${PORT:-8787}"
FPS_VAL="${FPS:-8}"
JPEG_VAL="${JPEG_QUALITY:-60}"
SCALE_VAL="${SCALE:-0.5}"
CF_TOKEN="${CLOUDFLARED_TOKEN:-}"
CF_CONFIG="${CLOUDFLARED_CONFIG:-}"
AUTO_TUNNEL_VAL="${AUTO_TUNNEL:-0}"
SHARE_ON_START_VAL="${SHARE_ON_START:-0}"
CONTROL_PLANE_URL_VAL="${CONTROL_PLANE_URL:-}"
AGENT_TOKEN_VAL="${AGENT_TOKEN:-}"
CORS_ORIGINS_VAL="${CORS_ORIGINS:-}"
PATH_VAL="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:$PATH"

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g'
}

ESCAPED_PASSWORD=$(xml_escape "$VIEWER_PASSWORD")
ESCAPED_AGENT_TOKEN=$(xml_escape "$AGENT_TOKEN_VAL")
ESCAPED_CONTROL_PLANE=$(xml_escape "$CONTROL_PLANE_URL_VAL")
ESCAPED_CORS=$(xml_escape "$CORS_ORIGINS_VAL")

sed \
  -e "s|__NODE_BIN__|${NODE_BIN}|g" \
  -e "s|__TSX_BIN__|${TSX_BIN}|g" \
  -e "s|__SERVER_ENTRY__|${ROOT}/src/server.ts|g" \
  -e "s|__PROJECT_ROOT__|${ROOT}|g" \
  -e "s|__LOG_DIR__|${LOG_DIR}|g" \
  -e "s|__PATH__|${PATH_VAL}|g" \
  -e "s|__VIEWER_PASSWORD__|${ESCAPED_PASSWORD}|g" \
  -e "s|__PORT__|${PORT_VAL}|g" \
  -e "s|__FPS__|${FPS_VAL}|g" \
  -e "s|__JPEG_QUALITY__|${JPEG_VAL}|g" \
  -e "s|__SCALE__|${SCALE_VAL}|g" \
  -e "s|__CLOUDFLARED_TOKEN__|${CF_TOKEN}|g" \
  -e "s|__CLOUDFLARED_CONFIG__|${CF_CONFIG}|g" \
  -e "s|__AUTO_TUNNEL__|${AUTO_TUNNEL_VAL}|g" \
  -e "s|__SHARE_ON_START__|${SHARE_ON_START_VAL}|g" \
  -e "s|__CONTROL_PLANE_URL__|${ESCAPED_CONTROL_PLANE}|g" \
  -e "s|__AGENT_TOKEN__|${ESCAPED_AGENT_TOKEN}|g" \
  -e "s|__CORS_ORIGINS__|${ESCAPED_CORS}|g" \
  "$PLIST_SRC" >"$PLIST_DST"

launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"
launchctl enable "gui/$(id -u)/${LABEL}" 2>/dev/null || true

if [[ "${DEFER_START:-0}" == "1" ]]; then
  echo "Installed LaunchAgent (start deferred): $PLIST_DST"
else
  launchctl kickstart -k "gui/$(id -u)/${LABEL}" 2>/dev/null || launchctl start "$LABEL"
  echo "Installed LaunchAgent: $PLIST_DST"

  echo "Waiting for local health…"
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    if curl -fsS "http://127.0.0.1:${PORT_VAL}/api/health" >/dev/null 2>&1; then
      echo "Local agent is responding on port ${PORT_VAL}"
      break
    fi
    sleep 1
  done
fi

echo "Logs: $LOG_DIR/screenviewer.*.log"
echo "Local URL: http://127.0.0.1:${PORT_VAL}"
echo ""
echo "Grant Screen Recording to this Node binary if prompted:"
echo "  $NODE_BIN"
echo "System Settings → Privacy & Security → Screen Recording"
