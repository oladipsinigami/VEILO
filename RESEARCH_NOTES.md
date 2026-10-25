# Research notes — empirical findings

This log records what we learned by **building and running** things, as opposed
to `VEILO_BLUEPRINT.md` Appendix A, which records what we learned by **reading
specifications**. The distinction matters: everything below cost us a failed
build, a broken run, or a wrong assumption to discover.

Every entry is reproducible. Sources are named so a judge can check rather than
trust.

Sessions: 13–15 October 2026.

---

## 1. The 512-byte memo is exactly right — and ZIP-317 nearly made us doubt it

**Claim under test.** Our envelope uses all 512 bytes of the Zcash memo field.

**How we almost got it wrong.** ZIP-317 is widely described as imposing a
32-byte memo limit. That is true of *wallet conventions* for the standard memo
field, not of consensus. Reading only ZIP-317 would have told us the design was
impossible.

**Verified.** `zcash_protocol::memo::MemoBytes` is `Box<[u8; 32...]` of exactly
512 bytes:

```rust
pub struct MemoBytes(pub(crate) Box<[u8; 512]>);
```

with `Error::TooLong(n) => "Memo length {n} is larger than maximum of 512"`, and
shorter inputs null-padded. The same `[u8; 512]` flows through
`sapling_note_encryption(.., memo, ..)` and comes back out of
`try_sapling_note_decryption`.

**Consequence for the design.** Zero headroom. Our envelope occupies the entire
field, so adding a version byte later is a breaking change. Recorded as
limitation 6 in the README.

**Source:** `zcash_protocol-0.6.0/src/memo.rs` (crate tarball, `static.crates.io`).

---

## 2. Compact outputs carry no memo — and failing silently is the real danger

`COMPACT_NOTE_SIZE = 52` versus `ENC_CIPHERTEXT_SIZE = 580`. The 512-byte memo
lives in the difference.

This is not academic. A light-client pipeline hands the auditor 52 bytes. If the
auditor treats that as "no bid here", the failure is **indistinguishable from a
real result** — a missed audit and an empty auction look identical.

**Our response.** `SaplingOutput::from_chain_bytes` rejects anything that is not
exactly 580 bytes, and `AuditError::CompactCiphertext` is a distinct variant from
"not ours". Tested in both Rust and the WASM layer.

**Source:** `sapling-crypto-0.9.0/src/note_encryption.rs:41-55`.

---

## 3. `zebrad` has no wallet whatsoever

**Finding.** `z_getnewaddress`, `z_getbalance` and `z_sendmany` all return
`-32601 "Method not found"`.

```
{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found"}}
```

**Consequence.** Any plan that funds a wallet, mints a shielded address, or
attaches a memo to a shielded output using `zebrad` cannot work. We lost a
regtest cycle to this before checking.

---

## 4. `zcashd` is end-of-life — permanently

`zcashd` 6.20.0 contains a hard-coded `DEPRECATION_HEIGHT`. At block 3417100
(18 July 2026) **every binary shuts down and refuses to restart**. It also does
not support NU6.3.

**Consequence.** There is no supported Zcash node with a wallet. This is the
single most important fact for anyone building on Zcash today, and it is not
obvious from a search — several community threads still recommend `zcashd`.

**Source:** `z.cash/support/zcashd-deprecation/`.

---

## 5. Zallet is the successor, but is *not* standalone — and cannot read a current zebrad

`Zallet` v0.1.0-beta.3 (26 Aug 2026) is the supported wallet. It ships a
prebuilt `linux-amd64` tarball (144,229,522 bytes), so nothing needs compiling.

**It needs a full node.** Its config describes `[indexer] validator_address` as
*"the JSON-RPC interface for the full node / validator being used as a data
source"*, and warns that `[consensus]` **must** match that node. So the stack is
always `zebrad` + `Zallet`.

**And the versions do not line up:**

| component | zebra-state |
| :--- | :--- |
| Zallet v0.1.0-beta.3 expects | **12.0.1** |
| `zebrad` v6.3.0 (Aug 10) | 13.0.0 |
| `zebrad` v6.4.2 (Sep 25) | 14.0.0 |
| `zebrad` v7.0.0-rc.0 (Oct 2) | 15.0.0 |

