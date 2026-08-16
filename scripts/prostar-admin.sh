#!/usr/bin/env bash
set -euo pipefail

LABEL="prostar.agent"
DOMAIN="gui/$(id -u)"
SERVICE="$DOMAIN/$LABEL"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
APP_ROOT="$HOME/Library/Application Support/Prostar"
LOG_DIR="$HOME/Library/Logs/Prostar"

resolve_script() {
  local source="${BASH_SOURCE[0]}"
  local directory target
  while [[ -L "$source" ]]; do
    directory="$(cd -P "$(dirname "$source")" && pwd)"
    target="$(readlink "$source")"
    if [[ "$target" == /* ]]; then
      source="$target"
    else
      source="$directory/$target"
    fi
  done
  cd -P "$(dirname "$source")" && pwd
}

SCRIPT_DIR="$(resolve_script)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$ROOT/.env"

usage() {
  cat <<'EOF'
Prostar administration

Usage: prostar-admin <command>

Commands:
  status       Show service, health, pairing, and local URL
  start        Enable and start the background service
  stop         Stop and disable the background service
  restart      Restart the background service
  logs [-f]    Show recent logs; -f keeps following them
  preflight    Test Screen Recording permission through the agent
  open         Open the local viewer in the default browser
  password     Print the local viewer password
  uninstall    Remove the background service (keeps data and logs)
  help         Show this help

The fallback command is:
  "$HOME/Library/Application Support/Prostar/prostar-admin"
EOF
}

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

env_value() {
  local key="$1"
  local line value
  [[ -f "$ENV_FILE" ]] || return 0
  line="$(/usr/bin/grep -m 1 "^${key}=" "$ENV_FILE" 2>/dev/null || true)"
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

port_value() {
  local port
  port="$(env_value PORT)"
  port="${port:-8787}"
  [[ "$port" =~ ^[0-9]+$ ]] || die "PORT in $ENV_FILE is invalid."
  ((port >= 1 && port <= 65535)) || die "PORT in $ENV_FILE is out of range."
  printf '%s' "$port"
}

is_loaded() {
  launchctl print "$SERVICE" >/dev/null 2>&1
}

is_healthy() {
  curl --max-time 2 -fsS "http://127.0.0.1:$(port_value)/api/health" >/dev/null 2>&1
}

wait_for_health() {
  local attempt
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    if is_healthy; then
      return 0
    fi
    sleep 1
  done
  return 1
}

print_log_tail() {
  local lines="${PROSTAR_LOG_LINES:-80}"
  [[ "$lines" =~ ^[0-9]+$ ]] || die "PROSTAR_LOG_LINES must be a number."
  if [[ ! -e "$LOG_DIR/prostar.out.log" && ! -e "$LOG_DIR/prostar.err.log" ]]; then
    printf 'No Prostar logs exist yet in %s.\n' "$LOG_DIR"
    return 0
  fi
  tail -n "$lines" "$LOG_DIR/prostar.out.log" "$LOG_DIR/prostar.err.log" 2>/dev/null || true
}

start_service() {
  [[ -f "$PLIST" ]] || die "Prostar is not installed. Run the production installer first."
  launchctl enable "$SERVICE" 2>/dev/null || true
  if is_loaded; then
    launchctl kickstart -k "$SERVICE"
  else
    launchctl bootstrap "$DOMAIN" "$PLIST"
    launchctl kickstart -k "$SERVICE" 2>/dev/null || true
  fi
  if ! wait_for_health; then
    printf 'Prostar did not become healthy. Recent logs:\n' >&2
    print_log_tail >&2
    return 1
  fi
  printf 'Prostar is running at http://127.0.0.1:%s.\n' "$(port_value)"
}

status_service() {
  local port pid control_plane client_id
  port="$(port_value)"
  printf 'Release: %s\n' "$ROOT"
  if is_loaded; then
    pid="$(launchctl print "$SERVICE" 2>/dev/null | /usr/bin/awk '/pid =/ { print $3; exit }')"
    if [[ -n "$pid" ]]; then
      printf 'Service: running (PID %s)\n' "$pid"
    else
      printf 'Service: loaded\n'
    fi
  else
    printf 'Service: stopped\n'
  fi
  if is_healthy; then
    printf 'Health: healthy\n'
  else
    printf 'Health: unavailable\n'
  fi
  printf 'Local URL: http://127.0.0.1:%s\n' "$port"
  control_plane="$(env_value CONTROL_PLANE_URL)"
  client_id="$(env_value PROSTAR_CLIENT_ID)"
  if [[ -n "$control_plane" && -n "$client_id" ]]; then
    printf 'Dashboard: paired (%s)\n' "$control_plane"
    printf 'Session: %s\n' "$client_id"
    printf 'Cloudflare: dashboard-controlled\n'
  else
    printf 'Dashboard: not paired\n'
    printf 'Cloudflare: disabled\n'
  fi
  printf 'Logs: %s\n' "$LOG_DIR"
}

stop_service() {
  launchctl disable "$SERVICE" 2>/dev/null || true
  launchctl bootout "$SERVICE" 2>/dev/null || true
  printf 'Prostar is stopped and disabled.\n'
}

restart_service() {
  [[ -f "$PLIST" ]] || die "Prostar is not installed. Run the production installer first."
  launchctl enable "$SERVICE" 2>/dev/null || true
  if is_loaded; then
    launchctl kickstart -k "$SERVICE"
  else
    launchctl bootstrap "$DOMAIN" "$PLIST"
  fi
  if ! wait_for_health; then
    printf 'Prostar did not become healthy after restart. Recent logs:\n' >&2
    print_log_tail >&2
    return 1
  fi
  printf 'Prostar restarted successfully.\n'
}

show_logs() {
  case "${1:-}" in
    "") print_log_tail ;;
    -f|--follow)
      mkdir -p "$LOG_DIR"
      touch "$LOG_DIR/prostar.out.log" "$LOG_DIR/prostar.err.log"
      tail -n "${PROSTAR_LOG_LINES:-80}" -F "$LOG_DIR/prostar.out.log" "$LOG_DIR/prostar.err.log"
      ;;
    *) die "Unknown logs option: $1" ;;
  esac
}

capture_preflight() {
  local secret response_file status
  secret="$(env_value PROSTAR_AGENT_SECRET)"
  if [[ -z "$secret" ]]; then
    secret="$(env_value AGENT_TOKEN)"
  fi
  [[ -n "$secret" ]] || die "This release has no local agent credential."
  is_healthy || die "Prostar is not running. Run 'prostar-admin start' first."
  response_file="$(mktemp -t prostar-preflight.XXXXXX)"
  status="$(curl --max-time 20 -sS -o "$response_file" -w '%{http_code}' \
    -X POST \
    -H "Authorization: Bearer $secret" \
    "http://127.0.0.1:$(port_value)/api/capture/preflight" || true)"
  if [[ "$status" == "204" ]]; then
    rm -f "$response_file"
    printf 'Screen Recording is ready.\n'
    return 0
  fi
  printf 'Screen Recording preflight failed (HTTP %s).\n' "${status:-unreachable}" >&2
  if [[ -s "$response_file" ]]; then
    /bin/cat "$response_file" >&2
    printf '\n' >&2
  fi
  rm -f "$response_file"
  printf 'Open System Settings → Privacy & Security → Screen & System Audio Recording, allow Prostar, then retry.\n' >&2
  return 1
}

open_viewer() {
  is_healthy || die "Prostar is not running. Run 'prostar-admin start' first."
  open "http://127.0.0.1:$(port_value)/"
  printf 'Opened the local Prostar viewer.\n'
}

show_password() {
  local password
  password="$(env_value PROSTAR_VIEWER_PASSWORD)"
  if [[ -z "$password" ]]; then
    password="$(env_value VIEWER_PASSWORD)"
  fi
  [[ -n "$password" ]] || die "No viewer password exists in $ENV_FILE."
  printf '%s\n' "$password"
}

uninstall_service() {
  [[ -f "$ROOT/scripts/uninstall-agent.sh" ]] || die "Uninstaller is missing from $ROOT."
  PROSTAR_ADMIN_VERBOSE=1 bash "$ROOT/scripts/uninstall-agent.sh"
  printf 'Application data and logs were retained in %s and %s.\n' "$APP_ROOT" "$LOG_DIR"
}

command="${1:-help}"
case "$command" in
  help|-h|--help) usage ;;
  status) status_service ;;
  start) start_service ;;
  stop) stop_service ;;
  restart) restart_service ;;
  logs) shift; show_logs "${1:-}" ;;
  preflight) capture_preflight ;;
  open) open_viewer ;;
  password) show_password ;;
  uninstall) uninstall_service ;;
  *)
    printf 'Unknown command: %s\n\n' "$command" >&2
    usage >&2
    exit 2
    ;;
esac
