#!/usr/bin/env bash
# Launch QuantumOS room agents DETACHED, on your Claude subscription (claude-code
# backend — needs the `claude` CLI installed + logged in). Because they're nohup'd,
# they keep running after you close the terminal (use tmux/screen or a service for
# survival across logout/reboot).
#
#   bash run-agents.sh [room-cap-or-url] [role ...]
#
# Defaults: the public test room (the one MyRoom.md links — cap:room:0521…4721,
# also used by scribe_poll.sh and selftest.mjs) + facilitator, WITH the test-REV faucet active
# (--key, from scripts/localnet/pk.txt's devnet deployer — FACIL_KEY= to
# disable). Stable identity per role under ./.qos-<role>; logs + pids under
# ./.agents. Stop with ./stop-agents.sh.
#
# HOW MANY AGENTS
#
# The default is ONE: the facilitator, carrying the room's memory via --persist.
# Two co-located node agents burn CPU on the werift ICE between each other —
# measured at ~35%/core for the facilitator<->skeptic connection alone, dropping
# to ~5% the moment the second agent stops (werift's ICE layer, no consent
# timer; the #125 fingerprint memo does not cover the whole SDP-rebuild path).
# The facilitator's duties are a superset of scribe's and greeter's, so neither
# is worth a peer. `skeptic` is the only role with `verify` (which predicate a
# history actually passed) — add it explicitly when you need that and accept the
# CPU cost:  bash run-agents.sh "$ROOM" facilitator skeptic
#
# The `/rholang` macro agent is NOT started here — the browser expands locally,
# so the agent is only worth a peer when you want the expansion posted into chat
# for the room to read. Start it by hand if you do:
#   node rholang-agent.mjs --room <cap> --name rholang
#
set -euo pipefail
cd "$(dirname "$0")"

ROOM="${1:-cap:room:05214747236101414325074505234721}"
shift || true
# Default role: facilitator alone — it greets, prompts for names, synthesises,
# chairs, and carries the memory. Pass roles explicitly to add more, e.g.
#   bash run-agents.sh "$ROOM" facilitator skeptic
# `observer` records live games (/observer start … stop) and needs no memory of its own.
ROLES=("$@"); [ ${#ROLES[@]} -eq 0 ] && ROLES=(facilitator)

# The room's memory rides with the FIRST role rather than running as its own
# peer. Same duty qos-daemon.mjs performs alone — which still works standalone,
# see the README — but carried here it costs no peer against the ceiling above.
# NO_MEMORY=1 turns it off; PERSIST_DIR moves the store.
PERSIST_DIR="${PERSIST_DIR:-./.qos-memory}"

# Seconds between joins. Override with STAGGER=n for a slower link or a bigger cast.
STAGGER="${STAGGER:-15}"

# TEST REV faucet (dev shard only — see scripts/qos-cli/README.md's "Test REV
# faucet" section). The facilitator's --key deploys against the rnode in
# rholang-client.mjs's DEFAULT_CONFIG — the dev instance at rnodeapi.rhobot.net,
# no longer loopback. The key is still the localnet's genesis-funded deployer
# from scripts/localnet/pk.txt (committed, documented as throwaway), so it has
# REV on that node only if its genesis was built from scripts/localnet/
# wallet.txt — and defaulting it on is as safe as pk.txt being committed only
# for as long as that node stays a dev instance. FACIL_KEY overrides it;
# FACIL_KEY= (set to empty) disables the faucet without touching this file.
# Only ever passed to the `facilitator` role — one key in one process, not
# one per agent.
FACIL_KEY="${FACIL_KEY-$(grep '^deployer=' ../localnet/pk.txt 2>/dev/null | cut -d= -f2 | tr -d '[:space:]')}"

command -v node >/dev/null || { echo "node not found — install Node 18+."; exit 1; }
[ -d node_modules ] || { echo "Run 'npm install' in scripts/qos-cli first."; exit 1; }
AI_BACKEND="${AI_BACKEND:-claude-code}"
case "$AI_BACKEND" in
  claude-code|claude|cli)
    command -v claude >/dev/null || echo "warning: 'claude' CLI not on PATH — the claude-code AI backend needs it (agents still run, deterministically)."
    ;;
esac

mkdir -p .agents
for role in "${ROLES[@]}"; do
  pidf=".agents/$role.pid"
  if [ -f "$pidf" ] && kill -0 "$(cat "$pidf")" 2>/dev/null; then
    echo "• $role already running (pid $(cat "$pidf"))"; continue
  fi
  persist=()
  if [ -z "${NO_MEMORY:-}" ] && [ "$role" = "${ROLES[0]}" ]; then persist=(--persist "$PERSIST_DIR"); fi
  keyflag=()
  if [ "$role" = "facilitator" ] && [ -n "$FACIL_KEY" ]; then keyflag=(--key "$FACIL_KEY"); fi
  # FAUCET_HTTP=<port> also serves the faucet over HTTP (agent.mjs
  # --faucet-http) — for a wallet (r-wallet) on the playground/testnet that
  # cannot join the room. Rate-limited in agent.mjs; put a TLS proxy in front.
  httpflag=()
  if [ "$role" = "facilitator" ] && [ -n "$FACIL_KEY" ] && [ -n "${FAUCET_HTTP:-}" ]; then httpflag=(--faucet-http "$FAUCET_HTTP"); fi
  # FACIL_RNODE=<url> is the chain the faucet's REV is on (agent.mjs --rnode;
  # default rholang-client.mjs's). Playground and testnet are two chains, so
  # two facilitators with two values — the same key is funded on each.
  rnodeflag=()
  if [ "$role" = "facilitator" ] && [ -n "${FACIL_RNODE:-}" ]; then rnodeflag=(--rnode "$FACIL_RNODE"); fi
  nohup node agent.mjs --room "$ROOM" --role "$role" --ai --ai-backend "$AI_BACKEND" \
    --state "./.qos-$role" "${persist[@]}" "${keyflag[@]}" "${httpflag[@]}" "${rnodeflag[@]}" >> ".agents/$role.log" 2>&1 &
  echo $! > "$pidf"
  echo "✓ started $role (pid $!)${keyflag[*]:+ [test-REV faucet active]}${httpflag[*]:+ [faucet HTTP :$FAUCET_HTTP]} → scripts/qos-cli/.agents/$role.log"
  sleep "$STAGGER"   # keep joins off each other's heels; see the ceiling note above
done


echo
echo "Tail:  tail -f scripts/qos-cli/.agents/*.log"
echo "Stop:  bash scripts/qos-cli/stop-agents.sh"
