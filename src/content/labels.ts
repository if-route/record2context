// Adapted from TraceBug (MIT, Copyright (c) 2026 Prashant Singh Mangat): buildSelector and fieldLabel in src/collectors.ts.
import { redactText, scrubEmails } from "../shared/redact";
import type { LabelSource } from "../shared/types";

const LABEL_MAX = 120;

const TEST_ID_ATTRS = ["data-testid", "data-test-id", "data-test", "data-cy", "data-qa"] as const;

const ACTIONABLE =
  "a[href],button,input,select,textarea,label,summary,option," +
  '[role="button"],[role="link"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],' +
  '[role="tab"],[role="option"],[role="checkbox"],[role="radio"],[role="switch"],[role="treeitem"],' +
  '[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]';

const EDITABLE = '[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]';

export function cssEscape(s: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(s);
  return s.replace(/^-?\d|[^a-zA-Z0-9_-]/g, (c) => `\\${c.codePointAt(0)!.toString(16)} `);
}

/** Redaction goes before the cut, so a clipped email or key cannot slip past the patterns. */
function clean(s: string | null | undefined): string {
  return redactText((s ?? "").replace(/\s+/g, " ").trim()).slice(0, LABEL_MAX);
}

function visibleText(el: Element): string {
  const it = (el as HTMLElement).innerText;
  // jsdom has no innerText; fall back to textContent so tests see the same chain.
  return clean(typeof it === "string" ? it : el.textContent);
}

/** The element a human meant: the nearest button/link/field around the raw event target. */
export function actionableTarget(target: Element): Element {
  return target.closest(ACTIONABLE) ?? target;
}

export function isEditable(el: Element): boolean {
  return !!el.closest?.(EDITABLE) || (el as HTMLElement).isContentEditable === true;
}

/** CSS-module / styled-components / emotion hashes are not stable or readable. */
export function isHashedClass(c: string): boolean {
  return (
    /^(css|sc|jsx|emotion|svelte|styled|tw)-[a-z0-9]+$/i.test(c) ||
    /[_-][a-zA-Z0-9]{5,}$/.test(c) && /\d/.test(c) ||
    /^[a-zA-Z]{1,3}[0-9][a-zA-Z0-9]{3,}$/.test(c)
  );
}

/** Ids that frameworks generate per render (rc-*, :r1:, uuids, long digit runs) are not stable. */
export function isStableId(id: string): boolean {
  if (!id) return false;
  if (/^:|:$/.test(id)) return false;
  if (/^(rc|react|radix|headlessui|mui|ember|ext-gen)[-_:]/i.test(id)) return false;
  if (/[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id)) return false;
  if (/\d{4,}/.test(id)) return false;
  return true;
}

function readableClasses(el: Element): string[] {
  const cn = typeof el.className === "string" ? el.className : el.getAttribute("class") ?? "";
  return cn.split(/\s+/).filter((c) => c && !isHashedClass(c));
}

function testIdOf(el: Element): { attr: string; value: string } | null {
  for (const attr of TEST_ID_ATTRS) {
    const v = el.getAttribute(attr);
    if (v) return { attr, value: v };
  }
  return null;
}

function unique(sel: string, root: ParentNode): boolean {
  try {
    return root.querySelectorAll(sel).length === 1;
  } catch {
    return false;
  }
}

/** One step of a selector path: tag, a readable class, and nth-of-type when siblings share the tag. */
function step(el: Element): string {
  let part = el.tagName.toLowerCase();
  const cls = readableClasses(el)[0];
  if (cls) part += `.${cssEscape(cls)}`;
  const parent = el.parentElement;
  if (parent) {
    const same = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
    if (same.length > 1) part += `:nth-of-type(${same.indexOf(el) + 1})`;
  }
  return part;
}

// A selector holding an email address would leak it, and `[EMAIL]` in its place would match nothing.
const hasEmail = (v: string) => scrubEmails(v) !== v;

function anchor(el: Element): string | null {
  const tid = testIdOf(el);
  if (tid && !hasEmail(tid.value)) return `[${tid.attr}="${tid.value.replace(/"/g, '\\"')}"]`;
  if (el.id && isStableId(el.id) && !hasEmail(el.id)) return `#${cssEscape(el.id)}`;
  return null;
}

/** Shortest stable, unique CSS selector: test id, stable id, name/aria-label, then a path up to an anchor. */
export function buildSelector(el: Element): string {
  const doc = el.ownerDocument;
  const own = anchor(el);
  if (own && unique(own, doc)) return own;

  const tag = el.tagName.toLowerCase();
  for (const attr of ["name", "aria-label", "placeholder"]) {
    const v = el.getAttribute(attr);
    if (v && !hasEmail(v)) {
      const sel = `${tag}[${attr}="${v.replace(/"/g, '\\"')}"]`;
      if (unique(sel, doc)) return sel;
    }
  }

  // Prefer a path anchored at a test id / stable id ancestor; otherwise the shortest unique path.
  const parts: string[] = [];
  let shortest: string | null = null;
  let node: Element | null = el;
  for (let depth = 0; node && node !== doc.documentElement && depth < 6; depth++) {
    const a = depth > 0 ? anchor(node) : null;
    if (a) {
      const sel = [a, ...parts].join(" > ");
      if (unique(sel, doc)) return sel;
    }
    parts.unshift(step(node));
    const sel = parts.join(" > ");
    if (!shortest && depth >= 1 && unique(sel, doc)) shortest = sel;
    if (node === doc.body) break;
    node = node.parentElement;
  }
  return shortest ?? parts.join(" > ");
}

