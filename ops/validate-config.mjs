#!/usr/bin/env node
// Validate ops/zebrad-regtest.toml against the key sets zebrad actually accepts.
//
// The config is deny_unknown_fields: one wrong key makes the node refuse to start,
// and discovering that on a remote codespace costs a full round trip. This checks
// the known key sets locally in milliseconds.
//
// The authoritative lists below were transcribed from real zebrad
// `Configuration error:` output, not from documentation or memory.
//
//   node ops/validate-config.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Keys accepted under [network.testnet_parameters.activation_heights].
// Note the DOTS: NU6.1, NU6.2, NU6.3. Writing NU6_1 is rejected.
const ACTIVATION_HEIGHTS = [
  "BeforeOverwinter",
  "Overwinter",
  "Sapling",
  "Blossom",
  "Heartwood",
  "Canopy",
  "NU5",
  "NU6",
  "NU6.1",
  "NU6.2",
  "NU6.3",
  "NU7",
];

// Keys accepted under [rpc].
const RPC_KEYS = [
  "listen_addr",
  "indexer_listen_addr",
  "lightwalletd_listen_addr",
  "parallel_cpu_threads",
  "debug_force_finished_sync",
  "cookie_dir",
  "enable_cookie_auth",
  "max_response_body_size",
];

// Keys accepted under [mining]. `miner_address` is deliberately absent from the base
// config: it is Option<ZcashAddress>, so omitting it is valid, and any placeholder
// string is rejected ("Not a Zcash address for key 'mining.miner_address'").
const MINING_KEYS = ["miner_address", "extra_coinbase_data", "miner_memo", "internal_miner"];

// Keys accepted under [state].
const STATE_KEYS = ["cache_dir", "ephemeral", "memory_limit", "max_tips", "min_tips", "progress_bar"];

// Complete set of valid TOP-LEVEL tables, from real zebrad error output.
// Getting this wrong was a real bug: `[sentry]` and `[logging]` are not tables.
const TOP_LEVEL_TABLES = [
  "consensus",
  "metrics",
  "network",
  "state",
  "tracing",
  "sync",
  "mempool",
  "notify",
  "rpc",
  "mining",
  "health",
  "zcashd_compat",
];

const here = dirname(fileURLToPath(import.meta.url));
const path = join(here, "zebrad-regtest.toml");
const raw = readFileSync(path, "utf8");

const errors = [];
const notes = [];

// --- crude but sufficient TOML table/key reader -------------------------
// We only need [table] headers and top-level keys within them, which is all the
// config uses. Deliberately not a full TOML parser: a dependency here would be
// worse than the thing it replaces.

const sections = {};
let current = null;
for (const rawLine of raw.split("\n")) {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) continue;

  const table = /^\[([^\]]+)\]$/.exec(line);
  if (table) {
    current = table[1];
    sections[current] = new Set();
    continue;
  }
  if (!current) continue;

  const kv = /^("(?:[^"]+)"|[A-Za-z0-9_.-]+)\s*=/.exec(line);
  if (kv) sections[current].add(kv[1].replace(/^"|"$/g, ""));
}

// Check the table names themselves. This was a blind spot: the validator checked
// keys inside known tables but never checked that the tables existed at all, so
// an invented `[sentry]` or `[logging]` passed validation and only failed on the
// remote codespace.
for (const table of Object.keys(sections)) {
  // TOML `[a.b.c]` defines a nested table, so only the FIRST segment is a
  // top-level table name. `network.testnet_parameters.activation_heights` is
  // legitimately rooted at `network`.
  const root = table.split(".")[0];
  if (!TOP_LEVEL_TABLES.includes(root)) {
    errors.push(`unknown table [${root}] (from [${table}]) — expected one of: ${TOP_LEVEL_TABLES.join(", ")}`);
  }
}

function check(label, keys, allowed) {
  const got = sections[label];
  if (!got) {
    errors.push(`missing [${label}] section`);
    return [];
  }
  const keysList = [...got];
  for (const k of keysList) {
    if (!allowed.includes(k)) {
      errors.push(`[${label}] unknown key '${k}' — expected one of: ${allowed.join(", ")}`);
    }
  }
  if (keysList.length === 0) errors.push(`[${label}] is empty`);
  return keysList;
}

