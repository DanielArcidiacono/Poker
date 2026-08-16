#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="prostar.agent"
LEGACY_LABEL="com.local.screenviewer"
PLIST_DST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LEGACY_PLIST="$HOME/Library/LaunchAgents/${LEGACY_LABEL}.plist"
APP_ROOT="$HOME/Library/Application Support/Prostar"

launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootout "gui/$(id -u)/${LEGACY_LABEL}" 2>/dev/null || true
launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl unload "$LEGACY_PLIST" 2>/dev/null || true
rm -f "$PLIST_DST" "$LEGACY_PLIST"

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

echo "Removed Prostar background agent"
