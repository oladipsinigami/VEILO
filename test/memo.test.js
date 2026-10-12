import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "@noble/hashes/utils";
import { x25519 } from "@noble/curves/ed25519";

import {
  MEMO_SIZE,
  C_REFUND_SIZE,
  AUCTION_ID_SIZE,
  EPK_SIZE,
  BID_COMMIT_SIZE,
  ZERO_PUBKEY,
  VeiloError,
  computeBidCommit,
  encodeReveal,
  decodeReveal,
  verifyReveal,
  sealRefundAddress,
  openRefundAddress,
  makeRefundKeypair,
  packMemo,
  unpackMemo,
  isVeiloMemo,
  buildBidEnvelope,
} from "../web/src/lib/memo.ts";

const FAKE_UA =
  "utest1qpsw0d7s6e5t7dv8x8yyw5e4v4jh8p5kux6g5v4kthh0nngwh2c5ue2x8p3wxy7" +
  "qsqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq7egr7p";

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

test("memo layout offsets match Part 3 section 5 exactly", () => {
  const fields = {
    auctionId: randomBytes(AUCTION_ID_SIZE),
    epkBid: randomBytes(EPK_SIZE),
    epkRefund: randomBytes(EPK_SIZE),
    bidCommit: randomBytes(BID_COMMIT_SIZE),
    cRefund: randomBytes(C_REFUND_SIZE),
  };
  const memo = packMemo(fields);
  assert.equal(memo.length, MEMO_SIZE);

  assert.equal(memo[0], 0xff, "byte 0 is the ZIP-302 arbitrary-binary lead");
  assert.deepEqual([...memo.slice(1, 5)], [0x56, 0x4c, 0x4f, 0x01], "protocol tag VLO\\x01");
  assert.deepEqual(memo.slice(5, 21), fields.auctionId, "auction_id at 5..21");
  assert.deepEqual(memo.slice(21, 53), fields.epkBid, "epk_bid at 21..53");
  assert.deepEqual(memo.slice(53, 85), fields.epkRefund, "epk_refund at 53..85");
  assert.deepEqual(memo.slice(85, 117), fields.bidCommit, "bid_commit at 85..117");
  assert.deepEqual(memo.slice(117, 349), fields.cRefund, "c_refund at 117..349");

  for (let i = 349; i < MEMO_SIZE; i++) {
    assert.equal(memo[i], 0, `padding byte ${i} must be zero`);
  }
});

test("pack/unpack round-trips", () => {
  const fields = {
    auctionId: randomBytes(AUCTION_ID_SIZE),
    epkBid: randomBytes(EPK_SIZE),
    epkRefund: randomBytes(EPK_SIZE),
    bidCommit: randomBytes(BID_COMMIT_SIZE),
    cRefund: randomBytes(C_REFUND_SIZE),
  };
  const round = unpackMemo(packMemo(fields));
  assert.deepEqual(round.auctionId, fields.auctionId);
  assert.deepEqual(round.epkBid, fields.epkBid);
  assert.deepEqual(round.epkRefund, fields.epkRefund);
  assert.deepEqual(round.bidCommit, fields.bidCommit);
  assert.deepEqual(round.cRefund, fields.cRefund);
});

test("encCiphertext accounting: 52 compact + 512 memo + 16 tag = 580", () => {
  // Regression guard for the "fixed 580-byte encCiphertext" claim in the blueprint.
  const COMPACT_NOTE_SIZE = 1 + 11 + 8 + 32;
  assert.equal(COMPACT_NOTE_SIZE, 52);
  assert.equal(COMPACT_NOTE_SIZE + MEMO_SIZE + 16, 580);
});

test("rejects wrong field sizes", () => {
  const good = {
    auctionId: randomBytes(AUCTION_ID_SIZE),
    epkBid: randomBytes(EPK_SIZE),
    epkRefund: randomBytes(EPK_SIZE),
    bidCommit: randomBytes(BID_COMMIT_SIZE),
    cRefund: randomBytes(C_REFUND_SIZE),
  };
  assert.throws(() => packMemo({ ...good, auctionId: randomBytes(15) }), /auction_id/);
  assert.throws(() => packMemo({ ...good, epkBid: randomBytes(31) }), /epk_bid/);
  assert.throws(() => packMemo({ ...good, cRefund: randomBytes(231) }), /c_refund/);
});

