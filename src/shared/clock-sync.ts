import { stretchOfSample, videoTime, type LagSample, type VideoClock } from "./clock";
import type { EventLog } from "./event-log";

/**
 * A frame the offscreen document saw: capture timestamp (VideoFrame.timestamp, ms), arrival (epoch ms) and,
 * while the HUD timer's place is known, the sum of its pixels there (`spot` names that place).
 */
export interface FrameSeen {
  ts: number;
  arrival: number;
  spot?: string;
  sum?: number;
}

/** The HUD timer's text changed at `at` (epoch ms, in a requestAnimationFrame, so it was drawn in that frame) at `spot`. */
export interface HudTick {
  at: number;
  spot: string;
}

/** MediaRecorder calls in high-resolution epoch ms. `resume` is missing when the recording stopped while paused. */
export interface RecorderCalls {
  startCall: number;
  /** The recorder's `start` event, i.e. the clock's videoStart. */
  start: number;
  pauses: { pause: number; resume?: number }[];
}

export interface PauseSync {
  /** Time between the pause() and resume() calls. */
  wallMs: number;
  /** What the recorder cut from the video, measured from frame timestamps against the file's own frame times. */
  videoMs: number;
  framesMatched: number;
  frames: number;
}

export interface ClockSync {
  /** Capture time of the file's first frame minus the `start` event; add it to videoStart. */
  startShiftMs: number;
  /** One per resumed pause, in order. */
  pauses: PauseSync[];
  /** Frames of the file found among the frames seen while recording, of `videoFrames`. */
  framesMatched: number;
  videoFrames: number;
  /** How far the captured picture trails the page, measured at each HUD timer change. */
  lag: LagSample[];
}

// A frame matches a file frame when they are this close; WebM stores ms, so 1 ms covers its rounding.
const MATCH_MS = 1;
// The recorder cuts exactly the time between pause() and resume() (measured: within ~1 ms). Under half the 60 fps frame
// spacing, so the search cannot slip onto the frames the recorder's 30 fps track skipped.
const SEARCH_MS = 5;
// A HUD change shows in the video within this long, or the sample is dropped; changes at one spot are >= this far apart
// (countdown steps 250 ms minus up to 2 frames), so a sample can never pick up the previous change instead of its own.
const LAG_MAX_MS = 200;

