# Veilo on GitHub Codespaces

The builder's Windows machine cannot run a Zcash node: `zebrad` publishes **Linux-only**
binaries (`aarch64-unknown-linux-gnu` and `x86_64-unknown-linux-gnu`), and there is no
Windows or macOS build. Codespaces gives us the Linux box the plan always assumed.

## One-time setup

1. Push this repo to GitHub (public or private).
2. **Code → Codespaces → Create codespace on \<branch\>.**
3. Choose the machine you already have, or bump to a larger one if the workspace
   reports low memory. Regtest needs very little; Oracle's free ARM tier (12 GB) is
   only needed if we later sync public Testnet.
4. Wait for `ops/bootstrap.sh` to finish. It installs the wasm target, fetches zebrad,
   builds, and runs every test.

## The scripts

| Command | What it does |
| :--- | :--- |
| `bash ops/status.sh` | Where everything stands |
| `bash ops/fund.sh` | Generates a miner address, writes it into the config, mines 110 blocks so coinbase matures |
| `bash ops/up.sh` | Starts zebrad on regtest and waits for RPC |
| `bash ops/zebrad.log` | Tail this if `up.sh` times out |
| `bash ops/onchain-probe.sh` | Runs `zcashd` in Docker, mines a transaction carrying the 512-byte envelope, writes `demo/chain-probe/` |

**Run `fund.sh` first.** It is the one that is genuinely fiddly: Zcash coinbase outputs
mature after 100 blocks, so a fresh chain cannot spend anything until block 101. The
script does that for you.

## The zcashd probe (the only mined transaction)

`ops/onchain-probe.sh` answers one question: will a real wallet put the Veilo
envelope on a chain, intact, and hand back bytes an independent auditor can
parse? It runs `zcashd 6.20.0` (published Docker image) on regtest:

- activates Overwinter through **Canopy** with `-nuparams`, which keeps the
  transaction **v4** *and* turns on ZIP 212 note encryption that the auditor
  enforces;
- mines 110 blocks, creates a Sapling escrow address, exports its `zxview…` key;
- builds a packed bid with `crates/veilo-core/examples/chain_memo.rs` (auction
  id, 60 ZEC commitment, sealed refund address for a second address it creates);
- carries that envelope in the **`z_shieldcoinbase` transaction itself**
  (parameter 5), so there is no transparent change and no privacy refusal;
- asserts the memo comes back byte-for-byte from `z_viewtransaction`;
- writes `tx.hex`, `probe.json` and `memo.txt` into `demo/chain-probe/`.

`memo.txt` publishes the envelope's inputs, including a **test** refund secret,
so `tests/chain_probe.rs` can recompute the bid commitment from the reveal and
open the refund seal. A real auction would never publish that key; here it is the
only way to check the last step without an auctioneer.

It needs Docker, not a Codespace. GitHub's `onchain-probe` workflow is
`workflow_dispatch` only: run it to regenerate the artefact, download the
artifact, and commit the two files. The committed artefact is what
`cargo test --test chain_probe` reads in the normal `rust` job, so CI does not
need Docker to keep the claim honest.

If you regenerate, the txid in `README.md` changes with it.

## Why regtest, and not public Testnet

- Regtest **skips Proof-of-Work validation entirely** and supports an `internal-miner`
  build of zebrad, so we control the chain exactly.
- Network upgrades activate at **height 1**, configurable in `ops/zebrad-regtest.toml`.
  We set NU5 through NU7 all to height 1, so the regtest chain follows **NU6.3 + NU7
  rules from genesis**: Ironwood pool active, `enableCrossAddress = 0`, 25-second target
  spacing. The demo exercises the real target rules, deterministically.
- Public Testnet was not viable here: explorer endpoints were unreachable on Oct 12, and
  `lightwalletd` only serves ZIP-307 **compact** outputs (52 bytes, no memo), so it cannot
  supply the full 580-byte `encCiphertext` the auditor needs.

## Known traps (each one cost a round trip to a remote codespace)

