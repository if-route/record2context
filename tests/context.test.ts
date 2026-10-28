import { describe, expect, it } from "vitest";
import { buildAiReadme } from "../src/shared/ai-readme";
import { CONTEXT_MAX_CHARS, buildPortableContext } from "../src/shared/context";
import { appendEvent, emptyLog } from "../src/shared/event-log";
import { closePause, openPause, scrubAnnotations, setMarkNote, setMarkShot, type MarkState } from "../src/shared/marks";
import { videoFile } from "../src/shared/paths";
import { buildReport } from "../src/shared/report";
import type { RawEvent, RecEvent } from "../src/shared/types";

const V = Date.UTC(2026, 9, 22, 7, 30, 5);
const ID = "2026-10-22_143005_app-test";
const env = { userAgent: "Mozilla/5.0 Chrome/149.0.0.0 Safari/537.36", os: "mac", arch: "arm64", viewport: { width: 1280, height: 800 }, dpr: 2 };
const vp = { width: 1280, height: 800, dpr: 2, scrollX: 0, scrollY: 0 };
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abcdefghij";

const click = (at: number, label: string, extra: Partial<RawEvent> = {}): RawEvent =>
  ({ type: "click", at: V + at, path: "/home", label, labelSource: "innerText", tag: "button", selector: `#${label.toLowerCase().replace(/\W/g, "")}`, bbox: { x: 1, y: 2, width: 3, height: 4 }, point: { x: 2, y: 3 }, viewport: vp, ...extra }) as RawEvent;
const net = (at: number, url: string, status = 200, method = "GET"): RawEvent => ({ type: "network", at: V + at, path: "/home", method, url, status, durationMs: 40, source: "fetch" });

function session(extra: (s: MarkState) => void = () => undefined) {
  const s: MarkState = { pauses: [], marks: 0, log: emptyLog() };
  const add = (r: RawEvent) => appendEvent(s.log, r);
  add({ type: "page_load", at: V + 5, path: "/home", navigationType: "navigate", initial: true, url: "https://app.test/home?session=abc", title: "Home" });
  add(net(50, "https://api.test/rest/me"));
  add(click(1000, "Save", { testId: "save-btn", role: "button" }));
  for (let i = 0; i < 30; i++) add(net(1010 + i * 10, "https://api.test/rest/poll?access_token=secret-1"));
  add(net(1200, "https://api.test/rest/save", 500, "POST"));
  add(net(1300, "https://api.test/rest/save", 500, "POST"));
  add({ type: "input", at: V + 2000, path: "/home", selector: "input[name=password]", label: "Password", tag: "input", inputType: "password", value: "[MASKED]", valueLength: 7, masked: true, truncated: false });
  add({ type: "input", at: V + 2500, path: "/home", selector: "input[name=title]", label: "Title", tag: "input", inputType: "text", value: "Hello", valueLength: 5, masked: false, truncated: false });
  add({ type: "key", at: V + 2600, path: "/home", key: "Enter", modifiers: ["Shift"], selector: "input[name=title]", label: "Title", tag: "input" });
  add({ type: "route_change", at: V + 2700, path: "/details", from: "/home", to: "/details?id=7", via: "pushState" });
  add({ type: "console_error", at: V + 2800, path: "/details", source: "console.error", message: `boom ${JWT}\nsecond line` });
  add({ type: "page_load", at: V + 4000, path: "/details", navigationType: "reload", initial: false, url: "https://app.test/details?id=7", title: "Details" });
  add({ type: "screenshot", at: V + 4500, path: "/details", file: "screenshots/01.png", viewport: vp, imageWidth: 2560, imageHeight: 1600, annotated: true });
  openPause(s, V + 5000, "/details");
  add(net(5500, "https://api.test/rest/poll?access_token=secret-1"));
  setMarkNote(s, "ปุ่ม Save ส่ง 500 สองครั้ง\nBearer abcdefghijklmnop");
  closePause(s, V + 9000);
  openPause(s, V + 9500, "/details");
  closePause(s, V + 9600);
  extra(s);
  return buildReport({
    version: "0.2.0",
    clock: { videoStart: V, pauses: s.pauses },
    stoppedAt: V + 12_000,
    stopReason: "user",
    startUrl: "https://app.test/home?session=abc",
    env,
    video: { file: videoFile(ID), mimeType: "video/webm", width: 2560, height: 1600, durationMs: 7900, sizeBytes: 1, seekableFix: true },
    log: s.log,
  });
}

