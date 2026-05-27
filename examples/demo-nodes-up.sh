#!/usr/bin/env bash
# Launch the demo nodes for /tmp/pollen-demo.json.
# Prefers the PACKAGE-driven node (examples/pollen-node, built on
# amalgame-pollen — correct `if` cond routing) and falls back to
# the legacy pollen-node-tcp binary if the package node is absent.
# Stop them with : pkill -x pollen-node   (or pkill -x pollen-node-tcp)
set -u

PKG_NODE="${POLLEN_PKG_NODE:-$HOME/Développement/amalgame-pollen/examples/pollen-node}"
LEGACY="${POLLEN_TCP_BIN:-$HOME/.cache/pollen-dev/pollen-node-tcp}"
WF="${WORKFLOW_PATH:-/tmp/pollen-demo.json}"
SHARED="${POLLEN_SHARED:-/tmp/pollen-shared}"
LOGDIR=/tmp/pollen-nodes
mkdir -p "$LOGDIR" "$SHARED"

if [ -x "$PKG_NODE" ]; then
    BIN="$PKG_NODE"; KIND="package"
elif [ -x "$LEGACY" ]; then
    BIN="$LEGACY"; KIND="legacy"
else
    echo "no node binary found (looked for $PKG_NODE then $LEGACY)" >&2
    exit 1
fi
echo "using $KIND node : $BIN"

nodes=(
    "ingest:8000"
    "enrich:8001"
    "vip:8002"
    "standard:8003"
)

pkill -x pollen-node 2>/dev/null
pkill -x pollen-node-tcp 2>/dev/null
sleep 0.5

for n in "${nodes[@]}"; do
    role="${n%%:*}"
    port="${n##*:}"
    nohup "$BIN" "$port" \
        --workflow "$WF" \
        --node-name "$role" \
        --shared-dir "$SHARED" \
        > "$LOGDIR/$role.log" 2>&1 &
    echo "launched $role on :$port (pid $!) → $LOGDIR/$role.log"
done

sleep 1.5
echo "--- listening ports ---"
ss -tlnp 2>/dev/null | grep -E ":800[0-3]" | awk '{print $4}' | sort
echo "done. inject via the manager UI or :"
echo "  $LEGACY 0 --publish 127.0.0.1:8000:order.in:1:'{\"amount\":1500}'"
