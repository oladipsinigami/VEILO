//! Veilo — 512-byte memo codec (Part 3 §5, Revision 2).
//!
//! Rust half of the two-implementation pair. `web/src/lib/memo.ts` is the other
//! half. They MUST produce identical bytes for identical inputs, because the
//! bidder's browser packs the envelope and the auditor's WASM unpacks it. If they
//! ever diverge, every bid becomes unreadable and every audit silently fails.
//!
//! `test/vectors.txt` is generated from the TypeScript side and replayed by
//! `tests::replay_ts_vectors`, which is the only thing keeping the two honest.

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use x25519_dalek::{PublicKey, StaticSecret};

pub mod layout {
    pub const MEMO_SIZE: usize = 512;
    pub const MAGIC_LEAD: u8 = 0xFF;
    pub const PROTOCOL_TAG: [u8; 4] = [0x56, 0x4C, 0x4F, 0x01]; // "VLO\x01"

    pub const AUCTION_ID_SIZE: usize = 16;
    pub const EPK_SIZE: usize = 32;
    pub const NONCE_SIZE: usize = 16;
    pub const BID_COMMIT_SIZE: usize = 32;

    /// 216 B padded plaintext + 16 B Poly1305 tag.
    pub const C_REFUND_SIZE: usize = 232;
    pub const REFUND_PLAINTEXT_MAX: usize = C_REFUND_SIZE - 16;

    pub const OFF_MAGIC_LEAD: usize = 0;
    pub const OFF_PROTOCOL_TAG: usize = 1;
    pub const OFF_AUCTION_ID: usize = 5;
    pub const OFF_EPK_BID: usize = 21;
    pub const OFF_EPK_REFUND: usize = 53;
    pub const OFF_BID_COMMIT: usize = 85;
    pub const OFF_C_REFUND: usize = 117;
    /// First byte of the deterministic zero-padding region.
    pub const OFF_PADDING: usize = 349;
}

pub use layout::*;

/// Domain separation tags. Must match the TypeScript constants exactly.
pub const BID_DOMAIN: &str = "VEILO-BID-V1";
pub const PAD_DOMAIN: &str = "VEILO-PAD-V1";

#[derive(Debug, PartialEq, Eq)]
pub enum VeiloError {
    SizeMismatch(String),
    InvalidMagic,
    InvalidProtocolTag,
    NonZeroPadding,
    RefundAddressTooLong(usize),
    UnlockFailed,
    SealFailed,
}

impl core::fmt::Display for VeiloError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            VeiloError::SizeMismatch(s) => write!(f, "size mismatch: {s}"),
            VeiloError::InvalidMagic => write!(f, "memo does not start with 0xFF"),
            VeiloError::InvalidProtocolTag => write!(f, "protocol tag mismatch"),
            VeiloError::NonZeroPadding => write!(f, "padding region is not all zero"),
            VeiloError::RefundAddressTooLong(n) => {
                write!(f, "refund address is {n} bytes, max {REFUND_PLAINTEXT_MAX}")
            }
            VeiloError::UnlockFailed => write!(f, "c_refund failed authentication"),
            VeiloError::SealFailed => write!(f, "c_refund encryption failed"),
        }
    }
}

impl std::error::Error for VeiloError {}

// ---------------------------------------------------------------------------
// Domain-separated BLAKE2b-256
// ---------------------------------------------------------------------------

/// BLAKE2b-256 over a length-delimited concatenation: `u32le(len)||part` for each.
///
/// Length prefixing is what makes the encoding unambiguous, so `("ab", "c")` and
/// `("a", "bc")` cannot collide. Mirrors `domainBlake2b` in memo.ts.
pub fn domain_blake2b_256(domain: &str, parts: &[&[u8]]) -> [u8; 32] {
    use blake2::digest::{Update, VariableOutput};

    let mut h = blake2::Blake2bVar::new(32).expect("32 is a valid BLAKE2b output size");
    h.update(&(domain.len() as u32).to_le_bytes());
    h.update(domain.as_bytes());
    for part in parts {
        h.update(&(part.len() as u32).to_le_bytes());
        h.update(part);
    }
    let mut out = [0u8; 32];
    h.finalize_variable(&mut out)
        .expect("output buffer matches declared size");
    out
}

