#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="prostar.agent"
LEGACY_LABEL="com.local.screenviewer"
PLIST_SRC="$ROOT/launchd/prostar.agent.plist"
PLIST_DST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LEGACY_PLIST="$HOME/Library/LaunchAgents/${LEGACY_LABEL}.plist"
LOG_DIR="$HOME/Library/Logs/Prostar"
INSTALL_MARKER="$ROOT/.prostar-install-pending"
PREVIOUS_PLIST="$ROOT/.prostar-previous-agent.plist"
DOMAIN="gui/$(id -u)"
APP_ROOT="$HOME/Library/Application Support/Prostar"
ADMIN_BIN_DIR="$HOME/.local/bin"
ADMIN_LINK="$ADMIN_BIN_DIR/prostar-admin"
ADMIN_FALLBACK_LINK="$APP_ROOT/prostar-admin"
ADMIN_LINK_STATE="$ROOT/.prostar-previous-admin-links"
VERBOSE="${PROSTAR_ADMIN_VERBOSE:-0}"

say() {
  if [[ "$VERBOSE" == "1" ]]; then
    printf '%s\n' "$*"
  fi
}

admin_target() {
  if [[ "$ROOT" == "$APP_ROOT/releases/"* ]]; then
    printf '%s\n' "$APP_ROOT/current/scripts/prostar-admin.sh"
  else
    printf '%s\n' "$ROOT/scripts/prostar-admin.sh"
  fi
}

remove_admin_link_if_owned() {
  local link="$1"
  local expected="$2"
  if [[ -L "$link" && "$(readlink "$link")" == "$expected" ]]; then
    rm -f "$link"
  fi
}

