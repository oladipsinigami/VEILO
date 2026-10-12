//! Replay the TypeScript-generated auction scenarios against the Rust implementation.
//!
//! Companion to `replay.rs`. The memo codec test proves the two languages agree on
//! bytes; this one proves they agree on *consequences* — who wins, what the clearing
//! price is, which bids are rejected, and who gets paid. A divergence here would let
//! a bidder's browser and the settlement engine disagree about a transfer of funds.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use veilo_core::auction::*;

/// Parse the dependency-free key=value format into ordered scenario blocks.
fn load_scenarios() -> Vec<(String, Vec<(String, String)>)> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("test")
        .join("auction-vectors.txt");
    let text = fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "cannot read {}: {e}\nrun: node test/gen-auction-vectors.mjs",
            path.display()
        )
    });

    let mut out = Vec::new();
    let mut name: Option<String> = None;
    let mut fields: Vec<(String, String)> = Vec::new();

    // A block starts at a `scenario=<name>` line. Comments and blank lines are
    // skipped; a trailing block is flushed at EOF. Note the name arrives AS A KEY,
    // not as a bare line — an earlier version split on "line has no '='", which
    // silently parsed zero scenarios.
    for line in text.lines() {
        let line = line.trim_end();
        if line.starts_with('#') || line.is_empty() {
            continue;
        }
        let (k, v) = line.split_once('=').expect("every line is key=value");
        if k == "scenario" {
            if let Some(n) = name.take() {
                out.push((n, std::mem::take(&mut fields)));
            }
            name = Some(v.to_string());
        } else {
            fields.push((k.to_string(), v.to_string()));
        }
    }
    if let Some(n) = name.take() {
        out.push((n, fields));
    }

    assert!(
        !out.is_empty(),
        "no scenarios parsed from {}",
        path.display()
    );
    out
}

struct Scenario {
    name: String,
    f: BTreeMap<String, String>,
}

impl Scenario {
    fn get(&self, k: &str) -> &str {
        self.f.get(k).map_or("", |s| s.as_str())
    }
    fn get_u64(&self, k: &str) -> u64 {
        self.get(k)
            .parse()
            .unwrap_or_else(|_| panic!("{}/{} is not a u64", self.name, k))
    }
    fn get_usize(&self, k: &str) -> usize {
        self.get_u64(k) as usize
    }
    fn get_bool(&self, k: &str) -> bool {
        self.get(k) == "true"
    }
}

fn parse_status(s: &str) -> BidStatus {
    match s {
        "Valid" => BidStatus::Valid,
        "InvalidInsufficientCollateral" => BidStatus::InvalidInsufficientCollateral,
        "InvalidNoReveal" => BidStatus::InvalidNoReveal,
        "InvalidRevealMismatch" => BidStatus::InvalidRevealMismatch,
        "InvalidLateBlock" => BidStatus::InvalidLateBlock,
        "ExcludedSeller" => BidStatus::ExcludedSeller,
        other => panic!("unknown status {other}"),
    }
}

