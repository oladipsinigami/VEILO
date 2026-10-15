//! Spike A: does the audit path actually work?
//!
//! The claim under test is Veilo's central one -- an auditor holding only the
//! escrow's *incoming viewing key* can recover a bid from a Sapling output, with
//! no spending key anywhere in the picture.
//!
//! To make this worth asserting, the output is built with the real
//! `sapling-crypto` encryption path and a real Veilo 512-byte envelope. A test
//! against a mock cipher would pass forever and prove nothing.
//!
//! Run with:
//!   cargo test -p veilo-core --features sapling --test sapling_audit

// Everything below needs the `sapling` feature. Without the gate, a plain
// `cargo test -p veilo-core` fails to compile this file rather than skipping
// it, which makes the default (cheap) build fail for no good reason.
#![cfg(feature = "sapling")]

use sapling_crypto::keys::{Diversifier, SaplingIvk};
use sapling_crypto::note::{Note, Rseed};
use sapling_crypto::note_encryption::{sapling_note_encryption, SaplingDomain};
use sapling_crypto::value::NoteValue;
use veilo_core::audit::{trial_decrypt, SaplingOutput, COMPACT_NOTE_SIZE, ENC_CIPHERTEXT_SIZE};
use veilo_core::memo::{compute_bid_commit, pack_memo, unpack_memo, MemoFields, MEMO_SIZE};
use zcash_note_encryption::Domain;

use rand::rngs::StdRng;
use rand::SeedableRng;

/// A valid incoming viewing key: scalar 1, which is inside {1 .. 2^251-1}.
/// Smallest legal value, so nothing here depends on a real wallet's key.
const ESCROW_IVK: [u8; 32] = [1u8; 32];

/// A *different* valid viewing key, for the negative control.
const WRONG_IVK: [u8; 32] = [2u8; 32];

fn veilo_envelope() -> [u8; MEMO_SIZE] {
    pack_memo(&MemoFields {
        auction_id: [0xA1; 16],
        epk_bid: [0xB2; 32],
        epk_refund: [0xC3; 32],
        bid_commit: [0xD4; 32],
        // A sealed refund ciphertext, exactly as the bid path would carry it.
        c_refund: [0xE5; 232],
    })
}

/// First diversifier whose `g_d` lands on the curve.
///
/// Roughly one in eight 11-byte values is a usable diversifier, so this
/// terminates in a handful of tries. Doing it here rather than hardcoding a
/// literal means the test cannot silently rot against a curve change.
fn first_valid_diversifier() -> Diversifier {
    for n in 0u16..10_000 {
        let mut bytes = [0u8; 11];
        bytes[0] = n as u8;
        bytes[1] = (n >> 8) as u8;
        let d = Diversifier(bytes);
        if d.g_d().is_some() {
            return d;
        }
    }
    panic!("no valid diversifier found in 10000 candidates");
}

/// Seal a real Sapling output paying `memo` to the escrow address.
///
/// Returns the chain-shaped bytes exactly as a block parser would see them,
/// plus the ciphertext, so the test can assert on both the round trip and the
/// rejection paths.
fn seal_output(
    value_zat: u64,
    memo: [u8; MEMO_SIZE],
    rng: &mut StdRng,
) -> ([u8; 32], [u8; 32], [u8; ENC_CIPHERTEXT_SIZE]) {
    let ivk = SaplingIvk::from_bytes(&ESCROW_IVK).expect("ESCROW_IVK is a valid ivk");
    let address = ivk
        .to_payment_address(first_valid_diversifier())
        .expect("valid address");

    // AfterZip212 keeps this deterministic: the note randomness is fixed rather
    // than drawn from the rng, so a failure is reproducible.
    let note = Note::from_parts(
        address,
        NoteValue::from_raw(value_zat),
        Rseed::AfterZip212([9u8; 32]),
    );

    // The note commitment belongs in the output description, so read it before
    // `sapling_note_encryption` consumes the note.
    let cmu = note.cmu().to_bytes();

    // ovk = None means the sender did not want the note recoverable; trial
    // decryption by the recipient does not depend on it. Passing None keeps the
    // test from having to conjure an OutgoingViewingKey it never uses.
    let encrypted = sapling_note_encryption(None, note, memo, rng);

    // `EphemeralPublicKey::to_bytes` is pub(crate); the public route to the
    // chain encoding is the Domain trait's `epk_bytes`. This is test-only
    // scaffolding: the auditor never constructs an output, it reads the epk
    // off the chain, so it never needs this direction at all.
    let epk = <SaplingDomain as Domain>::epk_bytes(encrypted.epk());
    let ciphertext = encrypted.encrypt_note_plaintext().0;

    (epk.0, cmu, ciphertext)
}

