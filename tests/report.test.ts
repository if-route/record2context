import { describe, expect, it } from "vitest";
import { appendEvent, emptyLog } from "../src/shared/event-log";
import { closePause, openPause, setMarkNote, type MarkState } from "../src/shared/marks";
import { dedupeNetwork } from "../src/shared/network-dedupe";
import { pngSize, safeHost, sessionId, videoFile } from "../src/shared/paths";
import { markFile, markOriginalFile } from "../src/shared/layout";
import { redactUrl, scrubSecrets } from "../src/shared/redact";
import { buildReport, TIMELINE_DOC } from "../src/shared/report";
import type { RawEvent, VideoInfo } from "../src/shared/types";

const VIDEO_START = Date.UTC(2026, 9, 21, 7, 30, 5);
const env = { userAgent: "UA", os: "mac", arch: "arm64", viewport: { width: 1280, height: 800 }, dpr: 2 };
const video: VideoInfo = {
  file: "video.webm",
  mimeType: "video/webm",
  width: 2560,
  height: 1600,
  durationMs: 12_345,
  sizeBytes: 999,
  seekableFix: true,
};

function logOf(raws: RawEvent[]) {
  const log = emptyLog();
  for (const r of raws) appendEvent(log, r);
  return log;
}

describe("buildReport", () => {
  const raws: RawEvent[] = [
    { type: "page_load", at: VIDEO_START + 10, path: "/home", navigationType: "navigate", initial: true, url: "https://x.test/home", title: "Home" },
    { type: "network", at: VIDEO_START + 600, path: "/home", method: "POST", url: "https://api.test/rpc/a", status: 200, durationMs: 40, source: "fetch" },
    { type: "network", at: VIDEO_START + 620, path: "/home", method: "", url: "https://api.test/rpc/a", status: 0, durationMs: 41, source: "resource-timing" },
    { type: "network", at: VIDEO_START + 5000, path: "/home", method: "", url: "https://cdn.test/cached", status: 0, durationMs: 9, source: "resource-timing" },
    { type: "page_load", at: VIDEO_START + 4000, path: "/home", navigationType: "reload", initial: false, url: "https://x.test/home", title: "Home" },
    { type: "screenshot", at: VIDEO_START + 3000, path: "/home", file: "screenshots/01.png", viewport: { width: 1280, height: 800, dpr: 2, scrollX: 0, scrollY: 0 }, imageWidth: 2560, imageHeight: 1600, annotated: true },
  ];
  const report = buildReport({
    version: "0.1.0",
    clock: { videoStart: VIDEO_START, pauses: [] },
    stoppedAt: VIDEO_START + 12_400,
    stopReason: "user",
    startUrl: "https://x.test/home",
    env,
    video,
    log: logOf(raws),
  });

  it("carries the session header an AI needs", () => {
    expect(report).toMatchObject({
      schemaVersion: 5,
      startedAt: "2026-10-21T07:30:05.000Z",
      durationMs: 12_345,
      startUrl: "https://x.test/home",
      browser: { userAgent: "UA", os: "mac", arch: "arm64" },
      viewport: { width: 1280, height: 800 },
      devicePixelRatio: 2,
      video: { file: "video.webm", width: 2560, height: 1600 },
      timeline: TIMELINE_DOC,
    });
  });

  it("orders events by t and keeps the reload", () => {
    expect(report.events.map((e) => e.t)).toEqual([10, 600, 3000, 4000, 5000]);
    expect(report.events.find((e) => e.type === "page_load" && e.navigationType === "reload")).toBeTruthy();
  });

  it("drops the resource-timing duplicate of a wrapped fetch but keeps unmatched ones", () => {
    const net = report.events.filter((e) => e.type === "network");
    expect(net.map((e) => (e.type === "network" ? e.source : ""))).toEqual(["fetch", "resource-timing"]);
  });

  it("indexes screenshots and counts types", () => {
    expect(report.screenshots).toEqual([{ file: "screenshots/01.png", t: 3000 }]);
    expect(report.marks).toEqual([]);
    expect(report.pauses).toEqual([]);
    expect(report.counts).toEqual({ events: 5, byType: { page_load: 2, network: 2, screenshot: 1 }, networkDropped: 0 });
  });

  it("falls back to wall-clock duration and records why the video is missing", () => {
    const r = buildReport({
      version: "0.1.0",
      clock: { videoStart: VIDEO_START, pauses: [] },
      stoppedAt: VIDEO_START + 7000,
      stopReason: "tab-closed",
      startUrl: "https://x.test/",
      env,
      video: null,
      videoError: "recording is empty",
      log: emptyLog(),
    });
    expect(r).toMatchObject({ durationMs: 7000, video: null, videoError: "recording is empty", stopReason: "tab-closed", events: [] });
  });

  it("logs each Mark as a mark and a pause at the pause point, and leaves paused time out of the duration", () => {
    const s: MarkState = { pauses: [], marks: 0, log: emptyLog() };
    appendEvent(s.log, { type: "network", at: VIDEO_START + 500, path: "/a", method: "GET", url: "https://api.test/before", status: 200, durationMs: 5, source: "fetch" });
    openPause(s, VIDEO_START + 1000, "/a");
    appendEvent(s.log, { type: "network", at: VIDEO_START + 1800, path: "/a", method: "GET", url: "https://api.test/during", status: 500, durationMs: 5, source: "fetch" });
    setMarkNote(s, "ปุ่มบันทึกไม่ทำงาน Bearer abcdefghijklmnop");
    closePause(s, VIDEO_START + 4000);
    openPause(s, VIDEO_START + 5000, "/b");
    // Stopped while still paused: the stop closes the second pause, note left empty.
    const stoppedAt = VIDEO_START + 7000;
    closePause(s, stoppedAt);
    const r = buildReport({ version: "0.2.0", clock: { videoStart: VIDEO_START, pauses: s.pauses }, stoppedAt, stopReason: "user", startUrl: "https://x.test/", env, video: null, log: s.log });

    expect(r.marks).toEqual([
      { n: 1, t: 1000, note: "ปุ่มบันทึกไม่ทำงาน Bearer [REDACTED]" },
      { n: 2, t: 2000, note: "" },
    ]);
    expect(r.pauses).toEqual([
      { t: 1000, pausedMs: 3000 },
      { t: 2000, pausedMs: 2000 },
    ]);
    expect(r.pausedMs).toBe(5000);
    expect(r.durationMs).toBe(2000);
    const during = r.events.find((e) => e.type === "network" && e.url.endsWith("/during"));
    expect(during).toMatchObject({ t: 1000, duringPause: true });
    expect(r.events.find((e) => e.type === "mark")).not.toHaveProperty("duringPause");
    expect(r.events.map((e) => e.type)).toEqual(["network", "mark", "pause", "network", "mark", "pause"]);
  });

  it("does nothing when closing without an open pause", () => {
    const s: MarkState = { pauses: [], marks: 0, log: emptyLog() };
    closePause(s, VIDEO_START);
    openPause(s, VIDEO_START + 10, "/");
    openPause(s, VIDEO_START + 20, "/"); // a second press while paused
    expect(s.pauses).toEqual([{ start: VIDEO_START + 10 }]);
    expect(s.log.actions).toHaveLength(0);
  });

  it("is plain JSON", () => {
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });
});

