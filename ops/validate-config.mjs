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

// Keys accepted under [mining].
const MINING_KEYS = ["miner_address", "extra_coinbase_data", "miner_memo", "internal_miner"];

// Keys accepted under [state].
const STATE_KEYS = ["cache_dir", "ephemeral", "memory_limit", "max_tips", "min_tips", "progress_bar"];

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
if (values.some((v) => v.value < 1)) {
  errors.push("activation heights must be >= 1 (height 0 is reserved for Genesis)");
}

// --- report -------------------------------------------------------------
console.log(`validating ${path}`);
console.log(`  activation heights : ${ordered.join(", ")}`);
console.log(`  rpc keys           : ${rpcKeys.join(", ")}`);

if (errors.length) {
  console.error("\nFAIL");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
if (notes.length) for (const n of notes) console.log(`  note: ${n}`);
console.log("\nOK — key sets and ordering are valid.");
console.log("Caveat: this checks keys we KNOW about. A key zebrad rejects but which");
console.log("is not in the lists above would still fail at startup.");