Zebra's config is `deny_unknown_fields`: **one wrong key makes the node refuse to start.**
Three mistakes we made, recorded so they are not repeated:

1. **Dotted release names.** `NU6.1`, `NU6.2`, `NU6.3` use **dots**, not underscores.
   Writing `NU6_1` is rejected. Dotted keys must be quoted in TOML.
2. **`NU6` is a real upgrade** — the sequence is `NU5`, `NU6`, `NU6.1`, `NU6.2`,
   `NU6.3`, `NU7`. (We initially removed `NU6` on the false belief it did not exist.)
3. **`enable_zmq` is not a valid `[rpc]` key** in 7.0.0-rc.0. Valid keys are
   `listen_addr`, `indexer_listen_addr`, `lightwalletd_listen_addr`,
   `parallel_cpu_threads`, `debug_force_finished_sync`, `cookie_dir`,
   `enable_cookie_auth`, `max_response_body_size`.
4. **`sentry` and `logging` are not valid top-level tables.** The complete set is
   `consensus`, `metrics`, `network`, `state`, `tracing`, `sync`, `mempool`,
   `notify`, `rpc`, `mining`, `health`, `zcashd_compat`. Use `[tracing]` if you
   ever need colour/verbosity settings.

Also: activation heights must be **strictly increasing**, and >= 1 (height 0 is reserved
for Genesis).

**Check the config before touching the codespace:**

```bash
node ops/validate-config.mjs
```

It validates table *names* as well as keys within them, and asserts the ordering. It is
verified to catch all four mistakes above.

The config is deliberately minimal — only `network`, `state`, `rpc` and `mining`, all
confirmed. Anything optional we do not need was removed, because every optional key is
another chance of an unknown-field rejection.

If zebrad rejects something the validator does not know about, run `zebrad generate` to
emit a canonical config and diff it against ours.

## The one thing that may not work out of the box

`ops/bootstrap.sh` tries to download the prebuilt zebrad binary first. **The prebuilt
release is not compiled with the experimental `internal-miner` feature**, so `generate`
may be unavailable. If so, rebuild from source in the codespace:

```bash
cargo install --git https://github.com/ZcashFoundation/zebra --locked \
  --bin zebrad --features internal-miner
cp "$(rustc --print sysroot)/../bin/zebrad" bin/zebrad   # or find it in ~/.cargo/bin
```

That build takes a while and wants ~8–10 GB of disk. The codespaces default workspace is
usually fine; if disk is tight, request a larger machine.

An alternative to the internal miner is `getblocktemplate` + `submitblock`, which works on
a stock binary because regtest skips PoW anyway.

## What we get from this

Once funded, the auditor's input is real Zcash note ciphertexts produced by
`librustzcash` on a chain we control:

1. Fund a transparent address (`fund.sh`).
2. Shield to a **Sapling-only** unified address — the escrow receiver (Part 3 §4.1).
3. Pack a real Veilo envelope into a 512-byte memo and broadcast it.
4. Fetch the resulting 580-byte `encCiphertext` and trial-decrypt it in WASM with the
   escrow `ivk`.

Step 4 is the one that needs a node, and it is the core novelty: a browser recomputing an
auction outcome from raw chain ciphertexts.

## The regtest stack, as it actually runs

Verified in CI (run `40970316511`, 30 Oct 2026), end to end, on a fresh runner:

```
zebrad v6.2.3 (7121c82), --features indexer,internal-miner
  state format 28, database created
  mined block 1
zallet v0.1.0-beta.3
  getwalletstatus: fully_synced_height 1, locked false
  z_getnewaccount -> account uuid
  z_getaddressforaccount -> uregtest1...
```

That is `ops/zallet-smoke.sh`, run by the `zallet + zebrad (regtest)` job. It is
a real gate now: the job spent its whole life red under `continue-on-error`, and
that flag is gone.

### Why zebrad v6.2.3

Zallet's `zebra` backend opens zebrad's RocksDB directory read-only, so the
on-disk format has to match exactly. Zallet beta.3 asks for `zebra-state = "12"`
and `zebra-rpc = "15"` (`backends/zebra/Cargo.toml`):

