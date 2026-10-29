#!/usr/bin/env bash
# Milestone 2 of the Zallet stack: get zebrad and Zallet running together on
# regtest, and make Zallet produce a shielded Unified Address.
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
# STAGED ON PURPOSE. This milestone ends at "Zallet derives a shielded address
# from its own chain view". Funding it and sending a memo-bearing transaction is
# the next step, and is not attempted here -- a script that half-works and exits
# 0 teaches you nothing.
#
# ORDER MATTERS, AND IT IS NOT THE OBVIOUS ONE.
# ---------------------------------------------
# Zallet will not derive an account until it has synced, and it will not sync
# until it has an account (its birthday is what tells the scanner where to
# start). `z_getnewaccount` is therefore closed until some account exists, which
# is a chicken-and-egg problem a human solves by hand in the docs and
# `zallet regtest generate-account-and-miner-address` solves for regtest: it
# writes a default account with a height-0 birthday, which gives the sync engine
# a starting point. That is why the wallet is prepared BEFORE the nodes start,
# and why the first account is created by a CLI command rather than over RPC.
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

# --- zallet wallet preparation (no node needed) ----------------------------
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

# The rest of Zallet's documented setup order (book/src/guide/setup.md):
# identity file, init-wallet-encryption, generate-mnemonic, then start. Skip the
# middle two and the wallet has no root of spend authority, so account creation
# fails with "Wallet does not contain any seeds to generate accounts with".
#
# These are one-shot commands: they take the data directory lock that `start`
# holds, so they must run before it, and only on a wallet that does not exist
# yet. The guard is the wallet database, not a marker file, so a rerun on a
# half-built wallet still repairs it.
FRESH_WALLET=0
if [ ! -f "$HOME/.zallet/wallet.db" ]; then
  FRESH_WALLET=1

  log "initializing wallet encryption (plain identity, regtest only)"
  "$ZALLET_BIN" init-wallet-encryption

  # Unconfirmed is fine here: keystore.require_backup defaults to false on
  # regtest (matching zcashd's fRequireWalletBackup=false), so an unconfirmed
  # phrase may still derive accounts. On mainnet this step would need
  # `zallet confirm-backup`, which is interactive.
  log "generating a throwaway mnemonic (regtest only)"
  "$ZALLET_BIN" generate-mnemonic
fi

# The bootstrap account. Without an account the wallet has no birthday, so the
# sync engine has nowhere to start and every account/spend RPC answers
# -28 "Wallet sync required". The command refuses on a wallet that already has a
# chain height, so it only runs on a fresh one.
#
# It prints a transparent address intended for zebrad's miner. This milestone
# does not mine, so the address is only echoed -- but creating the account is
# the point, and the address is what the next milestone will need to fund it.
if [ "$FRESH_WALLET" = "1" ]; then
  log "creating the bootstrap account (regtest only)"
  MINER_ADDR=$("$ZALLET_BIN" regtest generate-account-and-miner-address)
  if [ -z "$MINER_ADDR" ]; then
    echo "regtest generate-account-and-miner-address printed no address" >&2
    exit 1
  fi
  log "bootstrap miner address: $MINER_ADDR"
fi

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
log "starting zallet (regtest, wallet rpc 28232)"
"$ZALLET_BIN" start > ops/zallet.log 2>&1 &
echo $! > "$DATA_DIR/zallet.pid"

for i in $(seq 1 90); do
  R=$(rpc 28232 '{"jsonrpc":"1.0","id":"veilo","method":"getwalletstatus","params":[]}' \
        -u veilo:veilo-regtest-only)
  if printf '%s' "$R" | grep -q '"result"'; then
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

# --- wait for the wallet to finish syncing ---------------------------------
# `locked` is Zallet's own word for "not synced with the chain", and while it is
# true the account and spend RPCs refuse by design. This is not a race the
# script should paper over with a fixed sleep: poll the status the wallet
# reports and print it, so a hang shows the actual state rather than a timeout.
SYNCED=0
for i in $(seq 1 90); do
  STATUS=$(rpc 28232 '{"jsonrpc":"1.0","id":"veilo","method":"getwalletstatus","params":[]}' \
    -u veilo:veilo-regtest-only)
  if printf '%s' "$STATUS" | grep -q '"locked":false'; then
    log "wallet synced after ${i}s: $STATUS"
    SYNCED=1
    break
  fi
  sleep 1
done

if [ "$SYNCED" != "1" ]; then
  echo "wallet never reported locked:false. Last status: $STATUS" >&2
  tail -40 ops/zallet.log >&2 || true
  exit 1
fi

# --- the thing this job exists to prove ------------------------------------
# "The RPC socket answers" is a weak signal: `getwalletinfo` is still a TODO in
# beta.3 and answers -32601, and even `getwalletstatus` answers while the wallet
# is locked. An address is the first artefact the bid path needs, and deriving
# one exercises the keystore, the wallet database and the chain backend rather
# than just HTTP.
#
# `z_getnewaccount` then `z_getaddressforaccount` is Zallet's documented path
# (book/src/guide/first-wallet.md); method names are from
# book/src/rpc/methods.md.
log "creating an account"
ACCOUNT=$(rpc 28232 '{"jsonrpc":"1.0","id":"veilo","method":"z_getnewaccount","params":["veilo"]}' \
  -u veilo:veilo-regtest-only)
echo "$ACCOUNT"

ACCOUNT_UUID=$(printf '%s' "$ACCOUNT" | python3 -c \
  'import json,sys; print(json.load(sys.stdin)["result"]["account_uuid"])' 2>/dev/null || true)

if [ -z "${ACCOUNT_UUID:-}" ]; then
  echo "z_getnewaccount returned no account_uuid. Response: $ACCOUNT" >&2
  tail -40 ops/zallet.log >&2 || true
  exit 1
fi

log "deriving a Unified Address for account $ACCOUNT_UUID"
ADDRESS_RESP=$(rpc 28232 \
  "{\"jsonrpc\":\"1.0\",\"id\":\"veilo\",\"method\":\"z_getaddressforaccount\",\"params\":[\"$ACCOUNT_UUID\"]}" \
  -u veilo:veilo-regtest-only)
echo "$ADDRESS_RESP"

ADDRESS=$(printf '%s' "$ADDRESS_RESP" | python3 -c \
  'import json,sys; print(json.load(sys.stdin)["result"]["address"])' 2>/dev/null || true)

if [ -z "${ADDRESS:-}" ]; then
  echo "z_getaddressforaccount returned no address. Response: $ADDRESS_RESP" >&2
  tail -40 ops/zallet.log >&2 || true
  exit 1
fi

# A regtest Unified Address starts with uregtest1 (ZIP-316 HRPs: u / utest /
# uregtest). Anything else means the wallet picked the wrong network or
# returned a transparent address, either of which invalidates the bid path.
case "$ADDRESS" in
  uregtest1*)
    log "MILESTONE 2 OK: shielded Unified Address on regtest: $ADDRESS"
    ;;
  *)
    echo "expected a regtest Unified Address (uregtest1...), got: $ADDRESS" >&2
    exit 1
    ;;
esac

echo "Next step: fund that address, then send a memo-bearing transaction."
