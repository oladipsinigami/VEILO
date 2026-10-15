//! Browser auditor for Veilo.
//!
//! # What this is
//!
//! A wasm module that lets anyone verify a Veilo auction from public chain data
//! alone. It holds no keys beyond the escrow's published *incoming viewing key*,
//! so it can read bids but cannot spend, sign, or alter anything.
//!
//! The point of shipping this to a browser rather than trusting a server is the
//! same as the point of the protocol: the coordinator says the clearing price
//! was X, and you check that yourself, offline, without asking anyone's
//! permission. An endpoint that returned "the winner was X" would be worthless
//! as evidence.
//!
//! # Structure: logic here, ABI at the edge
//!
//! Everything below the `#[wasm_bindgen]` functions is plain Rust with no wasm
//! types, and it is unit-tested natively (`cargo test -p veilo-wasm`). The
//! exported functions are deliberately thin. That split exists because
//! `wasm-bindgen-test` would have to be pinned in lockstep with `wasm-bindgen`
//! and run under a headless browser; testing the logic directly is faster,
//! covers more cases, and cannot rot on a version bump.
//!
//! # Failure is never silent
//!
//! A malformed input is always an error, never a defaulted value. An auditor
//! that quietly reports "no bids" when handed a compact ciphertext is worse
//! than one that throws: the failure is indistinguishable from a real result,
//! and a wrong clearing price is the one outcome this project exists to
//! prevent.

use wasm_bindgen::prelude::*;

/// Size of the Veilo memo envelope, in bytes.
///
/// Also the full Zcash memo field: `MemoBytes` is a `Box<[u8; 512]>`, so this is
/// fixed by consensus and the envelope has zero headroom.
#[wasm_bindgen]
pub fn memo_size() -> usize {
    veilo_core::memo::MEMO_SIZE
}

/// Size of a full Sapling `encCiphertext`, in bytes.
#[wasm_bindgen]
pub fn enc_ciphertext_size() -> usize {
    veilo_core::audit::ENC_CIPHERTEXT_SIZE
}

/// Size of a compact Sapling `encCiphertext`, in bytes.
///
/// The compact form carries no memo, so it is useless for auditing. Exposed so a
/// caller can reject it explicitly rather than discover it as a silent miss.
#[wasm_bindgen]
pub fn compact_note_size() -> usize {
    veilo_core::audit::COMPACT_NOTE_SIZE
}

#[cfg(feature = "sapling")]
mod core {
    use veilo_core::audit;

    /// Why an audit could not be completed.
    ///
    /// Distinct from "not our output", which is a successful result carrying no
    /// bid. Every variant here means the input was unusable, and all of them
    /// must surface rather than degrade into an empty bid list.
    #[derive(Debug, PartialEq, Eq)]
    pub enum AuditError {
        /// A fixed-size field had the wrong length.
        BadLength {
            field: &'static str,
            got: usize,
            want: usize,
        },
        /// A compact ciphertext was supplied, so no memo exists to audit.
        CompactCiphertext,
        /// The output could not be parsed.
        UnparseableOutput,
        /// The memo decrypted but is not a valid Veilo envelope.
        InvalidEnvelope(String),
        /// The reveal's bid amount was not a decimal integer.
        BadRevealAmount(String),
    }

