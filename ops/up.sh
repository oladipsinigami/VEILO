#!/usr/bin/env bash
# Start zebrad on regtest in the background and wait for the RPC to answer.
set -euo pipefail
cd "$(dirname "$0")/.."

RPC_PORT="${ZEBO_RPC_PORT:-8232}"
LOG="ops/zebrad.log"
PIDFILE="ops/zebrad.pid"
CONFIG="ops/zebrad-regtest.toml"

ZEBRA_BIN="bin/zebrad"
if [ -x bin/zebrad-internal-miner ]; then ZEBRA_BIN="bin/zebrad-internal-miner"; fi

if [ ! -x "$ZEBRA_BIN" ]; then
  echo "no zebrad binary. Run: bash ops/bootstrap.sh (prebuilt) or bash ops/build-zebra.sh (can mine)" >&2
  echo "If the prebuilt download failed, rebuild with internal-miner:" >&2
  echo "  cargo install --git https://github.com/ZcashFoundation/zebra --locked \\" >&2
  echo "    --bin zebrad --features internal-miner" >&2
  exit 1
fi

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "zebrad already running (pid $(cat "$PIDFILE"))"
  exit 0
fi

# Note: the miner address is NOT required to boot. With none configured the node
# starts and serves RPC, which is what fund.sh needs in order to call
# z_getnewaddress. Refusing to start without it deadlocked fund.sh <-> up.sh.

echo "starting zebrad (regtest), rpc on 127.0.0.1:${RPC_PORT}"
nohup "./$ZEBRA_BIN" -c "$CONFIG" > "$LOG" 2>&1 &
echo $! > "$PIDFILE"

for i in $(seq 1 60); do
  if curl -s --max-time 2 "http://127.0.0.1:${RPC_PORT}" \
       -H 'content-type: application/json' \
       --data '{"jsonrpc":"2.0","id":1,"method":"getblockcount","params":[]}' \
       | grep -q '"result"'; then
    echo "zebrad is up after ${i}s"
    ./"$ZEBRA_BIN" --version 2>/dev/null || true
    exit 0
  fi
  sleep 1
done

echo "zebrad did not come up in 60s. Last log lines:" >&2
tail -30 "$LOG" >&2
exit 1
