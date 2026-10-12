#!/usr/bin/env bash
# Create and fund a transparent wallet on regtest.
#
# Zcash coinbase outputs mature after 100 blocks, so a fresh regtest chain needs
# 101+ blocks mined before any coinbase is spendable. That is the single biggest
# source of confusion when setting this up by hand, so it is scripted here.
set -euo pipefail
cd "$(dirname "$0")/.."

RPC="http://127.0.0.1:${ZEBO_RPC_PORT:-8232}"
CONFIG="ops/zebrad-regtest.toml"
mkdir -p ops/keys

rpc() { curl -s --max-time 10 "$RPC" -H 'content-type: application/json' --data "$1"; }

height() { rpc '{"jsonrpc":"2.0","id":1,"method":"getblockcount","params":[]}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"])'; }

if ! rpc '{"jsonrpc":"2.0","id":1,"method":"getblockcount","params":[]}' | grep -q result; then
  echo "zebrad is not running. Start it with: bash ops/up.sh" >&2
  exit 1
fi

echo "== generating miner address =="
ADDR=$(rpc '{"jsonrpc":"2.0","id":1,"method":"z_getnewaddress","params":["transparent"]}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"])')
echo "$ADDR" | tee ops/keys/miner_address.txt

python3 - "$CONFIG" "$ADDR" <<'PY'
import sys, re
path, addr = sys.argv[1], sys.argv[2]
s = open(path, encoding="utf-8").read()
s = re.sub(r"miner_address = \".*?\"", f'miner_address = "{addr}"', s)
open(path, "w", encoding="utf-8").write(s)
print(f"wrote miner_address into {path}")
PY

echo
echo "== restarting zebrad to pick up the miner address =="
[ -f ops/zebrad.pid ] && kill "$(cat ops/zebrad.pid)" 2>/dev/null || true
sleep 1
bash ops/up.sh

echo
echo "== mining to coinbase maturity (needs >100 blocks) =="
TARGET=$(( $(height) + 110 ))
while [ "$(height)" -lt "$TARGET" ]; do
  rpc '{"jsonrpc":"2.0","id":1,"method":"generate","params":[1]}' >/dev/null 2>&1 || true
  printf '\r  height %s / %s' "$(height)" "$TARGET"
done
printf '\r  height %s / %s  done\n' "$(height)" "$TARGET"

echo
echo "== balance check =="
rpc '{"jsonrpc":"2.0","id":1,"method":"z_getbalance","params":["*"]}' \
  | python3 -c 'import sys,json; print("  spendable:", json.load(sys.stdin)["result"], "ZEC")'

echo
echo "Regtest chain is funded. Next: ops/README.md"
