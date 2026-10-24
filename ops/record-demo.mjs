#!/usr/bin/env node
// Record the demo as a video, driving your existing Chrome via playwright-core.
//
// Why this exists: a judge should be able to watch the auditor run rather than
// take our word for it. It also means the demo video cannot drift from the demo
// — it is generated from the same page and the same committed `demo/pkg` bundle
// that the tests assert against.
//
// Nothing is mocked. The page loads `demo/fixture.json` (ten real Sapling
// ciphertexts), the committed WebAssembly module trial-decrypts them in Chrome,
// and the winner and clearing price below are read back out of the rendered DOM
// and asserted. If the page is broken, this script exits non-zero instead of
// producing a video of a failure.
//
//   node ops/record-demo.mjs [--headed] [--out demo/video/veilo-demo.webm]
//
// --headed shows the browser window while recording, which is useful for
// confirming framing. Default is headless for unattended runs.

import { createServer } from "node:http";
import { readFile, readdir, mkdir, writeFile, rm } from "node:fs/promises";
import { extname, join, resolve, basename, sep as pathSeparator } from "node:path";
import { chromium } from "playwright-core";

const ROOT = resolve(import.meta.dirname, "..");
const DEMO = join(ROOT, "demo");

const argv = process.argv.slice(2);
const headed = argv.includes("--headed");
const outArg = argv.indexOf("--out");
const OUT = resolve(ROOT, outArg >= 0 ? argv[outArg + 1] : "demo/video/veilo-demo.webm");
const TMP = join(ROOT, ".record-tmp");

// ---------------------------------------------------------------- assertions
// These are read out of the live page, not hardcoded, so a video that shows the
// wrong number fails instead of shipping.
const EXPECT = {
  winner: "10101010",
  clearing: "60.00 ZEC",
  recovered: "5 of 10",
  matches: "yes",
};

const problems = [];
const checks = [];
function check(name, actual, expected) {
  const ok = actual === expected;
  checks.push({ name, ok, actual, expected });
  if (!ok) problems.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ------------------------------------------------------------------- serving
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".css": "text/css; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

// wasm must be served as application/wasm or streaming instantiation fails,
// which is the classic way a browser-only demo turns out to be broken.
//
// `/rec/` exposes the recording temp dir so the just-written video can be
// loaded back and probed, same-origin, before the context is closed.
//
// Range requests are mandatory for video. Without `Accept-Ranges` and 206
// responses Chrome reports `seekable = [0, 0]` and silently refuses to seek, so
// every probe reads frame zero -- which looks exactly like a corrupt video.
const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  if (pathname === "/favicon.ico") {
    res.writeHead(204).end();
    return;
  }
  const fromTmp = pathname.startsWith("/rec/");
  const root = fromTmp ? TMP : DEMO;
  const rel = fromTmp ? pathname.slice("/rec/".length) : pathname === "/" ? "/index.html" : pathname;
  const file = resolve(root, `.${pathSeparator}${rel}`);
  if (!file.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    const type = MIME[extname(file)] ?? "application/octet-stream";
    const range = req.headers.range;

    if (!range) {
      res.writeHead(200, {
        "content-type": type,
        "content-length": body.length,
        "accept-ranges": "bytes",
        "cache-control": "no-store",
      });
      res.end(body);
      return;
    }

    // Single-range only, which is all a media element asks for.
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m) {
      res.writeHead(416, { "content-range": `bytes */${body.length}` }).end();
      return;
    }
    const start = m[1] ? Number(m[1]) : 0;
    const end = m[2] ? Math.min(Number(m[2]), body.length - 1) : body.length - 1;
    if (start > end || start >= body.length) {
      res.writeHead(416, { "content-range": `bytes */${body.length}` }).end();
      return;
    }
    const chunk = body.subarray(start, end + 1);
    res.writeHead(206, {
      "content-type": type,
      "content-length": chunk.length,
      "content-range": `bytes ${start}-${end}/${body.length}`,
      "accept-ranges": "bytes",
      "cache-control": "no-store",
    });
    res.end(chunk);
  } catch {
    res.writeHead(404).end("not found");
  }
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const origin = `http://127.0.0.1:${port}/`;
const URL_ = `${origin}index.html`;

