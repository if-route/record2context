import { pausedMs, videoTime, type VideoClock } from "./clock";
import type { ClockSyncReport } from "./clock-sync";
import { dedupeNetwork } from "./network-dedupe";
import { orderedEvents, type EventLog } from "./event-log";
import { PRIVATE_DIR } from "./layout";
import type { StorageSnapshot } from "./storage-snapshot";
import { maskEmailInput, scrubEmailsDeep } from "./redact";
import { SCHEMA_VERSION, type NetworkEvent, type RecEvent, type SessionEnv, type VideoInfo } from "./types";

export type StopReason = "user" | "tab-closed" | "capture-ended";

export interface ReportInput {
  version: string;
  /** First video frame and every pause; every event `t` is on this clock. Open pauses must be closed at `stoppedAt`. */
  clock: VideoClock;
  stoppedAt: number;
  stopReason: StopReason;
  startUrl: string;
  env: SessionEnv;
  video: VideoInfo | null;
  videoError?: string;
  log: EventLog;
  clockSync?: ClockSyncReport;
  storage?: StorageSnapshot[];
  /** Body files written to the private folder; network events keep `bodyId` only for these. */
  bodies?: BodyStats;
}

export interface BodyStats {
  saved: string[];
  bytes: number;
  /** Bodies not kept, counted by reason. */
  skipped: Record<string, number>;
}

export const TIMELINE_DOC = {
  t:
    "Milliseconds on the video clock: since the first frame, with paused time left out (the video has no frames for it). " +
    "t=0 and each pause length are measured from the video's own frames (clockSync). " +
    "Frame at an event: ffmpeg -ss <t/1000> -i <video.file> -frames:v 1 out.png",
  pauses:
    "Each Screenshot (a mark) paused the video; a mark event holds the tester's note and a pause event how long it lasted. " +
    "Events with duringPause: true happened during a pause; their t is the pause point.",
  coordinates:
    "bbox and point are CSS px relative to the top-level viewport at event time (event.viewport). " +
    "Video px = offset + css * scale, scale = min(video.width / viewport.width, video.height / viewport.height), " +
    "offset = ((video.width - viewport.width * scale) / 2, (video.height - viewport.height * scale) / 2). " +
    "Screenshot px = css * (imageWidth / viewport.width) (normally the device pixel ratio).",
  path: "location.pathname + search + hash when the event happened. Sensitive query values and email addresses are redacted.",
  network: "Request start time is t. Only method, URL, status and duration are kept here, never bodies. bodyId names the file with its bodies in privateData.dir/bodies/ (local only, never shared).",
  storage:
    "localStorage, sessionStorage and cookie names at Start, each Screenshot (mark) and Stop. Values are redacted (sensitive key names, tokens, " +
    "random-looking strings, emails) and shortened; cookie values are never read. The unredacted values are in privateFile (local only).",
  annotations:
    "Shapes drawn on a screenshot, numbered like the badges in the image. geometry.image is PNG px, geometry.css is page CSS px " +
    "at capture. element: what was under a box's centre or an arrow's tip on the live page when the shape was drawn.",
} as const;

export function buildReport(input: ReportInput) {
  return scrubEmailsDeep(assemble(input));
}

function assemble(input: ReportInput) {
  const saved = new Set(input.bodies?.saved ?? []);
  const all = orderedEvents(input.log, input.clock, input.stoppedAt)
    .map(maskEmailInput)
    .map((e) => (e.type === "network" && e.bodyId && !saved.has(e.bodyId) ? (({ bodyId: _drop, ...rest }) => rest)(e) : e)) as RecEvent[];
  const network = dedupeNetwork(all.filter((e): e is NetworkEvent => e.type === "network"));
  const keep = new Set<RecEvent>(network);
  const events = all.filter((e) => e.type !== "network" || keep.has(e));

  const byType: Record<string, number> = {};
  for (const e of events) byType[e.type] = (byType[e.type] ?? 0) + 1;

  return {
    schemaVersion: SCHEMA_VERSION,
    generator: { name: "record2context", version: input.version },
    startedAt: new Date(input.clock.videoStart).toISOString(),
    durationMs: input.video?.durationMs || Math.max(0, input.stoppedAt - input.clock.videoStart - pausedMs(input.clock, input.stoppedAt)),
    // The sum of the pause events below, so the report adds up (each pause is rounded to whole ms).
    pausedMs: events.reduce((n, e) => n + (e.type === "pause" ? e.pausedMs : 0), 0),
    stopReason: input.stopReason,
    startUrl: input.startUrl,
    browser: {
      userAgent: input.env.userAgent,
      os: input.env.os,
      arch: input.env.arch,
      ...(input.env.language ? { language: input.env.language, languages: input.env.languages ?? [] } : {}),
      ...(input.env.locale ? { locale: input.env.locale } : {}),
      ...(input.env.timeZone ? { timeZone: input.env.timeZone } : {}),
      ...(input.env.utcOffsetMinutes !== undefined ? { utcOffsetMinutes: input.env.utcOffsetMinutes } : {}),
    },
    viewport: input.env.viewport,
    devicePixelRatio: input.env.dpr,
    video: input.video,
    ...(input.videoError ? { videoError: input.videoError } : {}),
    timeline: TIMELINE_DOC,
    counts: { events: events.length, byType, networkDropped: input.log.networkDropped },
    screenshots: events.flatMap((e) =>
      e.type === "screenshot"
        ? [{ file: e.file, t: e.t, ...(e.annotatedFile ? { annotatedFile: e.annotatedFile } : {}), ...(e.mark ? { mark: e.mark } : {}), ...(e.annotations?.length ? { annotations: e.annotations } : {}) }]
        : [],
    ),
    marks: events.flatMap((e) =>
      e.type === "mark"
        ? [{ n: e.n, t: e.t, note: e.note, ...(e.screenshot ? { screenshot: e.screenshot } : {}), ...(e.annotatedScreenshot ? { annotatedScreenshot: e.annotatedScreenshot } : {}) }]
        : [],
    ),
    pauses: events.flatMap((e) => (e.type === "pause" ? [{ t: e.t, pausedMs: e.pausedMs, ...(e.correctionMs !== undefined ? { correctionMs: e.correctionMs } : {}) }] : [])),
    clockSync: input.clockSync ?? { source: "wall-clock", reason: "not measured" },
    storage: (input.storage ?? []).map(({ at, ...snap }) => ({ ...snap, t: videoTime(input.clock, at, input.stoppedAt).t })),
    privateData: {
      dir: PRIVATE_DIR,
      note: "Raw data for local use only (unredacted storage, request/response bodies). Never part of this report, context.md or the portable context.",
      storageFiles: (input.storage ?? []).flatMap((s) => (s.privateFile ? [s.privateFile] : [])),
      bodies: { saved: saved.size, bytes: input.bodies?.bytes ?? 0, skipped: input.bodies?.skipped ?? {} },
    },
    events,
  };
}

/** Email addresses are replaced everywhere except the tester's Mark and shape notes (`scrubEmailsDeep`). */
export type Report = ReturnType<typeof assemble>;
