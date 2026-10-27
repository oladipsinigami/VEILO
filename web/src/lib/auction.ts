/**
 * Veilo — auction math (Part 3 §2.4, §3).
 *
 * Pure functions over public data. Given the same input, every auditor in the world
 * computes the same winner and clearing price. Nothing here trusts the auctioneer.
 *
 * Reference implementation of crates/veilo-core/src/audit.rs and src/exclusion.rs.
 */

export type BidStatus =
  | "Valid"
  | "InvalidInsufficientCollateral"
  | "InvalidNoReveal"
  | "InvalidRevealMismatch"
  | "InvalidLateBlock"
  | "ExcludedSeller";

export interface AuditedBid {
  /** Stable public identifier: block height + note index, as seen in the chain. */
  orderKey: string;
  height: number;
  noteIndex: number;
  /** On-chain collateral value, in zatoshi. */
  collateralZat: bigint;
  /** Revealed bid, or null if no valid reveal was published by H_reveal. */
  bidZat: bigint | null;
  status: BidStatus;
}

export interface AuctionParams {
  reserveZat: bigint;
  hStart: number;
  hEnd: number;
  hReveal: number;
  sellerAddress: string;
}

export interface AuctionResult {
  winner: AuditedBid | null;
  clearingPriceZat: bigint;
  /** Bids that count toward the clearing price (excludes seller + invalid bids). */
  effectiveBids: AuditedBid[];
  /**
   * EVERY bid found in the window, including invalid and seller-excluded ones.
   * Settlement MUST iterate this, not effectiveBids: an under-collateralised or
   * unrevealed bidder still has collateral sitting in the escrow and is owed a refund.
   */
  allBids: AuditedBid[];
  /** Second-highest bid, or null when there is only one effective bid. */
  secondHighestZat: bigint | null;
  totalCollateralZat: bigint;
  invalidCount: number;
  sellerExcluded: number;
}

// ---------------------------------------------------------------------------
// Bid classification
// ---------------------------------------------------------------------------

/**
 * Classify one decrypted note.
 *
 * Ordering matters: the deadline check runs before the solvency check so that a
 * post-deadline note is reported as late rather than as a solvency violation, which
 * keeps the red-team demo (a deliberately under-collateralised bid) semantically clean.
 */
export function classifyBid(params: {
  height: number;
  noteIndex: number;
  collateralZat: bigint;
  revealValid: boolean;
  auction: AuctionParams;
}): AuditedBid {
  const { height, noteIndex, collateralZat, revealValid, auction } = params;
  const orderKey = `${height}:${String(noteIndex).padStart(6, "0")}`;

  if (height < auction.hStart || height > auction.hEnd) {
    return {
      orderKey,
      height,
      noteIndex,
      collateralZat,
      bidZat: null,
      status: "InvalidLateBlock",
    };
  }
  if (!revealValid) {
    // Deliberately collapses bidZat to null: an unrevealed bid must not participate in
    // pricing even if a party later produces an out-of-band claim about it.
    return {
      orderKey,
      height,
      noteIndex,
      collateralZat,
      bidZat: null,
      status: "InvalidNoReveal",
    };
  }
  // bidZat is supplied by the caller once revealed; see resolveBids().
  return {
    orderKey,
    height,
    noteIndex,
    collateralZat,
    bidZat: null,
    status: "Valid",
  };
}

/**
 * Apply the reveal set to classified bids and enforce the solvency rule.
 *
 * Solvency: note.value >= bid_zat. An under-collateralised bid is excluded from
 * pricing and refunded in full, which is why it is harmless to submit one — there is
 * no penalty, so there is no griefing incentive either.
 */
export function resolveBids(
  bids: AuditedBid[],
  reveals: Map<string, bigint>
): AuditedBid[] {
  return bids.map((bid) => {
    if (bid.status !== "Valid") return bid;

    const bidZat = reveals.get(bid.orderKey);
    if (bidZat === undefined) {
      return { ...bid, bidZat: null, status: "InvalidNoReveal" };
    }
    if (bidZat < 0n) {
      throw new RangeError(`negative bid for ${bid.orderKey}`);
    }
    if (bid.collateralZat < bidZat) {
      return { ...bid, bidZat, status: "InvalidInsufficientCollateral" };
    }
    return { ...bid, bidZat, status: "Valid" };
  });
}

// ---------------------------------------------------------------------------
// Seller exclusion (I3)
// ---------------------------------------------------------------------------

