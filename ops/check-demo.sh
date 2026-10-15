#!/usr/bin/env bash
# Run the audit-path tests and record the output to a file.
#
# The log file exists because streaming a long build/test transcript over the
# Codespace SSH tunnel loses output when the tunnel blips. Writing to disk first
# and reading the file afterwards is reliable.
set -uo pipefail
cd "$(dirname "$0")/.."

LOG="ops/demo-test.log"

{
  echo "== demo audit tests =="
  cargo test -p veilo-core --features sapling --test sapling_audit -- --nocapture 2>&1
  echo "DEMO_TEST_EXIT=$?"

  echo
  echo "== clippy =="
  cargo clippy --workspace --all-targets --features veilo-core/sapling -- -D warnings 2>&1 | tail -20
  echo "CLIPPY_EXIT=$?"
} > "$LOG" 2>&1

tail -40 "$LOG"