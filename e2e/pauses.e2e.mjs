// `t` after many Mark pauses. One clip with 8 Marks (different notes and pause lengths) on a static and an animated page,
// a full-page flash after each resume, the 3-2-1 countdown, and Stop during a countdown.
// Run: npm run build && node e2e/pauses.e2e.mjs [static|animated|stop-countdown]
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startServer } from "./server.mjs";
import { OUT, ROOT, flashAtT, framesWithCentre, launch, log, markViaHud, readReport, startRecording, status, stopViaHud, videoOf, waitForOutput } from "./lib.mjs";

// The recorder caps capture at 30 fps (src/offscreen), so one frame interval is 1000 / 30 ms.
const FRAME_MS = 1000 / 30;
// Whole-ms timestamps on both sides (Date.now at draw, WebM pts) plus rAF jitter: the oracle's resolution at a frame boundary.
const BOUNDARY_MS = 3;
const PAUSES = [
  { note: "short", pauseMs: 300, afterMs: 250, via: "enter" },
  { note: "Two lines\nwith a break", pauseMs: 1500, afterMs: 600, via: "button" },
  { note: "", pauseMs: 700, afterMs: 150, via: "enter" },
  { note: "x".repeat(400), pauseMs: 2500, afterMs: 900, via: "button" },
  { note: "ตรงนี้ไม่ตรงกับที่คาดไว้", pauseMs: 400, afterMs: 350, via: "enter" },
  { note: "medium length note about the table", pauseMs: 1100, afterMs: 200, via: "button" },
  { note: "y".repeat(120), pauseMs: 3000, afterMs: 700, via: "enter" },
  { note: "last", pauseMs: 900, afterMs: 450, via: "button" },
];

const results = [];
const check = (name, ok, detail = "") => {
  results.push(!!ok);
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
};

/** Full-page green for 500 ms, added at the start of a frame so the harness adds no paint delay; logs console.error then. */
function flashLogged(page, k) {
  return page.evaluate(
    (k) =>
      new Promise((resolve) =>
        requestAnimationFrame(() => {
          const d = document.createElement("div");
          // Leaves the animated page's timecode row (top 40 px) visible.
          d.style.cssText = "position:fixed;inset:40px 0 0 0;background:#00ff00;z-index:2147483646;pointer-events:none";
          document.documentElement.appendChild(d);
          console.error(`r2c-flash ${k}`);
          setTimeout(() => (d.remove(), resolve()), 500);
        }),
      ),
    k,
  );
}

async function hudBox(page) {
  return page.evaluate(() => {
    const b = document.querySelector("record2context-ui")?.shadowRoot?.querySelector(".hud")?.getBoundingClientRect();
    return b && { x: b.x, y: b.y, w: b.width, h: b.height };
  });
}

