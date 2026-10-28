/** A MediaRecorder pause, in epoch ms. `end` is missing while the recorder is still paused. */
export interface Pause {
  start: number;
  end?: number;
}

/** Content lag measured from the video: from wall-clock `at` on, a frame shows what was drawn `ms` before its capture. */
export interface LagSample {
  at: number;
  ms: number;
}

/** Maps wall-clock time to the video clock: time since the first frame, paused time excluded. */
export interface VideoClock {
  videoStart: number;
  pauses: Pause[];
  /** Set only when the report is built; in time order. */
  lag?: LagSample[];
}

// Lag at an event: the median of this many nearest samples (each is exact: the frame log sees every 60 Hz frame).
const LAG_NEAREST = 5;
// t lands this much before the frame that first shows a change drawn at the event, to absorb rAF and ms rounding.
// Measured: 8 ms keeps t between that frame and the one before it for every event (window was 2-3 ms past 6 ms).
export const LAG_MARGIN_MS = 8;
// Fewer samples than this taken after the resume, and the countdown's samples (taken just before it) count too.
const LAG_MIN_AFTER_RESUME = 3;

/** Stretch (0 = before the first pause) a lag sample belongs to: one taken during a pause (the countdown) counts for the next. */
export function stretchOfSample(clock: VideoClock, at: number): number {
  return clock.pauses.filter((p) => p.start <= at).length;
}

/**
 * Content lag at `at`: the median of the nearest samples taken in its stretch after the resume (with the countdown's when
 * there are too few; else the whole recording's), less the margin.
 */
export function lagAt(clock: VideoClock, at: number): number {
  const lag = clock.lag;
  if (!lag?.length) return 0;
  const ended = clock.pauses.filter((p) => p.end !== undefined && p.end <= at);
  const stretch = ended.length;
  const resumedAt = ended.at(-1)?.end ?? -Infinity;
  const inStretch = lag.filter((s) => stretchOfSample(clock, s.at) === stretch);
  const after = inStretch.filter((s) => s.at >= resumedAt);
  const pool = after.length >= LAG_MIN_AFTER_RESUME ? after : inStretch.length ? inStretch : lag;
  const nearest = [...pool].sort((a, b) => Math.abs(a.at - at) - Math.abs(b.at - at)).slice(0, LAG_NEAREST);
  const ms = nearest.map((s) => s.ms).sort((a, b) => a - b);
  return Math.max(0, ms[ms.length >> 1]! - LAG_MARGIN_MS);
}

/**
 * Video time of wall-clock `at`: the frame that shows the screen as it was then (content lag added, never past the next cut).
 * Inside a pause it is the pause point, flagged `duringPause`.
 */
export function videoTime(clock: VideoClock, at: number, now = Date.now()): { t: number; duringPause: boolean } {
  let paused = 0;
  for (const p of clock.pauses) {
    const end = p.end ?? Math.max(now, at);
    if (at <= p.start) {
      const t = at - clock.videoStart - paused + lagAt(clock, at);
      return { t: Math.max(0, Math.round(Math.min(t, p.start - clock.videoStart - paused))), duringPause: false };
    }
    if (at < end) {
      return { t: Math.max(0, Math.round(p.start - clock.videoStart - paused)), duringPause: true };
    }
    paused += end - p.start;
  }
  return { t: Math.max(0, Math.round(at - clock.videoStart - paused + lagAt(clock, at))), duringPause: false };
}

/** Total paused ms, counting an open pause up to `now`. */
export function pausedMs(clock: VideoClock, now = Date.now()): number {
  return clock.pauses.reduce((n, p) => n + Math.max(0, (p.end ?? now) - p.start), 0);
}

export function isPaused(clock: VideoClock): boolean {
  return clock.pauses.length > 0 && clock.pauses[clock.pauses.length - 1]!.end === undefined;
}

/** Current position on the video clock: frozen while paused. */
export function elapsedMs(clock: VideoClock, now = Date.now()): number {
  return videoTime(clock, now, now).t;
}
