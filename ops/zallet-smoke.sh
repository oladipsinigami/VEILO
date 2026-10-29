#!/usr/bin/env bash
# Milestone 1 of the Zallet stack: get zebrad and Zallet running together on
# regtest, and make Zallet produce a shielded address.
#
# WHY THIS IS A SEPARATE SCRIPT
# -----------------------------
# The previous attempt used zebrad alone and failed for two independent reasons,
# neither of which is a configuration mistake:
#
#   1. zebrad has no wallet. z_getnewaddress, z_getbalance and z_sendmany all
#      return -32601 "Method not found". It can never fund a bid.
#   2. Its internal miner cannot build a regtest block 1 (upstream #8434).
#
# Zallet is the supported wallet now that zcashd is EOL, but it is NOT standalone:
# its `[indexer] validator_address` points at a full node, so the two run
# together. This script wires them up.
#
# STAGED ON PURPOSE. The first milestone is only "does Zallet produce an
# address". Funding it and sending a memo-bearing transaction is the next step,
# and is not attempted here -- a script that half-works and exits 0 teaches you
# nothing.
set -uo pipefail
cd "$(dirname "$0")/.."

ZEBRAD_BIN="bin/zebrad"
ZALLET_BIN="${ZALLET_DIR:-$HOME/zallet}/zallet"
DATA_DIR="$PWD/.zallet-regtest"

rpc() { # rpc <port> <json> [extra curl args...]
  local port="$1" body="$2"
  shift 2
  curl -s --max-time 15 "http://127.0.0.1:$port" \
    -H 'content-type: application/json' --data "$body" "$@" 2>/dev/null || true
}

log() { echo "[zallet-smoke] $*"; }

cleanup() {
  [ -f "$DATA_DIR/zallet.pid" ] && kill "$(cat "$DATA_DIR/zallet.pid")" 2>/dev/null
  [ -f "$DATA_DIR/zebrad.pid" ] && kill "$(cat "$DATA_DIR/zebrad.pid")" 2>/dev/null
  return 0
}
trap cleanup EXIT

# --- preflight -------------------------------------------------------------
for f in "$ZEBRAD_BIN" "$ZALLET_BIN"; do
  if [ ! -x "$f" ]; then
    echo "missing executable: $f" >&2
    [ "$f" = "$ZEBRAD_BIN" ] && echo "  build it, or let CI cache it" >&2
    [ "$f" = "$ZALLET_BIN" ] && echo "  run: bash ops/install-zallet.sh" >&2
    exit 1
  fi
done

rm -rf "$DATA_DIR"
mkdir -p "$DATA_DIR"

# --- zebrad ----------------------------------------------------------------
# Cookie auth is off in ops/zebrad-zallet-regtest.toml and both listeners are on
# loopback in an ephemeral CI container, so no auth juggling is needed here.
log "starting zebrad (regtest, rpc 28233, indexer 28234)"
"$ZEBRAD_BIN" -c ops/zebrad-zallet-regtest.toml > ops/zebrad-zallet.log 2>&1 &
echo $! > "$DATA_DIR/zebrad.pid"

for i in $(seq 1 60); do
  H=$(rpc 28233 '{"jsonrpc":"2.0","id":1,"method":"getblockcount","params":[]}')
  if printf '%s' "$H" | grep -q '"result"'; then
    log "zebrad up after ${i}s (height ${H})"
    break
  fi
  sleep 1
done

if ! rpc 28233 '{"jsonrpc":"2.0","id":1,"method":"getblockcount","params":[]}' | grep -q '"result"'; then
  echo "zebrad did not become ready. Log:" >&2
  tail -40 ops/zebrad-zallet.log >&2
  exit 1
fi

# --- zallet ----------------------------------------------------------------
# Zallet has no `data_dir` config key. It unconditionally reads
# `~/.zallet/zallet.toml` (observed: "Loading configuration
# config=/home/vscode/.zallet/zallet.toml"), so the config has to go there. On a
# GitHub runner HOME=/home/runner, so this lands in the runner's own home.
mkdir -p "$HOME/.zallet"
cp ops/zallet-regtest.toml "$HOME/.zallet/zallet.toml"

# Zallet encrypts wallet key material at rest with an age identity and refuses
# to start without one:
#   "Encryption identity file could not be located at
#    ~/.zallet/encryption-identity.txt"
# A plain identity is the right choice here -- ephemeral regtest container,
# nothing of value -- and the interactive passphrase path would hang CI. The
# command writes to keystore.encryption_identity's default, which is this path.
if [ ! -f "$HOME/.zallet/encryption-identity.txt" ]; then
  log "generating a throwaway encryption identity (regtest only)"
  "$ZALLET_BIN" generate-encryption-identity
fi

log "starting zallet (regtest, wallet rpc 28232)"
"$ZALLET_BIN" start > ops/zallet.log 2>&1 &
echo $! > "$DATA_DIR/zallet.pid"

for i in $(seq 1 90); do
  R=$(rpc 28232 '{"jsonrpc":"2.0","id":1,"method":"getblockcount","params":[]}' \
        -u veilo:veilo-regtest-only)
  if printf '%s' "$R" | grep -qE '"result"|"error"'; then
    log "zallet RPC answered after ${i}s: $R"
    ZALLET_READY=1
    break
  fi
  sleep 1
done

if [ "${ZALLET_READY:-0}" != "1" ]; then
  echo "Zallet never answered on 28232. Its log:" >&2
  tail -40 ops/zallet.log >&2 || echo "(no ops/zallet.log)" >&2
  exit 1
fi

log "zallet wallet getwalletinfo:"
rpc 28232 '{"jsonrpc":"1.0","id":"veilo","method":"getwalletinfo","params":[]}' \
  -u veilo:veilo-regtest-only
echo
log "zallet getnetwork:"
rpc 28232 '{"jsonrpc":"1.0","id":"veilo","method":"getnetwork","params":[]}' \
  -u veilo:veilo-regtest-only
echo

log "MILESTONE 1 OK: zebrad and Zallet both up, Zallet serving RPC."
echo "Address generation is the next step -- see ops/README.md."