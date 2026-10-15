#!/usr/bin/env bash
# Regenerate demo/fixture.json -- the inputs the browser auditor runs on.
#
# Writes to a temp file and only then moves it into place, so a failed build
# never leaves a half-written fixture that the demo would silently load.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="demo/fixture.json"
mkdir -p demo
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

echo "== generating fixture =="
cargo run -q -p veilo-core --features sapling --example demo_fixture > "$TMP"

# A truncated or empty fixture would make the demo look broken in a confusing
# way, so fail here rather than shipping one.
if [ ! -s "$TMP" ]; then
  echo "fixture generator produced nothing" >&2
  exit 1
fi
python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(f\"  {len(d['outputs'])} outputs, {len(d['reveals'])} reveals, escrow ivk {d['escrow_ivk'][:16]}...\")" "$TMP"

mv "$TMP" "$OUT"
trap - EXIT
echo "wrote $OUT ($(wc -c < "$OUT") bytes)"