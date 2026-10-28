// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { describeElement, elementAt, elementInfoAt } from "../src/content/element-info";

beforeEach(() => {
  document.body.innerHTML = "";
});

/** jsdom has no layout: elementsFromPoint returns a fixed stack. */
function stack(...els: Element[]) {
  (document as Document & { elementsFromPoint: (x: number, y: number) => Element[] }).elementsFromPoint = () => els;
}

describe("element under a shape", () => {
  it("skips the recorder's own overlay and takes the topmost page element", () => {
    document.body.innerHTML = `<record2context-ui></record2context-ui><div class="card"><button data-testid="save-btn" role="button" style="color: rgb(255, 0, 0); font-size: 14px; font-weight: 700">Save <b>now</b></button></div>`;
    const host = document.querySelector("record2context-ui")!;
    const b = document.querySelector("b")!;
    stack(host, b, document.querySelector(".card")!, document.body);
    expect(elementAt(5, 5, (el) => el === host)).toBe(b);
    const info = elementInfoAt(5, 5, (el) => el === host)!;
    // The <b> inside the button resolves to the button, as clicks do.
    expect(info).toMatchObject({ tag: "button", label: "Save now", labelSource: "innerText", testId: "save-btn", role: "button", text: "Save now" });
    expect(info.selector).toContain("save-btn");
    expect(info.style).toMatchObject({ color: "rgb(255, 0, 0)", fontSize: "14px", fontWeight: "700", display: "inline-block", visibility: "visible" });
    expect(info.bbox).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it("null when only the overlay is there", () => {
    const host = document.createElement("record2context-ui");
    document.body.append(host);
    stack(host);
    expect(elementInfoAt(1, 1, (el) => el === host)).toBeNull();
  });

  it("never reads what was typed into a field", () => {
    document.body.innerHTML = `<label for="pw">Password</label><input id="pw" type="password" value="hunter2"><div contenteditable="true">secret draft</div>`;
    const pw = describeElement(document.querySelector("input")!);
    expect(pw.label).toBe("Password");
    expect(pw.text).toBeUndefined();
    expect(JSON.stringify(pw)).not.toContain("hunter2");
    expect(describeElement(document.querySelector("[contenteditable]")!).text).toBeUndefined();
  });

  it("clips long text, scrubs tokens and names the background behind a transparent element", () => {
    document.body.innerHTML = `<div style="background-color: rgb(1, 2, 3)"><p>${"word ".repeat(40)} Bearer abcdefghijklmnop</p></div>`;
    const info = describeElement(document.querySelector("p")!);
    expect(info.text!.length).toBe(80);
    expect(info.text!.endsWith("…")).toBe(true);
    expect(info.style.inheritedBackground).toBe("rgb(1, 2, 3)");
    document.body.innerHTML = `<p>Token Bearer abcdefghijklmnop</p>`;
    expect(describeElement(document.querySelector("p")!).text).toBe("Token Bearer [REDACTED]");
  });

  it("flags an iframe (its content is out of reach from the top page)", () => {
    document.body.innerHTML = `<iframe title="Chart"></iframe>`;
    expect(describeElement(document.querySelector("iframe")!)).toMatchObject({ tag: "iframe", iframe: true, label: "Chart" });
  });
});
