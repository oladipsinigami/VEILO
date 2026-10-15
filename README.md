# Veilo

**Sealed-bid auctions on Zcash with a publicly verifiable clearing price — where
the auctioneer never learns a single bid.**

ZECATHON 2026 · Track 2 (Private Markets) · *work in progress, 15 Oct 2026*

---

## The problem

Every online auction has the same hole: **someone has to hold your bid.**

The auctioneer sees your number. You bid, they know your bid, and they can shade
the reserve, favour a friend, or quietly shade the competition. You cannot check
this, because checking would require trusting them.

Cryptography has a partial answer — sealed bids, commit-then-reveal — but the
trusted intermediary usually remains.

Veilo's claim is that on Zcash you can remove that intermediary entirely:

- **Bids are genuinely private.** They sit in shielded Sapling outputs. The
  auctioneer holds a *viewing* key, not a *spending* key. There is no
  bid-decryption key to peek with — it was never created.
- **The result is publicly checkable.** Anyone, offline, in a browser, recomputes
  the winner and clearing price from public chain data.

---

## How an auction runs

Alice is selling a laptop. Reserve 50 ZEC, deadline Friday.

1. **Alice publishes the auction** — auction ID, escrow address, reserve,
   deadline — and a 32-byte *incoming viewing key*. It can read the escrow. It
   cannot spend from it. Publicly available, deliberately powerless.

2. **Bob bids 70 ZEC.** His wallet packs an opaque 32-byte BLAKE2b commitment to
   his bid, plus an X25519-sealed refund address, into Zcash's 512-byte memo, and
   pays the escrow as one shielded transfer. On-chain, all anyone sees is a
   commitment — a fingerprint with no number attached.

3. **Carol bids 60.** David bids 45. Alice bids 65 on her own auction.

4. **Friday: the bids open.** Bidders publish their plaintext bids. Each must
   hash to the commitment already on-chain, so nobody can change their number
   after seeing everyone else's.

5. **Anyone verifies.** Load the auditor in a browser, give it the block range
   and Alice's viewing key. It sweeps every output, trial-decrypts what it can,
   checks each reveal against its commitment, rejects bids without sufficient
   collateral, excludes the seller's own bid, and applies second-price.

   > Seller excluded: Alice's 65 ZEC disappears.
   > Survivors: Bob 70, Carol 60, David 45.
   > **Winner: Bob. Clearing price: 60 ZEC.**

6. **Settlement** is one batched shielded transaction. Each bidder then verifies
   their own refund against the published outgoing viewing key, which exposes
   every bid amount while redacting every refund address — the winner's included.

Step 5 is the whole project. Everywhere else, if Alice says "Bob won at 60", you
take her word for it. Here you check it yourself.

---

## Try it

```bash
python3 -m http.server --directory demo 8000
# open http://localhost:8000 and press "Run the audit"
```

The browser loads a WebAssembly module, sweeps ten outputs, recovers five bids
and prints the clearing price. **No server, no network calls, no account** — the
audit runs entirely on your machine.

Expected:

```
1010101010  bid  7000000000 zat  collateral  7000000000 zat  eligible      ← winner
1111111111  bid  6000000000 zat  collateral  6000000000 zat  eligible
1212121212  bid  6500000000 zat  collateral  6500000000 zat  seller — excluded
1313131313  bid  4500000000 zat  collateral  4500000000 zat  below reserve
1414141414  bid  5500000000 zat  collateral  2000000000 zat  under-collateralised

clearing price: 60.00 ZEC
```

The third row is the one that matters. **The seller bid 65 ZEC — the
second-highest bid in the auction — and is excluded.** Without that rule the
clearing price would be 65 instead of 60. The demo is built so the anti-rig is
visible rather than asserted.

You can verify the demo yourself:

```bash
bash ops/build-wasm.sh     # rebuild the wasm module
bash ops/verify-demo.sh    # run the page's exact pipeline under Node
```

`ops/verify-demo.sh` exits non-zero if the result drifts from the stated outcome
or if any invariant breaks.

---

## What is built and verified

Everything below is implemented and covered by tests that run in CI.

| Component | Status |
| :--- | :--- |
| 512-byte memo codec, round-tripped | done, 26 unit tests |
| BLAKE2b bid commitment + 40-byte reveal | done |
| X25519-sealed refund address, open/close | done |
| Vickrey pricing, reserve, deterministic tie-break | done |
| Seller exclusion with checkable proof | done |
| Batched settlement **plan** (accounting, invariants) | done, unit-tested |
| ZIP-321 URI builder/parser | done |
| **Sapling trial-decryption of a real `encCiphertext`** | done |
| **Block-range sweep keeping only escrow bids** | done |
| **WASM browser auditor** | done, builds for `wasm32-unknown-unknown` |
| Cross-implementation vectors (Rust ↔ TypeScript, byte-identical) | done |

Test totals, all run in CI:

| Suite | Count |
| :--- | ---: |
| `veilo-core` unit (memo, auction) | 26 |
| `veilo-core` cross-implementation replay (Rust ↔ TypeScript vectors) | 6 |
| `veilo-core` audit path (`tests/sapling_audit.rs`) | 8 |
| `veilo-wasm` exports | 10 |
| TypeScript (`test/*.test.js`) | 56 |
| **total** | **106** |

CI also runs `cargo clippy -- -D warnings`, `cargo fmt --check`, and the
`wasm32-unknown-unknown` build.

### The cryptography is real

