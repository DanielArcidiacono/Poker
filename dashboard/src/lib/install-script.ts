import { randomBytes } from "node:crypto";

function sanitizeUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

export function buildInstallScript(opts: {
  controlPlane: string;
  clientId: string;
  agentCredential: string;
  viewerPassword: string;
}): string {
  const { controlPlane, clientId, agentCredential, viewerPassword } = opts;
  const encodedControlPlane = Buffer.from(controlPlane).toString("base64");
  const encodedAgentCredential =
    Buffer.from(agentCredential).toString("base64");
  const encodedViewerPassword = Buffer.from(viewerPassword).toString("base64");
  return `#!/bin/bash
set -euo pipefail
umask 077

CONTROL_PLANE_B64='${encodedControlPlane}'
PROSTAR_CLIENT_ID='${clientId}'
PROSTAR_AGENT_SECRET_B64='${encodedAgentCredential}'
VIEWER_PASSWORD_B64='${encodedViewerPassword}'

INSTALL_LOG_DIR="$HOME/Library/Logs/Prostar"
INSTALL_LOG="$INSTALL_LOG_DIR/install.log"
INSTALL_SUCCEEDED=0
KEEP_RELEASE=0
STAGING=""
REPO_PATH=""
CURRENT_PATH=""
PREVIOUS_CURRENT_TARGET=""
CURRENT_SWAPPED=0

mkdir -p "$INSTALL_LOG_DIR"
exec 3>&1 4>&2
: > "$INSTALL_LOG"
exec >>"$INSTALL_LOG" 2>&1

cleanup() {
  if [[ -n "$STAGING" ]]; then
    rm -rf "$STAGING" 2>/dev/null || true
  fi
  if [[ "$KEEP_RELEASE" != "1" && -n "$REPO_PATH" ]]; then
    rm -rf "$REPO_PATH" 2>/dev/null || true
  fi
}

finish() {
  code=$?
  if [[ "$INSTALL_SUCCEEDED" != "1" && -n "$REPO_PATH" ]]; then
    if [[ -f "$REPO_PATH/.prostar-install-pending" ]]; then
      /bin/bash "$REPO_PATH/scripts/install-agent.sh" --rollback-install || true
      KEEP_RELEASE=0
    fi
    if [[ "$CURRENT_SWAPPED" == "1" && -n "$CURRENT_PATH" ]]; then
      if [[ -n "$PREVIOUS_CURRENT_TARGET" ]]; then
        recovery_link="\${CURRENT_PATH%/*}/.current-rollback.$$"
        if ln -s "$PREVIOUS_CURRENT_TARGET" "$recovery_link"; then
          mv -hf "$recovery_link" "$CURRENT_PATH" || KEEP_RELEASE=1
        else
          KEEP_RELEASE=1
        fi
      else
        rm -f "$CURRENT_PATH"
      fi
    fi
  fi
  cleanup
  trap - EXIT
  if [[ "$INSTALL_SUCCEEDED" == "1" && "$code" == "0" ]]; then
    printf '%s\n' 'Prostar installed successfully.' >&3
  else
    printf 'Prostar installation failed. See %s\n' "$INSTALL_LOG" >&4
  fi
  exit "$code"
}
trap finish EXIT

need_node() {
  # Common when node was installed but this Terminal session is old.
  export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

  node_supported() {
    command -v node >/dev/null 2>&1 && node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 20 || (major === 20 && minor >= 9) ? 0 : 1)'
  }

  if ! node_supported; then
    if command -v brew >/dev/null 2>&1; then
      echo "Node.js 20.9+ is required — installing the current release with Homebrew…"
      brew upgrade node 2>/dev/null || brew install node
      hash -r
    else
      echo ""
      echo "ERROR: Node.js 20.9 or later is required on this Mac."
      echo "1. Open https://nodejs.org and install the LTS version"
      echo "2. Quit Terminal completely (Cmd+Q) and open it again"
      echo "3. Re-run the same curl | bash command"
      echo ""
      exit 1
    fi
  fi
  if ! node_supported; then
    echo "ERROR: Node.js 20.9 or later is required (found $(node -v 2>/dev/null || echo none))."
    echo "Install the current LTS release from https://nodejs.org, then rerun this command."
    exit 1
  fi
  if ! command -v npm >/dev/null 2>&1; then
    echo "ERROR: npm is required (comes with Node.js). Reinstall from https://nodejs.org"
    exit 1
  fi
  echo "Using Node $(node -v) / npm $(npm -v)"
}

ensure_cloudflared() {
  export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
  if command -v cloudflared >/dev/null 2>&1; then
    echo "cloudflared: $(command -v cloudflared)"
    return 0
  fi
  if command -v brew >/dev/null 2>&1; then
    echo "Installing cloudflared (needed for remote watch)…"
    brew install cloudflare/cloudflare/cloudflared || brew install cloudflared || true
  fi
  if command -v cloudflared >/dev/null 2>&1; then
    echo "cloudflared: $(command -v cloudflared)"
    return 0
  fi
  echo "ERROR: cloudflared is required for secure remote viewing."
  echo "Install it with 'brew install cloudflared', then rerun this command."
  exit 1
}

need_node
decode_b64() {
  node -e 'process.stdout.write(Buffer.from(process.argv[1], "base64").toString("utf8"))' "$1"
}
CONTROL_PLANE="$(decode_b64 "$CONTROL_PLANE_B64")"
PROSTAR_AGENT_SECRET_VALUE="$(decode_b64 "$PROSTAR_AGENT_SECRET_B64")"
VIEWER_PASSWORD_VALUE="$(decode_b64 "$VIEWER_PASSWORD_B64")"
APP_ROOT="$HOME/Library/Application Support/Prostar"
CURRENT_PATH="$APP_ROOT/current"
if [[ -e "$CURRENT_PATH" && ! -L "$CURRENT_PATH" ]]; then
  echo "ERROR: Cannot install because $CURRENT_PATH already exists and is not a Prostar release link."
  exit 1
fi
if [[ -L "$CURRENT_PATH" ]]; then
  PREVIOUS_CURRENT_TARGET="$(readlink "$CURRENT_PATH")"
fi
mkdir -p "$APP_ROOT/releases"
REPO_PATH="$APP_ROOT/releases/$(date +%Y%m%d%H%M%S)-$$"
mkdir "$REPO_PATH"
BUNDLE_URL="$CONTROL_PLANE/prostar-agent.tgz"

echo "=== Prostar installer ==="
echo "Dashboard: $CONTROL_PLANE"
echo "Install path: $REPO_PATH"
echo ""
ensure_cloudflared

echo "Checking dashboard at $CONTROL_PLANE …"
if ! curl -fsS -o /dev/null "$CONTROL_PLANE/"; then
  echo "ERROR: Cannot reach the dashboard at $CONTROL_PLANE"
  echo "Check the dashboard address and this Mac's network connection."
  exit 1
fi
echo "Dashboard reachable."
echo ""

echo "Downloading agent from dashboard…"
STAGING="$(mktemp -d -t prostar.XXXXXX)"
mkdir -p "$STAGING/extracted"
curl -fsSL "$BUNDLE_URL" -o "$STAGING/prostar-agent.tgz"
curl -fsSL "$BUNDLE_URL.sha256" -o "$STAGING/prostar-agent.tgz.sha256"
(cd "$STAGING" && /usr/bin/shasum -a 256 -c prostar-agent.tgz.sha256)
tar -xzf "$STAGING/prostar-agent.tgz" -C "$STAGING/extracted"
if [[ ! -f "$STAGING/extracted/package.json" || ! -f "$STAGING/extracted/src/server.ts" || ! -f "$STAGING/extracted/scripts/install-agent.sh" ]]; then
  echo "ERROR: Downloaded package is incomplete."
  exit 1
fi
/usr/bin/ditto "$STAGING/extracted" "$REPO_PATH"
rm -rf "$STAGING"

cd "$REPO_PATH"

{
  printf 'PROSTAR_VIEWER_PASSWORD=%s\n' "$VIEWER_PASSWORD_VALUE"
  printf 'CONTROL_PLANE_URL=%s\n' "$CONTROL_PLANE"
  printf 'PROSTAR_CLIENT_ID=%s\n' "$PROSTAR_CLIENT_ID"
  printf 'PROSTAR_AGENT_SECRET=%s\n' "$PROSTAR_AGENT_SECRET_VALUE"
  printf '%s\n' 'PORT=8787' 'FPS=8' 'JPEG_QUALITY=60' 'SCALE=0.5' 'MAX_WIDTH=1920'
} > .env
chmod 600 .env

echo "Installing npm dependencies…"
npm ci --foreground-scripts

echo "Installing background agent (keeps running after Terminal quits)…"
npm run install-agent
KEEP_RELEASE=1

echo ""
echo "Waiting for local agent…"
LOCAL_OK=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  if curl -fsS "http://127.0.0.1:8787/api/health" >/dev/null 2>&1; then
    LOCAL_OK=1
    break
  fi
  sleep 1
done
if [[ "$LOCAL_OK" != "1" ]]; then
  echo "ERROR: Agent did not start. Logs:"
  tail -n 40 "$HOME/Library/Logs/Prostar/prostar.err.log" 2>/dev/null || true
  exit 1
fi

permission_ready() {
  curl --max-time 15 -fsS -o /dev/null \
    -X POST \
    -H "Authorization: Bearer $PROSTAR_AGENT_SECRET_VALUE" \
    "http://127.0.0.1:8787/api/capture/preflight"
}

echo "Checking Screen Recording permission…"
PERMISSION_OK=0
if permission_ready; then
  PERMISSION_OK=1
else
  echo "Allow Screen Recording for Prostar's displayed Node helper."
  open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture" >/dev/null 2>&1 || \
    open "x-apple.systempreferences:" >/dev/null 2>&1 || true
  echo "Waiting for permission in System Settings…"
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    sleep 3
    if permission_ready; then
      PERMISSION_OK=1
      break
    fi
  done
fi
unset PROSTAR_AGENT_SECRET_VALUE VIEWER_PASSWORD_VALUE
if [[ "$PERMISSION_OK" != "1" ]]; then
  echo ""
  if [[ -f "$REPO_PATH/.prostar-install-pending" ]]; then
    bash "$REPO_PATH/scripts/install-agent.sh" --rollback-install
    KEEP_RELEASE=0
    echo "Screen Recording was not enabled, so the previous background agent was restored."
  else
    echo "Screen Recording is not enabled yet. Prostar is installed, but it will not capture the screen."
  fi
  echo "Allow it in System Settings → Privacy & Security → Screen Recording, then return to the dashboard for a fresh setup command."
  exit 1
fi
echo "Screen Recording is ready."
NEXT_LINK="$APP_ROOT/.current.$$"
ln -s "$REPO_PATH" "$NEXT_LINK"
mv -hf "$NEXT_LINK" "$CURRENT_PATH"
CURRENT_SWAPPED=1
bash "$REPO_PATH/scripts/install-agent.sh" --finalize-install
INSTALL_SUCCEEDED=1
`;
}

export function resolveInstallConfig(
  req: Request,
  enrollment: { clientId: string; agentCredential: string },
) {
  const reqUrl = new URL(req.url);
  const controlPlane =
    sanitizeUrl(process.env.NEXT_PUBLIC_APP_URL ?? null) ||
    sanitizeUrl(reqUrl.origin) ||
    "http://127.0.0.1:3000";

  const configuredViewerPassword =
    process.env.PROSTAR_BOOTSTRAP_VIEWER_PASSWORD?.trim() ??
    process.env.BOOTSTRAP_VIEWER_PASSWORD?.trim();
  if (
    configuredViewerPassword &&
    !/^[A-Za-z0-9_-]{12,128}$/.test(configuredViewerPassword)
  ) {
    throw new Error(
      "PROSTAR_BOOTSTRAP_VIEWER_PASSWORD must be 12–128 URL-safe characters",
    );
  }
  const viewerPassword =
    configuredViewerPassword || randomBytes(24).toString("base64url");

  return { controlPlane, viewerPassword, ...enrollment };
}