    impl std::fmt::Display for AuditError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            match self {
                AuditError::BadLength { field, got, want } => {
                    write!(f, "{field} must be {want} bytes, got {got}")
                }
                AuditError::CompactCiphertext => write!(
                    f,
                    "got a {}-byte compact ciphertext, which carries no memo; \
                     an auditor needs the full {}-byte encCiphertext",
                    audit::COMPACT_NOTE_SIZE,
                    audit::ENC_CIPHERTEXT_SIZE
                ),
                AuditError::UnparseableOutput => write!(f, "failed to parse the Sapling output"),
                AuditError::InvalidEnvelope(why) => {
                    write!(f, "decrypted, but the envelope is invalid: {why}")
                }
                AuditError::BadRevealAmount(s) => {
                    write!(f, "reveal bid amount {s:?} is not a decimal integer")
                }
            }
        }
    }

    impl std::error::Error for AuditError {}

    /// Bytes per output record in the flat `audit_range` buffer.
    pub const RECORD_LEN: usize = 32 + 32 + 580;

    pub fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// Render one recovered bid as a JSON object.
    ///
    /// Only hex strings and integers appear, so there is nothing to escape --
    /// worth stating, because assuming that in a hand-rolled serialiser is
    /// exactly how a verifier ends up rendering a bidder's data as markup.
    pub fn bid_json(fields: &veilo_core::memo::MemoFields, value_zat: u64) -> String {
        format!(
            concat!(
                r#"{{"auction_id":"{aid}","value_zat":{value},"epk_bid":"{epk_bid}","#,
                r#""epk_refund":"{epk_refund}","bid_commit":"{commit}","#,
                r#""c_refund":"{c_refund}"}}"#
            ),
            aid = hex(&fields.auction_id),
            value = value_zat,
            epk_bid = hex(&fields.epk_bid),
            epk_refund = hex(&fields.epk_refund),
            commit = hex(&fields.bid_commit),
            c_refund = hex(&fields.c_refund),
        )
    }

    fn array32(bytes: &[u8], field: &'static str) -> Result<[u8; 32], AuditError> {
        bytes.try_into().map_err(|_| AuditError::BadLength {
            field,
            got: bytes.len(),
            want: 32,
        })
    }

    /// Audit a single output. `Ok(None)` means "not ours" -- a valid answer.
    pub fn audit_one(
        escrow_ivk: &[u8],
        epk: &[u8],
        cmu: &[u8],
        enc: &[u8],
    ) -> Result<Option<String>, AuditError> {
        let ivk = array32(escrow_ivk, "escrow_ivk")?;
        let epk = array32(epk, "ephemeral_key")?;
        let cmu = array32(cmu, "cmu")?;

        if enc.len() == audit::COMPACT_NOTE_SIZE {
            return Err(AuditError::CompactCiphertext);
        }
        if enc.len() != audit::ENC_CIPHERTEXT_SIZE {
            return Err(AuditError::BadLength {
                field: "enc_ciphertext",
                got: enc.len(),
                want: audit::ENC_CIPHERTEXT_SIZE,
            });
        }

        let output = audit::SaplingOutput::from_chain_bytes(epk, cmu, enc)
            .ok_or(AuditError::UnparseableOutput)?;

        let Some(bid) = audit::trial_decrypt(&ivk, &output) else {
            return Ok(None);
        };
        let fields = veilo_core::memo::unpack_memo(&bid.memo)
            .map_err(|e| AuditError::InvalidEnvelope(e.to_string()))?;

        Ok(Some(bid_json(&fields, bid.value_zat)))
    }


    /// Check a permissionless reveal against the commitment already on chain.
    ///
    /// This is the step that makes the auction honest: the bid amount is
    /// published only after the deadline, and it is accepted only if it hashes
    /// to the `bid_commit` that was in the memo from the start. A bidder who
    /// changes their number once they can see everyone else's produces a
    /// different hash and is dropped.
    ///
    /// `bid_zat` is a decimal STRING rather than a number on purpose. A u64
    /// crosses the wasm boundary as a BigInt and an f64 would silently lose
    /// precision above 2^53, which is roughly 90 million ZEC in zatoshis --
    /// low enough that "just use a float" is a real hazard, not a theoretical
    /// one.
    pub fn verify_reveal(
        auction_id: &[u8],
        bid_zat: &str,
        nonce: &[u8],
        epk_bid: &[u8],
        bid_commit: &[u8],
    ) -> Result<bool, AuditError> {
        let zat: u64 = bid_zat
            .parse()
            .map_err(|_| AuditError::BadRevealAmount(bid_zat.to_string()))?;
        // A bid_commit that is not 32 bytes is a malformed reveal, not a
        // mismatch. Reporting it as "does not match" would let a broken client
        // look like a rejected bid rather than a bug.
        let Some(commit) = as_commit32(bid_commit) else {
            return Err(AuditError::BadLength {
                field: "bid_commit",
                got: bid_commit.len(),
                want: 32,
            });
        };
        let computed = veilo_core::memo::compute_bid_commit(auction_id, zat, nonce, epk_bid)
            .map_err(|e| AuditError::InvalidEnvelope(e.to_string()))?;
        Ok(computed == commit)
    }

    fn as_commit32(bytes: &[u8]) -> Option<[u8; 32]> {
        bytes.try_into().ok()
    }

    /// Audit a flat buffer of `(epk || cmu || enc_ciphertext)` records.
    pub fn audit_range(escrow_ivk: &[u8], outputs: &[u8]) -> Result<String, AuditError> {
        if outputs.len() % RECORD_LEN != 0 {
            return Err(AuditError::BadLength {
                field: "outputs",
                got: outputs.len(),
                want: outputs.len() - (outputs.len() % RECORD_LEN) + RECORD_LEN,
            });
        }

        let mut found: Vec<String> = Vec::new();
        for record in outputs.chunks_exact(RECORD_LEN) {
            if let Some(json) =
                audit_one(escrow_ivk, &record[0..32], &record[32..64], &record[64..])?
            {
                found.push(json);
            }
        }
        Ok(format!("[{}]", found.join(",")))
    }
}

