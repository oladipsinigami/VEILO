#!/usr/bin/env node
// Convert the recorded demo from WebM (VP8/VP9) to MP4 (H.264).
//
// Why this exists: WebM plays in Chrome, Edge and Firefox but not everywhere,
// and a judge who cannot play the video sees nothing. H.264 MP4 is the safe
// submission format.
//
// Why it is done in a browser: ffmpeg is not installed on this machine, and a
// static build downloaded from npm is blocked by Windows Smart App Control
// ("Access is denied" — the same reason the Rust toolchain cannot run here).
// Chrome 152 can encode H.264 through MediaRecorder, so the browser we already
// depend on for the demo does the conversion. That also means no lossy
// re-encode of the audio, of which there is none — the demo carries burned-in
// captions, so it is deliberately silent.
//
// The output is verified by loading it back and comparing its duration against
// the source, because a truncated MP4 is a silent failure.
//
//   node ops/webm-to-mp4.mjs [in.webm] [out.mp4]

import { createServer } from "node:http";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { extname, join, resolve, basename, dirname } from "node:path";
import { chromium } from "playwright-core";

const ROOT = resolve(import.meta.dirname, "..");
const IN = resolve(ROOT, process.argv[2] ?? "demo/video/veilo-demo.webm");
const OUT = resolve(ROOT, process.argv[3] ?? "demo/video/veilo-demo.mp4");

for (const [label, p] of [["input", IN], ["output", OUT]]) {
  if (!p.startsWith(ROOT)) throw new Error(`refusing to write ${label} outside the repo`);
}

await stat(IN).catch(() => {
  throw new Error(`${IN} not found — run: node ops/record-demo.mjs`);
});

const MIME = { ".webm": "video/webm", ".mp4": "video/mp4", ".html": "text/html; charset=utf-8" };
const dir = dirname(IN);

const HOST_PAGE = "<!doctype html><meta charset=utf-8><title>convert</title><body style='background:#111'>";

// --------------------------------------------------------- MP4 timing repair
// Just enough ISO-BMFF parsing to read the fragment timeline and rewrite the
// timing fields. Written out rather than pulled from a dependency because the
// whole reason this script exists is that no binary tooling is available here.
//
// Two defects in Chrome's MediaRecorder H.264 output are corrected, both derived
// from the file itself rather than hardcoded:
//
//   1. `mdhd.duration` is written using the *movie* timescale value
//      (milliseconds) while `mdhd.timescale` stays at the media timescale
//      (30000). A 52s clip therefore reads as 1.74s through that field.
//   2. `trun` sample durations come out ~4.6% long, so even after fixing (1)
//      the file plays several percent slow.
//
// The source duration is known exactly -- it is the video we just played -- so
// sample durations are scaled to hit it. Nothing is re-encoded; only timestamps
// change.
const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "moof", "traf", "mvex"]);

