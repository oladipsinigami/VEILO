# Veilo demo — seal a bid, then audit the result

The demo is two static pages served from the same directory:

| Page | Who it is for | What it does |
| :--- | :--- | :--- |
| `index.html` | the auditor | recomputes the clearing price from chain outputs |
| `bid.html` | the bidder | seals a bid in the browser, then publishes its reveal |

```bash
python3 -m http.server --directory demo 8000
# then visit http://localhost:8000            (audit)
#        or http://localhost:8000/bid.html     (bid)
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
5. Bids are classified: seller **declared and excluded**, under-collateralised
   rejected, below reserve rejected. The remainder are sorted and the
   **second-highest** wins.

   The seller row is a declaration, not a proof. The page excludes whichever
   recovered bid uses the key that `fixture.json` names in `seller_epk_bid`, and
   says in a note under the result that the price depends on that declaration.
   It cannot open the bid's sealed refund address to show the bid really is the
   seller's: that needs `SK_refund`, which only the auctioneer holds, and
   publishing it would expose every bidder's refund address. The construction
   that would fix this is in README limitation 7.

Expected output:

```
winner          bidder 1010101010…
clearing price  60.00 ZEC
```

## The row that matters

The seller bids **65 ZEC** and is excluded. That is the highest bid other than
the winner's, so if the exclusion rule were missing the clearing price would be
65 ZEC instead of 60. The demo is built to make that difference visible.

The exclusion follows `fixture.json`'s `seller_epk_bid`, and
`npm run demo:audit` checks that it really does: the run is repeated with the
declaration removed and must then exclude nobody. What the page cannot check is
whether that key genuinely belongs to the seller. `c_refund` in the fixture is
filler, no seal is opened anywhere in the browser, and "declared" is the honest
label for what happens.

## Sealing a bid (`bid.html`)

The audit page proves the result. This page produces the input it audits.

1. **Fill in three fields.** The bid is the number that stays secret. The
   collateral is what you actually send to escrow; it must be at least the bid,
   because the winner pays the clearing price out of it.
2. **Seal.** The page packs the commitment, your X25519-sealed refund address
   and the auction id into a 512-byte memo, and wraps that in a `zcash:` payment
   request whose `amount` is the collateral. All of it happens in the tab. After
   the page loads it makes **no network requests at all** — a check in CI fails
   if one ever appears.
3. **Save the ticket first.** The downloaded JSON holds the nonce that opens
   your commitment. It is never put in `localStorage`, a cookie, or the page
   again. Lose it and the bid is unreadable forever — by you, by the auctioneer,
   by anyone. That is the sealed property working, not a bug.
4. **Send the payment request.** This needs a wallet that carries a 512-byte
   binary memo. Most do not; node tooling (`z_sendmany`) does. The demo stops
   here — there is no broadcast.
5. **After the deadline, publish the reveal.** Step 2 of the page reads the
   ticket back, re-checks it against its own commitment, and prints the 40 hex
   bytes to post. Publishing is permissionless: anyone may post it, and the
   auditor matches it against the commitment already on chain.

### The bundled practice auction

`auction.json` is a practice auction, not a live one:

- its **escrow address** is the regtest address from `chain-probe/`, which is
  inert on every real network — sending ZEC to it on mainnet burns them;
- its **refund key** is derived from 32 bytes of `0x55` and that secret is
  published here so tests can open the seal. **Any refund address you type into
  the practice page is readable by anyone.** The page says so above the form. A
  real auction publishes `pk_refund` and nothing else.

### How the page is built

| File | Role |
| :--- | :--- |
| `web/src/lib/bid.ts` | validation, sealing, payment request, ticket, reveal |
| `web/src/lib/bid-entry.ts` | the only surface the page may import |
| `demo/bid/app.js` | committed esbuild bundle of the above |
| `demo/bid/page.js` | DOM only: no crypto, no secrets |
| `ops/build-bid.mjs` | rebuilds the bundle; `--check` fails on drift |
| `ops/check-bid-states.mjs` | drives the page in Chrome |

The bundle is committed for the same reason `demo/pkg` is: the page has to run
as static files, and the crypto imports bare `@noble/*` specifiers that browsers
cannot resolve. `npm run bid:check` is what keeps that honest — edit `memo.ts`,
forget to rebuild, and CI fails instead of shipping a page whose sealing code no
longer matches the audited reference.

```bash
npm run bid:build     # regenerate demo/bid/app.js
npm run bid:check     # fail if the committed bundle is stale
npm run bid:states    # drive the page in Chrome
```

`bid:states` checks the parts arithmetic cannot: the auction banner, a sealed
bid producing 1024 hex characters of memo and a `zcash:` request for the right
amount, the ticket downloading and re-opening into 80 hex characters of reveal,
the two refusals a bidder is most likely to hit (collateral below the bid, and
an edited ticket) explaining themselves in plain words, zero requests after
load, no sideways scroll at 375px, and a visible focus ring.

## Verifying it yourself

`ops/verify-demo.sh` runs this exact pipeline under Node against the committed
`demo/pkg` bundle, and fails loudly if the result differs from the stated outcome
or if any invariant is violated (seller never eligible, an under-collateralised
bid always present to exercise the rule).

```bash
bash ops/build-wasm.sh     # regenerate demo/pkg, if the Rust source changed
bash ops/verify-demo.sh    # check the pipeline end to end
# or, equivalently:
npm run demo:audit
```

That check reads the **committed** bundle rather than a fresh build, so a stale
`demo/pkg` fails here instead of shipping.

### Checking the states a person meets

`ops/check-demo-states.mjs` drives the real page in Chrome and checks the parts
an arithmetic test cannot see: the empty state before the run, the loading state
during it, the plain-language error with a retry that actually recovers, the
keyboard focus ring, and the 375px layout. It exists because the demo's failure
mode was never "wrong number" — it was "blank screen with no explanation".

```bash
npm run demo:states
```

It fails if the error message ever shows a raw exception again, if a result
appears before the button is pressed, if the page scrolls sideways on a phone,
or if Tab does not reach the button.

The Rust tests (`crates/veilo-core/tests/sapling_audit.rs` and
`tests/demo_audit.rs`) cover the same logic plus more. The Node check exists
because the Rust tests cannot catch a broken wasm-bindgen ABI or a JSON contract
mismatch — those only fail in a browser.

## The video

`demo/video/veilo-demo.mp4` (and `.webm`) is a screen recording of this page
running in Chrome, with captions burned in so it plays without narration.

```bash
npm run demo:video         # record it again in Chrome  -> demo/video/veilo-demo.webm
npm run demo:video:mp4     # transcode to H.264        -> demo/video/veilo-demo.mp4
```

The recorder is not a stunt: it drives the real page, then **asserts the result
it read off screen** — winner, clearing price, bids recovered, and that the page
reported a match — before it will keep the file. It then loads the recording back
and probes five points for real, non-identical frames. A demo that quietly
produced a wrong number would fail the recording rather than ship as evidence.

Two notes for anyone re-running it:

- **HTTP Range support is required.** The recorder's own tiny server implements
  `206 Partial Content`. Without it Chrome reports `seekable = [0, 0]` and
  silently refuses to seek, so every probe reads frame zero — which looks exactly
  like a corrupt video and is not.
- **The MP4 step is browser-based on purpose.** There is no ffmpeg on this
  machine and Windows Smart App Control blocks static npm binaries, so Chrome
  encodes H.264 through `MediaRecorder`. Chrome then writes `mdhd.duration` using
  the movie timescale value, so `ops/webm-to-mp4.mjs` repairs that field and
  rescales sample durations to the known source duration. It verifies the result
  by seeking three points and decoding pixels.

The transcoder is optional — the WebM alone plays in every modern browser.

## Honesty note

The ciphertexts in `fixture.json` are produced by Zcash's real Sapling note
encryption and carry real 512-byte Veilo envelopes, so the decryption shown is
genuine. **Those particular ciphertexts were not mined on a chain** — the fixture
is generated locally. This demonstrates the cryptography and the auction
arithmetic, not transaction broadcast.

A *different* transaction was mined and is committed under `chain-probe/`: a v4
Sapling transaction that `zcashd 6.20.0` mined into regtest block 111, carrying a
packed 512-byte Veilo bid as its memo. `crates/veilo-core/tests/chain_probe.rs`
parses it and the auditor recovers the envelope with only the published viewing
key, then verifies the commitment and opens the sealed refund address. Note that
the probe's seal is opened with a test refund key that the example prints, so this
tests the seal *codec*; it is not the third-party verification a seller-exclusion
proof would need. The probe closes the "will a node accept and mint the envelope"
question and leaves "does it work on a public network" open (see `ops/README.md`
and the top-level README).
