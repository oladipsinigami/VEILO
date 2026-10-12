import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyBid,
  resolveBids,
  applySellerExclusion,
  computeAuctionResult,
  buildSettlementPlan,
  compareBids,
} from "../web/src/lib/auction.ts";

const ZAT = 1_000_000n;
const SELLER = "utest1seller00000000000000000000000000000000000000000000000000";

function auction(overrides = {}) {
  return {
    reserveZat: 1n * ZAT,
    hStart: 1000,
    hEnd: 1200,
    hReveal: 1300,
    sellerAddress: SELLER,
    ...overrides,
  };
}

/** Build a valid classified bid. */
function bid(height, noteIndex, collateralZat, bidZat) {
  return {
    orderKey: `${height}:${String(noteIndex).padStart(6, "0")}`,
    height,
    noteIndex,
    collateralZat: BigInt(collateralZat),
    bidZat: bidZat === undefined ? null : BigInt(bidZat),
    status: "Valid",
  };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

test("in-window notes are classified Valid before reveals resolve", () => {
  const b = classifyBid({
    height: 1100,
    noteIndex: 3,
    collateralZat: 5n * ZAT,
    revealValid: true,
    auction: auction(),
  });
  assert.equal(b.status, "Valid");
  assert.equal(b.orderKey, "1100:000003");
});

test("notes outside [H_start, H_end] are InvalidLateBlock", () => {
  const a = auction();
  for (const height of [999, 1201]) {
    const b = classifyBid({
      height,
      noteIndex: 0,
      collateralZat: 5n * ZAT,
      revealValid: true,
      auction: a,
    });
    assert.equal(b.status, "InvalidLateBlock", `height ${height}`);
  }
});

test("the deadline check wins over the solvency check for ordering hygiene", () => {
  // A late note is reported as late even when it would also fail solvency, so the
  // red-team demo of an under-collateralised bid stays semantically distinguishable.
  const b = classifyBid({
    height: 1300,
    noteIndex: 0,
    collateralZat: 1n,
    revealValid: true,
    auction: auction(),
  });
  assert.equal(b.status, "InvalidLateBlock");
  assert.equal(b.bidZat, null);
});

// ---------------------------------------------------------------------------
// Solvency
// ---------------------------------------------------------------------------

test("under-collateralised bids are excluded from pricing", () => {
  const bids = [
    bid(1100, 0, 10n * ZAT, 8n * ZAT),
    bid(1101, 0, 1n * ZAT, 9n * ZAT), // bid 9 ZEC, holds 1 ZEC -> invalid
  ];
  const reveals = new Map([
    [bids[0].orderKey, 8n * ZAT],
    [bids[1].orderKey, 9n * ZAT],
  ]);
  const resolved = resolveBids(bids, reveals);
  assert.equal(resolved[0].status, "Valid");
  assert.equal(resolved[1].status, "InvalidInsufficientCollateral");

  const result = computeAuctionResult(resolved, auction());
  assert.equal(result.winner?.orderKey, bids[0].orderKey);
  assert.equal(result.clearingPriceZat, 1n * ZAT, "falls back to reserve with one effective bid");
  assert.equal(result.invalidCount, 1);
});

test("exactly-collateralised bids are valid (>= not >)", () => {
  const b = [bid(1100, 0, 5n * ZAT, 5n * ZAT)];
  const resolved = resolveBids(b, new Map([[b[0].orderKey, 5n * ZAT]]));
  assert.equal(resolved[0].status, "Valid");
});

test("a missing reveal excludes the bid entirely", () => {
  const bids = [bid(1100, 0, 10n * ZAT)];
  const resolved = resolveBids(bids, new Map());
  assert.equal(resolved[0].status, "InvalidNoReveal");
  assert.equal(resolved[0].bidZat, null, "an unrevealed bid must not contribute an amount");
});

// ---------------------------------------------------------------------------
// Vickrey pricing
// ---------------------------------------------------------------------------

test("clearing price is the second-highest bid", () => {
  const bids = [
    bid(1100, 0, 10n * ZAT, 10n * ZAT),
    bid(1101, 0, 9n * ZAT, 9n * ZAT),
    bid(1102, 0, 5n * ZAT, 5n * ZAT),
  ];
  const reveals = new Map(bids.map((b) => [b.orderKey, b.bidZat]));
  const result = computeAuctionResult(resolveBids(bids, reveals), auction());

  assert.equal(result.winner?.orderKey, "1100:000000");
  assert.equal(result.secondHighestZat, 9n * ZAT);
  assert.equal(result.clearingPriceZat, 9n * ZAT, "winner pays the runner-up, not their own bid");
});

test("ties break deterministically on block height then note index", () => {
  const a = auction({ reserveZat: 0n });
  const mk = (h, i, amt) => [bid(h, i, 10n * ZAT, amt)];

  const t1 = [
    ...mk(1105, 0, 7n * ZAT),
    ...mk(1100, 0, 7n * ZAT),
  ];
  const t2 = [
    ...mk(1100, 0, 7n * ZAT),
    ...mk(1105, 0, 7n * ZAT),
  ];
  const run = (arr) =>
    computeAuctionResult(
      resolveBids(arr, new Map(arr.map((b) => [b.orderKey, b.bidZat]))),
      a
    ).winner?.orderKey;

  assert.equal(run(t1), "1100:000000");
  assert.equal(run(t2), "1100:000000", "input order must not change the winner");

  // Same height, different note index.
  const same = [bid(1100, 5, 10n * ZAT, 7n * ZAT), bid(1100, 2, 10n * ZAT, 7n * ZAT)];
  const w = computeAuctionResult(
    resolveBids(same, new Map(same.map((b) => [b.orderKey, b.bidZat]))),
    a
  ).winner;
  assert.equal(w?.orderKey, "1100:000002");
});

test("no bids -> no winner, everything refunded", () => {
  const result = computeAuctionResult([], auction());
  assert.equal(result.winner, null);
  assert.equal(result.clearingPriceZat, 0n);
  assert.equal(result.secondHighestZat, null);
});

test("a single bid wins at the reserve price, not at zero", () => {
  const bids = [bid(1100, 0, 10n * ZAT, 9n * ZAT)];
  const result = computeAuctionResult(
    resolveBids(bids, new Map([[bids[0].orderKey, 9n * ZAT]])),
    auction({ reserveZat: 3n * ZAT })
  );
  assert.equal(result.secondHighestZat, null);
  assert.equal(result.clearingPriceZat, 3n * ZAT);
});

test("reserve price floors the clearing price", () => {
  const bids = [bid(1100, 0, 10n * ZAT, 10n * ZAT), bid(1101, 0, 10n * ZAT, 2n * ZAT)];
  const result = computeAuctionResult(
    resolveBids(bids, new Map(bids.map((b) => [b.orderKey, b.bidZat]))),
    auction({ reserveZat: 5n * ZAT })
  );
  assert.equal(result.secondHighestZat, 2n * ZAT);
  assert.equal(result.clearingPriceZat, 5n * ZAT);
});

test("all bidders independently agree on the result", () => {
  const bids = [
    bid(1100, 0, 10n * ZAT, 10n * ZAT),
    bid(1101, 0, 8n * ZAT, 8n * ZAT),
    bid(1102, 0, 1n, 99n * ZAT), // under-collateralised
  ];
  const reveals = new Map(bids.map((b) => [b.orderKey, b.bidZat]));
  const a = auction();
  const r1 = computeAuctionResult(resolveBids(bids, reveals), a);
  const r2 = computeAuctionResult(resolveBids(bids, reveals), a);
  assert.equal(r1.winner?.orderKey, r2.winner?.orderKey);
  assert.equal(r1.clearingPriceZat, r2.clearingPriceZat);
});

// ---------------------------------------------------------------------------
// I3 — seller exclusion
// ---------------------------------------------------------------------------

test("I3: the seller cannot profit by bidding (the attack that forced Revision 2)", () => {
  // Without exclusion the seller's own 10 ZEC bid sets the clearing price at 8 ZEC,
  // which the seller captures as proceeds and is refunded for free as a "loser".
  const bids = [
    bid(1100, 0, 10n * ZAT, 8n * ZAT), // real bidder
    bid(1101, 0, 10n * ZAT, 10n * ZAT), // seller's shill
  ];
  const reveals = new Map(bids.map((b) => [b.orderKey, b.bidZat]));
  const a = auction();

  // --- naive (Revision 1) behaviour: no exclusion at all ---
  const naive = computeAuctionResult(resolveBids(bids, reveals), a);
  assert.equal(naive.winner?.orderKey, "1101:000000", "the shill wins");
  const naiveSettlement = buildSettlementPlan({
    result: naive,
    refundAddressFor: () => "utest1refund",
    sellerAddress: SELLER,
    feeZat: 0n,
    changeAddress: "utest1change",
  });
  const sellerLine = naiveSettlement.lines.find((l) => l.kind === "seller");
  assert.equal(sellerLine.amountZat, 8n * ZAT);
  // The seller also gets its own 10 ZEC collateral back minus the price it "paid",
  // so its true net outlay is negative: it was paid 8 and rebated 2.
  const selfRefund = naiveSettlement.lines.find(
    (l) => l.orderKey === "1101:000000"
  );
  assert.equal(selfRefund.amountZat, 2n * ZAT);
  const sellerNet = sellerLine.amountZat + selfRefund.amountZat - 10n * ZAT;
  assert.equal(sellerNet, 0n, "captured the winner's entire premium of 8 ZEC minus its own stake");

  // --- fixed (Revision 2): the shill is excluded with a valid proof ---
  const withProof = applySellerExclusion(resolveBids(bids, reveals), a, [
    {
      orderKey: "1101:000000",
      claimedAddress: SELLER,
      openSealedRefund: () => SELLER,
    },
  ]);
  assert.equal(withProof.excludedCount, 1);
  assert.equal(withProof.rejectedProofs.length, 0);

  const fixed = computeAuctionResult(withProof.kept, a);
  assert.equal(fixed.winner?.orderKey, "1100:000000", "the real bidder wins");
  assert.equal(fixed.secondHighestZat, null, "the shill no longer sets the price");
  assert.equal(fixed.clearingPriceZat, 1n * ZAT, "only the reserve remains");
});

test("I3: an exclusion proof that does not open to seller_UA is rejected", () => {
  const bids = [bid(1100, 0, 10n * ZAT, 10n * ZAT), bid(1101, 0, 10n * ZAT, 9n * ZAT)];
  const reveals = new Map(bids.map((b) => [b.orderKey, b.bidZat]));
  const a = auction();

  const liar = applySellerExclusion(resolveBids(bids, reveals), a, [
    {
      orderKey: "1101:000000",
      claimedAddress: SELLER, // claims the seller
      openSealedRefund: () => "utest1someoneelse", // but decrypts to someone else
    },
  ]);
  assert.deepEqual(liar.rejectedProofs, ["1101:000000"]);
  assert.equal(liar.excludedCount, 0, "a lying proof must not exclude anything");
  assert.equal(liar.kept.length, 2);

  const wrongClaim = applySellerExclusion(resolveBids(bids, reveals), a, [
    {
      orderKey: "1101:000000",
      claimedAddress: "utest1nottheseller",
      openSealedRefund: () => "utest1nottheseller",
    },
  ]);
  assert.equal(wrongClaim.excludedCount, 0);
  assert.equal(wrongClaim.rejectedProofs.length, 1);
});

test("I3: a proof whose c_refund fails to open is rejected, not fatal", () => {
  const bids = [bid(1100, 0, 10n * ZAT, 10n * ZAT)];
  const a = auction();
  const out = applySellerExclusion(resolveBids(bids, new Map([[bids[0].orderKey, 10n * ZAT]])), a, [
    {
      orderKey: "1100:000000",
      claimedAddress: SELLER,
      openSealedRefund: () => {
        throw new Error("AEAD tag mismatch");
      },
    },
  ]);
  assert.deepEqual(out.rejectedProofs, ["1100:000000"]);
  assert.equal(out.kept.length, 1);
});

// ---------------------------------------------------------------------------
// I5 — settlement accounting
// ---------------------------------------------------------------------------

test("I5: every collateral zatoshi is accounted for", () => {
  const bids = [
    bid(1100, 0, 10n * ZAT, 10n * ZAT),
    bid(1101, 0, 8n * ZAT, 8n * ZAT),
    bid(1102, 0, 6n * ZAT, 5n * ZAT),
    bid(1103, 0, 100_000n, 4n * ZAT), // 0.1 ZAT collateral vs 4 ZEC bid -> invalid
  ];
  const reveals = new Map(bids.map((b) => [b.orderKey, b.bidZat]));
  const a = auction();
  const resolved = resolveBids(bids, reveals);
  assert.equal(resolved[3].status, "InvalidInsufficientCollateral");

  const result = computeAuctionResult(resolved, a);
  const fee = 15_000n; // per-transaction ZIP-317 fee, charged to the seller

  const plan = buildSettlementPlan({
    result,
    refundAddressFor: (k) => `utest1refund-${k}`,
    sellerAddress: SELLER,
    feeZat: fee,
    changeAddress: "utest1change",
  });

  assert.equal(plan.balanced, true);
  assert.equal(plan.unfundedFeeZat, 0n);

  const total = plan.lines.reduce((s, l) => s + l.amountZat, 0n) + plan.changeZat + fee;
  assert.equal(total, result.totalCollateralZat, "no zatoshi created or destroyed");

  assert.equal(result.winner?.orderKey, "1100:000000");
  assert.equal(result.clearingPriceZat, 8n * ZAT);

  const winner = plan.lines.find((l) => l.kind === "winner");
  assert.equal(winner.amountZat, 2n * ZAT);
  const seller = plan.lines.find((l) => l.kind === "seller");
  assert.equal(seller.amountZat, 8n * ZAT - fee, "seller receives price less fee");
  assert.equal(plan.feeFromSellerZat, fee, "entire fee absorbed by seller proceeds");

  // The invalid bid is refunded in full, not clawed back: no griefing incentive.
  const loserAmounts = plan.lines.filter((l) => l.kind === "loser").map((l) => l.amountZat);
  assert.ok(loserAmounts.includes(8n * ZAT));
  assert.ok(loserAmounts.includes(6n * ZAT));

  // The invalid bid is refunded IN FULL under an explicit 'unrevealed' line, not
  // dropped. Losing a bid to the solvency rule must never cost a bidder anything.
  const unrevealed = plan.lines.find((l) => l.kind === "unrevealed");
  assert.ok(unrevealed, "under-collateralised bidder must still receive a refund line");
  assert.equal(unrevealed.amountZat, 100_000n, "full collateral returned");
  assert.equal(unrevealed.destination, "utest1refund-1103:000000");
});

test("I5: bidders receive their full collateral; only the seller bears the fee", () => {
  const bids = [bid(1100, 0, 10n * ZAT, 10n * ZAT), bid(1101, 0, 7n * ZAT, 7n * ZAT)];
  const reveals = new Map(bids.map((b) => [b.orderKey, b.bidZat]));
  const result = computeAuctionResult(resolveBids(bids, reveals), auction());
  const fee = 1_000n;
  const plan = buildSettlementPlan({
    result,
    refundAddressFor: (k) => `utest1${k}`,
    sellerAddress: SELLER,
    feeZat: fee,
    changeAddress: "utest1change",
  });

  assert.equal(plan.balanced, true);
  // winner collateral 10 ZAT, clearing price = second-highest = 7 ZAT
  const winner = plan.lines.find((l) => l.kind === "winner");
  assert.equal(winner.amountZat, 3n * ZAT, "winner receives exactly collateral minus price");
  for (const l of plan.lines.filter((x) => x.kind === "loser")) {
    assert.equal(l.amountZat, 7n * ZAT, "losers are made whole, fee-free");
  }
  assert.equal(plan.changeZat, 0n, "nothing left over once the fee is paid");
});

test("a fee larger than the whole escrow is reported as unfunded, not silently dropped", () => {
  const bids = [bid(1100, 0, 100_000n, 100_000n)]; // 0.1 ZAT escrow, one bidder
  const result = computeAuctionResult(
    resolveBids(bids, new Map([[bids[0].orderKey, 100_000n]])),
    auction({ reserveZat: 0n })
  );
  const plan = buildSettlementPlan({
    result,
    refundAddressFor: () => "utest1r",
    sellerAddress: SELLER,
    feeZat: 50_000n,
    changeAddress: "utest1change",
  });
  assert.equal(plan.balanced, false);
  assert.equal(plan.unfundedFeeZat, 50_000n);
  assert.equal(plan.changeZat, 0n);
});

test("compareBids is a strict total order", () => {
  const a = bid(1100, 0, 1n, 5n);
  const b = bid(1101, 0, 1n, 5n);
  assert.equal(compareBids(a, b) < 0, true);
  assert.equal(compareBids(b, a) > 0, true);
  assert.equal(compareBids(a, a), 0);
});