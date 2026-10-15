#!/usr/bin/env bash
# Prove the browser auditor actually works, using the exact module the browser loads.
#
# Why bother, when the Rust tests already cover the same logic? Because the
# browser path has moving parts the Rust tests never touch: the wasm-bindgen ABI,
# the generated JS glue, and the JSON contract between Rust and the page. A
# mismatch there fails only in the browser, which is the worst place to find out.
#
# Builds a second copy of the same wasm with `--target nodejs` (so plain Node can
# load it without a browser) and runs demo/index.html's exact pipeline against the
# real fixture.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== building a node-loadable copy of the same wasm =="
mkdir -p /tmp/veilo-node
wasm-bindgen --target nodejs --out-dir /tmp/veilo-node --out-name veilo_wasm \
  target/wasm32-unknown-unknown/release/veilo_wasm.wasm

echo "== running the page's pipeline under Node =="
node ops/verify-demo.mjs