function parse(markdown: string) {
  const m = /```json\n([\s\S]*?)\n```/.exec(markdown);
  if (!m) throw new Error("no json block");
  return JSON.parse(m[1]!);
}

describe("video naming", () => {
  it("names the video after the session", () => {
    expect(videoFile(ID)).toBe(`${ID}.webm`);
  });
});

describe("buildPortableContext", () => {
  const report = session();
  const { markdown, level, shortened } = buildPortableContext(report, ID);
  const ctx = parse(markdown);

  it("is a collapsed block with a one-line header naming the video", () => {
    expect(markdown.startsWith("<details><summary>Context for AI (record2context)</summary>\n\n")).toBe(true);
    expect(markdown.trimEnd().endsWith("</details>")).toBe(true);
    const header = markdown.split("\n")[2]!;
    expect(header).toContain(`\`${ID}.webm\``);
    expect(header).toContain("Every `t` is ms");
    expect(level).toBe(0);
    expect(shortened).toEqual([]);
    expect(ctx).not.toHaveProperty("shortened");
  });

  it("carries the session header", () => {
    expect(ctx).toMatchObject({
      contextVersion: 1,
      reportSchemaVersion: 5,
      generator: "record2context 0.2.0",
      session: ID,
      recordedAt: "2026-10-22T07:30:05.000Z",
      startUrl: "https://app.test/home?session=[REDACTED]",
      environment: { frontendHost: "app.test", apiHosts: ["api.test"] },
      client: { browser: "Chrome 149", os: "mac", arch: "arm64", viewport: "1280x800", dpr: 2 },
      video: { file: `${ID}.webm`, durationMs: 7900, size: "2560x1600", pausedMs: 4100 },
      screenshots: [{ file: "screenshots/01.png", t: 4500 }],
    });
  });

  it("lists pauses and marks with notes, Thai kept and tokens removed", () => {
    expect(ctx.pauses).toEqual([
      { t: 5000, pausedMs: 4000 },
      { t: 5500, pausedMs: 100 },
    ]);
    expect(ctx.marks).toEqual([
      { n: 1, t: 5000, video: "0:05.0", note: "ปุ่ม Save ส่ง 500 สองครั้ง\nBearer [REDACTED]" },
      { n: 2, t: 5500, video: "0:05.5", note: "" },
    ]);
  });

  it("orders actions with label, source, selector, test id and role, and masks inputs", () => {
    expect(ctx.actions.map((a: { type: string }) => a.type)).toEqual(["page_load", "click", "input", "input", "key", "route_change", "page_load"]);
    expect(ctx.actions[1]).toMatchObject({ n: 2, t: 1000, label: "Save", labelSource: "innerText", tag: "button", role: "button", testId: "save-btn", selector: "#save", route: "/home" });
    expect(ctx.actions[2]).toMatchObject({ type: "input", label: "Password", value: "[MASKED]", valueLength: 7 });
    expect(ctx.actions[3]).toMatchObject({ type: "input", label: "Title", value: "Hello" });
    expect(ctx.actions[4]).toMatchObject({ type: "key", key: "Shift+Enter" });
    expect(ctx.actions[6]).toMatchObject({ type: "page_load", navigation: "reload" });
  });

  it("gives each action the requests until the next one, identical requests counted once", () => {
    expect(ctx.actions[0].requests).toEqual([{ t: 50, method: "GET", url: "//api.test/rest/me", status: 200, ms: 40 }]);
    expect(ctx.actions[1].requests).toEqual([
      { t: 1010, method: "GET", url: "//api.test/rest/poll?access_token=[REDACTED]", status: 200, ms: 40, count: 30 },
      { t: 1200, method: "POST", url: "//api.test/rest/save", status: 500, ms: 40, count: 2 },
    ]);
    expect(ctx.actions[2]).not.toHaveProperty("requests");
  });

  it("groups repeated requests in network but lists every error on its own", () => {
    expect(ctx.network.requests).toBe(34);
    expect(ctx.network.errors).toEqual([
      { t: 1200, method: "POST", url: "//api.test/rest/save", status: 500, ms: 40, source: "fetch" },
      { t: 1300, method: "POST", url: "//api.test/rest/save", status: 500, ms: 40, source: "fetch" },
    ]);
    expect(ctx.network.groups).toEqual([
      { method: "GET", url: "//api.test/rest/me", status: 200, count: 1, firstT: 50, lastT: 50 },
      // 30 after the click plus one during the first pause, which sits at the pause point.
      { method: "GET", url: "//api.test/rest/poll?access_token=[REDACTED]", status: 200, count: 31, firstT: 1010, lastT: 5000 },
    ]);
  });

  it("scrubs tokens from console errors and never includes secrets", () => {
    expect(ctx.consoleErrors).toEqual([{ t: 2800, source: "console.error", message: "boom [REDACTED_JWT]" }]);
    for (const secret of ["secret-1", JWT, "abcdefghijklmnop", "session=abc"]) expect(markdown).not.toContain(secret);
  });

  it("has a replay list a machine can follow", () => {
    expect(ctx.replay).toEqual([
      { t: 5, do: "goto", url: "https://app.test/home?session=[REDACTED]", expect: ["GET //api.test/rest/me → 200"] },
      {
        t: 1000,
        do: "click",
        label: "Save",
        selector: "#save",
        testId: "save-btn",
        role: "button",
        expect: ["GET //api.test/rest/poll?access_token=[REDACTED] → 200 ×30", "POST //api.test/rest/save → 500 ×2"],
      },
      { t: 2000, do: "fill", selector: "input[name=password]", label: "Password", inputType: "password", value: "[MASKED]" },
      { t: 2500, do: "fill", selector: "input[name=title]", label: "Title", inputType: "text", value: "Hello" },
      { t: 2600, do: "key", key: "Shift+Enter", selector: "input[name=title]" },
      { t: 2700, do: "navigate", url: "/details?id=7", via: "pushState", causedByPrevious: true },
      // The only request after the reload was made while paused, so it is not expected.
      { t: 4000, do: "reload" },
    ]);
  });

  it("is deterministic", () => {
    expect(buildPortableContext(session(), ID).markdown).toBe(markdown);
  });

  it("escapes backticks so a note cannot close the code fence", () => {
    const r = session((s) => {
      openPause(s, V + 10_000, "/");
      setMarkNote(s, "see ```code``` here");
      closePause(s, V + 10_100);
    });
    const md = buildPortableContext(r, ID).markdown;
    expect(md.match(/```/g)).toHaveLength(2);
    expect(parse(md).marks[2].note).toBe("see ```code``` here");
  });
});

describe("buildPortableContext size cap", () => {
  const big = session((s) => {
    for (let i = 0; i < 1500; i++) appendEvent(s.log, net(10_000 + i, `https://api.test/rest/item/${i}?q=${"x".repeat(60)}`));
    for (let i = 0; i < 150; i++) appendEvent(s.log, click(20_000 + i * 10, `Row ${i} ${"y".repeat(40)}`));
  });

  it("shrinks the least important parts first and says what it shortened", () => {
    const r = buildPortableContext(big, ID);
    expect(r.markdown.length).toBeLessThanOrEqual(CONTEXT_MAX_CHARS);
    expect(r.level).toBeGreaterThan(0);
    const ctx = parse(r.markdown);
    expect(ctx.shortened).toEqual(r.shortened);
    expect(r.shortened.some((s) => s.startsWith("network.groups (most repeated kept):"))).toBe(true);
    // Marks, errors and every action survive; the bulk is cut from repeated-request groups.
    expect(ctx.marks).toHaveLength(2);
    expect(ctx.network.errors).toHaveLength(2);
    expect(ctx.actions).toHaveLength(157);
    expect(ctx.network.groups[0]).toMatchObject({ count: 31 });
  });

  it("cuts actions only as a last resort, and says so", () => {
    const huge = session((s) => {
      for (let i = 0; i < 2000; i++) appendEvent(s.log, click(20_000 + i * 10, `Row ${i}`));
    });
    const r = buildPortableContext(huge, ID);
    expect(r.markdown.length).toBeLessThanOrEqual(CONTEXT_MAX_CHARS);
    const ctx = parse(r.markdown);
    expect(ctx.actions.length).toBeLessThan(2007);
    expect(r.shortened).toContain(`actions: ${ctx.actions.length} of 2007 shown`);
    expect(ctx.marks).toHaveLength(2);
  });

  it("respects a smaller cap by cutting deeper", () => {
    const r = buildPortableContext(big, ID, 20_000);
    expect(r.markdown.length).toBeLessThanOrEqual(20_000);
    const ctx = parse(r.markdown);
    expect(ctx.marks[0].note).toContain("ปุ่ม Save");
    expect(r.shortened.length).toBeGreaterThan(1);
  });
});

describe("buildAiReadme", () => {
  const md = buildAiReadme(session(), ID);
  it("names the real files and explains t, marks, frames and masking", () => {
    expect(md).toContain(`# record2context recording ${ID}`);
    expect(md).toContain("relative to the recording folder (the folder that holds `details/`)");
    expect(md).toContain("`details/private-do-not-share/`");
    expect(md).toContain("`report.storage`");
    expect(md).toContain(`| \`${ID}.webm\` | Video of the tab, 2560x1600, 0:07.9 long.`);
    expect(md).toContain(`ffmpeg -ss <t/1000> -i ${ID}.webm -frames:v 1 frame.png`);
    expect(md).toContain("paused time is left out");
    expect(md).toContain("(2 in this session)");
    expect(md).toContain("duringPause: true");
    expect(md).toContain("`screenshots/01.png` at t=4500");
    expect(md).toContain("[MASKED]");
    expect(md).toContain("this session started at 1280x800, devicePixelRatio 2");
  });
});

describe("marks with screenshots and shapes", () => {
  const element = {
    tag: "button",
    label: "Save",
    labelSource: "innerText" as const,
    selector: "#save",
    testId: "save-btn",
    text: "Save",
    bbox: { x: 40, y: 50, width: 80, height: 30 },
    style: { color: "rgb(255, 255, 255)", backgroundColor: "rgba(0, 0, 0, 0)", inheritedBackground: "rgb(37, 99, 235)", fontSize: "14px", fontWeight: "600", display: "inline-block", visibility: "visible" },
  };
  const shapes = scrubAnnotations([
    { n: 1, shape: "box", color: "red", hex: "#ff2d55", geometry: { image: { x: 80, y: 100, width: 160, height: 60 }, css: { x: 40, y: 50, width: 80, height: 30 } }, note: "wrong colour Bearer abcdefghijklmnop", element },
    { n: 2, shape: "arrow", color: "yellow", hex: "#facc15", geometry: { image: { from: { x: 0, y: 0 }, to: { x: 200, y: 120 } }, css: { from: { x: 0, y: 0 }, to: { x: 100, y: 60 } } }, note: "" },
  ]);
  const report = session((s) => {
    openPause(s, V + 10_000, "/details");
    setMarkShot(s, { file: "screenshots/02.png", viewport: vp, imageWidth: 2560, imageHeight: 1600 });
    setMarkShot(s, { ...s.markDraft!.shot!, annotations: shapes, annotatedFile: "screenshots/02-annotated.png" });
    setMarkNote(s, "see 1 and 2");
    closePause(s, V + 11_000);
  });

  it("the mark references its screenshot, and the screenshot carries the shapes (notes scrubbed)", () => {
    expect(report.marks[2]).toEqual({ n: 3, t: 5900, note: "see 1 and 2", screenshot: "screenshots/02.png", annotatedScreenshot: "screenshots/02-annotated.png" });
    const shot = report.screenshots.find((x) => x.mark === 3)!;
    expect(shot).toMatchObject({ file: "screenshots/02.png", t: 5900, annotatedFile: "screenshots/02-annotated.png" });
    expect(shot.annotations!.map((a) => a.note)).toEqual(["wrong colour Bearer [REDACTED]", ""]);
    const ev = (report.events as RecEvent[]).find((e) => e.type === "screenshot" && e.mark === 3);
    expect(ev).toMatchObject({ annotated: true, imageWidth: 2560, viewport: vp });
  });

  it("context.md lists each shape compactly with what it points at", () => {
    const ctx = parse(buildPortableContext(report, ID).markdown);
    expect(ctx.marks[2]).toEqual({ n: 3, t: 5900, video: "0:05.9", note: "see 1 and 2", screenshot: "screenshots/02.png" });
    expect(ctx.screenshots[1]).toEqual({
      file: "screenshots/02.png",
      t: 5900,
      mark: 3,
      annotatedFile: "screenshots/02-annotated.png",
      shapes: [
        {
          n: 1,
          shape: "box",
          color: "red",
          note: "wrong colour Bearer [REDACTED]",
          box: [40, 50, 80, 30],
          on: { tag: "button", label: "Save", testId: "save-btn", text: "Save", selector: "#save", style: "color rgb(255, 255, 255); background rgb(37, 99, 235); 14px 600; inline-block" },
        },
        { n: 2, shape: "arrow", color: "yellow", tip: { x: 100, y: 60 } },
      ],
    });
  });

  it("AI-README explains the Screenshot (a mark) and the shapes", () => {
    const md = buildAiReadme(report, ID);
    expect(md).toContain("`screenshots/02-annotated.png` at t=5900 (Screenshot 3) (plain frame: `screenshots/02.png`)");
    expect(md).toContain("## Screenshots and shapes");
    expect(md).toContain("numbered like the badge");
  });
});