// ------------------------------------------------------------------ wasm ABI

/// Check a permissionless reveal against the commitment already on chain.
///
/// Returns true only if the amount hashes to the `bid_commit` that was in the
/// memo from the start. This is the step that makes the auction honest: a bidder
/// who changes their number at the deadline produces a different hash and is
/// rejected.
///
/// `bid_zat` is a decimal string on purpose. A `u64` crosses the wasm boundary
/// as a BigInt, and an `f64` would silently lose precision above 2^53 -- about
/// 90 million ZEC in zatoshis, so "just use a float" is a real hazard here.
#[cfg(feature = "sapling")]
#[wasm_bindgen]
pub fn verify_reveal(
    auction_id: &[u8],
    bid_zat: &str,
    nonce: &[u8],
    epk_bid: &[u8],
    bid_commit: &[u8],
) -> Result<bool, JsError> {
    core::verify_reveal(auction_id, bid_zat, nonce, epk_bid, bid_commit)
        .map_err(|e| JsError::new(&e.to_string()))
}


/// Trial-decrypt one Sapling output with the escrow viewing key.
///
/// Returns a JSON object string, or the string `null` when the output is not
/// ours. Throws when the input is malformed.
#[cfg(feature = "sapling")]
#[wasm_bindgen]
pub fn audit_output(
    escrow_ivk: &[u8],
    ephemeral_key: &[u8],
    cmu: &[u8],
    enc_ciphertext: &[u8],
) -> Result<String, JsError> {
    core::audit_one(escrow_ivk, ephemeral_key, cmu, enc_ciphertext)
        .map(|json| json.unwrap_or_else(|| "null".to_string()))
        .map_err(|e| JsError::new(&e.to_string()))
}

/// Trial-decrypt a whole block range and keep only the escrow's bids.
///
/// `outputs` is a flat concatenation of `(ephemeral_key || cmu || enc_ciphertext)`
/// records, each 644 bytes, in fetch order. Returns a JSON array string,
/// possibly empty.
#[cfg(feature = "sapling")]
#[wasm_bindgen]
pub fn audit_range(escrow_ivk: &[u8], outputs: &[u8]) -> Result<String, JsError> {
    core::audit_range(escrow_ivk, outputs).map_err(|e| JsError::new(&e.to_string()))
}

// ---------------------------------------------------------------------- tests

#[cfg(all(test, feature = "sapling"))]
mod tests {
    use super::core::{audit_one, audit_range, AuditError, RECORD_LEN};
    use sapling_crypto::keys::{Diversifier, SaplingIvk};
    use sapling_crypto::note::{Note, Rseed};
    use sapling_crypto::note_encryption::{sapling_note_encryption, SaplingDomain};
    use sapling_crypto::value::NoteValue;
    use veilo_core::memo::{pack_memo, MemoFields, MEMO_SIZE};
    use zcash_note_encryption::Domain;

    const IVK: [u8; 32] = [1u8; 32];

    fn envelope() -> [u8; MEMO_SIZE] {
        pack_memo(&MemoFields {
            auction_id: [0xA1; 16],
            epk_bid: [0xB2; 32],
            epk_refund: [0xC3; 32],
            bid_commit: [0xD4; 32],
            c_refund: [0xE5; 232],
        })
    }

    fn diversifier() -> Diversifier {
        for n in 0u16..10_000 {
            let mut b = [0u8; 11];
            b[0] = n as u8;
            b[1] = (n >> 8) as u8;
            let d = Diversifier(b);
            if d.g_d().is_some() {
                return d;
            }
        }
        panic!("no valid diversifier");
    }

    fn seal(value: u64, memo: [u8; MEMO_SIZE], rng: &mut rand::rngs::StdRng) -> Vec<u8> {
        use rand::SeedableRng;
        let ivk = SaplingIvk::from_bytes(&IVK).unwrap();
        let address = ivk.to_payment_address(diversifier()).unwrap();
        let note = Note::from_parts(
            address,
            NoteValue::from_raw(value),
            Rseed::AfterZip212([9u8; 32]),
        );
        let cmu = note.cmu().to_bytes();
        let enc = sapling_note_encryption(None, note, memo, rng);
        let epk = <SaplingDomain as Domain>::epk_bytes(enc.epk()).0;

        let mut record = Vec::with_capacity(RECORD_LEN);
        record.extend_from_slice(&epk);
        record.extend_from_slice(&cmu);
        record.extend_from_slice(&enc.encrypt_note_plaintext().0);
        record
    }

