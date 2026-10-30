import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAiReadme } from "../src/shared/ai-readme";
import { buildPortableContext } from "../src/shared/context";
import { appendEvent, emptyLog } from "../src/shared/event-log";
import { writeFile } from "../src/shared/fs";
import { REPORT_FILE, bodyFile, storageFile } from "../src/shared/layout";
import { PRETTY_MAX, PRIVATE_NOTE, bodiesLine, bodyPartLabel, browserLine, prettyBody, readBodies, readPrivateSnapshot, snapshotLabel, storageNote, storageView } from "../src/shared/private-view";
import { aiPointer, type RecentSession } from "../src/shared/recent";
import { buildReport } from "../src/shared/report";
import { copyableContext, storedContext } from "../src/shared/session-actions";
import { summarizeSnapshot, type RawSnapshot } from "../src/shared/storage-snapshot";
import { openSessionFile } from "../src/shared/store";
import { FakeDir } from "./helpers/fake-fs";

const blob = (v: unknown) => new Blob([typeof v === "string" ? v : JSON.stringify(v)]);
const reader = (files: Record<string, unknown>) => {
  const asked: string[] = [];
  const read = async (f: string) => (asked.push(f), f in files ? blob(files[f]) : null);
  return { read, asked };
};

const RAW: RawSnapshot = {
  origin: "https://app.test",
  local: { keys: 3, entries: [{ key: "authToken", value: "tok-PLANTED-1", length: 13 }, { key: "theme", value: "dark", length: 4 }, { key: "big", value: null, length: 9e6 }] },
  session: { keys: 1, entries: [{ key: "draft", value: "abc", length: 10 }] },
  cookieNames: ["sid"],
};
const PRIV = storageFile(1, "start");

describe("reading the private folder for the Recordings page", () => {
  it("reads the snapshot report.json names, and only a file in the private storage folder", async () => {
    const r = reader({ [PRIV]: RAW, "details/report.json": RAW });
    expect(await readPrivateSnapshot({ privateFile: PRIV }, r.read)).toEqual(RAW);
    for (const bad of ["details/report.json", "../x.json", `${PRIV}/../../report.json`, "details/private-do-not-share/bodies/b1-1.json", "/etc/passwd"])
      expect(await readPrivateSnapshot({ privateFile: bad }, r.read)).toBeNull();
    expect(r.asked).toEqual([PRIV]);
  });

  it("a missing, unreadable or broken file is null, never a throw (old recordings, deleted folder)", async () => {
    expect(await readPrivateSnapshot({}, reader({}).read)).toBeNull();
    expect(await readPrivateSnapshot({ privateFile: PRIV }, reader({}).read)).toBeNull();
    expect(await readPrivateSnapshot({ privateFile: PRIV }, reader({ [PRIV]: "{not json" }).read)).toBeNull();
    expect(await readPrivateSnapshot({ privateFile: PRIV }, async () => Promise.reject(new Error("helper gone")))).toBeNull();
    expect(await readBodies("b1-1", reader({}).read)).toBeNull();
  });

  it("bodies by a valid bodyId only", async () => {
    const rec = { method: "POST", url: "https://api.test/x", request: { text: "{}" } };
    const r = reader({ [bodyFile("babc-1")]: rec });
    expect(await readBodies("babc-1", r.read)).toEqual(rec);
    expect(await readBodies("../../report", r.read)).toBeNull();
    expect(r.asked).toEqual([bodyFile("babc-1")]);
  });
});

