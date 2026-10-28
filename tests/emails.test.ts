// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { describeElement } from "../src/content/element-info";
import { MASK, describeField, isSensitiveField } from "../src/content/inputs";
import { buildSelector, elementLabel } from "../src/content/labels";
import { buildPortableContext } from "../src/shared/context";
import { appendEvent, emptyLog, orderedEvents } from "../src/shared/event-log";
import { closePause, openPause, scrubAnnotations, setMarkNote, setMarkShot, type MarkState } from "../src/shared/marks";
import { maskEmailInput, pagePath, redactText, redactUrl, scrubEmails, scrubEmailsDeep } from "../src/shared/redact";
import { buildReport, type Report } from "../src/shared/report";
import type { RecentSession } from "../src/shared/recent";
import { copyableContext, storedContext } from "../src/shared/session-actions";
import type { RawEvent, RecEvent } from "../src/shared/types";

const EMAIL = "jane.doe@example.com";
const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector(sel) as unknown as T;

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("email pattern", () => {
  it.each([
    [`Signed in as ${EMAIL}.`, "Signed in as [EMAIL]."],
    ["First.Last+qa@sub.example.co.uk, next", "[EMAIL], next"],
    ["jane.doe%40example.com", "[EMAIL]"],
    ["jane.doe%2540example.com", "[EMAIL]"],
  ])("replaces %s", (input, out) => {
    expect(scrubEmails(input)).toBe(out);
  });

  it.each(["/img/logo@2x.png", "https://cdn.test/npm/lodash@4.17.21/lodash.min.js", "/node_modules/@babel/core", "user@localhost"])(
    "leaves %s alone",
    (s) => {
      expect(scrubEmails(s)).toBe(s);
    },
  );

  it("redactText removes tokens and emails together", () => {
    expect(redactText(`Bearer abcdefghijklmnop for ${EMAIL}`)).toBe("Bearer [REDACTED] for [EMAIL]");
  });
});

describe("URLs", () => {
  it("replaces emails in the query, plain or encoded, and keeps sensitive-param redaction", () => {
    // `eq.jane.doe` is itself a valid local part, so the PostgREST operator goes with the address.
    expect(redactUrl(`https://api.test/rest/user?email=eq.${EMAIL}&token=abc`)).toBe("https://api.test/rest/user?email=[EMAIL]&token=[REDACTED]");
    expect(redactUrl("https://api.test/rest/user?email=jane.doe%40example.com")).toBe("https://api.test/rest/user?email=[EMAIL]");
  });

  it("replaces emails in the path and the hash", () => {
    expect(redactUrl(`https://app.test/users/${EMAIL}/edit#${EMAIL}`)).toBe("https://app.test/users/[EMAIL]/edit#[EMAIL]");
    expect(pagePath({ pathname: `/u/${EMAIL}`, search: "", hash: "" })).toBe("/u/[EMAIL]");
  });

  it("replaces the email before cutting a long URL, so no half address is left", () => {
    const url = `https://app.test/${"a".repeat(480)}?e=${EMAIL}`;
    expect(redactUrl(url)).not.toContain("jane.doe");
  });
});