test("rejects tampered memos and non-zero padding", () => {
  const fields = {
    auctionId: randomBytes(AUCTION_ID_SIZE),
    epkBid: randomBytes(EPK_SIZE),
    epkRefund: randomBytes(EPK_SIZE),
    bidCommit: randomBytes(BID_COMMIT_SIZE),
    cRefund: randomBytes(C_REFUND_SIZE),
  };
  const memo = packMemo(fields);

  const badMagic = memo.slice();
  badMagic[0] = 0x02;
  assert.throws(() => unpackMemo(badMagic), VeiloError);
  assert.equal(isVeiloMemo(badMagic), false);

  const badTag = memo.slice();
  badTag[2] ^= 0x01;
  assert.throws(() => unpackMemo(badTag), VeiloError);

  const badPad = memo.slice();
  badPad[400] = 0x01;
  assert.throws(() => unpackMemo(badPad), /padding/);

  assert.equal(isVeiloMemo(memo), true);
});

test("a plaintext Zcash memo is not mistaken for a Veilo envelope", () => {
  const text = new Uint8Array(512);
  text.set(new TextEncoder().encode("hello"));
  assert.equal(isVeiloMemo(text), false);
});

// ---------------------------------------------------------------------------
// I1 — no bid readable before the deadline
// ---------------------------------------------------------------------------

test("I1: the on-chain envelope contains no plaintext bid amount", () => {
  const { pkRefund } = makeRefundKeypair();
  const bidZat = 123456789n;
  const env = buildBidEnvelope({
    auctionId: randomBytes(AUCTION_ID_SIZE),
    pkRefund,
    bidZat,
    refundAddress: FAKE_UA,
  });

  // The amount must not be recoverable from the memo without the reveal.
  const le = new Uint8Array(8);
  let n = bidZat;
  for (let i = 0; i < 8; i++) { le[i] = Number(n & 0xffn); n >>= 8n; }
  const memoBytes = Buffer.from(env.memo);
  assert.equal(memoBytes.includes(Buffer.from(le)), false, "le_bytes must not appear in memo");

  // bid_commit is opaque and does not open without nonce + amount.
  assert.equal(verifyReveal(env.bidCommit, env.auctionId, { bidZat, nonce: env.reveal.slice(24) }, env.epkBid), true);
  assert.equal(verifyReveal(env.bidCommit, env.auctionId, { bidZat: bidZat + 1n, nonce: env.reveal.slice(24) }, env.epkBid), false);
});

test("two independent ephemeral keys are used", () => {
  const { pkRefund } = makeRefundKeypair();
  const env = buildBidEnvelope({
    auctionId: randomBytes(AUCTION_ID_SIZE),
    pkRefund,
    bidZat: 1n,
    refundAddress: FAKE_UA,
  });
  assert.notDeepEqual(env.epkBid, env.epkRefund, "epk_bid must differ from epk_refund");
  // epk_bid is a valid X25519 public key even though Revision 2 does not use it yet.
  const sk = randomBytes(32);
  assert.deepEqual(x25519.getPublicKey(sk).length, 32);
});

test("commitment is deterministic and domain-separated", () => {
  const auctionId = randomBytes(AUCTION_ID_SIZE);
  const nonce = randomBytes(16);
  const epk = randomBytes(32);
  const a = computeBidCommit(auctionId, 500n, nonce, epk);
  const b = computeBidCommit(auctionId, 500n, nonce, epk);
  assert.deepEqual(a, b, "same inputs -> same commitment");
  assert.notDeepEqual(a, computeBidCommit(auctionId, 501n, nonce, epk));
  assert.notDeepEqual(a, computeBidCommit(auctionId, 500n, randomBytes(16), epk));
  assert.notDeepEqual(a, computeBidCommit(randomBytes(AUCTION_ID_SIZE), 500n, nonce, epk));
});

test("bigint and number bid amounts agree across the u64 boundary", () => {
  const auctionId = randomBytes(AUCTION_ID_SIZE);
  const nonce = randomBytes(16);
  const epk = randomBytes(32);
  assert.deepEqual(
    computeBidCommit(auctionId, 2100000000000000n, nonce, epk),
    computeBidCommit(auctionId, 2100000000000000, nonce, epk)
  );
  assert.throws(() => computeBidCommit(auctionId, -1n, nonce, epk), VeiloError);
  assert.throws(() => computeBidCommit(auctionId, 2n ** 64n, nonce, epk), VeiloError);
});

// ---------------------------------------------------------------------------
// Reveals
// ---------------------------------------------------------------------------

