#!/usr/bin/env bash
# Install the Zallet wallet binary.
#
# WHY ZALLET AND NOT ZCASHD
# ------------------------
# zcashd reached End of Life. Per https://z.cash/support/zcashd-deprecation/,
# on 2026-07-18 at block 3417100 every zcashd 6.20.0 binary shuts down and
# refuses to restart (hard-coded DEPRECATION_HEIGHT in src/deprecation.h), and
# zcashd does not support NU6.3. Zallet is the supported replacement: the same
# page says "If you depend on the zcashd wallet, start testing Zallet ... as
# soon as possible."
#
# zebrad, meanwhile, has no wallet at all -- z_getnewaddress, z_getbalance and
# z_sendmany all return -32601 "Method not found". So Zallet is currently the
# only supported way to hold keys and broadcast a transaction with a memo,
# which is exactly what the Veilo bid path needs.
#
# The release publishes a prebuilt linux-amd64 tarball, so there is nothing to
# compile. Idempotent: re-running is a no-op once the binary is present.
set -euo pipefail

ZALLET_VERSION="${ZALLET_VERSION:-v0.1.0-beta.3}"
INSTALL_DIR="${ZALLET_DIR:-$HOME/zallet}"
TARBALL="zallet-${ZALLET_VERSION}-linux-amd64.tar.gz"
URL="https://github.com/zcash/zallet/releases/download/${ZALLET_VERSION}/${TARBALL}"

if [ -x "$INSTALL_DIR/zallet" ] && "$INSTALL_DIR/zallet" --version >/dev/null 2>&1; then
  echo "zallet already installed: $("$INSTALL_DIR/zallet" --version 2>&1 | head -1)"
  exit 0
fi

mkdir -p "$INSTALL_DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "== downloading $TARBALL (~144 MB) =="
# --retry because a 144MB transfer over a Codespace SSH link drops often.
curl -fsSL --retry 5 --retry-delay 3 --retry-all-errors \
  -o "$TMP/$TARBALL" "$URL"

# Verify size against the release. A truncated download otherwise produces an
# obscure "cannot execute binary file" much later.
GOT=$(stat -c %s "$TMP/$TARBALL")
if [ "$GOT" -lt 100_000_000 ]; then
  echo "download looks truncated: only $GOT bytes" >&2
  exit 1
fi
echo "   $GOT bytes"
echo "   sha256 $(sha256sum "$TMP/$TARBALL" | cut -d' ' -f1)"

echo "== extracting =="
tar xzf "$TMP/$TARBALL" -C "$TMP"
# The tarball has a single versioned directory; move its binaries up to
# INSTALL_DIR so the path stays stable across version bumps.
mv "$TMP/zallet-${ZALLET_VERSION}-linux-amd64"/* "$INSTALL_DIR/"
chmod +x "$INSTALL_DIR"/zallet "$INSTALL_DIR"/zallet-zaino "$INSTALL_DIR"/zallet-zebra

echo "== installed =="
ls -la "$INSTALL_DIR" | grep -E 'zallet' || true
"$INSTALL_DIR/zallet" --version 2>&1 | head -3
echo
echo "Add to PATH:  export PATH=\"$INSTALL_DIR:\$PATH\""