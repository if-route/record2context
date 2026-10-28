// Adapted from TraceBug (MIT, Copyright (c) 2026 Prashant Singh Mangat): collectInputs, isSensitiveField,
// contentEditableHost in src/collectors.ts (contenteditable support from 1.11.1).
import { MASK, looksLikeEmailField, redactText } from "../shared/redact";
import { buildSelector, elementLabel, fieldLabelText } from "./labels";

export { MASK };
export const INPUT_VALUE_MAX = 200;

const SENSITIVE_TYPES = new Set(["password", "email"]);
// Long words match anywhere; short ones only as whole words (so "compass" or "footprint" stay visible).
const SHORT_WORDS = ["pass", "pwd", "otp", "ssn", "pin", "cvv", "cvc", "iban", "ccnum"];
const SENSITIVE_NAME_RE = new RegExp(
  "password|passwd|passcode|passphrase|secret|token|api[-_ ]?key|one[-_ ]?time|social[-_ ]?security|" +
    "credit[-_ ]?card|card[-_ ]?(number|no)(?![a-z])|" +
    SHORT_WORDS.map((w) => `(?:^|[^a-z0-9])${w}(?:[^a-z0-9]|$)`).join("|"),
  "i",
);
const SENSITIVE_AUTOCOMPLETE_RE = /^(current-password|new-password|one-time-code|cc-)|email|username/i;

const EDITABLE_SELECTOR = '[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]';

/** The editing host an event inside a rich editor belongs to (Jodit, Quill, ProseMirror, Lexical...). */
export function contentEditableHost(t: Element | null): HTMLElement | null {
  if (!t) return null;
  // Walk to the outermost editable so nested editable nodes report as one field.
  let host = t.closest<HTMLElement>(EDITABLE_SELECTOR);
  while (host?.parentElement) {
    const up = host.parentElement.closest<HTMLElement>(EDITABLE_SELECTOR);
    if (!up) break;
    host = up;
  }
  if (host) return host;
  return (t as HTMLElement).isContentEditable ? (t as HTMLElement) : null;
}

/** Name-ish attributes and the field's own label; any of them marking it sensitive masks the value. */
function nameHints(el: Element): string {
  return [...["name", "id", "aria-label", "placeholder", "data-placeholder", "data-testid", "autocomplete"].map((a) => el.getAttribute(a) ?? ""), fieldLabelText(el)].join(" ");
}

/** Passwords, secrets and email addresses: masked as `[MASKED]` with their real length. */
export function isSensitiveField(el: Element): boolean {
  const type = (el.getAttribute("type") ?? "").toLowerCase();
  if (SENSITIVE_TYPES.has(type)) return true;
  if (SENSITIVE_AUTOCOMPLETE_RE.test(el.getAttribute("autocomplete") ?? "")) return true;
  const hints = nameHints(el);
  return SENSITIVE_NAME_RE.test(hints) || looksLikeEmailField(hints);
}

export interface InputSnapshot {
  selector: string;
  label: string;
  tag: string;
  inputType: string;
  value: string;
  valueLength: number;
  masked: boolean;
  truncated: boolean;
}

function editableText(el: HTMLElement): string {
  const it = el.innerText;
  return typeof it === "string" ? it : el.textContent ?? "";
}

/** What a field holds right now, masked and truncated. `el` is an input/textarea/select or an editing host. */
export function describeField(el: HTMLElement): InputSnapshot {
  const tag = el.tagName.toLowerCase();
  const editable = !(tag === "input" || tag === "textarea" || tag === "select");
  const inputType = editable ? "contenteditable" : tag === "input" ? (el as HTMLInputElement).type || "text" : tag;
  let raw: string;
  if (editable) raw = editableText(el);
  else if (tag === "select") {
    const s = el as HTMLSelectElement;
    raw = Array.from(s.selectedOptions ?? [])
      .map((o) => o.text.trim() || o.value)
      .join(", ");
  } else if (inputType === "checkbox" || inputType === "radio") {
    raw = (el as HTMLInputElement).checked ? "checked" : "unchecked";
  } else raw = (el as HTMLInputElement).value ?? "";

  const masked = isSensitiveField(el);
  // Fields with ordinary names can still hold an address or a pasted key.
  const shown = masked ? MASK : redactText(raw);
  return {
    selector: safe(() => buildSelector(el), tag),
    label: elementLabel(el).label,
    tag,
    inputType,
    value: shown.slice(0, INPUT_VALUE_MAX),
    valueLength: raw.length,
    masked,
    truncated: !masked && shown.length > INPUT_VALUE_MAX,
  };
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** Resolve an `input`/`change` event target to the field it belongs to, or null. */
export function fieldFromTarget(t: Element | null): HTMLElement | null {
  if (!t) return null;
  const tag = t.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return t as HTMLElement;
  return contentEditableHost(t);
}

export const INPUT_DEBOUNCE_MS = 500;

/**
 * Debounced per-field input capture. `emit` gets the snapshot and the time of the last change,
 * so the logged `t` is when the user stopped typing, not when the timer fired.
 */
export class InputTracker {
  private pending = new Map<HTMLElement, { at: number; timer: ReturnType<typeof setTimeout> }>();

  constructor(
    private emit: (snap: InputSnapshot, at: number, el: HTMLElement) => void,
    private debounceMs = INPUT_DEBOUNCE_MS,
    private now: () => number = Date.now,
  ) {}

  touch(el: HTMLElement): void {
    const prev = this.pending.get(el);
    if (prev) clearTimeout(prev.timer);
    const at = this.now();
    const timer = setTimeout(() => this.flushOne(el), this.debounceMs);
    this.pending.set(el, { at, timer });
  }

  /** Emit immediately (select/checkbox changes are discrete, no typing to wait for). */
  immediate(el: HTMLElement): void {
    this.flushOne(el);
    this.emit(describeField(el), this.now(), el);
  }

  flushOne(el: HTMLElement): void {
    const p = this.pending.get(el);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(el);
    try {
      this.emit(describeField(el), p.at, el);
    } catch {
      /* element may be gone; nothing to report */
    }
  }

  flushAll(): void {
    for (const el of Array.from(this.pending.keys())) this.flushOne(el);
  }

  dispose(): void {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }
}
