#!/usr/bin/env bash
# scribe_poll.sh — two-phase watcher for a quantum-os collab room, for a headless
# Claude CLI that monitors the room and greets new joiners.
#
#   Phase 1 (every run, cheap ~45s): a LISTEN-ONLY probe via scripts/qos-cli. No
#     /scribe list sent. Catches broadcast chat + "Welcome, <name>!" joins; if
#     nothing new since last run -> prints NOCHANGE and exits.
#   Phase 2 (only when Phase 1 saw activity): send `/scribe list 500`, diff against
#     the seen-file, greet genuinely new joiners once, print new transcript lines
#     and flag any addressed to the CLI.
#
# Config via env:
#   SCRIBE_POLL_ROOM   room cap (default: the public MyRoom.md room)
#   SCRIBE_POLL_STATE  state dir (default: ~/.cache/scribe-poll)
#   SCRIBE_POLL_NAME   peer name for our poller (default: qlf-cli-poll)
#
# Typical use: a cron / loop invokes this every 5-10 min. State persists across
# runs in SCRIBE_POLL_STATE so restarts don't re-report or re-greet.

set -u
ROOM="${SCRIBE_POLL_ROOM:-cap:room:05214747236101414325074505234721}"
NAME="${SCRIBE_POLL_NAME:-qlf-cli-poll}"
STATE_DIR="${SCRIBE_POLL_STATE:-$HOME/.cache/scribe-poll}"
CLI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/qos-cli" && pwd)"
PROBE_SEEN="$STATE_DIR/scribe_probe_seen.txt"
SEEN="$STATE_DIR/scribe_seen.txt"
GREETED="$STATE_DIR/scribe_greeted.txt"
LOG="$STATE_DIR/scribe_poll_$(date +%s).log"
SELF_RE="^(${NAME}|qlf-claude|qlf-claude-listen|qlf-scribe-check|qlf-cli-.*|facilitator|skeptic|scribe)$"
mkdir -p "$STATE_DIR"; touch "$PROBE_SEEN" "$SEEN" "$GREETED"
[ -d "$CLI_DIR" ] || { echo "no qos-cli dir at $CLI_DIR"; exit 1; }
cd "$CLI_DIR" || exit 1

# strip qos-cli noise -> keep genuine broadcast chat / join lines
filter_activity() {
  grep -E '^\[[a-z0-9]+…\] ' "$1" \
    | sed -E 's/^\[[a-z0-9]+…\] //' \
    | grep -vE '^\{"kind"' \
    | grep -vE '^(Hi — I.m (skeptic|facilitator|scribe)|👋 Yes, I.m here — scribe)' \
    | grep -vE "Welcome, (${NAME}|qlf-claude|qlf-claude-listen|qlf-scribe-check|qlf-cli-)" \
    | grep -vE '^📜 last ' \
    | sed -E 's/[[:space:]]+$//' | awk 'NF'
}

# ---------- Phase 1: cheap listen-only probe ----------
timeout 52 node qos-cli.mjs --room "$ROOM" --name "$NAME" --listen > "$LOG" 2>&1 &
PID=$!; sleep 45; kill "$PID" 2>/dev/null

filter_activity "$LOG" | awk '!s[$0]++' > "$STATE_DIR/probe_now.txt"
PROBE_NEW=$(grep -Fxv -f "$PROBE_SEEN" "$STATE_DIR/probe_now.txt" || true)
cat "$STATE_DIR/probe_now.txt" >> "$PROBE_SEEN"
sort -u "$PROBE_SEEN" -o "$PROBE_SEEN"
tail -n 400 "$PROBE_SEEN" > "$PROBE_SEEN.tmp" && mv "$PROBE_SEEN.tmp" "$PROBE_SEEN"

if [ -z "$PROBE_NEW" ]; then
  echo "NOCHANGE: quiet room, no /scribe list pulled. $(date '+%H:%M')"
  rm -f "$LOG"; exit 0
fi
echo "ACTIVITY detected by probe:"; echo "$PROBE_NEW"; echo
rm -f "$LOG"

# ---------- Phase 2: full /scribe list pull ----------
LOG="$STATE_DIR/scribe_poll_$(date +%s).log"
timeout 80 node qos-cli.mjs --room "$ROOM" --name "$NAME" \
  --message "/scribe list 500" --listen > "$LOG" 2>&1 &
PID=$!; sleep 70; kill "$PID" 2>/dev/null

grep -oE '[0-9]{1,2}:[0-9]{2} [A-Za-z0-9_-]+: .+' "$LOG" \
  | sed -E 's/ \| .*$//' \
  | grep -vE "[0-9]{1,2}:[0-9]{2} ${NAME}: " \
  | grep -vE "[0-9]{1,2}:[0-9]{2} facilitator: .*Welcome, ${NAME}!" \
  | awk '!s[$0]++' > "$STATE_DIR/scribe_now.txt"

NEW=$(grep -Fxv -f "$SEEN" "$STATE_DIR/scribe_now.txt" || true)
if [ -z "$NEW" ]; then
  echo "(probe saw activity but /scribe list added no new timestamped lines)"
  rm -f "$LOG"; exit 0
fi
cat "$STATE_DIR/scribe_now.txt" >> "$SEEN"
sort -u "$SEEN" -o "$SEEN"

NEWJOINERS=$(echo "$NEW" | grep -oE 'Welcome, [^!]+!' | sed -E 's/^Welcome, //; s/!$//' | sort -u)
GREET_DONE=""
while IFS= read -r name; do
  [ -z "$name" ] && continue
  echo "$name" | grep -qE "$SELF_RE" && continue
  grep -Fxq "$name" "$GREETED" && continue
  MSG="👋 Hi $name — I'm the QLF Claude CLI. I watch the room and work the quantum-os / quantum-logical-framework repos (proofs, docs, the census tools). Ask me anything, or say what you're exploring. About this room: https://github.com/rhovision-org/quantum-os/blob/main/MyRoom.md"
  timeout 45 node qos-cli.mjs --room "$ROOM" --name "$NAME" --message "$MSG" --wait 12000 --linger 4000 >/dev/null 2>&1
  echo "$name" >> "$GREETED"
  GREET_DONE="$GREET_DONE $name"
done <<< "$NEWJOINERS"

echo "=== NEW /scribe list lines ($(date '+%Y-%m-%d %H:%M')) ==="
echo "$NEW"; echo
[ -n "$GREET_DONE" ] && echo "GREETED new joiner(s):$GREET_DONE" && echo
FLAG=$(echo "$NEW" | grep -iE 'claude|\bcli\b|task|test|lemma|\bci\b|issue|fix|improve' || true)
if [ -n "$FLAG" ]; then
  echo "*** lines that may be directed at the Claude CLI: ***"
  echo "$FLAG"
fi
rm -f "$LOG"