// ------------------------------------------------------------------- caption
// A silent video has to explain itself, so each scene burns a caption into the
// page. Injected rather than in demo/index.html so the demo stays clean.
// page.evaluate takes a function plus one argument, which is far safer than
// splicing a string into an eval and hoping the JSON escaping holds.
async function caption(page, text) {
  await page.evaluate((t) => {
    let bar = document.getElementById("__cap");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "__cap";
      bar.style.cssText = [
        "position:fixed",
        "left:0",
        "right:0",
        "bottom:0",
        "z-index:2147483647",
        "padding:18px 28px",
        "font:600 19px/1.45 ui-sans-serif,system-ui,sans-serif",
        "color:#f4f6fb",
        "background:linear-gradient(90deg,#0b1020f2,#161d33f2)",
        "border-top:1px solid #2c3557",
        "letter-spacing:.1px",
      ].join(";");
      document.body.appendChild(bar);
    }
    bar.textContent = t || "";
    bar.style.display = t ? "block" : "none";
  }, text);
}

// A beat between scenes so the viewer can read, without the video feeling dead.
const shot = (page, ms) => page.waitForTimeout(ms);

// --------------------------------------------------------------------- story
let browser;
let summary = null;
let videoReport = null;
try {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });

  browser = await chromium.launch({
    headless: !headed,
    executablePath: process.env.CHROME_PATH || undefined,
    channel: process.env.CHROME_PATH ? undefined : "chrome",
    args: ["--autoplay-policy=no-user-gesture-required"],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    recordVideo: { dir: TMP, size: { width: 1280, height: 800 } },
  });
  const page = await context.newPage();

  const pageErrors = [];
  // A missing favicon is a browser nicety, not a demo defect. Everything else
  // is treated as a real failure so a broken wasm MIME type cannot pass quietly.
  const benign = (t) => /favicon/i.test(t);
  page.on("pageerror", (e) => {
    if (!benign(String(e))) pageErrors.push(String(e));
  });
  page.on("console", (m) => {
    if (m.type() === "error" && !benign(m.text())) pageErrors.push(`console: ${m.text()}`);
  });
  page.on("requestfailed", (r) => {
    if (!benign(r.url())) pageErrors.push(`request failed: ${r.url()}`);
  });

  // Scene 1 — the claim, stated before any evidence.
  await page.goto(URL_, { waitUntil: "networkidle" });
  await shot(page, 2600);
  await caption(page, "Veilo: a sealed-bid auction whose seller never sees a single bid.");
  await shot(page, 3400);
  await caption(page, "The seller publishes a viewing key. It can read the escrow — it cannot spend, and no bid key exists.");
  await shot(page, 3800);

  // Scene 2 — the auction runs.
  await caption(page, "Auction 0101…0101: Bob 70, Carol 60, David 45 ZEC, reserve 50. The seller bids 65 on her own auction.");
  await shot(page, 3800);
  await caption(page, "Bids are sealed in the memo of a shielded Sapling transfer. On-chain, a bid is a commitment and nothing else.");
  await shot(page, 3800);

  // Scene 3 — the audit. This is the whole project.
  await caption(page, "Deadline. Reveals are public. Anyone can now check the result.");
  await shot(page, 2600);
  await caption(page, "Run the audit: the browser loads WebAssembly and trial-decrypts ten real 580-byte chain ciphertexts.");
  await page.click("#run");
  await page.waitForFunction(() => /audited \d+ outputs/.test(document.body.innerText), null, { timeout: 20000 });
  await caption(page, "One viewing key, no server, no network calls. The auctioneer is not in the loop.");
  await shot(page, 3600);

  // Scene 4 — the result, and the rule that makes it honest.
  summary = await page.evaluate(() => {
    // The verdict is a .stat per metric: a .k label with a .v value beside it.
    // Scoping to those classes rather than matching loose text keeps this from
    // silently reading the wrong element if the layout changes.
    const stat = {};
    for (const s of document.querySelectorAll("#out .stat")) {
      const k = s.querySelector(".k")?.textContent.trim() ?? "";
      const v = s.querySelector(".v")?.textContent.trim().replace(/\s+/g, " ") ?? "";
      stat[k] = v;
    }
    const body = document.body.innerText;
    const m = body.match(/audited (\d+) outputs in ([\d,]+) ms/);
    return {
      winner: stat["Winner"] ?? "",
      clearing: stat["Clearing price"] ?? "",
      recovered: stat["Bids recovered"] ?? "",
      matches: stat["Matches stated result"] ?? "",
      rowCount: document.querySelectorAll("#out tbody tr").length,
      swept: m ? `${m[1]} outputs` : "",
      ms: m ? `${m[2]} ms` : "",
    };
  });

  check("winner", summary.winner.startsWith(`bidder ${EXPECT.winner}`) ? EXPECT.winner : summary.winner, EXPECT.winner);
  check("clearing price", summary.clearing, EXPECT.clearing);
  check("bids recovered", summary.recovered, EXPECT.recovered);
  check("matches stated result", summary.matches, EXPECT.matches);
  check("recovered bid rows", summary.rowCount, 5);
  check("page errors", pageErrors.length, 0);
  if (pageErrors.length) problems.push(`page errors: ${pageErrors.join(" | ")}`);

  await page.evaluate(() => {
    const h = [...document.querySelectorAll("h2")].find((n) => n.textContent.trim() === "Recovered bids");
    h?.scrollIntoView({ block: "start", behavior: "instant" });
  });
  await caption(page, "Bob wins at 60.00 ZEC — the second-highest eligible bid.");
  await shot(page, 3600);

  await caption(page, "The seller bid 65 ZEC, second-highest overall, and is excluded. Without that rule the price would be 65.");
  await shot(page, 3800);

  await caption(page, "Also rejected: a bid below the reserve, and one that did not collateralise what it promised.");
  await shot(page, 3600);

  // Scene 5 — what was actually verified, stated honestly.
  await page.evaluate(() => {
    const h = [...document.querySelectorAll("h2")].find((n) => n.textContent.trim() === "How it ran");
    h?.scrollIntoView({ block: "start", behavior: "instant" });
  });
  await caption(page, "6,440 bytes swept. A compact 52-byte light-client output carries no memo — an auditor fed that way sees nothing.");
  await shot(page, 4000);

  await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" }));
  await caption(page, "Real Sapling encryption, real 512-byte envelopes, genuine decryption. Not mined on a chain — that is a separate claim.");
  await shot(page, 4200);

  await caption(page, "The clearing price is recomputed by anyone, offline. That is the point.");
  await shot(page, 3600);
  await caption(page, "");
  await shot(page, 1200);

  // Playwright finalises the video only when the context closes, so the file
  // must be closed first and verified afterwards.
  await context.close();

  // --------------------------------------------------- verify the artifact
  // A recording can finish without error and still be truncated, frameless or
  // unseekable. A broken artifact committed to the repo is worse than none,
  // because a judge reasonably assumes it was checked.
  const recorded = (await readdir(TMP)).find((f) => f.endsWith(".webm"));
  if (!recorded) throw new Error("playwright wrote no video");

  const verifyPage = await browser.newPage();
  await verifyPage.goto(origin, { waitUntil: "domcontentloaded" });

  // Frames are read with drawImage rather than requestVideoFrameCallback,
  // because a paused, off-screen video never presents a frame and so never
  // fires that callback, which would fail a perfectly good file.
  videoReport = await verifyPage.evaluate(async (src) => {
    const v = document.createElement("video");
    v.src = src;
    v.muted = true;
    v.preload = "auto";
    document.body.appendChild(v);
    const decoded = await new Promise((res) => {
      v.onloadeddata = () => res(true);
      v.onerror = () => res(false);
      setTimeout(() => res(false), 20000);
    });
    if (!decoded) return { decoded: false, error: `decode failed (code ${v.error?.code})` };

    const c = document.createElement("canvas");
    c.width = 160;
    c.height = 100;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    const fingerprint = () => {
      ctx.drawImage(v, 0, 0, 160, 100);
      const d = ctx.getImageData(0, 0, 160, 100).data;
      let sum = 0;
      let min = 255;
      let max = 0;
      for (let i = 0; i < d.length; i += 4) {
        const l = (d[i] * 77 + d[i + 1] * 151 + d[i + 2] * 28) >> 8;
        sum += l;
        if (l < min) min = l;
        if (l > max) max = l;
      }
      return { mean: Math.round(sum / (d.length / 4)), contrast: max - min };
    };

    const points = [];
    for (const frac of [0.02, 0.25, 0.5, 0.75, 0.97]) {
      const target = v.duration * frac;
      // Wait for `seeked`, with a currentTime fallback: a paused element
      // reports its old position until the seek actually lands.
      const landed = new Promise((res) => {
        v.addEventListener("seeked", () => res(true), { once: true });
        setTimeout(() => res(false), 10000);
      });
      v.currentTime = target;
      const reached = (await landed) || Math.abs(v.currentTime - target) < 1;
      points.push({ frac, reached, ...fingerprint() });
    }

    return {
      decoded: true,
      duration: v.duration,
      width: v.videoWidth,
      height: v.videoHeight,
      seekable: v.seekable.length ? [v.seekable.start(0), v.seekable.end(v.seekable.length - 1)] : null,
      points,
    };
  }, `${origin}rec/${recorded}`);
} finally {
  await browser?.close();
  server.close();
}

