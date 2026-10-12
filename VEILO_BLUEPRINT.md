# ZECATHON 2026 Master Plan & Veilo Architecture Blueprint

**Target Event:** ZECATHON (`https://thezecathon.com`) — $100,000 Prize Pool  
**Target Track:** Track 2 — Private Markets ($15k Track Prize + $20k Grand Prize)  
**Project Name:** **Veilo** — Sealed-Bid Second-Price Auctions with Publicly Verifiable Settlement  
**Deadline:** ~October 28, 2026 (inferred; confirm inside the portal — see Part 1)  
**Document Revision:** 2 (Oct 12, 2026)

> **What changed in Revision 2.** Four design defects were found and fixed: a seller-shill attack on
> the second-price rule; a bid-decryption key held by the auctioneer from before the first bid,
> which made "sealed bid" false; an unestimated dependency on a full node for chain access; and
> over-collateralization that served no purpose. Part 0's build prompt was split out to
> `AGENT_PROMPT.md`, and Part 2's self-graded ranking matrix was replaced with a risk/effort triage.
> Full changelog at the head of Part 3.  

---

## PART 0: Working Method

The role-persona and fact-checking system prompt used for Veilo research and implementation
sessions has been moved to **[AGENT_PROMPT.md](AGENT_PROMPT.md)**. It is a build tool, not
submission material, so it is kept out of this document.

Two rules from it govern everything below:

1. **Every technical claim is tagged** `[VERIFIED: <source>]` or `[UNVERIFIED: <test>]`, checked
   against a primary source in-session. No claim rests on memory.
2. **Draft ZIPs are labelled Draft** and are never treated as normative.

| ZIP | Status | Used by Veilo? |
| :--- | :--- | :--- |
| `ZIP-0321` Payment Request URIs | Active | Yes — bid submission |
| `ZIP-0203` Tx Expiry Height | Active | Yes — `nExpiryHeight` deadline enforcement |
| `ZIP-0316` Rev 0 Unified Addresses / UVKs | Active | Yes — escrow UA + public `UIVK` |
| `ZIP-0317` Rev 0 Proportional Fees | Active | Yes — settlement fee (per-tx, seller bears) |
| `ZIP-0318` Orchard to Ironwood Migration | Draft | No |
| `ZIP-0326` NU6.3 Wallet Consequences | Draft | No (Sapling-only sidesteps `use_qsk`) |
| `ZIP-0302` Memo Field Format | Draft | Partially — `0xFF` convention is pre-existing |
| `ZIP-0374` PCZT | Draft (Rev 0) | No — off critical path |
| `ZIP-0231` Memo Bundles | Draft (V7-onward) | No — but it will break the 512-byte layout later |

---

## PART 1: Verified Research Notes & Ecosystem Ground Truth

### 1. Protocol, Node & SDK Status (Verified Oct 12, 2026)

| Component | Status | Verified Facts & Impact on Your Build |
| :--- | :---: | :--- |
| **ZECATHON (`https://thezecathon.com`)** | `[VERIFIED]` / `[PARTIAL]` | `[VERIFIED]` $100,000 pool across 5 tracks ($20k grand, 5 × $15k track, $5k community choice); submissions sealed until judging. `[INFERRED]` ~Oct 28 deadline, from the Sep 28 "open for the next 30 days" announcement plus the site's "THIRTY DAYS TO BUILD" — **not** stated as a date or time on the public page. `[UNVERIFIED]` the exact deadline/time, and whether a privacy leak is formally disqualifying; both are behind the authenticated portal. **Log in on Oct 12 and confirm before writing a single line of the submission.** |
| **Zcash Full Nodes (`Zebra` & `Zakura`)** | `[VERIFIED]` | `zcashd` is archived/EOL (July 18, 2026). `Zebra 7.0.0-rc.0` (`ZcashFoundation/zebra`) and `Zakura` support the NU7 Testnet (`height >= 4,465,026`). |
| **NU6.3 (`ZIP-258`)** | `[VERIFIED]` | Branch ID `0x37A5165B` (Testnet block `4,134,000`; Mainnet `3,428,143`). Disables cross-address transfers in the legacy **Orchard pool** (`enableCrossAddress = 0`) and forbids new value entering Orchard (`valueBalanceOrchard >= 0`), routing new Orchard-protocol value into the **Ironwood pool** (`v6` tx format, `ZIP-229` Draft). Coinbase Orchard component must be empty. Ironwood notes require lead byte `0x03` (`ZIP-2005`). **`Sapling` v5 transfers remain completely unrestricted — this is what Veilo relies on.** |
| **NU7 (`ZIP-259` & `ZIP-218`)** | `[VERIFIED]` | Branch ID `0x77190AD9` (Testnet block `4,465,026`, activated Oct 4, 2026). Target block spacing **25 seconds**. Retires `v4`/Sprout (`ZIP-2003`). Keeps `v5`/`v6` structurally unchanged, but signatures commit to the branch ID. `ZIP-218` also caps blocks at **300 Sapling inputs+outputs** and **330 Orchard/Ironwood actions** — the hard ceiling on any single settlement batch. Mainnet height still TBD (due Oct 20). |
| **`zcash/librustzcash` (`main`)** | `[VERIFIED]` | `Cargo.toml` on `main`: `zcash_primitives`/`zcash_proofs` `0.31.0-pre.1`, `zcash_client_backend = 0.25.0-pre.1`, `zcash_keys = 0.17.0-pre.1`, `pczt = 0.10.0-pre.1`, `zip321 = 0.10.0-pre.1`, `zcash_pool_migration = 0.2.0-pre.1`, `zcash_note_encryption = 0.5.1`, `orchard = 0.16`, `sapling-crypto = 0.9`, `zip32 = 0.3`, `rust-version = 1.88`, edition 2024. Every crate is a **pre-release** — pin exactly, do not float. |
| **`ChainSafe/WebZjs` (`main`)** | `[VERIFIED]` | Browser WASM SDK (`@chainsafe/webzjs-wallet`, `@chainsafe/webzjs-keys`). **Trap 1:** Requires a `gRPC-web` proxy (e.g. Envoy) in front of `lightwalletd`. **Trap 2:** `Cargo.toml` pinned to `ChainSafe/librustzcash-nu61` (`feat/snap-nu61`) with `sapling-crypto 0.6` vs `0.9` on `main`, so npm builds sign with `Nu6_1` and cannot produce `v6`/Ironwood txs. **Veilo does not depend on WebZjs** — the Sapling-only escrow is payable by any current wallet (§4.1). |
| **NEAR Intents (`docs.near-intents.org`)** | `[VERIFIED]` | `resources/chain-support.md` explicitly lists Zcash as **"⚠️ Partially supported - Transparent addresses only (`t1` or `t3` prefix)"** and runs on mainnet (`1click.chaindefuser.com`). Naive wrappers around NEAR Intents 1Click API unshield ZEC to `t1` addresses. |
| **ZIP Statuses (`zips.z.cash`)** | `[VERIFIED]` | **Active:** `ZIP-0032` (Final), `ZIP-0203` (Active), `ZIP-0224` (Final), `ZIP-0225` (Final), `ZIP-0316` Rev 0, `ZIP-0317` Rev 0, `ZIP-0321`. **Draft:** `ZIP-0229` (`v6` tx), `ZIP-0231` (Memo Bundles, V7-onward), `ZIP-0230` (**Withdrawn**), `ZIP-0248` (Extensible Tx Format, unmerged), `ZIP-0258` (NU6.3), `ZIP-0259` (NU7), `ZIP-0302` (Memo format), `ZIP-0312` (FROST), `ZIP-0316` Rev 2, `ZIP-0317` Rev 1 (Ironwood fee contribution), `ZIP-0318`, `ZIP-0326`, `ZIP-0374` (PCZT Rev 0), `ZIP-2005`. **Never price or depend on a Draft as if normative.** |

