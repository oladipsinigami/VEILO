/**
 * ZIP-321 payment request URIs (Active) — the submission mechanism for a Veilo bid.
 *
 * Scope note, because it matters for I6: ZIP-321 has no standard expiry parameter.
 * Deadline enforcement is layered (Part 3 §4.2):
 *   1. ZIP-316 Rev 2 Address Expiry Metadata (typecode 0xE0) is the standards-compliant
 *      belt, but Rev 2 is Draft and only Rev 2-aware senders honour it.
 *   2. The `expires` parameter below is a NON-required custom param. Per the ZIP-321
 *      forward-compatibility rule, a parser that does not recognise a non-`req-` param
 *      SHOULD ignore it — so this is safe with every wallet, and honoured by ours.
 *   3. Receiver rotation at H_end is the braces, and it is the only mechanism that is
 *      auditable rather than merely advisory.
 *
 * `amount` is decimal ZEC per the ZIP-321 grammar: 1*DIGIT [ "." 1*8DIGIT ], no
 * thousands separators, no trailing zeros in the fraction.
 */

export const MEMO_SIZE = 512;

export interface Zip321Params {
  /** UA or legacy address. Sprout is not permitted. */
  address: string;
  /** Decimal ZEC. Omit for a "request any amount" URI. */
  amountZec?: string;
  /** Exactly 512 bytes for a Veilo envelope; ZIP-321 pads shorter memos to 512. */
  memo?: Uint8Array;
  label?: string;
  message?: string;
  /** Non-standard, advisory only. Block height. */
  expires?: number;
}

export class Zip321Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Zip321Error";
  }
}

// ---------------------------------------------------------------------------
// base64url (no padding) — ZIP-321 mandates this alphabet, and explicitly forbids
// the characters +, / and = that appear only in standard base64.
// ---------------------------------------------------------------------------

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64URL[b0 >> 2];
    out += B64URL[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 === undefined) break;
    out += B64URL[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 === undefined) break;
    out += B64URL[b2 & 0x3f];
  }
  return out;
}

export function fromBase64Url(s: string): Uint8Array {
  if (/[+/=]/.test(s)) {
    throw new Zip321Error("base64url must not contain +, / or =");
  }
  const bits: number[] = [];
  for (const ch of s) {
    const v = B64URL.indexOf(ch);
    if (v < 0) throw new Zip321Error(`invalid base64url character: ${ch}`);
    for (let k = 5; k >= 0; k--) bits.push((v >> k) & 1);
  }
  const bytes: number[] = [];
  for (let i = 0; i + 7 < bits.length; i += 8) {
    let b = 0;
    for (let k = 0; k < 8; k++) b = (b << 1) | bits[i + k];
    bytes.push(b);
  }
  return new Uint8Array(bytes);
}

// ---------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------

const ZAT_PER_ZEC = 100_000_000n;
const MAX_ZEC = 21_000_000n;

/** Parse a ZIP-321 `amount` into zatoshi. Rejects grammar violations explicitly. */
export function parseAmountZec(amount: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,8}))?$/.exec(amount);
  if (!m) {
    throw new Zip321Error(
      `invalid amount "${amount}": expected 1*DIGIT [ "." 1*8DIGIT ] with no separators`
    );
  }
  const whole = BigInt(m[1]);
  if (whole > MAX_ZEC) throw new Zip321Error(`amount exceeds ${MAX_ZEC} ZEC`);
  const frac = (m[2] ?? "").padEnd(8, "0");
  const zat = whole * ZAT_PER_ZEC + BigInt(frac || "0");
  // Check the TOTAL, not just the whole part: "21000000.00000001" is greater than
  // 21000000 ZEC even though its whole-number component is not.
  if (zat > MAX_ZEC * ZAT_PER_ZEC) {
    throw new Zip321Error(`amount exceeds ${MAX_ZEC} ZEC`);
  }
  return zat;
}

/** Render zatoshi as a ZIP-321 decimal ZEC amount, trimming trailing fraction zeros. */
export function formatAmountZec(zat: bigint): string {
  if (zat < 0n) throw new Zip321Error("negative amount");
  const whole = zat / ZAT_PER_ZEC;
  const frac = (zat % ZAT_PER_ZEC).toString().padStart(8, "0").replace(/0+$/, "");
  return frac.length ? `${whole}.${frac}` : whole.toString();
}

