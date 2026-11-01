#!/usr/bin/env bash
# run-node.sh — a standalone RChain node to develop /rholang against.
#
#   bash run-node.sh          start (reuses existing chain state)
#   bash run-node.sh --fresh  wipe the data dir and rebuild genesis first
#
# The node binary is bin/rnode, committed at the repo root, so a checkout of
# quantum-os alone is enough to bring a chain up -- no rholo checkout, no
# PATH symlink. Set RNODE=/path/to/rnode to run a different build against the
# same genesis, which is how a candidate rnode gets tested before it replaces
# bin/rnode.
#
# The flags are not decoration; each one earns its place:
#
#   --host 127.0.0.1     without it the node guesses an external IP and Kademlia
#                        fails to bind.
#   --api-host 127.0.0.1 the HTTP API the browser talks to. Without it /rholang
#                        cannot reach the node at all.
#   --dev-mode           lets `/rholang eval` work. Exploratory deploy is refused
#                        on a validating node unless dev mode is on. It does not
#                        affect block production — measured, both ways.
#   --deployer-private-key
#                        turns on the node's NATIVE faucet, POST /api/faucet
#                        {"address"} → {deployId, amount, to}, signed by the
#                        node from this key. r-wallet's faucet button calls
#                        exactly this; without the flag the node answers
#                        "faucet requires --dev-mode --deployer-private-key"
#                        (seen live on rhobot.net). pk.txt's `deployer` — the
#                        same throwaway key the facilitator faucet uses, so
#                        both draw one account. DEPLOYER_KEY= (empty) leaves it
#                        off; the node's own rate limit applies.
#
# NOT set: --min-phlo-price 0. At price 0 the charge is zero and pre_charge
# returns before it looks at any balance, which makes it look like a shortcut. It
# is not: block production then fails outright, every propose ending in
# "Validation of self created block failed with reason: InvalidStateHash".
# Measured on a fresh genesis, one flag apart — plain flags produce blocks,
# adding --min-phlo-price 0 produces none.
#
# wallet.txt funds the keys in pk.txt, and genesis seeds those balances into the
# node's native vault state, so a deploy from either key is pre-charged and
# executes. Both `/rholang eval` and `/rholang deploy` reach the qucalc
# powerbox — verified against rholo dev f3f4759e9.
set -euo pipefail
cd "$(dirname "$0")"

DATA_DIR="${QOS_RNODE_DATA:-$HOME/.rnode-local}"
RNODE="${RNODE:-$(cd ../.. && pwd)/bin/rnode}"
KEY="$(grep '^validator=' pk.txt | cut -d= -f2)"
DEPLOYER_KEY="${DEPLOYER_KEY-$(grep '^deployer=' pk.txt | cut -d= -f2)}"

if [ ! -x "$RNODE" ]; then
  echo "run-node.sh: no executable rnode at $RNODE" >&2
  echo "  set RNODE=/path/to/rnode, or restore bin/rnode from the repo." >&2
  exit 1
fi
echo "rnode: $RNODE"

# --fresh rebuilds genesis. Only pass it when you actually want a new chain —
# swapping bin/rnode is usually a DATA-COMPATIBILITY test (start the new binary
# against the existing chain and see if it reads it), which --fresh defeats.
# So --fresh does not delete: it MOVES the old data dir aside to a timestamped
# .bak, keeping the last few, so a genesis you didn't mean is recoverable.
if [ "${1:-}" = "--fresh" ]; then
  if [ -d "$DATA_DIR" ]; then
    bak="$DATA_DIR.bak-$(date +%Y%m%d-%H%M%S)"
    echo "--fresh: moving $DATA_DIR -> $bak (not deleting)"
    mv "$DATA_DIR" "$bak"
    # keep the 3 most recent backups, prune the rest
    ls -dt "$DATA_DIR".bak-* 2>/dev/null | tail -n +4 | xargs -r rm -rf
  else
    echo "--fresh: no existing $DATA_DIR to move aside"
  fi
fi
mkdir -p "$DATA_DIR/genesis"
cp bonds.txt "$DATA_DIR/genesis/bonds.txt"
cp wallet.txt "$DATA_DIR/genesis/wallets.txt"

faucet=()
if [ -n "$DEPLOYER_KEY" ]; then faucet=(--deployer-private-key "$DEPLOYER_KEY"); fi

exec "$RNODE" run -s \
  --dev-mode "${faucet[@]}" \
  --autopropose \
  --no-upnp \
  --host 127.0.0.1 \
  --api-host 127.0.0.1 \
  --data-dir "$DATA_DIR" \
  --bonds-file "$DATA_DIR/genesis/bonds.txt" \
  --wallets-file "$DATA_DIR/genesis/wallets.txt" \
  --validator-private-key "$KEY"
