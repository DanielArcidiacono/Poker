#!/usr/bin/env bash
set -euo pipefail
umask 077

# Public, local-only installer. Dashboard pairing uses its own expiring setup
# command, which supplies scoped credentials and enables remote sharing.
REPOSITORY="${PROSTAR_GITHUB_REPOSITORY:-DanielArcidiacono/Poker}"
REF="${PROSTAR_REF:-v1.2.1}"
APP_ROOT="$HOME/Library/Application Support/Prostar"
CURRENT_PATH="$APP_ROOT/current"
ADMIN_LINK="$HOME/.local/bin/prostar-admin"
ADMIN_FALLBACK_LINK="$APP_ROOT/prostar-admin"
LOG_DIR="$HOME/Library/Logs/Prostar"
LOG_FILE="$LOG_DIR/install.log"
RELEASE_PATH=""
STAGING=""
HANDOFF_STARTED=0
PROMOTED=0
CURRENT_SWAPPED=0
PREVIOUS_CURRENT_TARGET=""
INSTALL_SUCCEEDED=0

mkdir -p "$LOG_DIR" || {
  printf 'Prostar installation failed: cannot create %s.\n' "$LOG_DIR" >&2
  exit 1
}
exec 3>&1 4>&2
exec >>"$LOG_FILE" 2>&1

finish_install() {
  local code="$1"
  trap - INT TERM EXIT
  if [[ "$INSTALL_SUCCEEDED" != "1" && "$HANDOFF_STARTED" == "1" && "$PROMOTED" == "0" && -n "$RELEASE_PATH" ]]; then
    if [[ -f "$RELEASE_PATH/.prostar-install-pending" ]]; then
      PROSTAR_ADMIN_VERBOSE=0 bash "$RELEASE_PATH/scripts/install-agent.sh" --rollback-install || true
    fi
  fi
  if [[ "$CURRENT_SWAPPED" == "1" ]]; then
    if [[ -n "$PREVIOUS_CURRENT_TARGET" ]]; then
      rollback_link="$APP_ROOT/.current-rollback.$$"
      if ln -s "$PREVIOUS_CURRENT_TARGET" "$rollback_link"; then
        mv -hf "$rollback_link" "$CURRENT_PATH" || PROMOTED=1
      else
        PROMOTED=1
      fi
    else
      rm -f "$CURRENT_PATH" || true
    fi
  fi
  if [[ -n "$STAGING" && -d "$STAGING" ]]; then
    rm -rf "$STAGING" || true
  fi
  if [[ "$PROMOTED" == "0" && -n "$RELEASE_PATH" && -d "$RELEASE_PATH" ]]; then
    rm -rf "$RELEASE_PATH" || true
  fi
  exec 1>&3 2>&4
  if [[ "$INSTALL_SUCCEEDED" == "1" && "$code" == "0" ]]; then
    printf 'Prostar installed successfully.\n'
  else
    printf 'Prostar installation failed. See %s\n' "$LOG_FILE" >&2
  fi
  exit "$code"
}

trap 'finish_install "$?"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

die() {
  printf 'ERROR: %s\n' "$*" >&2
  return 1
}