#[test]
fn trial_decryption_recovers_value_and_veilo_memo() {
    let memo = veilo_envelope();
    let value = 12_345_678u64;
    let mut rng = StdRng::from_seed([42u8; 32]);

    let (epk, cmu, ciphertext) = seal_output(value, memo, &mut rng);

    // The ciphertext really is a full 580-byte encCiphertext.
    assert_eq!(ciphertext.len(), ENC_CIPHERTEXT_SIZE);

    let output = SaplingOutput::from_chain_bytes(epk, cmu, &ciphertext)
        .expect("full ciphertext parses as a Sapling output");

    let bid = trial_decrypt(&ESCROW_IVK, &output).expect("our output must decrypt for us");

    assert_eq!(
        bid.value_zat, value,
        "note value must survive the round trip"
    );
    assert_eq!(
        bid.memo, memo,
        "the whole 512-byte envelope must survive intact"
    );

    // And it is still a valid Veilo envelope, not just matching bytes: parse it
    // back through the real parser so a layout regression cannot hide here.
    let parsed =
        veilo_core::memo::unpack_memo(&bid.memo).expect("recovered memo is a valid envelope");
    assert_eq!(parsed.bid_commit, [0xD4; 32]);
    assert_eq!(parsed.auction_id, [0xA1; 16]);
}

#[test]
fn wrong_viewing_key_decrypts_nothing() {
    let memo = veilo_envelope();
    let mut rng = StdRng::from_seed([7u8; 32]);
    let (epk, cmu, ciphertext) = seal_output(1_000, memo, &mut rng);

    let output = SaplingOutput::from_chain_bytes(epk, cmu, &ciphertext).unwrap();

    // This is the property the entire auction rests on: a key that is not ours
    // yields nothing. There is no "partially correct" answer to fall back on.
    assert!(
        trial_decrypt(&WRONG_IVK, &output).is_none(),
        "an unrelated viewing key must not recover a bid"
    );
}

#[test]
fn compact_output_is_rejected_rather_than_silently_empty() {
    let memo = veilo_envelope();
    let mut rng = StdRng::from_seed([11u8; 32]);
    let (epk, cmu, ciphertext) = seal_output(1_000, memo, &mut rng);

    // The 52-byte compact form has no memo. Refusing it loudly is the point:
    // a lightwalletd-only pipeline would hand the auditor exactly this, and
    // quietly treating it as "no bid" would look identical to a real miss.
    let compact = &ciphertext[..COMPACT_NOTE_SIZE];
    assert_eq!(compact.len(), COMPACT_NOTE_SIZE);
    assert!(
        SaplingOutput::from_chain_bytes(epk, cmu, compact).is_none(),
        "a compact ciphertext must be rejected, not parsed"
    );
}

