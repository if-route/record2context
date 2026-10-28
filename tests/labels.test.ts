// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { actionableTarget, buildSelector, elementLabel, isStableId, nearestHeading } from "../src/content/labels";

const $ = (sel: string) => document.querySelector(sel)!;

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("elementLabel fallback chain", () => {
  it("uses visible text first", () => {
    document.body.innerHTML = `<button aria-label="Close dialog">  Save   changes </button>`;
    expect(elementLabel($("button"))).toEqual({ label: "Save changes", source: "innerText" });
  });

  it.each([
    [`<button aria-label="Close"><svg></svg></button>`, "Close", "aria-label"],
    [`<span id="l">Due date</span><button aria-labelledby="l"></button>`, "Due date", "aria-labelledby"],
    [`<button title="Refresh"></button>`, "Refresh", "title"],
    [`<a href="/x"><img alt="Company logo"></a>`, "Company logo", "alt"],
    [`<button data-testid="export-btn"></button>`, "export-btn", "data-testid"],
  ])("falls back for icon-only controls: %s", (html, label, source) => {
    document.body.innerHTML = html;
    const el = $("button, a");
    expect(elementLabel(el)).toEqual({ label, source });
  });

  it("uses value for input buttons", () => {
    document.body.innerHTML = `<input type="submit" value="Sign in">`;
    expect(elementLabel($("input"))).toEqual({ label: "Sign in", source: "value" });
  });

  it("names fields by label, not by what was typed", () => {
    document.body.innerHTML = `<label for="e">Email</label><input id="e" value="a@b.c">`;
    expect(elementLabel($("input"))).toEqual({ label: "Email", source: "label" });
    document.body.innerHTML = `<label>Notes <textarea>typed text</textarea></label>`;
    expect(elementLabel($("textarea"))).toEqual({ label: "Notes", source: "label" });
    document.body.innerHTML = `<label>Unit <select><option>MWh</option><option>GWh</option></select></label>`;
    expect(elementLabel($("select"))).toEqual({ label: "Unit", source: "label" });
  });

  it("names a rich editor by the nearest heading before its content", () => {
    document.body.innerHTML = `
      <section><h3>SMC - Daily update</h3><div><div contenteditable="true"><p>Prices rose</p></div></div></section>
      <section><h3>SMC - End of day</h3></section>`;
    expect(elementLabel($("[contenteditable]"))).toEqual({ label: "SMC - Daily update", source: "heading" });
  });

  it("finds a card title far above a deeply nested editor (antd + Jodit nesting)", () => {
    const deep = (inner: string, n: number): string => (n ? `<div class="ant-col">${deep(inner, n - 1)}</div>` : inner);
    document.body.innerHTML = `<div class="card">
      ${deep(`<span class="core-heading"><h2>SMC - Daily update</h2></span>`, 5)}
      ${deep(`<div data-testid="x"><div class="jodit-container" contenteditable="false"><div class="jodit-workplace">
        <div class="jodit-wysiwyg" contenteditable="true"><p>check</p></div></div></div></div>`, 7)}
    </div>`;
    expect(elementLabel($(".jodit-wysiwyg"))).toEqual({ label: "SMC - Daily update", source: "heading" });
  });

  it("prefers placeholder for an editor when present", () => {
    document.body.innerHTML = `<div contenteditable="true" data-placeholder="Write a comment"></div>`;
    expect(elementLabel($("div"))).toEqual({ label: "Write a comment", source: "placeholder" });
  });

  it("uses a readable class hint, then the tag, so the label is never empty", () => {
    document.body.innerHTML = `<div class="css-1x2y3z nav-item__icon"><span></span></div>`;
    expect(elementLabel($("span"))).toEqual({ label: "nav item icon", source: "class" });
    document.body.innerHTML = `<div><i></i></div>`;
    expect(elementLabel($("i"))).toEqual({ label: "i", source: "tag" });
  });

  it("does not use the whole page text for clicks on html/body", () => {
    document.body.innerHTML = `<p>lots of text</p>`;
    expect(elementLabel(document.body)).toEqual({ label: "body", source: "tag" });
    expect(elementLabel(document.documentElement)).toEqual({ label: "html", source: "tag" });
  });

  it("caps long labels", () => {
    document.body.innerHTML = `<div>${"word ".repeat(100)}</div>`;
    expect(elementLabel($("div")).label.length).toBeLessThanOrEqual(120);
  });
});

describe("actionableTarget", () => {
  it("climbs from an icon to its button", () => {
    document.body.innerHTML = `<button id="b"><svg><path></path></svg></button>`;
    expect(actionableTarget($("path")).id).toBe("b");
  });
  it("keeps the element when nothing actionable is around it", () => {
    document.body.innerHTML = `<div><span id="s">x</span></div>`;
    expect(actionableTarget($("#s")).id).toBe("s");
  });
});

describe("nearestHeading", () => {
  it("never returns a heading that comes after the element", () => {
    document.body.innerHTML = `<div><span id="x"></span><h2>Later</h2></div>`;
    expect(nearestHeading($("#x"))).toBe("");
  });
});

describe("buildSelector", () => {
  it("prefers a test id", () => {
    document.body.innerHTML = `<button id="save" data-testid="save-btn">Save</button>`;
    expect(buildSelector($("button"))).toBe('[data-testid="save-btn"]');
  });

  it("uses a stable id but skips generated ones", () => {
    document.body.innerHTML = `<button id="save">Save</button>`;
    expect(buildSelector($("button"))).toBe("#save");
    expect(isStableId("rc-menu-uuid-38211-2-carbon")).toBe(false);
    expect(isStableId(":r3:")).toBe(false);
    expect(isStableId("item-1234567")).toBe(false);
    expect(isStableId("main-nav")).toBe(true);
  });

  it("uses name for form fields", () => {
    document.body.innerHTML = `<form><input name="email"><input name="password"></form>`;
    expect(buildSelector($("input[name=password]"))).toBe('input[name="password"]');
  });

  it("builds a unique path anchored at a stable ancestor", () => {
    document.body.innerHTML = `
      <ul id="menu"><li class="item"><a>One</a></li><li class="item"><a>Two</a></li></ul>
      <ul><li class="item"><a>Three</a></li></ul>`;
    const sel = buildSelector(document.querySelectorAll("#menu a")[1]);
    expect(document.querySelectorAll(sel)).toHaveLength(1);
    expect(document.querySelector(sel)!.textContent).toBe("Two");
    expect(sel.startsWith("#menu")).toBe(true);
  });

  it("ignores hashed class names", () => {
    document.body.innerHTML = `<div><p class="css-9ab3cd">a</p><p class="css-9ab3cd">b</p></div>`;
    const sel = buildSelector(document.querySelectorAll("p")[1]);
    expect(sel).not.toContain("css-9ab3cd");
    expect(document.querySelector(sel)!.textContent).toBe("b");
  });
});

describe("review-4 N2: labels are redacted before the 120-character cut", () => {
  it("a key across character 120 leaves no fragment", () => {
    document.body.innerHTML = `<button>${"Save ".repeat(23)}Zq8Lm3Np7Rt2Vx9Kb4Hd6Fj1</button>`;
    const { label } = elementLabel($("button"));
    expect(label.length).toBeLessThanOrEqual(120);
    expect(label).not.toMatch(/Zq8|Lm3/);
    expect(label).toContain("Save [RE");
  });
});
