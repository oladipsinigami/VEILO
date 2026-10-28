/**
 * Browser entry point for the bid page.
 *
 * esbuild bundles this file (and only what it re-exports) into
 * `demo/bid/app.js`, which the page imports as a plain ES module. The point of
 * a separate entry is that the page cannot reach into `memo.ts` internals it
 * has no business touching, and the bundle stays smaller than the library.
 *
 * Rebuild with `npm run bid:build`; CI runs `npm run bid:check` and fails if the
 * committed bundle differs from the source.
 */

export {
  BidError,
  MAX_ZAT,
  TICKET_VERSION,
  fromHex,
  parseAuctionDoc,
  prepareBid,
  publishReveal,
  toHex,
  verifyTicket,
  zecToZat,
} from "./bid.ts";

// The page formats every ZEC figure the same way the payment request does, so
// both get the ZIP-321 rendering rather than a second, drifting formatter.
export { formatAmountZec } from "./zip321.ts";
