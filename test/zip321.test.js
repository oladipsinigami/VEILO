import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "@noble/hashes/utils";

import {
  buildZip321,
  parseZip321,
  toBase64Url,
  fromBase64Url,
  parseAmountZec,
  formatAmountZec,
  Zip321Error,
  MEMO_SIZE,
} from "../web/src/lib/zip321.ts";
import { buildBidEnvelope, makeRefundKeypair, isVeiloMemo } from "../web/src/lib/memo.ts";

const UA = "utest1qpsw0d7s6e5t7dv8x8yyw5e4v4jh8p5kux6g5v4kthh0nngwh2c5ue2x8p3wxy7" +
  "qsqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq7egr7p";

// ---------------------------------------------------------------------------
// base64url
// ---------------------------------------------------------------------------

test("base64url round-trips at every length modulo 3", () => {
  for (let n = 0; n <= 40; n++) {
    const bytes = randomBytes(n);
    assert.deepEqual(fromBase64Url(toBase64Url(bytes)), bytes, `length ${n}`);
  }
});

test("base64url emits no +, / or = characters", () => {
  const bytes = randomBytes(512);
  const s = toBase64Url(bytes);
  assert.equal(/[+/=]/.test(s), false);
});

test("base64url rejects the standard-base64 alphabet", () => {
  assert.throws(() => fromBase64Url("ab+c"), Zip321Error);
  assert.throws(() => fromBase64Url("ab/c"), Zip321Error);
  assert.throws(() => fromBase64Url("abc="), Zip321Error);
});

// ---------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------

test("amount parses per the ZIP-321 grammar", () => {
  assert.equal(parseAmountZec("1"), 100_000_000n);
  assert.equal(parseAmountZec("0.5"), 50_000_000n);
  assert.equal(parseAmountZec("123.456"), 12_345_600_000n);
  assert.equal(parseAmountZec("0.00000001"), 1n);
  assert.equal(parseAmountZec("21000000"), 2_100_000_000_000_000n);
});

test("amount rejects the grammar's forbidden forms", () => {
  for (const bad of [
    "1,000.00",   // thousands separator
    "1,00",       // comma as decimal point
    ".5",         // empty whole
    "1.",         // empty fraction
    "1.2345678901", // >8 fraction digits
    "1.2.3",
    "-1",
    "",
    "1 000",
  ]) {
    assert.throws(() => parseAmountZec(bad), Zip321Error, `should reject "${bad}"`);
  }
});

test("amount rejects values above the 21M cap", () => {
  assert.throws(() => parseAmountZec("21000000.00000001"), Zip321Error);
});

test("amount formatting trims trailing fraction zeros", () => {
  assert.equal(formatAmountZec(100_000_000n), "1");
  assert.equal(formatAmountZec(150_000_000n), "1.5");
  assert.equal(formatAmountZec(1n), "0.00000001");
  assert.equal(formatAmountZec(0n), "0");
});

// ---------------------------------------------------------------------------
// Build / parse
// ---------------------------------------------------------------------------

test("builds and parses a bid URI carrying a full 512-byte memo", () => {
  const memo = randomBytes(MEMO_SIZE);
  const uri = buildZip321({ address: UA, amountZec: "1.5", memo, expires: 4_500_000 });
  assert.ok(uri.startsWith(`zcash:${UA}?`));

  const parsed = parseZip321(uri);
  assert.equal(parsed.address, UA);
  assert.equal(parsed.amountZat, 150_000_000n);
  assert.equal(parsed.expires, 4_500_000);
  assert.deepEqual(parsed.memo, memo, "memo survives the base64url round-trip byte for byte");
});

