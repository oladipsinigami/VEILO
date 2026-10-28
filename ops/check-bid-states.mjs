#!/usr/bin/env node
// Check the bid page in a real browser.
//
// `test/bid.test.js` proves the sealing arithmetic. This proves the page a
// person actually uses: the auction document loads, a bid becomes a 512-byte
// memo and a wallet request, the ticket downloads and re-opens into a 40-byte
// reveal, the two rejections a bidder is most likely to hit explain themselves,
// nothing is sent anywhere after the page loads, and it survives a 375px screen
// and a keyboard.
//
//   node ops/check-bid-states.mjs
//
// Exits non-zero on any failure, so it is safe to wire into CI.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright-core";

const ROOT = resolve(import.meta.dirname, "..");
const DEMO = join(ROOT, "demo");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".css": "text/css; charset=utf-8",
};

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  if (pathname === "/favicon.ico") return res.writeHead(204).end();
  const file = resolve(DEMO, `.${pathname === "/" ? "/bid.html" : pathname}`);
  if (!file.startsWith(DEMO)) return res.writeHead(403).end();
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "content-length": body.length,
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}/bid.html`;

const results = [];
const check = (name, pass, detail = "") => results.push({ name, pass, detail });

const REFUND =
  "zregtestsapling1yuw2z0xuzpafnml99fhwz08efwn2wp637rqyerswz3f7kaljlkzzf0aynyjrvylvuye22htzvjy";

let browser;
try {
  browser = await chromium.launch({
    channel: process.env.CHROME_PATH ? undefined : "chrome",
    executablePath: process.env.CHROME_PATH || undefined,
  });

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

  await page.goto(origin, { waitUntil: "networkidle" });

  // ------------------------------------------------------------ auction banner
  await page.waitForSelector("#auction-note .stat", { timeout: 15000 });
  const banner = await page.$$eval("#auction-note .stat", (els) =>
    Object.fromEntries(els.map((e) => [
      e.querySelector(".k").textContent.trim(),
      e.querySelector(".v").textContent.replace(/\s+/g, " ").trim(),
    ])));
  check("auction name is shown", banner.Auction === "Veilo practice auction", banner.Auction);
  check("reserve is formatted from zatoshi", banner.Reserve === "5 ZEC", banner.Reserve);
  check("closing height is shown", banner["Closes at height"] === "120", banner["Closes at height"]);
  check("auction id is shown", /^[0-9a-f]{32}$/.test(banner["Auction id"]), banner["Auction id"]);

  const practiceNote = await page.locator("#auction-note .note").innerText();
  check("practice auction is labelled as practice", /practice auction/i.test(practiceNote));
  check("page warns the refund address is public",
    /readable by anyone/i.test(practiceNote), practiceNote.slice(0, 90));
  check("page warns the escrow is inert off regtest", /inert on every real network/i.test(practiceNote));

  check("nothing is sealed before the form is used",
    (await page.locator("#out .result-title").innerText()).trim() === "Nothing sealed yet");
  check("seal button starts enabled once the auction loads",
    (await page.locator("#seal").isEnabled()) === true);

  // ------------------------------------------------------------ zero network
  // Everything after this point must run with no request leaving the page. A
  // sealed bid that is silently uploaded is not a sealed bid.
  const requests = [];
  page.on("request", (r) => requests.push(r.url()));

  // ------------------------------------------------------------ seal
  await page.fill("#bid", "60");
  await page.fill("#collateral", "60");
  await page.fill("#refund", REFUND);
  await page.click("#seal");
  await page.waitForSelector("#out .result-title.ok", { timeout: 15000 });

  check("sealing reports a sealed bid",
    /sealed bid is ready/i.test(await page.locator("#out .result-title.ok").innerText()));
  check("page states that nothing was sent",
    /nothing was sent/i.test(await page.locator("#seal-status").innerText()) &&
    /Nothing has been sent/i.test(await page.locator("#out .hint-tight").innerText()));
  check("seal status is announced",
    await page.locator("#seal-status").getAttribute("aria-live") === "polite");

  const uri = await page.locator("#uri").inputValue();
  check("payment request targets the escrow address",
    uri.startsWith("zcash:zregtestsapling1hjah3xuapma7yjrd6xh7sgx885c3c370afjhne63f2wg0akrz5gnl4wvygupczk2f4s5x86hkyk?"),
    uri.slice(0, 60));
  check("payment request carries the collateral", /[?&]amount=60(&|$)/.test(uri));
  check("payment request carries an expiring height", /[?&]expires=120(&|$)/.test(uri));

  // textContent, not innerText: the memo lives inside a collapsed <details>, and
  // a bidder can still select and copy it without expanding first.
  const memoHex = await page.locator("#out .hexblock").textContent();
  check("memo is exactly 512 bytes", memoHex.trim().length === 1024, `${memoHex.trim().length} hex chars`);
  check("memo starts with the Veilo magic", /^ff564c4f01/.test(memoHex.trim()), memoHex.trim().slice(0, 10));
  check("bid amount does not appear in the memo", !memoHex.includes("3b9aca00"));

  const stats = await page.$$eval("#out .stat", (els) =>
    Object.fromEntries(els.map((e) => [
      e.querySelector(".k").textContent.trim(),
      e.querySelector(".v").textContent.replace(/\s+/g, " ").trim(),
    ])));
  check("sealed bid repeats the amount", stats.Bid === "60 ZEC", stats.Bid);
  check("sealed bid repeats the collateral", stats["Collateral to send"] === "60 ZEC", stats["Collateral to send"]);

  // ------------------------------------------------------------ ticket download
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 10000 }),
    page.click("#download"),
  ]);
  const ticketPath = await download.path();
  const ticket = JSON.parse(await readFile(ticketPath, "utf8"));
  check("ticket filename names the commitment",
    /^veilo-reveal-[0-9a-f]{8}\.json$/.test(download.suggestedFilename()), download.suggestedFilename());
  check("ticket is version 1", ticket.version === 1);
  check("ticket carries the bid", ticket.bid_zat === "6000000000", ticket.bid_zat);
  check("ticket carries a 16-byte nonce", /^[0-9a-f]{32}$/.test(ticket.nonce));
  check("ticket carries the 512-byte memo", /^[0-9a-f]{1024}$/.test(ticket.memo));
  check("ticket save is confirmed in the page",
    /Saved veilo-reveal-/.test(await page.locator("#save-status").innerText()));
  check("ticket is not stashed in browser storage",
    (await page.evaluate(() => ({ ls: localStorage.length, ss: sessionStorage.length, c: document.cookie })))
      .ls === 0);
  check("no cookies are set",
    (await page.evaluate(() => document.cookie)) === "");

  // ------------------------------------------------------------ reveal
  await page.fill("#ticket-text", JSON.stringify(ticket, null, 2));
  await page.click("#publish");
  await page.waitForSelector("textarea#reveal", { timeout: 10000 });
  const revealHex = await page.locator("#reveal").inputValue();
  check("reveal is 40 bytes", /^[0-9a-f]{80}$/.test(revealHex), `${revealHex.length} hex chars`);
  check("reveal names the auction",
    revealHex.startsWith(ticket.auction_id), revealHex.slice(0, 32));
  check("reveal page states the amount", /60 ZEC/.test(await page.locator("#reveal-out").innerText()));

  // ------------------------------------------------------------ tampered ticket
  await page.fill("#ticket-text", JSON.stringify({ ...ticket, bid_zat: "6100000000" }));
  await page.click("#publish");
  await page.waitForSelector("#reveal-out .error", { timeout: 10000 });
  const tamperText = await page.locator("#reveal-out .error").innerText();
  check("an edited amount is refused", /edited/i.test(tamperText), tamperText.slice(0, 100));
  check("refusal offers no pointless retry", (await page.locator("#reveal-out #retry").count()) === 0);

  // ------------------------------------------------------------ validation error
  await page.fill("#bid", "61");
  await page.fill("#collateral", "60");
  await page.click("#seal");
  await page.waitForSelector("#out .error", { timeout: 10000 });
  const underText = await page.locator("#out .error").innerText();
  check("under-collateralised bid is refused", /less than the bid/i.test(underText), underText.slice(0, 100));
  check("refusal names both amounts", /60 ZEC/.test(underText) && /61 ZEC/.test(underText));
  check("seal refusal offers no dead retry", (await page.locator("#out #retry").count()) === 0);
  check("seal status is cleared after a refusal",
    (await page.locator("#seal-status").innerText()).trim() === "");

  // ------------------------------------------------------------ below reserve
  await page.fill("#bid", "3");
  await page.fill("#collateral", "3");
  await page.click("#seal");
  await page.waitForSelector("#out .result-title.ok", { timeout: 10000 });
  const belowReserve = await page
    .locator("#out .note", { hasText: "Below the reserve" })
    .first()
    .innerText();
  check("below-reserve bid is sealed but flagged",
    /Below the reserve/i.test(belowReserve), belowReserve.slice(0, 80));
  check("flag explains the consequence",
    /will not set the price/i.test(belowReserve));

  // ------------------------------------------------------------ no network
  check("no network requests after load", requests.length === 0,
    requests.slice(0, 3).join("; "));

  // ------------------------------------------------------------ small screen
  await page.setViewportSize({ width: 375, height: 812 });
  await page.waitForTimeout(300);
  const widths = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    win: window.innerWidth,
  }));
  check("no horizontal page scroll at 375px", widths.doc <= widths.win + 1, JSON.stringify(widths));

  // ------------------------------------------------------------ keyboard
  const kb = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await kb.goto(origin, { waitUntil: "networkidle" });
  await kb.waitForSelector("#auction-note .stat", { timeout: 15000 });
  await kb.keyboard.press("Tab"); // back to the audit page
  await kb.keyboard.press("Tab"); // first field: the bid
  const focus = await kb.evaluate(() => {
    const el = document.activeElement;
    const s = getComputedStyle(el);
    return { id: el?.id, outlineWidth: s.outlineWidth, outlineStyle: s.outlineStyle };
  });
  check("Tab reaches the bid field", focus.id === "bid", focus.id);
  check("focus ring is visible", focus.outlineWidth !== "0px" && focus.outlineStyle !== "none",
    `${focus.outlineWidth} ${focus.outlineStyle}`);

  // ------------------------------------------------------------ load error
  const bad = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const uncaught = [];
  bad.on("pageerror", (e) => uncaught.push(String(e)));
  let breakAuction = true;
  await bad.route("**/auction.json", (r) => (breakAuction ? r.abort("failed") : r.continue()));

  await bad.goto(origin, { waitUntil: "networkidle" });
  await bad.waitForSelector("#auction-note .error", { timeout: 15000 });
  const errText = await bad.locator("#auction-note .error").innerText();
  check("load error explains itself", /Couldn't load the auction document/.test(errText));
  check("load error does not print a raw exception",
    !/TypeError|Failed to fetch|net::ERR/.test(errText));
  check("load error offers a retry", (await bad.locator("#auction-note #retry").count()) === 1);
  check("seal is disabled while the auction is missing",
    (await bad.locator("#seal").isDisabled()) === true);
  check("load error is announced",
    await bad.locator("#auction-note .error").getAttribute("role") === "alert");

  breakAuction = false;
  await bad.locator("#auction-note #retry").click();
  await bad.waitForSelector("#auction-note .stat", { timeout: 15000 });
  check("retry replaces the error with the auction",
    (await bad.locator("#auction-note .error").count()) === 0);
  check("retry re-enables sealing", (await bad.locator("#seal").isEnabled()) === true);
  check("error path throws nothing uncaught", uncaught.length === 0, uncaught.join("; "));

  check("bid page logs no console errors", consoleErrors.length === 0, consoleErrors.join("; "));
} finally {
  await browser?.close();
  server.close();
}

const failed = results.filter((r) => !r.pass);
for (const r of results) {
  console.log(`${r.pass ? "  ok  " : "  FAIL"} ${r.name}${r.detail ? `  -- ${r.detail}` : ""}`);
}
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("\nthe bid page is missing states a bidder will meet. Fix before shipping.");
  process.exitCode = 1;
}
