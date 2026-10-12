//! Veilo — auction math (Part 3 §2.4, §3, §7).
//!
//! Rust half of the two-implementation pair; `web/src/lib/auction.ts` is the other.
//! Everything here is a pure function over public chain data: given the same input,
//! every auditor in the world computes the same winner and clearing price, and none
//! of it trusts the auctioneer.
//!
//! Amounts are `u64` zatoshi. The Zcash supply cap is 2.1e15 zat, which fits in a
//! u64 (1.8e19) with ~4 orders of magnitude of headroom, so no widening is needed.
//! Sums use `checked_add` and surface an error rather than silently wrapping — a
//! settlement that overflows would be a total-loss bug.

use std::cmp::Ordering;
use std::collections::{BTreeMap, HashSet};
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BidStatus {
    Valid,
    InvalidInsufficientCollateral,
    InvalidNoReveal,
    InvalidRevealMismatch,
    InvalidLateBlock,
    ExcludedSeller,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditedBid {
    /// Stable public identifier: `<height>:<note_index zero-padded to 6>`.
    pub order_key: String,
    pub height: u32,
    pub note_index: u32,
    /// On-chain collateral, in zatoshi. Known to the escrow at all times.
    pub collateral_zat: u64,
    /// Revealed bid. `None` until a valid reveal exists, and deliberately kept `None`
    /// for invalid bids so an unrevealed amount can never reach the pricing step.
    pub bid_zat: Option<u64>,
    pub status: BidStatus,
}

impl AuditedBid {
    pub fn order_key(height: u32, note_index: u32) -> String {
        format!("{height}:{note_index:06}")
    }
}

#[derive(Debug, Clone)]
pub struct AuctionParams {
    pub reserve_zat: u64,
    pub h_start: u32,
    pub h_end: u32,
    pub h_reveal: u32,
    pub seller_address: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuctionError {
    NegativeBid { order_key: String },
    ArithmeticOverflow,
    /// The reserve exceeds the winner's collateral. The auction cannot settle.
    ReserveUnreachable {
        collateral_zat: u64,
        clearing_price_zat: u64,
    },
}

impl fmt::Display for AuctionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AuctionError::NegativeBid { order_key } => {
                write!(f, "negative bid for {order_key}")
            }
            AuctionError::ArithmeticOverflow => write!(f, "zatoshi arithmetic overflow"),
            AuctionError::ReserveUnreachable {
                collateral_zat,
                clearing_price_zat,
            } => write!(
                f,
                "winner collateral {collateral_zat} < clearing price {clearing_price_zat}; \
                 reserve is unreachable"
            ),
        }
    }
}

impl std::error::Error for AuctionError {}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/// Classify one decrypted note.
///
/// The deadline check runs before the solvency check so a post-deadline note is
/// reported as *late* rather than as a solvency violation, which keeps the two
/// failure modes distinguishable to an auditor and in the demo.
pub fn classify_bid(
    height: u32,
    note_index: u32,
    collateral_zat: u64,
    reveal_valid: bool,
    auction: &AuctionParams,
) -> AuditedBid {
    let order_key = AuditedBid::order_key(height, note_index);

    if height < auction.h_start || height > auction.h_end {
        return AuditedBid {
            order_key,
            height,
            note_index,
            collateral_zat,
            bid_zat: None,
            status: BidStatus::InvalidLateBlock,
        };
    }
    if !reveal_valid {
        return AuditedBid {
            order_key,
            height,
            note_index,
            collateral_zat,
            bid_zat: None,
            status: BidStatus::InvalidNoReveal,
        };
    }
    AuditedBid {
        order_key,
        height,
        note_index,
        collateral_zat,
        bid_zat: None,
        status: BidStatus::Valid,
    }
}

