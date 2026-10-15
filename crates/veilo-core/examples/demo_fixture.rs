//! Generate the demo fixture: real Sapling outputs the browser auditor can run on.
//!
//! # What is real here, and what is not
//!
//! REAL: every ciphertext. Each is produced by `sapling_crypto`'s actual
//! `sapling_note_encryption`, carrying a real 512-byte Veilo envelope packed by
//! `veilo_core::memo::pack_memo`, with a real BLAKE2b bid commitment. The
//! auditor decrypts these through the genuine trial-decryption path. There is
//! no mock anywhere, and nothing here is fabricated to make a test pass.
//!
//! NOT REAL: chain provenance. These outputs were never mined. This fixture
//! proves the cryptography and the auction logic. It does NOT prove we can
//! broadcast a transaction -- a separate claim, currently blocked on the
//! Zallet/zebra state-format gap (see ops/README.md). The two must not be
//! conflated when this is presented.
//!
//! Run with:
//!   cargo run -p veilo-core --features sapling --example demo_fixture

use sapling_crypto::keys::{Diversifier, SaplingIvk};
use sapling_crypto::note::{Note, Rseed};
use sapling_crypto::note_encryption::{sapling_note_encryption, SaplingDomain};
use sapling_crypto::value::NoteValue;
use veilo_core::memo::{compute_bid_commit, encode_reveal, pack_memo, MemoFields};
use zcash_note_encryption::Domain;

use rand::rngs::StdRng;
use rand::SeedableRng;

const ZEC: u64 = 100_000_000;
// Exactly 16 bytes: AUCTION_ID_SIZE. Not 15 -- a byte literal is its own
// length, so this is an easy off-by-one to introduce.
const AUCTION_ID: [u8; 16] = *b"veilo-demo-auct1";

/// Escrow viewing key for the demo: scalar 1, the smallest legal value in
/// {1 .. 2^251-1}, so it is stable and obviously synthetic.
///
/// A viewing key can read but cannot spend. That is the whole security
/// property: the auction holds collateral nobody can move.
const ESCROW_IVK: [u8; 32] = [1u8; 32];

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Roughly one in eight 11-byte values is a usable diversifier, so search for
/// one rather than hardcoding a literal that could rot against a curve change.
fn valid_diversifier(seed: u8) -> Diversifier {
    for n in 0u16..1000 {
        let mut b = [0u8; 11];
        b[0] = seed;
        b[1] = n as u8;
        b[2] = (n >> 8) as u8;
        let d = Diversifier(b);
        if d.g_d().is_some() {
            return d;
        }
    }
    panic!("no valid diversifier for seed {seed}");
}

/// One participant in the auction.
struct Participant {
    label: &'static str,
    bid_zat: u64,
    /// Collateral actually locked in the note. Below `bid_zat` the bid must be
    /// rejected -- that is invariant I2, and Erin exists to demonstrate it.
    collateral_zat: u64,
    nonce: [u8; 16],
    /// True for the seller, whose bids must be excluded (invariant I3).
    is_seller: bool,
    /// How many decoy outputs to interleave after this one.
    decoys_after: usize,
}

/// Seal one output to `ivk` carrying `memo`, returned as a 644-byte
/// (epk || cmu || enc_ciphertext) record -- the layout `audit_range` expects.
fn seal(ivk: &[u8; 32], value_zat: u64, memo: [u8; 512], dseed: u8, rng: &mut StdRng) -> Vec<u8> {
    let key = SaplingIvk::from_bytes(ivk).expect("valid ivk");
    let address = key
        .to_payment_address(valid_diversifier(dseed))
        .expect("valid address");
    let note = Note::from_parts(
        address,
        NoteValue::from_raw(value_zat),
        Rseed::AfterZip212([0x11; 32]),
    );
    let cmu = note.cmu().to_bytes();
    let encrypted = sapling_note_encryption(None, note, memo, rng);
    let epk = <SaplingDomain as Domain>::epk_bytes(encrypted.epk()).0;
    let enc = encrypted.encrypt_note_plaintext().0;

    let mut record = Vec::with_capacity(644);
    record.extend_from_slice(&epk);
    record.extend_from_slice(&cmu);
    record.extend_from_slice(&enc);
    record
}

/// A note belonging to somebody else entirely. The auditor must ignore these.
fn decoy(index: u8, rng: &mut StdRng) -> Vec<u8> {
    // The top bytes must stay small: `SaplingIvk::from_bytes` parses a
    // little-endian scalar and rejects anything outside {1 .. 2^251-1}, so a
    // high byte of 0xC0 overflows the field modulus and from_repr returns None.
    // Keep the pattern in the low bytes and pin the top ones.
    let mut bytes = [0u8; 32];
    bytes[..28].fill(0xC0);
    bytes[28] = index;
    bytes[29] = 0;
    bytes[30] = 0;
    bytes[31] = 1;
    let ivk = SaplingIvk::from_bytes(&bytes)
        .into_option()
        .expect("decoy ivk must be a valid scalar");
    seal(&ivk.to_repr(), 1234 + index as u64, [index; 512], 0x40 + index, rng)
}

