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
  installToken: string;
}): string {
  const {
    controlPlane,
    clientId,
    installToken,
  } = opts;
  const encodedControlPlane = Buffer.from(controlPlane).toString("base64");
  const encodedInstallToken = Buffer.from(installToken).toString("base64");
  return `#!/bin/bash
set -euo pipefail
umask 077

CONTROL_PLANE_B64='${encodedControlPlane}'
PROSTAR_CLIENT_ID='${clientId}'
INSTALL_TOKEN_B64='${encodedInstallToken}'

INSTALL_LOG_DIR="$HOME/Library/Logs/Prostar"
INSTALL_LOG="$INSTALL_LOG_DIR/install.log"
INSTALL_SUCCEEDED=0
KEEP_RELEASE=0
STAGING=""
REPO_PATH=""
CURRENT_PATH=""
PREVIOUS_CURRENT_TARGET=""
CURRENT_SWAPPED=0
ENROLLED_NEW_IDENTITY=0
PROSTAR_AGENT_SECRET_VALUE=""

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
  if [[ "$INSTALL_SUCCEEDED" != "1" && "$ENROLLED_NEW_IDENTITY" == "1" ]]; then
    CLEANUP_STATUS=""
    for _ in 1 2 3 4 5; do
      CLEANUP_STATUS="$(/usr/bin/curl -q --max-time 15 -sS -o /dev/null -w '%{http_code}' \
        -X DELETE \
        -H "Authorization: Bearer $PROSTAR_AGENT_SECRET_VALUE" \
        -H 'Content-Type: application/json' \
        --data "{\\\"clientId\\\":\\\"$PROSTAR_CLIENT_ID\\\"}" \
        "$CONTROL_PLANE/api/agent/deenroll" || true)"
      [[ "$CLEANUP_STATUS" == "204" || "$CLEANUP_STATUS" == "401" ]] && break
      sleep 1
    done
    if [[ "$CLEANUP_STATUS" == "204" ]]; then
      rm -f "$PENDING_IDENTITY_PATH"
    else
      # Preserve the locally generated credential so a later setup/uninstall
      # can finish revocation after an ambiguous network failure.
      KEEP_RELEASE=1
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

decode_b64() {
  printf '%s' "$1" | /usr/bin/base64 -D
}
CONTROL_PLANE="$(decode_b64 "$CONTROL_PLANE_B64")"
VIEWER_PASSWORD_VALUE="$(/usr/bin/uuidgen | /usr/bin/tr -d '-')$(/usr/bin/uuidgen | /usr/bin/tr -d '-')"
INSTALL_TOKEN_VALUE="$(decode_b64 "$INSTALL_TOKEN_B64")"
if [[ "$CONTROL_PLANE" == https://* ]]; then
  DASHBOARD_PROTOCOL='=https'
elif [[ "$CONTROL_PLANE" =~ ^http://(127\.0\.0\.1|localhost)(:[0-9]+)?$ ]]; then
  DASHBOARD_PROTOCOL='=http'
else
  echo "ERROR: Production setup requires HTTPS (HTTP is allowed only on loopback)."
  exit 1
fi
APP_ROOT="$HOME/Library/Application Support/Prostar"
CURRENT_PATH="$APP_ROOT/current"
PENDING_IDENTITY_PATH="$APP_ROOT/.pending-enrollment"
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

echo "Checking dashboard at $CONTROL_PLANE …"
if ! /usr/bin/curl -qfsS -o /dev/null "$CONTROL_PLANE/"; then
  echo "ERROR: Cannot reach the dashboard at $CONTROL_PLANE"
  echo "Check the dashboard address and this Mac's network connection."
  exit 1
fi
echo "Dashboard reachable."
echo ""

env_value_from_file() {
  local file="$1"
  local key="$2"
  local line value
  line="$(/usr/bin/grep -m 1 "^\${key}=" "$file" 2>/dev/null || true)"
  [[ -n "$line" ]] || return 0
  value="\${line#*=}"
  value="\${value%$'\r'}"
  printf '%s' "$value"
}

if [[ -L "$PENDING_IDENTITY_PATH" ]]; then
  echo "ERROR: Refusing an unsafe pending-enrollment link."
  exit 1
fi
if [[ -f "$PENDING_IDENTITY_PATH" ]]; then
  PENDING_CONTROL_PLANE="$(env_value_from_file "$PENDING_IDENTITY_PATH" CONTROL_PLANE_URL)"
  PENDING_CLIENT_ID="$(env_value_from_file "$PENDING_IDENTITY_PATH" PROSTAR_CLIENT_ID)"
  PENDING_AGENT_SECRET="$(env_value_from_file "$PENDING_IDENTITY_PATH" PROSTAR_AGENT_SECRET)"
  if [[ "\${PENDING_CONTROL_PLANE%/}" != "\${CONTROL_PLANE%/}" || \
        ! "$PENDING_CLIENT_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ || \
        ! "$PENDING_AGENT_SECRET" =~ ^[A-Za-z0-9_-]{32,256}$ ]]; then
    echo "ERROR: A previous Prostar enrollment needs manual recovery."
    exit 1
  fi
  PENDING_STATUS=""
  for _ in 1 2 3 4 5; do
    PENDING_STATUS="$(/usr/bin/curl -q --max-time 15 -sS -o /dev/null -w '%{http_code}' \
      -X DELETE \
      -H "Authorization: Bearer $PENDING_AGENT_SECRET" \
      -H 'Content-Type: application/json' \
      --data "{\\\"clientId\\\":\\\"$PENDING_CLIENT_ID\\\"}" \
      "$CONTROL_PLANE/api/agent/deenroll" || true)"
    [[ "$PENDING_STATUS" == "204" || "$PENDING_STATUS" == "401" ]] && break
    sleep 1
  done
  if [[ "$PENDING_STATUS" != "204" ]]; then
    echo "ERROR: Could not finish cleanup from the previous setup (HTTP \${PENDING_STATUS:-unreachable})."
    exit 1
  fi
  rm -f "$PENDING_IDENTITY_PATH"
fi

# Consume the short-lived setup claim before any large downloads. A reinstall
# on the same Mac instead keeps its durable identity; hostnames are labels and
# can legitimately change with DNS.
REUSE_EXISTING_IDENTITY=0
if [[ -n "$PREVIOUS_CURRENT_TARGET" && \
      "$PREVIOUS_CURRENT_TARGET" == "$APP_ROOT"/releases/* && \
      -f "$PREVIOUS_CURRENT_TARGET/.env" ]]; then
  EXISTING_CONTROL_PLANE="$(env_value_from_file "$PREVIOUS_CURRENT_TARGET/.env" CONTROL_PLANE_URL)"
  EXISTING_CLIENT_ID="$(env_value_from_file "$PREVIOUS_CURRENT_TARGET/.env" PROSTAR_CLIENT_ID)"
  EXISTING_AGENT_SECRET="$(env_value_from_file "$PREVIOUS_CURRENT_TARGET/.env" PROSTAR_AGENT_SECRET)"
  EXISTING_VIEWER_PASSWORD="$(env_value_from_file "$PREVIOUS_CURRENT_TARGET/.env" PROSTAR_VIEWER_PASSWORD)"
  if [[ "\${EXISTING_CONTROL_PLANE%/}" == "\${CONTROL_PLANE%/}" && \
        "$EXISTING_CLIENT_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ && \
        "$EXISTING_AGENT_SECRET" =~ ^[A-Za-z0-9_-]{32,256}$ ]]; then
    VERIFY_STATUS="$(/usr/bin/curl -q --max-time 15 -sS -o /dev/null -w '%{http_code}' \
      -X POST \
      -H "Authorization: Bearer $EXISTING_AGENT_SECRET" \
      -H 'Content-Type: application/json' \
      --data "{\\\"clientId\\\":\\\"$EXISTING_CLIENT_ID\\\"}" \
      "$CONTROL_PLANE/api/agent/verify" || true)"
    if [[ "$VERIFY_STATUS" == "204" ]]; then
      PROSTAR_CLIENT_ID="$EXISTING_CLIENT_ID"
      PROSTAR_AGENT_SECRET_VALUE="$EXISTING_AGENT_SECRET"
      REUSE_EXISTING_IDENTITY=1
      if [[ "$EXISTING_VIEWER_PASSWORD" =~ ^[A-Za-z0-9_-]{12,128}$ ]]; then
        VIEWER_PASSWORD_VALUE="$EXISTING_VIEWER_PASSWORD"
      fi
      echo "Reusing this Mac's existing Prostar identity."
    elif [[ "$VERIFY_STATUS" != "401" ]]; then
      echo "ERROR: Could not verify this Mac's saved Prostar identity (HTTP \${VERIFY_STATUS:-unreachable})."
      exit 1
    fi
  fi
fi

if [[ "$REUSE_EXISTING_IDENTITY" != "1" ]]; then
  PROSTAR_AGENT_SECRET_VALUE="$(/usr/bin/uuidgen | /usr/bin/tr -d '-')$(/usr/bin/uuidgen | /usr/bin/tr -d '-')"
  CREDENTIAL_HASH="$(printf '%s' "$PROSTAR_AGENT_SECRET_VALUE" | /usr/bin/shasum -a 256 | /usr/bin/awk '{print $1}')"
  ENROLL_STATUS=""
  for _ in 1 2 3 4 5; do
    ENROLL_STATUS="$(/usr/bin/curl -q --max-time 15 -sS -o /dev/null -w '%{http_code}' \
      -X POST \
      -H 'Content-Type: application/json' \
      --data "{\\\"token\\\":\\\"$INSTALL_TOKEN_VALUE\\\",\\\"credentialHash\\\":\\\"$CREDENTIAL_HASH\\\"}" \
      "$CONTROL_PLANE/api/agent/enroll" || true)"
    [[ "$ENROLL_STATUS" == "204" || "$ENROLL_STATUS" == "409" ]] && break
    sleep 1
  done
  if [[ "$ENROLL_STATUS" != "204" ]]; then
    echo "ERROR: Could not enroll this Mac with Prostar (HTTP \${ENROLL_STATUS:-unreachable})."
    exit 1
  fi
  {
    printf 'CONTROL_PLANE_URL=%s\n' "$CONTROL_PLANE"
    printf 'PROSTAR_CLIENT_ID=%s\n' "$PROSTAR_CLIENT_ID"
    printf 'PROSTAR_AGENT_SECRET=%s\n' "$PROSTAR_AGENT_SECRET_VALUE"
  } > "$PENDING_IDENTITY_PATH"
  chmod 600 "$PENDING_IDENTITY_PATH"
  ENROLLED_NEW_IDENTITY=1
fi

echo "Downloading agent from dashboard…"
STAGING="$(mktemp -d -t prostar.XXXXXX)"
mkdir -p "$STAGING/extracted"
/usr/bin/curl -q --proto "$DASHBOARD_PROTOCOL" --tlsv1.2 --retry 3 --retry-all-errors -fsSL "$BUNDLE_URL" -o "$STAGING/prostar-agent.tgz"
/usr/bin/curl -q --proto "$DASHBOARD_PROTOCOL" --tlsv1.2 --retry 3 --retry-all-errors -fsSL "$BUNDLE_URL.sha256" -o "$STAGING/prostar-agent.tgz.sha256"
(cd "$STAGING" && /usr/bin/shasum -a 256 -c prostar-agent.tgz.sha256)
tar -xzf "$STAGING/prostar-agent.tgz" -C "$STAGING/extracted"
if [[ ! -f "$STAGING/extracted/package.json" || ! -f "$STAGING/extracted/src/server.ts" || ! -f "$STAGING/extracted/scripts/install-agent.sh" ]]; then
  echo "ERROR: Downloaded package is incomplete."
  exit 1
fi
/usr/bin/ditto "$STAGING/extracted" "$REPO_PATH"
rm -rf "$STAGING"
STAGING=""

if [[ ! -x "$REPO_PATH/scripts/ensure-runtime.sh" ]]; then
  echo "ERROR: Downloaded package has no Prostar runtime installer."
  exit 1
fi
echo "Installing private Prostar runtime…"
PROSTAR_APP_ROOT="$APP_ROOT" /bin/bash "$REPO_PATH/scripts/ensure-runtime.sh" --with-cloudflared
export PATH="$APP_ROOT/runtime/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export npm_config_cache="$APP_ROOT/runtime/npm-cache"
export npm_config_update_notifier=false
mkdir -p "$npm_config_cache"

cd "$REPO_PATH"

{
  printf 'PROSTAR_VIEWER_PASSWORD=%s\n' "$VIEWER_PASSWORD_VALUE"
  printf 'CONTROL_PLANE_URL=%s\n' "$CONTROL_PLANE"
  printf 'PROSTAR_CLIENT_ID=%s\n' "$PROSTAR_CLIENT_ID"
  printf 'PROSTAR_AGENT_SECRET=%s\n' "$PROSTAR_AGENT_SECRET_VALUE"
  printf 'PROSTAR_CLOUDFLARED_BIN=%s\n' "$APP_ROOT/runtime/bin/cloudflared"
  printf '%s\n' 'PORT=8787' 'FPS=8' 'JPEG_QUALITY=60' 'SCALE=0.5' 'MAX_WIDTH=1920'
} > .env
chmod 600 .env

echo "Installing npm dependencies…"
npm ci --foreground-scripts --no-audit --no-fund

echo "Installing background agent (keeps running after Terminal quits)…"
npm run install-agent
KEEP_RELEASE=1

echo ""
echo "Waiting for local agent…"
LOCAL_OK=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  if /usr/bin/curl -qfsS "http://127.0.0.1:8787/api/health" >/dev/null 2>&1; then
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

echo "Waiting for dashboard pairing…"
PAIRING_OK=0
for _ in {1..100}; do
  if /usr/bin/curl -q --max-time 5 -fsS -o /dev/null \
    -H "Authorization: Bearer $PROSTAR_AGENT_SECRET_VALUE" \
    "http://127.0.0.1:8787/api/control-plane/health"; then
    PAIRING_OK=1
    break
  fi
  sleep 1
done
if [[ "$PAIRING_OK" != "1" ]]; then
  echo "ERROR: Agent could not acquire its dashboard session."
  exit 1
fi
echo "Dashboard pairing is ready."

permission_ready() {
  /usr/bin/curl -q --max-time 15 -fsS -o /dev/null \
    -X POST \
    -H "Authorization: Bearer $PROSTAR_AGENT_SECRET_VALUE" \
    "http://127.0.0.1:8787/api/capture/preflight"
}

echo "Checking Screen Recording permission…"
PERMISSION_OK=0
if permission_ready; then
  PERMISSION_OK=1
else
  echo "Allow Screen Recording for Prostar's displayed capture helper."
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

if [[ "$ENROLLED_NEW_IDENTITY" == "1" ]]; then
  ACTIVATE_STATUS=""
  for _ in 1 2 3 4 5; do
    ACTIVATE_STATUS="$(/usr/bin/curl -q --max-time 15 -sS -o /dev/null -w '%{http_code}' \
      -X POST \
      -H "Authorization: Bearer $PROSTAR_AGENT_SECRET_VALUE" \
      -H 'Content-Type: application/json' \
      --data "{\\\"clientId\\\":\\\"$PROSTAR_CLIENT_ID\\\"}" \
      "$CONTROL_PLANE/api/agent/activate" || true)"
    [[ "$ACTIVATE_STATUS" == "204" || "$ACTIVATE_STATUS" == "409" ]] && break
    sleep 1
  done
  if [[ "$ACTIVATE_STATUS" != "204" ]]; then
    echo "ERROR: Could not finish pairing this Mac (HTTP \${ACTIVATE_STATUS:-unreachable})."
    exit 1
  fi
fi
NEXT_LINK="$APP_ROOT/.current.$$"
ln -s "$REPO_PATH" "$NEXT_LINK"
mv -hf "$NEXT_LINK" "$CURRENT_PATH"
CURRENT_SWAPPED=1
bash "$REPO_PATH/scripts/install-agent.sh" --finalize-install
rm -f "$PENDING_IDENTITY_PATH"
INSTALL_SUCCEEDED=1
unset PROSTAR_AGENT_SECRET_VALUE VIEWER_PASSWORD_VALUE INSTALL_TOKEN_VALUE
`;
}

export function resolveInstallConfig(
  req: Request,
  enrollment: {
    clientId: string;
    installToken: string;
  },
) {
  const reqUrl = new URL(req.url);
  const controlPlane =
    sanitizeUrl(process.env.NEXT_PUBLIC_APP_URL ?? null) ||
    sanitizeUrl(reqUrl.origin) ||
    "http://127.0.0.1:3000";

  return { controlPlane, ...enrollment };
}