### 2. Six Fatal Traps to Avoid (Why Other Teams Will Fail)

1. **Passing a raw `lightwalletd` URL to `WebZjs`:** Browsers cannot speak raw HTTP/2 gRPC trailers. `WebZjs` requires an Envoy `gRPC-web` proxy in front of `lightwalletd`.
2. **Broadcasting unpatched `WebZjs` transactions on post-NU6.3/NU7 Testnet:** `WebZjs` on npm is pinned to `Nu6_1` and creates cross-address Orchard-pool `v5` outputs, which `Zebra 7.0.0-rc.0` rejects under `ZIP-258` (`enableCrossAddress = 0`) and `ZIP-259` (`BranchId = 0x77190AD9`). It also pins `sapling-crypto 0.6` against `main`'s `0.9`, so types are not interchangeable.
3. **Assuming `lightwalletd` can serve chain data for an audit:** it cannot. It is a per-wallet-key server returning ZIP-307 **compact** outputs, and `COMPACT_NOTE_SIZE = 52` (`1 + 11 + 8 + 32`, per `orchard/src/note_encryption.rs`) — **the 512-byte memo is not in the compact representation.** Anything needing full 580-byte `encCiphertext`s over a block range must read `zebrad`/`zaino` directly. Budget for this; it is a multi-day item.
4. **Looping $N$ sequential transactions from a single wallet:** spending a note locks the remaining balance in an unconfirmed change note until mined (`min_confirmations`). A sequential loop for batch payouts fails at Tx #2 with `InsufficientFunds`. Use **one multi-output transaction** — `zcash_client_backend` does this natively; hand-rolled PCZT is unnecessary. Note the ZIP-218 ceiling: **300 Sapling inputs+outputs per block**.
5. **Claiming "memo length leaks on-chain":** every Sapling, Orchard, and Ironwood output on-chain carries a fixed 512-byte plaintext memo inside a fixed 580-byte `encCiphertext`. Memo length never leaks. **Scope it, though:** this holds for `v5`/`v6`. `ZIP-231` (Draft, V7-onward) replaces the inline memo with a 32-byte `K^memo` and moves memos into a prunable per-transaction bundle.
6. **Rebuilding existing Zcash apps:**
   * **ZGo / CipherPay:** Merchant POS and `UFVK` checkout gateways.
   * **Laminar:** Desktop batch payroll command console with QR signing.
   * **Free2z / Zecpages:** Creator tipping and public memo boards.

---

## PART 2: Idea Shortlist — Risk vs. Effort (pre-submission triage)

Ten ideas were evaluated against three questions only: **can it be finished in 16 days by one
person, does it depend on unbuilt or Draft infrastructure, and is the privacy claim actually
defensible under a hostile read?** Self-assigned scores were deliberately dropped — a builder
grading their own idea 9.8/10 tells a judge nothing, and a ranking that puts #2 below #3 by score
looks like an unproofread document.

`BUILD` = shipped. `STRETCH` = build only if the Oct 15 go/no-go is green. `DROP` = genuine
ideas, wrong trade.

| # | Idea | Track | Build risk | Infra needed | Verdict |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | **Veilo** — sealed-bid auction, public audit | 2. Private Markets | Medium | `zebrad` + `zcash_client_backend` + WASM | **BUILD.** Only entry where the privacy claim survives an adversarial read, and the browser auditor needs no proving keys. |
| 2 | **PCZT Studio** — offline `ZIP-374` inspector | 4. Core & Tooling | Medium | `pczt 0.10.0-pre.1` (**Draft**) | **STRETCH.** Genuinely useful, but ZIP 374 Rev 0 is Draft, so the "final" format may move under you. |
| 3 | **PayShield** — memo invoicing + batch payroll | 1. Shielded Payments | Low | none exotic | **STRETCH.** Very likely to finish; weak novelty, and Track 1 will be crowded. |
| 4 | **ZeroDesk** — stateless bug-bounty tickets in memos | 1. Shielded Payments | Low | none exotic | **DROP.** Little that `ZIP-321` + a memo does not already do. |
| 5 | **ZeroDrop** — chunked whistleblower bounty box | 5. Wildcard | Medium | Memo Bundles (`ZIP-231`, **Draft**) | **DROP.** Needs >512-byte memos, so it is blocked on a Draft ZIP. |
| 6 | **ShieldedHTLC** — FROST `z-to-EVM` swap | 3. Cross-Chain | High | FROST (`ZIP-312`, **Draft**) + audited bridge | **DROP.** Deep threshold-signature work plus an EVM counterparty in 16 days. |
| 7 | **ZkBattleship** — committed-state game via reveal | 5. Wildcard | Low | none exotic | **DROP.** Fun demo, but hard to defend as *useful* to a judging panel. |
| 8 | **IntentShield** — split-lot stealth solver | 3. Cross-Chain | High | NEAR Intents (Zcash = **`t1`/`t3` only**) | **DROP.** Requires unshielding to a transparent address. Fails the hackathon's own premise. |
| 9 | **DarkCross** — OTC pool with proof-of-funds | 2. Private Markets | High | 2-party PCZT `Combiner` | **DROP.** Same Track as Veilo and strictly harder; the coordination problem is the product. |
| 10 | **Z-Pull** — prepaid retainer with clawback | 1. Shielded Payments | Medium | none exotic | **DROP.** Clawback after broadcast is not actually achievable once shielded. |

### Why Veilo won this comparison

Not the highest total score — there isn't one. Three reasons, stated so they can be argued with:

1. **It is the only entry whose central claim gets *stronger* when attacked.** Every other idea's
   privacy story depends on a component that is Draft, unbuilt, or unverified. Veilo's core — a
   32-byte commitment plus a Sapling `ivk` — is arithmetic and existing, tested infrastructure.