The demo ciphertexts are produced by Zcash's real Sapling note encryption
(`sapling-crypto`), carrying real Veilo envelopes packed by our own code, and
decrypted through the genuine `try_sapling_note_decryption` path. Nothing is
mocked. The auditor also rejects 52-byte *compact* ciphertexts outright rather
than treating them as "no bid" — a failure that would be indistinguishable from a
real result.

---

## What is **not** built yet

Stated plainly, because a judge should find these by reading.

1. **We have not broadcast a transaction.** The ciphertexts in the demo are real
   but were **not mined on a chain**. They prove the cryptography and the auction
   arithmetic, not transaction broadcast.

   *Why:* `zcashd` is end-of-life — every 6.20.0 binary shuts down permanently at
   block 3417100 (18 Jul 2026) and cannot support NU6.3. Its replacement,
   `Zallet` v0.1.0-beta.3, pins `zebra-state 12.0.1` while current `zebrad`
   writes format **v15**; even the nearest release (v6.3.0, Aug 10) is v13.
   Zallet opens zebrad's RocksDB read-only, so the formats must match exactly.
   This is an ecosystem gap, not something we can configure around. See
   `ops/README.md`.

2. **Settlement is a plan, not a broadcast.** The accounting is implemented and
   unit-tested — every zatoshi accounted for, refunds derived, fee charged to the
   seller — but no `zcash_client_backend` transaction is constructed or sent.
   There is no `settlement-engine` crate yet.

3. **No chain data fetcher.** The demo reads a fixture. Reading a real block
   range from `zebrad`/`zaino` is required for production and is not written.
   Note this must bypass `lightwalletd`: it serves 52-byte compact outputs,
   which contain no memo at all.

4. **No bidder-facing UI.** There is the audit page. There is no bid composer, no
   reveal publisher, no settlement inspector.

5. **Testnet is untested.** No public-network run yet. Testnet is currently
   Valar's NU7 fork, and most faucets are broken across the upgrade.

---

## Known limitations

We would rather a judge find these by reading than by asking.

1. **The auctioneer is custodial during the auction window.** It holds the
   escrow spending key. If lost or compromised, collateral is at risk. Our
   exact accounting, the OVK verification path and public recomputability all
   *detect* misbehaviour; none of them *prevent* it. The real fix is 2-of-2 or
   2-of-3 threshold signing (ZIP 312 FROST) — real work, deliberately out of
   scope for a 16-day build, and first on the roadmap.
2. **Bid amounts become public at settlement.** By design. This is not a
   private-*price* auction; it is a private-*bidding* auction with a public
   audit trail.
3. **The 512-byte memo layout is tied to v5/v6.** ZIP-231 memo bundles (Draft,
   V7-onward) move memos out of note plaintexts into a prunable per-transaction
   bundle. This layout will need a ZIP-231 encoder when V7 lands. Tracked.
4. **The seller can bid using a second address** at a real economic cost, but not
   a formal prohibition.
5. **`nExpiryHeight` is honoured only by Rev 2-aware senders.** Receiver rotation
   is the enforcement that is actually auditable.
6. **Zero headroom in the memo.** `MemoBytes` is a `Box<[u8; 512]>`; longer is
   rejected at consensus. Our envelope uses the entire field, so adding any field
   later is a breaking change, not a patch.

---

## How it fits together

```
veilo/
├── crates/
│   ├── veilo-core/            memo codec, commitment/reveal, Vickrey maths,
│   │   │                      seller exclusion, settlement planning
│   │   └── src/audit.rs       Sapling trial-decryption over chain outputs
│   └── veilo-wasm/            wasm-bindgen exports: audit_range, verify_reveal
├── web/src/lib/               TypeScript reference implementation
│   ├── memo.ts  auction.ts  zip321.ts
├── demo/                      browser auditor + fixture (works today)
│   ├── index.html  fixture.json  pkg/
├── test/                      cross-implementation vectors
└── ops/                       node tooling, CI scripts, known blockers
```

**Why both Rust and TypeScript.** The Rust crate is the reference and the thing
that ships to the browser. The TypeScript library is a second, independent
implementation. They are held byte-identical by generated vectors — a shared bug
would have to occur in two languages written from the same spec to slip through.
TypeScript cannot construct real shielded transactions anyway (that needs
`zcash_client_backend`), so Rust is required regardless.

---

## Invariants, and where they are enforced

| # | Invariant | Enforced by |
| :--- | :--- | :--- |
| I1 | A bid is unreadable before the deadline by anyone | no bid-decryption key exists; commitment is one-way |
| I2 | A bidder must collateralise their bid | `classify_bid`, `value >= bid_zat` |
| I3 | The seller's own bids never set the price | `apply_seller_exclusion`, proof published |
| I4 | The clearing price is reproducible by anyone | `compute_auction_result`, WASM auditor |
| I5 | Every zatoshi is accounted for at settlement | `build_settlement_plan` conservation check |
| I6 | Reveals cannot be changed after the deadline | `verify_reveal` recomputes the BLAKE2b commitment |

---

## Research notes

`RESEARCH_NOTES.md` is the verification log: every protocol claim traced to a
primary source, with verdicts. Several design assumptions were wrong at first
and were corrected — notably that ZIP-317's familiar 32-byte memo limit is a
*wallet* fee convention, not the consensus limit (which is 512 bytes, matching
our envelope exactly).

`VEILO_BLUEPRINT.md` is the full architecture document, including the red-team
table a hostile judge would use.

---

## Licence

MIT OR Apache-2.0.
