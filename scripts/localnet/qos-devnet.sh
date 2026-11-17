#!/usr/bin/env bash
# #601 — typed launcher; the Python runtime owns and verifies all started PIDs.
set -euo pipefail
exec python3 "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/qos-devnet.py" "$@"