export interface ExclusionProof {
  /** orderKey of the bid being excluded. */
  orderKey: string;
  /** The decrypted UA the exclusion claims to rest on. */
  claimedAddress: string;
  /**
   * Opener callback: returns the address the bid's sealed refund decrypts to.
   *
   * This needs `SK_refund`, not `PK_refund` — the public key cannot decrypt, and
   * the comment here previously implied it could. Whoever supplies this callback
   * supplies the trust: the check is only as good as the opener. That is why the
   * browser auditor does not use this path and applies the auction document's
   * declared key instead (see README limitation 7).
   */
  openSealedRefund: (orderKey: string) => string;
}

/**
 * Apply the seller-exclusion rule.
 *
 * Second-price auctions are shilling-resistant against a non-seller: raising the second
 * price only raises what the winner pays. The attack that works is the SELLER bidding,
 * because the seller is refunded the excess and captures the inflated price. So the
 * clearing price is computed over non-seller bids.
 *
 * How "seller" is established is the weak point. This function accepts a caller-supplied
 * opener, so it verifies a claim only relative to that opener; it is not a public proof.
 * A third party cannot run it without `SK_refund`, and publishing that key would expose
 * every bidder's refund address. The browser therefore applies the auction document's
 * declared seller key instead, and labels the result "declared".
 *
 * Returns the subset of bids that survive exclusion.
 */
export function applySellerExclusion(
  bids: AuditedBid[],
  auction: AuctionParams,
  proofs: ExclusionProof[]
): { kept: AuditedBid[]; excludedCount: number; rejectedProofs: string[] } {
  const byKey = new Map<string, AuditedBid>();
  for (const b of bids) byKey.set(b.orderKey, b);

  const excludedKeys = new Set<string>();
  const rejectedProofs: string[] = [];

  for (const proof of proofs) {
    if (proof.claimedAddress !== auction.sellerAddress) {
      rejectedProofs.push(proof.orderKey);
      continue;
    }
    let opened: string;
    try {
      opened = proof.openSealedRefund(proof.orderKey);
    } catch {
      rejectedProofs.push(proof.orderKey);
      continue;
    }
    if (opened !== auction.sellerAddress) {
      rejectedProofs.push(proof.orderKey);
      continue;
    }
    excludedKeys.add(proof.orderKey);
  }

  const kept: AuditedBid[] = [];
  let excludedCount = 0;
  for (const bid of bids) {
    if (excludedKeys.has(bid.orderKey)) {
      excludedCount++;
      continue;
    }
    kept.push(bid);
  }
  return { kept, excludedCount, rejectedProofs };
}

// ---------------------------------------------------------------------------
// Vickrey pricing (Part 3 §2.4)
// ---------------------------------------------------------------------------

/**
 * ClearingPrice = max(reserve, max over non-winner effective bids)
 *
 * Tie-break: lowest block height, then lowest note index. Deterministic and derived
 * entirely from public chain data, so every auditor lands on the same answer.
 *
 * Degenerate cases, all explicit:
 *  - 0 effective bids  -> no winner, clearing price 0, everything refunded.
 *  - 1 effective bid   -> winner takes the item at the reserve price. The runner-up is
 *                        null, which is why AuctionResult.secondHighestZat is nullable
 *                        and why Phase A publishes reserve_zat.
 */
export function computeAuctionResult(
  bids: AuditedBid[],
  auction: AuctionParams
): AuctionResult {
  const effective = bids
    .filter((b) => b.status === "Valid" && b.bidZat !== null)
    .sort(compareBids);

  const totalCollateralZat = bids.reduce((sum, b) => sum + b.collateralZat, 0n);
  const invalidCount = bids.filter((b) => b.status !== "Valid").length;

  if (effective.length === 0) {
    return {
      winner: null,
      clearingPriceZat: 0n,
      effectiveBids: [],
      allBids: bids,
      secondHighestZat: null,
      totalCollateralZat,
      invalidCount,
      sellerExcluded: 0,
    };
  }

  const winner = effective[0];
  const runnerUp = effective[1];
  const secondHighestZat = runnerUp ? runnerUp.bidZat : null;

  const raw = secondHighestZat ?? 0n;
  const clearingPriceZat = raw > auction.reserveZat ? raw : auction.reserveZat;

  // I5 requires the winner to actually be able to pay.
  if (winner.collateralZat < clearingPriceZat) {
    throw new RangeError(
      `winner collateral ${winner.collateralZat} < clearing price ${clearingPriceZat}; ` +
        `reserve is unreachable`
    );
  }

  return {
    winner,
    clearingPriceZat,
    effectiveBids: effective,
    allBids: bids,
    secondHighestZat,
    totalCollateralZat,
    invalidCount,
    sellerExcluded: 0,
  };
}

