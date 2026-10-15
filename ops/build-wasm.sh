#!/usr/bin/env bash
# Build the browser auditor into a loadable wasm module + JS glue.
#
# `cargo build --target wasm32-unknown-unknown` alone is NOT enough: it produces
# a .wasm with no bindings, and a browser cannot read its exports. The
# wasm-bindgen CLI post-processes it into a module that JavaScript can actually
# call.
#
# The CLI version MUST match the wasm-bindgen crate version. A mismatch compiles
# fine and then fails at runtime with an opaque error, so the version is read
# out of Cargo.lock rather than hardcoded.
#
# Output: demo/pkg/{veilo_wasm.js,veilo_wasm_bg.wasm} -- the standard
# wasm-bindgen --target web layout, loaded with ES modules.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="demo/pkg"
mkdir -p "$OUT"

echo "== toolchain =="
rustup target list --installed | grep -qx wasm32-unknown-unknown \
  || rustup target add wasm32-unknown-unknown

# Resolve the wasm-bindgen version the workspace actually depends on, so the CLI
# cannot drift away from the crate and break the ABI.
WB_VER=$(python3 - <<'PY'
import re
lock = open("Cargo.lock", encoding="utf-8").read()
m = re.search(r'name = "wasm-bindgen"\nversion = "([^"]+)"', lock)
print(m.group(1) if m else "")
PY
)
if [ -z "$WB_VER" ]; then
  echo "could not find wasm-bindgen in Cargo.lock" >&2
  exit 1
fi
echo "wasm-bindgen crate version: $WB_VER"

if ! command -v wasm-bindgen >/dev/null 2>&1 \
   || [ "$(wasm-bindgen --version)" != "$WB_VER" ]; then
  echo "== installing wasm-bindgen-cli $WB_VER (one-time, ~5 min) =="
  cargo install wasm-bindgen-cli --version "$WB_VER" --locked
fi
echo "wasm-bindgen CLI: $(wasm-bindgen --version)"

echo "== building veilo-wasm for wasm32 =="
cargo build --release -p veilo-wasm --features sapling --target wasm32-unknown-unknown

echo "== generating bindings =="
wasm-bindgen --target web --out-dir "$OUT" \
  --out-name veilo_wasm \
  target/wasm32-unknown-unknown/release/veilo_wasm.wasm

chmod +x "$OUT"/*.wasm 2>/dev/null || true
echo
ls -la "$OUT"
echo
echo "Demo entry point: demo/index.html"
echo "Serve it with:  python3 -m http.server --directory demo 8000"