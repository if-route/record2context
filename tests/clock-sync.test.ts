import { describe, expect, it } from "vitest";
import { LAG_MARGIN_MS, lagAt, stretchOfSample, videoTime, type VideoClock } from "../src/shared/clock";
import { applyClockSync, lagSamples, syncClock, syncSessionClock, type FrameSeen, type HudTick, type RecorderCalls } from "../src/shared/clock-sync";
import { appendEvent, emptyLog } from "../src/shared/event-log";

// Frame timestamps live on a monotonic clock; arrival (epoch ms) = ts + DOMAIN + delivery delay.
const DOMAIN = 1_790_000_000_000;
const DELAY = 2;
const FRAME = 1000 / 30;

/**
 * A recording as Chrome makes it: the recorder starts right after frame `startIndex` arrives, so the next frame is pts 0;
 * frames arriving while paused are left out; pts = ts - firstTs - cut so far, rounded to ms like WebM.
 */
function record(ts: number[], startIndex: number, pausesAt: { from: number; to: number; extraCutMs?: number }[], recorded = (_i: number) => true) {
  const frames: FrameSeen[] = ts.map((t) => ({ ts: t, arrival: t + DOMAIN + DELAY }));
  const startCall = frames[startIndex]!.arrival;
  const calls: RecorderCalls = {
    startCall,
    start: startCall + 20,
    pauses: pausesAt.map((p) => ({ pause: frames[p.from]!.arrival + 5, resume: frames[p.to]!.arrival - 5 })),
  };
  const first = ts.findIndex((_, i) => i > startIndex && recorded(i));
  const k0 = ts[first]!;
  const pts: number[] = [];
  frames.forEach((f, i) => {
    if (i < first || !recorded(i)) return;
    let cut = 0;
    for (const [n, p] of calls.pauses.entries()) {
      if (f.arrival >= p.pause && f.arrival < p.resume!) return;
      if (f.arrival >= p.resume!) cut += p.resume! - p.pause + (pausesAt[n]!.extraCutMs ?? 0);
    }
    pts.push(Math.round(f.ts - k0 - cut));
  });
  return { frames, calls, pts, k0 };
}

const steady = (n: number, from = 5000) => Array.from({ length: n }, (_, i) => from + i * FRAME);

describe("syncClock", () => {
  it("finds t=0 at the first frame after start() and each pause's cut on a steady 30 fps page", () => {
    const { frames, calls, pts } = record(steady(400), 10, [
      { from: 100, to: 160 },
      { from: 250, to: 300, extraCutMs: 0.6 },
    ]);
    const sync = syncClock(frames, calls, pts)!;
    // pts 0 is frame 11, captured one frame after frame 10, which arrived at startCall; the start event came 20 ms later.
    expect(sync.startShiftMs).toBeCloseTo(FRAME - 20, 2);
    expect(sync.pauses).toHaveLength(2);
    const [p1, p2] = sync.pauses;
    expect(p1!.videoMs - p1!.wallMs).toBeCloseTo(0, 0);
    expect(Math.abs(p2!.videoMs - p2!.wallMs - 0.6)).toBeLessThanOrEqual(0.5);
    expect(sync.framesMatched).toBe(sync.videoFrames);
  });

  it("picks the right first frame when the log runs at 60 fps and the recorder's track keeps about every other frame", () => {
    // Real capture timestamps jitter by a fraction of a ms; the track keeps a frame once >= 32 ms passed since the last kept.
    const ts = Array.from({ length: 600 }, (_, i) => 5000 + (i * 1000) / 60 + ((i * 7919) % 13) / 10);
    const kept = new Set<number>();
    let last = -Infinity;
    ts.forEach((t, i) => {
      if (t - last >= 32) {
        kept.add(i);
        last = t;
      }
    });
    // Start right after a kept frame, so the first frame to arrive after start() is one the 30 fps track skips.
    const startIndex = [...kept].find((i) => i > 10)!;
    const firstKept = [...kept].find((i) => i > startIndex)!;
    expect(firstKept).toBe(startIndex + 2);
    const { frames, calls, pts } = record(ts, startIndex, [{ from: 200, to: 320 }], (i) => kept.has(i));
    const sync = syncClock(frames, calls, pts)!;
    expect(sync.startShiftMs).toBeCloseTo(ts[firstKept]! - ts[startIndex]! - 20, 2);
    expect(sync.framesMatched).toBe(sync.videoFrames);
    expect(Math.abs(sync.pauses[0]!.videoMs - sync.pauses[0]!.wallMs)).toBeLessThanOrEqual(0.5);
  });

  it("works on a static page whose frames come only on change", () => {
    const ts = [5000, 5410, 5440, 6120, 6900, 7333, 7366, 8200, 9050, 9800, 10400, 11000, 11033, 12700];
    const { frames, calls, pts } = record(ts, 1, [{ from: 6, to: 8 }]);
    const sync = syncClock(frames, calls, pts)!;
    expect(sync.startShiftMs).toBeCloseTo(30 - 20, 2);
    expect(Math.abs(sync.pauses[0]!.videoMs - sync.pauses[0]!.wallMs)).toBeLessThanOrEqual(0.5);
  });

  it("gives up when the file's frames do not line up with the frames seen", () => {
    const { frames, calls } = record(steady(100), 3, []);
    expect(syncClock(frames, calls, [0, 7, 19, 51, 77, 123])).toBeNull();
    expect(syncClock([], calls, [0, 33])).toBeNull();
  });
});

