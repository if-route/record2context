import { describe, expect, it } from "vitest";
import { elapsedMs, isPaused, pausedMs, videoTime, type VideoClock } from "../src/shared/clock";
import { appendEvent, emptyLog, orderedEvents, toRecEvent } from "../src/shared/event-log";
import type { RawEvent, RecEvent } from "../src/shared/types";

const VIDEO_START = 1_700_000_000_000;
const plain: VideoClock = { videoStart: VIDEO_START, pauses: [] };
/** Paused 2 s at video 1 s, then 3 s at video 4 s (wall 7 s .. 10 s). */
const paused: VideoClock = {
  videoStart: VIDEO_START,
  pauses: [
    { start: VIDEO_START + 1000, end: VIDEO_START + 3000 },
    { start: VIDEO_START + 6000, end: VIDEO_START + 9000 },
  ],
};

const click = (at: number, label = "Save"): RawEvent => ({
  type: "click",
  at,
  path: "/home",
  label,
  labelSource: "innerText",
  tag: "button",
  selector: "#save",
  bbox: { x: 1, y: 2, width: 3, height: 4 },
  point: { x: 2, y: 3 },
  viewport: { width: 1280, height: 800, dpr: 2, scrollX: 0, scrollY: 0 },
});
const net = (at: number, url = "https://api.test/x"): RawEvent => ({
  type: "network",
  at,
  path: "/home",
  method: "GET",
  url,
  status: 200,
  durationMs: 5,
  source: "fetch",
});

describe("videoTime", () => {
  it("is wall time since the first frame when nothing paused", () => {
    expect(videoTime(plain, VIDEO_START + 1234.6)).toEqual({ t: 1235, duringPause: false });
    expect(videoTime(plain, VIDEO_START - 50).t).toBe(0);
  });

  it("leaves paused time out after each pause", () => {
    expect(videoTime(paused, VIDEO_START + 500)).toEqual({ t: 500, duringPause: false });
    expect(videoTime(paused, VIDEO_START + 3500)).toEqual({ t: 1500, duringPause: false });
    expect(videoTime(paused, VIDEO_START + 9500)).toEqual({ t: 4500, duringPause: false });
  });

  it("puts events inside a pause at the pause point, flagged", () => {
    expect(videoTime(paused, VIDEO_START + 2000)).toEqual({ t: 1000, duringPause: true });
    expect(videoTime(paused, VIDEO_START + 8999)).toEqual({ t: 4000, duringPause: true });
  });

  it("treats the pause start itself as the pause point, not inside it", () => {
    expect(videoTime(paused, VIDEO_START + 1000)).toEqual({ t: 1000, duringPause: false });
    expect(videoTime(paused, VIDEO_START + 3000)).toEqual({ t: 1000, duringPause: false });
  });

  it("freezes while a pause is still open", () => {
    const open: VideoClock = { videoStart: VIDEO_START, pauses: [{ start: VIDEO_START + 1000 }] };
    expect(isPaused(open)).toBe(true);
    expect(isPaused(paused)).toBe(false);
    expect(elapsedMs(open, VIDEO_START + 5000)).toBe(1000);
    expect(videoTime(open, VIDEO_START + 4000, VIDEO_START + 5000)).toEqual({ t: 1000, duringPause: true });
    expect(pausedMs(open, VIDEO_START + 5000)).toBe(4000);
    expect(pausedMs(paused)).toBe(5000);
  });
});

describe("toRecEvent", () => {
  it("drops `at` and sets duringPause only when true", () => {
    const ev = toRecEvent(click(VIDEO_START + 2000), paused);
    expect(ev).toMatchObject({ t: 1000, duringPause: true });
    expect(ev).not.toHaveProperty("at");
    expect(toRecEvent(click(VIDEO_START + 500), paused)).not.toHaveProperty("duringPause");
  });
});

describe("appendEvent", () => {
  it("never evicts user actions, however much network traffic arrives", () => {
    const log = emptyLog();
    appendEvent(log, click(VIDEO_START + 1, "first"), 10);
    for (let i = 0; i < 500; i++) appendEvent(log, net(VIDEO_START + 2 + i), 10);
    appendEvent(log, click(VIDEO_START + 900, "last"), 10);

    const events = orderedEvents(log, plain);
    const clicks = events.filter((e) => e.type === "click").map((e) => (e as { label: string }).label);
    expect(clicks).toEqual(["first", "last"]);
    expect(log.network).toHaveLength(10);
    expect(log.networkDropped).toBe(490);
    // The newest network rows are the ones kept.
    expect(events.filter((e) => e.type === "network").map((e) => e.t)[0]).toBe(492);
  });

  it("orders by time, ties by arrival", () => {
    const log = emptyLog();
    appendEvent(log, click(VIDEO_START + 300, "b"));
    appendEvent(log, net(VIDEO_START + 100)); // network arrives late but started earlier
    appendEvent(log, click(VIDEO_START + 300, "c"));
    appendEvent(log, click(VIDEO_START + 50, "a"));
    const order = orderedEvents(log, plain).map((e: RecEvent) => (e.type === "click" ? e.label : `net@${e.t}`));
    expect(order).toEqual(["a", "net@100", "b", "c"]);
  });

  it("keeps the real order of events inside a pause, which all share the pause point", () => {
    const log = emptyLog();
    appendEvent(log, net(VIDEO_START + 2500, "https://api.test/second"));
    appendEvent(log, net(VIDEO_START + 1500, "https://api.test/first"));
    appendEvent(log, click(VIDEO_START + 3500, "after"));
    const rows = orderedEvents(log, paused).map((e) => [e.type === "network" ? e.url : "click", e.t, !!e.duringPause]);
    expect(rows).toEqual([
      ["https://api.test/first", 1000, true],
      ["https://api.test/second", 1000, true],
      ["click", 1500, false],
    ]);
  });
});