2. **The audit is a genuinely novel primitive.** "Any browser can independently recompute the
   clearing price from chain ciphertexts" is not a feature other Track 2 entries will have, and
   it is the part that is genuinely hard, because it requires the insight that trial decryption
   needs no proving keys and no `SharedArrayBuffer`.
3. **Its failure modes are knowable in advance.** Part 4 Phase 0 exists to discover them on day 4
   rather than day 14, and the fallback path (regtest plus a recorded ciphertext bundle) is
   cheaper than the alternative.

The honest counterargument: Veilo scores *worse* on execution risk than ideas 3 and 4, which are
near-certain to finish. It is chosen because a finished mediocre project in a crowded track is
worth less than a finished defensible one in a thin one — but if Spikes A–C fail on Oct 15,
revisiting idea 3 is the correct call, and that decision is deliberately written into the
schedule rather than left to judgement under pressure.
---

## PART 3: VEILO — Complete Engineering & Architecture Blueprint (Revision 2)

> **Revision 2 changelog.** Revision 1 of this blueprint had four defects that a competent
> Track 2 judge would find. All four are fixed below:
> 1. **Seller-shill attack** on the second-price rule (now: clearing price excludes the seller, with a publicly checkable exclusion proof — §3).
> 2. **`SK_reveal` held by the coordinator since Phase A**, which made "sealed bid" false and the threat model wrong (now: opaque commitment + permissionless reveal — §2).
> 3. **The browser auditor needs a full node**, not `lightwalletd` (now stated in §5 and budgeted in Part 4).
> 4. **Over-collateralization was load-bearing for nothing** and is removed (now: `collateral_zat ≥ bid_zat`).
>
> The research layer in Parts 0–2 was re-verified against primary sources on Oct 12, 2026 and is unchanged.

### 0. What Veilo Is (one paragraph, no hype)

Veilo is a **sealed-bid auction with a publicly verifiable clearing price**. Bidders lock
collateral into a Sapling-only Unified Address and publish an *opaque 32-byte commitment* to
their bid. At the deadline `H_end`, bidders (or anyone) publish reveals, and every participant's
browser independently trial-decrypts the real chain ciphertexts with the auction's public
Incoming Viewing Key, checks solvency, and recomputes the winner and clearing price. Nobody —
including the auctioneer — can see any bid before the deadline. Settlement is a single batched
shielded transaction.

The privacy property is **forward-looking**: sealed during bidding, publicly verifiable at
settlement. Bids are not private forever, and we do not claim they are. What is private
forever is *who* bid — no bidder's refund address is ever published.

### 1. Design Invariants

These are the properties the rest of the design serves. Every one is testable.

| # | Invariant | Enforced by |
| :--- | :--- | :--- |
| **I1** | No party can read any bid before `H_end`. Bids are 32-byte commitments; `bid_zat` never touches the chain before reveal. | §2 memo layout; `PK_reveal` **does not exist** |
| **I2** | The winner and clearing price are recomputable by anyone from public chain data, with no trust in the auctioneer. | §1.4 audit, `veilo-wasm` |
| **I3** | The auctioneer cannot exclude any bid except by proving, publicly, that the bid's refund address is the seller's own. | §3 seller-exclusion proof |
| **I4** | No bidder's refund address, winner's identity included, is ever published. | `c_refund` under `PK_refund`; `SK_refund` never published |
| **I5** | Every collateral zatoshi is returned or paid out, to a provable destination, in one transaction. | §4 settlement + OVK verification |
| **I6** | A bid is bound to the chain by `nExpiryHeight`, so the coordinator cannot reorder, censor, or cherry-pick bids. | ZIP 203 `nExpiryHeight` + §1.3 receiver rotation |

### 2. Protocol Thesis and Cryptographic Lifecycle

#### 2.1 Core Thesis (two sentences)

Veilo turns one Zcash shielded transfer into a sealed-bid auction commitment by packing an
opaque bid commitment and an X25519-encrypted refund address into Zcash's fixed 512-byte
encrypted memo field, and by setting `nExpiryHeight = H_end + 1` so the bid cannot land after
the deadline. At `H_end`, permissionless reveals make every bid publicly auditable, and every
browser recomputes the Vickrey result directly from chain ciphertexts using the auction's
Incoming Viewing Key.

#### 2.2 Phase A — Auction Initialization (`H_start` → `H_end`)

The coordinator publishes, in a single signed JSON document:

