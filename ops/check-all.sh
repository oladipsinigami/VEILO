#!/usr/bin/env bash
# Full local verification: the audit path, the wasm exports, and the wasm32 build.
#
# Runs in the Codespace because Smart App Control blocks freshly linked binaries
# on the Windows box, so `cargo test` there silently executes nothing.
set -uo pipefail
cd "$(dirname "$0")/.."
FAIL=0

section() { printf '\n== %s ==\n' "$1"; }

section "veilo-core (default features)"
cargo test -p veilo-core 2>&1 | grep -E "^(test result|error|running [0-9]+ tests)" | head -20
[ "${PIPESTATUS[0]}" -eq 0 ] || FAIL=1

section "veilo-core (sapling): audit path"
cargo test -p veilo-core --features sapling --test sapling_audit 2>&1 | grep -E "^(test |test result|error|running)" | head -20
[ "${PIPESTATUS[0]}" -eq 0 ] || FAIL=1

section "veilo-wasm (sapling): exported auditor logic"
cargo test -p veilo-wasm --features sapling 2>&1 | grep -E "^(test |test result|error|running)" | head -25
[ "${PIPESTATUS[0]}" -eq 0 ] || FAIL=1

section "clippy (all targets, warnings are errors)"
cargo clippy --workspace --all-targets --features veilo-core/sapling -- -D warnings 2>&1 | grep -E "^(error|warning: unused|warning: .* generated)" | head -15
[ "${PIPESTATUS[0]}" -eq 0 ] || FAIL=1

section "wasm32 build"
if ! rustup target list --installed | grep -qx wasm32-unknown-unknown; then
  rustup target add wasm32-unknown-unknown >/dev/null 2>&1
fi
cargo build -p veilo-wasm --features sapling --target wasm32-unknown-unknown 2>&1 | grep -E "^(error|warning)" | head -15
[ "${PIPESTATUS[0]}" -eq 0 ] || FAIL=1
ls -la target/wasm32-unknown-unknown/debug/*.wasm 2>/dev/null | head -3

printf '\n'
if [ "$FAIL" -eq 0 ]; then echo "ALL CHECKS PASSED"; else echo "FAILURES ABOVE"; fi
exit "$FAIL"