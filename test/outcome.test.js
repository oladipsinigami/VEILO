// Tests for demo/outcome.js, the second-price arithmetic the audit page shows.
//
// Two kinds of coverage:
//   1. hand cases for the rules the page states in prose (reserve floor, seller,
//      collateral, reserve, ties), and
//   2. a differential sweep against web/src/lib/auction.ts, the TypeScript
//      reference. This is the part that would have caught the bug this module
//      was extracted to fix: the page and its old check agreed with each other
//      because one was a copy of the other.

import test from "node:test";
import assert from "node:assert/strict";

import {
  ZEC,
  STATUS,
  TONE,
  hexToBytes,
  packRecords,
  decodeReveal,
  classifyRow,
  resolveOutcome,
} from "../demo/outcome.js";
import { computeAuctionResult } from "../web/src/lib/auction.ts";

const AUCTION_ID = "00112233445566778899aabbccddeeff";
const NONCE = "f0e1d2c3b4a5968778695a4b3c2d1e0f";

/** A row in the shape the page builds from the wasm record. */
function row({ bid, collateral, isSeller = false }) {
  return {
    epk_bid: `epk-${bid}-${collateral}`,
    bid_commit: `commit-${bid}`,
    value_zat: collateral,
    bidZat: bid,
    isSeller,
  };
}

/**
 * The same auction expressed for the TypeScript reference. Heights are distinct
 * and ascending so the reference's documented tie-break is defined; tests that
 * care about ties do not run through this helper.
 */
function referenceBids(bids) {
  return bids.map((b, i) => ({
    orderKey: `1000:${String(i).padStart(6, "0")}`,
    height: 1000 + i,
    noteIndex: i,
    collateralZat: BigInt(b.collateral),
    bidZat: BigInt(b.bid),
    status: "Valid",
  }));
}

function reference(bids, reserveZat) {
  return computeAuctionResult(referenceBids(bids), {
    reserveZat: BigInt(reserveZat),
    hStart: 900,
    hEnd: 1100,
    hReveal: 1200,
    sellerAddress: "utest1seller",
  });
}

// ---------------------------------------------------------------------------
// Hand cases
// ---------------------------------------------------------------------------

test("no bids: no winner, no price", () => {
  const out = resolveOutcome([], { reserveZat: 50 * ZEC });
  assert.equal(out.winner, null);
  assert.equal(out.clearingPriceZat, 0);
  assert.equal(out.topTie, false);
});

test("one eligible bid clears at the reserve, not at nothing", () => {
  // The regression: the old page read eligible[1], which is undefined here.
  const out = resolveOutcome([row({ bid: 70 * ZEC, collateral: 70 * ZEC })], {
    reserveZat: 50 * ZEC,
  });
  assert.equal(out.winner.bidZat, 70 * ZEC);
  assert.equal(out.clearingPriceZat, 50 * ZEC);
});

test("two eligible bids clear at the second-highest", () => {
  const out = resolveOutcome(
    [
      row({ bid: 70 * ZEC, collateral: 70 * ZEC }),
      row({ bid: 60 * ZEC, collateral: 60 * ZEC }),
    ],
    { reserveZat: 50 * ZEC }
  );
  assert.equal(out.winner.bidZat, 70 * ZEC);
  assert.equal(out.secondHighestZat, 60 * ZEC);
  assert.equal(out.clearingPriceZat, 60 * ZEC);
});

test("a second bid below the reserve does not drag the price under it", () => {
  const out = resolveOutcome(
    [
      row({ bid: 70 * ZEC, collateral: 70 * ZEC }),
      row({ bid: 20 * ZEC, collateral: 20 * ZEC }),
    ],
    { reserveZat: 50 * ZEC }
  );
  assert.equal(out.winner.bidZat, 70 * ZEC);
  assert.equal(out.clearingPriceZat, 50 * ZEC);
});

test("a seller is excluded and cannot set the price", () => {
  const out = resolveOutcome(
    [
      row({ bid: 90 * ZEC, collateral: 90 * ZEC, isSeller: true }),
      row({ bid: 70 * ZEC, collateral: 70 * ZEC }),
    ],
    { reserveZat: 50 * ZEC }
  );
  assert.equal(out.winner.bidZat, 70 * ZEC);
  assert.equal(out.clearingPriceZat, 50 * ZEC);
  assert.equal(out.rows[0].status, "seller");
  assert.equal(out.rows[0].tone, "neutral");
});

test("an under-collateralised bid is excluded, not merely outbid", () => {
  const out = resolveOutcome(
    [
      row({ bid: 90 * ZEC, collateral: 20 * ZEC }),
      row({ bid: 70 * ZEC, collateral: 70 * ZEC }),
    ],
    { reserveZat: 50 * ZEC }
  );
  assert.equal(out.winner.bidZat, 70 * ZEC);
  assert.equal(out.clearingPriceZat, 50 * ZEC);
  assert.equal(out.rows[0].status, "underCollateralised");
  assert.equal(out.rows[0].tone, "bad");
});