Zallet opens zebrad's RocksDB read-only as a secondary instance, so the on-disk
format must match exactly. Result:

```
no zebra-state v28 database found under '/tmp/zebra-cache'
```

The format bumps roughly monthly, so this should resolve when Zallet ships a
release built against a newer `zebra-state`. Our CI job is kept and still runs
(non-blocking) so it turns green the moment that happens.

**Sources:** `zcash/zallet` `backends/zebra/Cargo.lock`; `ZcashFoundation/zebra`
release tags; `ops/README.md`.

---

## 6. `zebrad`'s `indexer_listen_addr` speaks gRPC, not JSON-RPC

We wasted time feeding that port an HTTP request and getting

```
curl: (1) Received HTTP/0.9 when not allowed
```

which looked like a broken node. It was gRPC being handed HTTP. The port only
exists at all in a build with `--features indexer`, and Zallet's `zebra-state`
backend requires it. The main `rpc.listen_addr` is the one that answers
`getblockcount`.

**Consequence.** Two RPC surfaces, different protocols, and the one you want
depends on which client you are.

---

## 7. `zebrad` cannot mine regtest block 1 (upstream #8434)

Three separate gates land on height 1:

| Requirement | Why | Symptom |
| :--- | :--- | :--- |
| `Overwinter == 1` | block-1 coinbase uses the v4 sighash | `Signature hashing for pre-overwinter transactions is not supported` |
| `Heartwood == 1` | block 1 is the only block with no stored chain history root | `history root is required for block templates` |
| `Canopy == 1` | pre-Canopy coinbase transactions are unimplemented | `does not support generating pre-Canopy block templates` |

`Heartwood == 1` and `Canopy == 1` are **mutually exclusive**: activation heights
are a `BTreeMap<Height, NetworkUpgrade>`, so two upgrades at one height collide
and the later silently overwrites the earlier. Block 1 is therefore unminable on
this commit.

This is zebra's own open issue, referenced in
`zebra-chain/src/parameters/network.rs` as **#8434**.

**Consequence.** Regtest cannot be used to create the demo outputs. The demo
generates real ciphertexts directly instead.

---

## 8. Testnet is currently Valar's NU7 fork — and most faucets are broken

Testnet ran an NU7 upgrade. Confirmed on the community forum (9 Oct 2026):

> *"Valar's faucet gives 0.125 TAZ a day, jinolabs is paused for NU7, and
> Fauzec's drips land on the old pre-NU7 chain, so they never arrive."*

The dangerous part is that **Fauzec still returns HTTP 200 and reports your
claim as confirmed.** The funds simply arrive on a chain your wallet does not
follow. That is a silent failure, which is worse than an error.

| Faucet | Status |
| :--- | :--- |
| fauzec.com | broken — confirms claims that never arrive |
| zcashfaucet.jinolabs.xyz | paused for NU7 |
| **faucet.testnet.valargroup.dev** | works — 0.125 TAZ / 24 h, transparent or unified |

**Consequence.** Testnet credibility is available but not trivial, and it depends
on a third party's Zebra fork. Noted as a limitation.

---

## 9. `sapling-crypto` builds for `wasm32-unknown-unknown` — with the right features

This gated the entire browser auditor, so it was checked before writing exports.

`sapling-crypto`'s **default features are `["multicore", "circuit", "zeroize"]`** —
rayon plus bellman/groth16, all wrong for a browser auditor that only decrypts
notes. `default-features = false, features = ["std"]` is sufficient and compiles
clean for wasm32.

Note `"alloc"` is **not** a feature of this crate; using it fails resolution.

---

## 10. `wasm-bindgen-cli` must match the `wasm-bindgen` crate version exactly

`cargo build --target wasm32-unknown-unknown` alone produces a `.wasm` a browser
cannot call. The CLI post-processes it into loadable bindings, and a version
mismatch compiles fine and then fails at runtime with an opaque error.

`ops/build-wasm.sh` reads the version out of `Cargo.lock` rather than hardcoding
it, so the two cannot drift.

---

## 11. A feature-gated test can be green while never running