const ahKeys = check(
  "network.testnet_parameters.activation_heights",
  ACTIVATION_HEIGHTS,
  ACTIVATION_HEIGHTS
);
const rpcKeys = check("rpc", RPC_KEYS, RPC_KEYS);
check("mining", MINING_KEYS, MINING_KEYS);
check("state", STATE_KEYS, STATE_KEYS);

// --- activation heights must be strictly increasing ----------------------
const ordered = ACTIVATION_HEIGHTS.filter((k) => ahKeys.includes(k));
if (ordered.length !== ahKeys.length) {
  errors.push("activation height order does not match the canonical upgrade order");
}
const values = [];
for (const rawLine of raw.split("\n")) {
  const m = /^("([^"]+)"|([A-Za-z0-9_.-]+))\s*=\s*(\d+)\s*$/.exec(rawLine.trim());
  if (m) values.push({ key: m[2] ?? m[3], value: Number(m[4]) });
}
for (let i = 1; i < values.length; i++) {
  if (values[i].value <= values[i - 1].value) {
    errors.push(
      `activation heights must be strictly increasing: ${values[i - 1].key}=${values[i - 1].value} then ${values[i].key}=${values[i].value}`
    );
  }
}
// --- Overwinter must be activated at height 1 -----------------------------
// The internal miner signs the block-1 coinbase with the v4 sighash, which only
// exists after Overwinter. With Overwinter >= 2 the very first mined block is a
// pre-Overwinter block and zebrad aborts with:
//   "Signature hashing for pre-overwinter transactions is not supported."
// Strictly-increasing heights alone do not catch this, so assert it directly.
const heightOf = (key) => values.find((v) => v.key === key)?.value;
const ow = heightOf("Overwinter");
if (ow === undefined) {
  errors.push(
    "activation_heights is missing Overwinter. On regtest, omitting it lets " +
      "zebrad default it to 1, which is correct; setting it to 2 or more breaks " +
      "block-1 mining."
  );
} else if (ow !== 1) {
  errors.push(
    `Overwinter must be 1 (found ${ow}). The internal miner's block-1 coinbase ` +
      `needs the v4 sighash, which panics on pre-Overwinter blocks.`
  );
}
// BeforeOverwinter is ignored by zebra's for_regtest() except as a fallback for
// Overwinter, so listing it alongside Overwinter only invites this confusion.
if (ahKeys.includes("BeforeOverwinter")) {
  errors.push(
    "BeforeOverwinter should not be set explicitly on regtest: zebra's " +
      "RegtestParameters::for_regtest() ignores it except via " +
      "overwinter.or(before_overwinter)."
  );
}

// If a miner_address IS present it must at least look like a Zcash address.
// A placeholder will be rejected by zebrad with a Base58Check parse error.
const minerLine = raw
  .split(/\r?\n/)
  .find((l) => /^\s*miner_address\s*=/.test(l));
if (minerLine) {
  const addr = minerLine.split("=")[1].trim().replace(/^"|"$/g, "");
  if (!/^(t1|t3|tm|tm2|zs|zu)[A-Za-z0-9]{6,}$/.test(addr)) {
    errors.push(
      `mining.miner_address is present but does not look like a Zcash address: "${addr}". ` +
        `zebrad parses this eagerly; omit the key entirely instead of using a placeholder.`
    );
  }
}

if (values.some((v) => v.value < 1)) {
  errors.push("activation heights must be >= 1 (height 0 is reserved for Genesis)");
}

// --- report -------------------------------------------------------------
console.log(`validating ${path}`);
console.log(`  activation heights : ${ordered.join(", ")}`);
console.log(`  rpc keys           : ${rpcKeys.join(", ")}`);
console.log(`  tables             : ${Object.keys(sections).join(", ")}`);

if (errors.length) {
  console.error("\nFAIL");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
if (notes.length) for (const n of notes) console.log(`  note: ${n}`);
console.log("\nOK — key sets and ordering are valid.");
console.log("Caveat: this checks keys we KNOW about. A key zebrad rejects but which");
console.log("is not in the lists above would still fail at startup.");
