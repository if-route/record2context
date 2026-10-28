// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INPUT_VALUE_MAX,
  InputTracker,
  MASK,
  contentEditableHost,
  describeField,
  fieldFromTarget,
  isSensitiveField,
} from "../src/content/inputs";

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector(sel) as unknown as T;

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("masking", () => {
  it.each([
    `<input type="password" name="x">`,
    `<input name="api_token">`,
    `<input id="clientSecret">`,
    `<input aria-label="One-time code">`,
    `<input autocomplete="cc-number">`,
    `<input name="user_pwd">`,
    `<input placeholder="PIN">`,
    `<input name="email">`,
  ])("masks %s", (html) => {
    document.body.innerHTML = html;
    expect(isSensitiveField($("input"))).toBe(true);
  });

  it.each([`<input name="compass">`, `<input name="footprint">`, `<input name="female">`, `<input name="spinner">`])(
    "does not mask %s",
    (html) => {
      document.body.innerHTML = html;
      expect(isSensitiveField($("input"))).toBe(false);
    },
  );

  it("never leaks a password value but keeps its true length", () => {
    document.body.innerHTML = `<input type="password" name="pw">`;
    $<HTMLInputElement>("input").value = "hunter2";
    expect(describeField($("input"))).toMatchObject({ value: MASK, valueLength: 7, masked: true, truncated: false });
  });

  it("masks a sensitive contenteditable", () => {
    document.body.innerHTML = `<div contenteditable="true" aria-label="Secret note">classified</div>`;
    expect(describeField($("div"))).toMatchObject({ value: MASK, masked: true, valueLength: 10 });
  });
});

describe("values", () => {
  it("truncates long values and reports the real length", () => {
    document.body.innerHTML = `<textarea name="notes"></textarea>`;
    $<HTMLTextAreaElement>("textarea").value = "x".repeat(450);
    const d = describeField($("textarea"));
    expect(d.value).toHaveLength(INPUT_VALUE_MAX);
    expect(d).toMatchObject({ valueLength: 450, truncated: true, masked: false, inputType: "textarea" });
  });

  it("reads a rich editor as text", () => {
    document.body.innerHTML = `<div class="jodit-wysiwyg" contenteditable="true"><p>Hello <b>world</b></p></div>`;
    expect(describeField($("div"))).toMatchObject({ inputType: "contenteditable", value: "Hello world", valueLength: 11 });
  });

  it("truncates a long rich editor", () => {
    document.body.innerHTML = `<div contenteditable="true">${"y".repeat(300)}</div>`;
    expect(describeField($("div"))).toMatchObject({ valueLength: 300, truncated: true });
  });

  it("reports select text and checkbox state", () => {
    document.body.innerHTML = `<select name="unit"><option value="a">MWh</option><option value="b" selected>GWh</option></select>
      <input type="checkbox" name="agree" checked>`;
    expect(describeField($("select"))).toMatchObject({ inputType: "select", value: "GWh" });
    expect(describeField($("input"))).toMatchObject({ inputType: "checkbox", value: "checked" });
  });
});

describe("contenteditable resolution", () => {
  it("resolves inner nodes to the outermost editing host", () => {
    document.body.innerHTML = `<div id="host" contenteditable="true"><p><span id="inner" contenteditable="true">x</span></p></div>`;
    expect(contentEditableHost($("#inner"))!.id).toBe("host");
    expect(fieldFromTarget($("#inner"))!.id).toBe("host");
  });
  it("returns null for plain elements", () => {
    document.body.innerHTML = `<div><span id="s">x</span></div>`;
    expect(fieldFromTarget($("#s"))).toBeNull();
  });
});

describe("InputTracker", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("debounces typing and stamps the last keystroke time", () => {
    document.body.innerHTML = `<input name="q">`;
    const input = $<HTMLInputElement>("input");
    const out: { value: string; at: number }[] = [];
    let now = 1000;
    const tr = new InputTracker((s, at) => out.push({ value: s.value, at }), 500, () => now);
    input.value = "h";
    tr.touch(input);
    now = 1100;
    input.value = "hi";
    tr.touch(input);
    vi.advanceTimersByTime(499);
    expect(out).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(out).toEqual([{ value: "hi", at: 1100 }]);
  });

  it("flushAll emits pending input immediately (before an Enter or a reload)", () => {
    document.body.innerHTML = `<input name="q">`;
    const input = $<HTMLInputElement>("input");
    const out: string[] = [];
    const tr = new InputTracker((s) => out.push(s.value));
    input.value = "search";
    tr.touch(input);
    tr.flushAll();
    vi.runAllTimers();
    expect(out).toEqual(["search"]);
  });
});

describe("secret shapes in an ordinarily named field (review-3 Q2)", () => {
  it("a pasted key is hidden, ordinary text stays", () => {
    document.body.innerHTML = `<input name="search" value="key sk-proj-PLANTEDTYPEDKEY1234567890 here"><input name="q" value="blue shoes size 42">`;
    expect(describeField($("input[name=search]")).value).toBe("key [REDACTED] here");
    expect(describeField($("input[name=q]")).value).toBe("blue shoes size 42");
  });
});
