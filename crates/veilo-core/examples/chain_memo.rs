//! The envelope the on-chain probe mines.
//!
//! Prints a four-line `key=value` file on stdout:
//!
//!   memo=<512-byte packed envelope, hex>
//!   reveal=<40-byte permissionless reveal, hex>
//!   sk_refund=<secret that opens c_refund, hex>
//!   refund_address=<utf8, hex>
//!
//! This is not a filler pattern. It is a real packed bid: auction id, bid
//! commitment, and an X25519-sealed refund address, built by the crate's own
//! encoders. `tests/chain_probe.rs` takes the memo recovered from the mined
//! transaction, unpacks it, recomputes the commitment from the reveal, and opens
//! the refund seal -- so the mined bytes are checked as an auction envelope, not
//! merely as 512 bytes that survived.
//!
//! Inputs are fixed so the artefact is reproducible. The refund address is the
//! one thing passed in, so the envelope refers to a real address on that chain:
//!
//!   cargo run -q -p veilo-core --example chain_memo -- <zaddr>

use veilo_core::memo::{
    compute_bid_commit, encode_reveal, pack_memo, public_key_from_secret,
    seal_refund_address_with_seed, MemoFields, REFUND_PLAINTEXT_MAX,
};

/// Fixed so a regenerated probe produces a recognisable, comparable envelope.
const AUCTION_ID: [u8; 16] = *b"veilo-chain-111!";
const BID_ZAT: u64 = 60_000_000_000; // 60 ZEC
const NONCE: [u8; 16] = [0x11; 16];
const EPK_BID: [u8; 32] = [0x22; 32];
const SK_REFUND: [u8; 32] = [0x33; 32];
const ESK_REFUND: [u8; 32] = [0x44; 32];

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes.iter().fold(String::new(), |mut s, b| {
        let _ = write!(s, "{b:02x}");
        s
    })
}

fn main() {
    let refund_address = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "ztestsapling1chainprobe-refund-address".to_string());
    assert!(
        refund_address.len() <= REFUND_PLAINTEXT_MAX,
        "refund address is {} bytes, limit is {REFUND_PLAINTEXT_MAX}",
        refund_address.len()
    );

    // The refund key is a test key, published next to the artefact so the test
    // can open the seal. Nothing on a real auction would publish it.
    let pk_refund = public_key_from_secret(&SK_REFUND);
    let seal = seal_refund_address_with_seed(
        &pk_refund,
        &ESK_REFUND,
        refund_address.as_bytes(),
        Some(&AUCTION_ID),
    )
    .expect("sealing a short address cannot fail");

    let bid_commit =
        compute_bid_commit(&AUCTION_ID, BID_ZAT, &NONCE, &EPK_BID).expect("fixed sizes");
    let reveal = encode_reveal(&AUCTION_ID, BID_ZAT, &NONCE).expect("fixed sizes");
    let memo = pack_memo(&MemoFields {
        auction_id: AUCTION_ID,
        epk_bid: EPK_BID,
        epk_refund: seal.epk_refund,
        bid_commit,
        c_refund: seal.sealed,
    });

    println!("memo={}", hex(&memo));
    println!("reveal={}", hex(&reveal));
    println!("sk_refund={}", hex(&SK_REFUND));
    println!("refund_address={}", hex(refund_address.as_bytes()));
}