/// Plain BLAKE2b with a non-64-byte output. Used only for the derived AEAD nonce.
fn blake2b_short(data: &[u8], out_len: usize) -> Vec<u8> {
    use blake2::digest::{Update, VariableOutput};
    let mut h = blake2::Blake2bVar::new(out_len).expect("valid output size");
    h.update(data);
    let mut out = vec![0u8; out_len];
    h.finalize_variable(&mut out).expect("buffer matches size");
    out
}

fn u64le(v: u64) -> [u8; 8] {
    v.to_le_bytes()
}

// ---------------------------------------------------------------------------
// Randomness
// ---------------------------------------------------------------------------

/// Derive an X25519 public key from a secret.
///
/// Note the reference form. dalek 2.x implements `From<&StaticSecret> for PublicKey`
/// (derives the key) but NOT `From<StaticSecret>`; and `From<[u8; 32]> for PublicKey`
/// means "these bytes ARE an encoded public key", not "derive from this secret".
/// Using the wrong one silently yields a public key equal to the secret bytes, and
/// every subsequent ECDH comes out asymmetric.
pub fn public_key_from_secret(sk: &[u8; 32]) -> [u8; 32] {
    PublicKey::from(&StaticSecret::from(*sk)).to_bytes()
}

fn random32() -> Result<[u8; 32], VeiloError> {
    let mut buf = [0u8; 32];
    getrandom::getrandom(&mut buf)
        .map_err(|e| VeiloError::SizeMismatch(format!("CSPRNG unavailable: {e}")))?;
    Ok(buf)
}

// ---------------------------------------------------------------------------
// Commitment (I1)
// ---------------------------------------------------------------------------

/// `BLAKE2b-256("VEILO-BID-V1" || auction_id || bid_zat_le || nonce || epk_bid)`
pub fn compute_bid_commit(
    auction_id: &[u8],
    bid_zat: u64,
    nonce: &[u8],
    epk_bid: &[u8],
) -> Result<[u8; 32], VeiloError> {
    if auction_id.len() != AUCTION_ID_SIZE {
        return Err(VeiloError::SizeMismatch(format!(
            "auction_id must be {AUCTION_ID_SIZE} bytes, got {}",
            auction_id.len()
        )));
    }
    if nonce.len() != NONCE_SIZE {
        return Err(VeiloError::SizeMismatch(format!(
            "nonce must be {NONCE_SIZE} bytes, got {}",
            nonce.len()
        )));
    }
    if epk_bid.len() != EPK_SIZE {
        return Err(VeiloError::SizeMismatch(format!(
            "epk_bid must be {EPK_SIZE} bytes, got {}",
            epk_bid.len()
        )));
    }
    Ok(domain_blake2b_256(
        BID_DOMAIN,
        &[auction_id, &u64le(bid_zat), nonce, epk_bid],
    ))
}

/// The 40-byte permissionless reveal: `auction_id(16) || bid_zat_le(8) || nonce(16)`.
pub fn encode_reveal(
    auction_id: &[u8],
    bid_zat: u64,
    nonce: &[u8],
) -> Result<[u8; 40], VeiloError> {
    if auction_id.len() != AUCTION_ID_SIZE || nonce.len() != NONCE_SIZE {
        return Err(VeiloError::SizeMismatch(
            "reveal requires a 16-byte auction_id and 16-byte nonce".into(),
        ));
    }
    let mut out = [0u8; 40];
    out[..16].copy_from_slice(auction_id);
    out[16..24].copy_from_slice(&u64le(bid_zat));
    out[24..].copy_from_slice(nonce);
    Ok(out)
}

// ---------------------------------------------------------------------------
// Sealed refund address (I4)
// ---------------------------------------------------------------------------

