#!/bin/sh
# Hands /reload-plugins to every Claude session, with optional --force to bypass version gating.
# Usage:   sh reload.sh [--idle] [--force]
#
#   sh reload.sh                  reload sessions behind the current cockpit version
#   sh reload.sh --idle           only the ones waiting at their prompt
#   sh reload.sh --force          reload EVERY session regardless of version
#
# The --force flag bypasses version gating, targeting ALL sessions regardless of
# their cockpit version.

root=$(cd "$(dirname "$0")" && pwd)
H="${HERDR_BIN_PATH:-herdr}"
HC="${HC_BIN_PATH:-$HOME/.local/bin/hc}"
app_home=${HERDR_APP_HOME:-$HOME/.config/herdr-app}

idle_only=false
force=false

for arg in "$@"; do
  case "$arg" in
    --idle) idle_only=true ;;
    --force) force=true ;;
  esac
done

want=$(jq -r .version "$(dirname "$root")/plugin/.claude-plugin/plugin.json" 2>/dev/null) || want=""
[ -z "$want" ] && want=$(sed -n 's/^version = "\(.*\)"$/\1/p' "$root/herdr-plugin.toml")

# Panes from active heartbeats
behind=""
all_heartbeat_panes=""
for beat in "$HOME/.cache/cockpit/sessions"/*.json; do
  [ -f "$beat" ] || continue
  p=$(jq -r '.pane // empty' "$beat" 2>/dev/null)
  [ -n "$p" ] || continue
  all_heartbeat_panes="$all_heartbeat_panes $p"
  v=$(jq -r '.version // empty' "$beat" 2>/dev/null)
  if [ "$v" != "$want" ]; then
    behind="$behind $p"
  fi
done

sent=0
targeted_panes=""

send_to_pane() {
  target_pane="$1"
  [ -n "$target_pane" ] || return
  # Avoid duplicate sends to the same pane in one run
  case " $targeted_panes " in
    *" $target_pane "*) return ;;
  esac
  targeted_panes="$targeted_panes $target_pane"

  if "$H" agent prompt "$target_pane" "/reload-plugins" >/dev/null 2>&1; then
    sent=$((sent + 1))
  fi
}

if command -v "$H" >/dev/null 2>&1; then
  # 1. Try finding panes from herdr pane list
  filter='.result.panes[]? | select(.agent == "claude" or .agent == null or .agent == "")'
  if [ "$idle_only" = true ]; then
    filter="$filter | select(.agent_status == \"idle\" or .agent_status == \"done\")"
  fi

  panes=$("$H" pane list 2>/dev/null | jq -r "$filter | .pane_id" 2>/dev/null)
  workspaces=$("$H" workspace list 2>/dev/null | jq -r '.result.workspaces[]?.workspace_id' 2>/dev/null)
  for ws in $workspaces; do
    ws_panes=$("$H" pane list --workspace "$ws" 2>/dev/null | jq -r "$filter | .pane_id" 2>/dev/null)
    panes="$panes $ws_panes"
  done

  # Also try agent list which lists across all workspaces
  agent_filter='.result.agents[]? | select(.agent == "claude" or .name == "claude")'
  if [ "$idle_only" = true ]; then
    agent_filter="$agent_filter | select(.status == \"idle\" or .status == \"done\")"
  fi
  agent_panes=$("$H" agent list 2>/dev/null | jq -r "$agent_filter | .pane_id" 2>/dev/null)
  panes="$panes $agent_panes"

  # For any panes found via herdr CLI:
  for pane in $panes; do
    [ -n "$pane" ] || continue
    if [ "$force" = true ]; then
      send_to_pane "$pane"
    else
      case " $behind " in
        *" $pane "*) send_to_pane "$pane" ;;
      esac
    fi
  done

  # Fallback to heartbeat panes when not filtering by --idle (heartbeats don't track idle/working status)
  if [ "$idle_only" = false ]; then
    candidates="$behind"
    if [ "$force" = true ]; then
      candidates="$all_heartbeat_panes"
    fi
    for pane in $candidates; do
      [ -n "$pane" ] || continue
      send_to_pane "$pane"
    done
  fi
fi

if command -v herdr-app >/dev/null 2>&1 && [ -S "$app_home/herdr-app.sock" ]; then
  if [ "$idle_only" = true ]; then
    term_filter='.spaces[].tabs[].terminals[] | select(.status == "idle" or .status == "done") | .terminal'
  else
    term_filter='.spaces[].tabs[].terminals[].terminal'
  fi
  terminals=$(herdr-app ls 2>/dev/null | jq -r "$term_filter" 2>/dev/null)
  for terminal in $terminals; do
    [ -n "$terminal" ] || continue
    case "$("$HC" get "$terminal" --json 2>/dev/null | jq -r '.foreground.name // ""')" in
      *claude*) env -u HC_TERMINAL_ID "$HC" send "$terminal" "/reload-plugins" >/dev/null 2>&1 && sent=$((sent + 1)) ;;
    esac
  done
fi

echo "cockpit: /reload-plugins sent to $sent session(s)"
