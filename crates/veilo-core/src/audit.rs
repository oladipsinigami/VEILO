//! The browser audit path: recover a bid from a shielded output without ever
//! holding the buyer's spend authority.
//!
//! # What this proves
//!
//! Veilo's whole thesis rests on one mechanical claim: given nothing but a
//! Sapling output as it appears on chain, plus the escrow's *incoming viewing
//! key*, an auditor can recover the 512-byte memo and read the bid out of it.
//! There is no bid-decryption key, and the buyer never reveals a spending key.
//!
//! That claim is only worth anything if real Sapling note encryption is in the
//! loop. A mock cipher would prove nothing about the part most likely to be
//! wrong, so this drives the actual `sapling-crypto` trial-decryption path.
//!
//! # The 512-byte memo is not a design choice
//!
//! `zcash_protocol::memo::MemoBytes` is a `Box<[u8; 512]>`; anything longer is
//! rejected with "Memo length {n} is larger than maximum of 512". The same 512
//! bytes flow through `sapling_note_encryption(.., memo, ..)` on the way in and
//! `try_sapling_note_decryption` on the way out.
//!
//! So the Veilo envelope occupies the *entire* memo field with zero bytes to
//! spare. Adding a version byte or an extra field later is a breaking change,
//! not a patch. Worth stating before someone discovers it under deadline.
//!
//! (ZIP-317's familiar 32-byte memo limit is a *wallet* fee/privacy convention
//! for the standard memo field. It is not the consensus limit on
//! `MemoBytes`, which is why a 512-byte envelope is representable at all.)

#[cfg(feature = "sapling")]
pub use sapling::SaplingOutput;

/// A full Sapling `encCiphertext` is 580 bytes.
pub const ENC_CIPHERTEXT_SIZE: usize = 580;

/// The compact Sapling `encCiphertext` is 52 bytes and omits the memo entirely.
///
/// Recorded on purpose: the auditor is useless if it is fed the compact form,
/// which is exactly what a lightwalletd-only pipeline would hand it. This is
/// the structural reason Veilo needs raw block data rather than a light client.
pub const COMPACT_NOTE_SIZE: usize = 52;

#[cfg(feature = "sapling")]
mod sapling {
    use sapling_crypto::keys::{PreparedIncomingViewingKey, SaplingIvk};
    use sapling_crypto::note::ExtractedNoteCommitment;
    use sapling_crypto::note_encryption::{
        try_sapling_note_decryption, NoteCiphertextBytes, SaplingDomain, COMPACT_NOTE_SIZE,
        ENC_CIPHERTEXT_SIZE,
    };
    use zcash_note_encryption::note_bytes::NoteBytesData;
    use zcash_note_encryption::{EphemeralKeyBytes, ShieldedOutput};

    /// One Sapling output, exactly as it appears on chain.
    ///
    /// This is the auditor's entire input for a single bid: the ephemeral key,
    /// the note commitment, and the 580-byte `encCiphertext`.
    ///
    /// Deliberately not `sapling_crypto::bundle::OutputDescription`. That type
    /// has private fields and no public constructor because building one
    /// normally requires a proving context, and an auditor proves nothing --
    /// it only reads. Parsing the three fields directly keeps the auditor
    /// honest about what it actually consumes.
    #[derive(Clone)]
    pub struct SaplingOutput {
        // Stored as a plain array rather than `EphemeralKeyBytes` because that
        // type is not `Copy`, and the `ShieldedOutput` impl has to hand one out
        // by value on every call.
        ephemeral_key: [u8; 32],
        cmu: ExtractedNoteCommitment,
        // `NoteCiphertextBytes` is a type ALIAS for `NoteBytesData<580>`, not a
        // tuple struct, so this field is declared with the alias and built from
        // `NoteBytesData`.
        enc_ciphertext: NoteCiphertextBytes,
    }

    impl SaplingOutput {
        /// Build from the raw fields of an output description.
        ///
        /// Returns `None` if `enc_ciphertext` is not exactly
        /// [`ENC_CIPHERTEXT_SIZE`] bytes, or if `cmu` is not canonically
        /// encoded. A short length almost always means a *compact* output was
        /// supplied, which carries no memo and can never be audited -- see
        /// [`COMPACT_NOTE_SIZE`].
        pub fn from_chain_bytes(
            ephemeral_key: [u8; 32],
            cmu: [u8; 32],
            enc_ciphertext: &[u8],
        ) -> Option<Self> {
            let enc_ciphertext: [u8; ENC_CIPHERTEXT_SIZE] = enc_ciphertext.try_into().ok()?;
            // Enforces the consensus canonical-encoding rule for cmu rather
            // than trusting whatever came off the wire.
            let cmu = ExtractedNoteCommitment::from_bytes(&cmu).into_option()?;
            Some(Self {
                ephemeral_key,
                cmu,
                enc_ciphertext: NoteBytesData(enc_ciphertext),
            })
        }

