// Adapted from TraceBug (MIT, Copyright (c) 2026 Prashant Singh Mangat): sanitizeUrl in src/collectors.ts
// and isSensitiveParamName in src/url-hygiene.ts.

const SENSITIVE_PARAM_RE = /token|key|secret|auth|password|passwd|pwd|credential|session|sid|csrf|sig|signature/i;
const URL_MAX = 500;

export const MASK = "[MASKED]";
export const EMAIL_MASK = "[EMAIL]";
// `@` may be URL-encoded once or twice. The last label must be letters, so `icon@2x.png` parts and `pkg@1.2.3` stay.
const EMAIL_RE = /[A-Za-z0-9._%+-]+(?:@|%40|%2540)(?!\d+x\.)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![A-Za-z0-9-])/gi;
/** Field names, labels and placeholders that mean "an email address goes here". */
const EMAIL_FIELD_RE = /e[-_ ]?mail|อีเมล/i;
// The tester's own Mark and shape notes: what they chose to write, so emails stay.
const NOTE_KEYS = new Set(["note"]);

export function scrubEmails(s: string): string {
  return s.replace(EMAIL_RE, EMAIL_MASK);
}

export function looksLikeEmailField(hint: string): boolean {
  return EMAIL_FIELD_RE.test(hint);
}

/** Tokens, emails and secret-shaped strings: for every captured string except the tester's notes and URLs. */
export function redactText(s: string): string {
  return redactValueText(s);
}

/** Every string in `value`, emails replaced, except `note` fields. Lets reports saved before email masking be re-used safely. */
export function scrubEmailsDeep<T>(value: T): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return scrubEmails(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, NOTE_KEYS.has(k) && typeof x === "string" ? x : walk(x)]));
    }
    return v;
  };
  return walk(value) as T;
}

/** An input event typed into an email field: value masked like a password, real length kept. */
export function maskEmailInput<T extends { type: string }>(e: T): T {
  const i = e as T & { inputType?: string; label?: string; value?: string; masked?: boolean; truncated?: boolean };
  if (i.type !== "input" || i.masked) return e;
  if (i.inputType !== "email" && !looksLikeEmailField(i.label ?? "")) return e;
  return { ...e, value: MASK, masked: true, truncated: false };
}

export function isSensitiveParamName(name: string): boolean {
  return SENSITIVE_PARAM_RE.test(name);
}

/** Mask values of sensitive query params and any email address; keeps everything else so the AI can still match routes. */
export function redactUrl(url: string): string {
  if (!url) return url;
  url = scrubEmails(url);
  try {
    const q = url.indexOf("?");
    if (q === -1) return url.slice(0, URL_MAX);
    const h = url.indexOf("#", q);
    const query = h === -1 ? url.slice(q + 1) : url.slice(q + 1, h);
    const hash = h === -1 ? "" : url.slice(h);
    const redacted = query
      .split("&")
      .map((part) => {
        const eq = part.indexOf("=");
        if (eq === -1) return part;
        let key = part.slice(0, eq);
        try {
          key = decodeURIComponent(key);
        } catch {
          /* keep raw */
        }
        return isSensitiveParamName(key) ? `${part.slice(0, eq)}=[REDACTED]` : part;
      })
      .join("&");
    return `${url.slice(0, q)}?${redacted}${hash}`.slice(0, URL_MAX);
  } catch {
    return url.slice(0, URL_MAX);
  }
}

/** Token shapes that must never land in a report, even inside an error message. */
export function scrubSecrets(s: string): string {
  return s
    .replace(/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+/g, "[REDACTED_JWT]")
    .replace(/(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]");
}

export function pagePath(loc: Pick<Location, "pathname" | "search" | "hash">): string {
  return redactUrl(`${loc.pathname}${loc.search}${loc.hash}`);
}

// Storage keys and JSON fields whose values are credentials or session state more often than not.
const SENSITIVE_KEY_RE = /token|auth|session|sessid|secret|passw|passcode|passphrase|pwd|key|jwt|cookie|credential|csrf|xsrf|bearer|refresh|access|signature|otp/i;
/** Whole words only, so `passenger`, `compass`, `pinned` and `consider` stay readable. */
const SENSITIVE_WORDS = new Set(["pass", "pw", "pin", "sid", "sig"]);
export const REDACTED = "[REDACTED]";

export function isSensitiveKey(key: string): boolean {
  if (SENSITIVE_KEY_RE.test(key)) return true;
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/);
  return words.some((w) => SENSITIVE_WORDS.has(w));
}