describe("input values", () => {
  it.each([
    `<input type="email" name="x">`,
    `<input name="x" autocomplete="username">`,
    `<input name="x" autocomplete="section-login email">`,
    `<input name="userEmail">`,
    `<input id="e-mail">`,
    `<input placeholder="E-Mail address">`,
    `<label>Email Address <input name="x"></label>`,
    `<label for="f">อีเมล</label><input id="f">`,
    `<span id="l">Your email</span><input aria-labelledby="l">`,
  ])("masks %s like a password, keeping the length", (html) => {
    document.body.innerHTML = html;
    const el = $<HTMLInputElement>("input");
    el.value = EMAIL;
    expect(isSensitiveField(el)).toBe(true);
    expect(describeField(el)).toMatchObject({ value: MASK, valueLength: EMAIL.length, masked: true, truncated: false });
  });

  it("masks a contenteditable named as an email field", () => {
    document.body.innerHTML = `<div contenteditable="true" aria-label="Email">${EMAIL}</div>`;
    expect(describeField($("div"))).toMatchObject({ value: MASK, masked: true, valueLength: EMAIL.length, inputType: "contenteditable" });
  });

  it("replaces an address typed into an ordinary field or editor", () => {
    document.body.innerHTML = `<input name="q"><div contenteditable="true" aria-label="Comment">ask ${EMAIL} please</div>`;
    $<HTMLInputElement>("input").value = `find ${EMAIL}`;
    expect(describeField($("input"))).toMatchObject({ value: "find [EMAIL]", valueLength: 5 + EMAIL.length, masked: false });
    expect(describeField($("div"))).toMatchObject({ value: "ask [EMAIL] please", masked: false });
  });

  it("a field label that holds an address loses it", () => {
    document.body.innerHTML = `<input name="q" placeholder="e.g. ${EMAIL}">`;
    expect(describeField($("input")).label).toBe("e.g. [EMAIL]");
  });
});

describe("click labels and selectors", () => {
  it("labels never carry an address", () => {
    document.body.innerHTML = `<button>Send to ${EMAIL}</button><a title="${EMAIL}"></a>`;
    expect(elementLabel($("button")).label).toBe("Send to [EMAIL]");
    expect(elementLabel($("a")).label).toBe("[EMAIL]");
  });

  it("a long label is scrubbed before it is cut", () => {
    document.body.innerHTML = `<button>${"x ".repeat(55)}${EMAIL}</button>`;
    expect(elementLabel($("button")).label).not.toContain("jane.doe");
  });

  it("selectors skip attributes that hold an address", () => {
    document.body.innerHTML = `<div><input placeholder="${EMAIL}"><input placeholder="other"></div>`;
    const sel = buildSelector($("input"));
    expect(sel).not.toContain("jane.doe");
    expect(document.querySelector(sel)).toBe($("input"));
  });
});

describe("element under a shape", () => {
  it("text, label and test id lose addresses", () => {
    document.body.innerHTML = `<p data-testid="row-${EMAIL}">Owner: ${EMAIL}</p>`;
    const info = describeElement($("p"));
    expect(info.text).toBe("Owner: [EMAIL]");
    expect(info.label).toBe("Owner: [EMAIL]");
    expect(info.testId).toBe("[EMAIL]");
    expect(JSON.stringify(info)).not.toContain("jane.doe");
  });
});

// A session as an older version saved it: nothing masked, emails everywhere, notes with an address the tester wrote.
const V = Date.UTC(2026, 9, 28, 3, 0, 0);
const vp = { width: 1280, height: 800, dpr: 2, scrollX: 0, scrollY: 0 };
const NOTE = `login as ${EMAIL} fails`;
const SHAPE_NOTE = `this should show ${EMAIL}`;

