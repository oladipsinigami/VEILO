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
//! permission. A JSON-RPC endpoint that returned "the winner was X" would be
//! worthless as evidence.
//!
//! # Byte-oriented API
//!
//! Everything crosses the boundary as bytes rather than as parsed structs. Two
//! reasons:
//!
//!   * The browser has the raw output-description fields off the wire; making JS
//!     rebuild a 580-byte array to hand it over would be pointless work.
//!   * Every length and format check stays in Rust, where it is testable, rather
//!     than being spread across JS that nobody runs.
//!
//! A malformed input is always a thrown error, never a silently-defaulted value.
//! An auditor that quietly returns "no bids" when handed a compact ciphertext
//! is worse than one that crashes: the failure is indistinguishable from a real
//! result, and a wrong clearing price is the one outcome this project exists to
//! prevent.

use wasm_bindgen::prelude::*;

#[cfg(feature = "sapling")]
use veilo_core::audit;

/// Size of the Veilo memo envelope, in bytes.
///
/// Also the full Zcash memo field: `MemoBytes` is a `Box<[u8; 512]>`, so this
/// value is fixed by consensus and the envelope has zero headroom.
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
/// The compact form carries no memo, so it is useless for auditing. Exposed so
/// a caller can reject it explicitly rather than discover it as a silent miss.
#[wasm_bindgen]
pub fn compact_note_size() -> usize {
    veilo_core::audit::COMPACT_NOTE_SIZE
}

/// The parts of a Veilo envelope, split out for display in the browser.
#[cfg(feature = "sapling")]
#[wasm_bindgen]
pub struct BidFields {
    /// 16-byte auction identifier this bid belongs to.
    pub auction_id: Vec<u8>,
    /// 32-byte ephemeral key for the bid's own sealed refund.
    pub epk_bid: Vec<u8>,
    /// 32-byte ephemeral key for the separate refund output.
    pub epk_refund: Vec<u8>,
    /// 32-byte commitment to the bid. This is the only thing visible on chain
    /// before the reveal; the amount itself is not here.
    pub bid_commit: Vec<u8>,
    /// 232-byte sealed refund ciphertext.
    pub c_refund: Vec<u8>,
    /// Note value in zatoshis.
    pub value_zat: f64,
}

#[cfg(feature = "sapling")]
#[wasm_bindgen]
impl BidFields {
    /// Hex, for copying into a terminal or pasting into a bug report.
    #[wasm_bindgen(getter)]
    pub fn bid_commit_hex(&self) -> String {
        hex(&self.bid_commit)
    }
}

#[cfg(feature = "sapling")]
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(feature = "sapling")]
fn to_array32(bytes: &[u8], what: &str) -> Result<[u8; 32], JsError> {
    bytes
        .try_into()
        .map_err(|_| JsError::new(&format!("{what} must be 32 bytes, got {}", bytes.len())))
}

#[cfg(feature = "sapling")]
fn to_array58_0(bytes: &[u8], what: &str) -> Result<[u8; 580], JsError> {
    bytes.try_into().map_err(|_| {
        JsError::new(&format!(
            "{what} must be {} bytes, got {}",
            veilo_core::audit::ENC_CIPHERTEXT_SIZE,
            bytes.len()
        ))
    })
}

/// Trial-decrypt one Sapling output with the escrow viewing key.
///
/// Returns `None` when the output is not ours. Throws when the input is
/// malformed -- see the module docs for why those two cases must not be
/// collapsed.
#[cfg(feature = "sapling")]
#[wasm_bindgen]
pub fn audit_output(
    escrow_ivk: &[u8],
    ephemeral_key: &[u8],
    cmu: &[u8],
    enc_ciphertext: &[u8],
) -> Result<Option<BidFields>, JsError> {
    let ivk = to_array32(escrow_ivk, "escrow_ivk")?;
    let epk = to_array32(ephemeral_key, "ephemeral_key")?;
    let cmu = to_array32(cmu, "cmu")?;
    let enc = to_array58_0(enc_ciphertext, "enc_ciphertext");

    let enc = match enc {
        Ok(enc) => enc,
        // Distinguish "compact, so unauditable" from "corrupt": the first is a
        // known and recoverable mistake by the caller, the second is a bug.
        Err(e) => {
            if enc_ciphertext.len() == veilo_core::audit::COMPACT_NOTE_SIZE {
                return Err(JsError::new(
                    "got a 52-byte compact ciphertext, which carries no memo. \
                     An auditor needs the full 580-byte encCiphertext.",
                ));
            }
            return Err(e);
        }
    };

    let output = audit::SaplingOutput::from_chain_bytes(epk, cmu, &enc)
        .ok_or_else(|| JsError::new("failed to parse the Sapling output"))?;

    let Some(bid) = audit::trial_decrypt(&ivk, &output) else {
        return Ok(None);
    };

    let fields = veilo_core::memo::unpack_memo(&bid.memo)
        .map_err(|e| JsError::new(&format!("decrypted, but the envelope is invalid: {e}")))?;

    Ok(Some(BidFields {
        auction_id: fields.auction_id.to_vec(),
        epk_bid: fields.epk_bid.to_vec(),
        epk_refund: fields.epk_refund.to_vec(),
        bid_commit: fields.bid_commit.to_vec(),
        c_refund: fields.c_refund.to_vec(),
        value_zat: bid.value_zat as f64,
    }))
}

/// Trial-decrypt a whole block range and keep only the escrow's bids.
///
/// `outputs` is a flat concatenation of `(ephemeral_key || cmu || enc_ciphertext)`
/// triples, each 32 + 32 + 580 bytes, in the order the blocks were fetched.
///
/// A flat buffer rather than an array of objects: this is the auditor's hot
/// path, and one typed-array copy beats allocating an object per output when a
/// range runs to thousands.
#[cfg(feature = "sapling")]
#[wasm_bindgen]
pub fn audit_range(
    escrow_ivk: &[u8],
    outputs: &[u8],
) -> Result<Vec<BidFields>, JsError> {
    const RECORD: usize = 32 + 32 + 580;

    let ivk = to_array32(escrow_ivk, "escrow_ivk")?;
    if outputs.len() % RECORD != 0 {
        return Err(JsError::new(&format!(
            "outputs must be a whole number of {RECORD}-byte records, got {} bytes",
            outputs.len()
        )));
    }

    let mut found = Vec::new();
    for record in outputs.chunks_exact(RECORD) {
        let epk: [u8; 32] = record[0..32].try_into().expect("record is 644 bytes");
        let cmu: [u8; 32] = record[32..64].try_into().expect("record is 644 bytes");
        let enc = &record[64..644];

        let Some(output) = audit::SaplingOutput::from_chain_bytes(epk, cmu, enc) else {
            return Err(JsError::new("failed to parse a Sapling output in the range"));
        };
        let Some(bid) = audit::trial_decrypt(&ivk, &output) else {
            continue;
        };
        let fields = veilo_core::memo::unpack_memo(&bid.memo)
            .map_err(|e| JsError::new(&format!("decrypted, but the envelope is invalid: {e}")))?;

        found.push(BidFields {
            auction_id: fields.auction_id.to_vec(),
            epk_bid: fields.epk_bid.to_vec(),
            epk_refund: fields.epk_refund.to_vec(),
            bid_commit: fields.bid_commit.to_vec(),
            c_refund: fields.c_refund.to_vec(),
            value_zat: bid.value_zat as f64,
        });
    }
    Ok(found)
}