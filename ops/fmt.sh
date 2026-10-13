#!/usr/bin/env bash
# Apply `cargo fmt` in-place and report what changed.
#
# Needed because the Windows box cannot run the cargo-installed rustfmt (Smart
# App Control blocks it), and CI checks formatting. Run this in the Codespace.
set -uo pipefail
cd "$(dirname "$0")/.."

cargo fmt --all || exit 1

if git diff --quiet -- '*.rs'; then
  echo "already formatted"
else
  echo "changed by cargo fmt:"
  git diff --stat -- '*.rs'
fi