[[ "$(uname -s)" == "Darwin" ]] || die "Prostar currently supports macOS only."
[[ "$REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "Invalid PROSTAR_GITHUB_REPOSITORY."
[[ "$REF" =~ ^[A-Za-z0-9._/-]+$ && "$REF" != *..* ]] || die "Invalid PROSTAR_REF."
if [[ -e "$CURRENT_PATH" && ! -L "$CURRENT_PATH" ]]; then
  die "$CURRENT_PATH exists and is not a Prostar release link."
fi
if [[ -L "$CURRENT_PATH" ]]; then
  PREVIOUS_CURRENT_TARGET="$(readlink "$CURRENT_PATH")"
fi
for link in "$ADMIN_LINK" "$ADMIN_FALLBACK_LINK"; do
  if [[ -e "$link" && ! -L "$link" ]]; then
    die "$link already exists and is not a Prostar-managed link."
  fi
done

mkdir -p "$APP_ROOT/releases"
STAGING="$(mktemp -d -t prostar-bootstrap.XXXXXX)"
ARCHIVE="$STAGING/prostar.tgz"
ARCHIVE_URL="https://codeload.github.com/$REPOSITORY/tar.gz/$REF"
/usr/bin/curl -q --proto '=https' --tlsv1.2 --retry 3 --retry-all-errors -fsSL "$ARCHIVE_URL" -o "$ARCHIVE"

RELEASE_PATH="$APP_ROOT/releases/$(date +%Y%m%d%H%M%S)-$$"
mkdir "$RELEASE_PATH"
tar -xzf "$ARCHIVE" --strip-components=1 -C "$RELEASE_PATH"
if [[ ! -f "$RELEASE_PATH/package-lock.json" || \
      ! -f "$RELEASE_PATH/src/server.ts" || \
      ! -f "$RELEASE_PATH/scripts/install-agent.sh" || \
      ! -f "$RELEASE_PATH/scripts/prostar-admin.sh" || \
      ! -x "$RELEASE_PATH/scripts/ensure-runtime.sh" ]]; then
  die "The downloaded Prostar archive is incomplete."
fi
rm -rf "$STAGING"
STAGING=""

PROSTAR_APP_ROOT="$APP_ROOT" /bin/bash "$RELEASE_PATH/scripts/ensure-runtime.sh" --node-only
export PATH="$APP_ROOT/runtime/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export npm_config_cache="$APP_ROOT/runtime/npm-cache"
export npm_config_update_notifier=false
mkdir -p "$npm_config_cache"

VIEWER_PASSWORD="${PROSTAR_VIEWER_PASSWORD:-}"
if [[ -z "$VIEWER_PASSWORD" ]]; then
  VIEWER_PASSWORD="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')"
fi
[[ "$VIEWER_PASSWORD" =~ ^[A-Za-z0-9_-]{12,128}$ ]] || die "PROSTAR_VIEWER_PASSWORD must be 12–128 URL-safe characters."
AGENT_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"

{
  printf 'PROSTAR_VIEWER_PASSWORD=%s\n' "$VIEWER_PASSWORD"
  printf 'PROSTAR_AGENT_SECRET=%s\n' "$AGENT_SECRET"
  printf '%s\n' \
    'PORT=8787' \
    'FPS=8' \
    'JPEG_QUALITY=60' \
    'SCALE=0.5' \
    'MAX_WIDTH=1920' \
    'AUTO_TUNNEL=0' \
    'CONTROL_PLANE_URL='
} > "$RELEASE_PATH/.env"
chmod 600 "$RELEASE_PATH/.env"

(cd "$RELEASE_PATH" && npm ci --foreground-scripts --no-audit --no-fund)
HANDOFF_STARTED=1
PROSTAR_ADMIN_VERBOSE=0 bash "$RELEASE_PATH/scripts/install-agent.sh"

permission_ready() {
  /usr/bin/curl -q --max-time 20 -fsS -o /dev/null \
    -X POST \
    -H "Authorization: Bearer $AGENT_SECRET" \
    "http://127.0.0.1:8787/api/capture/preflight"
}

if ! permission_ready; then
  open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture" >/dev/null 2>&1 ||
    open "x-apple.systempreferences:" >/dev/null 2>&1 || true
  PERMISSION_OK=0
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    sleep 3
    if permission_ready; then
      PERMISSION_OK=1
      break
    fi
  done
  [[ "$PERMISSION_OK" == "1" ]] || die "Screen Recording permission was not granted. Allow it in System Settings and run the installer again."
fi

NEXT_LINK="$APP_ROOT/.current.$$"
ln -s "$RELEASE_PATH" "$NEXT_LINK"
mv -hf "$NEXT_LINK" "$CURRENT_PATH"
CURRENT_SWAPPED=1
PROSTAR_ADMIN_VERBOSE=0 bash "$RELEASE_PATH/scripts/install-agent.sh" --finalize-install
PROMOTED=1
unset AGENT_SECRET VIEWER_PASSWORD
INSTALL_SUCCEEDED=1
