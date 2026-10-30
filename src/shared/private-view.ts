// What the Recordings page shows from details/private-do-not-share/. Only src/recordings imports this: nothing that builds
// report.json, context.md, AI-README or copied text may (tests/private-view.test.ts checks that).
import { BODY_MAX, BODY_WAIT_MS, type BodyPart, type BodyRecord } from "./bodies";
import { BODY_ID_RE, PRIVATE_DIR, bodyFile } from "./layout";
import type { AreaSummary, RawArea, RawSnapshot, StorageSnapshot } from "./storage-snapshot";

/** A file of the open recording by its path inside the session; null when it cannot be read. */
export type ReadFile = (file: string) => Promise<Blob | null>;

export const PRIVATE_NOTE =
  "Private: unredacted page data from details/private-do-not-share/. It stays on this computer and is never part of Copy portable context, context.md or report.json.";

const STORAGE_FILE_RE = new RegExp(`^${PRIVATE_DIR}/storage/\\d+-[a-z0-9-]+\\.json$`);

async function readJson<T>(read: ReadFile, file: string): Promise<T | null> {
  try {
    const blob = await read(file);
    return blob ? (JSON.parse(await blob.text()) as T) : null;
  } catch {
    return null;
  }
}

/** The unredacted snapshot behind a report.json summary; null when there is none, it is gone or it is not JSON. */
export async function readPrivateSnapshot(snap: { privateFile?: string }, read: ReadFile): Promise<RawSnapshot | null> {
  // report.json is a file on disk: only a path into the private storage folder is followed.
  if (!snap.privateFile || !STORAGE_FILE_RE.test(snap.privateFile)) return null;
  const raw = await readJson<RawSnapshot>(read, snap.privateFile);
  return raw?.local && raw.session ? raw : null;
}

/** A network call's request and response bodies; null for a bad id or a file that cannot be read. */
export function readBodies(bodyId: string, read: ReadFile): Promise<BodyRecord | null> {
  return BODY_ID_RE.test(bodyId) ? readJson<BodyRecord>(read, bodyFile(bodyId)) : Promise.resolve(null);
}

export interface StorageRow {
  key: string;
  value: string;
  length: number;
  note?: string;
}

export interface AreaView {
  keys: number;
  rows: StorageRow[];
  error?: string;
}

export interface StorageView {
  /** `private`: the unredacted file was read; `redacted`: the values from report.json. */
  source: "private" | "redacted";
  local?: AreaView;
  session?: AreaView;
  cookieNames: string[];
  cookieError?: string;
}

function rawArea(a: RawArea): AreaView {
  return {
    keys: a.keys,
    rows: a.entries.map((e) => ({
      key: e.key,
      value: e.value ?? "",
      length: e.length,
      ...(e.value === null ? { note: "not kept: snapshot size limit" } : e.value.length < e.length ? { note: `first ${e.value.length} of ${e.length} chars` } : {}),
    })),
    ...(a.error ? { error: a.error } : {}),
  };
}

function summaryArea(a: AreaSummary): AreaView {
  return {
    keys: a.keys,
    rows: a.entries.map((e) => {
      const note = [e.redacted ? "redacted" : "", e.truncated ? "shortened" : ""].filter(Boolean).join(", ");
      return { key: e.key, value: e.value ?? "", length: e.length, ...(note ? { note } : {}) };
    }),
    ...(a.error ? { error: a.error } : {}),
  };
}

export function storageView(snap: Pick<StorageSnapshot, "local" | "session" | "cookieNames">, raw: RawSnapshot | null): StorageView {
  if (raw)
    return { source: "private", local: rawArea(raw.local), session: rawArea(raw.session), cookieNames: raw.cookieNames ?? [], ...(raw.cookieError ? { cookieError: raw.cookieError } : {}) };
  return {
    source: "redacted",
    ...(snap.local ? { local: summaryArea(snap.local) } : {}),
    ...(snap.session ? { session: summaryArea(snap.session) } : {}),
    cookieNames: snap.cookieNames ?? [],
  };
}

