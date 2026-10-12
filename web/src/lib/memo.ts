/**
 * Veilo — 512-byte memo codec (Part 3 §5, Revision 2).
 *
 * This module is the single source of truth for the on-chain envelope. It runs in the
 * bidder's browser with zero network requests, and the auditor (Rust/WASM, veilo-core)
 * must produce byte-identical output. Any change here needs a matching change in
 * crates/veilo-core/src/memo.rs and a shared test vector.
 *
 * Layout (offsets are inclusive-exclusive, all little-endian):
 *
 *   0..1     1 B    magic_lead    0xFF (ZIP-302 arbitrary-binary indicator)
 *   1..5     4 B    protocol_tag  ASCII "VLO\x01"
 *   5..21   16 B    auction_id    binds the memo to exactly one auction
 *  21..53   32 B    epk_bid       ephemeral X25519 pubkey #1 (reserved; see below)
 *  53..85   32 B    epk_refund    ephemeral X25519 pubkey #2, used only for c_refund
 *  85..117  32 B    bid_commit    BLAKE2b-256 commitment to the bid amount
 * 117..349 232 B    c_refund      ChaCha20-Poly1305 sealed UA_refund + 16B tag
 * 349..512 163 B    zero_pad      deterministic 0x00
 *
 * 1 + 4 + 16 + 32 + 32 + 32 + 232 + 163 === 512
 *
 * Two independent ephemeral keypairs are used (epk_bid, epk_refund) rather than one.
 * Reusing a single X25519 secret across two recipient keys means a leak of either
 * counterparty's static key compromises both shared secrets. Cheap to avoid, so we do.
 */

import { x25519 } from "@noble/curves/ed25519";
import { chacha20poly1305 } from "@noble/ciphers/chacha";
import { blake2b } from "@noble/hashes/blake2b";
import { randomBytes } from "@noble/hashes/utils";

export const MEMO_SIZE = 512;
export const MAGIC_LEAD = 0xff;
export const PROTOCOL_TAG = new Uint8Array([0x56, 0x4c, 0x4f, 0x01]); // "VLO\x01"

export const AUCTION_ID_SIZE = 16;
export const EPK_SIZE = 32;
export const BID_COMMIT_SIZE = 32;
export const NONCE_SIZE = 16;

/** Domain separation tags. Never reuse these for anything else. */
export const BID_DOMAIN = "VEILO-BID-V1";
export const PAD_DOMAIN = "VEILO-PAD-V1";

export const ZERO_PUBKEY = new Uint8Array(32);

/** Sealed refund address field: 216 B padded plaintext + 16 B Poly1305 tag. */
export const C_REFUND_SIZE = 232;
const REFUND_PLAINTEXT_MAX = C_REFUND_SIZE - 16; // 216

/** First byte of the deterministic zero-padding region. */
export const C_REFUND_END = 5 + 16 + 32 + 32 + 32 + C_REFUND_SIZE; // 349
/** Byte offsets, exported so tests and the Rust side cannot silently disagree. */
export const OFFSETS = {
  magicLead: 0,
  protocolTag: 1,
  auctionId: 5,
  epkBid: 21,
  epkRefund: 53,
  bidCommit: 85,
  cRefund: 117,
  padding: 349,
} as const;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type VeiloErrorCode =
  | "InvalidMagic"
  | "InvalidProtocolTag"
  | "InvalidAuctionId"
  | "InvalidEpkBid"
  | "InvalidEpkRefund"
  | "InvalidCommitment"
  | "InvalidSealedRefund"
  | "RefundAddressTooLong"
  | "CommitmentMismatch"
  | "UnlockFailed"
  | "NonZeroPadding"
  | "SizeMismatch";

