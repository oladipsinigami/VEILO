#!/usr/bin/env python3
"""Derive a deterministic regtest transparent address and its private key.

Why this exists
---------------
fund.sh used to call `z_getnewaddress` to mint an address for
`mining.miner_address`. That was a mistake: zebrad is a NODE, not a wallet.
It answers `getblockcount` and the mining RPCs, but `z_getnewaddress`,
`z_getbalance` and `z_sendmany` all return -32601 "Method not found". There is
no wallet to ask.

So the address is derived here instead, offline, from a fixed secret. Because we
keep the private key we can later construct spends without a wallet daemon at
all, which is what a Zcash sealed-bid settlement actually needs.

Dependencies: standard library only. RIPEMD-160 comes from hashlib, which
Ubuntu 24.04 / OpenSSL 3.0.13 provides (verified: ops/probe-hash.py). An
earlier hand-rolled RIPEMD-160 in this file was wrong and is deliberately gone
-- a silently incorrect hash would produce a valid-looking address that nobody
can spend from, which is the worst possible failure for this project. If
hashlib cannot supply it we abort loudly instead.

secp256k1 is not in the standard library, so the point multiplication below is
hand-written; it is checked against the published pubkeys for secret 1 and 2.

Usage:
    python3 ops/make-address.py             # print the regtest address
    python3 ops/make-address.py --wif       # print the private key (WIF)
    python3 ops/make-address.py --selftest  # verify the crypto above
"""

import hashlib
import sys

# ---------------------------------------------------------------- secp256k1

P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F
N = 0xFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
GX = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798
GY = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8


def point_add(a, b):
    if a is None:
        return b
    if b is None:
        return a
    (x1, y1), (x2, y2) = a, b
    if x1 == x2 and (y1 + y2) % P == 0:
        return None
    if a == b:
        lam = (3 * x1 * x1) * pow(2 * y1, P - 2, P) % P
    else:
        lam = (y2 - y1) * pow(x2 - x1, P - 2, P) % P
    x3 = (lam * lam - x1 - x2) % P
    return (x3, (lam * (x1 - x3) - y1) % P)


def point_mul(k, point=(GX, GY)):
    result = None
    addend = point
    while k:
        if k & 1:
            result = point_add(result, addend)
        addend = point_add(addend, addend)
        k >>= 1
    return result


def pubkey(secret: bytes) -> bytes:
    k = int.from_bytes(secret, "big") % N
    if k == 0:
        raise ValueError("secret out of range")
    x, y = point_mul(k)
    return bytes([2 + (y & 1)]) + x.to_bytes(32, "big")


# ---------------------------------------------------------------- hashing

def ripemd160(data: bytes) -> bytes:
    try:
        h = hashlib.new("ripemd160")
    except Exception as exc:  # noqa: BLE001 - we want the name, whatever it is
        raise SystemExit(
            "this Python has no RIPEMD-160 (OpenSSL legacy provider disabled).\n"
            "Refusing to continue: a wrong hash here yields an address that looks\n"
            "valid but can never be spent from."
        ) from exc
    h.update(data)
    return h.digest()


def hash160(data: bytes) -> bytes:
    return ripemd160(hashlib.sha256(data).digest())


# ---------------------------------------------------------------- base58check

B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58encode(payload: bytes) -> str:
    n = int.from_bytes(payload, "big")
    out = ""
    while n:
        n, rem = divmod(n, 58)
        out = B58[rem] + out
    for byte in payload:
        if byte != 0:
            break
        out = B58[0] + out
    return out


def b58decode(text: str) -> bytes:
    n = 0
    for ch in text:
        n = n * 58 + B58.index(ch)
    size = (n.bit_length() + 7) // 8
    body = n.to_bytes(size, "big")
    pad = 0
    for ch in text:
        if ch != B58[0]:
            break
        pad += 1
    return b"\x00" * pad + body


def base58check(version: bytes, payload: bytes) -> str:
    body = version + payload
    return b58encode(body + hashlib.sha256(hashlib.sha256(body).digest()).digest()[:4])


# Regtest prefixes, taken from zcashd's CRegTestParams (src/chainparams.cpp):
#   PUBKEY_ADDRESS  = {0x1D, 0x25}  -> transparent P2PKH, "tm..."
#   SCRIPT_ADDRESS  = {0x1C, 0xBA}  -> "t2..."  (NOT what we want here)
#   SECRET_KEY      = {0xEF}        -> WIF
# Note {0x1C,0xBA} looks plausible because mainnet uses 0x1cb8/0x1cbd for t1/t3,
# but on regtest it is the *script* prefix, so it yields t2..., not tm....
REGTEST_P2PKH = bytes([0x1D, 0x25])
REGTEST_WIF = bytes([0xEF])


def selftest() -> None:
    known = {
        1: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
        2: "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5",
    }
    for secret, want in known.items():
        got = pubkey(secret.to_bytes(32, "big")).hex()
        if got != want:
            raise SystemExit(f"secp256k1 self-test FAILED for secret {secret}: {got} != {want}")

    # RIPEMD-160 published vectors, so a broken hashlib provider is caught here
    # rather than as an unspendable address later.
    for msg, want in {
        b"": "9c1185a5c5e9fc54612808977ee8f548b2258d31",
        b"abc": "8eb208f7e05d987a9b044a8e98c6b087f15a0bfc",
    }.items():
        got = ripemd160(msg).hex()
        if got != want:
            raise SystemExit(f"ripemd160 self-test FAILED for {msg!r}: {got} != {want}")

    # Base58 round trip through our own decoder.
    # 2 version bytes + 20 hash160 + 4 checksum = 26 bytes.
    addr = base58check(REGTEST_P2PKH, hash160(pubkey((1).to_bytes(32, "big"))))
    raw = b58decode(addr)
    if raw[:2] != REGTEST_P2PKH or len(raw) != 26:
        raise SystemExit(f"base58check round-trip FAILED for {addr}: {raw.hex()}")
    if hashlib.sha256(hashlib.sha256(raw[:-4]).digest()).digest()[:4] != raw[-4:]:
        raise SystemExit(f"base58check checksum FAILED for {addr}")
    # Belt and braces: a wrong version byte still base58-encodes to *something*,
    # so assert the human-visible prefix too.
    if not addr.startswith("tm"):
        raise SystemExit(f"regtest address does not start with 'tm': {addr}")


def main() -> int:
    if "--selftest" in sys.argv:
        selftest()
        print("make-address self-test PASSED (secp256k1, RIPEMD-160, base58check)")
        return 0

    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    secret = bytes.fromhex(args[0]) if args else hashlib.sha256(b"veilo-regtest-miner").digest()
    if len(secret) != 32:
        raise SystemExit("secret must be 32 bytes")

    if "--wif" in sys.argv:
        print(base58check(REGTEST_WIF, secret + b"\x01"))  # 0x01 = compressed key
    else:
        print(base58check(REGTEST_P2PKH, hash160(pubkey(secret))))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())