// ------------------------------------------------------------------ retrieve
let made = null;
for (const f of await readdir(TMP)) {
  if (f.endsWith(".webm")) made = join(TMP, f);
}
if (!made) {
  console.error("no video was produced");
  process.exit(1);
}

await mkdir(resolve(OUT, ".."), { recursive: true });
await writeFile(OUT, await readFile(made));
await rm(TMP, { recursive: true, force: true });

console.log(`wrote ${OUT}`);
console.log(`swept ${summary?.swept ?? "?"} in ${summary?.ms ?? "?"} in real Chrome`);
console.log("");

// ------------------------------------------------------------ video verdict
if (videoReport) {
  if (!videoReport.decoded) {
    problems.push(`the recorded video does not decode: ${videoReport.error}`);
  } else {
    const { duration, width, height, seekable, points } = videoReport;
    console.log(`video ${width}x${height}  ${duration.toFixed(2)}s  seekable=${JSON.stringify(seekable)}`);
    for (const p of points) {
      console.log(
        `  ${(p.frac * 100).toFixed(0).padStart(3)}%  reached=${String(p.reached).padEnd(5)} ` +
          `mean=${String(p.mean).padStart(3)}  contrast=${p.contrast}`,
      );
    }
    if (duration < 20) problems.push(`video is only ${duration.toFixed(2)}s, which is too short to be the whole demo`);
    if (!points.every((p) => p.reached)) problems.push("the video could not be seeked to every probe point, so it is likely truncated");
    if (!points.some((p) => p.contrast > 12)) problems.push("no probe point returned a non-blank frame");
    const distinct = new Set(points.map((p) => p.mean)).size;
    if (distinct < 3) problems.push(`only ${distinct} distinct frames across 5 probe points, so the video looks static or broken`);
    if (seekable && seekable[1] < duration - 1) {
      problems.push(`seekable range ends at ${seekable[1]}s but the file claims ${duration.toFixed(2)}s`);
    }
    console.log("");
  }
}

for (const c of checks) console.log(`  ${c.ok ? "ok  " : "FAIL"}  ${c.name}: ${c.actual}`);
console.log("");

if (problems.length) {
  console.error("the recording is not being claimed as correct:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("every value on screen matched the expected result, and the video decodes and seeks");
