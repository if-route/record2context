import { fmtDuration, fmtLocalTime } from "./format";
import { readmeFor } from "./layout";

export const RECENT_KEY = "recent";
/** The Recordings page lists every entry; each keeps its context.md (at most 60 000 chars). */
export const RECENT_MAX = 200;

/** The session's copy in the recordings folder, written by the recording helper. */
export interface FolderCopy {
  /** Absolute session folder the helper reported, `<recordings folder>/<id>`. */
  dir?: string;
  /** Copying failed (or the helper was not set up): the recording is only in the extension's storage. */
  error?: string;
}

/** A finished session as the popup and the Recordings page list it (chrome.storage.local). */
export interface RecentSession {
  id: string;
  host: string;
  /** Start page, sensitive query values redacted. */
  startUrl?: string;
  startedAt: string;
  durationMs: number;
  marks: number;
  /** context.md, so it can be copied without reading the file back. */
  context: string;
  /** `context` was built with email masking; older entries are rebuilt or scrubbed before they are copied (`copyableContext`). */
  emailsMasked?: true;
  /** Every file of the session, as paths inside it (`details/report.json`, `mark-01.png`, ...). */
  paths?: string[];
  folderCopy?: FolderCopy;
  error?: string;
}

/** Not (successfully) in the recordings folder yet: what the background copies once the helper answers. */
export function needsFolderCopy(r: RecentSession): boolean {
  return !r.folderCopy?.dir || !!r.folderCopy.error;
}

export function addRecent(list: RecentSession[], entry: RecentSession, max = RECENT_MAX): RecentSession[] {
  return [entry, ...list.filter((r) => r.id !== entry.id)].slice(0, max);
}

export function updateEntry(list: RecentSession[], id: string, patch: Partial<RecentSession>): RecentSession[] {
  return list.map((r) => (r.id === id ? { ...r, ...patch } : r));
}

export function removeRecent(list: RecentSession[], ids: readonly string[]): RecentSession[] {
  return list.filter((r) => !ids.includes(r.id));
}

/** The absolute folder an AI can read: the copy in the recordings folder. */
export function folderPath(r: RecentSession): string | null {
  return r.folderCopy?.dir && !r.folderCopy.error ? r.folderCopy.dir : null;
}

/** "Copy for my AI": a neutral pointer, no instructions. Null when the recording is in no folder an AI can read. */
export function aiPointer(r: RecentSession): string | null {
  const path = folderPath(r);
  if (!path) return null;
  return `Browser recording of what I did on ${r.host} (${fmtDuration(r.durationMs)}, recorded ${fmtLocalTime(r.startedAt)}): ${path} — read ${readmeFor(r.paths)} there for the format.`;
}

export const NO_FOLDER_FOR_AI = "Not in the recordings folder yet: Save to folder first";

export function hostOf(url: string): string {
  try {
    return new URL(url).host || (url.startsWith("file:") ? "a local file" : "a page");
  } catch {
    return "a page";
  }
}

/** Where a recording's files can be read right now. */
export interface Where {
  /** In the extension's storage (report.json). */
  opfs: boolean;
  /** The copy in the recordings folder: there, missing, not checkable (helper not reachable), or never made. */
  folder: "yes" | "no" | "unknown" | "none";
}

export type WhereState = "both" | "extension" | "extension-unchecked" | "folder" | "folder-unchecked" | "missing";

export function whereState(w: Where): WhereState {
  if (w.opfs) return w.folder === "yes" ? "both" : w.folder === "unknown" ? "extension-unchecked" : "extension";
  if (w.folder === "yes") return "folder";
  if (w.folder === "unknown") return "folder-unchecked";
  return "missing";
}

/** Never "on disk" for a file that could not be read. */
export const WHERE_TEXT: Record<WhereState, string> = {
  both: "In extension + folder",
  extension: "In extension only",
  "extension-unchecked": "In extension (folder not checked)",
  folder: "In folder",
  "folder-unchecked": "In folder (not checked)",
  missing: "Files missing",
};

/** Something can be played or opened. */
export function isReadable(s: WhereState): boolean {
  return s === "both" || s === "extension" || s === "extension-unchecked" || s === "folder";
}

/** The entries the popup can offer: a recording with nothing left to read is left out. */
export function isGone(s: WhereState): boolean {
  return s === "missing";
}
