// @ts-check
/**
 * Second-price arithmetic for the audit page.
 *
 * This file exists because the rule used to be copy-pasted into
 * `demo/index.html` and `ops/verify-demo.mjs`. The copy agreed with itself, so
 * the check could not notice that both had drifted from the reference: the page
 * took the second element of the sorted bid list and forgot the reserve floor
 * that `crates/veilo-core/src/auction.rs` applies, so an auction with one
 * eligible bid reported no price instead of the reserve.
 *
 * Anything here must match `compute_auction_result` in that file.
 * `test/outcome.test.js` compares the two implementations directly rather than
 * trusting this comment.
 *
 * Amounts are zatoshi as JS numbers. Every amount is checked with
 * `Number.isSafeInteger` before it is used: a price that silently rounded would
 * be worse than one that threw.
 */

export const ZEC = 100_000_000;

/** Machine key -> display label. Keys are stable; labels are copy. */
export const STATUS = /** @type {const} */ ({
  noReveal: "no valid reveal",
  seller: "seller — declared",
  underCollateralised: "under-collateralised",
  belowReserve: "below reserve",
  eligible: "eligible",
});

/**
 * One colour, one meaning: green accepted, red rejected as invalid, yellow
 * rejected by a stated rule, grey excluded by design.
 *
 * @type {Record<keyof typeof STATUS, string>}
 */
export const TONE = {
  noReveal: "bad",
  seller: "neutral",
  underCollateralised: "bad",
  belowReserve: "warn",
  eligible: "ok",
};

/** @param {string} hex @returns {Uint8Array} */
export function hexToBytes(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0) {
    throw new TypeError(`expected an even-length hex string, got ${typeof hex}`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new TypeError(`not hex at offset ${i * 2}`);
    out[i] = byte;
  }
  return out;
}

/**
 * Concatenate hex records into the flat buffer `audit_range` expects:
 * `(ephemeral_key || cmu || enc_ciphertext)` repeated.
 *
 * @param {string[]} records
 * @returns {Uint8Array}
 */
export function packRecords(records) {
  const parts = records.map(hexToBytes);
  const buf = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    buf.set(part, offset);
    offset += part.length;
  }
  return buf;
}

/**
 * Decode a 40-byte reveal: `auction_id(16) || bid_zat_le(8) || nonce(16)`.
 *
 * Returns `null` for a reveal belonging to a different auction, which is a
 * normal thing to find and not an error.
 *
 * @param {string} hex 80 hex characters
 * @param {string} auctionIdHex 32 hex characters
 * @returns {{zat: string, nonce: string} | null}
 */
export function decodeReveal(hex, auctionIdHex) {
  if (typeof hex !== "string" || hex.length !== 80) return null;
  if (hex.slice(0, 32) !== auctionIdHex) return null;
  const bytes = hexToBytes(hex);
  let zat = 0n;
  for (let i = 7; i >= 0; i--) zat = (zat << 8n) | BigInt(bytes[16 + i]);
  return { zat: zat.toString(), nonce: hex.slice(48, 80) };
}

/**
 * @typedef {object} BidRow
 * @property {string} epk_bid
 * @property {number} value_zat On-chain collateral. Known to the escrow always.
 * @property {string} bid_commit
 * @property {number | null} bidZat Revealed amount, null when no reveal matched.
 * @property {boolean} [isSeller]
 * @property {number} [height] Optional: absent from the wasm record.
 * @property {number} [noteIndex] Optional: absent from the wasm record.
 */

/**
 * @param {number} value
 * @param {string} what
 * @returns {number}
 */
function assertZat(value, what) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(
      `${what} ${value} is not an exact non-negative integer; ` +
        "the auditor must not round an amount"
    );
  }
  return value;
}

/**
 * Classify one decrypted output.
 *
 * The order matters only for the label, not the price: a seller is reported as
 * the seller even if its own bid is under-collateralised, because that is the
 * interesting fact about it.
 *
 * @param {BidRow} row
 * @param {number} reserveZat
 * @returns {keyof typeof STATUS}
 */
export function classifyRow(row, reserveZat) {
  const bid = row.bidZat ?? null;
  if (bid === null) return "noReveal";
  if (row.isSeller) return "seller";
  if (row.value_zat < bid) return "underCollateralised";
  if (bid < reserveZat) return "belowReserve";
  return "eligible";
}