function repairMp4Timing(buf, targetSeconds) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const u32 = (o) => dv.getUint32(o);

  let header = null;
  const truns = [];
  let samples = 0;
  let total = 0;

  const walk = (start, end) => {
    let off = start;
    while (off + 8 <= end) {
      let size = u32(off);
      const type = buf.toString("latin1", off + 4, off + 8);
      let hdr = 8;
      if (size === 1) {
        size = u32(off + 8) * 2 ** 32 + u32(off + 12);
        hdr = 16;
      }
      if (size === 0) size = end - off;
      if (size < hdr || off + size > end) return;
      const body = off + hdr;

      if (type === "mdhd" && !header) {
        const version = buf[body];
        header = {
          version,
          durationAt: version === 1 ? body + 24 : body + 16,
          timescale: version === 1 ? u32(body + 20) : u32(body + 12),
          current: version === 1 ? Number(dv.getBigUint64(body + 24)) : u32(body + 16),
        };
      }

      if (type === "trun") {
        const flags = u32(body) & 0xffffff;
        const count = u32(body + 4);
        let p = body + 8;
        if (flags & 0x1) p += 4; // data offset
        if (flags & 0x4) p += 4; // first sample flags
        if (flags & 0x100) {
          truns.push({ durationAt: p, duration: u32(p), count });
          samples += count;
          total += count * u32(p);
        } else {
          // No per-sample duration: the timeline length is not addressable.
          truns.push({ durationAt: 0, duration: 0, count });
        }
      }

      if (CONTAINERS.has(type)) walk(body, off + size);
      off += size;
    }
  };

  walk(0, buf.length);
  if (!header || !samples || !total || !targetSeconds) return buf;

  const want = Math.round(targetSeconds * header.timescale);
  const scale = want / total;

  // Scaling the per-sample durations also corrects mdhd, since mdhd is just the
  // sum of them. Only rewrite it if scaling did not happen.
  let rescaled = 0;
  if (truns.every((t) => t.durationAt) && Math.abs(scale - 1) > 0.001) {
    for (const t of truns) {
      const next = Math.max(1, Math.round(t.duration * scale));
      if (next !== t.duration) {
        dv.setUint32(t.durationAt, next);
        rescaled += t.count;
      }
    }
    console.log(
      `rescaled ${rescaled} sample durations by ${scale.toFixed(4)} ` +
        `(${truns.length} fragments, ${samples} samples)`,
    );
  }

  const fixed = truns.reduce((a, t) => a + t.count * (t.durationAt ? Math.max(1, Math.round(t.duration * scale)) : t.duration), 0);
  const before = header.current;
  const after = fixed || Math.round(targetSeconds * header.timescale);
  if (header.version === 1) dv.setBigUint64(header.durationAt, BigInt(after));
  else if (after <= 0xffffffff) dv.setUint32(header.durationAt, after);

  if (before !== after) {
    console.log(
      `repaired mdhd: timescale=${header.timescale} duration ${before} -> ${after} ` +
        `(${(before / header.timescale).toFixed(2)}s -> ${(after / header.timescale).toFixed(2)}s)`,
    );
  }
  return buf;
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://x");
  try {
    if (pathname === "/" || pathname === "") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(HOST_PAGE);
      return;
    }
    const p = join(dir, basename(pathname));
    const body = await readFile(p);
    const type = MIME[extname(p)] ?? "application/octet-stream";
    const range = req.headers.range;

    // Range support is required: without 206 responses Chrome refuses to seek
    // and reports `seekable = [0, 0]`, which makes a healthy video look corrupt.
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
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    const start = m?.[1] ? Number(m[1]) : 0;
    const end = m?.[2] ? Math.min(Number(m[2]), body.length - 1) : body.length - 1;
    if (!m || start > end || start >= body.length) {
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
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;

const CANDIDATES = [
  "video/mp4;codecs=avc1.42E01E",
  "video/mp4;codecs=avc1.4D401E",
  "video/mp4",
];

const chunks = [];
let browser;
try {
  browser = await chromium.launch({
    // Headed, deliberately: MediaRecorder needs the compositor to actually
    // present frames. Headless Chrome accepts the calls and can hand back an
    // empty recording, which looks exactly like a codec problem.
    headless: false,
    channel: process.env.CHROME_PATH ? undefined : "chrome",
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--mute-audio",
      // Chrome stops presenting frames for an occluded window, so a capture
      // started without these produces a file that plays at real speed but
      // carries only a few seconds of frames. Turning off every backgrounding
      // and occlusion throttle is what makes wall-clock capture complete.
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-features=CalculateNativeWinOcclusion",
    ],
  });
  const page = await browser.newPage();
  await page.exposeFunction("__sink", (b64) => {
    chunks.push(Buffer.from(b64, "base64"));
  });
  await page.goto(base, { waitUntil: "domcontentloaded" });

  const mime = await page.evaluate((c) => c.find((t) => MediaRecorder.isTypeSupported(t)) ?? null, CANDIDATES);
  if (!mime) throw new Error(`this Chrome cannot encode H.264; tried ${CANDIDATES.join(", ")}`);
  console.log(`encoding with ${mime}`);

  const info = await page.evaluate(
    async ([src, mimeType, sink]) => {
      const v = document.createElement("video");
      v.src = src;
      v.muted = true;
      v.playsInline = true;
      document.body.appendChild(v);

      await new Promise((res, rej) => {
        v.onloadedmetadata = res;
        v.onerror = () => rej(new Error(`could not decode the source video (${v.error?.code})`));
      });

      const srcDuration = v.duration;
      const W = v.videoWidth;
      const H = v.videoHeight;

      // Frames are pulled through a canvas on a wall-clock 30fps tick, not taken
      // from `video.captureStream()`. The element stream only emits frames when
      // the element is actually painted, so on a window nobody is watching it
      // hands back a file carrying a few seconds of frames across the whole
      // runtime -- a silent truncation that looks like a broken encode.
      const canvas = document.createElement("canvas");
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext("2d", { alpha: false });
      document.body.appendChild(canvas);

      const stream = canvas.captureStream(0);
      const track = stream.getVideoTracks()[0];
      const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2_500_000 });

      // Blobs are collected first and only base64-encoded afterwards. Spreading
      // a multi-megabyte Uint8Array into String.fromCharCode overflows the stack,
      // and the resulting error inside a data handler surfaces as "no data".
      const blobs = [];
      rec.ondataavailable = (e) => {
        if (e.data.size) blobs.push(e.data);
      };

      const done = new Promise((res) => (rec.onstop = res));
      rec.start();

      let frames = 0;
      const draw = () => {
        ctx.drawImage(v, 0, 0, W, H);
        track.requestFrame();
        frames++;
      };

      await v.play();

      // 15fps, not 30. Playwright launches Chrome on software GL
      // (--enable-unsafe-swiftshader), so the software H.264 encoder cannot keep
      // up with 30fps at 1280x800 and silently drops frames -- which shows up as
      // a file several seconds shorter than the source. 15fps gives the encoder
      // room to keep every frame, and for captions over still slides 15fps is
      // visually indistinguishable from 30.
      const FPS = 15;
      const ticker = setInterval(draw, 1000 / FPS);
      draw();

      await new Promise((res, rej) => {
        v.onended = res;
        v.onerror = () => rej(new Error("playback failed mid-encode"));
        setTimeout(() => rej(new Error("playback did not finish within 180s")), 180000);
      });
      clearInterval(ticker);
      await new Promise((r) => setTimeout(r, 400));
      rec.stop();
      await done;
      draw();

      const emit = window[sink];
      let bytes = 0;
      for (const blob of blobs) {
        const buf = new Uint8Array(await blob.arrayBuffer());
        // Chunked so no single btoa call gets a megabyte of arguments.
        for (let i = 0; i < buf.length; i += 0x8000) {
          await emit(btoa(String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000))));
        }
        bytes += buf.length;
      }

      return { srcDuration, srcWidth: W, srcHeight: H, frames, fps: FPS, encodedBytes: bytes, blobs: blobs.length };
    },
    [`${base}${basename(IN)}`, mime, "__sink"],
  );

  await browser.close();
  browser = null;

  if (!chunks.length) throw new Error("MediaRecorder produced no data");
  await mkdir(dirname(OUT), { recursive: true });
  const mp4 = Buffer.concat(chunks);

  const repaired = repairMp4Timing(mp4, info.srcDuration);
  await writeFile(OUT, repaired);

  // ---------------------------------------------------------------- verify
  // Loading it back is the only honest check available without ffprobe: a file
  // that Chrome can decode at the source's duration and dimensions is intact.
  browser = await chromium.launch({ headless: true, channel: process.env.CHROME_PATH ? undefined : "chrome" });
  const verifyPage = await browser.newPage();
  await verifyPage.goto(base, { waitUntil: "domcontentloaded" });
  const out = await verifyPage.evaluate(async (src) => {
    const v = document.createElement("video");
    v.src = src;
    v.muted = true;
    // Seeking before the media pipeline has data silently does nothing, so
    // wait for loadeddata, not just metadata.
    v.preload = "auto";
    document.body.appendChild(v);
    const ok = await new Promise((res) => {
      v.onloadeddata = () => res(true);
      v.onerror = () => res(false);
      setTimeout(() => res(false), 15000);
    });
    if (!ok) return { ok: false, error: `decode failed (code ${v.error?.code})` };
    const seekable = v.seekable.length ? [v.seekable.start(0), v.seekable.end(v.seekable.length - 1)] : null;

    // Seek to three points and confirm real pixels come back at each. A
    // truncated MP4 still reports a plausible duration from its header, so
    // duration alone proves nothing -- decoding actual frames does.
    //
    // The pixels are read with drawImage rather than requestVideoFrameCallback,
    // because a paused, off-screen video never presents a frame and so never
    // fires that callback, which would fail on a perfectly good file.
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 100;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    const seekTo = async (frac) => {
      const target = Math.max(0, v.duration * frac);
      // Wait for `seeked` as well as polling currentTime: a paused element
      // reports its old currentTime until the seek lands, so polling alone can
      // read a stale value and conclude the seek failed.
      const landed = new Promise((res) => {
        v.addEventListener("seeked", () => res(true), { once: true });
        setTimeout(() => res(false), 10000);
      });
      v.currentTime = target;
      const ok = await landed;
      return ok || Math.abs(v.currentTime - target) < 1.0;
    };

    const fingerprint = () => {
      ctx.drawImage(v, 0, 0, 160, 100);
      const d = ctx.getImageData(0, 0, 160, 100).data;
      let sum = 0;
      let min = 255;
      let max = 0;
      for (let i = 0; i < d.length; i += 4) {
        const lum = (d[i] * 77 + d[i + 1] * 151 + d[i + 2] * 28) >> 8;
        sum += lum;
        if (lum < min) min = lum;
        if (lum > max) max = lum;
      }
      return { mean: Math.round(sum / (d.length / 4)), contrast: max - min };
    };

    const points = [];
    for (const frac of [0.02, 0.5, 0.97]) {
      const reached = await seekTo(frac);
      points.push({ frac, reached, ...fingerprint() });
    }

    // Real video has variation between frames and within them; a black or
    // single-colour frame at every position means the decoder gave us nothing.
    const distinct = new Set(points.map((p) => p.mean)).size;
    const anyContrast = points.some((p) => p.contrast > 12);
    const allReached = points.every((p) => p.reached);

    return {
      ok: true,
      duration: v.duration,
      width: v.videoWidth,
      height: v.videoHeight,
      seekable,
      points,
      seekableTail: allReached && distinct > 1 && anyContrast,
      distinctMeans: distinct,
    };
  }, `${base}${basename(OUT)}`);

  await browser.close();
  browser = null;

  const size = (await stat(OUT)).size;
  console.log(`source  ${info.srcWidth}x${info.srcHeight}  ${info.srcDuration.toFixed(2)}s  ${info.frames} frames drawn at ${info.fps}fps`);
  console.log(`written ${OUT}  ${(size / 1e6).toFixed(2)} MB`);

  const problems = [];
  if (!out.ok) problems.push(out.error);
  if (out.ok) {
    console.log(`decoded ${out.width}x${out.height}  ${out.duration.toFixed(2)}s  seekable=${JSON.stringify(out.seekable)}`);
    for (const p of out.points) {
      console.log(`  seek ${(p.frac * 100).toFixed(0).padStart(3)}%  reached=${p.reached}  mean=${p.mean}  contrast=${p.contrast}`);
    }
    const drift = Math.abs(out.duration - info.srcDuration);
    if (drift > 0.25) problems.push(`duration drift: ${out.duration.toFixed(2)}s vs source ${info.srcDuration.toFixed(2)}s`);
    // A real-time capture of a 52s clip needs roughly 52 x fps frames. Far fewer
    // means frames were dropped, which shows up as a stuttering or short file.
    const expectedFrames = info.srcDuration * info.fps;
    if (info.frames < expectedFrames * 0.9) {
      problems.push(`only ${info.frames} frames drawn, expected about ${Math.round(expectedFrames)}`);
    }
    if (out.width !== info.srcWidth || out.height !== info.srcHeight) {
      problems.push(`dimensions changed: ${out.width}x${out.height} vs ${info.srcWidth}x${info.srcHeight}`);
    }
    if (!out.seekableTail) {
      problems.push(
        `frames did not decode at every probe point ` +
          `(${out.points.map((p) => `${(p.frac * 100) | 0}%:${p.reached ? "ok" : "fail"}/c${p.contrast}`).join(" ")})`,
      );
    }
  }

  if (problems.length) {
    console.error("");
    console.error("the MP4 did not verify, so it is not being claimed as good:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log("");
  console.log("MP4 verified: decodes, matches source duration and size, seeks to the end");
} finally {
  await browser?.close();
  server.close();
}