pub struct RefundSeal {
    pub epk_refund: [u8; EPK_SIZE],
    pub sealed: [u8; C_REFUND_SIZE],
}

/// The AEAD nonce is derived from `epk_refund` rather than transmitted, because the
/// 232-byte field is fully consumed by 216 B of plaintext plus a 16 B tag.
/// `epk_refund` is a fresh random ephemeral per seal and is already on chain at
/// offset 53, so deriving from it yields a nonce unique per (key, message) without
/// spending any of the envelope.
fn derived_nonce(epk_refund: &[u8]) -> [u8; 12] {
    let v = blake2b_short(epk_refund, 12);
    let mut out = [0u8; 12];
    out.copy_from_slice(&v);
    out
}

fn derive_pad_key(shared: &[u8; 32]) -> [u8; 32] {
    domain_blake2b_256(PAD_DOMAIN, &[shared])
}

/// Encrypt `refund_address` to `pk_refund`, using the supplied ephemeral seed.
///
/// The seed is a parameter so cross-implementation test vectors can pin it. Callers
/// that do not care should use [`seal_refund_address`], which draws from the CSPRNG.
pub fn seal_refund_address_with_seed(
    pk_refund: &[u8],
    esk_refund: &[u8; 32],
    refund_address: &[u8],
    aad: Option<&[u8]>,
) -> Result<RefundSeal, VeiloError> {
    if pk_refund.len() != EPK_SIZE {
        return Err(VeiloError::SizeMismatch(format!(
            "PK_refund must be {EPK_SIZE} bytes, got {}",
            pk_refund.len()
        )));
    }
    if refund_address.len() > REFUND_PLAINTEXT_MAX {
        return Err(VeiloError::RefundAddressTooLong(refund_address.len()));
    }

    let esk = StaticSecret::from(*esk_refund);
    let epk = PublicKey::from(&esk);
    let shared = esk
        .diffie_hellman(&PublicKey::from(<[u8; 32]>::try_from(pk_refund).map_err(
            |_| VeiloError::SizeMismatch("PK_refund must be 32 bytes".into()),
        )?));
    let key = derive_pad_key(&shared.to_bytes());

    let mut padded = [0u8; REFUND_PLAINTEXT_MAX];
    padded[..refund_address.len()].copy_from_slice(refund_address);

    let nonce = derived_nonce(epk.as_bytes());
    let cipher = ChaCha20Poly1305::new(Key::from_slice(&key));
    let ct = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &padded,
                aad: aad.unwrap_or(&[]),
            },
        )
        .map_err(|_| VeiloError::SealFailed)?;

    let mut sealed = [0u8; C_REFUND_SIZE];
    sealed.copy_from_slice(&ct);
    Ok(RefundSeal {
        epk_refund: epk.to_bytes(),
        sealed,
    })
}

/// Encrypt using a fresh CSPRNG ephemeral.
pub fn seal_refund_address(
    pk_refund: &[u8],
    refund_address: &[u8],
    aad: Option<&[u8]>,
) -> Result<RefundSeal, VeiloError> {
    let esk = random32()?;
    seal_refund_address_with_seed(pk_refund, &esk, refund_address, aad)
}