#[test]
fn every_memo_byte_is_carried_through_the_ciphertext() {
    // The envelope occupies the entire 512-byte memo field with no headroom.
    // Prove that with a maximally distinct pattern so a single dropped byte
    // cannot hide.
    let mut memo = [0u8; MEMO_SIZE];
    for (i, b) in memo.iter_mut().enumerate() {
        *b = (i % 251) as u8;
    }
    let value = 999_999u64;
    let mut rng = StdRng::from_seed([3u8; 32]);

    let (epk, cmu, ciphertext) = seal_output(value, memo, &mut rng);
    let output = SaplingOutput::from_chain_bytes(epk, cmu, &ciphertext).unwrap();
    let bid = trial_decrypt(&ESCROW_IVK, &output).expect("decrypts");

    assert_eq!(bid.memo, memo, "all 512 memo bytes must round-trip");
    assert_eq!(bid.value_zat, value);
}
#[test]
fn scanning_a_range_keeps_ours_and_drops_the_rest() {
    // The shape of the real auditor: a block range full of outputs, of which
    // only some are ours. Nothing labels them in advance, so the sweep itself
    // has to be the filter.
    let mut rng = StdRng::from_seed([5u8; 32]);

    let (our_epk, our_cmu, our_ct) = seal_output(1_000_000, veilo_envelope(), &mut rng);
    let ours = SaplingOutput::from_chain_bytes(our_epk, our_cmu, &our_ct).unwrap();

    // Two decoys from a different recipient, built off a different view key.
    let mut decoys = Vec::new();
    for seed in 1u8..=2 {
        // Byte 31 must have its top five bits clear for the scalar to fall inside
        // {1 .. 2^251 - 1}, so fill only the low bytes and pin the top one.
        let mut other_bytes = [0u8; 32];
        other_bytes[..31].fill(100u8 + seed);
        other_bytes[31] = seed;
        let other_ivk = SaplingIvk::from_bytes(&other_bytes).unwrap();
        let address = other_ivk
            .to_payment_address(first_valid_diversifier())
            .unwrap();
        let note = Note::from_parts(
            address,
            NoteValue::from_raw(7 * seed as u64),
            Rseed::AfterZip212([seed; 32]),
        );
        let cmu = note.cmu().to_bytes();
        let enc = sapling_note_encryption(None, note, [seed; 512], &mut rng);
        let epk = <SaplingDomain as Domain>::epk_bytes(enc.epk());
        let ct = enc.encrypt_note_plaintext().0;
        decoys.push(SaplingOutput::from_chain_bytes(epk.0, cmu, &ct).unwrap());
    }

    // Interleave them so position cannot be what makes the selection work.
    let range = vec![decoys[0].clone(), ours.clone(), decoys[1].clone()];
    let found = veilo_core::audit::scan_range(&ESCROW_IVK, range);

    assert_eq!(found.len(), 1, "exactly one bid should survive the sweep");
    assert_eq!(found[0].value_zat, 1_000_000);
    assert_eq!(found[0].memo, veilo_envelope());
}

#[test]
fn an_empty_range_yields_no_bids_rather_than_erroring() {
    assert!(veilo_core::audit::scan_range(&ESCROW_IVK, Vec::new()).is_empty());
}

// ---------------------------------------------------------------------------
// Demo fixture: end-to-end proof that the browser page shows a real result
// ---------------------------------------------------------------------------
//
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
    /// Find `"key":` allowing any amount of whitespace after the colon.
    ///
    /// Hand-rolled readers usually assume one exact separator and then fail on
    /// a file that is merely formatted differently -- which is exactly what
    /// happened here: the fixture's `expected` block is emitted compactly while
    /// everything else is pretty-printed.
    fn key_start(text: &str, key: &str) -> Option<usize> {
        let needle = format!("\"{key}\":");
        let mut from = 0;
        while let Some(rel) = text[from..].find(&needle) {
            let at = from + rel + needle.len();
            if text[at..].starts_with(|c: char| c.is_whitespace()) {
                return Some(at + text[at..].len() - text[at..].trim_start().len());
            }
            from += rel + needle.len();
        }
        None
    }

    pub fn str_field<'a>(text: &'a str, key: &str) -> &'a str {
        // +1 skips the opening quote that follows the colon.
        let start = key_start(text, key).unwrap_or_else(|| panic!("missing key {key}")) + 1;
        let rest = &text[start..];
        let end = rest.find('"').expect("unterminated string");
        &rest[..end]
    }

    pub fn num_field(text: &str, key: &str) -> u64 {
        let start = key_start(text, key).unwrap_or_else(|| panic!("missing key {key}"));
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
        let start = key_start(text, key).unwrap_or_else(|| panic!("missing array {key}")) + 1;
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
    let expected_block = &fx[fx.find(&expected_text).expect("expected block")..];
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
        let bid_zat = matched.expect(
            "every decrypted bid must have a reveal matching its on-chain commitment",
        );
        resolved.push(Resolved {
            epk_bid: epk_bid.iter().map(|b| format!("{b:02x}")).collect(),
            bid_zat,
            collateral_zat: *collateral_zat,
            is_seller: epk_bid.iter().map(|b| format!("{b:02x}")).collect::<String>() == seller_epk_bid,
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
            let hex = fields.epk_bid.iter().map(|b| format!("{b:02x}")).collect::<String>();
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
