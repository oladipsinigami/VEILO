# veilo-core

Rust half of the Veilo memo codec. The other half is `web/src/lib/memo.ts`.

## Why there are two implementations

The bidder's browser builds the 512-byte envelope in TypeScript. The auditor
unpacks and verifies it in Rust, compiled to `wasm32-unknown-unknown`. Those are
different languages running on different schedules, so they can silently drift.
A one-byte drift breaks every bid and every audit while still passing any demo
built from a single language.

`tests/replay.rs` is the guard. `test/vectors.txt` is generated from the
TypeScript side:

    node test/gen-vectors.mjs
    cargo test -p veilo-core

It asserts key derivation, the commitment, the reveal, `c_refund`, the derived
AEAD nonce, and all 512 packed memo bytes match exactly.

## Build

    cargo test -p veilo-core
    cargo build -p veilo-wasm --target wasm32-unknown-unknown

## Environment note

On this machine Smart App Control is enabled, which blocks freshly built
unsigned binaries (`os error 4551`, CodeIntegrity event 3077). Existing binaries
run, so `cargo test` works, but each new build script is frequently blocked.
The wasm target additionally needs `wasm-bindgen-cli` or `wasm-pack`, which is
not yet installed.

Turn it off with (elevated, then reboot):

    Set-MpPreference -EnableSmartAppControl Off

This is a real security reduction — it is the machine's main defence against
untrusted downloaded code — so it should be a deliberate choice, not a
convenience.
