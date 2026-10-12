//! Replay the TypeScript-generated vectors against the Rust implementation.
//!
//! This is the single most important test in the project. The bidder's browser
//! builds envelopes in TypeScript (`web/src/lib/memo.ts`); the auditor unpacks and
//! verifies them in Rust/WASM. If the two disagree by one byte, every bid becomes
//! unreadable and every audit fails silently — and it would still "work" in any
//! demo built from a single language, which is exactly why it needs an explicit
//! cross-implementation check.
//!
//! Regenerate with: `node test/gen-vectors.mjs`

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use veilo_core::memo::*;

fn unhex(s: &str) -> Vec<u8> {
    assert!(s.len() % 2 == 0, "odd-length hex: {s}");
    (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).expect("valid hex"))
        .collect()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn arr32(v: &Vec<u8>, what: &str) -> [u8; 32] {
    <[u8; 32]>::try_from(v.as_slice()).unwrap_or_else(|_| panic!("{what} must be 32 bytes"))
}

fn arr16(v: &Vec<u8>, what: &str) -> [u8; 16] {
    <[u8; 16]>::try_from(v.as_slice()).unwrap_or_else(|_| panic!("{what} must be 16 bytes"))
}

fn arr40(v: &Vec<u8>, what: &str) -> [u8; 40] {
    <[u8; 40]>::try_from(v.as_slice()).unwrap_or_else(|_| panic!("{what} must be 40 bytes"))
}

/// Parse the dependency-free key=value format into blocks keyed by case name.
fn load_vectors() -> Vec<(String, HashMap<String, String>)> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("test")
        .join("vectors.txt");
    let text = fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}\nrun: node test/gen-vectors.mjs", path.display()));

    let mut out = Vec::new();
    let mut name: Option<String> = None;
    let mut fields: HashMap<String, String> = HashMap::new();

    for line in text.lines() {
        let line = line.trim_end();
        if line.starts_with('#') || line.is_empty() {
            if line.is_empty() {
                if let Some(n) = name.take() {
                    out.push((n, std::mem::take(&mut fields)));
                }
            }
            continue;
        }
        if !line.contains('=') {
            name = Some(line.to_string());
            continue;
        }
        let (k, v) = line.split_once('=').expect("split_once on '='");
        fields.insert(k.to_string(), v.to_string());
    }
    if let Some(n) = name.take() {
        out.push((n, fields));
    }

    assert!(!out.is_empty(), "no vectors parsed from {}", path.display());
    out
}

