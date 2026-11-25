#!/usr/bin/env bash
# Add one AI agent to a QuantumOS room — the one command a newcomer needs.
#
#   bash add-agent.sh <room link | cap:room:…> [role] [display name]
#
# The browser's `/agent add` prints this command with the room filled in. It:
#   • installs the agent's dependencies the first time (npm install),
#   • picks the AI backend it can actually use:
#       the `claude` CLI on PATH        → your Claude plan (no API key)
#       else ANTHROPIC_API_KEY is set   → the Anthropic API (pay as you go)
#       else                            → no AI: greets and answers basics
#                                         from its built-in FAQ
#     (AI=off forces the last; AI=api / AI=claude-code force a backend),
#   • keeps the room's memory (--persist) so the room outlives its browsers
#     (NO_MEMORY=1 turns that off),
#   • runs the agent DETACHED, so closing the terminal does not remove it.
#
# Roles: facilitator (default), skeptic, scribe, greeter, observer.
# SIGNAL=<wss url> points it at a room's own signaling server.
# Stop it with:  bash stop-agents.sh <role>   (same pidfiles as run-agents.sh)
#
# Unlike run-agents.sh this never turns on the test-REV faucet and has no
# default room: it does exactly what the room asked for and nothing else.
set -euo pipefail
cd "$(dirname "$0")"

usage() { sed -n '2,4p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }
[ $# -ge 1 ] || usage 1
case "$1" in -h|--help) usage 0 ;; esac

ROOM="$1"
ROLE="${2:-facilitator}"
NAME="${3:-}"

# Accept the full link (…#room=cap%3Aroom%3A…) or a bare cap; agent.mjs parses
# either, but checking here gives the error before anything is installed.
case "$ROOM" in
  *cap:room:*|*cap%3Aroom%3A*|*cap%3aroom%3a*) ;;
  *) echo "That doesn't look like a room link — expected …#room=cap:room:… or cap:room:…"; exit 1 ;;
esac
case "$ROLE" in
  facilitator|skeptic|scribe|greeter|observer) ;;
  *) echo "Unknown role '$ROLE'. Roles: facilitator, skeptic, scribe, greeter, observer."; exit 1 ;;
esac

command -v node >/dev/null || { echo "Node.js 18+ is needed — https://nodejs.org/"; exit 1; }
major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$major" -ge 18 ] || { echo "Node.js 18+ is needed (found $(node -v))."; exit 1; }
if [ ! -d node_modules ]; then
  echo "• first run: installing the agent's dependencies…"
  npm install --no-audit --no-fund --no-update-notifier --loglevel=error
fi

ai=()
case "${AI:-auto}" in
  off) ;;
  api) ai=(--ai --ai-backend api) ;;
  claude-code) ai=(--ai --ai-backend claude-code) ;;
  auto)
    if command -v claude >/dev/null; then ai=(--ai --ai-backend claude-code)
    elif [ -n "${ANTHROPIC_API_KEY:-}" ]; then ai=(--ai --ai-backend api)
    fi ;;
  *) echo "AI must be auto, off, api or claude-code"; exit 1 ;;
esac

mkdir -p .agents
pidf=".agents/$ROLE.pid"
if [ -f "$pidf" ] && kill -0 "$(cat "$pidf")" 2>/dev/null; then
  echo "A $ROLE is already running here (pid $(cat "$pidf")). Stop it first: bash $(pwd)/stop-agents.sh $ROLE"
  exit 1
fi

persist=()
[ -n "${NO_MEMORY:-}" ] || persist=(--persist)
namearg=()
[ -z "$NAME" ] || namearg=(--name "$NAME")
sigarg=()
[ -z "${SIGNAL:-}" ] || sigarg=(--signal "$SIGNAL")   # the room's signaling server, if not the default

log=".agents/$ROLE.log"
start=0; [ -f "$log" ] && start="$(wc -l < "$log")"
# ${a[@]+"${a[@]}"} so an empty array is not "unbound" under set -u on bash 3.2 (macOS).
nohup node agent.mjs --room "$ROOM" --role "$ROLE" ${namearg[@]+"${namearg[@]}"} ${ai[@]+"${ai[@]}"} \
  ${sigarg[@]+"${sigarg[@]}"} --state "./.qos-$ROLE" ${persist[@]+"${persist[@]}"} >> "$log" 2>&1 &
pid=$!
echo "$pid" > "$pidf"

# Wait for the join, so "it worked" means it reached the room, not just started.
joined=""
for _ in $(seq 1 40); do
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "✗ the $ROLE stopped straight away. Last lines of its log:"; tail -n 15 "$log"; rm -f "$pidf"; exit 1
  fi
  if tail -n +"$((start + 1))" "$log" | grep -q "joined room"; then joined=1; break; fi
  sleep 0.5
done

if [ ${#ai[@]} -eq 0 ]; then
  mode="no AI (built-in FAQ only — install the claude CLI or set ANTHROPIC_API_KEY for full answers)"
else
  mode="AI via ${ai[2]}"
fi
if [ -n "$joined" ]; then
  echo "✓ ${NAME:-$ROLE} joined the room (pid $pid) — $mode"
else
  echo "• ${NAME:-$ROLE} started (pid $pid) but hasn't reached the signaling server yet — $mode"
  echo "  If it never does, this machine can't reach quantum-os-signaling.onrender.com (a firewall or proxy)."
fi
echo "  In the room, type /agent to see it, or /ask <question>."
echo "  Log:  tail -f $(pwd)/$log"
echo "  Stop: bash $(pwd)/stop-agents.sh $ROLE"
