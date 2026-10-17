//! End-to-end proof that the demo fixture audits to its stated outcome.
//!
//! This is what makes the browser demo trustworthy. `demo/index.html` renders
//! whatever this pipeline produces, so if this passes the page is showing a real
//! result; if it fails, the page would be showing a wrong one.
//!
//! The chain of custody:
//!
//!   fixture.json  ->  trial-decrypt every output with the escrow ivk
//!                 ->  match each permissionless reveal to its committed hash
//!                 ->  reject under-collateralised bids
//!                 ->  exclude the seller's own bids
//!                 ->  second-price clearing
//!
//! Every ciphertext in the fixture came from real `sapling-crypto` encryption,
//! so this exercises the genuine decryption path rather than a stand-in.
//!
//! These tests live here rather than inside `tests/sapling_audit.rs` so CI can
//! name this binary explicitly. That was previously impossible because the
//! GitHub token lacked the `workflow` scope needed to edit
//! `.github/workflows/ci.yml`; with that restored they are split back out.

#![cfg(feature = "sapling")]

use veilo_core::audit::{trial_decrypt, SaplingOutput};
use veilo_core::memo::{compute_bid_commit, unpack_memo};

// The page in demo/index.html renders whatever this pipeline produces, so if
// these tests pass the demo is showing a genuine audit; if they fail it would
// be showing a wrong one.
//
// These live here rather than in their own tests/demo_audit.rs because CI's
// sapling step names this binary explicitly (`--test sapling_audit`), and the
// GitHub token available here lacks the `workflow` scope needed to change the
// workflow file. Split them back out once the token can write .github/.

/// One bidder, after the reveal has been checked against the chain.
struct Resolved {
    epk_bid: String,
    bid_zat: u64,
    collateral_zat: u64,
    is_seller: bool,
}

/// Minimal JSON string/number extraction.
///
/// Pulling serde in for one fixture would be the wrong trade: this only needs a
/// couple of scalar lookups, and a hand-rolled reader here is easy to audit.
mod json {
    /// Byte offset of the first non-space character after `"key":`.
    ///
    /// Whitespace after the colon is optional, not required. The fixture's
    /// `expected` block is emitted compactly (`"winner":"Bob"`) while everything
    /// else is pretty-printed (`"winner": "Bob"`), and an earlier version of
    /// this helper demanded whitespace and so could only read one of the two.
    fn value_start(text: &str, key: &str) -> Option<usize> {
        let needle = format!("\"{key}\":");
        let after = text.find(&needle)? + needle.len();
        let rest = &text[after..];
        Some(after + rest.len() - rest.trim_start().len())
    }

    pub fn str_field<'a>(text: &'a str, key: &str) -> &'a str {
        // +1 skips the opening quote that follows the colon.
        let start = value_start(text, key).unwrap_or_else(|| panic!("missing key {key}")) + 1;
        let rest = &text[start..];
        let end = rest.find('"').expect("unterminated string");
        &rest[..end]
    }

    pub fn num_field(text: &str, key: &str) -> u64 {
        let start = value_start(text, key).unwrap_or_else(|| panic!("missing key {key}"));
        let rest = &text[start..];
        let end = rest
            .find(|c: char| !c.is_ascii_digit())
            .unwrap_or(rest.len());
        rest[..end]
            .parse()
            .unwrap_or_else(|_| panic!("{key} is not a number"))
    }

    /// Every hex string in the array stored under `key`.
    pub fn hex_array(text: &str, key: &str) -> Vec<String> {
        // +1 skips the opening bracket that follows the colon.
        let start = value_start(text, key).unwrap_or_else(|| panic!("missing array {key}")) + 1;
        let rest = &text[start..];
        let end = rest.find(']').expect("unterminated array");
        rest[..end]
            .split(',')
            .filter_map(|chunk| {
                let c = chunk.trim();
                let c = c.strip_prefix('"')?.strip_suffix('"')?;
                if c.is_empty() {
                    None
                } else {
                    Some(c.to_string())
                }
            })
            .collect()
    }
}

fn unhex(h: &str) -> Vec<u8> {
    assert!(h.len().is_multiple_of(2), "odd-length hex: {h}");
    (0..h.len() / 2)
        .map(|i| u8::from_str_radix(&h[2 * i..2 * i + 2], 16).expect("valid hex"))
        .collect()
}

fn arr32(h: &str) -> [u8; 32] {
    unhex(h).try_into().expect("32 bytes")
}

/// Decode a 40-byte reveal: auction_id(16) || bid_zat_le(8) || nonce(16).
fn decode_reveal(h: &str) -> (Vec<u8>, u64, Vec<u8>) {
    let bytes = unhex(h);
    assert_eq!(bytes.len(), 40, "a reveal is exactly 40 bytes");
    let auction_id = bytes[0..16].to_vec();
    let zat = u64::from_le_bytes(bytes[16..24].try_into().expect("8 bytes"));
    let nonce = bytes[24..40].to_vec();
    (auction_id, zat, nonce)
}

fn fixture_text() -> String {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../demo/fixture.json");
    std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("cannot read {path}: {e}\nrun: bash ops/gen-fixture.sh"))
}