describe("lagSamples", () => {
  // The HUD spot: sum 100 until the change drawn at `at` reaches the video `lag` ms later (on the capture clock).
  function hud(at: number, lag: number) {
    const frames: FrameSeen[] = steady(60, at - 1000).map((ts) => ({ ts: ts - DOMAIN, arrival: ts + DELAY, spot: "a", sum: ts >= at + lag ? 200 : 100 }));
    return frames;
  }

  it("measures the time from a drawn change to the first frame that shows it", () => {
    const at = DOMAIN + 50_000;
    const frames = hud(at, 35);
    const [s] = lagSamples(frames, [{ at, spot: "a" }], DOMAIN);
    // The first frame at or after at + 35 on a 33.3 ms grid.
    const first = frames.find((f) => f.sum === 200)!;
    expect(s!.ms).toBeCloseTo(first.ts + DOMAIN - at, 2);
    expect(s!.ms).toBeGreaterThanOrEqual(35);
    expect(s!.ms).toBeLessThan(35 + FRAME);
  });

  it("skips a change too soon after the previous one at the same spot, and frames from before the last resume", () => {
    const at = DOMAIN + 50_000;
    const frames = hud(at, 35);
    const ticks: HudTick[] = [
      { at: at - 100, spot: "a" },
      { at, spot: "a" },
    ];
    expect(lagSamples(frames, ticks, DOMAIN).map((s) => s.at)).not.toContain(at);
    expect(lagSamples(frames, [{ at, spot: "a" }], DOMAIN, [at - 1])).toEqual([]);
  });
});

describe("lag on the video clock", () => {
  const clock: VideoClock = {
    videoStart: 1000,
    pauses: [{ start: 5000, end: 9000 }],
    lag: [
      { at: 2000, ms: 20 },
      { at: 3000, ms: 36.7 },
      { at: 4000, ms: 20.4 },
      // Taken during the pause (the countdown): they count for the stretch after it.
      { at: 8000, ms: 2 },
      { at: 8250, ms: 2.4 },
      // After the resume the pipeline is one step deeper.
      { at: 9300, ms: 35 },
      { at: 9550, ms: 35.4 },
      { at: 9800, ms: 34.8 },
    ],
  };

  it("assigns countdown samples to the stretch after their pause", () => {
    expect(clock.lag!.map((s) => stretchOfSample(clock, s.at))).toEqual([0, 0, 0, 1, 1, 1, 1, 1]);
  });

  it("uses the median of the nearest samples, preferring those taken after the resume, less the margin", () => {
    expect(lagAt(clock, 3500)).toBeCloseTo(20.4 - LAG_MARGIN_MS, 5);
    expect(lagAt(clock, 9100)).toBeCloseTo(35 - LAG_MARGIN_MS, 5);
    // Too few samples after the resume: the countdown's count too.
    const early = { ...clock, lag: clock.lag!.slice(0, 6) };
    expect(lagAt(early, 9100)).toBeCloseTo(2.4 - LAG_MARGIN_MS > 0 ? 2.4 - LAG_MARGIN_MS : 0, 5);
    expect(lagAt({ ...clock, lag: [] }, 3500)).toBe(0);
  });

  it("adds the lag to t but never past the next cut; events inside a pause stay at the pause point", () => {
    expect(videoTime(clock, 3500).t).toBe(Math.round(2500 + 20.4 - LAG_MARGIN_MS));
    expect(videoTime(clock, 4995).t).toBe(4000);
    expect(videoTime(clock, 6000)).toEqual({ t: 4000, duringPause: true });
    expect(videoTime(clock, 9500).t).toBe(Math.round(4500 + 35 - LAG_MARGIN_MS));
  });
});

describe("applying the sync", () => {
  const sync = {
    startShiftMs: -30.4,
    pauses: [{ wallMs: 4000.2, videoMs: 4000.9, framesMatched: 40, frames: 41 }],
    framesMatched: 100,
    videoFrames: 100,
    lag: [{ at: 2000, ms: 18 }],
  };

  it("moves t=0 and each resumed pause, and leaves an open pause alone", () => {
    const c = applyClockSync({ videoStart: 1000, pauses: [{ start: 5000, end: 9000 }, { start: 12000 }] }, sync);
    expect(c.videoStart).toBeCloseTo(969.6, 5);
    expect(c.pauses).toEqual([{ start: 5000, end: 9000.9 }, { start: 12000 }]);
    expect(c.lag).toEqual(sync.lag);
  });

  it("rewrites the logged pause to what the video cut and reports every correction", () => {
    const log = emptyLog();
    appendEvent(log, { type: "mark", at: 5000, path: "/", n: 1, note: "" });
    appendEvent(log, { type: "pause", at: 5000, path: "/", pausedMs: 4000 });
    const { clock, report } = syncSessionClock({ videoStart: 1000, pauses: [{ start: 5000, end: 9000 }] }, log, sync);
    expect(log.actions[1]!.ev).toMatchObject({ type: "pause", pausedMs: 4001, correctionMs: 0.9 });
    expect(report).toEqual({
      source: "video-frames",
      startShiftMs: -30.4,
      framesMatched: 100,
      videoFrames: 100,
      pauses: [{ n: 1, wallMs: 4000.2, videoMs: 4000.9, correctionMs: 0.9, framesMatched: 40 }],
      // One row per stretch, from the stretch's start.
      lag: [{ t: 0, ms: 18, minMs: 18, maxMs: 18, samples: 1 }],
    });
    expect(clock.pauses[0]!.end).toBeCloseTo(9000.9, 5);
  });

  it("falls back to the wall clock with the reason when there is no sync", () => {
    const clock = { videoStart: 1000, pauses: [] };
    expect(syncSessionClock(clock, emptyLog(), null, "MediaStreamTrackProcessor unavailable")).toEqual({
      clock,
      report: { source: "wall-clock", reason: "MediaStreamTrackProcessor unavailable" },
    });
  });
});
