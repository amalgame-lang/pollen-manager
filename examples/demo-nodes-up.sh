#!/usr/bin/env bash
# Launch all 6 demo nodes for /tmp/pollen-demo.json.
# Stop them with : pkill -f pollen-node-tcp
set -u

BIN="${POLLEN_TCP_BIN:-$HOME/.cache/pollen-dev/pollen-node-tcp}"
WF="${WORKFLOW_PATH:-/tmp/pollen-demo.json}"
SHARED="${POLLEN_SHARED:-/tmp/pollen-shared}"
LOGDIR=/tmp/pollen-nodes
mkdir -p "$LOGDIR" "$SHARED"

if [ ! -x "$BIN" ]; then
    echo "no pollen-node-tcp binary at $BIN" >&2
    exit 1
fi

# role:port pairs from the demo workflow
nodes=(
    "ingest:8000"
    "enrich:8001"
    "vip:8002"
    "standard:8003"
)

# kill any previous run first
pkill -f "pollen-node-tcp" 2>/dev/null
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
ss -tlnp 2>/dev/null | grep -E ":800[0-5]" | awk '{print $4}'
echo "done. inject via the manager UI or :"
echo "  $BIN 0 --publish 127.0.0.1:8000:order.in:1:'{\"amount\":1500}'"