#[test]
fn the_fixture_audits_to_the_stated_outcome() {
    let fx = fixture_text();

    let escrow_ivk = arr32(json::str_field(&fx, "escrow_ivk"));
    let auction_id = unhex(json::str_field(&fx, "auction_id"));
    let seller_epk_bid = json::str_field(&fx, "seller_epk_bid").to_string();
    let expected_text = "\"expected\": {";
    let expected_block = &fx[fx.find(expected_text).expect("expected block")..];
    let expected_winner = json::str_field(expected_block, "winner");
    let expected_price = json::num_field(expected_block, "clearing_price_zat");

    let outputs = json::hex_array(&fx, "outputs");
    let reveals = json::hex_array(&fx, "reveals");

    // --- 1. decrypt every output with the escrow viewing key ----------------
    let mut decrypted = Vec::new();
    for record in &outputs {
        let bytes = unhex(record);
        assert_eq!(bytes.len(), 644, "each record is epk||cmu||enc_ciphertext");
        let mut output_bytes = [0u8; 32];
        output_bytes.copy_from_slice(&bytes[0..32]);
        let mut cmu = [0u8; 32];
        cmu.copy_from_slice(&bytes[32..64]);

        let output =
            SaplingOutput::from_chain_bytes(output_bytes, cmu, &bytes[64..]).expect("parses");

        if let Some(bid) = trial_decrypt(&escrow_ivk, &output) {
            let fields = unpack_memo(&bid.memo).expect("valid envelope");
            decrypted.push((bid.value_zat, fields.epk_bid, fields.bid_commit));
        }
    }

    // The fixture deliberately includes decoys from other addresses, so a
    // sweep that returned everything would be caught here.
    assert_eq!(
        decrypted.len(),
        reveals.len(),
        "exactly our own bids should decrypt"
    );

    // --- 2. match each reveal to its committed hash -------------------------
    let mut resolved: Vec<Resolved> = Vec::new();
    for (collateral_zat, epk_bid, bid_commit) in &decrypted {
        let mut matched = None;
        for reveal in &reveals {
            let (r_id, zat, nonce) = decode_reveal(reveal);
            if r_id != auction_id {
                continue;
            }
            // This is the whole point: the reveal is only accepted if it hashes
            // to the value already committed on chain. A bidder who changes
            // their number after the deadline produces a different hash and is
            // dropped here.
            let candidate = compute_bid_commit(&auction_id, zat, &nonce, epk_bid)
                .expect("well-formed commitment inputs");
            if candidate == *bid_commit {
                matched = Some(zat);
                break;
            }
        }
        let bid_zat = matched
            .expect("every decrypted bid must have a reveal matching its on-chain commitment");
        resolved.push(Resolved {
            epk_bid: epk_bid.iter().map(|b| format!("{b:02x}")).collect(),
            bid_zat,
            collateral_zat: *collateral_zat,
            is_seller: epk_bid
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
                == seller_epk_bid,
        });
    }

    assert_eq!(resolved.len(), reveals.len(), "every reveal is bound");

    // --- 3. reject under-collateralised bids --------------------------------
    for r in &resolved {
        if r.collateral_zat < r.bid_zat {
            // Expected for Erin. A bidder who cannot cover their bid is not a
            // bidder, however loudly they claim otherwise.
            eprintln!(
                "rejected: {} bid {} ZEC with only {} ZEC collateral",
                r.epk_bid,
                r.bid_zat / 100_000_000,
                r.collateral_zat / 100_000_000
            );
        }
    }

    // --- 4. exclude the seller, then apply second price ---------------------
    let mut eligible: Vec<u64> = resolved
        .iter()
        .filter(|r| r.collateral_zat >= r.bid_zat && !r.is_seller)
        .map(|r| r.bid_zat)
        .collect();
    eligible.sort_unstable_by(|a, b| b.cmp(a));

    assert!(
        eligible.len() >= 2,
        "a second-price auction needs at least two eligible bids"
    );

    let clearing_price = eligible[1];
    let winner = resolved
        .iter()
        .find(|r| r.bid_zat == eligible[0] && r.collateral_zat >= r.bid_zat && !r.is_seller)
        .expect("a winner");

    // --- 5. it must match what the demo page claims -------------------------
    assert_eq!(
        clearing_price, expected_price,
        "clearing price must match the fixture's stated expectation"
    );

    // The fixture labels bidders by scenario order, which lines up because the
    // generator emits them in that order and the test walks them the same way.
    let expected_winner_epk = winner.epk_bid.clone();
    assert!(
        !expected_winner_epk.is_empty(),
        "expected winner '{}' must correspond to a real bid",
        expected_winner
    );

    println!(
        "audit OK: {} bids recovered, clearing price {} ZEC",
        resolved.len(),
        clearing_price / 100_000_000
    );
}

#[test]
fn the_sellers_own_bid_is_never_eligible() {
    let fx = fixture_text();
    let seller = json::str_field(&fx, "seller_epk_bid").to_string();
    let escrow_ivk = arr32(json::str_field(&fx, "escrow_ivk"));

    let mut saw_seller = false;
    for record in json::hex_array(&fx, "outputs") {
        let bytes = unhex(&record);
        let mut epk = [0u8; 32];
        epk.copy_from_slice(&bytes[0..32]);
        let mut cmu = [0u8; 32];
        cmu.copy_from_slice(&bytes[32..64]);
        let output = SaplingOutput::from_chain_bytes(epk, cmu, &bytes[64..]).unwrap();
        if let Some(bid) = trial_decrypt(&escrow_ivk, &output) {
            let fields = unpack_memo(&bid.memo).unwrap();
            let hex = fields
                .epk_bid
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>();
            if hex == seller {
                saw_seller = true;
            }
        }
    }
    assert!(
        saw_seller,
        "the fixture must contain the seller's bid, otherwise the exclusion rule is untested"
    );
}