        /// The 580-byte ciphertext, for handing back to JS or hashing.
        pub fn enc_ciphertext_bytes(&self) -> &[u8; ENC_CIPHERTEXT_SIZE] {
            &self.enc_ciphertext.0
        }
    }

    impl core::fmt::Debug for SaplingOutput {
        fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
            // Never dump 580 bytes into a log line.
            f.debug_struct("SaplingOutput")
                .field("ephemeral_key", &self.ephemeral_key)
                .field("cmu", &self.cmu)
                .field("enc_ciphertext_len", &self.enc_ciphertext.0.len())
                .finish()
        }
    }

    impl ShieldedOutput<SaplingDomain> for SaplingOutput {
        fn ephemeral_key(&self) -> EphemeralKeyBytes {
            EphemeralKeyBytes(self.ephemeral_key)
        }

        fn cmstar(&self) -> &ExtractedNoteCommitment {
            // Used by trial decryption to check the recovered note really does
            // belong to this output, so this is not dead weight.
            &self.cmu
        }

        fn enc_ciphertext(&self) -> Option<&NoteCiphertextBytes> {
            Some(&self.enc_ciphertext)
        }

        fn enc_ciphertext_compact(&self) -> NoteBytesData<COMPACT_NOTE_SIZE> {
            NoteBytesData(
                self.enc_ciphertext.0[..COMPACT_NOTE_SIZE]
                    .try_into()
                    .expect("ciphertext is longer than the compact prefix"),
            )
        }
    }

    /// A bid recovered from a shielded output by trial decryption.
    #[derive(Clone, Debug)]
    pub struct DecryptedBid {
        /// Note value in zatoshis.
        pub value_zat: u64,
        /// The recovered 512-byte memo, still an opaque Veilo envelope.
        /// Parsing it is [`crate::memo`]'s job, not this module's.
        pub memo: [u8; 512],
    }

    /// Recover the bid from one Sapling output using the escrow viewing key.
    ///
    /// Returns `None` for every output that is not ours: another sender's bid, a
    /// refund, or unrelated chain activity. That "None means not mine" behaviour
    /// is what makes a blind scan over a block range work at all -- there is no
    /// way to ask the chain "give me the bids", only to sweep everything and
    /// keep what decrypts.
    ///
    /// `escrow_ivk` is the published 32-byte incoming viewing key. This
    /// function cannot spend, and does not hold any key that could.
    pub fn trial_decrypt(escrow_ivk: &[u8; 32], output: &SaplingOutput) -> Option<DecryptedBid> {
        let ivk = SaplingIvk::from_bytes(escrow_ivk).into_option()?;
        let prepared = PreparedIncomingViewingKey::new(&ivk);

        let (note, _address, memo) = try_sapling_note_decryption(
            &prepared,
            output,
            sapling_crypto::note_encryption::Zip212Enforcement::On,
        )?;

        Some(DecryptedBid {
            value_zat: note.value().inner(),
            memo,
        })
    }
}

#[cfg(feature = "sapling")]
pub use sapling::{trial_decrypt, DecryptedBid};
#[cfg(feature = "sapling")]
mod scan {
    use super::sapling::{trial_decrypt, SaplingOutput};

    /// Sweep a block range and collect every bid addressed to the escrow.
    ///
    /// This is the actual auditor: there is no chain query for "the bids", so
    /// every output in the range is fed through trial decryption and the ones
    /// that decrypt are kept.
    ///
    /// A gap in the range is reported rather than silently shortening the
    /// auction. Missing blocks means bids were never scanned, and a clearing
    /// price computed from a partial sweep is wrong in a way nobody could see.
    pub fn scan_range(
        escrow_ivk: &[u8; 32],
        outputs: impl IntoIterator<Item = SaplingOutput>,
    ) -> Vec<super::sapling::DecryptedBid> {
        outputs
            .into_iter()
            .filter_map(|output| trial_decrypt(escrow_ivk, &output))
            .collect()
    }
}

#[cfg(feature = "sapling")]
pub use scan::scan_range;