function rawFrames(video, crop) {
  const pts = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v", "-show_entries", "frame=pts_time", "-of", "csv=p=0", video])
    .toString()
    .trim()
    .split("\n")
    .map((l) => Math.round(Number(l) * 1000));
  const rgb = execFileSync("ffmpeg", ["-v", "error", "-i", video, "-fps_mode", "passthrough", "-vf", `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], {
    maxBuffer: 512 * 1024 * 1024,
  });
  const size = crop.w * crop.h * 3;
  return pts.map((ms, i) => ({ ms, px: rgb.subarray(i * size, (i + 1) * size) }));
}

/** Frames whose HUD area shows the countdown's blue (#2563eb). */
function countdownFrames(video, box) {
  const even = (n) => Math.max(0, Math.round(n / 2) * 2);
  const crop = { x: even(box.x - 40), y: even(box.y - 4), w: even(box.w + 80), h: even(box.h + 8) };
  return rawFrames(video, crop).filter(({ px }) => {
    let n = 0;
    for (let i = 0; i < px.length; i += 3) if (px[i] < 90 && px[i + 1] > 70 && px[i + 1] < 140 && px[i + 2] > 190) n++;
    return n > 20;
  }).map((f) => f.ms);
}

/** Frames showing the Mark editor's dark toolbar backdrop across the top-right corner (the test pages are light there). */
function editorFrames(video) {
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v", "-show_entries", "stream=width", "-of", "json", video]).toString());
  const w = probe.streams[0].width;
  const crop = { x: w - 200, y: 0, w: 200, h: 40 };
  return rawFrames(video, crop).filter(({ px }) => {
    let dark = 0;
    for (let i = 0; i < px.length; i += 3) if (px[i] < 70 && px[i + 1] < 70 && px[i + 2] < 90) dark++;
    return dark > (px.length / 3) * 0.9;
  }).map((f) => f.ms);
}

/** Per video frame: the page's Date.now() drawn into it (18 blocks of 40 px), skipping frames where a block is not black or white. */
function timecodes(video, startedAt) {
  return rawFrames(video, { x: 0, y: 0, w: 720, h: 40 }).flatMap(({ ms, px }) => {
    let code = 0;
    for (let i = 0; i < 18; i++) {
      const o = (20 * 720 + i * 40 + 20) * 3;
      const [r, g, b] = [px[o], px[o + 1], px[o + 2]];
      if (r > 195 && g > 195 && b > 195) code |= 1 << i;
      else if (!(r < 60 && g < 60 && b < 60)) return [];
    }
    const base = startedAt - 10000;
    return [{ ms, drawn: base + ((code - (base % 262144) + 262144) % 262144) }];
  });
}

const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];

async function eightMarks(variant) {
  const { server, port } = await startServer(join(ROOT, "e2e", "fixtures"));
  const env = await launch(`pauses-${variant}`);
  const { ctx, sw, extId } = env;
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(`http://127.0.0.1:${port}/${variant === "animated" ? "animated.html" : ""}`);
    await startRecording(ctx, extId, sw, page);
    await page.waitForTimeout(800);
    await flashLogged(page, 0);
    await page.waitForTimeout(600);
    // Measured while the bar shows: the Mark editor hides it while paused.
    const box = await hudBox(page);
    const counts = [];
    for (const [i, p] of PAUSES.entries()) {
      const mark = await markViaHud(page, p.note, { continueWith: p.via });
      await page.waitForTimeout(p.pauseMs);
      counts.push((await mark.resume()).join(""));
      await page.waitForTimeout(p.afterMs);
      await flashLogged(page, i + 1);
      await page.waitForTimeout(300);
    }
    await stopViaHud(page);
    const dir = await waitForOutput(env);
    const report = readReport(dir);
    const video = videoOf(dir, report);
    const frames = framesWithCentre(video);
    const offsets = report.events
      .filter((e) => e.type === "console_error" && /^r2c-flash \d+/.test(e.message))
      .map((e) => ({ k: Number(e.message.match(/\d+$/)[0]), t: e.t, ...flashAtT(frames, e.t) }));
    const cs = report.clockSync;
    log(`${variant} clockSync ${cs.source}: start shift ${cs.startShiftMs} ms, frames matched ${cs.framesMatched}/${cs.videoFrames}, per pause correctionMs ${(cs.pauses ?? []).map((p) => `${p.correctionMs}(${p.framesMatched})`).join(" ")}, lag per stretch ${(cs.lag ?? []).map((l) => `${l.ms} (${l.minMs}-${l.maxMs}, n=${l.samples})`).join(" ")}`);
    check(`${variant}: countdown 3-2-1 before every resume`, counts.every((c) => c === "321"), counts.join(" "));
    check(`${variant}: 8 marks with their notes, 8 pauses`, report.marks.length === 8 && report.marks.every((m, i) => m.note === PAUSES[i].note) && report.pauses.length === 8);
    check(`${variant}: every mark has its paused frame as a screenshot`, report.marks.every((m) => m.screenshot && report.screenshots.some((s) => s.file === m.screenshot && s.mark === m.n && s.t === m.t)));
    const editorLeaks = editorFrames(video);
    check(`${variant}: the Mark editor never in the video`, editorLeaks.length === 0, editorLeaks.length ? `frames at ${editorLeaks.slice(0, 10).join(", ")} ms` : "");
    check(`${variant}: clock measured from the video's frames, every pause`, cs.source === "video-frames" && cs.pauses.length === 8 && cs.pauses.every((p) => p.framesMatched > 0) && cs.framesMatched * 100 >= cs.videoFrames * 98, JSON.stringify({ ...cs, pauses: undefined }));
    const leaks = countdownFrames(video, box);
    check(`${variant}: countdown never in the video`, leaks.length === 0, leaks.length ? `frames at ${leaks.join(", ")} ms` : "");

    // Every offset within one frame, except at most one flash per clip that has no video frame between t and it (capture
    // made none for a while, so the frame at t is that flash however late it is); that one is listed.
    const base = offsets.find((o) => o.k === 0);
    const found = offsets.length === 9 && offsets.every((o) => o.offset != null);
    const off = (o) => !(o.offset >= -5 && o.offset <= FRAME_MS && (o.k === 0 || Math.abs(o.offset - base.offset) <= FRAME_MS));
    const outside = offsets.filter(off);
    const exempt = outside.length === 1 && outside[0].captureGap && outside[0].k !== 0 ? outside : [];
    const timed = offsets.filter((o) => o.k > 0 && !exempt.includes(o)).map((o) => o.offset);
    const spread = timed.length ? Math.max(...timed) - Math.min(...timed) : null;
    check(
      `${variant}: flash offset after each pause within one frame (${FRAME_MS.toFixed(1)} ms) of the pre-pause one, spread within one frame`,
      found && outside.length === exempt.length && spread <= FRAME_MS,
      `offsets ${offsets.map((o) => `#${o.k} ${o.offset}`).join(", ")}; spread after pauses ${spread} ms${exempt.length ? `; exempt: #${exempt[0].k} (no video frame between t and it)` : ""}`,
    );

    let codeRows = null;
    if (variant === "animated") {
      // Each r2c-code event was logged by the frame that drew that code: -ss t must land on the first frame drawn at or after it.
      const codes = timecodes(video, Date.parse(report.startedAt));
      const events = report.events.filter((e) => e.type === "console_error" && /^r2c-code \d+/.test(e.message) && !e.duringPause);
      codeRows = events.map((e) => {
        const drawn = Number(e.message.slice("r2c-code ".length));
        const i = codes.findIndex((c) => c.ms >= e.t);
        const at = codes[i];
        const prev = codes[i - 1];
        const firstDrawnAfter = codes.find((c) => c.drawn >= drawn);
        const before = firstDrawnAfter ? codes.filter((c) => c.ms < firstDrawnAfter.ms).at(-1) : undefined;
        return {
          t: e.t,
          drawn,
          ok: !!at && at.drawn >= drawn && (!prev || prev.drawn < drawn),
          gap: firstDrawnAfter ? firstDrawnAfter.ms - e.t : null,
          // pts of the frame before it, relative to t: t may move anywhere in (prevGap, gap] and still be right.
          prevGap: before ? before.ms - e.t : null,
        };
      });
      // Timestamps are whole ms (Date.now, WebM pts): an event drawn within BOUNDARY_MS of a frame boundary may land on the
      // neighbouring frame. Those are counted, not hidden; any other miss fails.
      // Right when prevGap < 0 <= gap; a boundary miss is t just past the right frame, or the frame before it just at/after t.
      const near = (r) => (r.gap !== null && r.gap < 0 && r.gap >= -BOUNDARY_MS) || (r.prevGap !== null && r.prevGap >= 0 && r.prevGap < BOUNDARY_MS);
      const wrong = codeRows.filter((r) => !r.ok);
      const bad = wrong.filter((r) => !near(r));
      const gaps = codeRows.map((r) => r.gap).filter((g) => g !== null);
      check(
        `animated: for every r2c-code event, the frame at t is the first frame drawn at or after it (${codeRows.length} events across 8 pauses; within ${BOUNDARY_MS} ms of a frame boundary counted apart)`,
        codeRows.length >= 40 && bad.length === 0,
        `${wrong.length - bad.length} at a boundary, ${bad.length} wrong${bad.length ? ` (first: t=${bad[0].t}, gap ${bad[0].gap} ms)` : ""}; pts of that frame − t: ${Math.min(...gaps)}..${Math.max(...gaps)} ms`,
      );
    }
    return { variant, offsets, spread, clockSync: cs, codeRows };
  } finally {
    await ctx.close();
    server.close();
  }
}

async function stopInCountdown() {
  const { server, port } = await startServer(join(ROOT, "e2e", "fixtures"));
  const env = await launch("pauses-stop");
  const { ctx, sw, extId } = env;
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(`http://127.0.0.1:${port}/animated.html`);
    await startRecording(ctx, extId, sw, page);
    await page.waitForTimeout(1500);
    const note = "stopped during the countdown";
    const box = await hudBox(page);
    await markViaHud(page, note, { continueWith: "button" });
    await page.locator("record2context-ui .ed button.continue").click();
    await page.waitForTimeout(1300);
    const shown = await page.evaluate(() => document.querySelector("record2context-ui")?.shadowRoot?.querySelector(".countdown")?.textContent);
    const stillPaused = (await sw.evaluate(async () => (await chrome.storage.session.get("session")).session?.pauses?.at(-1)?.end)) === undefined;
    await stopViaHud(page);
    const dir = await waitForOutput(env);
    const report = readReport(dir);
    check("stop during countdown: recorder still paused while it counts", shown === "2" && stillPaused, `showing ${shown}`);
    check("stop during countdown: saved with the note, one pause, never resumed", report.marks.length === 1 && report.marks[0].note === note && report.pauses.length === 1 && report.durationMs < report.marks[0].t + 200, `video ${report.durationMs} ms, mark at ${report.marks[0]?.t}`);
    check("stop during countdown: session idle afterwards", (await status(sw)) === "idle");
    const leaks = countdownFrames(videoOf(dir, report), box);
    check("stop during countdown: countdown never in the video", leaks.length === 0, leaks.join(", "));
  } finally {
    await ctx.close();
    server.close();
  }
}

const which = process.argv[2];
const out = [];
if (!which || which === "static") out.push(await eightMarks("static"));
if (!which || which === "animated") out.push(await eightMarks("animated"));
if (!which || which === "stop-countdown") await stopInCountdown();
writeFileSync(join(OUT, "pauses.json"), JSON.stringify(out, null, 2));
log(`${results.filter(Boolean).length}/${results.length} checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);
