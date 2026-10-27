/**
 * Generate auction-math test scenarios from the TypeScript implementation.
 *
 * Mirrors test/vectors.txt but for the pricing/exclusion/settlement logic. The
 * auditor runs this in WASM while the bidder-facing tools run it in TypeScript, and
 * the two must never disagree about who won or who gets paid.
 *
 *   node test/gen-auction-vectors.mjs
 *
 * Format is dependency-free key=value so the Rust replay needs no JSON parser.
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  classifyBid,
  resolveBids,
  applySellerExclusion,
  computeAuctionResult,
  buildSettlementPlan,
} from "../web/src/lib/auction.ts";

const here = dirname(fileURLToPath(import.meta.url));

const SELLER = "utest1seller";
const REFUND = (k) => `utest1refund-${k}`;

// Each scenario: auction params, raw notes, reveal map, exclusion proofs, fee.
const scenarios = [];
const scenario = (name, cfg) => scenarios.push({ name, ...cfg });

const bid = (height, noteIndex, collateral, bidZat, opts = {}) => ({
  height,
  noteIndex,
  collateral,
  bidZat,
  revealValid: opts.revealValid ?? bidZat !== undefined,
});

// 1. Textbook second-price: winner pays the runner-up, not their own bid.
scenario("vickrey_basic", {
  reserve: 1_000_000,
  hStart: 1000,
  hEnd: 1200,
  seller: SELLER,
  fee: 15_000,
  bids: [bid(1100, 0, 10_000_000, 8_000_000), bid(1101, 0, 9_000_000, 9_000_000), bid(1102, 0, 6_000_000, 5_000_000)],
  reveals: new Map(),
  proofs: [],
});

// 2. Tie at the top: lowest block height wins regardless of input order.
scenario("tie_break_by_height", {
  reserve: 0,
  hStart: 1000,
  hEnd: 1200,
  seller: SELLER,
  fee: 0,
  bids: [bid(1105, 0, 10_000_000, 7_000_000), bid(1100, 0, 10_000_000, 7_000_000)],
  reveals: new Map(),
  proofs: [],
});

// 3. Tie on height too: note index breaks it.
scenario("tie_break_by_index", {
  reserve: 0,
  hStart: 1000,
  hEnd: 1200,
  seller: SELLER,
  fee: 0,
  bids: [bid(1100, 5, 10_000_000, 7_000_000), bid(1100, 2, 10_000_000, 7_000_000)],
  reveals: new Map(),
  proofs: [],
});

// 4. Under-collateralised and unrevealed bidders must both be refunded in full.
scenario("invalid_bids_refunded", {
  reserve: 1_000_000,
  hStart: 1000,
  hEnd: 1200,
  seller: SELLER,
  fee: 15_000,
  bids: [
    bid(1100, 0, 10_000_000, 10_000_000),
    bid(1101, 0, 8_000_000, 8_000_000),
    bid(1102, 0, 6_000_000, 5_000_000),
    bid(1103, 0, 100_000, 4_000_000), // 0.1 ZAT collateral vs 4 ZEC bid
    bid(1104, 0, 900_000, undefined),   // never reveals
  ],
  reveals: new Map(),
  proofs: [],
});

// 5. The seller shill attack, excluded by an opener the caller supplies. This
//    tests the rule and its reject paths; it is not a public proof (the opener
//    needs SK_refund). See README limitation 7.
scenario("seller_shill_excluded", {
  reserve: 1_000_000,
  hStart: 1000,
  hEnd: 1200,
  seller: SELLER,
  fee: 0,
  bids: [bid(1100, 0, 10_000_000, 8_000_000), bid(1101, 0, 10_000_000, 10_000_000)],
  reveals: new Map(),
  proofs: [{ orderKey: "1101:000000", claimed: SELLER, opened: SELLER, fails: false }],
});

// 6. Same auction, but the exclusion proof lies: c_refund decrypts to someone else.
scenario("seller_shill_proof_lying", {
  reserve: 1_000_000,
  hStart: 1000,
  hEnd: 1200,
  seller: SELLER,
  fee: 0,
  bids: [bid(1100, 0, 10_000_000, 8_000_000), bid(1101, 0, 10_000_000, 10_000_000)],
  reveals: new Map(),
  proofs: [{ orderKey: "1101:000000", claimed: SELLER, opened: "utest1someoneelse", fails: false }],
});

// 7. An exclusion proof whose c_refund cannot be opened at all.
scenario("seller_shill_proof_fails_to_open", {
  reserve: 1_000_000,
  hStart: 1000,
  hEnd: 1200,
  seller: SELLER,
  fee: 0,
  bids: [bid(1100, 0, 10_000_000, 8_000_000), bid(1101, 0, 10_000_000, 10_000_000)],
  reveals: new Map(),
  proofs: [{ orderKey: "1101:000000", claimed: SELLER, opened: null, fails: true }],
});

// 8. Reserve floors a low second bid.
scenario("reserve_floors_price", {
  reserve: 5_000_000,
  hStart: 1000,
  hEnd: 1200,
  seller: SELLER,
  fee: 0,
  bids: [bid(1100, 0, 10_000_000, 10_000_000), bid(1101, 0, 10_000_000, 2_000_000)],
  reveals: new Map(),
  proofs: [],
});

// 9. Exactly-collateralised bid is valid (>= not >).
scenario("solvency_boundary_equal", {
  reserve: 0,
  hStart: 1000,
  hEnd: 1200,
  seller: SELLER,
  fee: 0,
  bids: [bid(1100, 0, 5_000_000, 5_000_000)],
  reveals: new Map(),
  proofs: [],
});

// 10. Solvency boundary minus one zatoshi is not.
scenario("solvency_boundary_short", {
  reserve: 0,
  hStart: 1000,
  hEnd: 1200,
  seller: SELLER,
  fee: 0,
  bids: [bid(1100, 0, 5_000_000 - 1, 5_000_000)],
  reveals: new Map(),
  proofs: [],
});

// 11. A note mined after the deadline never becomes a bid.
scenario("late_block_excluded", {
  reserve: 0,
  hStart: 1000,
  hEnd: 1200,
  seller: SELLER,
  fee: 0,
  bids: [bid(1200, 0, 10_000_000, 10_000_000), bid(1201, 0, 10_000_000, 9_000_000)],
  reveals: new Map(),
  proofs: [],
});

// 12. Empty auction: everything refunded, no winner.
scenario("no_bids", {
  reserve: 1_000_000,
  hStart: 1000,
  hEnd: 1200,
  seller: SELLER,
  fee: 0,
  bids: [],
  reveals: new Map(),
  proofs: [],
});

// 13. Fee exceeds the whole escrow: must surface as unfunded, not vanish.
scenario("fee_exceeds_escrow", {
  reserve: 0,
  hStart: 1000,
  hEnd: 1200,
  seller: SELLER,
  fee: 50_000,
  bids: [bid(1100, 0, 100_000, 100_000)],
  reveals: new Map(),
  proofs: [],
});

// 14. Single bidder wins at the reserve, since second-highest is undefined.
scenario("single_bidder_reserve", {
  reserve: 3_000_000,
  hStart: 1000,
  hEnd: 1200,
  seller: SELLER,
  fee: 0,
  bids: [bid(1100, 0, 10_000_000, 9_000_000)],
  reveals: new Map(),
  proofs: [],
});

// ---------------------------------------------------------------------------
// Run each scenario through TypeScript and record the outcome.
// ---------------------------------------------------------------------------

const lines = [];
for (const s of scenarios) {
  const auction = {
    reserveZat: BigInt(s.reserve),
    hStart: s.hStart,
    hEnd: s.hEnd,
    hReveal: s.hEnd + 100,
    sellerAddress: s.seller,
  };

  let classified = s.bids.map((b) =>
    classifyBid({
      height: b.height,
      noteIndex: b.noteIndex,
      collateralZat: BigInt(b.collateral),
      revealValid: b.revealValid,
      auction,
    })
  );

  // Build the reveal map from the RAW inputs. AuditedBid does not carry
  // `revealValid` (classifyBid consumes it), so reading it back off the classified
  // bids silently produces an empty map and marks everything InvalidNoReveal.
  const revealMap = new Map();
  for (const raw of s.bids) {
    if (!raw.revealValid || raw.bidZat === undefined) continue;
    revealMap.set(`${raw.height}:${String(raw.noteIndex).padStart(6, "0")}`, BigInt(raw.bidZat));
  }
  classified = resolveBids(classified, revealMap);

  const proofList = s.proofs.map((p) => ({
    orderKey: p.orderKey,
    claimedAddress: p.claimed,
    openSealedRefund: () => {
      if (p.fails) throw new Error("AEAD tag mismatch");
      return p.opened;
    },
  }));
  const excluded = applySellerExclusion(classified, auction, proofList);
  const result = computeAuctionResult(excluded.kept, auction);
  const plan = buildSettlementPlan({
    result,
    refundAddressFor: REFUND,
    sellerAddress: s.seller,
    feeZat: BigInt(s.fee),
    changeAddress: "utest1change",
  });

  lines.push(
    [
      `scenario=${s.name}`,
      `reserve=${s.reserve}`,
      `h_start=${s.hStart}`,
      `h_end=${s.hEnd}`,
      `seller=${s.seller}`,
      `fee=${s.fee}`,
      `nbids=${classified.length}`,
      ...classified.flatMap((b, i) => [
        `bid_${i}_key=${b.orderKey}`,
        `bid_${i}_height=${b.height}`,
        `bid_${i}_index=${b.noteIndex}`,
        `bid_${i}_collateral=${b.collateralZat}`,
        `bid_${i}_status=${b.status}`,
        `bid_${i}_bid=${b.bidZat === null ? "" : b.bidZat}`,
      ]),
      `nproofs=${s.proofs.length}`,
      ...s.proofs.flatMap((p, i) => [
        `proof_${i}_key=${p.orderKey}`,
        `proof_${i}_claimed=${p.claimed}`,
        `proof_${i}_opened=${p.opened ?? ""}`,
        `proof_${i}_fails=${p.fails}`,
      ]),
      `nreveals=${revealMap.size}`,
      ...[...revealMap].map(([k, v]) => `reveal_${k}=${v}`),
      `excluded_count=${excluded.excludedCount}`,
      `rejected_proofs=${excluded.rejectedProofs.join(",")}`,
      `exp_winner=${result.winner?.orderKey ?? ""}`,
      `exp_clearing=${result.clearingPriceZat}`,
      `exp_second=${result.secondHighestZat === null ? "" : result.secondHighestZat}`,
      `exp_total=${result.totalCollateralZat}`,
      `exp_invalid=${result.invalidCount}`,
      `nlines=${plan.lines.length}`,
      ...plan.lines.map(
        (l, i) =>
          `line_${i}=${l.kind}|${l.orderKey ?? ""}|${l.destination}|${l.amountZat}`
      ),
      `exp_change=${plan.changeZat}`,
      `exp_fee_from_seller=${plan.feeFromSellerZat}`,
      `exp_unfunded=${plan.unfundedFeeZat}`,
      `exp_balanced=${plan.balanced}`,
      "",
    ].join("\n")
  );
}

const header = [
  "# Veilo auction-math scenarios, generated by test/gen-auction-vectors.mjs",
  "# from the TypeScript implementation. Replayed by crates/veilo-core/tests/replay_auction.rs.",
  "# Do not hand-edit.",
  "",
].join("\n");

const out = join(here, "auction-vectors.txt");
writeFileSync(out, header + lines.join("\n"), "utf8");
console.log(`wrote ${scenarios.length} scenarios to ${out}`);
