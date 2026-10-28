import { describe, expect, it } from "vitest";
import { fmtVideoTime } from "../src/shared/format";
import { buildMarkers, eventLabel, isNetworkError, markerKind, nearestRow, timeToPercent } from "../src/shared/timeline";
import type { NetworkEvent, RecEvent } from "../src/shared/types";

const vp = { width: 1280, height: 800, dpr: 1, scrollX: 0, scrollY: 0 };
const API = "https://api.example.test/rest";

const EVENTS: RecEvent[] = [
  { type: "page_load", t: 50, path: "/home", navigationType: "navigate", initial: true, url: "https://app.example.test/home", title: "Home" },
  { type: "network", t: 300, path: "/home", method: "GET", url: "https://app.example.test/main.js", status: 200, durationMs: 20, source: "resource-timing" },
  { type: "click", t: 1000, path: "/home", label: "Markets", labelSource: "innerText", tag: "div", role: "menuitem", selector: "li > div.menu", bbox: { x: 0, y: 0, width: 10, height: 10 }, point: { x: 5, y: 5 }, viewport: vp },
  { type: "click", t: 2000, path: "/home", label: "Carbon", labelSource: "innerText", tag: "a", selector: "li > a", bbox: { x: 0, y: 0, width: 10, height: 10 }, point: { x: 5, y: 5 }, viewport: vp, href: "https://app.example.test/markets/carbon?token=abc123" },
  { type: "route_change", t: 2001, path: "/markets/carbon", from: "/home", to: "/markets/carbon", via: "pushState" },
  { type: "network", t: 2300, path: "/markets/carbon", method: "GET", url: `${API}/curves?date=2026-10-21&api_key=SECRET1`, status: 200, durationMs: 400, source: "xhr" },
  { type: "input", t: 5000, path: "/markets/carbon", selector: "#password", label: "Password", tag: "input", inputType: "password", value: "[MASKED]", valueLength: 9, masked: true, truncated: false },
  { type: "network", t: 6997, path: "/markets/carbon", method: "POST", url: `${API}/rpc/set_commentaries`, status: 200, durationMs: 500, source: "xhr" },
  { type: "click", t: 7000, path: "/markets/carbon", label: "End of day", labelSource: "innerText", tag: "h2", testId: "eod-panel", selector: "h2.title", bbox: { x: 0, y: 0, width: 10, height: 10 }, point: { x: 5, y: 5 }, viewport: vp },
  { type: "network", t: 7400, path: "/markets/carbon", method: "GET", url: `${API}/broken`, status: 500, durationMs: 90, source: "fetch" },
  { type: "console_error", t: 7450, path: "/markets/carbon", source: "console.error", message: "Request failed Bearer abcdefghijklmnop1234 eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefg" },
  { type: "screenshot", t: 9000, path: "/markets/carbon", file: "screenshots/01.png", viewport: vp, imageWidth: 1280, imageHeight: 800, annotated: true },
  { type: "mark", t: 9500, path: "/markets/carbon", n: 1, note: "Total is wrong\nshould be 42", screenshot: "screenshots/02.png" },
  { type: "screenshot", t: 9500, path: "/markets/carbon", file: "screenshots/02.png", viewport: vp, imageWidth: 1280, imageHeight: 800, annotated: false, mark: 1 },
  { type: "pause", t: 9500, path: "/markets/carbon", pausedMs: 4200 },
  { type: "page_load", t: 10_000, path: "/markets/carbon", navigationType: "reload", initial: false, url: "https://app.example.test/markets/carbon", title: "Carbon" },
];


const net = (status: number, source: NetworkEvent["source"], error?: string): NetworkEvent => ({
  type: "network",
  t: 0,
  path: "/",
  method: "GET",
  url: "https://x.test/a",
  status,
  durationMs: 1,
  source,
  ...(error ? { error } : {}),
});

describe("markers from report.json", () => {
  it("maps every event type to its marker kind and skips successful network rows", () => {
    expect(buildMarkers(EVENTS).map((m) => [m.t, m.kind])).toEqual([
      [50, "nav"],
      [1000, "click"],
      [2000, "click"],
      [2001, "nav"],
      [5000, "input"],
      [7000, "click"],
      [7400, "net-error"],
      [7450, "console-error"],
      [9000, "screenshot"],
      [9500, "mark"],
      [10_000, "nav"],
    ]);
  });

  it("a Mark's own screenshot has no marker of its own (it would cover the mark's)", () => {
    const shot = EVENTS.find((e) => e.type === "screenshot" && e.mark === 1)!;
    expect(markerKind(shot)).toBeNull();
    expect(eventLabel(shot)).toBe("Screenshot 1 screenshots/02.png");
  });

  it("keeps the event index so a marker can open its row", () => {
    const m = buildMarkers(EVENTS).find((x) => x.kind === "net-error")!;
    expect(EVENTS[m.index]).toMatchObject({ type: "network", status: 500 });
  });

  it("labels clicks by their on-screen name and never shows a masked value", () => {
    const labels = buildMarkers(EVENTS).map((m) => m.label);
    expect(labels).toContain('Click "Markets"');
    expect(labels.find((l) => l.startsWith("Type in"))).toBe('Type in "Password": [MASKED]');
  });

  it("labels a mark with the first line of its note; a pause has no marker", () => {
    expect(buildMarkers(EVENTS).find((m) => m.kind === "mark")?.label).toBe("Screenshot 1: Total is wrong");
    const pause = EVENTS.find((e) => e.type === "pause")!;
    expect(markerKind(pause)).toBeNull();
    expect(eventLabel(pause)).toBe("Paused for 4.2 s (not in the video)");
  });

  it("treats >= 400 and failed fetch/xhr as errors, but not hidden resource-timing status 0", () => {
    expect(isNetworkError(net(404, "xhr"))).toBe(true);
    expect(isNetworkError(net(0, "fetch"))).toBe(true);
    expect(isNetworkError(net(0, "resource-timing"))).toBe(false);
    expect(isNetworkError(net(0, "resource-timing", "net::ERR_FAILED"))).toBe(true);
    expect(isNetworkError(net(304, "fetch"))).toBe(false);
    expect(markerKind(net(200, "xhr"))).toBeNull();
  });
});

describe("nearestRow", () => {
  const times = [100, 200, 200, 500, 1000];

  it("returns the closest row, preferring the earlier one on a tie", () => {
    expect(nearestRow(times, 0)).toBe(0);
    expect(nearestRow(times, 140)).toBe(0);
    expect(nearestRow(times, 150)).toBe(0);
    expect(nearestRow(times, 160)).toBe(1);
    expect(nearestRow(times, 200)).toBe(1);
    expect(nearestRow(times, 340)).toBe(1);
    expect(nearestRow(times, 360)).toBe(3);
    expect(nearestRow(times, 99_999)).toBe(4);
  });

  it("handles empty and single lists", () => {
    expect(nearestRow([], 10)).toBe(-1);
    expect(nearestRow([42], 0)).toBe(0);
  });
});

describe("scrubber math and time format", () => {
  it("clamps percent", () => {
    expect(timeToPercent(500, 1000)).toBe(50);
    expect(timeToPercent(-5, 1000)).toBe(0);
    expect(timeToPercent(2000, 1000)).toBe(100);
    expect(timeToPercent(5, 0)).toBe(0);
  });

  it("formats the video clock", () => {
    expect(fmtVideoTime(0)).toBe("0:00.0");
    expect(fmtVideoTime(16_525)).toBe("0:16.5");
    expect(fmtVideoTime(61_049)).toBe("1:01.0");
  });
});
