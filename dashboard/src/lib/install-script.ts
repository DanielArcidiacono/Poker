import { getAgentToken } from "@/lib/store";

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
  agentToken: string;
  repoPath: string;
  gitRepo: string;
  viewerPassword: string;
}): string {
  const { controlPlane, agentToken, repoPath, gitRepo, viewerPassword } = opts;
  return `#!/bin/bash
set -euo pipefail

REPO_PATH="${repoPath}"
REPO_PATH="\${REPO_PATH/#\\~/$HOME}"
CONTROL_PLANE="${controlPlane}"
BUNDLE_URL="$CONTROL_PLANE/api/install-agent/bundle"
GIT_REPO="${gitRepo}"

echo "=== Screen Viewer installer ==="
echo "Dashboard: $CONTROL_PLANE"
echo "Install path: $REPO_PATH"
echo ""

need_node() {
  # Common when node was installed but this Terminal session is old.
  export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

  if ! command -v node >/dev/null 2>&1; then
    if command -v brew >/dev/null 2>&1; then
      echo "Node.js not found — installing with Homebrew…"
      brew install node
    else
      echo ""
      echo "ERROR: Node.js is not installed on this Mac."
      echo "1. Open https://nodejs.org and install the LTS version"
      echo "2. Quit Terminal completely (Cmd+Q) and open it again"
      echo "3. Re-run the same curl | bash command"
      echo ""
      exit 1
    fi
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
  echo "NOTE: cloudflared not installed — watch will use LAN fallback when possible."
  echo "Optional: brew install cloudflared"
}

need_node
ensure_cloudflared

echo "Checking dashboard at $CONTROL_PLANE …"
if ! curl -fsS -o /dev/null "$CONTROL_PLANE/api/go-live"; then
  echo "ERROR: Cannot reach the dashboard at $CONTROL_PLANE"
  echo "Is the dashboard Mac on and is this computer on the same Wi‑Fi?"
  exit 1
fi
echo "Dashboard reachable."
echo ""

has_agent() {
  [[ -f "$REPO_PATH/package.json" && -f "$REPO_PATH/src/server.ts" && -f "$REPO_PATH/scripts/install-agent.sh" ]]
}

fetch_agent() {
  echo "Downloading agent from dashboard…"
  mkdir -p "$REPO_PATH"
  local tmp
  tmp="$(mktemp -t screen-viewer-XXXXXX.tgz)"
  if ! curl -fsSL "$BUNDLE_URL" -o "$tmp"; then
    rm -f "$tmp"
    echo "Could not download agent package from $BUNDLE_URL"
    return 1
  fi
  # Clear incomplete / README-only clones so extract can succeed.
  rm -rf "$REPO_PATH/src" "$REPO_PATH/scripts" "$REPO_PATH/public" "$REPO_PATH/launchd"
  if ! tar -xzf "$tmp" -C "$REPO_PATH"; then
    rm -f "$tmp"
    echo "Downloaded package was not a valid archive."
    return 1
  fi
  rm -f "$tmp"
  has_agent
}

clone_agent() {
  echo "Falling back to git clone…"
  mkdir -p "$(dirname "$REPO_PATH")"
  if [[ -d "$REPO_PATH/.git" ]]; then
    # Incomplete GitHub clone (README only) — replace it.
    rm -rf "$REPO_PATH"
  fi
  git clone "$GIT_REPO" "$REPO_PATH"
}

# Always refresh agent code from the live dashboard (fixes stale installs).
if ! fetch_agent; then
  if ! has_agent; then
    echo "Dashboard package unavailable — trying git…"
    clone_agent
  else
    echo "Using existing agent files (dashboard package refresh failed)."
  fi
fi

cd "$REPO_PATH"

if ! has_agent; then
  echo "ERROR: Agent files are missing in $REPO_PATH"
  echo "Your GitHub repo may only have README.md. Use the dashboard download, or push the full project."
  exit 1
fi

cat > .env <<'ENVEOF'
VIEWER_PASSWORD=${viewerPassword}
CONTROL_PLANE_URL=${controlPlane}
AGENT_TOKEN=${agentToken}
CORS_ORIGINS=${controlPlane},http://localhost:3000,http://127.0.0.1:3000
PORT=8787
FPS=8
JPEG_QUALITY=60
SCALE=0.5
ENVEOF

echo "Installing npm dependencies…"
# npm 11+ may skip native install scripts (sharp) unless forced.
npm install --foreground-scripts
npm rebuild sharp || true

# Background LaunchAgent is optional; simple share (below) is what actually works
# reliably — same model as streaming from computer 1.
echo "Installing background agent (optional)…"
DEFER_START=0 npm run install-agent || true

echo ""
echo "========================================"
echo "SIMPLE SHARE (same as computer 1)"
echo "Leave this Terminal open while sharing."
echo "========================================"
echo ""
echo "Starting public link…"
echo ""

# Foreground share: prints a trycloudflare.com URL to open on the other Mac.
exec npm run share
`;
}

function controlPlaneFromHost(req: Request): string | null {
  const host =
    req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
    req.headers.get("host")?.trim();
  if (!host) return null;
  const proto =
    req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
    (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "http");
  return sanitizeUrl(`${proto}://${host}`);
}

export function resolveInstallConfig(req: Request) {
  const reqUrl = new URL(req.url);
  const controlPlane =
    sanitizeUrl(reqUrl.searchParams.get("controlPlaneUrl")) ||
    sanitizeUrl(req.headers.get("origin")) ||
    sanitizeUrl(req.headers.get("referer")) ||
    controlPlaneFromHost(req) ||
    sanitizeUrl(process.env.NEXT_PUBLIC_APP_URL ?? null) ||
    "http://127.0.0.1:3000";

  const agentToken = getAgentToken();
  const repoPath = process.env.NEXT_PUBLIC_SETUP_REPO_PATH ?? "~/Poker";
  const gitRepo =
    process.env.NEXT_PUBLIC_GIT_REPO ??
    "https://github.com/DanielArcidiacono/Poker.git";
  const viewerPassword =
    process.env.BOOTSTRAP_VIEWER_PASSWORD?.trim() || "change-me";

  return { controlPlane, agentToken, repoPath, gitRepo, viewerPassword };
}
