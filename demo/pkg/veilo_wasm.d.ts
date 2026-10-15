/* tslint:disable */
/* eslint-disable */

/**
 * Trial-decrypt one Sapling output with the escrow viewing key.
 *
 * Returns a JSON object string, or the string `null` when the output is not
 * ours. Throws when the input is malformed.
 */
export function audit_output(escrow_ivk: Uint8Array, ephemeral_key: Uint8Array, cmu: Uint8Array, enc_ciphertext: Uint8Array): string;

/**
 * Trial-decrypt a whole block range and keep only the escrow's bids.
 *
 * `outputs` is a flat concatenation of `(ephemeral_key || cmu || enc_ciphertext)`
 * records, each 644 bytes, in fetch order. Returns a JSON array string,
 * possibly empty.
 */
export function audit_range(escrow_ivk: Uint8Array, outputs: Uint8Array): string;

/**
 * Size of a compact Sapling `encCiphertext`, in bytes.
 *
 * The compact form carries no memo, so it is useless for auditing. Exposed so a
 * caller can reject it explicitly rather than discover it as a silent miss.
 */
export function compact_note_size(): number;

/**
 * Size of a full Sapling `encCiphertext`, in bytes.
 */
export function enc_ciphertext_size(): number;

/**
 * Size of the Veilo memo envelope, in bytes.
 *
 * Also the full Zcash memo field: `MemoBytes` is a `Box<[u8; 512]>`, so this is
 * fixed by consensus and the envelope has zero headroom.
 */
export function memo_size(): number;

/**
 * Check a permissionless reveal against the commitment already on chain.
 *
 * Returns true only if the amount hashes to the `bid_commit` that was in the
 * memo from the start. This is the step that makes the auction honest: a bidder
 * who changes their number at the deadline produces a different hash and is
 * rejected.
 *
 * `bid_zat` is a decimal string on purpose. A `u64` crosses the wasm boundary
 * as a BigInt, and an `f64` would silently lose precision above 2^53 -- about
 * 90 million ZEC in zatoshis, so "just use a float" is a real hazard here.
 */
export function verify_reveal(auction_id: Uint8Array, bid_zat: string, nonce: Uint8Array, epk_bid: Uint8Array, bid_commit: Uint8Array): boolean;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly audit_output: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly audit_range: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly compact_note_size: () => number;
    readonly enc_ciphertext_size: () => number;
    readonly memo_size: () => number;
    readonly verify_reveal: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
