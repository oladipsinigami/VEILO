import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { x25519 } from "@noble/curves/ed25519";

import {
  BidError,
  MAX_ZAT,
  fromHex,
  parseAuctionDoc,
  prepareBid,
  publishReveal,
  verifyTicket,
  zecToZat,
} from "../web/src/lib/bid.ts";
import {
  computeBidCommit,
  decodeReveal,
  openRefundAddress,
  unpackMemo,
} from "../web/src/lib/memo.ts";
import { parseZip321 } from "../web/src/lib/zip321.ts";

const ZEC = 100_000_000n;
const AUCTION_JSON = JSON.parse(
  readFileSync(new URL("../demo/auction.json", import.meta.url), "utf8")
);
const auction = parseAuctionDoc(AUCTION_JSON);

// The practice auction's refund secret, published in demo/README.md so tests and
// anyone reading can open the seal. This is exactly why the page warns that the
// practice auction's refunds are readable.
const TEST_REFUND_SECRET = new Uint8Array(32).fill(0x55);

const draft = (over = {}) => ({
  bidZat: 60n * ZEC,
  collateralZat: 60n * ZEC,
  refundAddress: "zregtestsapling1yuw2z0xuzpafnml99fhwz08efwn2wp637rqyerswz3f7kaljlkzzf0aynyjrvylvuye22htzvjy",
  ...over,
});

test("the practice auction file is internally consistent", () => {
  assert.equal(auction.auctionId.length, 16);
  assert.equal(auction.pkRefund.length, 32);
  assert.equal(auction.practice, true, "the bundled auction must be marked practice");
  assert.deepEqual(
    Buffer.from(auction.pkRefund).toString("hex"),
    Buffer.from(x25519.getPublicKey(TEST_REFUND_SECRET)).toString("hex"),
    "documented test secret must derive the auction's refund key"
  );
});

test("a bid becomes a 512-byte envelope with a matching commitment", () => {
  const sealed = prepareBid(auction, draft());

  assert.equal(sealed.memo.length, 512);
  const fields = unpackMemo(sealed.memo);
  assert.equal(fields.cRefund.length, 232);

  const expected = computeBidCommit(
    auction.auctionId,
    60n * ZEC,
    sealed.reveal.slice(24),
    fields.epkBid
  );
  assert.deepEqual(fields.bidCommit, expected, "commitment must open with the reveal");
});

test("the sealed refund address opens to the address the bidder entered", () => {
  const sealed = prepareBid(auction, draft());
  const fields = unpackMemo(sealed.memo);

  const opened = openRefundAddress(
    TEST_REFUND_SECRET,
    fields.epkRefund,
    fields.cRefund,
    auction.auctionId
  );
  assert.equal(opened, draft().refundAddress);
});

test("a different refund address does not open the same seal", () => {
  const sealed = prepareBid(auction, draft({ refundAddress: "zregtestsapling1other" }));
  const fields = unpackMemo(sealed.memo);
  const opened = openRefundAddress(
    TEST_REFUND_SECRET,
    fields.epkRefund,
    fields.cRefund,
    auction.auctionId
  );
  assert.equal(opened, "zregtestsapling1other");
  assert.notEqual(opened, draft().refundAddress);
});

test("the payment request carries the collateral, the escrow, and the envelope", () => {
  const sealed = prepareBid(auction, draft({ collateralZat: 70n * ZEC }));
  const parsed = parseZip321(sealed.uri);

  assert.equal(parsed.address, auction.escrowAddress);
  assert.equal(parsed.amountZat, 70n * ZEC);
  assert.deepEqual(parsed.memo, sealed.memo, "URI memo must be the exact 512 bytes");
  assert.equal(parsed.expires, auction.endsAtHeight);
  assert.equal(sealed.uri.startsWith("zcash:"), true);
});

test("the URI is a request, not a payment: no wallet is touched", () => {
  // Guards the claim on the page. If this ever stops starting with zcash:, the
  // page is no longer producing something a wallet can be asked to pay.
  const sealed = prepareBid(auction, draft());
  assert.match(sealed.uri, /^zcash:[A-Za-z0-9]+\?/);
});

test("collateral below the bid is refused before any funds move", () => {
  assert.throws(
    () => prepareBid(auction, draft({ bidZat: 61n * ZEC, collateralZat: 60n * ZEC })),
    (err) => err instanceof BidError && err.code === "UnderCollateralised"
  );
});

test("zero, negative and over-supply amounts are refused", () => {
  assert.throws(() => prepareBid(auction, draft({ bidZat: 0n })), /greater than zero/);
  assert.throws(
    () => prepareBid(auction, draft({ bidZat: -1n })),
    (err) => err instanceof BidError && err.code === "BadAmount"
  );
  assert.throws(
    () => prepareBid(auction, draft({ bidZat: MAX_ZAT + 1n, collateralZat: MAX_ZAT + 1n })),
    /21 million/
  );
});