const PRIVATE_NOTE_MIXED =
  "Private: unredacted page data from details/private-do-not-share/ in the snapshots marked Private; the others are redacted, as in report.json (private file not found). It stays on this computer and is never part of Copy portable context, context.md or report.json.";

/** The line above the Storage tab's snapshots, true to what they show; null when none is private. */
export function storageNote(sources: StorageView["source"][]): string | null {
  const shown = sources.filter((s) => s === "private").length;
  return shown === 0 ? null : shown === sources.length ? PRIVATE_NOTE : PRIVATE_NOTE_MIXED;
}

/** `start`, `stop`, `mark-N` as people see them. */
export function snapshotLabel(label: string): string {
  const mark = /^mark-(\d+)$/.exec(label);
  return mark ? `Screenshot ${mark[1]}` : label === "start" ? "Start" : label === "stop" ? "Stop" : label;
}

function fmtBytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

export function bodyPartLabel(name: string, p: BodyPart | undefined): string {
  if (!p) return `${name}: no body`;
  if (p.skipped) return `${name}: not kept (${p.skipped})`;
  const cut = p.truncated === "size" ? ` (cut at ${fmtBytes(BODY_MAX)})` : p.truncated === "time" ? ` (stopped after ${BODY_WAIT_MS / 1000} s)` : "";
  return `${name}${p.contentType ? ` · ${p.contentType}` : ""} · ${fmtBytes(p.size ?? 0)}${cut}`;
}

/** Indenting grows with depth squared: a 24 KB `[[[…]]]` would be 288 M chars and crash the tab. */
export const PRETTY_MAX = 2 * 1024 * 1024;

/** JSON re-indented by its own tokens, so numbers keep every digit (JSON.parse would round big ids); other text as is. */
export function prettyBody(text: string): string {
  try {
    JSON.parse(text);
  } catch {
    return text;
  }
  let out = "";
  let depth = 0;
  const nl = () => `\n${"  ".repeat(depth)}`;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "{" || c === "[") {
      let j = i + 1;
      while (/\s/.test(text[j] ?? "")) j++;
      if (text[j] === (c === "{" ? "}" : "]")) {
        out += c + text[j];
        i = j;
      } else {
        depth++;
        out += c + nl();
      }
    } else if (c === "}" || c === "]") {
      depth--;
      out += nl() + c;
    } else if (c === ",") out += `,${nl()}`;
    else if (c === ":") out += ": ";
    else if (!/\s/.test(c)) out += c;
    if (out.length > PRETTY_MAX) return text;
  }
  return out;
}

/** What report.privateData says about bodies, for the Network tab. */
export function bodiesLine(pd: { bodies?: { saved: number; bytes: number; skipped: Record<string, number> } } | undefined): string | null {
  if (!pd?.bodies) return null;
  const { saved, bytes, skipped } = pd.bodies;
  const notKept = Object.entries(skipped).map(([why, n]) => `${n} ${why}`);
  return `Bodies kept for ${saved} call${saved === 1 ? "" : "s"} (${fmtBytes(bytes)})${notKept.length ? `; not kept: ${notKept.join("; ")}` : ""}. Open one with Body on its row.`;
}

function utcOffset(min: number): string {
  if (!min) return "UTC";
  const a = Math.abs(min);
  return `UTC${min < 0 ? "-" : "+"}${Math.floor(a / 60)}${a % 60 ? `:${String(a % 60).padStart(2, "0")}` : ""}`;
}

/** Language, locale and time zone at Start; null for a recording made before they were kept. */
export function browserLine(b: { language?: string; locale?: string; timeZone?: string; utcOffsetMinutes?: number }): string | null {
  const parts = [
    b.language ? `language ${b.language}` : "",
    b.locale ? `locale ${b.locale}` : "",
    b.timeZone ? `time zone ${b.timeZone}${b.utcOffsetMinutes !== undefined ? ` (${utcOffset(b.utcOffsetMinutes)})` : ""}` : "",
  ].filter(Boolean);
  return parts.length ? `Browser: ${parts.join(", ")}` : null;
}