`cargo test --all` builds **without** the `sapling` feature, so every
trial-decryption and WASM-export test was silently skipped — locally, in CI,
everywhere. It looked green the entire time.

**Lesson.** A test that never executes reports success. Coverage of a
feature-gated path requires a step that explicitly enables it.

---

## 12. `!inputs.skip_zebra` is true on push events

Our CI ran a known-broken regtest job on **every push**, because for a `push`
event the `skip_zebra` workflow input is unset and `!null` is `true`. Every push
went red for a long time, which made a green run meaningless.

**Lesson.** A required-status check that is permanently failing trains everyone to
ignore it. Known-broken exploration does not belong on the merge gate.

---

## 13. Two Zallet config schemas, both discovered the hard way

Three attempts, each failing with a precise parser error:

| Attempt | Error |
| :--- | :--- |
| `[rpc] user` / `password` | `unknown field 'user'` — the example config still prints them commented out |
| `auth = "user:pass"` | `invalid type: string, expected a sequence` |
| `auth = ["user:pass"]` | `invalid type: string, expected struct RpcAuthSection` |

The working form is a table section:

```toml
[[rpc.auth]]
user = "veilo"
password = "..."
```

**Also:** hand-writing a minimal config fails with `missing field 'builder'` —
every table must be present even when empty. Start from `zallet example-config`
and override only what you need.

**Lesson.** `example-config` is not a schema reference; it emits commented keys
the parser rejects.

---

## 14. A video that will not seek usually means the server, not the file

Recording the demo video meant playing a local file back to verify it. Every
probe returned the identical frame, and Chrome reported `seekable = [0, 0]`.

The file was fine. **The test server had no HTTP Range support.** Chrome cannot
seek a media response that does not answer `206 Partial Content`, so it clamps
every `currentTime` assignment to zero — and each probe then reads frame zero,
which is indistinguishable from a corrupt video.

Adding `Accept-Ranges: bytes` and a single-range `206` handler changed the same
file from `seekable = [0, 0]` to `seekable = [0, 52.84]` and five distinct
frames.

**Lesson.** Before concluding an artifact is corrupt, check that the harness
serving it can do what the client is asking for. We had already written off a
correct MP4 on this basis.

---

## 15. Chrome's `MediaRecorder` writes a wrong `mdhd.duration`

Recorded WebM converted to MP4 in-browser (Chrome 152 can encode H.264 through
`MediaRecorder`) produced a 52-second clip that reported **1.74 s**. Parsing the
boxes by hand rather than guessing:

| field | value | reads as |
| :--- | :--- | :--- |
| `mvhd` | timescale 1000, duration 52269 | 52.269 s ✅ |
| `mdhd` | timescale **30000**, duration **52269** | 1.742 s ❌ |
| `tfdt` fragments | 0 → 1,499,751 | spans the clip ✅ |
| `mfhd` | 16 fragments, no sequence gaps | complete ✅ |

`mdhd.duration` was written using the *movie* timescale value while
`mdhd.timescale` stayed at the media timescale. Every other timing field agreed
with a complete 52-second file. So the audio/video is all there; only one
header field lies, and any player that trusts it reports the wrong length.

A second, smaller defect: `trun` sample durations come out a few percent long,
so the clip plays slightly slow even after fixing `mdhd`.

`ops/webm-to-mp4.mjs` corrects both by parsing the fragment timeline and
rescaling it to the known source duration. This is a timestamp rewrite, not a
re-encode.

**Lesson.** "The duration is wrong" and "the file is truncated" look identical
from a player's error message. Reading the container apart is what separates
them, and it took a hand-written box parser to do it because no `ffprobe` was
available.

---

## 16. Regtest activates nothing, and Canopy is the upgrade that decides whether the auditor can read the note

`zcashd -regtest` starts with **every** network upgrade inactive. Without
`-nuparams`, Sapling is not active and shielded RPCs fail. The upgrades must be
switched on in order, keyed by branch ID from
`src/consensus/upgrades.cpp`:

| upgrade | branch ID | height |
| :--- | :--- | ---: |
| Overwinter | `5ba81b19` | 1 |
| Sapling | `76b809bb` | 2 |
| Blossom | `2bb40e60` | 3 |
| Heartwood | `f5b9230b` | 4 |
| Canopy | `e9ff75a6` | 5 |