test("a bid below the reserve cannot win", () => {
  const out = resolveOutcome([row({ bid: 40 * ZEC, collateral: 40 * ZEC })], {
    reserveZat: 50 * ZEC,
  });
  assert.equal(out.winner, null);
  assert.equal(out.clearingPriceZat, 0);
  assert.equal(out.rows[0].status, "belowReserve");
  assert.equal(out.rows[0].tone, "warn");
});

test("a bid with no valid reveal cannot win", () => {
  const out = resolveOutcome(
    [row({ bid: null, collateral: 70 * ZEC })],
    { reserveZat: 50 * ZEC }
  );
  assert.equal(out.winner, null);
  assert.equal(out.rows[0].status, "noReveal");
});

test("a tie at the top is reported, not silently resolved", () => {
  const out = resolveOutcome(
    [
      row({ bid: 70 * ZEC, collateral: 70 * ZEC }),
      row({ bid: 70 * ZEC, collateral: 70 * ZEC }),
    ],
    { reserveZat: 50 * ZEC }
  );
  assert.equal(out.topTie, true);
  assert.equal(out.clearingPriceZat, 70 * ZEC);
});

test("an amount that cannot be represented exactly is refused, not rounded", () => {
  assert.throws(
    () => resolveOutcome([row({ bid: 2 ** 53, collateral: 2 ** 53 })], { reserveZat: 1 }),
    /not an exact non-negative integer/
  );
});

test("every status has a label and a colour, and the colours mean one thing", () => {
  for (const key of Object.keys(STATUS)) {
    assert.equal(typeof STATUS[key], "string");
    assert.equal(typeof TONE[key], "string");
  }
  assert.equal(TONE.eligible, "ok");
  assert.equal(TONE.belowReserve, "warn");
  assert.equal(TONE.seller, "neutral");
  assert.equal(TONE.noReveal, "bad");
  assert.equal(TONE.underCollateralised, "bad");
});

test("classifyRow reports the seller before the collateral problem", () => {
  assert.equal(
    classifyRow({ value_zat: 1, bidZat: 2, isSeller: true }, 0),
    "seller"
  );
});

// ---------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------

test("hexToBytes decodes and rejects malformed input", () => {
  assert.deepEqual([...hexToBytes("00ff10")], [0x00, 0xff, 0x10]);
  assert.throws(() => hexToBytes("abc"), TypeError);
  assert.throws(() => hexToBytes("zz"), TypeError);
});

test("packRecords concatenates in order", () => {
  assert.deepEqual([...packRecords(["aabb", "cc"])], [0xaa, 0xbb, 0xcc]);
});

test("decodeReveal round-trips a 40-byte reveal", () => {
  const zat = 6_000_000_000n;
  let n = zat;
  let le = "";
  for (let i = 0; i < 8; i++) {
    le += Number(n & 0xffn).toString(16).padStart(2, "0");
    n >>= 8n;
  }
  const hex = AUCTION_ID + le + NONCE;

  assert.deepEqual(decodeReveal(hex, AUCTION_ID), {
    zat: zat.toString(),
    nonce: NONCE,
  });
});

test("decodeReveal ignores a reveal for another auction", () => {
  const other = "ff".repeat(16) + "00".repeat(24);
  assert.equal(decodeReveal(other, AUCTION_ID), null);
});

// ---------------------------------------------------------------------------
// Differential sweep against the TypeScript reference
// ---------------------------------------------------------------------------

test("agrees with computeAuctionResult wherever the reference returns a result", () => {
  const amounts = [100, 70, 60, 55].map((z) => z * ZEC);
  const reserves = [0, 1, 50 * ZEC, 60 * ZEC, 100 * ZEC];

  // Every subset of the four bids, against every reserve.
  const subsets = [];
  for (let mask = 0; mask < 1 << amounts.length; mask++) {
    subsets.push(amounts.filter((_, i) => mask & (1 << i)));
  }

  let compared = 0;
  let noSale = 0;

  for (const reserveZat of reserves) {
    for (const subset of subsets) {
      const bids = subset.map((bid) => ({ bid, collateral: bid }));
      const ours = resolveOutcome(
        bids.map((b) => row(b)),
        { reserveZat }
      );

      let ref;
      let refError = null;
      try {
        ref = reference(bids, reserveZat);
      } catch (e) {
        refError = e;
      }

      if (refError) {
        // The reference represents "nobody can pay the reserve" as an error.
        // The page represents it as no sale. Both mean the auction did not
        // clear, and the equivalence is asserted here rather than assumed.
        assert.match(refError.message, /reserve/i);
        assert.equal(ours.winner, null);
        assert.equal(ours.clearingPriceZat, 0);
        noSale++;
        continue;
      }

      assert.equal(
        ours.clearingPriceZat,
        Number(ref.clearingPriceZat),
        `reserve ${reserveZat}, bids ${JSON.stringify(subset)}`
      );
      assert.equal(
        ours.winner ? ours.winner.bidZat : null,
        ref.winner ? Number(ref.winner.bidZat) : null,
        `winner, reserve ${reserveZat}, bids ${JSON.stringify(subset)}`
      );
      compared++;
    }
  }

  // Guard against the sweep silently shrinking to nothing.
  assert.ok(compared > 50, `only ${compared} cases compared`);
  assert.ok(noSale > 0, "the sweep never exercised a no-sale case");
});
