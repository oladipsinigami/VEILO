# Veilo demo — independent auction audit

Open `index.html` over HTTP and press **Run the audit**.

```bash
python3 -m http.server --directory demo 8000
# then visit http://localhost:8000
```

It must be served over HTTP, not opened as a `file://` URL — ES modules and
`fetch` are blocked on `file://` by the browser's origin rules.

## What happens when you press the button

1. The page loads `pkg/veilo_wasm_bg.wasm` — Zcash's real Sapling note
   encryption, compiled to WebAssembly.
2. It concatenates the ten outputs in `fixture.json` into a flat buffer and
   calls `audit_range(ivk, buffer)`.
3. In the browser, with no server and no network calls, every output is
   trial-decrypted with the escrow viewing key. Five decrypt; five are decoys
   belonging to other addresses and are discarded.
4. Each surviving bid's amount is resolved by checking a permissionless reveal
   against the `bid_commit` that was already in the memo — via `verify_reveal`,
   also in wasm. A reveal that does not hash to the committed value is rejected.
5. Bids are classified: seller excluded, under-collateralised rejected, below
   reserve rejected. The remainder are sorted and the **second-highest** wins.

Expected output:

```
winner          bidder 1010101010…
clearing price  60.00 ZEC
```

## The row that matters

The seller bids **65 ZEC** and is excluded. That is the highest bid other than
the winner's, so if the exclusion rule were missing the clearing price would be
65 ZEC instead of 60. The demo is built to make that difference visible.

## Verifying it yourself

`ops/verify-demo.sh` runs this exact pipeline under Node against the same
compiled wasm, and fails loudly if the result differs from the stated outcome or
if any invariant is violated (seller never eligible, an under-collateralised bid
always present to exercise the rule).

```bash
bash ops/build-wasm.sh     # regenerate demo/pkg
bash ops/verify-demo.sh    # check the pipeline end to end
```

The Rust tests (`crates/veilo-core/tests/sapling_audit.rs`) cover the same
logic plus more. The Node check exists because the Rust tests cannot catch a
broken wasm-bindgen ABI or a JSON contract mismatch — those only fail in a
browser.

## Honesty note

The ciphertexts in `fixture.json` are produced by Zcash's real Sapling note
encryption and carry real 512-byte Veilo envelopes, so the decryption shown is
genuine. **They were not mined on a chain.** This demonstrates the cryptography
and the auction arithmetic, not transaction broadcast. Broadcasting a real bid
is a separate claim and is currently blocked on a Zallet/zebra state-format gap
(see `ops/README.md`).
