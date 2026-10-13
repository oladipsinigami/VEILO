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
//! # Why JSON, and not a typed struct
//!
//! `#[wasm_bindgen]` struct fields must be `Copy`, so a struct of `Vec<u8>`
//! fields does not compile. The alternative -- hex strings per field -- pushes
//! the same work into JS. Returning one JSON string keeps every format
//! decision in Rust, where it is covered by tests, and is what a browser
//! actually wants to render.
//!
//! # Failure is never silent
//!
//! A malformed input is always a thrown error, never a defaulted value. An
//! auditor that quietly reports "no bids" when handed a compact ciphertext is
//! worse than one that throws: the failure is indistinguishable from a real
//! result, and a wrong clearing price is the one outcome this project exists to
//! prevent.

use wasm_bindgen::prelude::*;

#[cfg(feature = "sapling")]
use veilo_core::audit;

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

// ---------------------------------------------------------------- JSON output

#[cfg(feature = "sapling")]
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Render one recovered bid as a JSON object.
///
/// Only hex strings and integers appear here, so there is nothing to escape --
/// which is worth stating, because it is exactly the assumption a hand-rolled
/// serialiser usually gets wrong.
#[cfg(feature = "sapling")]
fn bid_json(
    fields: &veilo_core::memo::MemoFields,
    value_zat: u64,
) -> String {
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

#[cfg(feature = "sapling")]
fn err_bad_len(what: &str, got: usize, want: usize) -> JsError {
    JsError::new(&format!("{what} must be {want} bytes, got {got}"))
}

#[cfg(feature = "sapling")]
fn array32(bytes: &[u8], what: &str) -> Result<[u8; 32], JsError> {
    bytes.try_into().map_err(|_| err_bad_len(what, bytes.len(), 32))
}

/// Turn one `(epk, cmu, enc_ciphertext)` triple into a JSON object, or `None`
/// if the output is not ours.
#[cfg(feature = "sapling")]
fn audit_one(escrow_ivk: &[u8; 32], epk: &[u8; 32], cmu: &[u8; 32], enc: &[u8]) -> Result<Option<String>, JsError> {
    if enc.len() == veilo_core::audit::COMPACT_NOTE_SIZE {
        return Err(JsError::new(
            "got a 52-byte compact ciphertext, which carries no memo. \
             An auditor needs the full 580-byte encCiphertext.",
        ));
    }
    if enc.len() != veilo_core::audit::ENC_CIPHERTEXT_SIZE {
        return Err(err_bad_len("enc_ciphertext", enc.len(), veilo_core::audit::ENC_CIPHERTEXT_SIZE));
    }

    let output = audit::SaplingOutput::from_chain_bytes(*epk, *cmu, enc)
        .ok_or_else(|| JsError::new("failed to parse the Sapling output"))?;

    let Some(bid) = audit::trial_decrypt(escrow_ivk, &output) else {
        return Ok(None);
    };

    let fields = veilo_core::memo::unpack_memo(&bid.memo)
        .map_err(|e| JsError::new(&format!("decrypted, but the envelope is invalid: {e}")))?;

    Ok(Some(bid_json(&fields, bid.value_zat)))
}

/// Trial-decrypt one Sapling output with the escrow viewing key.
///
/// Returns a JSON object string, or the string `null` when the output is not
/// ours. Throws when the input is malformed -- see the module docs for why those
/// two cases must not be collapsed.
#[cfg(feature = "sapling")]
#[wasm_bindgen]
pub fn audit_output(
    escrow_ivk: &[u8],
    ephemeral_key: &[u8],
    cmu: &[u8],
    enc_ciphertext: &[u8],
) -> Result<String, JsError> {
    let ivk = array32(escrow_ivk, "escrow_ivk")?;
    let epk = array32(ephemeral_key, "ephemeral_key")?;
    let cmu = array32(cmu, "cmu")?;
    match audit_one(&ivk, &epk, &cmu, enc_ciphertext)? {
        Some(json) => Ok(json),
        None => Ok("null".to_string()),
    }
}

/// Trial-decrypt a whole block range and keep only the escrow's bids.
///
/// `outputs` is a flat concatenation of `(ephemeral_key || cmu || enc_ciphertext)`
/// records, each 32 + 32 + 580 = 644 bytes, in fetch order. Returns a JSON array
/// string, possibly empty.
///
/// A flat buffer rather than an array of objects: this is the auditor's hot
/// path, and one typed-array copy beats allocating an object per output when a
/// range runs to thousands.
#[cfg(feature = "sapling")]
#[wasm_bindgen]
pub fn audit_range(escrow_ivk: &[u8], outputs: &[u8]) -> Result<String, JsError> {
    const RECORD: usize = 32 + 32 + 580;

    let ivk = array32(escrow_ivk, "escrow_ivk")?;
    if outputs.len() % RECORD != 0 {
        return Err(JsError::new(&format!(
            "outputs must be a whole number of {RECORD}-byte records, got {} bytes",
            outputs.len()
        )));
    }

    let mut found: Vec<String> = Vec::new();
    for record in outputs.chunks_exact(RECORD) {
        let epk: [u8; 32] = record[0..32].try_into().expect("record is 644 bytes");
        let cmu: [u8; 32] = record[32..64].try_into().expect("record is 644 bytes");
        if let Some(json) = audit_one(&ivk, &epk, &cmu, &record[64..])? {
            found.push(json);
        }
    }
    Ok(format!("[{}]", found.join(",")))
}