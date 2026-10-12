#!/usr/bin/env python3
"""Write a miner address into the regtest config and enable the internal miner.

Kept as a standalone file rather than a heredoc inside fund.sh: heredocs inside a
python patcher inside a shell script is three levels of quoting, and that is
exactly how the previous version ended up with a literal newline inside "\n".

    python3 ops/set-miner-address.py ops/zebrad-regtest.toml tmXXXX...

Idempotent: safe to run twice. It replaces an existing or commented-out
miner_address inside [mining], and flips internal_miner to true.
"""

import re
import sys


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2

    path, addr = sys.argv[1], sys.argv[2]

    # Cheap sanity check. zebrad parses this eagerly and rejects anything that is
    # not a valid Zcash address, so catching an obvious non-address locally saves
    # a round trip to the codespace. Full Base58Check/Bech32 verification is out
    # of scope -- zebrad remains the authority.
    if not re.fullmatch(r"(t1|t3|tm|tm2|zs|zs1|zu|zutest)[A-Za-z0-9]{6,}", addr):
        print(f"refusing: {addr!r} does not look like a Zcash address")
        return 1

    with open(path, encoding="utf-8") as fh:
        lines = fh.read().split("\n")

    out = []
    in_mining = False
    found_slot = False

    for line in lines:
        stripped = line.strip()
        if stripped.startswith("["):
            in_mining = stripped == "[mining]"
        if in_mining and re.match(r"^#?\s*miner_address\s*=", line):
            out.append(f'miner_address = "{addr}"')
            found_slot = True
            continue
        out.append(line)

    if not found_slot:
        # No miner_address key at all: append one to the [mining] table.
        for i, line in enumerate(out):
            if line.strip() == "[mining]":
                insert_at = i + 1
                while insert_at < len(out) and not out[insert_at].strip().startswith("["):
                    insert_at += 1
                out.insert(insert_at, f'miner_address = "{addr}"')
                found_slot = True
                break

    if not found_slot:
        print("could not find a [mining] table to write miner_address into")
        return 1

    text = "\n".join(out).replace("internal_miner = false", "internal_miner = true")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)

    print(f"  wrote miner_address into {path} and enabled internal_miner")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
