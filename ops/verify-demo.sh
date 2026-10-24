#!/usr/bin/env bash
# Prove the browser auditor actually works, using the exact module the browser loads.
#
# Why bother, when the Rust tests already cover the same logic? Because the
# browser path has moving parts the Rust tests never touch: the wasm-bindgen ABI,
# the generated JS glue, and the JSON contract between Rust and the page. A
# mismatch there fails only in the browser, which is the worst place to find out.
#
# This runs the committed `demo/pkg` bundle -- the same bytes the page fetches --
# so a stale bundle fails here too. Node can load it directly because the
# generated glue is an ES module with an explicit `init`, which is what
# `--target web` produces.
#
# Rebuild the bundle first if the Rust source changed:
#   bash ops/build-wasm.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f demo/pkg/veilo_wasm_bg.wasm ]; then
  echo "demo/pkg is missing; run: bash ops/build-wasm.sh" >&2
  exit 1
fi

echo "== running the page's pipeline under Node against demo/pkg =="
node ops/verify-demo.mjs
