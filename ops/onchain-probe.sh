#!/usr/bin/env bash
# Probe: can a real zcashd wallet put a 512-byte Veilo envelope on a chain?
#
# This is the whole feasibility question for the on-chain demo, in one run. It
# does not try to be elegant. If it works, the pieces get folded into a proper
# harness; if it does not, it cost one CI run instead of a day.
#
# What it proves, in order:
#   1. zcashd accepts a 512-byte memo on a Sapling send (the limit is exactly
#      512 bytes, zero-padded, which is why the Veilo envelope fits at all).
#   2. The transaction is mined into a block.
#   3. The memo comes back byte-for-byte, so nothing truncates or re-encodes it.
#   4. The raw transaction can be exported for an independent auditor to parse.
#
# Why zcashd and not Zallet: this needs a node AND a wallet in one process, and
# it must mine. zcashd is EOL for mainnet, but regtest needs neither a peer nor
# a network upgrade schedule beyond what we pass explicitly.
#
# Regtest ships every network upgrade INACTIVE, so they have to be switched on
# with -nuparams, in order. Branch IDs are from src/consensus/upgrades.cpp at
# v6.20.0:
#   Overwinter 5ba81b19, Sapling 76b809bb, Blossom 2bb40e60,
#   Heartwood  f5b9230b, Canopy  e9ff75a6
# It stops at Canopy on purpose. Canopy is the last pre-NU5 upgrade, so the
# transaction is still v4 -- the shape the browser auditor reads -- while ZIP 212
# note encryption is in force. That matters: the auditor enforces ZIP 212
# (lead byte 0x02), and a chain that never reached Canopy would produce 0x01
# notes that it must, correctly, refuse to decrypt.
#
# Why z_shieldcoinbase carries the envelope rather than a follow-up z_sendmany:
#   * it consumes whole coinbase UTXOs, so there is no transparent change and no
#     privacy-policy refusal ("could not send to the Sapling pool without
#     spending non-Sapling funds");
#   * it needs no spendable-note wait -- a note minted in the tip block can be
#     invisible to z_getbalance for a block or two;
#   * since 6.20 it takes a memo directly (parameter 5).
# The note it produces is an ordinary Sapling output, which is all the auditor
# reads. A bid-shaped send (z_sendmany, shielded in and out) is the next step
# once funding is known to work; this probe is about the envelope surviving.
set -euo pipefail

CONTAINER=veilo-zcashd
RPC_USER=u
RPC_PASS=p
OUT_DIR=demo/chain-probe
FEE=0.001      # well above the ZIP 317 fee for 10 inputs / 2 outputs (0.0006)
UTXO_LIMIT=10

cli() { docker exec "$CONTAINER" zcash-cli -regtest -rpcuser="$RPC_USER" -rpcpassword="$RPC_PASS" "$@"; }
py() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

say() { echo; echo "== $* =="; }

say "starting zcashd 6.20.0 (regtest, Overwinter@1 .. Canopy@5)"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" electriccoinco/zcashd:6.20.0 \
  -regtest=1 \
  -nuparams=5ba81b19:1 \
  -nuparams=76b809bb:2 \
  -nuparams=2bb40e60:3 \
  -nuparams=f5b9230b:4 \
  -nuparams=e9ff75a6:5 \
  -rpcuser="$RPC_USER" \
  -rpcpassword="$RPC_PASS" \
  -rpcbind=127.0.0.1 \
  -rpcallowip=127.0.0.1 \
  -txindex=1 \
  -allowdeprecated=z_getnewaddress \
  -allowdeprecated=z_listaddresses \
  -allowdeprecated=z_getbalance \
  -allowdeprecated=z_gettotalbalance \
  -i-am-aware-zcashd-will-be-replaced-by-zebrad-and-zallet-in-2025=1 >/dev/null

say "waiting for RPC (first start downloads the Sapling parameters)"
up=0
for i in $(seq 1 60); do
  if cli getblockchaininfo >/dev/null 2>&1; then up=1; echo "rpc up after ~$((i * 5))s"; break; fi
  # Do not sit in this loop for five minutes if the node has already given up.
  if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" != "true" ]; then
    echo "::error::zcashd exited during startup"
    docker logs --tail 60 "$CONTAINER" || true
    exit 1
  fi
  sleep 5
done
if [ "$up" != 1 ]; then
  echo "::error::zcashd RPC never came up"
  docker logs --tail 60 "$CONTAINER" || true
  exit 1
fi

say "chain state"
cli getblockchaininfo | python3 -m json.tool | sed -n '1,40p'

# ------------------------------------------------------------------ the wallet
say "mining 110 blocks so a coinbase output matures (maturity is 100)"
cli generate 110 | py "'mined %d blocks' % len(d)"

