#!/usr/bin/env bash
# Run every sapling-gated test binary and report each one's result.
#
# Kept as a script because a bare `cargo test` needs a working directory, and
# driving that through the Codespace SSH tunnel mangles the quoting. Output goes
# to a log file so a tunnel blip does not lose it.
set -uo pipefail
cd "$(dirname "$0")/.."

LOG="ops/all-sapling-tests.log"
{
  for t in sapling_audit demo_audit; do
    echo "== tests/$t.rs =="
    cargo test -p veilo-core --features sapling --test "$t" 2>&1 | grep -E "^(test |running |test result|error)"
    echo "exit=$?"
  done
  echo
  echo "== veilo-wasm =="
  cargo test -p veilo-wasm --features sapling 2>&1 | grep -E "^(test |running |test result|error)"
  echo "exit=$?"
} > "$LOG" 2>&1

cat "$LOG"