    fn rng() -> rand::rngs::StdRng {
        use rand::SeedableRng;
        rand::rngs::StdRng::from_seed([42u8; 32])
    }

    #[test]
    fn audit_output_emits_json_for_our_bid() {
        let mut r = rng();
        let record = seal(1_234u64, envelope(), &mut r);

        let json = audit_one(&IVK, &record[0..32], &record[32..64], &record[64..])
            .unwrap()
            .expect("our output must yield a bid");

        // Hand-check the JSON rather than trusting JSON.parse on the other side.
        assert!(json.starts_with('{') && json.ends_with('}'));
        assert!(json.contains(r#""value_zat":1234"#));
        assert!(json.contains(
            r#""bid_commit":"d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4"#
        ));
        assert!(json.contains(&format!(r#""auction_id":"{}""#, "a1".repeat(16))));
    }

    #[test]
    fn audit_output_returns_none_for_a_foreign_key() {
        let mut r = rng();
        let record = seal(1_234, envelope(), &mut r);
        let wrong = [2u8; 32];
        assert_eq!(
            audit_one(&wrong, &record[0..32], &record[32..64], &record[64..]).unwrap(),
            None
        );
    }

    #[test]
    fn compact_ciphertext_is_a_distinct_error_not_a_miss() {
        let mut r = rng();
        let record = seal(1_234, envelope(), &mut r);
        let compact = &record[64..64 + 52];
        assert_eq!(
            audit_one(&IVK, &record[0..32], &record[32..64], compact),
            Err(AuditError::CompactCiphertext)
        );
    }

    #[test]
    fn wrong_length_fields_are_rejected() {
        assert_eq!(
            audit_one(&IVK, &[0u8; 31], &[0u8; 32], &[0u8; 580]),
            Err(AuditError::BadLength {
                field: "ephemeral_key",
                got: 31,
                want: 32
            })
        );
    }

    #[test]
    fn range_keeps_ours_and_skips_others() {
        let mut r = rng();
        let mut records = seal(500, envelope(), &mut r);
        // A decoy record: same length, different everything.
        let mut decoy = seal(9, [0u8; 512], &mut r);
        decoy.iter_mut().for_each(|b| *b = b.wrapping_add(1));
        let mut flat = decoy.clone();
        flat.extend_from_slice(&records);
        records = flat;

        let json = audit_range(&IVK, &records).unwrap();
        assert!(json.starts_with('[') && json.ends_with(']'));
        assert_eq!(
            json.matches(r#""value_zat""#).count(),
            1,
            "only ours survives"
        );
    }

    #[test]
    fn range_rejects_a_ragged_buffer() {
        assert!(matches!(
            audit_range(&IVK, &[0u8; RECORD_LEN + 1]),
            Err(AuditError::BadLength {
                field: "outputs",
                ..
            })
        ));
    }

    #[test]
    fn verify_reveal_accepts_a_matching_reveal() {
        let nonce = [0x11; 16];
        let epk = [0x22; 32];
        let auction_id = [0x33; 16];
        let zat = 7_000_000_000u64;

        let expected = veilo_core::memo::compute_bid_commit(&auction_id, zat, &nonce, &epk)
            .expect("well-formed");


        assert!(super::core::verify_reveal(
            &auction_id,
            "7000000000",
            &nonce,
            &epk,
            &expected,
        )
        .expect("well-formed inputs"));
    }

    #[test]
    fn verify_reveal_rejects_a_changed_amount() {
        let auction_id = [0x33; 16];
        let nonce = [0x11; 16];
        let epk = [0x22; 32];
        let commit =
            veilo_core::memo::compute_bid_commit(&auction_id, 7_000_000_000, &nonce, &epk).unwrap();

        // Same commitment, different claimed amount: exactly the attack the
        // reveal check exists to stop.
        assert!(!super::core::verify_reveal(
            &auction_id,
            "100000000",
            &nonce,
            &epk,
            &commit,
        )
        .expect("well-formed inputs"));
    }

    #[test]
    fn verify_reveal_rejects_a_non_numeric_amount() {
        let e = super::core::verify_reveal(
            &[0u8; 16],
            "seventy",
            &[0u8; 16],
            &[0u8; 32],
            &[0u8; 32],
        )
        .unwrap_err();
        assert!(matches!(e, super::core::AuditError::BadRevealAmount(_)));
    }

    #[test]
    fn empty_range_is_an_empty_array_not_an_error() {
        assert_eq!(audit_range(&IVK, &[]).unwrap(), "[]");
    }
}