is_known_admin_target() {
  local target="$1"
  local desired="$2"
  [[ "$target" == "$desired" || \
    "$target" == "$APP_ROOT/current/scripts/prostar-admin.sh" || \
    "$target" == "$APP_ROOT"/releases/*/scripts/prostar-admin.sh ]]
}

restore_admin_links() {
  local link previous desired current
  [[ -f "$ADMIN_LINK_STATE" ]] || return 0
  desired="$(admin_target)"
  while IFS=$'\t' read -r link previous; do
    [[ -n "$link" ]] || continue
    if [[ "$previous" == "absent" ]]; then
      remove_admin_link_if_owned "$link" "$desired"
    else
      current="$(readlink "$link" 2>/dev/null || true)"
      if [[ -z "$current" ]]; then
        mkdir -p "$(dirname "$link")"
        ln -sfn "$previous" "$link"
      elif is_known_admin_target "$current" "$desired"; then
        mkdir -p "$(dirname "$link")"
        ln -sfn "$previous" "$link"
      fi
    fi
  done < "$ADMIN_LINK_STATE"
  rm -f "$ADMIN_LINK_STATE"
}

install_admin_command() {
  local target existing link
  target="$(admin_target)"
  for link in "$ADMIN_LINK" "$ADMIN_FALLBACK_LINK"; do
    if [[ -e "$link" && ! -L "$link" ]]; then
      echo "Cannot install prostar-admin because $link already exists." >&2
      return 1
    fi
    if [[ -L "$link" ]]; then
      existing="$(readlink "$link")"
      if ! is_known_admin_target "$existing" "$target"; then
        echo "Cannot install prostar-admin because $link points outside Prostar." >&2
        return 1
      fi
    fi
  done
  : > "$ADMIN_LINK_STATE"
  chmod 600 "$ADMIN_LINK_STATE"
  for link in "$ADMIN_LINK" "$ADMIN_FALLBACK_LINK"; do
    if [[ -L "$link" ]]; then
      printf '%s\t%s\n' "$link" "$(readlink "$link")" >> "$ADMIN_LINK_STATE"
    else
      printf '%s\tabsent\n' "$link" >> "$ADMIN_LINK_STATE"
    fi
  done
  mkdir -p "$ADMIN_BIN_DIR" "$APP_ROOT"
  ln -sfn "$target" "$ADMIN_LINK"
  ln -sfn "$target" "$ADMIN_FALLBACK_LINK"
}

case "${1:-install}" in
  --finalize-install|--finalize-migration)
    if [[ -f "$INSTALL_MARKER" ]]; then
      if [[ "$(<"$INSTALL_MARKER")" == "legacy" ]]; then
        rm -f "$LEGACY_PLIST"
      fi
      rm -f "$INSTALL_MARKER" "$PREVIOUS_PLIST" "$ADMIN_LINK_STATE"
      say "Completed the Prostar background-agent handoff."
    fi
    exit 0
    ;;
  --rollback-install|--rollback-migration)
    if [[ -f "$INSTALL_MARKER" ]]; then
      PREVIOUS_KIND="$(<"$INSTALL_MARKER")"
      launchctl bootout "$DOMAIN/${LABEL}" 2>/dev/null || true
      launchctl disable "$DOMAIN/${LABEL}" 2>/dev/null || true
      if [[ "$PREVIOUS_KIND" == prostar:* && -f "$PREVIOUS_PLIST" ]]; then
        cp "$PREVIOUS_PLIST" "$PLIST_DST"
        chmod 600 "$PLIST_DST"
        launchctl enable "$DOMAIN/${LABEL}" 2>/dev/null || true
        if [[ "$PREVIOUS_KIND" == "prostar:loaded" ]]; then
          launchctl bootstrap "$DOMAIN" "$PLIST_DST" 2>/dev/null || true
        fi
      else
        rm -f "$PLIST_DST"
      fi
      if [[ "$PREVIOUS_KIND" == "legacy" && -f "$LEGACY_PLIST" ]]; then
        launchctl enable "$DOMAIN/${LEGACY_LABEL}" 2>/dev/null || true
        launchctl bootstrap "$DOMAIN" "$LEGACY_PLIST" 2>/dev/null || true
      fi
      restore_admin_links
      rm -f "$INSTALL_MARKER" "$PREVIOUS_PLIST"
      say "Restored the previous background agent."
    fi
    exit 0
    ;;
  install)
    ;;
  *)
    echo "Unknown install-agent option: $1" >&2
    exit 2
    ;;
esac

if [[ ! -f "$ROOT/.env" ]]; then
  echo "Missing $ROOT/.env — copy .env.example and set PROSTAR_VIEWER_PASSWORD first." >&2
  exit 1
fi

if ! NODE_BIN="$(command -v node)"; then
  echo "node not found on PATH" >&2
  exit 1
fi
if ! "$NODE_BIN" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 20 || (major === 20 && minor >= 9) ? 0 : 1)'; then
  echo "Node.js 20.9 or later is required (found $("$NODE_BIN" -v))." >&2
  echo "Install the current LTS release from https://nodejs.org and try again." >&2
  exit 1
fi

# Compile once at install time. The background process runs plain JavaScript,
# not the heavier TypeScript development loader.
TSC_BIN="$ROOT/node_modules/.bin/tsc"
if [[ ! -x "$TSC_BIN" ]]; then
  say "Installing dependencies…"
  (cd "$ROOT" && npm ci --foreground-scripts --no-audit --no-fund)
fi
if [[ ! -x "$TSC_BIN" ]]; then
  echo "TypeScript compiler not found at $TSC_BIN after npm ci" >&2
  exit 1
fi
(cd "$ROOT" && npm run build --silent)
SERVER_ENTRY="$ROOT/dist/server.js"

mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"

BACKUP_DIR="$(mktemp -d -t prostar-install.XXXXXX)"
HANDOFF_ACTIVE=0
PROSTAR_PLIST_EXISTED=0
PROSTAR_WAS_LOADED=0
LEGACY_WAS_LOADED=0
if [[ -f "$PLIST_DST" ]]; then
  PROSTAR_PLIST_EXISTED=1
  cp "$PLIST_DST" "$BACKUP_DIR/prostar.agent.plist"
fi
if launchctl print "$DOMAIN/${LABEL}" >/dev/null 2>&1; then
  PROSTAR_WAS_LOADED=1
fi
if launchctl print "$DOMAIN/${LEGACY_LABEL}" >/dev/null 2>&1; then
  LEGACY_WAS_LOADED=1
fi

restore_previous_agent() {
  launchctl bootout "$DOMAIN/${LABEL}" 2>/dev/null || true
  launchctl disable "$DOMAIN/${LABEL}" 2>/dev/null || true
  if [[ "$PROSTAR_PLIST_EXISTED" == "1" ]]; then
    cp "$BACKUP_DIR/prostar.agent.plist" "$PLIST_DST"
    chmod 600 "$PLIST_DST"
    launchctl enable "$DOMAIN/${LABEL}" 2>/dev/null || true
    if [[ "$PROSTAR_WAS_LOADED" == "1" ]]; then
      launchctl bootstrap "$DOMAIN" "$PLIST_DST" 2>/dev/null || true
    fi
  else
    rm -f "$PLIST_DST"
  fi
  if [[ "$PROSTAR_WAS_LOADED" != "1" && "$LEGACY_WAS_LOADED" == "1" && -f "$LEGACY_PLIST" ]]; then
    launchctl enable "$DOMAIN/${LEGACY_LABEL}" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$LEGACY_PLIST" 2>/dev/null || true
  fi
  restore_admin_links
  rm -f "$INSTALL_MARKER" "$PREVIOUS_PLIST"
  HANDOFF_ACTIVE=0
}

cleanup_install() {
  local code="$1"
  trap - EXIT
  if [[ "$code" != "0" && "$HANDOFF_ACTIVE" == "1" ]]; then
    restore_previous_agent || true
  fi
  rm -rf "$BACKUP_DIR"
  exit "$code"
}
trap 'cleanup_install "$?"' EXIT

HANDOFF_ACTIVE=1
"$NODE_BIN" "$ROOT/scripts/render-launch-agent.mjs" \
  "$ROOT" \
  "$NODE_BIN" \
  "$SERVER_ENTRY" \
  "$PLIST_SRC" \
  "$PLIST_DST" \
  "$LOG_DIR"
PORT_VAL="$(/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:PORT' "$PLIST_DST")"

launchctl bootout "$DOMAIN/${LABEL}" 2>/dev/null || true
launchctl bootout "$DOMAIN/${LEGACY_LABEL}" 2>/dev/null || true
launchctl enable "$DOMAIN/${LABEL}" 2>/dev/null || true
if ! launchctl bootstrap "$DOMAIN" "$PLIST_DST"; then
  echo "Prostar failed to start; restoring the previous background agent." >&2
  restore_previous_agent
  exit 1
fi
launchctl kickstart -k "$DOMAIN/${LABEL}" 2>/dev/null || launchctl start "$LABEL"
say "Installed LaunchAgent: $PLIST_DST"
say "It will restart automatically after login and if the agent exits."

say "Waiting for local health…"
HEALTHY=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  if curl -fsS "http://127.0.0.1:${PORT_VAL}/api/health" >/dev/null 2>&1; then
    say "Local agent is responding on port ${PORT_VAL}"
    HEALTHY=1
    break
  fi
  sleep 1
done
if [[ "$HEALTHY" != "1" ]]; then
  echo "Prostar did not become healthy; restoring the previous agent." >&2
  restore_previous_agent
  exit 1
fi

if ! install_admin_command; then
  echo "Prostar started, but the prostar-admin command could not be installed; restoring the previous agent." >&2
  restore_previous_agent
  exit 1
fi

# Keep the previous job recoverable until the outer installer verifies an
# authenticated screen capture. A disabled legacy job cannot relaunch beside it.
if [[ "$PROSTAR_PLIST_EXISTED" == "1" ]]; then
  cp "$BACKUP_DIR/prostar.agent.plist" "$PREVIOUS_PLIST"
  chmod 600 "$PREVIOUS_PLIST"
  if [[ "$PROSTAR_WAS_LOADED" == "1" ]]; then
    printf '%s\n' 'prostar:loaded' > "$INSTALL_MARKER"
  else
    printf '%s\n' 'prostar:idle' > "$INSTALL_MARKER"
  fi
  chmod 600 "$INSTALL_MARKER"
elif [[ "$PROSTAR_WAS_LOADED" != "1" && "$LEGACY_WAS_LOADED" == "1" && -f "$LEGACY_PLIST" ]]; then
  printf '%s\n' 'legacy' > "$INSTALL_MARKER"
  chmod 600 "$INSTALL_MARKER"
  launchctl disable "$DOMAIN/${LEGACY_LABEL}" 2>/dev/null || true
else
  printf '%s\n' 'fresh' > "$INSTALL_MARKER"
  chmod 600 "$INSTALL_MARKER"
fi
HANDOFF_ACTIVE=0

say "Logs: $LOG_DIR/prostar.*.log"
say "Local URL: http://127.0.0.1:${PORT_VAL}"
say "Grant Screen Recording to Prostar's Node helper if prompted: $NODE_BIN"
say "System Settings → Privacy & Security → Screen Recording"