describe("dedupeNetwork", () => {
  it("pairs one timing row per wrapper row, so polling keeps every request", () => {
    const rows = [
      { url: "https://a/p", t: 0, source: "fetch" as const },
      { url: "https://a/p", t: 1000, source: "fetch" as const },
      { url: "https://a/p", t: 3, source: "resource-timing" as const },
      { url: "https://a/p", t: 1004, source: "resource-timing" as const },
      { url: "https://a/p", t: 2000, source: "resource-timing" as const },
    ];
    expect(dedupeNetwork(rows).map((r) => `${r.source}@${r.t}`)).toEqual(["fetch@0", "fetch@1000", "resource-timing@2000"]);
  });
});

describe("paths and redaction", () => {
  it("names the session (and its folder) by local time and host", () => {
    const d = new Date(2026, 9, 21, 9, 5, 7);
    expect(sessionId(d, "https://preview--my-app.example.app/home")).toBe("2026-10-21_090507_preview--my-app-example-app");
    expect(sessionId(d, "http://localhost:8080/x")).toBe("2026-10-21_090507_localhost_8080");
    expect(sessionId(d, "http://127.0.0.1:8080/x")).toBe("2026-10-21_090507_127-0-0-1_8080");
    expect(sessionId(d, "file:///tmp/a.html")).toBe("2026-10-21_090507_file");
    expect(sessionId(d, "not a url")).toBe("2026-10-21_090507_page");
    expect(markFile(3)).toBe("screenshot-03.png");
    expect(markOriginalFile(3)).toBe("details/screenshots/screenshot-03-original.png");
  });

  it("reads a PNG's size from its header", () => {
    const head = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0x0a, 0x00, 0, 0, 0x06, 0x40]);
    expect(pngSize(head)).toEqual({ width: 2560, height: 1600 });
    expect(pngSize(new Uint8Array(24))).toBeNull();
  });

  it("never ends the folder in an extension-like suffix (macOS treats `<name>.app` as an app bundle)", () => {
    const d = new Date(2026, 9, 25, 19, 2, 23);
    for (const host of ["my-app.example.app", "x.bundle", "a.pkg", "b.framework", "example.com", "[::1]:3001"]) {
      const id = sessionId(d, `https://${host}/`);
      expect(id).toMatch(/^2026-10-25_190223_[a-zA-Z0-9_-]+$/);
      expect(videoFile(id)).toBe(`${id}.webm`);
    }
    expect(safeHost("[::1]:3001")).toBe("-__1-_3001");
  });

  it("redacts sensitive query values only", () => {
    expect(redactUrl("https://a/x?id=5&access_token=abc&q=hi#h")).toBe("https://a/x?id=5&access_token=[REDACTED]&q=hi#h");
  });

  it("scrubs tokens from messages", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abcdefghij";
    expect(scrubSecrets(`bad ${jwt} and Bearer abcdefghijkl`)).toBe("bad [REDACTED_JWT] and Bearer [REDACTED]");
  });
});