describe("what the Storage tab shows", () => {
  it("unredacted values from the private file, with why a value is short", () => {
    const v = storageView(summarizeSnapshot(RAW, { n: 1, label: "start", at: 0 }), RAW);
    expect(v.source).toBe("private");
    expect(v.local!.rows).toEqual([
      { key: "authToken", value: "tok-PLANTED-1", length: 13 },
      { key: "theme", value: "dark", length: 4 },
      { key: "big", value: "", length: 9e6, note: "not kept: snapshot size limit" },
    ]);
    expect(v.session!.rows[0]).toEqual({ key: "draft", value: "abc", length: 10, note: "first 3 of 10 chars" });
    expect(v.cookieNames).toEqual(["sid"]);
  });

  it("the redacted report.json values when the private file is not there", () => {
    const v = storageView(summarizeSnapshot(RAW, { n: 1, label: "start", at: 0 }), null);
    expect(v.source).toBe("redacted");
    expect(v.local!.rows[0]).toEqual({ key: "authToken", value: "[REDACTED]", length: 13, note: "redacted" });
    expect(JSON.stringify(v)).not.toContain("tok-PLANTED-1");
    expect(storageView({}, null)).toEqual({ source: "redacted", cookieNames: [] });
  });

  it("a cookie read that failed says so, not none", () => {
    const failed = { ...RAW, cookieNames: [], cookieError: "SecurityError: The document is sandboxed and lacks the 'allow-same-origin' flag." };
    expect(storageView(summarizeSnapshot(failed, { n: 1, label: "start", at: 0 }), failed)).toMatchObject({ cookieNames: [], cookieError: failed.cookieError });
    expect(storageView(summarizeSnapshot(RAW, { n: 1, label: "start", at: 0 }), RAW)).not.toHaveProperty("cookieError");
  });

  it("the note above the snapshots matches them: private, a mix, or none when all are redacted", () => {
    expect(storageNote(["private", "private"])).toBe(PRIVATE_NOTE);
    const mixed = storageNote(["private", "redacted"])!;
    expect(mixed).toContain("in the snapshots marked Private; the others are redacted");
    expect(mixed).toContain("never part of Copy portable context");
    expect(storageNote(["redacted", "redacted"])).toBeNull();
    expect(storageNote([])).toBeNull();
  });

  it("labels snapshots as people see them", () => {
    expect(["start", "mark-2", "stop"].map(snapshotLabel)).toEqual(["Start", "Screenshot 2", "Stop"]);
  });
});

describe("bodies, privateData and the browser line", () => {
  it("pretty-prints JSON by its own tokens: big numbers and strings with brackets stay exact", () => {
    expect(prettyBody('{"id":12345678901234567890,"s":"a,{b}:[c] \\"q\\"","e":{},"l":[ ],"n":[1,{"x":null}]}')).toBe(
      '{\n  "id": 12345678901234567890,\n  "s": "a,{b}:[c] \\"q\\"",\n  "e": {},\n  "l": [],\n  "n": [\n    1,\n    {\n      "x": null\n    }\n  ]\n}',
    );
  });

  it("anything that is not whole JSON is shown as it is (plain text, a body cut at the size cap)", () => {
    for (const t of ["hello, world", '{"a": [1, 2', "a=1&b=2", ""]) expect(prettyBody(t)).toBe(t);
  });

  it("deeply nested JSON too big to indent is shown as its raw text, not a string that crashes the tab", () => {
    const deep = "[".repeat(12000) + "]".repeat(12000); // 24 KB; indented it would be ~288 M chars
    expect(prettyBody(deep)).toBe(deep);
    const wide = JSON.stringify(Array.from({ length: 3000 }, (_, i) => ({ id: i, name: `item ${i}`, tags: ["a", "b"] }))); // ~150 KB, shallow
    const pretty = prettyBody(wide);
    expect(pretty.length).toBeLessThan(PRETTY_MAX);
    expect(pretty.startsWith('[\n  {\n    "id": 0,')).toBe(true);
  });

  it("says what each side is, or why it was not kept", () => {
    expect(bodyPartLabel("Request", undefined)).toBe("Request: no body");
    expect(bodyPartLabel("Response", { skipped: "not a text type (image/png)" })).toBe("Response: not kept (not a text type (image/png))");
    expect(bodyPartLabel("Response", { contentType: "application/json", text: "x", size: 262144, truncated: "size" })).toBe("Response · application/json · 256.0 KiB (cut at 256.0 KiB)");
    expect(bodyPartLabel("Request", { text: "abc", size: 3 })).toBe("Request · 3 B");
  });

  it("report.privateData counts, and nothing for a recording made before bodies were kept", () => {
    expect(bodiesLine({ bodies: { saved: 2, bytes: 2048, skipped: { "more than 500 calls with bodies in one recording": 3 } } })).toBe(
      "Bodies kept for 2 calls (2.0 KiB); not kept: 3 more than 500 calls with bodies in one recording. Open one with Body on its row.",
    );
    expect(bodiesLine(undefined)).toBeNull();
  });

  it("language, locale and time zone with its UTC offset", () => {
    expect(browserLine({ language: "th-TH", locale: "th-TH", timeZone: "Asia/Bangkok", utcOffsetMinutes: 420 })).toBe("Browser: language th-TH, locale th-TH, time zone Asia/Bangkok (UTC+7)");
    expect(browserLine({ timeZone: "Asia/Kolkata", utcOffsetMinutes: 330 })).toBe("Browser: time zone Asia/Kolkata (UTC+5:30)");
    expect(browserLine({ timeZone: "America/St_Johns", utcOffsetMinutes: -150 })).toBe("Browser: time zone America/St_Johns (UTC-2:30)");
    expect(browserLine({})).toBeNull();
  });
});

