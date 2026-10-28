// The element under a shape on the live page: what a box or an arrow points at, kept compact for report.json.
import { redactText } from "../shared/redact";
import type { ElementInfo } from "../shared/types";
import { actionableTarget, buildSelector, elementLabel, isEditable } from "./labels";

const TEXT_MAX = 80;
const TEST_ID_ATTRS = ["data-testid", "data-test-id", "data-test", "data-cy", "data-qa"];
const TRANSPARENT = new Set(["transparent", "rgba(0, 0, 0, 0)"]);

/** The topmost page element at a viewport point, skipping the recorder's own overlay (`isOwn`). */
export function elementAt(x: number, y: number, isOwn: (el: Element) => boolean, doc: Document = document): Element | null {
  const stack = typeof doc.elementsFromPoint === "function" ? doc.elementsFromPoint(x, y) : [];
  return stack.find((el) => !isOwn(el)) ?? null;
}

function inheritedBackground(el: Element, view: Window): string | undefined {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const bg = view.getComputedStyle(p).backgroundColor;
    if (bg && !TRANSPARENT.has(bg)) return bg;
  }
  return undefined;
}

/** Label, selector, test id, role, a text snippet, the box and a few computed styles. Never reads field values. */
export function describeElement(raw: Element): ElementInfo {
  const el = actionableTarget(raw);
  const view = el.ownerDocument.defaultView ?? window;
  const tag = el.tagName.toLowerCase();
  const { label, source } = elementLabel(el);
  const rawTestId = TEST_ID_ATTRS.map((a) => el.getAttribute(a)).find(Boolean);
  const testId = rawTestId ? redactText(rawTestId) : undefined;
  const role = el.getAttribute("role") ?? undefined;
  const isField = tag === "input" || tag === "textarea" || tag === "select" || isEditable(el);
  const inner = (el as HTMLElement).innerText;
  const text = isField ? "" : redactText((typeof inner === "string" ? inner : el.textContent ?? "").replace(/\s+/g, " ").trim());
  let selector = tag;
  try {
    selector = buildSelector(el);
  } catch {
    /* keep the tag */
  }
  const r = el.getBoundingClientRect();
  const cs = view.getComputedStyle(el);
  const bg = cs.backgroundColor;
  const inherited = !bg || TRANSPARENT.has(bg) ? inheritedBackground(el, view) : undefined;
  return {
    tag,
    label: redactText(label),
    labelSource: source,
    selector,
    ...(testId ? { testId } : {}),
    ...(role ? { role } : {}),
    ...(text ? { text: text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX - 1)}…` : text } : {}),
    bbox: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
    style: {
      color: cs.color,
      backgroundColor: bg,
      ...(inherited ? { inheritedBackground: inherited } : {}),
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      display: cs.display,
      visibility: cs.visibility,
    },
    ...(tag === "iframe" ? { iframe: true as const } : {}),
  };
}

/** The element at a viewport point, described; null when only the recorder's overlay is there. */
export function elementInfoAt(x: number, y: number, isOwn: (el: Element) => boolean, doc: Document = document): ElementInfo | null {
  const el = elementAt(x, y, isOwn, doc);
  try {
    return el ? describeElement(el) : null;
  } catch {
    return null;
  }
}