/// Auctioneer-side open. Takes the SECRET, never the public key.
pub fn open_refund_address(
    sk_refund: &[u8; 32],
    epk_refund: &[u8],
    sealed: &[u8],
    aad: Option<&[u8]>,
) -> Result<String, VeiloError> {
    if sealed.len() != C_REFUND_SIZE {
        return Err(VeiloError::SizeMismatch(format!(
            "c_refund must be {C_REFUND_SIZE} bytes, got {}",
            sealed.len()
        )));
    }
    if epk_refund.len() != EPK_SIZE {
        return Err(VeiloError::SizeMismatch(format!(
            "epk_refund must be {EPK_SIZE} bytes, got {}",
            epk_refund.len()
        )));
    }

    let esk = StaticSecret::from(*sk_refund);
    let shared = esk
        .diffie_hellman(&PublicKey::from(<[u8; 32]>::try_from(epk_refund).map_err(
            |_| VeiloError::SizeMismatch("epk_refund must be 32 bytes".into()),
        )?));
    let key = derive_pad_key(&shared.to_bytes());

    let cipher = ChaCha20Poly1305::new(Key::from_slice(&key));
    let pt = cipher
        .decrypt(
            Nonce::from_slice(&derived_nonce(epk_refund)),
            Payload {
                msg: sealed,
                aad: aad.unwrap_or(&[]),
            },
        )
        .map_err(|_| VeiloError::UnlockFailed)?;

    let end = pt.iter().rposition(|&b| b != 0).map_or(0, |i| i + 1);
    if end == 0 {
        return Err(VeiloError::UnlockFailed);
    }
    String::from_utf8(pt[..end].to_vec()).map_err(|_| VeiloError::UnlockFailed)
}

// ---------------------------------------------------------------------------
// Memo pack / unpack
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MemoFields {
    pub auction_id: [u8; AUCTION_ID_SIZE],
    pub epk_bid: [u8; EPK_SIZE],
    pub epk_refund: [u8; EPK_SIZE],
    pub bid_commit: [u8; BID_COMMIT_SIZE],
    pub c_refund: [u8; C_REFUND_SIZE],
}

fn expect<const N: usize>(src: &[u8], what: &str) -> Result<[u8; N], VeiloError> {
    <[u8; N]>::try_from(src)
        .map_err(|_| VeiloError::SizeMismatch(format!("{what} must be {N} bytes")))
}

pub fn pack_memo(fields: &MemoFields) -> [u8; MEMO_SIZE] {
    let mut memo = [0u8; MEMO_SIZE];
    memo[OFF_MAGIC_LEAD] = MAGIC_LEAD;
    memo[OFF_PROTOCOL_TAG..OFF_PROTOCOL_TAG + 4].copy_from_slice(&PROTOCOL_TAG);
    memo[OFF_AUCTION_ID..OFF_AUCTION_ID + AUCTION_ID_SIZE].copy_from_slice(&fields.auction_id);
    memo[OFF_EPK_BID..OFF_EPK_BID + EPK_SIZE].copy_from_slice(&fields.epk_bid);
    memo[OFF_EPK_REFUND..OFF_EPK_REFUND + EPK_SIZE].copy_from_slice(&fields.epk_refund);
    memo[OFF_BID_COMMIT..OFF_BID_COMMIT + BID_COMMIT_SIZE].copy_from_slice(&fields.bid_commit);
    memo[OFF_C_REFUND..OFF_C_REFUND + C_REFUND_SIZE].copy_from_slice(&fields.c_refund);
    // OFF_PADDING..MEMO_SIZE stays 0x00 by construction of the zeroed buffer.
    debug_assert_eq!(OFF_C_REFUND + C_REFUND_SIZE, OFF_PADDING);
    memo
}

pub fn is_veilo_memo(memo: &[u8]) -> bool {
    memo.len() >= 1 + PROTOCOL_TAG.len()
        && memo[OFF_MAGIC_LEAD] == MAGIC_LEAD
        && memo[OFF_PROTOCOL_TAG..OFF_PROTOCOL_TAG + 4] == PROTOCOL_TAG
}