function labelledBy(el: Element): string {
  const ids = el.getAttribute("aria-labelledby");
  if (!ids) return "";
  return clean(
    ids
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id))
      .filter(Boolean)
      .map((n) => visibleText(n!))
      .join(" "),
  );
}

/** A label's own text: a wrapping label also contains the control (and a select's options). */
function labelText(label: Element): string {
  const copy = label.cloneNode(true) as Element;
  copy.querySelectorAll("input,select,textarea,button,option").forEach((n) => n.remove());
  return clean(copy.textContent);
}

function associatedLabel(el: Element): string {
  const labels = (el as HTMLInputElement).labels;
  if (labels && labels.length) {
    const t = clean(Array.from(labels).map(labelText).join(" "));
    if (t) return t;
  }
  if (el.id) {
    try {
      const l = el.ownerDocument.querySelector(`label[for="${cssEscape(el.id)}"]`);
      if (l) return labelText(l);
    } catch {
      /* invalid id for a selector */
    }
  }
  const wrap = el.parentElement?.closest("label");
  return wrap ? labelText(wrap) : "";
}

/** A field's own name from its label elements, aria-labelledby and title (not a heading or class nearby). */
export function fieldLabelText(el: Element): string {
  return [associatedLabel(el), labelledBy(el), clean(el.getAttribute("title"))].filter(Boolean).join(" ");
}

const HEADING = 'h1,h2,h3,h4,h5,h6,[role="heading"],legend,caption,[class*="title" i],[class*="heading" i]';

/** The closest heading-like element that precedes `el` inside one of its ancestors. */
export function nearestHeading(el: Element, maxLevels = 16): string {
  let node: Element | null = el;
  for (let i = 0; node && i < maxLevels; i++) {
    const parent: Element | null = node.parentElement;
    if (!parent) break;
    const candidates = Array.from(parent.querySelectorAll(HEADING)).filter(
      (h) => !h.contains(el) && !el.contains(h) &&
        (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    );
    for (let j = candidates.length - 1; j >= 0; j--) {
      const t = visibleText(candidates[j]);
      if (t) return t;
    }
    node = parent;
  }
  return "";
}

function classHint(el: Element): string {
  let node: Element | null = el;
  for (let i = 0; node && i < 3; i++, node = node.parentElement) {
    const c = readableClasses(node)[0];
    if (c) return clean(c.replace(/[-_]+/g, " "));
  }
  return "";
}

export interface Label {
  label: string;
  source: LabelSource;
}

/**
 * Human label for a clicked element, tokens and email addresses removed; never empty. Fields and rich editors put their
 * name before innerText, because their innerText is what the user typed, not what it is.
 */
export function elementLabel(el: Element): Label {
  const attr = (name: string) => clean(el.getAttribute(name));
  const tag = el.tagName.toLowerCase();
  // A click that lands on the page itself: its innerText is the whole page, not a name.
  if (tag === "html" || tag === "body") return { label: tag, source: "tag" };
  const isField = tag === "input" || tag === "textarea" || tag === "select" || isEditable(el);
  const type = (el.getAttribute("type") ?? "").toLowerCase();
  const isButtonInput = tag === "input" && ["button", "submit", "reset"].includes(type);

  const textSteps: [LabelSource, () => string][] = [
    ["innerText", () => (tag === "input" || tag === "textarea" || tag === "select" ? "" : visibleText(el))],
    ["value", () => (isButtonInput ? attr("value") : "")],
  ];
  const nameSteps: [LabelSource, () => string][] = [
    ["aria-label", () => attr("aria-label")],
    ["aria-labelledby", () => labelledBy(el)],
    ["title", () => attr("title")],
    ["alt", () => attr("alt") || clean(el.querySelector("img[alt]")?.getAttribute("alt"))],
    ["placeholder", () => attr("placeholder") || attr("data-placeholder")],
    ["data-testid", () => clean(testIdOf(el)?.value)],
    ["label", () => associatedLabel(el)],
  ];
  const steps: [LabelSource, () => string][] = isField && !isButtonInput
    ? [...nameSteps, ["heading", () => nearestHeading(el)], ...textSteps]
    : [...textSteps, ...nameSteps, ["heading", () => nearestHeading(el)]];
  steps.push(["class", () => classHint(el)]);

  for (const [source, get] of steps) {
    const v = get();
    if (v) return { label: redactText(v), source };
  }
  return { label: tag, source: "tag" };
}
