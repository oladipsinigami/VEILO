// Runs demo/index.html's exact pipeline against demo/fixture.json, using the
// same wasm module the browser loads.
//
// The page cannot be tested headlessly here, but its logic can: if this produces
// the stated outcome, the ABI, the JS glue and the JSON contract all hold. What
// remains untested is the DOM rendering, which is the least likely part to be
// wrong.
//
// Exits non-zero on any mismatch, so it is safe to wire into CI.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const wasm = require("/tmp/veilo-node/veilo_wasm.js");

const ZEC = 100000000;
const hexToBytes = (h) => {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
};
const zec = (z) => (z / ZEC).toFixed(2);

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const fx = JSON.parse(readFileSync(new URL("../demo/fixture.json", import.meta.url), "utf8"));

// --- 1. sweep, exactly as the page does ------------------------------------
const parts = fx.outputs.map(hexToBytes);
const buf = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
let o = 0;
for (const p of parts) { buf.set(p, o); o += p.length; }

const t0 = Date.now();
const bids = JSON.parse(wasm.audit_range(hexToBytes(fx.escrow_ivk), buf));
const ms = Date.now() - t0;

console.log(`  swept ${fx.outputs.length} outputs, recovered ${bids.length} bids in ${ms} ms`);

if (bids.length !== fx.reveals.length) {
  fail(`expected ${fx.reveals.length} bids, recovered ${bids.length}`);
}

// --- 2. resolve each reveal against its on-chain commitment -----------------
function decodeReveal(hex, idHex) {
  if (hex.slice(0, 32) !== idHex) return null;
  const b = hexToBytes(hex);
  let zat = 0n;
  for (let i = 7; i >= 0; i--) zat = (zat << 8n) | BigInt(b[16 + i]);
  return { zat: zat.toString(), nonce: hex.slice(48, 80) };
}
const reveals = fx.reveals.map((r) => decodeReveal(r, fx.auction_id)).filter(Boolean);

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
    collateral: b.value_zat,
    isSeller: b.epk_bid === fx.seller_epk_bid,
  };
});

// --- 3. classify -----------------------------------------------------------
for (const r of rows) {
  r.status =
    r.bidZat === null ? "no valid reveal"
    : r.isSeller ? "seller - excluded"
    : r.collateral < r.bidZat ? "under-collateralised"
    : r.bidZat < fx.reserve_zat ? "below reserve"
    : "eligible";
  r.eligible = r.status === "eligible";
}

// --- 4. second price -------------------------------------------------------
const eligible = rows.filter((r) => r.eligible).map((r) => r.bidZat).sort((a, b) => b - a);
if (eligible.length < 2) fail("need at least two eligible bids for a second-price auction");

const winner = rows.find((r) => r.eligible && r.bidZat === eligible[0]);
const clearing = eligible[1];

for (const r of rows) {
  console.log(
    `  ${r.epk_bid.slice(0, 10)}  bid ${String(r.bidZat ?? "?").padStart(11)} zat` +
    `  collateral ${String(r.collateral).padStart(11)} zat  ${r.status}`
  );
}
console.log(`  winner: ${winner.epk_bid.slice(0, 10)}`);
console.log(`  clearing price: ${zec(clearing)} ZEC`);

// --- 5. it must match what the fixture claims ------------------------------
if (clearing !== fx.expected.clearing_price_zat) {
  fail(`clearing price ${clearing} != stated ${fx.expected.clearing_price_zat}`);
}

// The seller's bid must never be the winner and must never set the price.
if (!winner || winner.isSeller) fail("the winner must not be the seller");
if (rows.some((r) => r.isSeller && r.eligible)) {
  fail("a seller bid was marked eligible");
}
// At least one bid must actually have been rejected for under-collateralisation,
// or the fixture is not exercising that rule.
if (!rows.some((r) => r.status === "under-collateralised")) {
  fail("fixture does not exercise the under-collateralised rule");
}

console.log(`\n  PASS: matches stated outcome (${zec(clearing)} ZEC), all invariants held`);
console.log(`  memo ${wasm.memo_size()} B, encCiphertext ${wasm.enc_ciphertext_size()} B,` +
            ` compact ${wasm.compact_note_size()} B`);
