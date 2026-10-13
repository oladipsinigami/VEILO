#!/usr/bin/env bash
# Compile AND run the Sapling audit-path tests.
#
# Runs in the Codespace because Smart App Control blocks freshly linked binaries
# on the Windows box, so `cargo test` there silently executes nothing.
set -uo pipefail
cd "$(dirname "$0")/.."

echo "== cargo test -p veilo-core --features sapling --test sapling_audit =="
cargo test -p veilo-core --features sapling --test sapling_audit 2>&1 | tail -70
echo "exit=${PIPESTATUS[0]}"