/**
 * Veilo — bidder side: turn a number and an address into a sealed bid.
 *
 * This is the half the auditor never sees. Everything here runs in the bidder's
 * browser, before the bid is broadcast, and produces exactly three things:
 *
 *   1. a 512-byte memo (the envelope that goes on chain),
 *   2. a ZIP-321 payment request carrying that memo as its `memo` parameter,
 *   3. a reveal ticket the bidder keeps until the deadline.
 *
 * The ticket is the only copy of the bid amount's nonce. Lose it and the bid is
 * unreadable forever: the commitment on chain cannot be opened by anyone, the
 * auctioneer included. That is I1 working as designed, and it is why the page
 * refuses to pretend the ticket is recoverable.
 *
 * No network calls, no server, no wallet access. `prepareBid` is pure except for
 * the CSPRNG that mints the nonce and ephemeral keys, and accepts injected
 * randomness so tests can pin the bytes.
 */

import {
  REFUND_PLAINTEXT_MAX,
  buildBidEnvelope,
  computeBidCommit,
  decodeReveal,
  encodeReveal,
  isVeiloMemo,
  unpackMemo,
  type Reveal,
} from "./memo.ts";
import { buildZip321, formatAmountZec, parseAmountZec } from "./zip321.ts";

export const TICKET_VERSION = 1;
export const ZAT_PER_ZEC = 100_000_000n;
export const MAX_ZAT = 21_000_000n * ZAT_PER_ZEC;

/** A rejection the bidder should see in plain words, not as a stack trace. */
export class BidError extends Error {
  code:
    | "BadAuction"
    | "BadAmount"
    | "UnderCollateralised"
    | "BadAddress"
    | "BadTicket";