/**
 * Descending bid, then ascending height, then ascending note index.
 *
 * The browser's records carry no height, so when the top two bids are equal the
 * fallback is the order the outputs were supplied in. That is why
 * `resolveOutcome` reports `topTie` instead of quietly picking one: this
 * function cannot implement the documented tie-break without block data.
 *
 * @param {any} a
 * @param {any} b
 */
function compareRows(a, b) {
  if (a.bidZat !== b.bidZat) return b.bidZat - a.bidZat;
  if (a.height != null && b.height != null && a.height !== b.height) {
    return a.height - b.height;
  }
  if (a.noteIndex != null && b.noteIndex != null && a.noteIndex !== b.noteIndex) {
    return a.noteIndex - b.noteIndex;
  }
  return a.position - b.position;
}

/**
 * Apply the auction document's declared seller key.
 *
 * This is deliberately not called a proof. It marks the bid whose ephemeral key
 * the auction document names as the seller's. A public proof would require
 * opening the bid's sealed refund address, and the auditor does not hold the key
 * that opens it: the auction's refund secret belongs to the auctioneer, and
 * publishing it would expose every bidder's refund address, not just the
 * excluded one. The page says so in words; this function exists so the rule is
 * one tested function rather than two inline comparisons.
 *
 * @param {BidRow[]} rows
 * @param {string | null | undefined} declaredEpk 64 hex characters, or null
 * @returns {{rows: BidRow[], excludedCount: number, declared: string | null,
 *            basis: "auction-document"}}
 */
export function applyDeclaredSellerExclusion(rows, declaredEpk) {
  const declared = declaredEpk ?? null;
  if (declared !== null && !/^[0-9a-f]{64}$/i.test(declared)) {
    throw new TypeError("declared seller key must be 64 hex characters");
  }
  const key = declared === null ? null : declared.toLowerCase();

  let excludedCount = 0;
  const marked = rows.map((row) => {
    const isSeller = key !== null && row.epk_bid.toLowerCase() === key;
    if (isSeller) excludedCount++;
    return { ...row, isSeller };
  });

  return { rows: marked, excludedCount, declared: key, basis: "auction-document" };
}

/**
 * Winner and clearing price for a set of decrypted bids.
 *
 * `ClearingPrice = max(reserve, second-highest eligible bid)`. A single
 * eligible bidder pays the reserve; no eligible bidder means no sale. Both
 * degenerate cases are explicit here because the page used to get the first one
 * wrong.
 *
 * @param {BidRow[]} rows
 * @param {{reserveZat: number}} auction
 */
export function resolveOutcome(rows, auction) {
  const reserveZat = assertZat(auction.reserveZat, "reserve");

  const classified = rows.map((row, position) => {
    const bidZat = row.bidZat ?? null;
    assertZat(row.value_zat, `collateral at position ${position}`);
    if (bidZat !== null) assertZat(bidZat, `bid at position ${position}`);

    const status = classifyRow(row, reserveZat);
    return {
      ...row,
      bidZat,
      position,
      status,
      label: STATUS[status],
      tone: TONE[status],
    };
  });

  const effective = classified
    .filter((row) => row.status === "eligible")
    .sort(compareRows);

  if (effective.length === 0) {
    return {
      rows: classified,
      effective,
      winner: null,
      secondHighestZat: null,
      clearingPriceZat: 0,
      topTie: false,
    };
  }

  const winner = effective[0];
  const secondHighestZat = effective.length > 1 ? effective[1].bidZat : null;
  const clearingPriceZat = Math.max(reserveZat, secondHighestZat ?? 0);

  // I5: the winner must be able to pay. Mirrors AuctionError::ReserveUnreachable.
  if (winner.value_zat < clearingPriceZat) {
    throw new RangeError(
      `winner collateral ${winner.value_zat} < clearing price ${clearingPriceZat}; ` +
        "reserve is unreachable"
    );
  }

  return {
    rows: classified,
    effective,
    winner,
    secondHighestZat,
    clearingPriceZat,
    // True when the top two amounts are identical. The documented rule breaks
    // this by block height, which the browser does not have.
    topTie: effective.length > 1 && effective[0].bidZat === effective[1].bidZat,
  };
}