function unmaskedLog(): MarkState {
  const s: MarkState = { pauses: [], marks: 0, log: emptyLog() };
  const add = (r: RawEvent) => appendEvent(s.log, r);
  add({ type: "page_load", at: V + 5, path: "/login", navigationType: "navigate", initial: true, url: `https://app.test/login?hint=${EMAIL}`, title: `Login ${EMAIL}` });
  add({ type: "input", at: V + 1000, path: "/login", selector: "input[name=email]", label: "Email Address", tag: "input", inputType: "text", value: EMAIL, valueLength: EMAIL.length, masked: false, truncated: false });
  add({ type: "input", at: V + 1500, path: "/login", selector: "input[name=x]", label: "Login", tag: "input", inputType: "email", value: "someone", valueLength: 7, masked: false, truncated: false });
  add({ type: "input", at: V + 1700, path: "/login", selector: "input[name=q]", label: "Search", tag: "input", inputType: "text", value: `find ${EMAIL}`, valueLength: 5 + EMAIL.length, masked: false, truncated: false });
  add({ type: "click", at: V + 2000, path: "/login", label: `Continue as ${EMAIL}`, labelSource: "innerText", tag: "a", selector: `a[title="${EMAIL}"]`, bbox: { x: 1, y: 2, width: 3, height: 4 }, point: { x: 2, y: 3 }, viewport: vp, href: `https://app.test/u/${EMAIL}` });
  add({ type: "network", at: V + 2100, path: "/login", method: "GET", url: `https://api.test/rest/user?email=eq.${EMAIL}`, status: 500, durationMs: 40, source: "fetch", error: `no user ${EMAIL}` });
  add({ type: "route_change", at: V + 2200, path: `/u/${EMAIL}`, from: "/login", to: `/u/${EMAIL}`, via: "pushState" });
  add({ type: "console_error", at: V + 2300, path: `/u/${EMAIL}`, source: "console.error", message: `Error: unknown ${EMAIL}`, stack: `at f (https://app.test/u/${EMAIL}.js:1:1)` });
  openPause(s, V + 3000, "/login");
  setMarkShot(s, { file: "screenshots/01.png", viewport: vp, imageWidth: 2560, imageHeight: 1600 });
  const element = { tag: "p", label: `Owner ${EMAIL}`, labelSource: "innerText" as const, selector: "#owner", text: `Owner ${EMAIL}`, bbox: { x: 1, y: 2, width: 3, height: 4 }, style: { color: "a", backgroundColor: "b", fontSize: "c", fontWeight: "d", display: "e", visibility: "visible" } };
  setMarkShot(s, { ...s.markDraft!.shot!, annotations: scrubAnnotations([{ n: 1, shape: "box", color: "red", hex: "#f00", geometry: { image: { x: 0, y: 0, width: 2, height: 2 }, css: { x: 0, y: 0, width: 1, height: 1 } }, note: SHAPE_NOTE, element }]) });
  setMarkNote(s, NOTE);
  closePause(s, V + 4000);
  return s;
}

function reportOf(s: MarkState): Report {
  return buildReport({
    version: "0.1.0",
    clock: { videoStart: V, pauses: s.pauses },
    stoppedAt: V + 5000,
    stopReason: "user",
    startUrl: `https://app.test/login?hint=${EMAIL}`,
    env: { userAgent: "Chrome/149", os: "mac", arch: "arm64", viewport: { width: 1280, height: 800 }, dpr: 2 },
    video: null,
    log: s.log,
  });
}

/** What report.json held before masking: the same report with the log's raw strings put back. */
function oldReport(s: MarkState): Report {
  const r = reportOf(s);
  const events = orderedEvents(s.log, { videoStart: V, pauses: s.pauses }, V + 5000);
  const shots = events.flatMap((e) => (e.type === "screenshot" ? [e] : []));
  return {
    ...r,
    startUrl: `https://app.test/login?hint=${EMAIL}`,
    screenshots: r.screenshots.map((sh, i) => ({ ...sh, annotations: shots[i]!.annotations })),
    events: events as unknown as Report["events"],
  };
}

const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

describe("report.json", () => {
  const report = reportOf(unmaskedLog());
  const json = JSON.stringify(report);

  it("holds no address outside the notes", () => {
    expect(occurrences(json, EMAIL)).toBe(4); // mark note and shape note, each in its summary list and in its event
  });

  it("masks email-field inputs and replaces addresses in other values", () => {
    const inputs = (report.events as RecEvent[]).filter((e) => e.type === "input");
    expect(inputs.map((e) => (e.type === "input" ? [e.value, e.masked, e.valueLength] : []))).toEqual([
      [MASK, true, EMAIL.length],
      [MASK, true, 7],
      ["find [EMAIL]", false, 5 + EMAIL.length],
    ]);
  });

  it("leaves the tester's Mark and shape notes as written", () => {
    expect(report.marks[0]!.note).toBe(NOTE);
    expect(report.screenshots[0]!.annotations![0]!.note).toBe(SHAPE_NOTE);
    expect(report.screenshots[0]!.annotations![0]!.element!.text).toBe("Owner [EMAIL]");
  });
});