#[test]
fn rust_reproduces_typescript_auction_outcomes() {
    let scenarios: Vec<Scenario> = load_scenarios()
        .into_iter()
        .map(|(name, kv)| Scenario {
            name,
            f: kv.into_iter().collect(),
        })
        .collect();

    assert!(
        scenarios.len() >= 14,
        "expected at least 14 scenarios, found {}",
        scenarios.len()
    );

    for s in &scenarios {
        let auction = AuctionParams {
            reserve_zat: s.get_u64("reserve"),
            h_start: s.get_u64("h_start") as u32,
            h_end: s.get_u64("h_end") as u32,
            h_reveal: s.get_u64("h_end") as u32 + 100,
            seller_address: s.get("seller").to_string(),
        };

        // Rebuild the raw notes.
        let nbids = s.get_usize("nbids");
        let mut classified = Vec::with_capacity(nbids);
        for i in 0..nbids {
            let p = format!("bid_{i}_");
            let height = s.get(&format!("{p}height")).parse().unwrap();
            let note_index = s.get(&format!("{p}index")).parse().unwrap();
            let collateral = s.get_u64(&format!("{p}collateral"));
            // A reveal was published iff the vector carries a non-empty bid value.
            let reveal_valid = !s.get(&format!("{p}bid")).is_empty();
            classified.push(classify_bid(
                height,
                note_index,
                collateral,
                reveal_valid,
                &auction,
            ));
        }

        let mut reveals = BTreeMap::new();
        for (key, v) in &s.f {
            if let Some(key) = key.strip_prefix("reveal_") {
                reveals.insert(key.to_string(), v.parse().unwrap());
            }
        }

        let resolved = resolve_bids(classified, &reveals)
            .unwrap_or_else(|e| panic!("{}: resolve: {e}", s.name));

        // Per-bid classification must match.
        for (i, bid) in resolved.iter().enumerate() {
            let p = format!("bid_{i}_");
            assert_eq!(
                bid.status,
                parse_status(s.get(&format!("{p}status"))),
                "{}: bid {i} status",
                s.name
            );
            let expected_bid = s.get(&format!("{p}bid"));
            let expected = if expected_bid.is_empty() {
                None
            } else {
                Some(expected_bid.parse::<u64>().unwrap())
            };
            assert_eq!(bid.bid_zat, expected, "{}: bid {i} amount", s.name);
            assert_eq!(
                bid.order_key,
                s.get(&format!("{p}key")),
                "{}: bid {i} key",
                s.name
            );
        }

        // Exclusion.
        let mut proofs = Vec::new();
        for i in 0..s.get_usize("nproofs") {
            proofs.push(ExclusionProof {
                order_key: s.get(&format!("proof_{i}_key")).to_string(),
                claimed_address: s.get(&format!("proof_{i}_claimed")).to_string(),
            });
        }
        // Capture the per-proof outcome so the closure can report it deterministically.
        let opened_map: Vec<(String, Option<String>, bool)> = (0..s.get_usize("nproofs"))
            .map(|i| {
                (
                    s.get(&format!("proof_{i}_key")).to_string(),
                    {
                        let o = s.get(&format!("proof_{i}_opened"));
                        if o.is_empty() {
                            None
                        } else {
                            Some(o.to_string())
                        }
                    },
                    s.get_bool(&format!("proof_{i}_fails")),
                )
            })
            .collect();

        let open = move |key: &str| -> Result<String, String> {
            let (_, opened, fails) = opened_map
                .iter()
                .find(|(k, _, _)| k == key)
                .expect("proof key present");
            if *fails {
                return Err("AEAD tag mismatch".to_string());
            }
            opened.clone().ok_or_else(|| "no address".to_string())
        };

        let excluded = apply_seller_exclusion(resolved.clone(), &auction, &proofs, &open);
        assert_eq!(
            excluded.excluded_count,
            s.get_usize("excluded_count"),
            "{}: excluded count",
            s.name
        );
        assert_eq!(
            excluded.rejected_proofs.join(","),
            s.get("rejected_proofs"),
            "{}: rejected proofs",
            s.name
        );

        // Pricing.
        let result = compute_auction_result(excluded.kept.clone(), &auction)
            .unwrap_or_else(|e| panic!("{}: pricing: {e}", s.name));
        assert_eq!(
            result
                .winner
                .as_ref()
                .map(|w| w.order_key.as_str())
                .unwrap_or(""),
            s.get("exp_winner"),
            "{}: winner",
            s.name
        );
        assert_eq!(
            result.clearing_price_zat,
            s.get_u64("exp_clearing"),
            "{}: clearing price",
            s.name
        );
        let expected_second = s.get("exp_second");
        assert_eq!(
            result.second_highest_zat,
            if expected_second.is_empty() {
                None
            } else {
                Some(expected_second.parse().unwrap())
            },
            "{}: second price",
            s.name
        );
        assert_eq!(
            result.total_collateral_zat,
            s.get_u64("exp_total"),
            "{}: total collateral",
            s.name
        );
        assert_eq!(
            result.invalid_count,
            s.get_usize("exp_invalid"),
            "{}: invalid count",
            s.name
        );

        // Settlement.
        let addr = |k: &str| format!("utest1refund-{k}");
        let plan = build_settlement_plan(&result, &addr, s.get("seller"), s.get_u64("fee"))
            .unwrap_or_else(|e| panic!("{}: settlement: {e}", s.name));

        assert_eq!(
            plan.lines.len(),
            s.get_usize("nlines"),
            "{}: line count",
            s.name
        );
        for (i, l) in plan.lines.iter().enumerate() {
            let expected = format!(
                "{}|{}|{}|{}",
                l.kind.as_str(),
                l.order_key.clone().unwrap_or_default(),
                l.destination,
                l.amount_zat
            );
            assert_eq!(
                expected,
                s.get(&format!("line_{i}")),
                "{}: line {i}",
                s.name
            );
        }
        assert_eq!(
            plan.change_zat,
            s.get_u64("exp_change"),
            "{}: change",
            s.name
        );
        assert_eq!(
            plan.fee_from_seller_zat,
            s.get_u64("exp_fee_from_seller"),
            "{}: fee from seller",
            s.name
        );
        assert_eq!(
            plan.unfunded_fee_zat,
            s.get_u64("exp_unfunded"),
            "{}: unfunded fee",
            s.name
        );
        assert_eq!(
            plan.balanced,
            s.get_bool("exp_balanced"),
            "{}: balanced",
            s.name
        );

        // Every scenario must conserve value, whatever it was testing.
        // The fee leaves the escrow exactly once, and any part of it the escrow
        // cannot cover is an external obligation rather than a redistribution, so it
        // sits on the right-hand side: lines + change + fee == total + unfunded.
        let sum: u64 = plan.lines.iter().map(|l| l.amount_zat).sum();
        assert_eq!(
            sum + plan.change_zat + s.get_u64("fee"),
            result.total_collateral_zat + plan.unfunded_fee_zat,
            "{}: zatoshi conserved",
            s.name
        );
    }
}