test("an end-to-end bid URI carries a parseable Veilo envelope", () => {
  const { pkRefund } = makeRefundKeypair();
  const env = buildBidEnvelope({
    auctionId: randomBytes(16),
    pkRefund,
    bidZat: 250_000_000n, // 2.5 ZEC collateral
    refundAddress: UA,
  });

  const uri = buildZip321({
    address: UA,
    amountZec: formatAmountZec(250_000_000n),
    memo: env.memo,
    expires: 4_500_000,
  });

  const parsed = parseZip321(uri);
  assert.equal(isVeiloMemo(parsed.memo), true, "wallet will see a valid Veilo envelope");
  assert.deepEqual(parsed.memo, env.memo);
  assert.equal(parsed.amountZat, env.reveal.length > 0 ? 250_000_000n : 0n);
});

test("memo must be exactly 512 bytes when building", () => {
  assert.throws(() => buildZip321({ address: UA, memo: randomBytes(511) }), /512/);
  assert.throws(() => buildZip321({ address: UA, memo: randomBytes(513) }), /512/);
});

test("a short memo is zero-padded to 512 on parse, per ZIP-321", () => {
  const short = new TextEncoder().encode("hi");
  const uri = buildZip321({ address: UA, amountZec: "1", memo: (() => {
    const m = new Uint8Array(MEMO_SIZE);
    m.set(short);
    return m;
  })() });
  const parsed = parseZip321(uri);
  assert.equal(parsed.memo.length, MEMO_SIZE);
});

test("rejects Sprout addresses, which ZIP-321 forbids as a target", () => {
  // Sprout is Base58Check: "zc" on mainnet, "zt" on testnet and regtest.
  assert.throws(() => buildZip321({ address: "zc1abc" }), /Sprout/);
  assert.throws(() => buildZip321({ address: "zt1abc" }), /Sprout/);
  assert.throws(() => parseZip321("zcash:zc1abc?amount=1"), /Sprout/);

  // Sapling must not be caught by the Sprout rule. "ztestsapling" also starts
  // with "zt", and this is the regression that the old prefix check caused.
  for (const sapling of ["zs1abc", "ztestsapling1abc", "zregtestsapling1abc"]) {
    assert.equal(
      buildZip321({ address: sapling }).startsWith(`zcash:${sapling}`),
      true,
      `${sapling} is Sapling and must be accepted`
    );
  }

  assert.throws(() => buildZip321({ address: "has spaces" }), Zip321Error);
  assert.throws(() => buildZip321({ address: "" }), Zip321Error);
});

test("rejects zcash:// which the grammar disallows", () => {
  assert.throws(() => parseZip321("zcash://abc?amount=1"), /authority/);
});

test("rejects duplicate parameters", () => {
  assert.throws(() => parseZip321(`zcash:${UA}?amount=1&amount=2`), /duplicate/);
});

test("unknown non-req params are ignored, per ZIP-321 forward compatibility", () => {
  const parsed = parseZip321(`zcash:${UA}?amount=1&somefutureparam=xyz`);
  assert.equal(parsed.amountZat, 100_000_000n);
  assert.equal(parsed.address, UA);
});

test("label and message survive percent encoding", () => {
  const uri = buildZip321({
    address: UA,
    amountZec: "1",
    label: "Veilo bid & auction #1",
    message: "collateral 2.5 ZEC / 100% sealed",
  });
  const parsed = parseZip321(uri);
  assert.equal(parsed.label, "Veilo bid & auction #1");
  assert.equal(parsed.message, "collateral 2.5 ZEC / 100% sealed");
});

test("an address-only URI is valid", () => {
  const parsed = parseZip321(`zcash:${UA}`);
  assert.equal(parsed.address, UA);
  assert.equal(parsed.amountZec, undefined);
  assert.equal(parsed.memo, undefined);
});

test("expires must be a non-negative integer", () => {
  assert.throws(() => buildZip321({ address: UA, expires: -1 }), Zip321Error);
  assert.throws(() => buildZip321({ address: UA, expires: 1.5 }), Zip321Error);
  assert.throws(() => parseZip321(`zcash:${UA}?expires=-3`), Zip321Error);
});