/** Deterministic total order: descending bid, then ascending height, then ascending index. */
export function compareBids(a: AuditedBid, b: AuditedBid): number {
  const av = a.bidZat ?? -1n;
  const bv = b.bidZat ?? -1n;
  if (av !== bv) return av > bv ? -1 : 1;
  if (a.height !== b.height) return a.height - b.height;
  return a.noteIndex - b.noteIndex;
}

// ---------------------------------------------------------------------------
// Settlement accounting (I5)
// ---------------------------------------------------------------------------

export interface SettlementLine {
  kind: "seller" | "winner" | "loser" | "unrevealed";
  orderKey: string | null;
  destination: string;
  amountZat: bigint;
}

export interface SettlementPlan {
  lines: SettlementLine[];
  /** Value returning to the auctioneer's change address. */
  changeZat: bigint;
  /** Portion of the fee absorbed by seller proceeds before touching change. */
  feeFromSellerZat: bigint;
  /**
   * Fee the escrow could not cover. The auctioneer must fund this out of pocket
   * before broadcasting. Non-zero means the plan is NOT safe to broadcast.
   */
  unfundedFeeZat: bigint;
  balanced: boolean;
}

/**
 * Every collateral zatoshi is accounted for in exactly one output line.
 *
 * The ZIP-317 fee is a single per-transaction amount (Part 3 §7). It is charged against
 * seller proceeds first, then against change, because a second-price auction's fee
 * naturally belongs to the party that initiated the sale. Bidders are never charged:
 * that is what makes I5 exact for them.
 */
export function buildSettlementPlan(params: {
  result: AuctionResult;
  refundAddressFor: (orderKey: string) => string;
  sellerAddress: string;
  feeZat: bigint;
  changeAddress: string;
}): SettlementPlan {
  const { result, refundAddressFor, sellerAddress, feeZat } = params;
  if (feeZat < 0n) throw new RangeError("fee must be non-negative");

  const lines: SettlementLine[] = [];
  let distributed = 0n;
  let feeRemaining = feeZat;
  let feeFromSellerZat = 0n;

  if (result.winner) {
    const w = result.winner;
    const amount = w.collateralZat - result.clearingPriceZat;
    lines.push({
      kind: "winner",
      orderKey: w.orderKey,
      destination: refundAddressFor(w.orderKey),
      amountZat: amount,
    });
    distributed += amount;

    // Seller absorbs as much of the fee as their proceeds allow.
    const sellerNet = result.clearingPriceZat - feeRemaining;
    const sellerAmount = sellerNet > 0n ? sellerNet : 0n;
    feeFromSellerZat = result.clearingPriceZat - sellerAmount;
    feeRemaining -= sellerAmount;
    if (feeRemaining < 0n) feeRemaining = 0n;

    lines.push({
      kind: "seller",
      orderKey: null,
      destination: sellerAddress,
      amountZat: sellerAmount,
    });
    distributed += sellerAmount;
  }

  // Walk ALL bids, not just the effective ones. An under-collateralised or unrevealed
  // bidder still has collateral in the escrow and is owed a full refund; dropping them
  // here would silently strand their funds.
  for (const bid of result.allBids) {
    if (result.winner && bid.orderKey === result.winner.orderKey) continue;
    lines.push({
      kind: bid.status === "Valid" ? "loser" : "unrevealed",
      orderKey: bid.orderKey,
      destination: refundAddressFor(bid.orderKey),
      amountZat: bid.collateralZat,
    });
    distributed += bid.collateralZat;
  }

  // The fee leaves the escrow exactly once — it is the transaction fee paid to the
  // network. It must NOT be subtracted again here when the seller has already absorbed
  // it from their proceeds line, or the fee is double-counted and change is overstated.
  const changeZat = result.totalCollateralZat - distributed - feeZat;
  const unfundedFeeZat = changeZat < 0n ? -changeZat : 0n;

  return {
    lines,
    changeZat: changeZat > 0n ? changeZat : 0n,
    feeFromSellerZat,
    unfundedFeeZat,
    balanced: unfundedFeeZat === 0n,
  };
}