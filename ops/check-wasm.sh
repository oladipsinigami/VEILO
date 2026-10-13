#!/usr/bin/env bash
# Check that the audit path builds for wasm32-unknown-unknown.
#
# This is the gate for the browser auditor: if sapling-crypto cannot compile
# for wasm32, the plan has to change (server-side audit, or a different crypto
# stack) and it is much cheaper to find out before writing exports on top of it.
#
# Runs in the Codespace because Smart App Control blocks freshly linked binaries
# on the Windows box.
set -uo pipefail
cd "$(dirname "$0")/.."

if ! rustup target list --installed | grep -qx wasm32-unknown-unknown; then
  echo "== adding wasm32-unknown-unknown =="
  rustup target add wasm32-unknown-unknown || exit 1
fi

echo "== veilo-core (sapling) for wasm32 =="
cargo build -p veilo-core --features sapling --target wasm32-unknown-unknown 2>&1 | tail -45
echo "veilo-core exit=${PIPESTATUS[0]}"

echo
echo "== veilo-wasm for wasm32 =="
cargo build -p veilo-wasm --features sapling --target wasm32-unknown-unknown 2>&1 | tail -45
echo "veilo-wasm exit=${PIPESTATUS[0]}"