// Well-known credential prefixes: AWS key ids, OpenAI, GitHub, Slack, Google API, GitLab.
const KNOWN_SECRET_RE = /\b(?:(?:AKIA|ASIA)[A-Z0-9]{12,}|sk-[A-Za-z0-9_-]{16,}|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[bpas]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,}|glpat-[A-Za-z0-9_-]{16,})/g;

/** A 16+ character piece with letters and digits mixed (or 40+ of token characters), not plain words, not repetitive. */
function looksRandom(piece: string): boolean {
  if (/^[a-z]+([-_][a-z]+)*$/i.test(piece) || new Set(piece).size < 6) return false;
  // Names built from words and short numbers (checkout-step-2-continue, react-select-3-input) are not keys.
  if (/[-_]/.test(piece) && piece.split(/[-_]/).every((w) => /^[A-Za-z]*$/.test(w) || /^[0-9]{1,6}$/.test(w))) return false;
  return piece.length >= 40 || (/[0-9]/.test(piece) && /[A-Za-z]/.test(piece));
}

/** Base64 marks (`+`, trailing `=`) or a piece mixing cases with digits inside: the `/` is part of the token, not a path. */
function isOneToken(run: string): boolean {
  return /\+|=$/.test(run) || run.split(/[/.=]/).some((p) => p.length >= 8 && /[a-z]/.test(p) && /[A-Z]/.test(p) && /[A-Za-z][0-9]+[A-Za-z]/.test(p));
}

/**
 * Tokens, emails, known key prefixes and random-looking strings inside free text. Paths and host names are judged per
 * `/` or `.` piece, so `/projects/12345/edit` stays; a UUID or hex id counts as random and is hidden.
 */
export function redactValueText(s: string): string {
  return scrubEmails(scrubSecrets(s))
    .replace(KNOWN_SECRET_RE, REDACTED)
    .replace(/[A-Za-z0-9+/_=.-]{16,}/g, (run) =>
      isOneToken(run) ? (looksRandom(run) ? REDACTED : run) : run.split(/([/.=])/).map((p) => (p.length >= 16 && looksRandom(p) ? REDACTED : p)).join(""),
    );
}

const MAX_JSON_DEPTH = 10;

/**
 * A storage value as it may appear in shareable output: whole value redacted for a sensitive key, JSON redacted per
 * field (also JSON kept as a string inside JSON), other text by shape. JSON that does not parse is hidden whole.
 */
export function redactStorageValue(key: string, value: string, depth = 0): { value: string; redacted: boolean } {
  if (isSensitiveKey(key)) return { value: REDACTED, redacted: true };
  const t = value.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(t);
    } catch {
      // Cut at the size cap, or not JSON after all: its fields cannot be checked, so nothing of it is shown.
      return { value: REDACTED, redacted: true };
    }
    if (depth >= MAX_JSON_DEPTH) return { value: REDACTED, redacted: true };
    const out = JSON.stringify(redactJson(parsed, depth + 1));
    return { value: out, redacted: out !== JSON.stringify(parsed) };
  }
  const out = redactValueText(value);
  return { value: out, redacted: out !== value };
}

function redactJson(v: unknown, depth: number): unknown {
  if (typeof v === "string") return redactStorageValue("", v, depth).value;
  if (!v || typeof v !== "object") return v;
  if (depth >= MAX_JSON_DEPTH) return REDACTED;
  if (Array.isArray(v)) return v.map((x) => redactJson(x, depth + 1));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, isSensitiveKey(k) && x !== null && x !== "" ? REDACTED : redactJson(x, depth + 1)]));
}