The first working probe stopped after Sapling, and produced a valid v4
transaction that mined cleanly. The auditor still could not read it: the note
plaintext led with `0x01`, because ZIP 212 note encryption only becomes
mandatory at **Canopy**, and `trial_decrypt` enforces ZIP 212 (`0x02`). The
auditor was right to refuse. Weakening it to accept pre-ZIP-212 notes would have
made the test pass against a chain nobody runs.

Enabling through Canopy keeps both properties: ZIP 212 is in force, and the
transaction is still **v4**, because v5 only begins at NU5. So the mined artefact
is the same shape the browser auditor already parses.

**Lesson.** "Mined on a chain" is not one property. The upgrade epoch you choose
decides which encryption rules the note follows, and a chain that is too old
produces ciphertext the auditor must — correctly — reject.

---

## 17. From a fresh regtest wallet, `z_shieldcoinbase` was the only call that could carry the memo

Two failures in a row made the shape of the problem clear.

`z_sendmany` from the funded shielded note was refused:

> Could not send to the Sapling shielded pool without spending non-Sapling
> funds, which would reveal transaction amounts.

The wallet pulls transparent change into the transaction even when both ends are
shielded, and the default privacy policy will not allow the resulting amount
disclosure.

`z_shieldcoinbase` has none of that baggage: it consumes whole coinbase UTXOs,
so there is no change, no privacy-policy refusal, and no spendable-note wait. It
also takes a memo directly as parameter 5 (since 6.20), which is exactly the
envelope field Veilo uses.

Two details cost a run each:

- **The from-address must be a bare `*`.** It is compared against the literal
  string `"*"` (`isFromWildcard = fromaddress == "*"`), and this parameter is
  *not* JSON-converted by `zcash-cli`. Passing `'"*"'` delivers the quote
  characters and the node rejects it as an invalid address.
- **6.20 refuses to start without**
  `-i-am-aware-zcashd-will-be-replaced-by-zebrad-and-zallet-in-2025=1`.

The deprecation surface turned out to be narrower than feared. From
`src/deprecation.h`, the denied set is exactly `getnewaddress`,
`getrawchangeaddress`, `z_getnewaddress`, `z_getbalance`, `z_listaddresses`,
`legacy_privacy`, `wallettxvjoinsplit`. `z_shieldcoinbase`, `z_sendmany`,
`z_exportviewingkey`, `z_viewtransaction` and `z_listreceivedbyaddress` need no
flag.

**Lesson.** The shortest working path was not "send a bid-shaped transaction".
It was "attach the envelope to the transaction that already had to happen".

---

## 18. A note minted in the tip block is invisible to `z_getbalance`

After shielding, the operation reported success and the transaction was in the
next block — yet the escrow balance read `0.0 ZEC`.

`getBalanceZaddr` calls `GetFilteredNotes(..., ignoreUnspendable=true)` and
`z_getbalance` defaults to `minconf 1`. A note created in the tip block can be
excluded by both filters at once. One more block made the same call return
`99.9994 ZEC`, with no other change.

`z_viewtransaction` and the node log showed the note existed the whole time.

**Lesson.** A zero balance is not evidence that a note is missing. It can mean
"not yet spendable by this wallet's own rules", which is a different failure and
needs a different fix.

---

## Open questions

- **Zallet ↔ zebrad alignment.** Resolves itself when Zallet ships against a
  newer `zebra-state`. Alternative if it does not: Zallet's `zaino` backend
  speaks JSON-RPC and does not share a RocksDB directory, so the format coupling
  disappears at the cost of running a second node.
- **`zcash_address` / unified addresses.** We derive Sapling addresses offline but
  have not yet produced ZIP-316 unified addresses for the demo path.
- **Real broadcast.** Regtest now proves the authoring path end to end with
  `zcashd`; a public network still needs a post-EOL wallet stack. A related
  question is transaction shape: the committed artefact is v4, and a mainnet
  deployment would produce v5, which keeps the same 512-byte memo but needs a
  different parsing path.