/// Apply the reveal set and enforce solvency: `note.value >= bid_zat`.
///
/// An under-collateralised bid is excluded from pricing and refunded in full, which
/// is why submitting one is harmless — and therefore has no griefing incentive.
pub fn resolve_bids(
    bids: Vec<AuditedBid>,
    reveals: &BTreeMap<String, u64>,
) -> Result<Vec<AuditedBid>, AuctionError> {
    bids.into_iter()
        .map(|bid| {
            if bid.status != BidStatus::Valid {
                return Ok(bid);
            }
            let Some(bid_zat) = reveals.get(&bid.order_key).copied() else {
                return Ok(AuditedBid {
                    status: BidStatus::InvalidNoReveal,
                    bid_zat: None,
                    ..bid
                });
            };
            if bid.collateral_zat < bid_zat {
                return Ok(AuditedBid {
                    bid_zat: Some(bid_zat),
                    status: BidStatus::InvalidInsufficientCollateral,
                    ..bid
                });
            }
            Ok(AuditedBid {
                bid_zat: Some(bid_zat),
                ..bid
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Seller exclusion (I3)
// ---------------------------------------------------------------------------

/// A claim that a bid should be excluded from pricing because it is the seller's.
///
/// The auctioneer must prove it: the decrypted refund address must actually be
/// `seller_UA`. Without this, a second-price auction is riggable — the seller bids,
/// is refunded the excess, and captures the inflated price.
pub struct ExclusionProof {
    pub order_key: String,
    pub claimed_address: String,
}

pub struct SellerExclusion {
    pub kept: Vec<AuditedBid>,
    pub excluded_count: usize,
    /// Proofs that were rejected. A rejected proof must not exclude anything.
    pub rejected_proofs: Vec<String>,
}

pub fn apply_seller_exclusion(
    bids: Vec<AuditedBid>,
    auction: &AuctionParams,
    proofs: &[ExclusionProof],
    open_sealed_refund: &dyn Fn(&str) -> Result<String, String>,
) -> SellerExclusion {
    let mut excluded: HashSet<String> = HashSet::new();
    let mut rejected: Vec<String> = Vec::new();

    for proof in proofs {
        if proof.claimed_address != auction.seller_address {
            rejected.push(proof.order_key.clone());
            continue;
        }
        match open_sealed_refund(&proof.order_key) {
            Ok(opened) if opened == auction.seller_address => {
                excluded.insert(proof.order_key.clone());
            }
            _ => rejected.push(proof.order_key.clone()),
        }
    }

    let mut kept = Vec::with_capacity(bids.len());
    let mut excluded_count = 0usize;
    for bid in bids {
        if excluded.contains(&bid.order_key) {
            excluded_count += 1;
            continue;
        }
        kept.push(bid);
    }
    SellerExclusion {
        kept,
        excluded_count,
        rejected_proofs: rejected,
    }
}

// ---------------------------------------------------------------------------
// Vickrey pricing (I2)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct AuctionResult {
    pub winner: Option<AuditedBid>,
    pub clearing_price_zat: u64,
    /// Bids that count toward the price.
    pub effective_bids: Vec<AuditedBid>,
    /// EVERY bid found in the window, including invalid ones. Settlement MUST walk
    /// this rather than `effective_bids`: an invalid bidder still has collateral in
    /// the escrow and is owed a refund.
    pub all_bids: Vec<AuditedBid>,
    pub second_highest_zat: Option<u64>,
    pub total_collateral_zat: u64,
    pub invalid_count: usize,
}

/// Deterministic total order: descending bid, then ascending height, then index.
///
/// Derived entirely from public chain data, so every auditor lands on the same
/// winner regardless of input ordering.
pub fn compare_bids(a: &AuditedBid, b: &AuditedBid) -> Ordering {
    match a.bid_zat.cmp(&b.bid_zat).reverse() {
        Ordering::Equal => a.height.cmp(&b.height).then(a.note_index.cmp(&b.note_index)),
        other => other,
    }
}

/// `ClearingPrice = max(reserve, second-highest non-seller bid)`
///
/// Degenerate cases, all explicit:
///  - 0 effective bids -> no winner, price 0, everything refunded.
///  - 1 effective bid  -> winner takes the item at the reserve. This is exactly why
///    Phase A publishes `reserve_zat`.
pub fn compute_auction_result(
    bids: Vec<AuditedBid>,
    auction: &AuctionParams,
) -> Result<AuctionResult, AuctionError> {
    let total_collateral_zat = bids.iter().try_fold(0u64, |acc, b| {
        acc.checked_add(b.collateral_zat)
            .ok_or(AuctionError::ArithmeticOverflow)
    })?;
    let invalid_count = bids.iter().filter(|b| b.status != BidStatus::Valid).count();

    let mut effective: Vec<AuditedBid> = bids
        .iter()
        .filter(|b| b.status == BidStatus::Valid && b.bid_zat.is_some())
        .cloned()
        .collect();
    effective.sort_by(compare_bids);

    if effective.is_empty() {
        return Ok(AuctionResult {
            winner: None,
            clearing_price_zat: 0,
            effective_bids: Vec::new(),
            all_bids: bids,
            second_highest_zat: None,
            total_collateral_zat,
            invalid_count,
        });
    }

    let winner = effective[0].clone();
    let second_highest_zat = effective.get(1).and_then(|b| b.bid_zat);
    let raw = second_highest_zat.unwrap_or(0);
    let clearing_price_zat = raw.max(auction.reserve_zat);

    // I5 requires the winner to actually be able to pay.
    if winner.collateral_zat < clearing_price_zat {
        return Err(AuctionError::ReserveUnreachable {
            collateral_zat: winner.collateral_zat,
            clearing_price_zat,
        });
    }

    Ok(AuctionResult {
        winner: Some(winner),
        clearing_price_zat,
        effective_bids: effective,
        all_bids: bids,
        second_highest_zat,
        total_collateral_zat,
        invalid_count,
    })
}

// ---------------------------------------------------------------------------
// Settlement accounting (I5)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineKind {
    Seller,
    Winner,
    Loser,
    /// Invalid or unrevealed: refunded in full, never clawed back.
    Unrevealed,
}

impl LineKind {
    pub fn as_str(self) -> &'static str {
        match self {
            LineKind::Seller => "seller",
            LineKind::Winner => "winner",
            LineKind::Loser => "loser",
            LineKind::Unrevealed => "unrevealed",
        }
    }
}

#[derive(Debug, Clone)]
pub struct SettlementLine {
    pub kind: LineKind,
    pub order_key: Option<String>,
    pub destination: String,
    pub amount_zat: u64,
}

#[derive(Debug, Clone)]
pub struct SettlementPlan {
    pub lines: Vec<SettlementLine>,
    pub change_zat: u64,
    /// Portion of the fee absorbed by seller proceeds.
    pub fee_from_seller_zat: u64,
    /// Fee the escrow could not cover. Non-zero means do NOT broadcast.
    pub unfunded_fee_zat: u64,
    pub balanced: bool,
}

/// Build the single batched transaction.
///
/// The ZIP-317 fee is one per-transaction amount. It is charged against seller
/// proceeds first, then against change, because in a second-price auction the fee
/// naturally belongs to the party that initiated the sale. Bidders are never
/// charged, which is what makes I5 exact for them.
pub fn build_settlement_plan(
    result: &AuctionResult,
    refund_address_for: &dyn Fn(&str) -> String,
    seller_address: &str,
    fee_zat: u64,
) -> Result<SettlementPlan, AuctionError> {
    let mut lines: Vec<SettlementLine> = Vec::new();
    let mut distributed: u64 = 0;
    let mut fee_from_seller_zat: u64 = 0;

    if let Some(w) = &result.winner {
        let amount = w.collateral_zat - result.clearing_price_zat;
        lines.push(SettlementLine {
            kind: LineKind::Winner,
            order_key: Some(w.order_key.clone()),
            destination: refund_address_for(&w.order_key),
            amount_zat: amount,
        });
        distributed = distributed
            .checked_add(amount)
            .ok_or(AuctionError::ArithmeticOverflow)?;

        // Seller absorbs as much of the fee as their proceeds allow. `saturating_sub`
        // handles the case where the clearing price is below the whole fee, in which
        // case the seller takes nothing and the rest falls to change.
        let seller_amount = result.clearing_price_zat.saturating_sub(fee_zat);
        fee_from_seller_zat = result.clearing_price_zat - seller_amount;

        lines.push(SettlementLine {
            kind: LineKind::Seller,
            order_key: None,
            destination: seller_address.to_string(),
            amount_zat: seller_amount,
        });
        distributed = distributed
            .checked_add(seller_amount)
            .ok_or(AuctionError::ArithmeticOverflow)?;
    }

    // Walk ALL bids, not just the effective ones. Dropping an invalid bidder here
    // would silently strand their collateral.
    for bid in &result.all_bids {
        if result.winner.as_ref().is_some_and(|w| w.order_key == bid.order_key) {
            continue;
        }
        lines.push(SettlementLine {
            kind: if bid.status == BidStatus::Valid {
                LineKind::Loser
            } else {
                LineKind::Unrevealed
            },
            order_key: Some(bid.order_key.clone()),
            destination: refund_address_for(&bid.order_key),
            amount_zat: bid.collateral_zat,
        });
        distributed = distributed
            .checked_add(bid.collateral_zat)
            .ok_or(AuctionError::ArithmeticOverflow)?;
    }

    // The fee leaves the escrow exactly once — it is the transaction fee paid to the
    // network. Subtracting it again here when the seller already absorbed it would
    // double-count and overstate change.
    let change_signed = (result.total_collateral_zat as i128)
        - (distributed as i128)
        - (fee_zat as i128);
    let unfunded_fee_zat = if change_signed < 0 {
        (-change_signed) as u64
    } else {
        0
    };

    Ok(SettlementPlan {
        lines,
        change_zat: if change_signed > 0 { change_signed as u64 } else { 0 },
        fee_from_seller_zat,
        unfunded_fee_zat,
        balanced: unfunded_fee_zat == 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SELLER: &str = "utest1seller";
    const ZAT: u64 = 1_000_000;

    fn auction() -> AuctionParams {
        AuctionParams {
            reserve_zat: ZAT,
            h_start: 1000,
            h_end: 1200,
            h_reveal: 1300,
            seller_address: SELLER.to_string(),
        }
    }

    fn bid(height: u32, note_index: u32, collateral: u64, bid_zat: Option<u64>) -> AuditedBid {
        AuditedBid {
            order_key: AuditedBid::order_key(height, note_index),
            height,
            note_index,
            collateral_zat: collateral,
            bid_zat,
            status: BidStatus::Valid,
        }
    }

    fn reveals(pairs: &[(&str, u64)]) -> BTreeMap<String, u64> {
        pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
    }

    #[test]
    fn order_key_is_zero_padded_and_stable() {
        assert_eq!(AuditedBid::order_key(1100, 3), "1100:000003");
        assert_eq!(AuditedBid::order_key(7, 123456), "7:123456");
    }

    #[test]
    fn deadline_check_precedes_solvency_check() {
        let a = auction();
        let b = classify_bid(1300, 0, 1, true, &a);
        assert_eq!(b.status, BidStatus::InvalidLateBlock);
        assert_eq!(b.bid_zat, None);
        for h in [999, 1201] {
            assert_eq!(
                classify_bid(h, 0, 5 * ZAT, true, &a).status,
                BidStatus::InvalidLateBlock
            );
        }
        assert_eq!(classify_bid(1100, 0, 5 * ZAT, true, &a).status, BidStatus::Valid);
        assert_eq!(
            classify_bid(1100, 0, 5 * ZAT, false, &a).status,
            BidStatus::InvalidNoReveal
        );
    }

    #[test]
    fn solvency_boundary_is_inclusive() {
        let bids = vec![bid(1100, 0, 5 * ZAT, None)];
        let r = resolve_bids(bids, &reveals(&[("1100:000000", 5 * ZAT)])).unwrap();
        assert_eq!(r[0].status, BidStatus::Valid);

        let bids = vec![bid(1100, 0, 5 * ZAT - 1, None)];
        let r = resolve_bids(bids, &reveals(&[("1100:000000", 5 * ZAT)])).unwrap();
        assert_eq!(r[0].status, BidStatus::InvalidInsufficientCollateral);
    }

    #[test]
    fn missing_reveal_excludes_the_bid() {
        let bids = vec![bid(1100, 0, 10 * ZAT, None)];
        let r = resolve_bids(bids, &BTreeMap::new()).unwrap();
        assert_eq!(r[0].status, BidStatus::InvalidNoReveal);
        assert_eq!(r[0].bid_zat, None);
    }

    #[test]
    fn clearing_price_is_the_second_highest_bid() {
        let bids = vec![
            bid(1100, 0, 10 * ZAT, None),
            bid(1101, 0, 9 * ZAT, None),
            bid(1102, 0, 5 * ZAT, None),
        ];
        let r = resolve_bids(
            bids,
            &reveals(&[
                ("1100:000000", 10 * ZAT),
                ("1101:000000", 9 * ZAT),
                ("1102:000000", 5 * ZAT),
            ]),
        )
        .unwrap();
        let out = compute_auction_result(r, &auction()).unwrap();
        assert_eq!(out.winner.as_ref().unwrap().order_key, "1100:000000");
        assert_eq!(out.second_highest_zat, Some(9 * ZAT));
        assert_eq!(out.clearing_price_zat, 9 * ZAT);
    }

    #[test]
    fn ties_break_deterministically_regardless_of_input_order() {
        let a = AuctionParams { reserve_zat: 0, ..auction() };
        let mk = |h: u32, i: u32| bid(h, i, 10 * ZAT, Some(7 * ZAT));
        let mut a1 = vec![mk(1105, 0), mk(1100, 0)];
        let mut a2 = vec![mk(1100, 0), mk(1105, 0)];
        for v in [&mut a1, &mut a2] {
            let r = compute_auction_result(v.clone(), &a).unwrap();
            assert_eq!(r.winner.unwrap().order_key, "1100:000000");
        }
        // same height, different index
        let same = vec![mk(1100, 5), mk(1100, 2)];
        let r = compute_auction_result(same, &a).unwrap();
        assert_eq!(r.winner.unwrap().order_key, "1100:000002");
    }

    #[test]
    fn empty_auction_has_no_winner() {
        let r = compute_auction_result(vec![], &auction()).unwrap();
        assert!(r.winner.is_none());
        assert_eq!(r.clearing_price_zat, 0);
        assert_eq!(r.second_highest_zat, None);
    }

    #[test]
    fn single_bidder_wins_at_the_reserve() {
        let bids = vec![bid(1100, 0, 10 * ZAT, None)];
        let r = resolve_bids(bids, &reveals(&[("1100:000000", 9 * ZAT)])).unwrap();
        let a = AuctionParams { reserve_zat: 3 * ZAT, ..auction() };
        let out = compute_auction_result(r, &a).unwrap();
        assert_eq!(out.second_highest_zat, None);
        assert_eq!(out.clearing_price_zat, 3 * ZAT);
    }

    #[test]
    fn unreachable_reserve_is_an_error_not_a_broken_plan() {
        let bids = vec![bid(1100, 0, 1_000, None)];
        let r = resolve_bids(bids, &reveals(&[("1100:000000", 1_000)])).unwrap();
        let a = AuctionParams { reserve_zat: 5 * ZAT, ..auction() };
        assert!(matches!(
            compute_auction_result(r, &a),
            Err(AuctionError::ReserveUnreachable { .. })
        ));
    }

    #[test]
    fn i3_seller_shill_cannot_profit() {
        // Without exclusion the seller's own 10 ZEC bid sets the price at 8 ZEC, which
        // it captures as proceeds and is refunded for free as a "loser".
        let bids = vec![
            bid(1100, 0, 10 * ZAT, None),
            bid(1101, 0, 10 * ZAT, None),
        ];
        let r = resolve_bids(
            bids,
            &reveals(&[("1100:000000", 8 * ZAT), ("1101:000000", 10 * ZAT)]),
        )
        .unwrap();

        // --- naive behaviour ---
        let naive = compute_auction_result(r.clone(), &auction()).unwrap();
        assert_eq!(naive.winner.as_ref().unwrap().order_key, "1101:000000");
        let addr = |_k: &str| "utest1refund".to_string();
        let naive_plan =
            build_settlement_plan(&naive, &addr, SELLER, 0).unwrap();
        let seller_line = naive_plan.lines.iter().find(|l| l.kind == LineKind::Seller).unwrap();
        let self_refund = naive_plan
            .lines
            .iter()
            .find(|l| l.order_key.as_deref() == Some("1101:000000"))
            .unwrap();
        assert_eq!(seller_line.amount_zat, 8 * ZAT);
        assert_eq!(self_refund.amount_zat, 2 * ZAT);
        // Seller is paid 8 and rebated 2, so its 10 ZEC stake cost nothing: it
        // captured the winner's entire 8 ZEC premium.
        let net = seller_line.amount_zat as i64 + self_refund.amount_zat as i64 - (10 * ZAT) as i64;
        assert_eq!(net, 0);

        // --- fixed behaviour ---
        let proofs = [ExclusionProof {
            order_key: "1101:000000".to_string(),
            claimed_address: SELLER.to_string(),
        }];
        let open = |k: &str| Ok(SELLER.to_string());
        let ex = apply_seller_exclusion(r.clone(), &auction(), &proofs, &open);
        assert_eq!(ex.excluded_count, 1);
        assert!(ex.rejected_proofs.is_empty());

        let fixed = compute_auction_result(ex.kept, &auction()).unwrap();
        assert_eq!(fixed.winner.as_ref().unwrap().order_key, "1100:000000");
        assert_eq!(fixed.second_highest_zat, None);
        assert_eq!(fixed.clearing_price_zat, ZAT);
    }

    #[test]
    fn i3_lying_exclusion_proofs_are_rejected() {
        let bids = vec![bid(1100, 0, 10 * ZAT, None), bid(1101, 0, 10 * ZAT, None)];
        let r = resolve_bids(
            bids,
            &reveals(&[("1100:000000", 10 * ZAT), ("1101:000000", 9 * ZAT)]),
        )
        .unwrap();

        // Claims to be the seller, but decrypts to someone else.
        let proofs = [ExclusionProof {
            order_key: "1101:000000".to_string(),
            claimed_address: SELLER.to_string(),
        }];
        let open = |_k: &str| Ok("utest1someoneelse".to_string());
        let ex = apply_seller_exclusion(r.clone(), &auction(), &proofs, &open);
        assert_eq!(ex.rejected_proofs, vec!["1101:000000".to_string()]);
        assert_eq!(ex.excluded_count, 0);
        assert_eq!(ex.kept.len(), 2);

        // Claims a wrong address that happens to match what decrypts.
        let proofs = [ExclusionProof {
            order_key: "1101:000000".to_string(),
            claimed_address: "utest1nottheseller".to_string(),
        }];
        let open = |_k: &str| Ok("utest1nottheseller".to_string());
        let ex = apply_seller_exclusion(r.clone(), &auction(), &proofs, &open);
        assert_eq!(ex.excluded_count, 0);
        assert_eq!(ex.rejected_proofs.len(), 1);

        // Decryption failure is rejected, not fatal.
        let open = |_k: &str| Err("AEAD tag mismatch".to_string());
        let ex = apply_seller_exclusion(r, &auction(), &proofs, &open);
        assert_eq!(ex.rejected_proofs.len(), 1);
        assert_eq!(ex.excluded_count, 0);
    }

    #[test]
    fn i5_every_zatoshi_is_accounted_for() {
        let bids = vec![
            bid(1100, 0, 10 * ZAT, None),
            bid(1101, 0, 8 * ZAT, None),
            bid(1102, 0, 6 * ZAT, None),
            bid(1103, 0, 100_000, None), // 0.1 ZAT vs a 4 ZEC bid
        ];
        let r = resolve_bids(
            bids,
            &reveals(&[
                ("1100:000000", 10 * ZAT),
                ("1101:000000", 8 * ZAT),
                ("1102:000000", 5 * ZAT),
                ("1103:000000", 4 * ZAT),
            ]),
        )
        .unwrap();
        assert_eq!(r[3].status, BidStatus::InvalidInsufficientCollateral);

        let result = compute_auction_result(r, &auction()).unwrap();
        let fee = 15_000;
        let addr = |k: &str| format!("utest1refund-{k}");
        let plan = build_settlement_plan(&result, &addr, SELLER, fee).unwrap();

        assert!(plan.balanced);
        assert_eq!(plan.unfunded_fee_zat, 0);

        let total: u64 = plan.lines.iter().map(|l| l.amount_zat).sum::<u64>()
            + plan.change_zat
            + fee;
        assert_eq!(total, result.total_collateral_zat);

        assert_eq!(result.clearing_price_zat, 8 * ZAT);
        assert_eq!(plan.fee_from_seller_zat, fee);

        let winner = plan.lines.iter().find(|l| l.kind == LineKind::Winner).unwrap();
        assert_eq!(winner.amount_zat, 2 * ZAT);
        let seller = plan.lines.iter().find(|l| l.kind == LineKind::Seller).unwrap();
        assert_eq!(seller.amount_zat, 8 * ZAT - fee);

        // The invalid bidder is refunded IN FULL under an explicit line. Losing a bid
        // to the solvency rule must never cost anything, or it creates a grief vector.
        let refunded = plan.lines.iter().find(|l| l.kind == LineKind::Unrevealed).unwrap();
        assert_eq!(refunded.amount_zat, 100_000);
        assert_eq!(refunded.destination, "utest1refund-1103:000000");
    }

    #[test]
    fn i5_bidders_are_fee_free_and_only_the_seller_pays() {
        let bids = vec![bid(1100, 0, 10 * ZAT, None), bid(1101, 0, 7 * ZAT, None)];
        let r = resolve_bids(
            bids,
            &reveals(&[("1100:000000", 10 * ZAT), ("1101:000000", 7 * ZAT)]),
        )
        .unwrap();
        let result = compute_auction_result(r, &auction()).unwrap();
        let addr = |k: &str| format!("utest1{k}");
        let plan = build_settlement_plan(&result, &addr, SELLER, 1_000).unwrap();

        assert!(plan.balanced);
        let winner = plan.lines.iter().find(|l| l.kind == LineKind::Winner).unwrap();
        // collateral 10, price = second-highest 7
        assert_eq!(winner.amount_zat, 3 * ZAT);
        for l in plan.lines.iter().filter(|l| l.kind == LineKind::Loser) {
            assert_eq!(l.amount_zat, 7 * ZAT);
        }
        assert_eq!(plan.change_zat, 0);
    }

    #[test]
    fn a_fee_larger_than_the_escrow_is_reported_not_dropped() {
        let bids = vec![bid(1100, 0, 100_000, None)];
        let r = resolve_bids(bids, &reveals(&[("1100:000000", 100_000)])).unwrap();
        let a = AuctionParams { reserve_zat: 0, ..auction() };
        let result = compute_auction_result(r, &a).unwrap();
        let addr = |_k: &str| "utest1r".to_string();
        let plan = build_settlement_plan(&result, &addr, SELLER, 50_000).unwrap();
        assert!(!plan.balanced);
        assert_eq!(plan.unfunded_fee_zat, 50_000);
        assert_eq!(plan.change_zat, 0);
    }

    #[test]
    fn all_bids_survives_into_the_result() {
        let bids = vec![
            bid(1100, 0, 10 * ZAT, None),
            bid(1103, 0, 100_000, None),
        ];
        let r = resolve_bids(
            bids,
            &reveals(&[("1100:000000", 10 * ZAT), ("1103:000000", 4 * ZAT)]),
        )
        .unwrap();
        let result = compute_auction_result(r, &auction()).unwrap();
        assert_eq!(result.all_bids.len(), 2);
        assert_eq!(result.effective_bids.len(), 1);
        assert_eq!(result.invalid_count, 1);
        assert_eq!(result.total_collateral_zat, 10 * ZAT + 100_000);
    }

    #[test]
    fn compare_bids_is_a_strict_total_order() {
        let a = bid(1100, 0, 1, Some(5 * ZAT));
        let b = bid(1101, 0, 1, Some(5 * ZAT));
        assert_eq!(compare_bids(&a, &b), Ordering::Less);
        assert_eq!(compare_bids(&b, &a), Ordering::Greater);
        assert_eq!(compare_bids(&a, &a), Ordering::Equal);
        let hi = bid(1, 0, 1, Some(9 * ZAT));
        assert_eq!(compare_bids(&hi, &a), Ordering::Less);
    }
}