describe("hard rule: what the page shows from the private folder never reaches what it copies", () => {
  const START = Date.UTC(2026, 9, 29, 3, 0, 0);
  const ID = "2026-10-29_100000_app-test";
  const PLANTED = ["tok-PLANTED-1", "PLANTED-REQUEST-BODY", "PLANTED-RESPONSE-BODY"];
  let opfs: FakeDir;

  beforeEach(async () => {
    opfs = new FakeDir("root");
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => opfs } });
    const log = emptyLog();
    appendEvent(log, { type: "page_load", at: START + 10, path: "/", navigationType: "navigate", initial: true, url: "https://app.test/", title: "App" });
    appendEvent(log, { type: "network", at: START + 100, path: "/", method: "POST", url: "https://api.test/save", status: 200, durationMs: 5, source: "fetch", bodyId: "babc-1" });
    const report = buildReport({
      version: "1",
      clock: { videoStart: START, pauses: [] },
      stoppedAt: START + 5000,
      stopReason: "user",
      startUrl: "https://app.test/",
      env: { userAgent: "UA", os: "mac", arch: "arm64", viewport: { width: 1280, height: 800 }, dpr: 2, timeZone: "Asia/Bangkok" },
      video: null,
      videoError: "no video",
      log,
      storage: [summarizeSnapshot(RAW, { n: 1, label: "start", at: START + 50, privateFile: PRIV })],
      bodies: { saved: ["babc-1"], bytes: 100, skipped: {} },
    });
    const dir = `sessions/${ID}`;
    await writeFile(opfs, `${dir}/${REPORT_FILE}`, JSON.stringify(report));
    await writeFile(opfs, `${dir}/${PRIV}`, JSON.stringify(RAW));
    await writeFile(opfs, `${dir}/${bodyFile("babc-1")}`, JSON.stringify({ method: "POST", url: "https://api.test/save", request: { text: '{"x":"PLANTED-REQUEST-BODY"}' }, response: { text: "PLANTED-RESPONSE-BODY" } }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("the page can read the planted values, and Copy portable context, Copy for my AI, context.md and AI-README hold none", async () => {
    const entry = (extra: Partial<RecentSession> = {}): RecentSession => ({ id: ID, host: "app.test", startedAt: new Date(START).toISOString(), durationMs: 5000, marks: 0, context: "kept context", folderCopy: { dir: `/tmp/r/${ID}` }, ...extra });
    const read = (f: string) => openSessionFile(entry(), f);
    const shown = JSON.stringify([await readPrivateSnapshot({ privateFile: PRIV }, read), await readBodies("babc-1", read)]);
    for (const p of PLANTED) expect(shown).toContain(p);

    const report = JSON.parse(await (await read(REPORT_FILE))!.text());
    const copied = [
      await copyableContext(entry()), // rebuilt from report.json (an entry from before email masking)
      await copyableContext(entry({ emailsMasked: true })),
      storedContext(entry()),
      aiPointer(entry()) ?? "",
      buildPortableContext(report, ID).markdown,
      buildAiReadme(report, ID),
      JSON.stringify(report),
    ];
    expect(copied[0]).toContain("Asia/Bangkok");
    for (const text of copied) for (const p of PLANTED) expect(text).not.toContain(p);
  });

  it("only src/recordings imports the private reader; nothing that builds copied or saved text does", () => {
    const src = path.join(__dirname, "..", "src");
    const files = fs.readdirSync(src, { recursive: true }).map(String).filter((f) => f.endsWith(".ts"));
    const imports = /(?:from|import)\s*\(?\s*["'][^"']*\/private-view(?:\.[cm]?[jt]s)?["']/;
    for (const spelling of ['from "./private-view"', "from '../shared/private-view.js'", 'from "./private-view.ts"', 'import("./private-view")', "import './private-view'"])
      expect(spelling).toMatch(imports);
    const importers = files.filter((f) => imports.test(fs.readFileSync(path.join(src, f), "utf8")));
    expect(importers.sort()).toEqual(["recordings/index.ts", "recordings/player.ts"]);
  });
});