say "creating the escrow Sapling address"
ADDR=$(cli z_getnewaddress sapling | tr -d '"')
if [ -z "$ADDR" ]; then echo "::error::no address"; exit 1; fi
echo "escrow address: $ADDR"

EXTFVK=$(cli z_exportviewingkey "$ADDR" | tr -d '"')
echo "viewing key:    ${EXTFVK:0:24}... (${#EXTFVK} chars)"

CB=$(cli listunspent 0 9999999 | py "sum(1 for u in d if u.get('generated'))")
echo "mature coinbase utxos: $CB"
if [ "${CB:-0}" -lt 1 ]; then
  echo "::error::no mature coinbase utxos to shield"
  exit 1
fi

wait_op() {
  local opid=$1 status i
  for i in $(seq 1 150); do
    status=$(cli z_getoperationstatus "[\"$opid\"]" | py "d[0]['status']")
    case "$status" in
      success) return 0 ;;
      failed)
        cli z_getoperationstatus "[\"$opid\"]" | python3 -m json.tool
        return 1
        ;;
    esac
    sleep 2
  done
  echo "::error::operation $opid never finished"
  return 1
}

op_id() { py "d if isinstance(d, str) else (d.get('opid') or d.get('operationid'))"; }

# ---------------------------------------------------------------- the envelope
# 512 bytes, each byte = its own index mod 256. Any truncation, zero-padding or
# re-encoding shows up immediately as a mismatch, and it is trivially checkable
# by eye: the hex is 000102...ff0001...
say "building a 512-byte memo"
MEMO=$(python3 -c "print(''.join('%02x' % (i % 256) for i in range(512)))")
echo "memo is ${#MEMO} hex chars = $(( ${#MEMO} / 2 )) bytes"

# z_shieldcoinbase wants a BARE `*`. Passing `'"*"'` (as an earlier version did)
# sends the quote characters along, because this parameter is not JSON-converted
# by zcash-cli, and the node then rejects it as an invalid address.
say "shielding coinbase into the escrow note, with the envelope attached"
SHIELD=$(cli z_shieldcoinbase '*' "$ADDR" "$FEE" "$UTXO_LIMIT" "$MEMO")
OPID=$(printf '%s' "$SHIELD" | op_id)
echo "operation: $OPID"
wait_op "$OPID"

TXID=$(cli z_getoperationstatus "[\"$OPID\"]" | py "d[0].get('result', {}).get('txid', '')")
if [ -z "$TXID" ]; then
  echo "::error::the operation succeeded but reported no txid"
  cli z_getoperationstatus "[\"$OPID\"]" | python3 -m json.tool
  exit 1
fi
echo "txid: $TXID"

say "mining the transaction"
cli generate 1 >/dev/null
TIP=$(cli getblockcount | py "d")
echo "chain tip: $TIP"

# ------------------------------------------------------------- what went in
say "zcashd's own view of the transaction (proves the memo is intact)"
cli z_viewtransaction "$TXID" | python3 -m json.tool | sed -n '1,60p'

RETURNED=$(cli z_viewtransaction "$TXID" \
  | py "max((o.get('memo') or '' for o in d['outputs']), key=len)")
echo
echo "memo sent:     ${MEMO:0:32}... (${#MEMO} chars)"
echo "memo returned: ${RETURNED:0:32}... (${#RETURNED} chars)"
if [ "$MEMO" = "$RETURNED" ]; then
  echo "MEMO MATCH: yes"
else
  echo "::error::memo came back different"
  exit 1
fi

# ------------------------------------------------------- the artefact itself
say "exporting the raw transaction"
mkdir -p "$OUT_DIR"
RAW=$(cli getrawtransaction "$TXID" 0 | tr -d '"')
printf '%s' "$RAW" > "$OUT_DIR/tx.hex"
BB=$(cli getrawtransaction "$TXID" 1 | py "d['blockhash']")
BH=$(cli getblock "$BB" 1 | py "d['height']")
echo "raw tx:  ${#RAW} hex chars = $(( ${#RAW} / 2 )) bytes"
echo "mined in block $BH ($BB)"

cat > "$OUT_DIR/probe.json" <<JSON
{
  "network": "regtest",
  "zcashd": "6.20.0",
  "nuparams": ["5ba81b19:1", "76b809bb:2", "2bb40e60:3", "f5b9230b:4", "e9ff75a6:5"],
  "txid": "$TXID",
  "block_height": $BH,
  "block_hash": "$BB",
  "escrow_address": "$ADDR",
  "escrow_extfvk": "$EXTFVK",
  "memo_hex_len": ${#MEMO},
  "memo_matches": true
}
JSON

say "done"
echo "artefacts:"
ls -la "$OUT_DIR"
echo
echo "next: parse tx.hex with zcash_primitives, extract the Sapling output, and"
echo "trial-decrypt it with the ivk derived from escrow_extfvk."