export class VeiloError extends Error {
  readonly code: VeiloErrorCode;
  constructor(code: VeiloErrorCode, message: string) {
    super(message);
    this.name = "VeiloError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

export function toU8a(input: ArrayBufferView | ArrayBuffer | string): Uint8Array {
  if (typeof input === "string") return new TextEncoder().encode(input);
  if (input instanceof Uint8Array) return input;
  return new Uint8Array(input as ArrayBuffer);
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function u64le(value: bigint | number): Uint8Array {
  const v = BigInt(value);
  if (v < 0n || v > 0xffffffffffffffffn) {
    throw new VeiloError("SizeMismatch", `bid_zat out of range: ${v}`);
  }
  const out = new Uint8Array(8);
  let n = v;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function readU64le(bytes: Uint8Array): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
  return v;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Canonical BLAKE2b-256 with a domain-separation prefix. */
function domainBlake2b(domain: string, ...parts: Uint8Array[]): Uint8Array {
  const d = new TextEncoder().encode(domain);
  const buf = blake2b(createBlake2bInput(d, parts), { dkLen: 32 });
  return Uint8Array.from(buf);
}

// noble's blake2b takes opts with personalization; simplest correct route is to
// hash a length-delimited concatenation ourselves so the Rust side can mirror it.
function createBlake2bInput(domain: Uint8Array, parts: Uint8Array[]): Uint8Array {
  const chunks: Uint8Array[] = [u32le(domain.length), domain];
  for (const p of parts) chunks.push(u32le(p.length), p);
  return concat(...chunks);
}

function u32le(n: number): Uint8Array {
  const out = new Uint8Array(4);
  out[0] = n & 0xff;
  out[1] = (n >>> 8) & 0xff;
  out[2] = (n >>> 16) & 0xff;
  out[3] = (n >>> 24) & 0xff;
  return out;
}

// ---------------------------------------------------------------------------
// Commitment (I1 — the bid amount never touches the chain)
// ---------------------------------------------------------------------------

export interface Reveal {
  bidZat: bigint;
  nonce: Uint8Array;
}

/**
 * bid_commit = BLAKE2b-256("VEILO-BID-V1" || auction_id || bid_zat_le || nonce || epk_bid)
 *
 * The commitment is the ONLY thing about the bid that reaches the chain before the
 * deadline. There is deliberately no bid-decryption key anywhere in the protocol.
 */
export function computeBidCommit(
  auctionId: Uint8Array,
  bidZat: bigint | number,
  nonce: Uint8Array,
  epkBid: Uint8Array
): Uint8Array {
  if (auctionId.length !== AUCTION_ID_SIZE) {
    throw new VeiloError("InvalidAuctionId", `auction_id must be ${AUCTION_ID_SIZE} bytes`);
  }
  if (nonce.length !== NONCE_SIZE) {
    throw new VeiloError("SizeMismatch", `bid nonce must be ${NONCE_SIZE} bytes`);
  }
  if (epkBid.length !== EPK_SIZE) {
    throw new VeiloError("InvalidEpkBid", `epk_bid must be ${EPK_SIZE} bytes`);
  }
  return domainBlake2b(BID_DOMAIN, auctionId, u64le(bidZat), nonce, epkBid);
}

/** Recompute a commitment from a reveal and check it against the on-chain value. */
export function verifyReveal(
  onChainCommit: Uint8Array,
  auctionId: Uint8Array,
  reveal: Reveal,
  epkBid: Uint8Array
): boolean {
  return equalBytes(onChainCommit, computeBidCommit(auctionId, reveal.bidZat, reveal.nonce, epkBid));
}

/**
 * The 40-byte permissionless reveal published at H_end:
 *   auction_id(16) || bid_zat_le_u64(8) || nonce(16)
 *
 * Pure public data. Anyone may publish it, so it cannot be censored.
 */
export function encodeReveal(auctionId: Uint8Array, reveal: Reveal): Uint8Array {
  if (auctionId.length !== AUCTION_ID_SIZE) {
    throw new VeiloError("InvalidAuctionId", `auction_id must be ${AUCTION_ID_SIZE} bytes`);
  }
  if (reveal.nonce.length !== NONCE_SIZE) {
    throw new VeiloError("SizeMismatch", `bid nonce must be ${NONCE_SIZE} bytes`);
  }
  return concat(auctionId, u64le(reveal.bidZat), reveal.nonce);
}

export function decodeReveal(bytes: Uint8Array): { auctionId: Uint8Array; reveal: Reveal } {
  if (bytes.length !== AUCTION_ID_SIZE + 8 + NONCE_SIZE) {
    throw new VeiloError("SizeMismatch", `reveal must be 40 bytes, got ${bytes.length}`);
  }
  return {
    auctionId: bytes.slice(0, AUCTION_ID_SIZE),
    reveal: {
      bidZat: readU64le(bytes.slice(AUCTION_ID_SIZE, AUCTION_ID_SIZE + 8)),
      nonce: bytes.slice(AUCTION_ID_SIZE + 8),
    },
  };
}

// ---------------------------------------------------------------------------
// Sealed refund address (I4)
// ---------------------------------------------------------------------------

export interface RefundSeal {
  epkRefund: Uint8Array;
  sealed: Uint8Array;
}

/**
 * c_refund = ChaCha20-Poly1305(k, pad256(UA_refund))
 *   k = BLAKE2b-256(X25519(esk_refund, PK_refund))
 *
 * The settlement key SK_refund is never published, so publishing UIVK_escrow at H_end
 * exposes every bid amount while redacting every refund address, winner included.
 *
 * Takes only PK_refund. The bidder never sees, generates, or derives any escrow secret —
 * holding SK_refund would let them decrypt every other bidder's refund address.
 */
export function sealRefundAddress(
  pkRefund: Uint8Array,
  refundAddress: string,
  aad?: Uint8Array,
  eskRefund?: Uint8Array
): RefundSeal {
  if (pkRefund.length !== 32) {
    throw new VeiloError("SizeMismatch", "PK_refund must be 32 bytes");
  }

  const addr = new TextEncoder().encode(refundAddress);
  if (addr.length > REFUND_PLAINTEXT_MAX) {
    throw new VeiloError(
      "RefundAddressTooLong",
      `UA_refund is ${addr.length} bytes, max ${REFUND_PLAINTEXT_MAX}`
    );
  }

  // The ephemeral seed is injectable so cross-implementation test vectors can pin
  // it; callers that do not care get a CSPRNG value. Mirrors the Rust
  // seal_refund_address_with_seed / seal_refund_address pair exactly.
  const esk = eskRefund ?? randomBytes(32);
  if (esk.length !== 32) {
    throw new VeiloError("SizeMismatch", "esk_refund must be 32 bytes");
  }
  const epkRefund = x25519.getPublicKey(esk);
  const shared = x25519.getSharedSecret(esk, pkRefund);
  const key = domainBlake2b(PAD_DOMAIN, shared);

  const padded = new Uint8Array(REFUND_PLAINTEXT_MAX);
  padded.set(addr);

  // The AEAD nonce is derived rather than transmitted, because the 232-byte field is
  // fully accounted for by 216 B of plaintext + a 16 B tag. epk_refund is a fresh
  // random 32-byte ephemeral for every seal, so truncating its hash to 12 bytes yields
  // a nonce that is unique per (key, message) — which is all ChaCha20-Poly1305 requires.
  // epk_refund is already stored at memo offset 53..85, so nothing extra goes on chain.
  const nonce = blake2b(epkRefund, { dkLen: 12 });

  // `aad` (auction_id) is authenticated but not encrypted, binding the sealed address to
  // this one auction so a ciphertext cannot be lifted into a different envelope.
  const sealed = chacha20poly1305(key, nonce, aad).encrypt(padded);

  return { epkRefund, sealed: new Uint8Array(sealed) };
}

/** Auctioneer-side open. Only ever runs with SK_refund, which is never published. */
/**
 * Auctioneer-side open. Only ever runs with SK_refund, which is never published.
 *
 * Takes the SECRET, not the public key. noble's `getSharedSecret(secretKey, publicKey)`
 * clamps its first argument as a private scalar, so passing PK_refund here would clamp
 * the public key and silently derive a different shared secret — the AEAD tag would
 * fail and, worse, it looks like tampering rather than a caller bug.
 */
export function openRefundAddress(
  skRefund: Uint8Array,
  epkRefund: Uint8Array,
  sealed: Uint8Array,
  aad?: Uint8Array
): string {
  if (skRefund.length !== 32) {
    throw new VeiloError("SizeMismatch", "SK_refund must be 32 bytes");
  }
  if (sealed.length !== C_REFUND_SIZE) {
    throw new VeiloError("InvalidSealedRefund", `c_refund must be ${C_REFUND_SIZE} bytes`);
  }
  const shared = x25519.getSharedSecret(skRefund, epkRefund);
  const key = domainBlake2b(PAD_DOMAIN, shared);
  const nonce = blake2b(epkRefund, { dkLen: 12 });

  let padded: Uint8Array;
  try {
    padded = chacha20poly1305(key, nonce, aad).decrypt(sealed);
  } catch {
    throw new VeiloError("UnlockFailed", "c_refund failed authentication");
  }

  // Strip zero padding; a UA never contains a NUL byte.
  let end = padded.length;
  while (end > 0 && padded[end - 1] === 0) end--;
  if (end === 0) {
    throw new VeiloError("UnlockFailed", "c_refund decrypted to empty");
  }
  return new TextDecoder().decode(padded.subarray(0, end));
}

// ---------------------------------------------------------------------------
// Memo pack / unpack
// ---------------------------------------------------------------------------

export interface MemoFields {
  auctionId: Uint8Array;
  epkBid: Uint8Array;
  epkRefund: Uint8Array;
  bidCommit: Uint8Array;
  cRefund: Uint8Array;
}

export function packMemo(fields: MemoFields): Uint8Array {
  const {
    auctionId,
    epkBid,
    epkRefund,
    bidCommit,
    cRefund,
  } = fields;

  if (auctionId.length !== AUCTION_ID_SIZE) throw new VeiloError("InvalidAuctionId", "auction_id must be 16 bytes");
  if (epkBid.length !== EPK_SIZE) throw new VeiloError("InvalidEpkBid", "epk_bid must be 32 bytes");
  if (epkRefund.length !== EPK_SIZE) throw new VeiloError("InvalidEpkRefund", "epk_refund must be 32 bytes");
  if (bidCommit.length !== BID_COMMIT_SIZE) throw new VeiloError("InvalidCommitment", "bid_commit must be 32 bytes");
  if (cRefund.length !== C_REFUND_SIZE) throw new VeiloError("InvalidSealedRefund", "c_refund must be 232 bytes");

  const memo = new Uint8Array(MEMO_SIZE);
  let o = 0;
  memo[o++] = MAGIC_LEAD;
  memo.set(PROTOCOL_TAG, o); o += 4;
  memo.set(auctionId, o); o += 16;
  memo.set(epkBid, o); o += 32;
  memo.set(epkRefund, o); o += 32;
  memo.set(bidCommit, o); o += 32;
  memo.set(cRefund, o); o += C_REFUND_SIZE;
  // remaining bytes stay 0x00 (deterministic padding)

  // The cursor lands at the start of the padding region, not at the end of the memo.
  // Asserting against MEMO_SIZE here would hide a layout drift that overflows 512.
  if (o !== C_REFUND_END) {
    throw new VeiloError(
      "SizeMismatch",
      `layout wrote ${o} bytes, expected ${C_REFUND_END} (padding would be ${MEMO_SIZE - o} B)`
    );
  }
  return memo;
}

export function isVeiloMemo(memo: Uint8Array): boolean {
  if (memo.length < 1 + PROTOCOL_TAG.length) return false;
  if (memo[0] !== MAGIC_LEAD) return false;
  for (let i = 0; i < PROTOCOL_TAG.length; i++) {
    if (memo[1 + i] !== PROTOCOL_TAG[i]) return false;
  }
  return true;
}

/** Strict parse. Throws with a precise code so the auditor can classify bad bids. */
export function unpackMemo(memo: Uint8Array): MemoFields {
  if (memo.length !== MEMO_SIZE) {
    throw new VeiloError("SizeMismatch", `memo must be ${MEMO_SIZE} bytes, got ${memo.length}`);
  }
  if (memo[0] !== MAGIC_LEAD) throw new VeiloError("InvalidMagic", "memo does not start with 0xFF");
  for (let i = 0; i < PROTOCOL_TAG.length; i++) {
    if (memo[1 + i] !== PROTOCOL_TAG[i]) {
      throw new VeiloError("InvalidProtocolTag", "protocol tag mismatch");
    }
  }
  let o = 5;
  const auctionId = memo.slice(o, o + 16); o += 16;
  const epkBid = memo.slice(o, o + 32); o += 32;
  const epkRefund = memo.slice(o, o + 32); o += 32;
  const bidCommit = memo.slice(o, o + 32); o += 32;
  const cRefund = memo.slice(o, o + C_REFUND_SIZE); o += C_REFUND_SIZE;

  for (let i = o; i < MEMO_SIZE; i++) {
    if (memo[i] !== 0) {
      throw new VeiloError("NonZeroPadding", `padding byte ${i} is non-zero`);
    }
  }
  return { auctionId, epkBid, epkRefund, bidCommit, cRefund };
}

/** Build the complete bid envelope. Runs entirely client-side. */
export function buildBidEnvelope(params: {
  auctionId: Uint8Array;
  pkRefund: Uint8Array;
  bidZat: bigint | number;
  refundAddress: string;
  nonce?: Uint8Array;
}): MemoFields & { memo: Uint8Array; reveal: Uint8Array } {
  const nonce = params.nonce ?? randomBytes(NONCE_SIZE);
  const eskBid = randomBytes(32);
  const epkBid = x25519.getPublicKey(eskBid);
  const bidCommit = computeBidCommit(params.auctionId, params.bidZat, nonce, epkBid);
  const { epkRefund, sealed } = sealRefundAddress(params.pkRefund, params.refundAddress, params.auctionId);
  const fields: MemoFields = {
    auctionId: params.auctionId,
    epkBid,
    epkRefund,
    bidCommit,
    cRefund: sealed,
  };
  return {
    ...fields,
    memo: packMemo(fields),
    reveal: encodeReveal(params.auctionId, { bidZat: BigInt(params.bidZat), nonce }),
  };
}

export function makeRefundKeypair(seed?: Uint8Array): { skRefund: Uint8Array; pkRefund: Uint8Array } {
  const sk = seed ?? randomBytes(32);
  const pk = x25519.getPublicKey(sk);
  return { skRefund: sk, pkRefund: pk };
}