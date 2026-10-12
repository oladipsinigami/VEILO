#!/usr/bin/env bash
# Run every check that does not need a Zcash node.
#
# This exists because the Windows dev box cannot run its own Rust tests:
# Smart App Control blocks newly linked executables (os error 4551), so
# `cargo test` appears to pass while executing nothing. On Linux (Codespaces,
# CI) this is the same command line CI runs, and it really does execute.
#
#   bash ops/dev.sh          # fmt + clippy + tests, TS and Rust
#   bash ops/dev.sh fmt      # cargo fmt --check only
#   bash ops/dev.sh ts       # TypeScript only
#   bash ops/dev.sh rust     # Rust only
set -uo pipefail
cd "$(dirname "$0")/.."

WHAT="${1:-all}"
FAIL=0

step() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
note() { printf '   %s\n' "$1"; }

run_ts() {
  step "TypeScript"
  if [ ! -d node_modules ]; then npm install --no-audit --no-fund || return 1; fi
  npm run -s typecheck || FAIL=1
  npm run -s test || FAIL=1
}

run_rust() {
  step "cargo fmt"
  cargo fmt --all --check || FAIL=1

  step "cargo clippy"
  cargo clippy --all-targets -- -D warnings || FAIL=1

  step "cargo test"
  cargo test --workspace || FAIL=1
}

case "$WHAT" in
  fmt)  step "cargo fmt"; cargo fmt --all --check || FAIL=1 ;;
  ts)   run_ts ;;
  rust) run_rust ;;
  all)  run_ts; run_rust ;;
  *)    echo "usage: bash ops/dev.sh [all|fmt|ts|rust]" >&2; exit 2 ;;
esac

printf '\n'
if [ "$FAIL" -eq 0 ]; then
  printf '\033[32mdev.sh: all checks passed\033[0m\n'
else
  printf '\033[31mdev.sh: FAILURES above\033[0m\n'
fi
exit "$FAIL"