test("a malformed refund address is refused with a reason", () => {
  for (const [address, why] of [
    ["", /required/],
    [" zregtest1abc", /whitespace/],
    ["zregtest 1abc", /alphanumeric/],
    ["a".repeat(217), /at most 216/],
  ]) {
    assert.throws(() => prepareBid(auction, draft({ refundAddress: address })), why);
  }
});

test("a Sprout escrow address is refused by the payment request", () => {
  const sprout = "zcSproutAddress00000000000000000000000000000000000000000000";
  const doc = { ...auction, escrowAddress: sprout };
  assert.throws(() => prepareBid(doc, draft()), /Sprout/);
});

test("the ticket describes the bid it came from", () => {
  const sealed = prepareBid(auction, draft());
  const t = verifyTicket(JSON.stringify(sealed.ticket));

  assert.equal(t.bidZat, 60n * ZEC);
  assert.equal(t.memo.length, 512);
  assert.deepEqual(t.memo, sealed.memo);
  assert.equal(t.created_at, sealed.ticket.created_at);
});

test("publishing a reveal yields the 40 bytes the auditor expects", () => {
  const sealed = prepareBid(auction, draft());
  const published = publishReveal(sealed.ticket);

  assert.equal(published.revealHex.length, 80);
  assert.equal(published.revealHex, sealed.revealHex);
  assert.equal(published.bidZec, "60");
  assert.equal(published.auctionId, "7665696c6f2d70726163746963653121");

  const back = decodeReveal(fromHex(published.revealHex, 40, "reveal"));
  assert.equal(back.reveal.bidZat, 60n * ZEC);
  assert.deepEqual(back.auctionId, auction.auctionId);
});

test("a ticket with an edited amount is caught, not published", () => {
  const sealed = prepareBid(auction, draft());
  const edited = { ...sealed.ticket, bid_zat: (61n * ZEC).toString() };
  assert.throws(
    () => verifyTicket(edited),
    (err) => err instanceof BidError && err.code === "BadTicket" && /edited/.test(err.message)
  );
});

test("a ticket with an edited memo is caught", () => {
  const sealed = prepareBid(auction, draft());
  const bytes = fromHex(sealed.ticket.memo, 512, "memo");
  bytes[90] ^= 0xff; // inside bid_commit (85..117)
  assert.throws(
    () => verifyTicket({ ...sealed.ticket, memo: Buffer.from(bytes).toString("hex") }),
    /different commitment/
  );
});

test("a ticket for another auction is refused", () => {
  const sealed = prepareBid(auction, draft());
  const other = parseAuctionDoc({
    ...AUCTION_JSON,
    auction_id: "00".repeat(16),
  });
  assert.throws(
    () => verifyTicket({ ...sealed.ticket, auction_id: Buffer.from(other.auctionId).toString("hex") }),
    /different auction/
  );
});

test("a ticket that is not JSON, or the wrong version, is refused", () => {
  assert.throws(() => verifyTicket("{oops"), /valid JSON/);
  assert.throws(() => verifyTicket({ ...prepareBid(auction, draft()).ticket, version: 2 }), /version/);
});

test("decimal ZEC input follows the ZIP-321 grammar", () => {
  assert.equal(zecToZat("60"), 60n * ZEC);
  assert.equal(zecToZat("60.5"), 60n * ZEC + 50_000_000n);
  assert.equal(zecToZat("0.00000001"), 1n);
  for (const bad of ["", "1,000", "60.", ".5", "60.000000001", "-1"]) {
    assert.throws(() => zecToZat(bad), (err) => err instanceof BidError && err.code === "BadAmount");
  }
});

test("the auction document rejects typos instead of defaulting", () => {
  assert.throws(() => parseAuctionDoc({ ...AUCTION_JSON, auction_id: "aa" }), /16 bytes/);
  assert.throws(() => parseAuctionDoc({ ...AUCTION_JSON, pk_refund: "zz".repeat(32) }), /not hex/);
  assert.throws(() => parseAuctionDoc({ ...AUCTION_JSON, escrow_address: "not an address" }), /Zcash address/);
  assert.throws(() => parseAuctionDoc({ ...AUCTION_JSON, reserve_zat: -1 }), /negative/);
  assert.throws(() => parseAuctionDoc(null), /JSON object/);
});

test("two bids for the same amount still differ on chain", () => {
  const a = prepareBid(auction, draft());
  const b = prepareBid(auction, draft());
  assert.notEqual(a.revealHex, b.revealHex, "fresh nonce per bid");
  assert.notEqual(a.ticket.epk_bid, b.ticket.epk_bid, "fresh bidder key per bid");
  assert.notDeepEqual(a.memo, b.memo);
});
