#!/usr/bin/env bash
# Create and fund a wallet on regtest.
#
# Zcash coinbase outputs mature after 100 blocks, so a fresh chain cannot spend
# anything until block 101. That is the single most confusing part of regtest
# setup, so it is scripted here.
#
# Boot order matters and was previously deadlocked:
#   * fund.sh needs a live RPC to call z_getnewaddress
#   * up.sh used to refuse to start until a miner address was configured
#   * but the address could only come FROM the running node
# Now: start the node with mining disabled -> get an address -> restart with
# mining configured -> mine.
set -euo pipefail
cd "$(dirname "$0")/.."

RPC="http://127.0.0.1:${ZEBO_RPC_PORT:-8232}"
CONFIG="ops/zebrad-regtest.toml"
mkdir -p ops/keys

rpc() { curl -s --max-time 15 "$RPC" -H 'content-type: application/json' --data "$1"; }
height() {
  rpc '{"jsonrpc":"2.0","id":1,"method":"getblockcount","params":[]}' \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("result",0))' 2>/dev/null || echo 0
}
alive() {
  rpc '{"jsonrpc":"2.0","id":1,"method":"getblockcount","params":[]}' | grep -q '"result"'
}
stop_ze() { [ -f ops/zebrad.pid ] && kill "$(cat ops/zebrad.pid)" 2>/dev/null || true; sleep 1; }

# Pick the binary that can actually mine.
if [ -x bin/zebrad-internal-miner ]; then
  BIN="bin/zebrad-internal-miner"
elif [ -x bin/zebrad ]; then
  BIN="bin/zebrad"
else
  echo "No zebrad binary. Run one of:" >&2
  echo "  bash ops/bootstrap.sh        # prebuilt (cannot mine)" >&2
  echo "  bash ops/build-zebra.sh      # source build (can mine)" >&2
  exit 1
fi

# ---- Phase 1: start with mining disabled so the RPC answers -------------
echo "== phase 1: boot node without mining =="
if grep -q 'miner_address = "REPLACE_ME"' "$CONFIG"; then
  echo "  no miner address yet -> starting without one"
  # Neutralise miner_address so the node starts at all.
  cp "$CONFIG" ops/zebrad-regtest.toml.bak
  sed -i 's/^miner_address = "REPLACE_ME"/miner_address = "tmEvsG7YUCGXd9T5qJfR1p4FZ4Yt1RgqG7v8YbXtLGNmA"/' "$CONFIG"
  sed -i 's/^internal_miner = true/internal_miner = false/' "$CONFIG"
  bash ops/up.sh || { cp ops/zebrad-regtest.toml.bak "$CONFIG"; exit 1; }
else
  bash ops/up.sh
fi

# ---- Phase 2: mint an address from the live node ------------------------
echo
echo "== phase 2: get a miner address =="
ADDR=$(rpc '{"jsonrpc":"2.0","id":1,"method":"z_getnewaddress","params":["transparent"]}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin).get("result",""))')
if [ -z "$ADDR" ]; then
  echo "z_getnewaddress failed. Is $(basename "$BIN") exposing the RPC?" >&2
  tail -20 ops/zebrad.log >&2
  exit 1
fi
echo "  $ADDR"
echo "$ADDR" | tee ops/keys/miner_address.txt

# ---- Phase 3: restart with mining enabled -------------------------------
echo
echo "== phase 3: restart with mining enabled =="
stop_ze
python3 - "$CONFIG" "$ADDR" <<'PY'
import sys, re
path, addr = sys.argv[1], sys.argv[2]
s = open(path, encoding="utf-8").read()
s = re.sub(r'miner_address = ".*?"', f'miner_address = "{addr}"', s)
s = s.replace("internal_miner = false", "internal_miner = true")
open(path, "w", encoding="utf-8").write(s)
print("  config updated")
PY
bash ops/up.sh

# ---- Phase 4: mine past coinbase maturity -------------------------------
echo
echo "== phase 4: mine past coinbase maturity (>100 blocks) =="
if ! "$BIN" --version >/dev/null 2>&1; then :; fi
START=$(height)
TARGET=$(( START + 110 ))
LAST=$START
while [ "$LAST" -lt "$TARGET" ]; do
  rpc '{"jsonrpc":"2.0","id":1,"method":"generate","params":[1]}' >/dev/null 2>&1 || true
  NOW=$(height)
  if [ "$NOW" -ne "$LAST" ]; then printf '\r  height %s / %s' "$NOW" "$TARGET"; LAST=$NOW; fi
done
printf '\r  height %s / %s  done\n' "$LAST" "$TARGET"

if [ "$LAST" -lt 101 ]; then
  echo
  echo "WARNING: chain only reached $LAST. 'generate' may be unavailable." >&2
  echo "That means the binary lacks the internal-miner feature. Build one with:" >&2
  echo "  bash ops/build-zebra.sh" >&2
  echo "See ops/README.md for the getblocktemplate + submitblock alternative." >&2
  exit 1
fi

echo
echo "== balance =="
rpc '{"jsonrpc":"2.0","id":1,"method":"z_getbalance","params":["*"]}' \
  | python3 -c 'import sys,json; print("  spendable:", json.load(sys.stdin).get("result","?"), "ZEC")'

echo
echo "Regtest chain is funded. See ops/README.md for the next step."