| zebrad | zebra-state | format |
| :--- | :--- | :--- |
| `v6.2.3` (7121c82) | **12.0.1** | **28** |
| `v6.3.0` | 13.0.0 | newer |
| `v7.0.0` | 16.0.0 | newer |

`zebra-state/src/constants.rs` at v6.2.3 declares
`DATABASE_FORMAT_VERSION: u64 = 28`, which is the "v28" Zallet looks for. The
commit is pinned rather than the tag, so a moved tag cannot change what CI
builds.

An earlier version of this file called the mismatch an ecosystem gap that would
resolve itself. It was a mispaired version, and the pairing is readable from the
manifests.

### Block 1 on regtest: three constraints, one ordering

zebrad's block-template path has three requirements that all land on height 1:

| Requirement | Why | Failure if unmet |
|---|---|---|
| `Overwinter == 1` | the block-1 coinbase is signed with the v4 sighash | "Signature hashing for pre-overwinter transactions is not supported" |
| `Heartwood == 1` | block 1 has no stored chain history root; `DefaultRoots::from_coinbase` substitutes the reserved root only at Heartwood's activation height | "history root is required for block templates" |
| `Canopy == 1` | zebra will not template a pre-Canopy block | "Zebra does not support generating pre-Canopy block templates" |

An earlier version of this file claimed `Heartwood == 1` and `Canopy == 1` were
mutually exclusive because activation heights are a
`BTreeMap<Height, NetworkUpgrade>` and one upgrade overwrites the other at the
same height. The collision is real; the conclusion was wrong.
`NetworkUpgrade::activation_height()` falls back to the **next** upgrade's
height (`zebra-chain/src/parameters/network_upgrade.rs`), so with **Canopy last**
among the height-1 entries:

```
{1: Canopy}  ->  Canopy   = 1
                 Heartwood= 1   (falls back to Canopy)
                 Blossom  = 1   (falls back to Heartwood)
                 Sapling  = 1   (falls back to Blossom)
                 Overwinter=1   (falls back to Sapling)
```

With Heartwood as the survivor instead, Canopy resolves to NU5's height and
every template request is refused. The ordering is load-bearing, and it is the
opposite of what it looks like.

### The wallet needs a block, not just a node

At height 0 the wallet cannot finish its first sync. `getwalletstatus` omits
`fully_synced_height` when the wallet's birthday "has not yet been synced", the
bootstrap account's birthday is block 0, and `z_getnewaccount` refuses while the
wallet is locked:

```
{"code":-28,"message":"Wallet sync required"}
```

So the job mines exactly one block before starting Zallet. That is why the
zebrad build includes `--features internal-miner`, why the run writes its own
zebrad config with `[mining] internal_miner = true` and a real `miner_address`
(the shared config deliberately omits one), and why the bootstrap account is
created with `zallet regtest generate-account-and-miner-address` before either
node starts. Its address is what the coinbase pays.

### Zallet must be told the same consensus rules

`[consensus] regtest_nuparams` defaults to empty, i.e. stock regtest heights.
With custom heights on the zebra side, Zallet derives a different branch id and
shuts down rather than guess:

```
The chain has reached height 1, where the backing full node's consensus rules
diverge from what this zallet build can interpret.
```

`ops/zallet-regtest.toml` now lists all ten upgrades with their branch ids, at
the same heights as `ops/zebrad-zallet-regtest.toml`. NU7 is excluded from both:
zebra v6.2.3 still carries a placeholder branch id for it (`0xfffffffe`), so the
zebra config parks it at height 1000, out of reach. Ironwood (NU6.3) still
activates at 7.

## Still not done

* **No funds moved.** The derived address has never held ZEC; the coinbase from
  block 1 needs 100 confirmations to mature, and no shielding or
  memo-bearing send is attempted. That is the next milestone.
* **No public network.** Everything above is regtest: no peers, no fee market,
  and no proof that a public node accepts the envelope.
