#!/usr/bin/env bash
# Compile-only check for the Sapling audit path.
#
# `cargo build` (not `test`) so we are not waiting on test binaries, and with
# --features sapling to pull in sapling-crypto. Run inside the Codespace
# because Smart App Control blocks freshly linked binaries on the Windows box.
set -uo pipefail
cd "$(dirname "$0")/.."

echo "== cargo build -p veilo-core --features sapling =="
cargo build -p veilo-core --features sapling 2>&1 | tail -60
echo "exit=${PIPESTATUS[0]}"