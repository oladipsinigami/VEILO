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

use sapling_crypto::keys::{Diversifier, SaplingIvk};
use sapling_crypto::note::{Note, Rseed};
use sapling_crypto::note_encryption::{sapling_note_encryption, SaplingDomain};
use sapling_crypto::value::NoteValue;
use zcash_note_encryption::Domain;
use veilo_core::audit::{trial_decrypt, SaplingOutput, COMPACT_NOTE_SIZE, ENC_CIPHERTEXT_SIZE};
use veilo_core::memo::{pack_memo, MemoFields, MEMO_SIZE};

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
    let note = Note::from_parts(address, NoteValue::from_raw(value_zat), Rseed::AfterZip212([9u8; 32]));

    // ovk = None means the sender did not want the note recoverable; trial
    // decryption by the recipient does not depend on it. Passing None keeps the
    // test from having to conjure an OutgoingViewingKey it never uses.
    let encrypted = sapling_note_encryption(None, note, memo, rng);

    // `EphemeralPublicKey::to_bytes` is pub(crate); the public route to the
    // chain encoding is the Domain trait's `epk_bytes`. This is test-only
    // scaffolding: the auditor never constructs an output, it reads the epk
    // off the chain, so it never needs this direction at all.
    let epk = <SaplingDomain as Domain>::epk_bytes(encrypted.epk());
    let cmu = note.cmu().to_bytes();
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

    assert_eq!(bid.value_zat, value, "note value must survive the round trip");
    assert_eq!(bid.memo, memo, "the whole 512-byte envelope must survive intact");

    // And it is still a valid Veilo envelope, not just matching bytes: parse it
    // back through the real parser so a layout regression cannot hide here.
    let parsed = veilo_core::memo::unpack_memo(&bid.memo).expect("recovered memo is a valid envelope");
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