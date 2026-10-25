//! The auditor, reading a transaction that a real node mined.
//!
//! Every other test in this crate starts from ciphertexts this repository
//! produced. That proves the crypto is self-consistent, not that it matches what
//! Zcash actually puts on a chain. This one closes that gap: `demo/chain-probe/`
//! holds a raw transaction exported by `zcashd 6.20.0` on regtest, mined in a
//! block, carrying a 512-byte Veilo envelope as its memo.
//!
//! What is being checked, in order:
//!
//!   1. `tx.hex` parses as a v4 Sapling transaction and hashes to the txid the
//!      probe reported. If the bytes were corrupted or replaced, this fails.
//!   2. The escrow viewing key, as a user would paste it (a bech32 `zxview...`
//!      string), decodes to an incoming viewing key.
//!   3. Trial decryption of the transaction's Sapling outputs recovers the memo
//!      byte-for-byte -- no cooperation from `zcashd`, no wallet database.
//!
//! The memo used by the probe is deliberately self-describing: byte `i` is
//! `i mod 256`, so the hex reads `000102...ff0001...`. A truncation, a
//! zero-padding bug, or an off-by-one all show up as a mismatch rather than as
//! plausible-looking garbage.

#![cfg(feature = "sapling")]

use sapling_crypto::zip32::Scope;
use veilo_core::audit::{trial_decrypt, SaplingOutput, ENC_CIPHERTEXT_SIZE};
use zcash_keys::encoding::decode_extfvk_with_network;
use zcash_primitives::transaction::Transaction;
// The probe stops at Canopy, which is the last upgrade that still produces v4
// transactions, so that is the branch the signature hash is computed against.
use zcash_protocol::consensus::BranchId;

/// Read a file the regtest probe wrote.
fn artifact(name: &str) -> String {
    let path = format!(
        "{}/../../demo/chain-probe/{}",
        env!("CARGO_MANIFEST_DIR"),
        name
    );
    std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "cannot read {path}: {e}\n\
             this test needs the regtest artefact; produce it with:\n\
             \x20 bash ops/onchain-probe.sh"
        )
    })
}

fn hex_decode(s: &str) -> Vec<u8> {
    let s = s.trim();
    assert!(s.len().is_multiple_of(2), "odd-length hex from the probe");
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("probe wrote non-hex"))
        .collect()
}

/// The 512-byte memo the probe sends: byte `i` is `i mod 256`.
fn expected_memo() -> [u8; 512] {
    let mut memo = [0u8; 512];
    for (i, byte) in memo.iter_mut().enumerate() {
        *byte = (i % 256) as u8;
    }
    memo
}

/// Minimal JSON string extraction, for the two fields this test needs.
///
/// Same reasoning as `demo_audit.rs`: one fixture does not justify serde.
mod json {
    pub fn str_field<'a>(text: &'a str, key: &str) -> &'a str {
        let needle = format!("\"{key}\":");
        let after = text
            .find(&needle)
            .unwrap_or_else(|| panic!("missing key {key}"))
            + needle.len();
        let rest = &text[after..];
        // Whitespace between the colon and the opening quote is optional.
        let rest = rest.trim_start();
        let rest = rest
            .strip_prefix('"')
            .unwrap_or_else(|| panic!("{key} is not a string"));
        let end = rest.find('"').expect("unterminated string");
        &rest[..end]
    }
}

#[test]
fn the_auditor_reads_a_mined_transaction() {
    let probe = artifact("probe.json");
    let raw = hex_decode(&artifact("tx.hex"));

    // -- 1. the bytes are the transaction the probe claims -------------------
    let tx = Transaction::read(&raw[..], BranchId::Canopy)
        .expect("tx.hex does not parse as a v4 transaction under Canopy");
    assert_eq!(
        tx.txid().to_string(),
        json::str_field(&probe, "txid"),
        "tx.hex does not hash to the txid in probe.json"
    );

    // -- 2. the published viewing key yields an ivk --------------------------
    let (network, extfvk) = decode_extfvk_with_network(json::str_field(&probe, "escrow_extfvk"))
        .expect("escrow_extfvk is not a valid bech32 extended full viewing key");
    assert_eq!(
        format!("{network:?}"),
        "Regtest",
        "the artefact should be a regtest viewing key"
    );
    let ivk = extfvk.to_ivk(Scope::External).to_repr();

    // -- 3. trial decryption recovers the envelope --------------------------
    let bundle = tx
        .sapling_bundle()
        .expect("the mined transaction has no Sapling bundle");
    assert!(
        !bundle.shielded_outputs().is_empty(),
        "the mined transaction has no Sapling outputs"
    );

    let mut recovered = None;
    for output in bundle.shielded_outputs() {
        let enc = output.enc_ciphertext();
        assert_eq!(
            enc.len(),
            ENC_CIPHERTEXT_SIZE,
            "a mined output must carry the full 580-byte ciphertext, not the compact form"
        );

        // These are byte-for-byte the three fields the browser auditor is
        // handed: ephemeral key, note commitment, ciphertext.
        let Some(candidate) =
            SaplingOutput::from_chain_bytes(output.ephemeral_key().0, output.cmu().to_bytes(), enc)
        else {
            continue;
        };

        if let Some(bid) = trial_decrypt(&ivk, &candidate) {
            recovered = Some(bid);
            break;
        }
    }

    let bid = recovered.expect(
        "no Sapling output in the mined transaction decrypted with the escrow ivk: \
         the auditor cannot read what zcashd wrote",
    );

    assert_eq!(
        bid.memo,
        expected_memo(),
        "the on-chain memo is not the 512 bytes that were sent"
    );

    // Value is not the point of this test, but a note that decrypted with a
    // value of zero would mean the wrong output matched.
    assert!(
        bid.value_zat > 0,
        "decrypted a note with no value; the wrong output matched"
    );

    println!(
        "txid {} (height {}) -> note of {} zat, {} memo bytes recovered",
        tx.txid(),
        json::str_field(&probe, "block_height"),
        bid.value_zat,
        bid.memo.iter().filter(|b| **b != 0).count()
    );
}