// ---------------------------------------------------------------------------
// Percent encoding (only qchar-legal characters are escaped)
// ---------------------------------------------------------------------------

// ZIP-321 qchar = unreserved / pct-encoded / allowed-delims / ":" / "@"
//   allowed-delims = "!" / "$" / "'" / "(" / ")" / "*" / "+" / "," / ";"
// Critically this EXCLUDES & = / ? # and space. Leaving `&` unescaped would let a
// label like "bid & auction" silently split the query string into a bogus extra
// parameter, so the safe set must match the grammar exactly and no more.
const QCHAR_SAFE = /[A-Za-z0-9\-._~!$'()*+,;:@]/;

function encodeQchar(s: string): string {
  let out = "";
  for (const ch of s) {
    if (QCHAR_SAFE.test(ch)) {
      out += ch;
    } else {
      out += Array.from(new TextEncoder().encode(ch))
        .map((b) => "%" + b.toString(16).toUpperCase().padStart(2, "0"))
        .join("");
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export function buildZip321(params: Zip321Params): string {
  const { address, amountZec, memo, label, message, expires } = params;

  if (!/^[A-Za-z0-9]+$/.test(address)) {
    throw new Zip321Error("address must match zcashaddress = 1*( ALPHA / DIGIT )");
  }
  if (address.startsWith("zs") && !address.startsWith("zshield")) {
    throw new Zip321Error("Sprout addresses MUST NOT be used in payment requests");
  }
  if (memo && memo.length !== MEMO_SIZE) {
    throw new Zip321Error(`memo must be exactly ${MEMO_SIZE} bytes, got ${memo.length}`);
  }
  if (amountZec !== undefined) parseAmountZec(amountZec);

  const query: string[] = [];
  if (amountZec !== undefined) query.push(`amount=${amountZec}`);
  if (memo) query.push(`memo=${toBase64Url(memo)}`);
  if (label) query.push(`label=${encodeQchar(label)}`);
  if (message) query.push(`message=${encodeQchar(message)}`);
  if (expires !== undefined) {
    if (!Number.isInteger(expires) || expires < 0) {
      throw new Zip321Error("expires must be a non-negative block height");
    }
    query.push(`expires=${expires}`);
  }

  const qs = query.join("&");
  return qs ? `zcash:${address}?${qs}` : `zcash:${address}`;
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

export interface ParsedZip321 {
  address: string;
  amountZec?: string;
  amountZat?: bigint;
  memo?: Uint8Array;
  label?: string;
  message?: string;
  expires?: number;
}

export function parseZip321(uri: string): ParsedZip321 {
  if (!uri.startsWith("zcash:")) throw new Zip321Error("URI must start with zcash:");
  // The grammar forbids an authority component.
  if (uri.startsWith("zcash://")) throw new Zip321Error("zcash:// is not valid; no authority allowed");

  const rest = uri.slice("zcash:".length);
  const q = rest.indexOf("?");
  const address = q === -1 ? rest : rest.slice(0, q);
  if (!/^[A-Za-z0-9]+$/.test(address)) {
    throw new Zip321Error("URI must contain an address in the hier-part");
  }

  const out: ParsedZip321 = { address };
  if (q === -1) return out;

  const seen = new Set<string>();
  for (const pair of rest.slice(q + 1).split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const key = eq === -1 ? pair : pair.slice(0, eq);
    const value = eq === -1 ? "" : pair.slice(eq + 1);
    if (seen.has(key)) throw new Zip321Error(`duplicate parameter: ${key}`);
    seen.add(key);

    switch (key) {
      case "amount":
        parseAmountZec(value);
        out.amountZec = value;
        out.amountZat = parseAmountZec(value);
        break;
      case "memo": {
        const memo = fromBase64Url(value);
        if (memo.length > MEMO_SIZE) {
          throw new Zip321Error("memo exceeds 512 bytes");
        }
        // ZIP-321: shorter memos are filled with trailing zeros to 512.
        const padded = new Uint8Array(MEMO_SIZE);
        padded.set(memo);
        out.memo = padded;
        break;
      }
      case "label":
        out.label = decodeURIComponent(value);
        break;
      case "message":
        out.message = decodeURIComponent(value);
        break;
      case "expires":
        if (!/^\d+$/.test(value)) throw new Zip321Error("expires must be an integer");
        out.expires = Number(value);
        break;
      default:
        // Non-req params that are not recognised SHOULD be ignored (ZIP-321).
        break;
    }
  }
  return out;
}