//! The auditor, reading a transaction that a real node mined.
//!
//! Every other test in this crate starts from ciphertexts this repository
//! produced. That proves the crypto is self-consistent, not that it matches what
//! Zcash actually puts on a chain. This one closes that gap: `demo/chain-probe/`
//! holds a raw transaction exported by `zcashd 6.20.0` on regtest, mined in a
//! block, carrying a packed Veilo bid in its 512-byte memo.
//!
//! What is being checked, in order:
//!
//!   1. `tx.hex` parses as a v4 Sapling transaction and hashes to the txid the
//!      probe reported. If the bytes were corrupted or replaced, this fails.
//!   2. The escrow viewing key, as a user would paste it (a bech32 `zxview...`
//!      string), decodes to an incoming viewing key.
//!   3. Trial decryption of the transaction's Sapling outputs recovers the memo
//!      byte-for-byte -- no cooperation from `zcashd`, no wallet database.
//!   4. Those bytes are a *valid* envelope, not filler: they unpack, repack to
//!      themselves, the bid commitment recomputes from the published reveal, and
//!      the refund address opens with its key.
//!
//! Step 4 is the difference between "512 bytes survived" and "a bid survived".
//! The probe builds the memo with the crate's own encoder
//! (`examples/chain_memo.rs`) and commits the values it used in `memo.txt`, which
//! is what makes the checks below exact rather than approximate.

#![cfg(feature = "sapling")]

use veilo_core::audit::{trial_decrypt, SaplingOutput, ENC_CIPHERTEXT_SIZE};
use veilo_core::memo::{
    compute_bid_commit, is_veilo_memo, open_refund_address, pack_memo, unpack_memo,
};
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

/// One `key=value` line from the probe's `memo.txt`.
///
/// Hand-rolled for the same reason as the JSON reader below: five scalar
/// lookups do not justify a serde dependency in the test build.
fn kv(text: &str, key: &str) -> String {
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix(key).and_then(|r| r.strip_prefix('=')) {
            return rest.trim().to_string();
        }
    }
    panic!("memo.txt has no `{key}=` line");
}

/// Minimal JSON string/number extraction, for the fields this test needs.
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

    pub fn num_field(text: &str, key: &str) -> u64 {
        let needle = format!("\"{key}\":");
        let after = text
            .find(&needle)
            .unwrap_or_else(|| panic!("missing key {key}"))
            + needle.len();
        text[after..]
            .trim_start()
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect::<String>()
            .parse()
            .unwrap_or_else(|_| panic!("{key} is not a number"))
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
    // An `IncomingViewingKey` encodes as `dk(32) || ivk(32)`, and the auditor
    // consumes the raw 32-byte ivk, so take the second half.
    let ivk_bytes = extfvk
        .to_diversifiable_full_viewing_key()
        .to_external_ivk()
        .to_bytes();
    let ivk: [u8; 32] = ivk_bytes[32..]
        .try_into()
        .expect("an incoming viewing key encoding is 64 bytes");

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

    // -- 4. the recovered bytes are a real, self-consistent envelope ---------
    let spec = artifact("memo.txt");
    let sent = hex_decode(&kv(&spec, "memo"));
    assert_eq!(
        bid.memo.as_slice(),
        sent.as_slice(),
        "the on-chain memo is not the 512 bytes the probe sent"
    );

    assert!(
        is_veilo_memo(&bid.memo),
        "the mined memo does not carry the Veilo magic and protocol tag"
    );

    let fields = unpack_memo(&bid.memo).expect("the mined memo is not a well-formed envelope");
    assert_eq!(
        pack_memo(&fields),
        bid.memo,
        "unpacking and repacking the mined envelope changed it"
    );

    // The reveal is the 40 bytes a bidder publishes after the deadline:
    // auction_id(16) || bid_zat_le(8) || nonce(16).
    let reveal = hex_decode(&kv(&spec, "reveal"));
    assert_eq!(reveal.len(), 40, "the probe's reveal is not 40 bytes");
    assert_eq!(
        &reveal[..16],
        &fields.auction_id[..],
        "the reveal names a different auction"
    );
    let bid_zat = u64::from_le_bytes(reveal[16..24].try_into().expect("8 bytes"));
    let nonce: [u8; 16] = reveal[24..].try_into().expect("16 bytes");

    assert_eq!(
        compute_bid_commit(&fields.auction_id, bid_zat, &nonce, &fields.epk_bid)
            .expect("fixed-size inputs"),
        fields.bid_commit,
        "the commitment in the mined memo does not match the published reveal"
    );
    assert!(
        bid_zat <= bid.value_zat,
        "the mined note ({} zat) does not cover the bid ({bid_zat} zat)",
        bid.value_zat
    );

    // Opening the refund seal requires `SK_refund` -- the *auction's* refund
    // secret, not the bidder's. The probe publishes a fixed test key next to the
    // artefact so this step is checkable, and that is exactly the gap: a real
    // auctioneer cannot publish this key without opening every bidder's refund
    // address. This test proves the seal codec, not a public exclusion proof.
    let sk_refund: [u8; 32] = hex_decode(&kv(&spec, "sk_refund"))
        .try_into()
        .expect("sk_refund is 32 bytes");
    let refund = open_refund_address(
        &sk_refund,
        &fields.epk_refund,
        &fields.c_refund,
        Some(&fields.auction_id[..]),
    )
    .expect("the sealed refund address does not open with the probe's key");
    let expected_refund =
        String::from_utf8(hex_decode(&kv(&spec, "refund_address"))).expect("utf8 refund address");
    assert_eq!(
        refund, expected_refund,
        "the sealed refund address does not match the one the probe used"
    );

    // Value is not the point of this test, but a note that decrypted with a
    // value of zero would mean the wrong output matched.
    assert!(
        bid.value_zat > 0,
        "decrypted a note with no value; the wrong output matched"
    );

    println!(
        "txid {} (height {}) -> note of {} zat, bid of {bid_zat} zat, refund {refund}",
        tx.txid(),
        json::num_field(&probe, "block_height"),
        bid.value_zat,
    );
}
