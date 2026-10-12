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