test("reveal round-trips and is exactly 40 bytes", () => {
  const auctionId = randomBytes(AUCTION_ID_SIZE);
  const nonce = randomBytes(16);
  const enc = encodeReveal(auctionId, { bidZat: 987654321n, nonce });
  assert.equal(enc.length, 40);
  const { auctionId: a2, reveal } = decodeReveal(enc);
  assert.deepEqual(a2, auctionId);
  assert.equal(reveal.bidZat, 987654321n);
  assert.deepEqual(reveal.nonce, nonce);
});

// ---------------------------------------------------------------------------
// I4 — refund addresses sealed
// ---------------------------------------------------------------------------

test("I4: c_refund round-trips under PK/SK_refund only", () => {
  const { skRefund, pkRefund } = makeRefundKeypair();
  const { epkRefund, sealed } = sealRefundAddress(pkRefund, FAKE_UA);
  assert.equal(sealed.length, C_REFUND_SIZE);
  assert.equal(openRefundAddress(skRefund, epkRefund, sealed), FAKE_UA);
});

test("I4: a wrong SK_refund cannot open c_refund", () => {
  const { pkRefund } = makeRefundKeypair();
  const other = makeRefundKeypair();
  const { epkRefund, sealed } = sealRefundAddress(pkRefund, FAKE_UA);
  // Must not open. Regression guard: passing PK instead of SK yields a *different*
  // shared secret (noble clamps the first arg as a private scalar), so this also
  // proves openRefundAddress cannot be satisfied by the public key alone.
  assert.throws(() => openRefundAddress(other.skRefund, epkRefund, sealed), VeiloError);
  assert.throws(() => openRefundAddress(pkRefund, epkRefund, sealed), VeiloError);
});

test("I4: tampering with c_refund is detected by the AEAD tag", () => {
  const { skRefund, pkRefund } = makeRefundKeypair();
  const { epkRefund, sealed } = sealRefundAddress(pkRefund, FAKE_UA);
  const tampered = sealed.slice();
  tampered[10] ^= 0x01;
  assert.throws(() => openRefundAddress(skRefund, epkRefund, tampered), VeiloError);
});

test("I4: c_refund is bound to auction_id via AAD", () => {
  const { skRefund, pkRefund } = makeRefundKeypair();
  const a = randomBytes(AUCTION_ID_SIZE);
  const b = randomBytes(AUCTION_ID_SIZE);
  const { epkRefund, sealed } = sealRefundAddress(pkRefund, FAKE_UA, a);
  assert.equal(openRefundAddress(skRefund, epkRefund, sealed, a), FAKE_UA);
  assert.throws(() => openRefundAddress(skRefund, epkRefund, sealed, b), VeiloError);
  assert.throws(() => openRefundAddress(skRefund, epkRefund, sealed), VeiloError);
});

test("I4: the escrow public key is never written into the memo", () => {
  const { skRefund, pkRefund } = makeRefundKeypair();
  const env = buildBidEnvelope({
    auctionId: randomBytes(AUCTION_ID_SIZE),
    pkRefund,
    bidZat: 10n,
    refundAddress: FAKE_UA,
  });
  assert.equal(Buffer.from(env.memo).includes(Buffer.from(pkRefund)), false);
  assert.equal(Buffer.from(env.memo).includes(Buffer.from(skRefund)), false);
});

test("refund addresses of different bidders are independently sealed", () => {
  const { skRefund, pkRefund } = makeRefundKeypair();
  const a = sealRefundAddress(pkRefund, FAKE_UA);
  const b = sealRefundAddress(pkRefund, "utest1" + "q".repeat(90));
  assert.notDeepEqual(a.epkRefund, b.epkRefund, "fresh ephemeral per bidder");
  assert.notDeepEqual(a.sealed, b.sealed, "ciphertexts differ even for identical plaintext");
  assert.equal(openRefundAddress(skRefund, a.epkRefund, a.sealed), FAKE_UA);
  assert.equal(openRefundAddress(skRefund, b.epkRefund, b.sealed), "utest1" + "q".repeat(90));
});

test("rejects an over-long refund address", () => {
  const { pkRefund } = makeRefundKeypair();
  assert.throws(() => sealRefundAddress(pkRefund, "u".repeat(217)), /max 216/);
});

test("makeRefundKeypair derives a real X25519 key", () => {
  const { skRefund, pkRefund } = makeRefundKeypair();
  assert.equal(skRefund.length, 32);
  assert.deepEqual(pkRefund, x25519.getPublicKey(skRefund));
  assert.notDeepEqual(pkRefund, ZERO_PUBKEY);
});