  constructor(code: BidError["code"], message: string) {
    super(message);
    this.name = "BidError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Hex, because the page and the ticket both speak it
// ---------------------------------------------------------------------------

const HEX_RE = /^[0-9a-f]+$/i;

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Decode exactly `size` bytes, or say which field was wrong and why. */
export function fromHex(value: string, size: number, field: string): Uint8Array {
  if (typeof value !== "string" || !HEX_RE.test(value)) {
    throw new BidError("BadTicket", `${field} is not hex`);
  }
  if (value.length !== size * 2) {
    throw new BidError("BadTicket", `${field} must be ${size} bytes (${size * 2} hex characters)`);
  }
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// ---------------------------------------------------------------------------
// The auction document
// ---------------------------------------------------------------------------

/**
 * What a bidder must know before bidding. All of it is public by construction:
 * `pkRefund` is the auction's refund encryption key, whose secret the auctioneer
 * never publishes (I4), and `escrowAddress` is the address bids are sent to.
 */
export interface AuctionDoc {
  auctionId: Uint8Array;
  escrowAddress: string;
  pkRefund: Uint8Array;
  reserveZat: bigint;
  endsAtHeight?: number;
  /**
   * True for the bundled practice auction, whose refund secret is published in
   * the repository so tests can open the seal. The page must warn loudly: any
   * address entered here is readable by anyone.
   */
  practice: boolean;
}

/** The on-disk shape, so a typo in the JSON is an error and not `undefined`. */
export interface AuctionDocJson {
  auction_id: string;
  escrow_address: string;
  pk_refund: string;
  reserve_zat: number | string;
  ends_at_height?: number;
  practice?: boolean;
}

export function parseAuctionDoc(json: unknown): AuctionDoc {
  if (typeof json !== "object" || json === null) {
    throw new BidError("BadAuction", "auction document must be a JSON object");
  }
  const doc = json as Record<string, unknown>;
  const auctionId = fromHex(String(doc.auction_id ?? ""), 16, "auction_id");
  const pkRefund = fromHex(String(doc.pk_refund ?? ""), 32, "pk_refund");

  const escrowAddress = String(doc.escrow_address ?? "");
  if (!/^[A-Za-z0-9]+$/.test(escrowAddress)) {
    throw new BidError("BadAuction", "escrow_address is not a Zcash address");
  }

  const reserveZat = parseZatString(doc.reserve_zat, "reserve_zat");
  const endsAtHeight = doc.ends_at_height;
  if (endsAtHeight !== undefined && (!Number.isInteger(endsAtHeight) || (endsAtHeight as number) < 0)) {
    throw new BidError("BadAuction", "ends_at_height must be a non-negative block height");
  }

  return {
    auctionId,
    escrowAddress,
    pkRefund,
    reserveZat,
    endsAtHeight: endsAtHeight as number | undefined,
    practice: doc.practice === true,
  };
}

function parseZatString(value: unknown, field: string): bigint {
  if (typeof value === "bigint") return assertZat(value, field);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new BidError("BadAuction", `${field} must be a safe integer number of zatoshi`);
    }
    return assertZat(BigInt(value), field);
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return assertZat(BigInt(value), field);
  }
  throw new BidError("BadAuction", `${field} must be a whole number of zatoshi`);
}

function assertZat(value: bigint, field: string): bigint {
  if (value < 0n) throw new BidError("BadAmount", `${field} cannot be negative`);
  if (value > MAX_ZAT) throw new BidError("BadAmount", `${field} exceeds 21 million ZEC`);
  return value;
}

/** "60" or "60.5" (decimal ZEC) to zatoshi, using the ZIP-321 grammar. */
export function zecToZat(input: string, field = "amount"): bigint {
  const text = input.trim();
  if (text === "") throw new BidError("BadAmount", `${field} is required`);
  try {
    return parseAmountZec(text);
  } catch (err) {
    throw new BidError(
      "BadAmount",
      `${field} must be decimal ZEC with at most 8 decimal places (got ${JSON.stringify(input)})`
    );
  }
}

// ---------------------------------------------------------------------------
// Sealing a bid
// ---------------------------------------------------------------------------

export interface BidDraft {
  bidZat: bigint;
  collateralZat: bigint;
  refundAddress: string;
}

export interface RevealTicket {
  version: number;
  auction_id: string;
  bid_zat: string;
  nonce: string;
  epk_bid: string;
  bid_commit: string;
  memo: string;
  created_at: string;
}

export interface SealedBid {
  /** The exact 512 bytes that go in the memo field. */
  memo: Uint8Array;
  /** `zcash:` payment request: amount = collateral, address = escrow, memo = envelope. */
  uri: string;
  /** 40-byte permissionless reveal, for after the deadline. */
  reveal: Uint8Array;
  revealHex: string;
  ticket: RevealTicket;
}

export interface PrepareOptions {
  /** Fixed nonce, for test vectors. Omit to draw from the CSPRNG. */
  nonce?: Uint8Array;
}

/**
 * Validate, seal, pack, and describe one bid.
 *
 * The two rules enforced here mirror the auditor, so a bidder learns about a
 * mistake before locking funds rather than at settlement:
 *   - `collateralZat >= bidZat` (an unbacked bid is not a bid)
 *   - both amounts are whole zatoshi within the 21M ZEC supply
 */
export function prepareBid(
  auction: AuctionDoc,
  draft: BidDraft,
  options: PrepareOptions = {}
): SealedBid {
  const bidZat = assertZat(draft.bidZat, "bid");
  const collateralZat = assertZat(draft.collateralZat, "collateral");

  if (bidZat === 0n) throw new BidError("BadAmount", "bid must be greater than zero ZEC");
  if (collateralZat < bidZat) {
    throw new BidError(
      "UnderCollateralised",
      `collateral (${formatAmountZec(collateralZat)} ZEC) is less than the bid ` +
        `(${formatAmountZec(bidZat)} ZEC); the auditor would reject it`
    );
  }

  const refundAddress = assertRefundAddress(draft.refundAddress);

  const envelope = buildBidEnvelope({
    auctionId: auction.auctionId,
    pkRefund: auction.pkRefund,
    bidZat,
    refundAddress,
    nonce: options.nonce,
  });

  const uri = buildZip321({
    address: auction.escrowAddress,
    amountZec: formatAmountZec(collateralZat),
    memo: envelope.memo,
    label: "Veilo sealed bid",
    expires: auction.endsAtHeight,
  });

  const ticket: RevealTicket = {
    version: TICKET_VERSION,
    auction_id: toHex(auction.auctionId),
    bid_zat: bidZat.toString(),
    nonce: toHex(envelope.reveal.slice(24)),
    epk_bid: toHex(envelope.epkBid),
    bid_commit: toHex(envelope.bidCommit),
    memo: toHex(envelope.memo),
    created_at: new Date().toISOString(),
  };

  return {
    memo: envelope.memo,
    uri,
    reveal: envelope.reveal,
    revealHex: toHex(envelope.reveal),
    ticket,
  };
}

function assertRefundAddress(address: string): string {
  if (address !== address.trim()) {
    throw new BidError("BadAddress", "refund address has leading or trailing whitespace");
  }
  if (address === "") {
    throw new BidError("BadAddress", "refund address is required");
  }
  if (!/^[A-Za-z0-9]+$/.test(address)) {
    throw new BidError("BadAddress", "refund address must be alphanumeric (a Zcash address)");
  }
  const bytes = new TextEncoder().encode(address).length;
  if (bytes > REFUND_PLAINTEXT_MAX) {
    throw new BidError(
      "BadAddress",
      `refund address is ${bytes} bytes; the sealed field holds at most ${REFUND_PLAINTEXT_MAX}`
    );
  }
  return address;
}

// ---------------------------------------------------------------------------
// The reveal ticket
// ---------------------------------------------------------------------------

/**
 * Parse and fully self-check a ticket.
 *
 * A ticket is data the bidder saved earlier, so every field is treated as
 * untrusted input: lengths, hex, the memo magic, and the commitment recomputed
 * from the reveal. A ticket that disagrees with its own memo is refused before
 * anything is published, which is the last point where a mistake is still
 * private.
 */
export function verifyTicket(input: string | unknown): {
  auctionId: Uint8Array;
  bidZat: bigint;
  nonce: Uint8Array;
  epkBid: Uint8Array;
  bidCommit: Uint8Array;
  memo: Uint8Array;
  created_at: string;
} {
  let raw: unknown = input;
  if (typeof input === "string") {
    try {
      raw = JSON.parse(input);
    } catch {
      throw new BidError("BadTicket", "ticket is not valid JSON");
    }
  }
  if (typeof raw !== "object" || raw === null) {
    throw new BidError("BadTicket", "ticket must be a JSON object");
  }
  const t = raw as Record<string, unknown>;

  if (Number(t.version) !== TICKET_VERSION) {
    throw new BidError("BadTicket", `unsupported ticket version ${String(t.version)}`);
  }

  const auctionId = fromHex(String(t.auction_id ?? ""), 16, "auction_id");
  const nonce = fromHex(String(t.nonce ?? ""), 16, "nonce");
  const epkBid = fromHex(String(t.epk_bid ?? ""), 32, "epk_bid");
  const bidCommit = fromHex(String(t.bid_commit ?? ""), 32, "bid_commit");
  const memo = fromHex(String(t.memo ?? ""), 512, "memo");

  const bidText = String(t.bid_zat ?? "");
  if (!/^\d+$/.test(bidText)) {
    throw new BidError("BadTicket", "bid_zat must be a whole number of zatoshi");
  }
  const bidZat = BigInt(bidText);
  if (bidZat === 0n || bidZat > MAX_ZAT) {
    throw new BidError("BadTicket", "bid_zat is outside the possible range");
  }

  if (!isVeiloMemo(memo)) {
    throw new BidError("BadTicket", "memo is not a Veilo envelope");
  }
  const fields = unpackMemo(memo);
  if (toHex(fields.auctionId) !== toHex(auctionId)) {
    throw new BidError("BadTicket", "ticket names a different auction than its memo");
  }
  if (toHex(fields.epkBid) !== toHex(epkBid)) {
    throw new BidError("BadTicket", "ticket names a different bidder key than its memo");
  }
  if (toHex(fields.bidCommit) !== toHex(bidCommit)) {
    throw new BidError("BadTicket", "ticket names a different commitment than its memo");
  }

  const recomputed = computeBidCommit(auctionId, bidZat, nonce, epkBid);
  if (toHex(recomputed) !== toHex(bidCommit)) {
    throw new BidError(
      "BadTicket",
      "bid amount and nonce do not open the commitment in the memo; the ticket was edited"
    );
  }

  return {
    auctionId,
    bidZat,
    nonce,
    epkBid,
    bidCommit,
    memo,
    created_at: String(t.created_at ?? ""),
  };
}

/** The 40-byte reveal to publish, as hex, after the deadline. */
export function publishReveal(input: string | unknown): {
  revealHex: string;
  bidZec: string;
  auctionId: string;
} {
  const t = verifyTicket(input);
  const reveal: Reveal = { bidZat: t.bidZat, nonce: t.nonce };
  const bytes = encodeReveal(t.auctionId, reveal);
  // Decode our own bytes before handing them out: if these two ever disagree,
  // the bidder publishes a reveal nobody can match.
  const back = decodeReveal(bytes);
  if (back.reveal.bidZat !== t.bidZat || toHex(back.reveal.nonce) !== toHex(t.nonce)) {
    throw new BidError("BadTicket", "internal error encoding the reveal");
  }
  return {
    revealHex: toHex(bytes),
    bidZec: formatAmountZec(t.bidZat),
    auctionId: toHex(t.auctionId),
  };
}
