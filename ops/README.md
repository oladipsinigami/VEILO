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

**Run `fund.sh` first.** It is the one that is genuinely fiddly: Zcash coinbase outputs
mature after 100 blocks, so a fresh chain cannot spend anything until block 101. The
script does that for you.

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

## Known limitation: zebrad cannot mine block 1 on regtest (zebra #8434)

Verified on zebrad `c1f84f3ee92a577ebaeaf5753a5f3cf261428e8e` (7.0.0-rc.0).

The node boots, accepts the derived miner address, and serves RPC. **Mining
block 1 does not work**, and it is not a config mistake. Three separate zebra
behaviours all land on height 1:

| Requirement | Why | Where |
|---|---|---|
| `Overwinter == 1` | the block-1 coinbase is signed with the v4 sighash | `zcash_primitives` `sighash_v4.rs:255` panics on pre-Overwinter |
| `Heartwood == 1` | block 1 is the only block with no stored chain history root; `DefaultRoots::from_coinbase` substitutes the reserved root only when `Heartwood.activation_height == height` | `zebra-rpc/src/methods/types/default_roots.rs:70` panics with "history root is required for block templates" |
| `Canopy == 1` | zebra cannot construct pre-Canopy coinbase transactions or block templates (open upstream issue) | `zebra-state` exits with "Zebra does not support generating pre-Canopy block templates" |

`Heartwood == 1` and `Canopy == 1` are mutually exclusive: activation heights
are a `BTreeMap<Height, NetworkUpgrade>`, so two upgrades at one height collide
and the later one silently overwrites the earlier. Each of the three panics was
reproduced and fixed in turn before the next surfaced.

**Consequence for Veilo:** zebrad is a node, not a wallet. It also returns
`-32601 Method not found` for `z_getnewaddress`, `z_getbalance` and
`z_sendmany`, so it could never fund a wallet, create a shielded address, or
put a memo in a shielded output. A real end-to-end demo needs a wallet-capable
node; `zcashd` is the next step. See VEILO_BLUEPRINT.md.
