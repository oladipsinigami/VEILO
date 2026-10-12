#!/usr/bin/env bash
# Start zebrad on regtest in the background and wait for the RPC to answer.
set -euo pipefail
cd "$(dirname "$0")/.."

RPC_PORT="${ZEBO_RPC_PORT:-8232}"
LOG="ops/zebrad.log"
PIDFILE="ops/zebrad.pid"
CONFIG="ops/zebrad-regtest.toml"

if [ ! -f bin/zebrad ]; then
  echo "bin/zebrad not found. Run: bash ops/bootstrap.sh" >&2
  echo "If the prebuilt download failed, rebuild with internal-miner:" >&2
  echo "  cargo install --git https://github.com/ZcashFoundation/zebra --locked \\" >&2
  echo "    --bin zebrad --features internal-miner" >&2
  exit 1
fi

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "zebrad already running (pid $(cat "$PIDFILE"))"
  exit 0
fi

# The miner address must be set before zebrad starts.
if grep -q REPLACE_ME "$CONFIG"; then
  echo "Miner address not configured yet. Run: bash ops/fund.sh" >&2
  exit 1
fi

echo "starting zebrad (regtest), rpc on 127.0.0.1:${RPC_PORT}"
nohup ./bin/zebrad -c "$CONFIG" > "$LOG" 2>&1 &
echo $! > "$PIDFILE"

for i in $(seq 1 60); do
  if curl -s --max-time 2 "http://127.0.0.1:${RPC_PORT}" \
       -H 'content-type: application/json' \
       --data '{"jsonrpc":"2.0","id":1,"method":"getblockcount","params":[]}' \
       | grep -q '"result"'; then
    echo "zebrad is up after ${i}s"
    ./bin/zebrad --version 2>/dev/null || true
    exit 0
  fi
  sleep 1
done

echo "zebrad did not come up in 60s. Last log lines:" >&2
tail -30 "$LOG" >&2
exit 1
