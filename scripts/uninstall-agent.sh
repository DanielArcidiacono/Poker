#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="prostar.agent"
LEGACY_LABEL="com.local.screenviewer"
DOMAIN="gui/$(/usr/bin/id -u)"
SERVICE="$DOMAIN/$LABEL"
LEGACY_SERVICE="$DOMAIN/$LEGACY_LABEL"
PLIST_DST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LEGACY_PLIST="$HOME/Library/LaunchAgents/${LEGACY_LABEL}.plist"
APP_ROOT="$HOME/Library/Application Support/Prostar"
CURRENT_PATH="$APP_ROOT/current"
PENDING_IDENTITY_PATH="$APP_ROOT/.pending-enrollment"
LOG_DIR="$HOME/Library/Logs/Prostar"
LEGACY_LOG_DIR="$HOME/Library/Logs/screenviewer"
LEGACY_OUT_LOG="$LEGACY_LOG_DIR/screenviewer.out.log"
LEGACY_ERR_LOG="$LEGACY_LOG_DIR/screenviewer.err.log"
PURGE=0

case "${1:-}" in
  "") ;;
  --purge|--full) PURGE=1 ;;
  *)
    echo "Usage: uninstall-agent.sh [--purge]" >&2
    exit 2
    ;;
esac

remove_admin_links() {
  local link target
  for link in "$HOME/.local/bin/prostar-admin" "$APP_ROOT/prostar-admin"; do
    if [[ -L "$link" ]]; then
      target="$(readlink "$link")"
      if [[ "$target" == "$ROOT/scripts/prostar-admin.sh" || \
            "$target" == "$APP_ROOT/current/scripts/prostar-admin.sh" || \
            "$target" == "$APP_ROOT"/releases/*/scripts/prostar-admin.sh ]]; then
        rm -f "$link"
      fi
    fi
  done
}

stop_jobs_best_effort() {
  # Keep the historical, service-only uninstall behavior intentionally lenient.
  launchctl bootout "$SERVICE" 2>/dev/null || true
  launchctl bootout "$LEGACY_SERVICE" 2>/dev/null || true
  launchctl unload "$PLIST_DST" 2>/dev/null || true
  launchctl unload "$LEGACY_PLIST" 2>/dev/null || true
}

if [[ "$PURGE" != "1" ]]; then
  stop_jobs_best_effort
  rm -f "$PLIST_DST" "$LEGACY_PLIST"
  remove_admin_links
  echo "Removed Prostar background agent"
  exit 0
fi

validate_purge_paths() {
  [[ -n "$HOME" && "$HOME" == /* && "$HOME" != "/" ]] || {
    echo "Refusing to purge with an invalid home directory." >&2
    return 1
  }
  [[ "$APP_ROOT" == "$HOME/Library/Application Support/Prostar" ]] || {
    echo "Refusing to purge an unexpected application path." >&2
    return 1
  }
  [[ "$PENDING_IDENTITY_PATH" == "$APP_ROOT/.pending-enrollment" && \
     ! -L "$PENDING_IDENTITY_PATH" ]] || {
    echo "Refusing to purge an unsafe pending-enrollment path." >&2
    return 1
  }
  [[ "$LOG_DIR" == "$HOME/Library/Logs/Prostar" ]] || {
    echo "Refusing to purge an unexpected log path." >&2
    return 1
  }
  [[ "$LEGACY_LOG_DIR" == "$HOME/Library/Logs/screenviewer" && \
     "$LEGACY_OUT_LOG" == "$HOME/Library/Logs/screenviewer/screenviewer.out.log" && \
     "$LEGACY_ERR_LOG" == "$HOME/Library/Logs/screenviewer/screenviewer.err.log" ]] || {
    echo "Refusing to purge unexpected legacy application paths." >&2
    return 1
  }
  [[ "$PLIST_DST" == "$HOME/Library/LaunchAgents/prostar.agent.plist" && \
     "$LEGACY_PLIST" == "$HOME/Library/LaunchAgents/com.local.screenviewer.plist" ]] || {
    echo "Refusing to purge unexpected LaunchAgent paths." >&2
    return 1
  }
}

env_value_from_file() {
  local file="$1"
  local key="$2"
  local line value
  [[ -f "$file" ]] || return 0
  line="$(/usr/bin/grep -m 1 "^${key}=" "$file" 2>/dev/null || true)"
  [[ -n "$line" ]] || return 0
  value="${line#*=}"
  value="${value%$'\r'}"
  if [[ ${#value} -ge 2 ]]; then
    if [[ "${value:0:1}" == '"' && "${value: -1}" == '"' ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "${value:0:1}" == "'" && "${value: -1}" == "'" ]]; then
      value="${value:1:${#value}-2}"
    fi
  fi
  printf '%s' "$value"
}

current_env_file() {
  local target
  if [[ -f "$ROOT/.env" ]]; then
    printf '%s' "$ROOT/.env"
    return 0
  fi
  [[ -L "$CURRENT_PATH" ]] || return 0
  target="$(readlink "$CURRENT_PATH")"
  [[ "$target" == "$APP_ROOT"/releases/* && -f "$target/.env" ]] || return 0
  printf '%s' "$target/.env"
}

config_value() {
  local key="$1"
  local env_file value
  if [[ -f "$PLIST_DST" ]]; then
    value="$(/usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:${key}" "$PLIST_DST" 2>/dev/null || true)"
    if [[ -n "$value" ]]; then
      printf '%s' "$value"
      return 0
    fi
  fi
  env_file="$(current_env_file)"
  [[ -n "$env_file" ]] || return 0
  env_value_from_file "$env_file" "$key"
}

# Record both the PID and its immutable-enough process identity before stopping
# launchd. A reused PID will not be signaled if its start time or command differs.
CAPTURED_PIDS=()
CAPTURED_IDENTITIES=()
CAPTURED_COUNT=0

capture_pid() {
  local pid="$1"
  local identity owner index
  [[ "$pid" =~ ^[0-9]+$ && "$pid" -gt 1 && "$pid" != "$$" ]] || return 1
  for ((index = 0; index < CAPTURED_COUNT; index++)); do
    [[ "${CAPTURED_PIDS[$index]}" != "$pid" ]] || return 1
  done
  owner="$(/bin/ps -p "$pid" -o uid= 2>/dev/null | /usr/bin/tr -d ' ' || true)"
  [[ "$owner" == "$(/usr/bin/id -u)" ]] || return 1
  identity="$(/bin/ps -p "$pid" -o lstart= -o command= 2>/dev/null || true)"
  [[ -n "$identity" ]] || return 1
  index="$CAPTURED_COUNT"
  CAPTURED_PIDS[$index]="$pid"
  CAPTURED_IDENTITIES[$index]="$identity"
  CAPTURED_COUNT=$((CAPTURED_COUNT + 1))
}

capture_process_tree() {
  local pid="$1"
  local child children
  capture_pid "$pid" || return 0
  children="$(/usr/bin/pgrep -P "$pid" 2>/dev/null || true)"
  for child in $children; do
    capture_process_tree "$child"
  done
}

capture_job_tree() {
  local service="$1"
  local pid
  pid="$(launchctl print "$service" 2>/dev/null | /usr/bin/awk '/pid =/ { print $3; exit }' || true)"
  [[ -n "$pid" ]] && capture_process_tree "$pid"
  return 0
}

captured_process_alive() {
  local index="$1"
  local current
  current="$(/bin/ps -p "${CAPTURED_PIDS[$index]}" -o lstart= -o command= 2>/dev/null || true)"
  [[ -n "$current" && "$current" == "${CAPTURED_IDENTITIES[$index]}" ]]
}

all_captured_processes_gone() {
  local index
  for ((index = 0; index < CAPTURED_COUNT; index++)); do
    if captured_process_alive "$index"; then
      return 1
    fi
  done
  return 0
}

wait_for_captured_processes() {
  local attempt
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    all_captured_processes_gone && return 0
    /bin/sleep 0.25
  done
  return 1
}

signal_captured_processes() {
  local signal="$1"
  local index
  for ((index = 0; index < CAPTURED_COUNT; index++)); do
    if captured_process_alive "$index"; then
      /bin/kill "-$signal" "${CAPTURED_PIDS[$index]}" 2>/dev/null || true
    fi
  done
}

jobs_are_gone() {
  ! launchctl print "$SERVICE" >/dev/null 2>&1 &&
    ! launchctl print "$LEGACY_SERVICE" >/dev/null 2>&1
}

wait_for_jobs() {
  local attempt
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    jobs_are_gone && return 0
    /bin/sleep 0.25
  done
  return 1
}

stop_jobs_strictly() {
  capture_job_tree "$SERVICE"
  capture_job_tree "$LEGACY_SERVICE"

  # Disable first so KeepAlive cannot create a new process while bootout runs.
  launchctl disable "$SERVICE" 2>/dev/null || true
  launchctl disable "$LEGACY_SERVICE" 2>/dev/null || true
  launchctl bootout "$SERVICE" 2>/dev/null || true
  launchctl bootout "$LEGACY_SERVICE" 2>/dev/null || true
  launchctl unload "$PLIST_DST" 2>/dev/null || true
  launchctl unload "$LEGACY_PLIST" 2>/dev/null || true
  wait_for_jobs || true

  if ! wait_for_captured_processes; then
    signal_captured_processes TERM
    wait_for_captured_processes || true
  fi
  if ! all_captured_processes_gone; then
    signal_captured_processes KILL
    wait_for_captured_processes || true
  fi

  # A disabled job can still be loaded without a running process. Remove it one
  # final time, then require both launchd and every captured process to be gone.
  launchctl bootout "$SERVICE" 2>/dev/null || true
  launchctl bootout "$LEGACY_SERVICE" 2>/dev/null || true
  wait_for_jobs || true
  if ! jobs_are_gone || ! all_captured_processes_gone; then
    echo "Prostar could not be stopped completely; no application data was deleted." >&2
    return 1
  fi
}

deenroll_dashboard_session() {
  local control_plane="$1"
  local client_id="$2"
  local agent_secret="$3"
  local status

  if [[ -z "$control_plane" && -z "$client_id" ]]; then
    return 0
  fi
  if [[ -z "$control_plane" || -z "$client_id" || -z "$agent_secret" ]]; then
    echo "Prostar's dashboard credentials are incomplete; no application data was deleted." >&2
    return 1
  fi
  control_plane="${control_plane%/}"
  [[ "$client_id" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]] || {
    echo "Prostar's dashboard client ID is invalid; no application data was deleted." >&2
    return 1
  }
  [[ "$agent_secret" =~ ^[A-Za-z0-9_-]{32,256}$ ]] || {
    echo "Prostar's dashboard credential is invalid; no application data was deleted." >&2
    return 1
  }

  if [[ "$control_plane" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]]; then
    status="$(/usr/bin/curl -q --proto '=https' --tlsv1.2 --connect-timeout 5 --max-time 20 \
      -sS -o /dev/null -w '%{http_code}' \
      -X DELETE \
      -H "Authorization: Bearer $agent_secret" \
      -H 'Content-Type: application/json' \
      --data "{\"clientId\":\"$client_id\"}" \
      "$control_plane/api/agent/deenroll" || true)"
  elif [[ "$control_plane" =~ ^http://(127\.0\.0\.1|localhost)(:[0-9]{1,5})?$ ]]; then
    status="$(/usr/bin/curl -q --proto '=http' --connect-timeout 5 --max-time 20 \
      -sS -o /dev/null -w '%{http_code}' \
      -X DELETE \
      -H "Authorization: Bearer $agent_secret" \
      -H 'Content-Type: application/json' \
      --data "{\"clientId\":\"$client_id\"}" \
      "$control_plane/api/agent/deenroll" || true)"
  else
    echo "Prostar's dashboard URL is invalid; no application data was deleted." >&2
    return 1
  fi

  if [[ "$status" != "204" ]]; then
    echo "The dashboard session could not be revoked (HTTP ${status:-unreachable}); no application data was deleted." >&2
    return 1
  fi
}

validate_purge_paths
CONTROL_PLANE_URL="$(config_value CONTROL_PLANE_URL)"
PROSTAR_CLIENT_ID="$(config_value PROSTAR_CLIENT_ID)"
PROSTAR_AGENT_SECRET="$(config_value PROSTAR_AGENT_SECRET)"
PENDING_CONTROL_PLANE_URL="$(env_value_from_file "$PENDING_IDENTITY_PATH" CONTROL_PLANE_URL)"
PENDING_CLIENT_ID="$(env_value_from_file "$PENDING_IDENTITY_PATH" PROSTAR_CLIENT_ID)"
PENDING_AGENT_SECRET="$(env_value_from_file "$PENDING_IDENTITY_PATH" PROSTAR_AGENT_SECRET)"

stop_jobs_strictly
deenroll_dashboard_session "$CONTROL_PLANE_URL" "$PROSTAR_CLIENT_ID" "$PROSTAR_AGENT_SECRET"
deenroll_dashboard_session "$PENDING_CONTROL_PLANE_URL" "$PENDING_CLIENT_ID" "$PENDING_AGENT_SECRET"

# Credentials are gone remotely and no Prostar process can retain an open file.
# Delete only the exact, validated paths owned by this installation.
rm -f "$PLIST_DST" "$LEGACY_PLIST"
remove_admin_links
rm -rf "$APP_ROOT" "$LOG_DIR"
rm -f "$LEGACY_OUT_LOG" "$LEGACY_ERR_LOG"
/bin/rmdir "$LEGACY_LOG_DIR" 2>/dev/null || true
echo "Removed Prostar and all of its private data"
