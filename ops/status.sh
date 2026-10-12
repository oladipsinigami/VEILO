#!/usr/bin/env bash
# One-glance status: toolchain, zebrad, chain height, test counts.
set -uo pipefail
cd "$(dirname "$0")/.."

ok()   { printf '  \033[32m%s\033[0m\n' "$1"; }
bad()  { printf '  \033[31m%s\033[0m\n' "$1"; }
warn() { printf '  \033[33m%s\033[0m\n' "$1"; }

echo "== toolchain =="
printf '  rustc %s\n' "$(rustc --version 2>/dev/null || echo MISSING)"
printf '  node  %s\n' "$(node --version 2>/dev/null || echo MISSING)"
if rustup target list --installed 2>/dev/null | grep -q wasm32-unknown-unknown; then
  ok "wasm32-unknown-unknown target installed"
else
  warn "wasm32-unknown-unknown NOT installed (bash ops/bootstrap.sh)"
fi

echo
echo "== zebrad =="
if [ -f bin/zebrad ]; then ok "bin/zebrad present"; else bad "bin/zebrad MISSING (bash ops/bootstrap.sh)"; fi
if [ -f ops/zebrad.pid ] && kill -0 "$(cat ops/zebrad.pid)" 2>/dev/null; then
  ok "running (pid $(cat ops/zebrad.pid))"
  # getblockcount is an indexer method -> indexer_listen_addr, and cookie auth applies.
  A=(); [ -s "$HOME/.cache/zebra/.cookie" ] && A=(-u "cookie:$(cat "$HOME/.cache/zebra/.cookie")")
  H=$(curl -s --max-time 3 "${A[@]}" "http://127.0.0.1:${ZEBO_INDEXER_PORT:-8233}" \
        -H 'content-type: application/json' \
        --data '{"jsonrpc":"2.0","id":1,"method":"getblockcount","params":[]}' \
      | python3 -c 'import sys,json; print(json.load(sys.stdin).get("result","?"))' 2>/dev/null || echo "?")
  printf '  regtest height: %s\n' "$H"
else
  bad "not running (bash ops/up.sh)"
fi

echo
echo "== disk =="
df -h . | tail -1 | awk '{printf "  %s total, %s used, %s free\n",$2,$3,$4}'

echo
echo "== tests =="
if [ -d target ]; then
  warn "target/ present ($(du -sh target 2>/dev/null | cut -f1)) - cargo test will be fast"
else
  printf '  cargo test -p veilo-core   (not built yet)\n'
fi
printf '  node --experimental-strip-types --test "test/*.test.js"\n'
