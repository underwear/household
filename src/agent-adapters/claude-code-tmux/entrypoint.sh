#!/bin/sh
# Pet main process: seed $HOME once (the home volume keeps it, so files claude rewrote are never reset),
# run claude in tmux, and live exactly as long as that session. Hooks and Household's MCP server come from
# root-owned files. Account connectors are opt-in; the default isolates all other MCP sources.
set -eu
trap 'exit 0' TERM
# A throwaway VM of Household's own: Claude Code's sign-in waiting in tmux (`signin`), or nothing but the VM kept up
# while Household runs its one command (`renew`). Never a bot: no seed, no session.
case "${HOUSEHOLD_UTILITY:-}" in
  signin)
    tmux new-session -d -s signin -x 600 -y 40 -e CLAUDE_CONFIG_DIR="$HOME/.household-signin" "claude auth login --claudeai"
    exec sleep infinity ;;
  renew) exec sleep infinity ;;
esac
cp -rn /opt/household/seed/. "$HOME/"
# An API key's placeholder, approved on every start (claude asks about a key once, by its last 20 characters),
# also in a home from before: a pet moved to an API key must not sit at "use this API key?".
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  tail=$(printf %s "$ANTHROPIC_API_KEY" | tail -c 20)
  [ -s "$HOME/.claude.json" ] || echo '{}' > "$HOME/.claude.json"
  jq --arg k "$tail" '.customApiKeyResponses.approved = (((.customApiKeyResponses.approved // []) + [$k]) | unique)
    | .customApiKeyResponses.rejected = ((.customApiKeyResponses.rejected // []) - [$k])' "$HOME/.claude.json" > "$HOME/.claude.json.tmp"
  mv "$HOME/.claude.json.tmp" "$HOME/.claude.json"
fi
workspace="${HOUSEHOLD_WORKSPACE:-$HOME/work}"
if [ -z "${HOUSEHOLD_WORKSPACE:-}" ]; then mkdir -p "$workspace"; fi
[ -d "$workspace" ] || { echo "Working directory does not exist" >&2; exit 1; }
# Each sideworker uses an independent HOME; trust its explicitly delegated workspace.
jq --arg p "$workspace" ' .projects[$p].hasTrustDialogAccepted = true ' "$HOME/.claude.json" > "$HOME/.claude.json.tmp"
mv "$HOME/.claude.json.tmp" "$HOME/.claude.json"
set -- --strict-mcp-config
if [ "${ENABLE_CLAUDEAI_MCP_SERVERS:-false}" = "true" ]; then set --; fi
tmux new-session -d -s main -x 160 -y 48 -c "$workspace" claude --settings /etc/household/claude-settings.json \
  --mcp-config /etc/household/mcp.json "$@" --model "$HOUSEHOLD_MODEL" \
  --permission-mode "$HOUSEHOLD_PERMISSION_MODE" --append-system-prompt "$HOUSEHOLD_INSTRUCTIONS"
while tmux has-session -t main 2>/dev/null; do sleep 2; done