/// Strict parse: a malformed envelope is an error, never a silently-truncated bid.
pub fn unpack_memo(memo: &[u8]) -> Result<MemoFields, VeiloError> {
    if memo.len() != MEMO_SIZE {
        return Err(VeiloError::SizeMismatch(format!(
            "memo must be {MEMO_SIZE} bytes, got {}",
            memo.len()
        )));
    }
    if memo[OFF_MAGIC_LEAD] != MAGIC_LEAD {
        return Err(VeiloError::InvalidMagic);
    }
    if memo[OFF_PROTOCOL_TAG..OFF_PROTOCOL_TAG + 4] != PROTOCOL_TAG {
        return Err(VeiloError::InvalidProtocolTag);
    }
    if memo[OFF_PADDING..MEMO_SIZE].iter().any(|&b| b != 0) {
        return Err(VeiloError::NonZeroPadding);
    }
    Ok(MemoFields {
        auction_id: expect(
            &memo[OFF_AUCTION_ID..OFF_AUCTION_ID + AUCTION_ID_SIZE],
            "auction_id",
        )?,
        epk_bid: expect(&memo[OFF_EPK_BID..OFF_EPK_BID + EPK_SIZE], "epk_bid")?,
        epk_refund: expect(
            &memo[OFF_EPK_REFUND..OFF_EPK_REFUND + EPK_SIZE],
            "epk_refund",
        )?,
        bid_commit: expect(
            &memo[OFF_BID_COMMIT..OFF_BID_COMMIT + BID_COMMIT_SIZE],
            "bid_commit",
        )?,
        c_refund: expect(
            &memo[OFF_C_REFUND..OFF_C_REFUND + C_REFUND_SIZE],
            "c_refund",
        )?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_offsets_are_contiguous() {
        assert_eq!(OFF_AUCTION_ID, OFF_PROTOCOL_TAG + 4);
        assert_eq!(OFF_EPK_BID, OFF_AUCTION_ID + AUCTION_ID_SIZE);
        assert_eq!(OFF_EPK_REFUND, OFF_EPK_BID + EPK_SIZE);
        assert_eq!(OFF_BID_COMMIT, OFF_EPK_REFUND + EPK_SIZE);
        assert_eq!(OFF_C_REFUND, OFF_BID_COMMIT + BID_COMMIT_SIZE);
        assert_eq!(OFF_PADDING, OFF_C_REFUND + C_REFUND_SIZE);
        assert_eq!(OFF_PADDING, 349);
        assert_eq!(MEMO_SIZE, 512);
        // 52 compact + 512 memo + 16 tag = the 580-byte encCiphertext
        assert_eq!(52 + MEMO_SIZE + 16, 580);
    }

    #[test]
    fn commitment_is_deterministic_and_binds_every_input() {
        let a = [0x11u8; 16];
        let n = [0x22u8; 16];
        let e = [0x33u8; 32];
        let base = compute_bid_commit(&a, 500, &n, &e).unwrap();

        assert_eq!(base, compute_bid_commit(&a, 500, &n, &e).unwrap());
        assert_ne!(base, compute_bid_commit(&a, 501, &n, &e).unwrap());
        assert_ne!(
            base,
            compute_bid_commit(&a, 500, &[0x23u8; 16], &e).unwrap()
        );
        assert_ne!(
            base,
            compute_bid_commit(&[0x12u8; 16], 500, &n, &e).unwrap()
        );
        assert_ne!(
            base,
            compute_bid_commit(&a, 500, &n, &[0x34u8; 32]).unwrap()
        );
    }

    #[test]
    fn seal_open_round_trips_with_aad() {
        let sk = [7u8; 32];
        let pk = public_key_from_secret(&sk);
        let aad = [0xABu8; 16];
        let addr = b"utest1exampleaddress";

        let seal = seal_refund_address_with_seed(&pk, &[9u8; 32], addr, Some(&aad)).unwrap();
        assert_eq!(seal.sealed.len(), C_REFUND_SIZE);
        assert_eq!(
            open_refund_address(&sk, &seal.epk_refund, &seal.sealed, Some(&aad)).unwrap(),
            "utest1exampleaddress"
        );

        // Wrong AAD must fail: this is what binds the seal to one auction.
        assert_eq!(
            open_refund_address(&sk, &seal.epk_refund, &seal.sealed, Some(&[0u8; 16])),
            Err(VeiloError::UnlockFailed)
        );
        assert_eq!(
            open_refund_address(&sk, &seal.epk_refund, &seal.sealed, None),
            Err(VeiloError::UnlockFailed)
        );
    }

    #[test]
    fn wrong_secret_cannot_open() {
        let sk = [7u8; 32];
        let pk = public_key_from_secret(&sk);
        let seal = seal_refund_address_with_seed(&pk, &[9u8; 32], b"addr", None).unwrap();
        assert_eq!(
            open_refund_address(&[8u8; 32], &seal.epk_refund, &seal.sealed, None),
            Err(VeiloError::UnlockFailed)
        );
    }

    #[test]
    fn tampering_is_detected() {
        let sk = [7u8; 32];
        let pk = public_key_from_secret(&sk);
        let seal = seal_refund_address_with_seed(&pk, &[9u8; 32], b"addr", None).unwrap();
        let mut bad = seal.sealed;
        bad[10] ^= 0x01;
        assert_eq!(
            open_refund_address(&sk, &seal.epk_refund, &bad, None),
            Err(VeiloError::UnlockFailed)
        );
    }

    #[test]
    fn seal_is_deterministic_given_the_seed() {
        let sk = [7u8; 32];
        let pk = public_key_from_secret(&sk);
        let a = seal_refund_address_with_seed(&pk, &[9u8; 32], b"addr", None).unwrap();
        let b = seal_refund_address_with_seed(&pk, &[9u8; 32], b"addr", None).unwrap();
        assert_eq!(a.sealed, b.sealed);
        assert_eq!(a.epk_refund, b.epk_refund);
    }

    #[test]
    fn over_long_address_is_rejected() {
        let pk = public_key_from_secret(&[7u8; 32]);
        let long = vec![b'x'; REFUND_PLAINTEXT_MAX + 1];
        assert!(matches!(
            seal_refund_address_with_seed(&pk, &[9u8; 32], &long, None),
            Err(VeiloError::RefundAddressTooLong(_))
        ));
    }

    #[test]
    fn memo_round_trips_and_rejects_tampering() {
        let fields = MemoFields {
            auction_id: [0x01; 16],
            epk_bid: [0x02; 32],
            epk_refund: [0x03; 32],
            bid_commit: [0x04; 32],
            c_refund: [0x05; C_REFUND_SIZE],
        };
        let memo = pack_memo(&fields);
        assert_eq!(memo.len(), MEMO_SIZE);
        assert!(is_veilo_memo(&memo));
        assert_eq!(memo[OFF_PADDING..].iter().all(|&b| b == 0), true);

        let parsed = unpack_memo(&memo).unwrap();
        assert_eq!(parsed.bid_commit, fields.bid_commit);
        assert_eq!(parsed.c_refund, fields.c_refund);

        let mut bad_magic = memo;
        bad_magic[0] = 0x02;
        assert_eq!(unpack_memo(&bad_magic), Err(VeiloError::InvalidMagic));
        assert!(!is_veilo_memo(&bad_magic));

        let mut bad_tag = memo;
        bad_tag[2] ^= 1;
        assert_eq!(unpack_memo(&bad_tag), Err(VeiloError::InvalidProtocolTag));

        let mut bad_pad = memo;
        bad_pad[400] = 1;
        assert_eq!(unpack_memo(&bad_pad), Err(VeiloError::NonZeroPadding));
    }

    #[test]
    fn plaintext_memo_is_not_a_veilo_envelope() {
        let mut m = [0u8; MEMO_SIZE];
        m[..5].copy_from_slice(b"hello");
        assert!(!is_veilo_memo(&m));
    }

    #[test]
    fn reveal_is_forty_bytes_and_round_trips() {
        let r = encode_reveal(&[0x01; 16], 987_654_321, &[0x02; 16]).unwrap();
        assert_eq!(r.len(), 40);
        assert_eq!(&r[..16], &[0x01u8; 16]);
        assert_eq!(
            u64::from_le_bytes(r[16..24].try_into().unwrap()),
            987_654_321
        );
        assert_eq!(&r[24..], &[0x02u8; 16]);
    }
}