fn main() {
    let mut rng = StdRng::from_seed([7u8; 32]);

    let participants = [
        Participant { label: "Bob",   bid_zat: 70 * ZEC, collateral_zat: 70 * ZEC, nonce: [0xB0; 16], is_seller: false, decoys_after: 1 },
        Participant { label: "Carol", bid_zat: 60 * ZEC, collateral_zat: 60 * ZEC, nonce: [0xC0; 16], is_seller: false, decoys_after: 1 },
        Participant { label: "Alice", bid_zat: 65 * ZEC, collateral_zat: 65 * ZEC, nonce: [0xA1; 16], is_seller: true,  decoys_after: 1 },
        Participant { label: "Dave",  bid_zat: 45 * ZEC, collateral_zat: 45 * ZEC, nonce: [0xD0; 16], is_seller: false, decoys_after: 0 },
        // Erin claims 55 ZEC but only locks 20. Must be rejected: a bidder who
        // cannot cover their bid is not a bidder.
        Participant { label: "Erin",  bid_zat: 55 * ZEC, collateral_zat: 20 * ZEC, nonce: [0xE0; 16], is_seller: false, decoys_after: 2 },
    ];

    let mut records: Vec<String> = Vec::new();
    // The seller publishes which ephemeral key is theirs, so an auditor can
    // exclude their bids without trusting a label. That is the anchor for the
    // seller-exclusion rule.
    let mut seller_epk_bid: Option<String> = None;
    let mut reveals: Vec<String> = Vec::new();
    let mut notes: Vec<String> = Vec::new();

    for (i, p) in participants.iter().enumerate() {
        // Each bidder's ephemeral keys are distinct, as they would be in reality.
        let epk_bid = [0x10 + i as u8; 32];
        let epk_refund = [0x20 + i as u8; 32];
        let c_refund = [0x30 + i as u8; 232];

        let bid_commit = compute_bid_commit(&AUCTION_ID, p.bid_zat, &p.nonce, &epk_bid)
            .expect("well-formed commitment inputs");
        let memo = pack_memo(&MemoFields {
            auction_id: AUCTION_ID,
            epk_bid,
            epk_refund,
            bid_commit,
            c_refund,
        });

        records.push(hex(&seal(
            &ESCROW_IVK,
            p.collateral_zat,
            memo,
            i as u8,
            &mut rng,
        )));
        if p.is_seller {
            seller_epk_bid = Some(hex(&epk_bid));
        }
        reveals.push(hex(&encode_reveal(&AUCTION_ID, p.bid_zat, &p.nonce).expect("valid reveal")));
        notes.push(format!(
            "{} bids {} ZEC with {} ZEC collateral{}",
            p.label,
            p.bid_zat / ZEC,
            p.collateral_zat / ZEC,
            if p.is_seller { " (seller: excluded)" } else { "" }
        ));

        for d in 0..p.decoys_after {
            records.push(hex(&decoy((i * 4 + d) as u8, &mut rng)));
        }
    }

    // Expected outcome, stated up front so the page can be checked against it
    // rather than merely believed.
    //
    // After removing Erin's under-collateralised bid and Alice's seller bid, the
    // surviving bids are Bob 70, Carol 60, Dave 45. Second-price => Bob wins at
    // 60 ZEC.
    let expected = r#"{"winner":"Bob","clearing_price_zat":6000000000,"clearing_price_zec":"60","reason":"second-highest surviving bid after under-collateralised and seller bids are removed"}"#;

    println!("{{");
    println!("  \"_comment\": \"Generated by crates/veilo-core/examples/demo_fixture.rs. Real Sapling ciphertexts, not mined on chain. See the file header.\",");
    println!("  \"auction_id\": \"{}\",", hex(&AUCTION_ID));
    println!("  \"escrow_ivk\": \"{}\",", hex(&ESCROW_IVK));
    println!(
        "  \"seller_epk_bid\": \"{}\",",
        seller_epk_bid.expect("the scenario must contain a seller")
    );
    println!("  \"reserve_zat\": {},", 50 * ZEC);
    println!("  \"scenario\": [");
    for (i, n) in notes.iter().enumerate() {
        let comma = if i + 1 == notes.len() { "" } else { "," };
        println!("    \"{}\"{comma}", n);
    }
    println!("  ],");
    println!("  \"reveals\": [");
    for (i, r) in reveals.iter().enumerate() {
        let comma = if i + 1 == reveals.len() { "" } else { "," };
        println!("    \"{}\"{comma}", r);
    }
    println!("  ],");
    println!("  \"outputs\": [");
    for (i, r) in records.iter().enumerate() {
        let comma = if i + 1 == records.len() { "" } else { "," };
        println!("    \"{}\"{comma}", r);
    }
    println!("  ],");
    println!("  \"expected\": {expected}");
    println!("}}");
}