function lowerBound(a: number[], x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The shift within ±SEARCH_MS of `k` that lines most frames up with file frames (pts = ts - k - shift). */
function bestShift(frames: FrameSeen[], pts: number[], k: number): { shift: number; matched: number } {
  const res: number[] = [];
  for (const f of frames) {
    const x = f.ts - k;
    for (let i = lowerBound(pts, x - SEARCH_MS - MATCH_MS); i < pts.length && pts[i]! <= x + SEARCH_MS + MATCH_MS; i++) res.push(x - pts[i]!);
  }
  res.sort((a, b) => a - b);
  let best = { lo: 0, n: 0 };
  for (let lo = 0, hi = 0; hi < res.length; hi++) {
    while (res[hi]! - res[lo]! > 2 * MATCH_MS) lo++;
    if (hi - lo + 1 > best.n) best = { lo, n: hi - lo + 1 };
  }
  if (!best.n) return { shift: 0, matched: 0 };
  const win = res.slice(best.lo, best.lo + best.n);
  const shift = win[win.length >> 1]!;
  return { shift, matched: matches(frames, pts, k + shift) };
}

/** File frames (distinct) that some frame seen lands on, with pts = ts - k. */
function matches(frames: FrameSeen[], pts: number[], k: number): number {
  const hit = new Set<number>();
  for (const f of frames) {
    const i = lowerBound(pts, f.ts - k - MATCH_MS);
    if (i < pts.length && Math.abs(pts[i]! - (f.ts - k)) <= MATCH_MS) hit.add(i);
  }
  return hit.size;
}

/** Capture time (epoch, via `domain`) of the first frame after `tick` whose timer pixels differ from the frame before it. */
export function lagSamples(frames: FrameSeen[], ticks: HudTick[], domain: number, resumes: number[] = []): LagSample[] {
  const raw: LagSample[] = [];
  for (const [n, tick] of ticks.entries()) {
    const prev = ticks[n - 1];
    if (prev && prev.spot === tick.spot && tick.at - prev.at < LAG_MAX_MS) continue;
    // Only frames since the last resume: across a pause the HUD and page may have changed for other reasons.
    const since = Math.max(-Infinity, ...resumes.filter((r) => r <= tick.at));
    const spot = frames.filter((f) => f.spot === tick.spot && f.sum !== undefined && f.arrival >= since);
    const i = spot.findIndex((f) => f.ts + domain >= tick.at);
    if (i < 1) continue;
    const before = spot[i - 1]!.sum;
    const changed = spot.slice(i).find((f) => f.sum !== before);
    if (!changed) continue;
    const ms = changed.ts + domain - tick.at;
    if (ms >= 0 && ms <= LAG_MAX_MS) raw.push({ at: tick.at, ms });
  }
  return raw;
}

/**
 * Line the frames the offscreen document saw up with the frames in the file (`pts`, ms, from the WebM blocks):
 * pts = ts - firstTs - pausedSoFar. Gives the capture time of t=0 and what each pause really cut; null when they do not line up.
 */
export function syncClock(frames: FrameSeen[], calls: RecorderCalls, pts: number[], ticks: HudTick[] = []): ClockSync | null {
  if (!frames.length || !pts.length) return null;
  const sorted = [...pts].sort((a, b) => a - b);
  // Arrival minus capture is the domain offset plus a delivery delay; the smallest is the closest to the offset.
  // Any error left here cancels out once lag (measured with the same offset) is added to t.
  const domain = Math.min(...frames.map((f) => f.arrival - f.ts));
  const bounds: [number, number][] = [[calls.startCall, calls.pauses[0]?.pause ?? Infinity]];
  calls.pauses.forEach((p, i) => {
    if (p.resume !== undefined) bounds.push([p.resume, calls.pauses[i + 1]?.pause ?? Infinity]);
  });
  // Segment 0 starts after the frame start() was called on, which the recorder never got.
  const segs = bounds.map(([lo, hi], i) => frames.filter((f) => (i ? f.arrival >= lo : f.arrival > lo) && f.arrival < hi));

  const solve = (k0: number) => {
    let matched = matches(segs[0]!, sorted, k0);
    let k = k0;
    const pauses: PauseSync[] = [];
    for (let i = 1; i < segs.length; i++) {
      const p = calls.pauses[i - 1]!;
      const wallMs = p.resume! - p.pause;
      const { shift, matched: m } = bestShift(segs[i]!, sorted, k + wallMs);
      k += wallMs + shift;
      matched += m;
      pauses.push({ wallMs, videoMs: wallMs + shift, framesMatched: m, frames: segs[i]!.length });
    }
    return { k0, matched, pauses };
  };

  // The file starts at the first frame the recorder's track passed on after start(): try the frames around the first to
  // arrive after the call and take the best match (the earliest after the call on a tie). The 30 fps track keeps frames
  // by a jittery interval rule, so the frames it skipped line up worse than the ones it kept.
  const first = frames.findIndex((f) => f.arrival > calls.startCall);
  if (first < 0) return null;
  const tried = [-2, -1, 0, 1, 2, 3, 4].flatMap((d) => (frames[first + d] ? [{ d, ...solve(frames[first + d]!.ts) }] : []));
  const top = Math.max(...tried.map((c) => c.matched));
  const best = tried.find((c) => c.d >= 0 && c.matched === top) ?? tried.find((c) => c.matched === top)!;
  // Every frame of the file should be found among the frames seen (the log runs at twice the video's frame rate).
  if (best.matched * 2 < pts.length) return null;
  return {
    startShiftMs: best.k0 + domain - calls.start,
    pauses: best.pauses,
    framesMatched: best.matched,
    videoFrames: pts.length,
    lag: lagSamples(frames, ticks, domain, calls.pauses.flatMap((p) => (p.resume === undefined ? [] : [p.resume]))),
  };
}

/** The clock moved to the video's own timing: t=0 at the first frame's capture, each resumed pause as long as the cut, lag. */
export function applyClockSync(clock: VideoClock, sync: ClockSync): VideoClock {
  return {
    videoStart: clock.videoStart + sync.startShiftMs,
    pauses: clock.pauses.map((p, i) => {
      const s = sync.pauses[i];
      return s && p.end !== undefined ? { start: p.start, end: p.start + s.videoMs } : { ...p };
    }),
    ...(sync.lag.length ? { lag: sync.lag } : {}),
  };
}

/** report.json `clockSync`: where t=0, the pause lengths and the content lag came from, and every correction applied. */
export type ClockSyncReport =
  | {
      source: "video-frames";
      startShiftMs: number;
      framesMatched: number;
      videoFrames: number;
      /** `framesMatched`: frames after this pause's resume found in the file, which measured the cut. */
      pauses: { n: number; wallMs: number; videoMs: number; correctionMs: number; framesMatched: number }[];
      /** Per stretch between pauses (from video time `t`): median, lowest and highest measured lag, and how many samples. */
      lag: { t: number; ms: number; minMs: number; maxMs: number; samples: number }[];
    }
  | { source: "wall-clock"; reason: string };

const r1 = (n: number) => Math.round(n * 10) / 10;

/** Apply `sync` to the clock and to the logged pause events (pausedMs becomes what the video cut, plus correctionMs). */
export function syncSessionClock(
  clock: VideoClock,
  log: EventLog,
  sync: ClockSync | null | undefined,
  reason = "no frame timing",
): { clock: VideoClock; report: ClockSyncReport } {
  if (!sync) return { clock, report: { source: "wall-clock", reason } };
  const synced = applyClockSync(clock, sync);
  const pauses = sync.pauses.slice(0, clock.pauses.length).map((p, i) => {
    const before = clock.pauses[i]!;
    const logged = before.end === undefined ? p.wallMs : before.end - before.start;
    return { n: i + 1, wallMs: r1(p.wallMs), videoMs: r1(p.videoMs), correctionMs: r1(p.videoMs - logged), framesMatched: p.framesMatched };
  });
  const events = log.actions.filter((s) => s.ev.type === "pause");
  pauses.forEach((p, i) => {
    const ev = events[i]?.ev;
    if (ev?.type === "pause") Object.assign(ev, { pausedMs: Math.round(p.videoMs), correctionMs: p.correctionMs });
  });
  // One row per stretch between pauses (countdown samples count for the stretch after their pause), as lagAt uses them.
  const lag: { t: number; ms: number; minMs: number; maxMs: number; samples: number }[] = [];
  const bare = { ...synced, lag: undefined };
  for (let k = 0; k <= synced.pauses.length; k++) {
    const inStretch = sync.lag.filter((s) => stretchOfSample(synced, s.at) === k);
    if (!inStretch.length) continue;
    const from = k === 0 ? synced.videoStart : synced.pauses[k - 1]!.end ?? synced.pauses[k - 1]!.start;
    const ms = inStretch.map((s) => s.ms).sort((a, b) => a - b);
    lag.push({ t: videoTime(bare, from).t, ms: r1(ms[ms.length >> 1]!), minMs: r1(ms[0]!), maxMs: r1(ms[ms.length - 1]!), samples: ms.length });
  }
  return {
    clock: synced,
    report: { source: "video-frames", startShiftMs: r1(sync.startShiftMs), framesMatched: sync.framesMatched, videoFrames: sync.videoFrames, pauses, lag },
  };
}