#[test]
fn scenarios_cover_the_attack_and_the_degenerate_cases() {
    let scenarios = load_scenarios();
    let names: Vec<String> = scenarios.iter().map(|(n, _)| n.clone()).collect();

    for required in [
        "seller_shill_excluded",
        "seller_shill_proof_lying",
        "seller_shill_proof_fails_to_open",
        "invalid_bids_refunded",
        "solvency_boundary_equal",
        "solvency_boundary_short",
        "late_block_excluded",
        "no_bids",
        "single_bidder_reserve",
        "reserve_floors_price",
        "fee_exceeds_escrow",
        "tie_break_by_height",
        "tie_break_by_index",
    ] {
        assert!(
            names.iter().any(|n| n == required),
            "scenario file is missing required coverage: {required}"
        );
    }
}

/// The two shill scenarios must disagree, or the exclusion rule proves nothing.
#[test]
fn exclusion_actually_changes_the_outcome() {
    let scenarios = load_scenarios();
    let find = |name: &str| -> BTreeMap<String, String> {
        scenarios
            .iter()
            .find(|(n, _)| n == name)
            .unwrap_or_else(|| panic!("missing scenario {name}"))
            .1
            .iter()
            .cloned()
            .collect()
    };

    let honest = find("seller_shill_excluded");
    let lying = find("seller_shill_proof_lying");

    assert_eq!(honest["excluded_count"], "1");
    assert_eq!(lying["excluded_count"], "0");

    // With the proof, the real bidder wins at the reserve...
    assert_eq!(honest["exp_winner"], "1100:000000");
    assert_eq!(honest["exp_clearing"], "1000000");

    // Without it, the seller's shill wins and inflates the price to 8 ZEC.
    // This is the attack that forced Revision 2, so it must stay reproducible.
    assert_eq!(lying["exp_winner"], "1101:000000");
    assert_eq!(lying["exp_clearing"], "8000000");

    assert_ne!(honest["exp_clearing"], lying["exp_clearing"]);
}