describe("context.md from a report saved before masking", () => {
  const s = unmaskedLog();
  const old = oldReport(s);

  it("the fixture really is unmasked", () => {
    expect(occurrences(JSON.stringify(old.events), EMAIL)).toBeGreaterThan(8);
  });

  it("holds no address outside the notes, and masks email fields by type and label", () => {
    const md = buildPortableContext(old, "2026-10-28_100000_app-test").markdown;
    expect(occurrences(md, EMAIL)).toBe(2); // the Mark note and the shape note
    expect(md).toContain(NOTE);
    expect(md).toContain(SHAPE_NOTE);
    const json = JSON.parse(md.slice(md.indexOf("```json") + 7, md.lastIndexOf("```")));
    const fills = json.replay.filter((r: { do: string }) => r.do === "fill").map((r: { value: string }) => r.value);
    expect(fills).toEqual([MASK, MASK, "find [EMAIL]"]);
    expect(json.consoleErrors[0].message).toBe("Error: unknown [EMAIL]");
  });

  it("is the same text as a context built from the masked report", () => {
    const fresh = reportOf(s);
    expect(buildPortableContext(old, "x").markdown).toBe(buildPortableContext(fresh, "x").markdown);
  });
});

describe("helpers on old data", () => {
  it("maskEmailInput only touches unmasked input events of email fields", () => {
    const base = { type: "input", label: "Name", inputType: "text", value: "Ann", masked: false, truncated: false };
    expect(maskEmailInput(base)).toBe(base);
    expect(maskEmailInput({ ...base, label: "E-mail" })).toMatchObject({ value: MASK, masked: true });
    expect(maskEmailInput({ type: "click", label: "Email" })).toEqual({ type: "click", label: "Email" });
  });

  it("scrubEmailsDeep keeps every `note` and replaces everything else", () => {
    expect(scrubEmailsDeep({ note: EMAIL, a: [EMAIL, { note: EMAIL, b: EMAIL }], n: 1 })).toEqual({ note: EMAIL, a: ["[EMAIL]", { note: EMAIL, b: "[EMAIL]" }], n: 1 });
  });
});

describe("Copy portable context for an older recording", () => {
  const s = unmaskedLog();
  const old = oldReport(s);
  const oldCtx = `<details>${EMAIL} note: ${NOTE}</details>`;
  const entry = (extra: Partial<RecentSession> = {}): RecentSession => ({ id: "x", host: "app.test", startedAt: "", durationMs: 0, marks: 1, context: oldCtx, ...extra });
  // jsdom's Blob has no text(); the copy only needs that.
  const blob = (r: Report) => ({ text: async () => JSON.stringify(r) }) as Blob;

  it("rebuilds from report.json, notes kept", async () => {
    const text = await copyableContext(entry(), async () => blob(old));
    expect(text).toBe(buildPortableContext(old, "x").markdown);
    expect(occurrences(text, EMAIL)).toBe(2);
  });

  it("without a readable report, scrubs every address from the kept text", async () => {
    expect(await copyableContext(entry(), async () => null)).toBe("<details>[EMAIL] note: login as [EMAIL] fails</details>");
    expect(await copyableContext(entry(), async () => ({ text: async () => "not json" }) as Blob)).not.toContain(EMAIL);
    expect(storedContext(entry())).not.toContain(EMAIL);
  });

  it("a recording made with masking is copied as kept", async () => {
    const kept = `<details>${NOTE}</details>`;
    expect(await copyableContext(entry({ context: kept, emailsMasked: true }), async () => blob(old))).toBe(kept);
    expect(storedContext(entry({ context: kept, emailsMasked: true }))).toBe(kept);
  });
});