#[test]
fn rust_matches_typescript_byte_for_byte() {
    let vectors = load_vectors();
    assert!(
        vectors.len() >= 8,
        "expected at least 8 vectors, found {}",
        vectors.len()
    );

    for (name, f) in vectors {
        let get = |k: &str| f.get(k).unwrap_or_else(|| panic!("{name}: missing key {k}"));

        let address = unhex(get("address"));
        let aad = {
            let s = get("aad");
            if s.is_empty() {
                None
            } else {
                Some(unhex(s))
            }
        };
        let sk_refund = arr32(&unhex(get("sk_refund")), "sk_refund");
        let esk_refund = arr32(&unhex(get("esk_refund")), "esk_refund");
        let pk_refund = arr32(&unhex(get("pk_refund")), "pk_refund");
        let auction_id = arr16(&unhex(get("auction_id")), "auction_id");
        let nonce = arr16(&unhex(get("nonce")), "nonce");
        let epk_bid = arr32(&unhex(get("epk_bid")), "epk_bid");
        let bid_zat: u64 = get("bid_zat").parse().expect("bid_zat parses as u64");
        let expect_epk_refund = arr32(&unhex(get("epk_refund")), "epk_refund");
        let expect_bid_commit = arr32(&unhex(get("bid_commit")), "bid_commit");
        let expect_reveal = arr40(&unhex(get("reveal")), "reveal");
        let expect_sealed = unhex(get("sealed"));
        let expect_memo = unhex(get("memo"));

        // 1. The derived public key must match the vector.
        assert_eq!(public_key_from_secret(&sk_refund), pk_refund, "{name}: PK derivation");

        // 2. Commitment and reveal must match.
        assert_eq!(
            compute_bid_commit(&auction_id, bid_zat, &nonce, &epk_bid).unwrap(),
            expect_bid_commit,
            "{name}: bid_commit"
        );
        assert_eq!(
            encode_reveal(&auction_id, bid_zat, &nonce).unwrap(),
            expect_reveal,
            "{name}: reveal"
        );

        // 3. Sealing with the pinned ephemeral must reproduce the ciphertext exactly.
        let seal = seal_refund_address_with_seed(
            &pk_refund,
            &esk_refund,
            &address,
            aad.as_deref(),
        )
        .unwrap();
        assert_eq!(seal.epk_refund, expect_epk_refund, "{name}: epk_refund");
        assert_eq!(seal.sealed.to_vec(), expect_sealed, "{name}: c_refund");

        // 4. Rust must open what TypeScript sealed.
        let opened = open_refund_address(
            &sk_refund,
            &expect_epk_refund,
            &expect_sealed,
            aad.as_deref(),
        )
        .unwrap_or_else(|e| panic!("{name}: Rust failed to open a TS seal: {e}"));
        assert_eq!(opened.as_bytes(), address.as_slice(), "{name}: opened address");

        // 5. Memo packing must be byte-identical, including the zero padding.
        let fields = MemoFields {
            auction_id,
            epk_bid,
            epk_refund: expect_epk_refund,
            bid_commit: expect_bid_commit,
            c_refund: <[u8; C_REFUND_SIZE]>::try_from(expect_sealed.as_slice()).unwrap(),
        };
        let memo = pack_memo(&fields);
        assert_eq!(memo.len(), MEMO_SIZE, "{name}: memo size");
        assert_eq!(hex(&memo), hex(&expect_memo), "{name}: packed memo bytes");
        assert!(is_veilo_memo(&memo), "{name}: memo must be recognisable");

        // 6. And unpacking the TS bytes must recover the same fields.
        let parsed = unpack_memo(&expect_memo).unwrap_or_else(|e| panic!("{name}: unpack: {e}"));
        assert_eq!(parsed, fields, "{name}: round-tripped fields");
    }
}

#[test]
fn aad_scoping_differs_between_vectors() {
    // Guards the vector file itself: if every case accidentally used AAD (or none
    // did), the test above would still pass while never exercising the binding.
    let vectors = load_vectors();
    let with_aad = vectors.iter().filter(|(_, f)| !f["aad"].is_empty()).count();
    let without = vectors.len() - with_aad;
    assert!(with_aad > 0, "no vector exercises AAD binding");
    assert!(without > 0, "no vector exercises the no-AAD path");
}

#[test]
fn wrong_aad_cannot_open_a_vector_seal() {
    let vectors = load_vectors();
    let mut checked = 0;
    for (name, f) in vectors {
        let aad = f["aad"].clone();
        if aad.is_empty() {
            continue;
        }
        let sk = arr32(&unhex(&f["sk_refund"]), "sk_refund");
        let epk = arr32(&unhex(&f["epk_refund"]), "epk_refund");
        let sealed = unhex(&f["sealed"]);
        assert_eq!(
            open_refund_address(&sk, &epk, &sealed, Some(&[0u8; 16])),
            Err(VeiloError::UnlockFailed),
            "{name}: a wrong auction_id must not open the seal"
        );
        assert_eq!(
            open_refund_address(&sk, &epk, &sealed, None),
            Err(VeiloError::UnlockFailed),
            "{name}: omitting AAD must not open the seal"
        );
        checked += 1;
    }
    assert!(checked > 0, "no AAD-bound vector to check");
}
