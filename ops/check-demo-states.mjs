#!/usr/bin/env node
// Check the demo page's *states*, not just its numbers.
//
// `verify-demo.mjs` proves the audit arithmetic. This proves the page a person
// actually meets: an empty state before the run, a loading state during it, a
// plain-language error with a way out, a result that survives a 375px screen,
// and a focus ring for keyboard users. Those are the parts AI-generated UIs
// usually omit, and the parts a passing arithmetic test cannot see.
//
//   node ops/check-demo-states.mjs
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

// Range support, because a check that cannot seek is a check that checks nothing.
const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  if (pathname === "/favicon.ico") return res.writeHead(204).end();
  const file = resolve(DEMO, `.${pathname === "/" ? "/index.html" : pathname}`);
  if (!file.startsWith(DEMO)) return res.writeHead(403).end();
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "content-length": body.length,
      "accept-ranges": "bytes",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}/`;

const results = [];
const check = (name, pass, detail = "") => results.push({ name, pass, detail });

let browser;
try {
  browser = await chromium.launch({
    channel: process.env.CHROME_PATH ? undefined : "chrome",
    executablePath: process.env.CHROME_PATH || undefined,
    args: ["--enable-unsafe-swiftshader"],
  });

  // ---------------------------------------------------------------- happy path
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(400);

  check("empty state on load", await page.locator("#out .empty").count() === 1);
  check("no result before the click", await page.locator("#out .stat").count() === 0);
  check("nothing claims to be busy", await page.locator("#out").getAttribute("aria-busy") === "false");

  // Sampled inside the page: a round trip over CDP can lose this race, because
  // the whole audit can finish in well under a tenth of a second.
  const during = await page.evaluate(() => {
    const btn = document.getElementById("run");
    btn.click();
    return {
      disabled: btn.disabled,
      busy: document.getElementById("out").getAttribute("aria-busy"),
      skeleton: document.querySelectorAll("#out .skeleton").length,
      status: document.getElementById("status").textContent,
    };
  });
  check("loading state shows a placeholder", during.skeleton === 1);
  check("run button cannot be double-clicked", during.disabled === true);
  check("result area marked aria-busy", during.busy === "true");
  check("loading status is plain words", /loading/i.test(during.status), during.status);

  await page.waitForSelector("#out .stat", { timeout: 30000 });
  await page.waitForTimeout(250);

  const stats = await page.$$eval("#out .stat", (els) =>
    Object.fromEntries(els.map((e) => [
      e.querySelector(".k").textContent.trim(),
      e.querySelector(".v").textContent.replace(/\s+/g, " ").trim(),
    ])));
  check("winner", stats.Winner === "bidder 10101010…", stats.Winner);
  check("clearing price", stats["Clearing price"] === "60.00 ZEC", stats["Clearing price"]);
  check("bids recovered", stats["Bids recovered"] === "5 of 10", stats["Bids recovered"]);
  check("matches stated price", stats["Matches stated price"] === "yes", stats["Matches stated price"]);

  const status = await page.locator("#status").innerText();
  check("status reports time and count", /audited 10 outputs in \d+ ms/.test(status), status);
  check("status is a live region", await page.locator("#status").getAttribute("aria-live") === "polite");

  check("provenance note explains the match", await page.locator("#out .provenance").count() === 1);

  // The honesty note is load-bearing: it is the only place the page admits the
  // exclusion is declared rather than proven. If it disappears, this fails.
  const disclosure = await page.locator("#out .note").first().innerText();
  check("seller exclusion is disclosed as declared",
    /declared, not proven/i.test(disclosure), disclosure.slice(0, 80));
  check("disclosure names the dependency",
    /depends on the declaration/i.test(disclosure));
  const sellerStatus = await page.$$eval("#out tbody tr", (rows) =>
    rows.map((r) => r.lastElementChild.previousElementSibling?.textContent.trim() ?? "")
      .find((t) => t.startsWith("seller")) ?? "");
  check("seller row is labelled declared", sellerStatus === "seller — declared", sellerStatus);

  check("three next-step links", await page.locator(".next a").count() === 3);
  check("next-step links leave the page usefully", await page.$$eval(".next a", (as) =>
    as.every((a) => a.href.startsWith("https://github.com/"))));

  const inline = await page.$$eval("[style]", (els) => els.length);
  check("no inline styles anywhere", inline === 0, `${inline} found`);

  // ---------------------------------------------------------------- small screen
  await page.setViewportSize({ width: 375, height: 812 });
  await page.waitForTimeout(300);
  const widths = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    win: window.innerWidth,
    table: document.querySelector(".table-scroll")?.scrollWidth ?? 0,
    box: document.querySelector(".table-scroll")?.clientWidth ?? 0,
  }));
  check("no horizontal page scroll at 375px", widths.doc <= widths.win + 1, JSON.stringify(widths));
  check("wide table scrolls inside its wrapper", widths.table > widths.box, JSON.stringify(widths));

  // ---------------------------------------------------------------- keyboard
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.keyboard.press("Tab");
  const focus = await page.evaluate(() => {
    const el = document.activeElement;
    return { id: el?.id, outline: getComputedStyle(el).outlineWidth, style: getComputedStyle(el).outlineStyle };
  });
  check("Tab reaches the run button", focus.id === "run", focus.id);
  check("focus ring is visible", focus.outline !== "0px" && focus.style !== "none",
        `${focus.outline} ${focus.style}`);

  // ---------------------------------------------------------------- error path
  const bad = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const uncaught = [];
  bad.on("pageerror", (e) => uncaught.push(String(e)));
  let breakFixture = true;
  await bad.route("**/fixture.json", (r) => (breakFixture ? r.abort("failed") : r.continue()));

  await bad.goto(origin, { waitUntil: "domcontentloaded" });
  await bad.locator("#run").click();
  await bad.waitForSelector("#out .error", { timeout: 20000 });

  const errText = await bad.locator("#out .error").innerText();
  check("error explains itself in plain words", /Couldn't load the demo data/.test(errText));
  check("error does not print a raw exception", !/TypeError|Failed to fetch|net::ERR/.test(errText));
  check("error offers a way out", await bad.locator("#retry").count() === 1);
  check("error is announced", await bad.locator("#out .error").getAttribute("role") === "alert");
  check("technical detail starts collapsed",
        await bad.locator("#out details").count() === 1 &&
        !(await bad.locator("#out details").getAttribute("open")));
  check("error clears the stale loading status",
        (await bad.locator("#status").innerText()).trim() === "");

  breakFixture = false;
  await bad.locator("#retry").click();
  await bad.waitForSelector("#out .stat", { timeout: 30000 });
  check("retry replaces the error with a result", await bad.locator("#out .error").count() === 0);
  check("retry does not stack results", await bad.locator("#out .stat").count() === 4);
  check("error path throws nothing uncaught", uncaught.length === 0, uncaught.join("; "));

  check("main page logs no console errors", consoleErrors.length === 0, consoleErrors.join("; "));
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
  console.log("\nthe page is missing states a person will meet. Fix before shipping.");
  process.exitCode = 1;
}