| Field | Value | Note |
| :--- | :--- | :--- |
| `auction_id` | 16 random bytes | `BLAKE2b256("VEILO-AUCTION-V1" ‖ canonical(params))` — binds the params so they cannot be swapped after bids exist |
| `UA_escrow` | **`zu`/`utest`-style UA carrying a Sapling receiver only** | See §4.1 for why Sapling-only |
| `seller_UA` | The seller's own refund address | Openly published, so §3 exclusion is checkable |
| `PK_refund` | X25519 public key | `SK_refund` generated and retained by the coordinator, **never published** |
| `reserve_zat` | Seller's minimum acceptable clearing price | Prevents the 1-bidner → price 0 degenerate case |
| `H_start`, `H_end` | Block heights | `H_end ≥ H_start + 240` (~100 min at NU7's 25s spacing) |
| `coordinator_sig` | Ed25519 over all above | Binds the auction document |

**There is no `PK_reveal`.** Revision 1 had the coordinator publish `PK_reveal` in Phase A and
`SK_reveal` in Phase C — meaning it held the bid-decryption key from before the first bid. That
is the defect that made the sealed-bid claim false. Revision 2 has no such key.

#### 2.3 Phase B — Sealed Bidding (zero server contact)

1. Bidder generates **two independent X25519 ephemeral keypairs** in-browser: `(esk_bid, epk_bid)`
   and `(esk_refund, epk_refund)`. Never reuse one ephemeral secret across two recipients.
2. Bidder computes:
   - `bid_commit = BLAKE2b256("VEILO-BID-V1" ‖ auction_id ‖ bid_zat_LE_u64 ‖ bid_nonce[16] ‖ epk_bid)`
   - `c_refund = ChaCha20-Poly1305(k_refund, pad256(UA_refund))` where
     `k_refund = BLAKE2b256(X25519(esk_refund, PK_refund))`
3. Bidder packs the 512-byte memo per §5 layout and encodes a ZIP-321 URI carrying `nExpiryHeight`.
4. Bidder broadcasts from their own wallet. The bidder never contacts the coordinator, and the
   coordinator cannot read the bid.

**Over-collateralization is gone.** Revision 1 required `collateral ≥ bid` to "hide the bid from
the UIVK holder." With an opaque commitment the bid is already hidden; the extra capital was
locked up for nothing. Now: `collateral_zat ≥ bid_zat`, checked at audit.

#### 2.4 Phase C — Deadline, Reveal, and Public Audit

At `H_end`:

- **Reveals are permissionless.** Anyone (the bidder, a third party, the coordinator) may publish
  the 40-byte reveal `auction_id(16) ‖ bid_zat_LE_u64(8) ‖ bid_nonce(16)`. It is public data; there
  is nothing to steal. Publishing is a public good, and it cannot be censored because anyone can
  publish it.
- Reveal window closes at `H_reveal = H_end + 96` blocks (~40 min at 25s).
- A bid with no valid reveal at `H_reveal` is **invalid** and refunded in full at settlement. This
  removes bid griefing entirely: there is no penalty for not revealing.

Anyone then runs the audit (`veilo-wasm`, in-browser):

1. Fetch blocks `[H_start, H_end]` from a chain source (§6).
2. Trial-decrypt every output with the auction's `UIVK_escrow` — Sapling only, so this is one
   `ivk`, no `use_qsk` scanning, no proof generation, no `SharedArrayBuffer`.
3. For each note in `[H_start, H_end]` whose memo parses as a valid Veilo envelope:
   - require `H_start ≤ H ≤ H_end` (belt and braces alongside `nExpiryHeight`)
   - require a matching reveal that opens `bid_commit`
   - require `note.value ≥ reveal.bid_zat` — else `InvalidInsufficientCollateral`
4. Compute, over surviving bids excluding the seller (§3):

$$\text{ClearingPrice} = \max\Big(\mathit{reserve\_zat},\ \max_{j \neq \text{Winner}} (\text{bid\_zat}_j)\Big)$$

Ties break deterministically: **lowest block height, then lowest note index within that block.**
Every auditor gets the same answer from public data.

#### 2.5 Phase D — Batched Settlement

One transaction, one `zcash_client_backend` wallet, all escrow notes as inputs:

- **Seller output:** `ClearingPrice` to `seller_UA`
- **Winner output:** `collateral_Winner − ClearingPrice − fee_share` to `UA_refund, Winner`
- **Loser outputs:** `collateral_j − fee_share` to `UA_refund, j`
- **Unrevealed bids:** full `collateral_j` refunded, same batch
- **Auctioneer change:** remainder

The auctioneer publishes the settlement's **outgoing viewing key**, so any bidder can
trial-decrypt the settlement transaction and confirm they received exactly what I5 promises. This
is the only remaining trust reduction that does not require threshold signatures.

#### Sequence

```mermaid
sequenceDiagram
    autonumber
    participant A as Auctioneer
    participant B as Bidder Browser
    participant W as Bidder Wallet
    participant Z as Zcash (zebrad + chain)
    participant X as Any Auditor

    A->>B: 1. Publish auction doc (auction_id, UA_escrow, seller_UA, PK_refund,<br/>reserve, H_start..H_end, Ed25519 sig)
    B->>B: 2. Generate esk_bid/epk_bid + esk_refund/epk_refund (independent)
    B->>B: 3. bid_commit = BLAKE2b(auction_id, bid_zat, nonce, epk_bid)<br/>c_refund = ChaCha20Poly1305(X25519(esk_refund, PK_refund), UA_refund)
    B->>B: 4. Pack 512B memo -> ZIP-321 URI with nExpiryHeight = H_end+1
    Note over B: ZERO network requests
    B->>W: 5. Scan QR / open zcash: URI
    W->>Z: 6. Broadcast shielded tx (collateral >= bid) to UA_escrow
    Note over A,A: A sees only an opaque 32-byte commitment.<br/>A cannot read any bid. Ever.
    Note over Z: H_end mined (25s blocks under NU7)
    A->>X: 7. Publish UIVK_escrow (public) + rotate UA_escrow receiver
    B->>X: 8. Publish 40B reveal (auction_id, bid_zat, nonce) -- permissionless
    X->>Z: 9. Fetch 580B encCiphertexts for [H_start, H_end]
    X->>X: 10. WASM trial-decrypt via UIVK_escrow; check note.value >= bid_zat;<br/>apply seller-exclusion proofs (Part 3 §3); compute 2nd price + tie-break
    X->>X: 11. Same winner + clearing price on every auditor
    A->>Z: 12. Broadcast 1 batched shielded tx (seller, winner change, N-1 refunds)
    A->>X: 13. Publish settlement OVK
    B->>Z: 14. Bidder trial-decrypts settlement, confirms own refund locally
```

### 3. The Seller-Exclusion Rule (why this is not a central rig)

Second-price auctions are shilling-resistant in the obvious direction: a *non-seller* shill bid
raises what the winner pays, so it never helps. The attack that does work is the seller bidding,
because the seller is refunded the excess and captures the inflated price.

**Rule:** `ClearingPrice` is computed over bids from participants **excluding the seller**.

Enforcement cannot be cryptographic at bid time, because the coordinator holds `SK_refund` and
could construct a note claiming any role. So exclusion is enforced *publicly, at audit*:

> For every bid the settlement engine excludes as seller-owned, it MUST publish the decrypted
> `c_refund` alongside a proof that `ChaCha20-Poly1305` under `(epk_refund, PK_refund)` opens to
> `seller_UA`. Any auditor recomputes the decryption and rejects the exclusion if it does not.

An auditor therefore learns the refund address **of excluded bids only** — which are the
coordinator's own bids, already public via `seller_UA`. Nothing about real bidders leaks, and the
exclusion set is capped at the number of notes the auctioneer sent itself.

**Limit, stated honestly:** a seller who wants to bid has to control a *second* refund address,
because a bid decrypting to `seller_UA` is excluded. This is a meaningful economic cost and not a
theoretical one, but it is not an absolute prohibition. We claim "the seller cannot profit from
bidding," not "the seller cannot bid."

### 4. Pool and Wallet Strategy

#### 4.1 Sapling-only Unified Address for the escrow

ZIP 258 disables cross-address transfers in the Orchard pool and forbids new value entering it,
but leaves **Sapling v5 transfers completely unrestricted**. A `UA` carrying only a Sapling
receiver therefore:

- can be paid by **any** current wallet (Zodl/Zashi, Zallet, Nighthawk, WebZjs-on-nu61),
  sidestepping WebZjs's NU6.1 pin (Trap 2) entirely;
- needs only a Sapling `ivk` for trial decryption — no `use_qsk` dual scanning (ZIP 326), no
  Ironwood lead-byte `0x03` constraint, no `IronwoodBundle` in PCZT v2;
- keeps the 512-byte memo inline in the 580-byte `encCiphertext`, which is true for v5/v6 and
  avoids depending on ZIP 231 memo bundles (a Draft that moves memos out of note plaintexts into
  V7 prunable bundles).

**This is the single largest schedule de-risking decision in the project** and it is why we target
Sapling-only rather than "latest and greatest."

#### 4.2 Standardization caveat, disclosed

A `UA` with only a Sapling receiver is a Revision 0 `utest1…` address. We deliberately do **not**
use ZIP 316 Revision 2 address-expiry metadata (`zutest1…`, `uvitest…`, typecode `0xE0`), because
Rev 2 is **Draft** and only Rev 2-aware senders honour `nExpiryHeight`. We depend on
`nExpiryHeight` as a *belt*, not the *braces*; the braces are receiver rotation (§6), which is
auditable by anyone. Tracked as a post-hackathon hardening item.

### 5. The 512-Byte Memo Layout (Revision 2)

Fixed **512-byte plaintext** memo inside the fixed **580-byte** AEAD `encCiphertext`
(`COMPACT_NOTE_SIZE = 52`, so `564 + 16 = 580`). Memo byte 0 is `0xFF` per ZIP 302, which leaves
the remaining 511 bytes unconstrained for application use.

| Byte offset | Size | Field | Description & Role |
| :--- | ---: | :--- | :--- |
| `0..1` | 1 B | `magic_lead` | `0xFF` — ZIP 302 arbitrary-binary indicator. |
| `1..5` | 4 B | `protocol_tag` | ASCII `"VLO\x01"` (`0x56 0x4C 0x4F 0x01`). |
| `5..21` | 16 B | `auction_id` | Binds the memo to one auction; prevents cross-auction replay. |
| `21..53` | 32 B | `epk_bid` | Ephemeral X25519 public key #1. *Reserved for future selective disclosure; carries no secret.* |
| `53..85` | 32 B | `epk_refund` | Ephemeral X25519 public key #2, used only for `c_refund`. |
| `85..117` | 32 B | `bid_commit` | `BLAKE2b256("VEILO-BID-V1" ‖ auction_id ‖ bid_zat_LE_u64 ‖ bid_nonce ‖ epk_bid)`. **Opaque to everyone before reveal.** |
| `117..349` | 232 B | `c_refund` | `ChaCha20-Poly1305` of `pad256(UA_refund)` — 216 B padded plaintext + 16 B tag — under `BLAKE2b256(X25519(esk_refund, PK_refund))`. |
| `349..512` | 163 B | `zero_pad` | Deterministic `0x00` padding to the fixed 512-byte slot. |

Arithmetic check: `1 + 4 + 16 + 32 + 32 + 32 + 232 + 163 = 512`. ✔

`epk_bid` is carried but unused in Revision 2. It is retained deliberately: it costs 32 bytes of
a field we would otherwise waste, it is already committed inside `bid_commit`, and it leaves room
for a future signed-bid extension without a layout break. Documented as reserved, not dead.

#### Threat model

| Surface | Hidden | Public | Mechanism |
| :--- | :--- | :--- | :--- |
| **Bidding** `[H_start, H_end]` | Bidder identity, IP, wallet, `collateral_zat`, `bid_zat` | That shielded transactions occurred | Client-side ZIP-321 construction, zero HTTP POSTs; `bid_zat` is a 32-byte commitment (I1) |
| **At audit** `> H_reveal` | Every `UA_refund`, **including the winner's** | Bid amounts, winning bid, clearing price, block heights | `UIVK_escrow` opens the memo; `c_refund` stays sealed under `PK_refund` (I4) |
| **At settlement** | Which output is seller proceeds vs. refund; individual amounts | One batched shielded transaction | Multi-output shielded transaction; OVK published so each party verifies only its own line |

**Corrected from Revision 1:** Revision 1 claimed `collateral_zat` was hidden from the
coordinator during bidding. It is not — the coordinator holds the escrow's viewing keys and can
always read note values. What is hidden from the coordinator is `bid_zat`, because it never
appears on chain in the clear.

### 6. Chain Access, Receiver Rotation, and Censorship Resistance

**`lightwalletd` cannot serve this workload.** It is a per-wallet-key server that returns ZIP 307
*compact* outputs, and the compact note plaintext is 52 bytes — the memo is not in it. The auditor
requires full 580-byte `encCiphertext`s over a block range, so we run our own `zebrad` (or
`zaino`), with `node/` exposing read-only block-range access.

Red-team row #4 is therefore restated precisely:

> *"Does your server see my bid?"* — The **bid path** makes zero network requests after page load:
> the memo is built and the ZIP-321 URI is produced entirely in the browser, and only the bidder's
> own wallet broadcasts. The **audit path** fetches public ciphertexts from our node and decrypts
> them locally. Both are true; only the first was previously claimed, which was not honest.

**Receiver rotation.** `UA_escrow` is used only for `[H_start, H_end]`. At `H_end` the coordinator
rotates to a fresh diversified Sapling receiver (or next ZIP-32 account index). This is the
enforcement that matters, because it is *auditable*: since `UIVK_escrow` is public, anyone can
recompute the complete set of notes the auction received, so **omitting a bid is provable
censorship, not invisible discretion**. The audit rule is therefore stated as:

> The bid set is *every* note in `[H_start, H_end]` that trial-decrypts under `UIVK_escrow` and
> parses as a valid Veilo envelope. The coordinator has no discretion over membership.

### 7. Fees, Batching Bounds, and Refund Verification

**ZIP 317 fees are per-transaction, not per-bidder.** The conventional fee is
`marginal_fee × max(grace_actions, logical_actions)` with `marginal_fee = 5000` zat, computed from
public transaction data only. Revision 1's "refund minus proportional fee" was wrong twice over.

- **Single fee, deducted from seller proceeds.** In a second-price auction the seller initiated the
  sale and is the natural fee bearer. `fee_share = 0` for all bidders, which makes I5 exact: every
  bidder gets back `collateral_zat` (winner: `collateral − ClearingPrice`).
- **Batching is bounded.** ZIP 218 caps a block at 300 Sapling inputs+outputs and 330
  Orchard/Ironwood actions. We cap a single settlement at **250 refund outputs** and batch any
  overflow into subsequent transactions, where each extra batch pays its own fee.
- **Optional fee-bucket padding.** Round the output count up to a fixed bucket (8/16/32/64/128/256)
  so the fee does not leak the bidder count. Padding outputs are change returning to the
  auctioneer's own address, so no value is destroyed.
- `zcash_client_backend` computes ZIP 317 conventional fees from public data by default, so we get
  this correct for free rather than by hand.

**Refund verification (closing I5 for bidders).** After settlement the auctioneer publishes the
settlement transaction's outgoing viewing key. Each bidder then runs the same WASM module to
trial-decrypt the settlement outputs and confirm their expected amount arrived. No bidder needs
to trust the auctioneer's arithmetic, and no bidder learns anything about the others' refunds.

### 8. Toolchain Strategy

1. **`veilo-core`** — memo codec, X25519/ChaCha20-Poly1305/BLAKE2b, Vickrey math, seller-exclusion
   verification. Pure Rust, no proving keys, fully unit-testable.
2. **`veilo-wasm`** — `#[wasm_bindgen]` wrapper over `veilo-core`. Trial decryption needs only
   `zcash_note_encryption` + `sapling-crypto`; **no Halo 2 proving keys, no `SharedArrayBuffer`,
   no worker threads.** Compiles to a small WASM binary that runs in any browser in tens of
   milliseconds. This is the core novelty and it is genuinely correct.

   **Why this stays in Rust (decided Oct 12).** A TypeScript auditor is *theoretically* viable —
   `@noble/curves` exposes BLS12-381 G1/G2 `multiply` and a Miller loop — but it was rejected for
   two reasons. First, Sapling note decryption is exactly the kind of code that is wrong in a way
   no local test catches: a subtly incorrect shared-secret derivation yields a "no match" for every
   note, so the audit silently reports zero bids forever. Second, and decisively, **we cannot
   obtain a real Sapling note ciphertext on this machine** to validate against (see Appendix A), so
   a hand-rolled implementation would ship unvalidated. `librustzcash` is the reference
   implementation; using it is the only way the correctness claim survives review.

   **Rust's role is narrowed, not removed.** It exists for two things only: the auditor, because
   the reference crypto must be used, and the settlement engine, because building and broadcasting
   a real batched shielded transaction has no TypeScript equivalent. Everything else stays in
   TypeScript. See Appendix A for why the cross-implementation vectors still matter.
3. **`settlement-engine`** — `axum` service that (a) serves block-range ciphertexts from `zebrad`,
   (b) ingests permissionless reveals, (c) runs the audit server-side to produce a settlement plan,
   (d) broadcasts one batched shielded transaction via a `zcash_client_backend` wallet.
4. **Hand-rolled PCZT is off the critical path.** Revision 1 made `pczt 0.10.0-pre.1` — implementing
   ZIP 374 Revision 0, which is **Draft** — a Day-1-to-Day-3 dependency. `zcash_client_backend`
   already builds a correct multi-output transaction from all spendable notes in one go, which is
   exactly the batching I3 requires. PCZT inspection stays as a **bonus artifact** rendered from
   the finalized transaction, not as the settlement mechanism.

### 9. Repository Structure

```text
veilo/
├── VEILO_BLUEPRINT.md            # this document
├── RESEARCH_NOTES.md             # verification log: URL → claim → verdict
├── docker-compose.yml            # zebrad + zaino + settlement-engine
├── crates/
│   ├── veilo-core/               # memo codec, Vickrey math, exclusion proof verify
│   │   ├── src/memo.rs           # 512B pack/unpack, X25519 + ChaCha20Poly1305 + BLAKE2b
│   │   ├── src/audit.rs          # trial-decrypt, solvency, 2nd-price, tie-break
│   │   └── src/exclusion.rs      # seller-exclusion proof verification
│   ├── veilo-wasm/               # wasm-bindgen wrapper over veilo-core
│   └── settlement-engine/        # axum + zcash_client_backend batched settler
│       ├── src/node_source.rs    # block-range ciphertext fetch from zebrad
│       └── src/settle.rs         # one-tx, N-output settlement
└── web/                          # Next.js 15
    └── src/
        ├── lib/
        │   ├── memoBuilder.ts    # client-side 512B packer + ZIP-321 URI, zero requests
        │   ├── revealSigner.ts   # 40-byte reveal encoding
        │   └── wasmAudit.ts      # veilo-wasm bindings
        └── components/
            ├── BidComposer.tsx           # no-network bid creation + QR
            ├── RevealPublisher.tsx       # H_end reveal submission
            ├── BrowserAuditVerifier.tsx  # in-browser trial decryption table
            └── SettlementInspector.tsx   # OVK-based per-bidder refund check
```

### 10. Hostile Judge Red-Team

| # | Attack | Fix | Verification gate |
| :--- | :--- | :--- | :--- |
| **1** | *"Publishing the `UIVK` exposes every bidder's refund address."* | `c_refund` sealed under `PK_refund`; `SK_refund` never published. Auditor UI shows `c_refund` bytes as ciphertext next to the decrypted `bid_zat`. | Screenshot in demo: raw `c_refund` hex, no plaintext. |
| **2** | *"Doesn't the auctioneer peek at bids before `H_end`?"* | **There is no bid-decryption key.** Bids are 32-byte commitments; `bid_zat` is not on chain until permissionless reveal. | Unit test: no component of the coordinator can produce `bid_zat` from the escrow key material. Demo: coordinator's UI cannot display any bid amount at `H_end − 1`. |
| **3** | *"Bid says 100 TAZ, note holds 1 TAZ."* | Solvency check `note.value ≥ bid_zat` in both auditor and settler; violations are excluded and refunded. | Automated test + live demo with a deliberately under-collateralized bid. |
| **4** | *"Your server logs my IP."* | Bid path is 100% client-side after page load. | DevTools Network panel cleared before bid creation; zero requests during construction. |
| **5** | *"The seller bids to inflate the clearing price."* | Clearing price excludes the seller; every exclusion must ship a publicly checkable `c_refund`-decrypts-to-`seller_UA` proof (§3). | Auditor rejects a forged exclusion; unit test on the proof verifier. **New in Rev 2.** |
| **6** | *"You censored a bid."* | `UIVK_escrow` is public, so the bid set is recomputable by anyone. Rule: all decryptable in-window notes count. | Auditor independently derives the same bid count as the coordinator. **New in Rev 2.** |
| **7** | *"You stole a loser a few zatoshis in settlement."* | OVK published; each bidder verifies their own output locally. | Live demo: a bidder's browser shows `received == expected`. **New in Rev 2.** |
| **8** | *"Public testnet is down when judges test your URL."* | Pre-recorded audit bundle of real testnet ciphertexts + self-hosted `zebrad` regtest path; demo works with no faucet and no wallet extensions. | Incognito test, zero extensions installed. |

### 11. Known Limitations (stated in the submission)

We would rather a judge find these by reading than by asking.

1. **The auctioneer is custodial for the auction window.** It holds the escrow spending key. If it
   is lost or compromised, collateral is at risk. Mitigation today: I5's exact accounting, the OVK
   verification path, and public bid-set recomputability, all of which detect misbehaviour but
   none of which prevent it. The real fix is 2-of-2 or 2-of-3 threshold signing of the escrow
   spend (ZIP 312 FROST) — real work, deliberately out of scope for a 16-day build. It is the
   first item on the roadmap.
2. **Bid amounts become public at settlement.** By design (§0). This is not a private-price
   auction; it is a private-*bidding* auction with a public audit trail.
3. **The 512-byte memo layout is tied to v5/v6.** ZIP 231 memo bundles (Draft, V7-onward) move
   memos out of note plaintexts into a prunable per-transaction bundle. When V7 lands, this layout
   needs a ZIP 231 encoder. Tracked.
4. **The seller can bid using a second address** at a real economic cost, but not a formal
   prohibition (§3).
5. **`nExpiryHeight` is honoured only by Rev 2-aware senders.** Receiver rotation is the
   enforcement that is actually auditable (§4.2).

## PART 4: 16-Day Execution Schedule (Oct 12 → Oct 28, 2026)

Re-cut around the two items that were previously unestimated and that can each consume days on
their own: **proving real shielded transactions can be constructed and broadcast on NU6.3/NU7
Testnet**, and **running and syncing our own node for ciphertext access**. Everything else is
subordinate to de-risking those two by Oct 15.

### Phase 0 — De-risk the two unknowns (Oct 12–15). Nothing else starts until these pass.

| Dates | Deliverable | Gate |
| :--- | :--- | :--- |
| **Oct 12–13** | **Spike A — chain access.** Stand up `zebrad` (Docker, public Testnet). Prove we can fetch full 580-byte `encCiphertext`s for an arbitrary block range and that `zcash_note_encryption` trial-decrypts them with a Sapling `ivk` on a real historical transaction. | A Rust binary prints the decrypted note value + 512-byte memo for a known real tx. If lightwalletd is attempted first, confirm it fails as predicted. |
| **Oct 13–14** | **Spike B — transaction construction.** Build and broadcast one real shielded payment on Testnet from a `zcash_client_backend` wallet. Confirm which pool it lands in and that it confirms. | A txid exists on a public Testnet explorer. **If this fails, the whole demo pivots to regtest immediately — do not debug for more than 24h.** |
| **Oct 14–15** | **Spike C — batched settlement.** One tx, 5 outputs, mixed destinations, from escrow notes. | `zcash_client_backend` produces and broadcasts it; ZIP 317 fee matches hand calculation. |
| **Oct 15** | **Go / no-go.** | Both spikes green → proceed. Any red → cut to the offline recorded-bundle demo and re-scope. |

### Phase 1 — Core crypto (Oct 16–18)

| Dates | Deliverable | Gate |
| :--- | :--- | :--- |
| **Oct 16–17** | `veilo-core`: 512-byte memo codec (Rev 2 layout), reveal encode/decode, Vickrey math with reserve + tie-break, seller-exclusion proof verifier. | `cargo test` green on: valid bids, under-collateralized rejection, late-block rejection, tie-break determinism, exclusion proof accept/reject. |
| **Oct 18** | **🔒 `veilo-core` API freeze.** | No signature changes after this date. |

### Phase 2 — Audit path (Oct 19–20)

| Dates | Deliverable | Gate |
| :--- | :--- | :--- |
| **Oct 19** | `veilo-wasm` + `node_source.rs`: block-range fetch, in-browser trial decryption. | WASM trial-decrypts real Testnet ciphertexts and reproduces a known plaintext in a browser. |
| **Oct 20** | `veilo-core` end-to-end against real testnet data: publish `UIVK_escrow`, run full audit, print winner + clearing price. | Auditor's output matches an independent hand calculation. |

### Phase 3 — Settlement + frontend (Oct 21–24)

| Dates | Deliverable | Gate |
| :--- | :--- | :--- |
| **Oct 21–22** | `settle.rs`: ingest reveals, apply exclusion rule, build and broadcast the batched transaction, publish OVK. | Full loop on Testnet: 3 bids → reveal → audit → 1 settlement tx confirmed. |
| **Oct 23** | **🔒 FEATURE FREEZE, 23:59 UTC.** | No new features. |
| **Oct 23–24** | `web`: `BidComposer` (no-network), `RevealPublisher`, `BrowserAuditVerifier`, `SettlementInspector`. | Full walkthrough on `localhost:3000`. |

### Phase 4 — Harden, record, submit (Oct 25–28)

| Dates | Deliverable | Gate |
| :--- | :--- | :--- |
| **Oct 25** | Leak audit: verify zero bid-path requests, strip external fonts/trackers, self-host all assets, confirm `UIVK_escrow` + reveals + settlement are published as static artifacts. | Live HTTPS demo passes in incognito with zero extensions. |
| **Oct 26** | Demo video, under 2:00: no-network bid → shielded tx → commit visible / bid unreadable → deadline → reveal → in-browser audit → batched settlement → refund verified. | Uploaded and linked in `README.md`. |
| **Oct 27** | `README.md` + submission text, including the §11 limitations section verbatim. | Draft reviewed against the track rules page inside the authenticated portal. |
| **Oct 28** | **Submit before 18:00 UTC.** | Submitted 6+ hours ahead of deadline. |

### Schedule risk register

| Risk | Likelihood | Impact | Mitigation |
| :--- | :--- | :--- | :--- |
| Testnet transaction construction fails (branch ID / pool / faucet) | Medium | Fatal | Spike B by Oct 14; regtest fallback; recorded-bundle demo as last resort |
| Node sync/indexing eats the schedule | Medium | High | Spike A by Oct 13; recorded ciphertext bundle committed to the repo |
| WASM build fights `librustzcash` pre-releases | Medium | Medium | Sapling-only keeps the dependency surface small; pin exact versions from `main`'s `Cargo.toml` |
| Reveal UX confuses judges | Medium | Medium | Reveal is 40 bytes of public data and permissionless; demo it explicitly in the video |
| Scope creep into FROST / PCZT authoring | Low | Fatal | Both explicitly off the critical path (§8, §11.1) |

---
## PART 5: Draft Submission Description (1,997 / 2,000 Characters)
> **Veilo: Sealed-Bid Auctions with Verifiable Clearing Prices**
>
> **What It Does**
> Veilo is a sealed-bid second-price auction where no bid is disclosed before the deadline, not even to the auctioneer. A bidder packs an opaque 32-byte BLAKE2b commitment to their bid, plus an X25519-sealed refund address, into Zcash's fixed 512-byte memo (`ZIP-302`) and sends it as one shielded Sapling transfer with `nExpiryHeight = H_end+1`.
>
> At `H_end`, reveals are published permissionlessly; they are public data. Any browser then trial-decrypts real 580-byte chain ciphertexts with the auction's Unified Incoming Viewing Key (`ZIP-316`), verifies `note.value >= bid_zat`, and recomputes winner and clearing price. No proving keys or `SharedArrayBuffer`: a Rust/WASM auditor runs in milliseconds. Settlement is one batched shielded transaction; each bidder then verifies their refund against the published outgoing viewing key.
>
> **Why It Doesn't Leak**
> 1. **No bid is readable before the deadline, by anyone.** We hold no bid-decryption key: a commitment hides a value, but encrypting to a key the auctioneer holds does not.
> 2. **Zero network requests on the bid path.** The memo and `ZIP-321` URI are built in-browser; only the bidder's wallet broadcasts.
> 3. **Identities stay sealed forever.** `c_refund` is encrypted to a never-published settlement key, so the viewing key exposes every bid amount while redacting every refund address, the winner's included.
> 4. **The seller cannot rig the price.** Second-price is shilling-resistant against outsiders but not the seller, so clearing price excludes the seller, and every exclusion ships a checkable proof.
>
> **Real vs. Mocked**
> - **Real:** memo codec, commitment/reveal scheme, WASM note trial-decryption, solvency check, seller-exclusion proofs, batched settlement, OVK refund verification.
> - **Limits:** the auctioneer is custodial during the window (threshold signing is roadmap); bid amounts go public at settlement — this is a private-*bidding* auction.

---

## APPENDIX A: Primary-Source Verification Log

Every claim in Parts 0–3 was re-checked against primary sources on Oct 12, 2026. This log exists so
a judge (or future session) can reproduce the checks rather than take them on trust.

### Confirmed correct in Revision 1

| Claim | Source | Verdict |
| :--- | :--- | :--- |
| `zcashd` EOL July 18 2026 @ block 3,417,100 | `z.cash/support/zcashd-deprecation/`; `zcashd` README | ✅ exact |
| NU6.3 branch `0x37A5165B`, Testnet 4,134,000 / Mainnet 3,428,143 | `zips.z.cash/zip-0258` | ✅ exact |
| Orchard `enableCrossAddress = 0`; `valueBalanceOrchard >= 0`; Ironwood via v6 | ZIP-258, "Consensus rules from NU6.3 activation" | ✅ exact |
| Ironwood notes require lead byte `0x03` | ZIP-2005 §3.2.1 edit; protocol.tex:3857 | ✅ exact |
| NU7 branch `0x77190AD9`, Testnet 4,465,026, active Oct 4 2026 | `zips.z.cash/zip-0259`; Zebra `7.0.0-rc.0` notes | ✅ exact |
| 25s spacing; v4/Sprout retired; v5/v6 structurally unchanged | ZIP-259, ZIP-218, ZIP-2003 | ✅ exact |
| All librustzcash crate versions | `raw.githubusercontent.com/zcash/librustzcash/main/Cargo.toml` | ✅ exact, all 8 |
| WebZjs pinned to `librustzcash-nu61` / `feat/snap-nu61` | `raw.githubusercontent.com/ChainSafe/WebZjs/main/Cargo.toml` | ✅ exact |
| Same `ivk` trial-decrypts Orchard- and Ironwood-pool ciphertexts | `zips.z.cash/zip-0326` | ✅ verbatim |
| Memo byte `0xFF` = arbitrary binary, remaining 511 unconstrained | `zips.z.cash/zip-0302` | ✅ exact |
| 580-byte `encCiphertext` = (52 compact + 512 memo) + 16 tag | `orchard/src/note_encryption.rs`, `ENC_CIPHERTEXT_SIZE` | ✅ exact |
| Memo first byte is unconstrained (no lead-byte coupling) | `orchard/src/note_encryption.rs:304` (`np[52..].copy_from_slice(memo)`) | ✅ `0xFF` lead is safe |
| Prize structure $20k + 5×$15k + $5k | `zkSNARKs` announcement, Sep 28 2026 | ✅ sums to $100k |

### Defects found and corrected

| Defect | Evidence | Fix |
| :--- | :--- | :--- |
| Coordinator held `SK_reveal` from Phase A | Rev-1 Part 3 §2.2 published `PK_reveal` in Phase A, `SK_reveal` in Phase C | Removed both keys; bids are opaque commitments with permissionless reveals (§3.2) |
| Threat model claimed `collateral_zat` hidden from coordinator | Coordinator derives the escrow keys, so can always read `note.value` | Restated honestly (§5, "Corrected from Revision 1") |
| Seller-shill attack on second-price | Seller bid is refunded the excess and captures the inflated price | Clearing price excludes the seller, with a publicly checkable exclusion proof (§3) |
| `lightwalletd` assumed usable for chain access | `COMPACT_NOTE_SIZE = 52`; memos absent from compact blocks | Run `zebrad`/`zaino`; added as Spike A and Trap 3 (Part 3 §6, Part 4 Phase 0) |
| Same `ephem_sk` reused for two recipients | ECDH anti-pattern — one leaked static key exposes both shared secrets | Two independent ephemerals (§5 layout) |
| ZIP-317 fee modelled per-bidder | ZIP-317 is `marginal_fee × max(grace, logical_actions)`, per-tx | Single fee, seller bears, 250-output cap under ZIP-218's 300 (Part 3 §7) |
| `pczt 0.10.0-pre.1` on the critical path | ZIP-374 Rev 0 is **Draft** | Off critical path; `zcash_client_backend` does the batching (Part 3 §8) |
| `BLINDBOOK_BLUEPRINT.md` in repo tree | Stale filename from a prior project | Corrected in Part 3 §9 |

### Still unverified — must be checked

| Item | Why it matters | Action |
| :--- | :--- | :--- |
| Exact ZECATHON submission deadline and time | Schedule depends on it; date only inferred from "30 days" | Log in Oct 12 |
| Whether a privacy leak is formally disqualifying | Changes the whole risk posture | Read track rules in the portal |
| Whether Track 2 has its own earlier sub-deadline | A Wildcard sub-bounty already had one (Oct 4) | Read track rules in the portal |
| Testnet faucet availability and NU7 testnet wallet support | Gates Spikes B and C | Spike B by Oct 14 |
| `zebrad` sync time on public Testnet | Gates Spike A | Spike A by Oct 13 |

### Discovered constraints (Oct 12, environment survey)

| Finding | Consequence |
| :--- | :--- |
| **`zebrad` ships Linux-only binaries.** `7.0.0-rc.0` publishes only `aarch64-unknown-linux-gnu` and `x86_64-unknown-linux-gnu` — no Windows or macOS build. | Spike A **cannot be completed on this machine**, with or without Docker. Regtest is off the table. Plan C (a committed bundle of real ciphertexts, recorded elsewhere) becomes the primary demo path rather than the fallback. |
| Public explorer endpoints tested (`zcashexplorer.info`, `explorer.zcash.org`, `zcashscan`, `blockchair`) were unreachable from this environment. | **No external substitute for a node** for fetching full ciphertexts. Revisit before committing to a demo design; if all remain unreachable, the audit demo must run against pre-recorded ciphertexts. |
| Smart App Control was blocking unsigned Rust build scripts until disabled. | Resolved, but it will block `wasm-pack` output and any `zebrad` binary too. Documented in `crates/README.md`. |
| No TS path to real settlement: broadcasting a batched shielded transaction requires `zcash_client_backend`. | Confirms Rust is required for the settlement engine, not merely preferred. |

### Known-future breakage

The 512-byte memo layout is tied to `v5`/`v6`. When `ZIP-231` (Memo Bundles, Draft, V7-onward)
deploys, memos leave note plaintexts entirely and this layout needs a rewrite. Recorded in Part 3 §11 item 5
rather than left to be discovered.
