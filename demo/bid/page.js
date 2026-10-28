/**
 * The bid page's behaviour. Crypto comes from `app.js`, the committed bundle of
 * `web/src/lib/bid.ts`; this file only touches the DOM.
 *
 * Two rules govern everything below:
 *   1. Nothing the bidder types is sent anywhere. The only network request is
 *      loading the public auction document on page load.
 *   2. The reveal ticket is never stored in the page, in a cookie, or in
 *      localStorage. It is downloaded as a file, because it is the only copy of
 *      the nonce and a browser storage area is not a backup.
 */

import {
  BidError,
  formatAmountZec,
  parseAuctionDoc,
  prepareBid,
  publishReveal,
  toHex,
  zecToZat,
} from "./app.js";

const $ = (id) => document.getElementById(id);
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));

let auction = null;
let auctionRaw = null;

// ---------------------------------------------------------------------------
// Loading the auction
// ---------------------------------------------------------------------------

async function loadAuction() {
  $("auction-note").innerHTML = '<p class="dim">Loading the auction document…</p>';
  try {
    const res = await fetch("../auction.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`auction.json: HTTP ${res.status}`);
    auctionRaw = await res.json();
    auction = parseAuctionDoc(auctionRaw);
    renderAuction();
    $("seal").disabled = false;
  } catch (err) {
    auction = null;
    $("seal").disabled = true;
    $("auction-note").innerHTML = errorPanel(
      "Couldn't load the auction document",
      "The page needs the public auction details (address, refund key, reserve) " +
        "before it can seal anything. Check that demo/auction.json is being served.",
      err,
      { retry: true }
    );
    $("auction-note").querySelector("#retry")?.addEventListener("click", loadAuction);
  }
}

function renderAuction() {
  const name = escapeHtml(auctionRaw.name ?? "Auction");
  const reserve = formatAmountZec(auction.reserveZat);
  // The hex id, not the human-readable alias: this is the exact string that
  // appears in the reveal and in the ticket, so a bidder comparing against
  // chain data sees the same 32 characters the protocol uses.
  const id = escapeHtml(toHex(auction.auctionId));

  const practice = auction.practice
    ? `<div class="note">
         <strong>This is a practice auction.</strong>
         Its escrow address is the regtest address from the mined probe, so it is
         inert on every real network — sending ZEC to it on mainnet burns them. Its
         refund key is published in the repository so tests can open the seal, which
         means <strong>any refund address you enter here is readable by anyone</strong>.
         Do not use an address you care about.
       </div>`
    : `<div class="note">
         This auction's refund key is not published, so refund addresses sealed here
         are readable only by the auctioneer.
       </div>`;

  $("auction-note").innerHTML = `
    <div class="verdict">
      <div class="stat"><div class="k">Auction</div><div class="v">${name}</div></div>
      <div class="stat"><div class="k">Reserve</div><div class="v">${reserve} ZEC</div></div>
      <div class="stat"><div class="k">Closes at height</div>
        <div class="v">${auction.endsAtHeight ?? "—"}</div></div>
      <div class="stat span2"><div class="k">Auction id</div><div class="v hex">${id}</div></div>
    </div>
    ${practice}`;
}

// ---------------------------------------------------------------------------
// Sealing
// ---------------------------------------------------------------------------

$("bid-form").addEventListener("submit", (event) => {
  event.preventDefault();
  seal();
});

function seal() {
  if (!auction) return;

  const status = $("seal-status");
  status.textContent = "Sealing in your browser…";
  status.className = "dim status";
  $("seal").disabled = true;

  // Yield once so the status paints before the small amount of crypto runs.
  setTimeout(() => {
    try {
      const bidZat = zecToZat($("bid").value, "bid");
      const collateralZat = zecToZat($("collateral").value, "collateral");
      const sealed = prepareBid(auction, {
        bidZat,
        collateralZat,
        refundAddress: $("refund").value,
      });

      status.textContent = "Sealed locally — nothing was sent.";
      status.className = "ok status";
      renderSealed(sealed, bidZat, collateralZat);
    } catch (err) {
      status.textContent = "";
      renderSealError(err);
    } finally {
      $("seal").disabled = false;
    }
  }, 16);
}

function renderSealed(sealed, bidZat, collateralZat) {
  const belowReserve = bidZat < auction.reserveZat;
  const reserveNote = belowReserve
    ? `<div class="note note-tight">
         <strong>Below the reserve.</strong> This bid is under
         ${formatAmountZec(auction.reserveZat)} ZEC, so the auditor will classify it
         <em>below reserve</em> and it will not set the price. Sealing it is allowed;
         winning with it is not.
       </div>`
    : "";

  $("out").innerHTML = `
    <h2>Sealed bid</h2>
    <div class="panel">
      <p class="result-title ok">Your sealed bid is ready</p>
      <p class="dim hint-tight">
        Nothing has been sent. The payment request below is yours to pay from
        your own wallet.
      </p>
      <div class="verdict">
        <div class="stat"><div class="k">Bid</div>
          <div class="v">${formatAmountZec(bidZat)} ZEC</div></div>
        <div class="stat"><div class="k">Collateral to send</div>
          <div class="v">${formatAmountZec(collateralZat)} ZEC</div></div>
        <div class="stat"><div class="k">Memo</div><div class="v">512 bytes</div></div>
        <div class="stat"><div class="k">Commitment</div>
          <div class="v hex">${escapeHtml(sealed.ticket.bid_commit.slice(0, 16))}…</div></div>
      </div>

      <p class="hint">
        This payment request is what your wallet sends: the collateral to the
        escrow address, with the sealed envelope as its memo. The bid amount is
        not in it — only a commitment that your reveal will open later.
      </p>
      <div class="copy-row">
        <textarea class="uri" id="uri" readonly aria-label="Payment request"></textarea>
        <button type="button" class="secondary" id="copy-uri">Copy</button>
      </div>

      <details class="note-tight">
        <summary class="dim">The 512-byte memo, in hex</summary>
        <pre class="hexblock">${escapeHtml(sealed.ticket.memo)}</pre>
      </details>

      <div class="actions spaced">
        <button type="button" id="download">Download reveal ticket</button>
        <span id="save-status" class="dim" role="status" aria-live="polite"></span>
      </div>

      <ol class="steps">
        <li><strong>Save the ticket first.</strong>
            <span class="dim">It holds the nonce that opens your commitment. It is the
            only copy, and this page does not keep one.</span></li>
        <li><strong>Send the payment request from your wallet.</strong>
            <span class="dim">Amount: ${formatAmountZec(collateralZat)} ZEC, to the escrow
            address, with the memo attached. Most wallets cannot carry a 512-byte
            binary memo; the request works only in a wallet that understands ZIP-321
            memos, or through node tooling like <code>z_sendmany</code>.</span></li>
        <li><strong>After the deadline, publish the reveal.</strong>
            <span class="dim">Use step 2 on this page. A bid nobody can open is not
            counted, even though the funds were sent.</span></li>
      </ol>

      ${reserveNote}

      <div class="note note-tight">
        Lose the ticket and the bid is unreadable forever: the commitment on chain
        cannot be opened by you, the auctioneer, or anyone else. That is the sealed
        property working as designed, not a bug to work around.
      </div>
    </div>`;

  $("uri").value = sealed.uri;

  $("copy-uri").addEventListener("click", () => copyFrom($("uri"), "Payment request"));
  $("download").addEventListener("click", () => downloadTicket(sealed));
}

function renderSealError(err) {
  const message = err instanceof BidError
    ? err.message
    : "The bid could not be sealed. Check the amounts and the refund address.";
  $("out").innerHTML = errorPanel("That bid was not sealed", message, err);
}

// ---------------------------------------------------------------------------
// Ticket download
// ---------------------------------------------------------------------------

function downloadTicket(sealed) {
  const name = `veilo-reveal-${sealed.ticket.bid_commit.slice(0, 8)}.json`;
  const body = JSON.stringify(sealed.ticket, null, 2) + "\n";
  const url = URL.createObjectURL(new Blob([body], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking immediately can race the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  $("save-status").textContent = `Saved ${name}. Keep it until the reveal is published.`;
}

// ---------------------------------------------------------------------------
// Publishing the reveal
// ---------------------------------------------------------------------------

$("publish").addEventListener("click", () => {
  const status = $("reveal-status");
  try {
    const text = $("ticket-text").value.trim();
    if (!text) {
      throw new BidError("BadTicket", "Paste the ticket file's contents, or choose the file above.");
    }
    const published = publishReveal(text);
    status.textContent = "Reveal checked against its own commitment."
    status.className = "ok status";
    renderReveal(published);
  } catch (err) {
    status.textContent = "";
    $("reveal-out").innerHTML = errorPanel(
      "That reveal was not published",
      err instanceof BidError
        ? err.message
        : "The ticket could not be read. It must be the JSON file this page downloaded.",
      err
    );
  }
});

function renderReveal(published) {
  $("reveal-out").innerHTML = `
    <div class="panel spaced">
      <p class="result-title ok">Reveal ready to publish</p>
      <p class="hint">
        This bid was <strong>${published.bidZec} ZEC</strong> in auction
        <code>${escapeHtml(published.auctionId)}</code>. Post the 40 bytes below
        wherever the auction's reveals are collected. Publishing is permissionless:
        anyone may post it, and the auditor will match it against your commitment.
      </p>
      <div class="copy-row">
        <textarea class="reveal" id="reveal" readonly aria-label="Reveal bytes"></textarea>
        <button type="button" class="secondary" id="copy-reveal">Copy</button>
      </div>
      <p class="hint">
        Until this is public, your bid has an amount on chain that nobody can read.
        That is the cost of a sealed bid: the reveal is not optional.
      </p>
    </div>`;
  $("reveal").value = published.revealHex;
  $("copy-reveal").addEventListener("click", () => copyFrom($("reveal"), "Reveal"));
}

$("ticket-file").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  const text = await file.text();
  $("ticket-text").value = text;
  $("reveal-status").textContent = `Loaded ${file.name}. Press "Read my reveal".`;
  $("reveal-status").className = "dim status";
});

// ---------------------------------------------------------------------------
// Shared UI helpers
// ---------------------------------------------------------------------------

async function copyFrom(element, label) {
  try {
    await navigator.clipboard.writeText(element.value);
    element.focus();
    element.select();
    announce(`${label} copied.`);
  } catch {
    // Clipboard access can be refused; selecting the text is the fallback that
    // always works and tells the person what to do next.
    element.focus();
    element.select();
    announce(`${label} selected — press Ctrl/Cmd+C to copy.`);
  }
}

function announce(text) {
  const el = $("copy-status");
  if (el) el.textContent = text;
}

/**
 * One error shape for all three failure points. `retry` is opt-in: only the
 * auction load has a meaningful "try again" (re-fetch), because re-running a
 * seal or a reveal would repeat an action the person already took.
 */
function errorPanel(title, message, err, { retry = false } = {}) {
  const detail = err instanceof Error && err.stack
    ? `<details><summary>Technical detail</summary><pre>${escapeHtml(err.message)}</pre></details>`
    : "";
  return `
    <div class="panel error spaced" role="alert">
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(message)}</p>
      ${retry ? `<button type="button" id="retry">Try again</button>` : ""}
      ${detail}
    </div>`;
}

// A single live region for copy feedback, outside the replaced markup.
$("copy-status").setAttribute("aria-live", "polite");

loadAuction();
