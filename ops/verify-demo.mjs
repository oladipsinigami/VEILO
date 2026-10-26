// Runs demo/index.html's exact pipeline against demo/fixture.json, using the
// same wasm module and the same second-price code the browser loads.
//
// The page cannot be tested headlessly here, but its logic can: if this produces
// the stated outcome, the ABI, the JS glue, the JSON contract and the pricing
// rule all hold. What remains untested is the DOM rendering, which is the least
// likely part to be wrong.
//
// The pricing rule is imported from demo/outcome.js rather than reimplemented.
// It used to be a copy, and the copy drifted: both this file and the page took
// the second element of the sorted list and forgot the reserve floor. A test
// that restates the code cannot catch that.
//
// Exits non-zero on any mismatch, so it is safe to wire into CI.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import init, {
  audit_range,
  verify_reveal,
  memo_size,
  enc_ciphertext_size,
  compact_note_size,
} from "../demo/pkg/veilo_wasm.js";
import {
  ZEC,
  hexToBytes,
  packRecords,
  decodeReveal,
  resolveOutcome,
} from "../demo/outcome.js";

// Load the committed bundle, not a build-tree copy. When CI wants to test a
// fresh build it overwrites demo/pkg first; this check always reads whatever is
// in demo/pkg, which for the demo job is the committed bytes.
const wasmPath = fileURLToPath(new URL("../demo/pkg/veilo_wasm_bg.wasm", import.meta.url));
await init({ module_or_path: readFileSync(wasmPath) });

const wasm = { audit_range, verify_reveal, memo_size, enc_ciphertext_size, compact_note_size };

const zec = (z) => (z / ZEC).toFixed(2);

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const fx = JSON.parse(readFileSync(new URL("../demo/fixture.json", import.meta.url), "utf8"));

// --- 1. sweep, exactly as the page does ------------------------------------
const buf = packRecords(fx.outputs);

const t0 = Date.now();
const bids = JSON.parse(wasm.audit_range(hexToBytes(fx.escrow_ivk), buf));
const ms = Date.now() - t0;

console.log(`  swept ${fx.outputs.length} outputs, recovered ${bids.length} bids in ${ms} ms`);

if (bids.length !== fx.reveals.length) {
  fail(`expected ${fx.reveals.length} bids, recovered ${bids.length}`);
}

// --- 2. resolve each reveal against its on-chain commitment -----------------
const reveals = fx.reveals
  .map((r) => decodeReveal(r, fx.auction_id))
  .filter(Boolean);

const rows = bids.map((b) => {
  const epk = hexToBytes(b.epk_bid);
  const commit = hexToBytes(b.bid_commit);
  let matched = null;
  for (const r of reveals) {
    if (wasm.verify_reveal(hexToBytes(fx.auction_id), r.zat, hexToBytes(r.nonce), epk, commit)) {
      matched = r;
      break;
    }
  }
  return {
    ...b,
    bidZat: matched ? Number(matched.zat) : null,
    isSeller: b.epk_bid === fx.seller_epk_bid,
  };
});

// --- 3. classify and price, through the page's own module ------------------
const outcome = resolveOutcome(rows, { reserveZat: fx.reserve_zat });
const { winner, clearingPriceZat, effective } = outcome;

for (const r of outcome.rows) {
  console.log(
    `  ${r.epk_bid.slice(0, 10)}  bid ${String(r.bidZat ?? "?").padStart(11)} zat` +
    `  collateral ${String(r.value_zat).padStart(11)} zat  ${r.label}`
  );
}

if (!winner) fail("no winner: the fixture must yield at least one eligible bid");
console.log(`  winner: ${winner.epk_bid.slice(0, 10)}`);
console.log(`  clearing price: ${zec(clearingPriceZat)} ZEC`);

// --- 4. it must match what the fixture claims ------------------------------
if (clearingPriceZat !== fx.expected.clearing_price_zat) {
  fail(`clearing price ${clearingPriceZat} != stated ${fx.expected.clearing_price_zat}`);
}

// --- 5. the fixture must keep exercising the rules -------------------------
// The seller's bid must never be the winner and must never set the price.
if (winner.isSeller) fail("the winner must not be the seller");
if (outcome.rows.some((r) => r.isSeller && r.status === "eligible")) {
  fail("a seller bid was marked eligible");
}
// At least one bid must actually have been rejected for under-collateralisation,
// or the fixture is not exercising that rule.
if (!outcome.rows.some((r) => r.status === "underCollateralised")) {
  fail("fixture does not exercise the under-collateralised rule");
}
// At least two eligible bids, or the fixture never exercises second pricing and
// could not tell a Vickrey rule from a first-price one.
if (effective.length < 2) {
  fail(`need at least two eligible bids to exercise second pricing, got ${effective.length}`);
}
// And the top two must differ, or the fixture would also hide a tie.
if (outcome.topTie) fail("fixture has a tie at the top; it would not pin the winner");

console.log(`\n  PASS: matches stated price (${zec(clearingPriceZat)} ZEC), all invariants held`);
console.log(`  memo ${wasm.memo_size()} B, encCiphertext ${wasm.enc_ciphertext_size()} B,` +
            ` compact ${wasm.compact_note_size()} B`);
