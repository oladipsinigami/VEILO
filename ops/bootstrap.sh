#!/usr/bin/env bash
# Workspace bootstrap for Codespaces. Idempotent: safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

say "Toolchain"
rustc --version
cargo --version
node --version

if ! rustup target list --installed | grep -q wasm32-unknown-unknown; then
  say "Adding wasm32-unknown-unknown target"
  rustup target add wasm32-unknown-unknown
fi

say "Fetching zebrad release (Linux binary, internal-miner)"
ZEBRA_VERSION="7.0.0-rc.0"
ZEBRA_BIN="zebrad-${ZEBRA_VERSION}-x86_64-unknown-linux-gnu"
mkdir -p bin
if [ ! -x "bin/${ZEBRA_BIN}" ]; then
  BASE="https://github.com/ZcashFoundation/zebra/releases/download/v${ZEBRA_VERSION}"
  # NOTE: this prebuilt binary is NOT built with the experimental `internal-miner`
  # cargo feature, so `generate` is unavailable on regtest and fund.sh cannot mine.
  # That is the whole reason ops/build-zebra.sh exists. Do not try to fix it with
  # `cargo install --git`: cargo install rejects `-p`, and without `-p` it errors
  # with "multiple packages with binaries found".
  curl -fsSL -o "bin/${ZEBRA_BIN}" "${BASE}/${ZEBRA_BIN}.tar.gz" 2>/dev/null \
    || echo "  (download failed - see ops/README.md for the source-build fallback)"
fi

if [ -f "bin/${ZEBRA_BIN}" ]; then
  tar -xzf "bin/${ZEBRA_BIN}" -C bin 2>/dev/null || true
  # `if`, not `[ ... ] && chmod`: under `set -e` a failing `&&` list aborts the
  # whole bootstrap, and bin/zebrad is legitimately absent when the tarball did
  # not contain it.
  if [ -f "bin/zebrad" ]; then chmod +x bin/zebrad; fi
  ls -la bin/zebrad 2>/dev/null || true
fi

say "Node dependencies"
if [ -f package.json ]; then
  npm install --no-audit --no-fund --silent
fi

say "Rust tests (veilo-core + cross-implementation vectors)"
# Generates the vectors from TypeScript first, so the Rust replay is never stale.
node --experimental-strip-types test/gen-vectors.mjs
node --experimental-strip-types test/gen-auction-vectors.mjs
cargo test -p veilo-core

say "TypeScript tests"
node --experimental-strip-types --test "test/*.test.js"

say "Ready"
cat <<'EOF'
  bash ops/up.sh          # start zebrad regtest
  bash ops/fund.sh        # create + fund a transparent wallet, mature the coinbase
  bash ops/status.sh      # where is everything
EOF
