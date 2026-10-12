#!/usr/bin/env bash
# Build zebrad WITH the experimental `internal-miner` feature.
#
# Why this is necessary: in zebra-rpc/src/config/mining.rs,
#   #[cfg(feature = "internal-miner")]
#   pub fn is_internal_miner_enabled(&self) -> bool { self.internal_miner }
# The method does not exist at all in a build without the feature, so the
# prebuilt release binaries can never mine on regtest no matter what the config
# says. `internal_miner = true` in a stock binary is silently inert.
#
# This is a cold build of a large Rust workspace. Expect 15-40 minutes on a
# 2-core codespace. Run it in the background and keep working:
#   nohup bash ops/build-zebra.sh > ops/build-zebra.log 2>&1 &
set -euo pipefail
cd "$(dirname "$0")/.."

ZEBRA_TAG="${ZEBRA_TAG:-main}"
OUT="ops/build-zebra.log"

if [ -x bin/zebrad-internal-miner ]; then
  echo "bin/zebrad-internal-miner already built."
  exit 0
fi

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

say "Checking whether the downloaded binary already supports the internal miner"
if [ -x bin/zebrad ]; then
  if ./bin/zebrad --version 2>&1 | grep -qi "internal.miner"; then
    echo "Prebuilt binary already has internal-miner; copying."
    cp bin/zebrad bin/zebrad-internal-miner
    exit 0
  fi
  echo "  no -- source build required."
fi

say "Building zebrad from source ($ZEBRA_TAG) with --features internal-miner"
echo "This is a cold build and will take a while. Log: $OUT"

CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-target-zebra}" \
  cargo install --locked \
    --git "https://github.com/ZcashFoundation/zebra" \
    --rev "$ZEBRA_TAG" \
    --bin zebrad \
    --features internal-miner \
    --root "$PWD/.zebrad-install" \
    --no-default-features \
    --features internal-miner,release_max_level_info 2>&1 | tee -a "$OUT"

mkdir -p bin
cp .zebrad-install/bin/zebrad bin/zebrad-internal-miner
./bin/zebrad-internal-miner --version

cat <<'EOF'

Built. Now use it:
  bash ops/fund.sh
EOF
