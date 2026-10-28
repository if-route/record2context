// Where recordings live: every file goes to the extension's own storage (OPFS) first; after Stop the recording helper
// (native messaging host) copies the session to `<recordings folder>/<id>/`.
import { asDir, dirAt, hasFile, readFile, removePath, type DirLike } from "./fs";
import { HostClient, HostRequestError, HostUnavailable } from "./host";
import { REPORT_PATHS } from "./layout";
import { folderPath, type FolderCopy, type RecentSession, type Where } from "./recent";

const SESSIONS = "sessions";
export const NOT_SET_UP_ERROR = "the recording helper is not set up";

/** One connection per extension context; it closes itself when idle. */
export const host = new HostClient();

/** `<OPFS>/sessions`: one directory per session id. */
export async function opfsSessions(): Promise<DirLike> {
  const root = asDir(await navigator.storage.getDirectory());
  return (await dirAt(root, SESSIONS, true))!;
}

export async function opfsSession(id: string, create = false): Promise<DirLike | null> {
  return dirAt(await opfsSessions(), id, create);
}

/** Copies the session from OPFS into the recordings folder through the helper. Never throws: a failure is in `error`. */
export async function copySessionToFolder(id: string, client: HostClient = host): Promise<FolderCopy> {
  try {
    const src = await opfsSession(id);
    if (!src || !(await hasReport(src))) return { error: "not in the extension's storage" };
    return { dir: (await client.saveSession(id, src)).dir };
  } catch (e) {
    return { error: e instanceof HostUnavailable && e.kind === "missing" ? NOT_SET_UP_ERROR : (e as Error).message };
  }
}

/** Either layout: details/report.json, or report.json for a recording saved before details/ existed. */
export async function hasReport(dir: DirLike): Promise<boolean> {
  for (const p of REPORT_PATHS) if (await hasFile(dir, p).catch(() => false)) return true;
  return false;
}

/** The recording's report.json from whichever layout it was saved in; null when it cannot be read. */
export async function openReport(r: RecentSession, client: HostClient = host): Promise<Blob | null> {
  for (const p of REPORT_PATHS) {
    const blob = await openSessionFile(r, p, client);
    if (blob) return blob;
  }
  return null;
}

/**
 * Which recorded session folders still hold a report.json, wherever they were saved (an earlier recordings folder too):
 * one request for the whole list. Null when the helper cannot be reached.
 */
export async function folderPresence(list: RecentSession[], client: HostClient = host): Promise<Map<string, boolean> | null> {
  const dirs = list.map((r) => folderPath(r)).filter((d): d is string => !!d);
  if (!dirs.length) return new Map();
  try {
    const { found } = await client.exists(dirs);
    return new Map(dirs.map((d) => [d, found[d] === true]));
  } catch {
    return null;
  }
}

/** Where a recording can be read right now; `present` comes from one `folderPresence()` call. */
export async function locate(r: RecentSession, present: Map<string, boolean> | null): Promise<Where> {
  const opfs = await opfsSession(r.id).then((d) => (d ? hasReport(d) : false), () => false);
  const dir = folderPath(r);
  if (!dir) return { opfs, folder: "none" };
  if (!present) return { opfs, folder: "unknown" };
  return { opfs, folder: present.get(dir) ? "yes" : "no" };
}

/** A file of the recording: from OPFS, else from the recordings folder through the helper. Null when it cannot be read. */
export async function openSessionFile(r: RecentSession, file: string, client: HostClient = host): Promise<Blob | null> {
  const own = await opfsSession(r.id).catch(() => null);
  const f = own ? await readFile(own, file).catch(() => null) : null;
  if (f) return f;
  const dir = folderPath(r);
  if (!dir) return null;
  const type = file.endsWith(".webm") ? "video/webm" : file.endsWith(".png") ? "image/png" : "";
  return client.readFile(r.id, file, type, dir).catch(() => null);
}

/** What Delete could not remove, so the person can do it by hand. */
export interface DeleteOutcome {
  id: string;
  notDeleted: { what: string; error: string }[];
}

/** Removes the OPFS copy and, through the helper, the copy at the folder it was saved to (an earlier recordings folder too). */
export async function deleteSessionFiles(r: RecentSession, client: HostClient = host): Promise<DeleteOutcome> {
  const notDeleted: DeleteOutcome["notDeleted"] = [];
  await removePath(await opfsSessions(), r.id).catch((e: Error) => notDeleted.push({ what: "extension storage", error: e.message }));
  const dir = folderPath(r);
  if (dir) {
    await client.deleteSession(r.id, dir).catch((e: Error) =>
      notDeleted.push({
        what: dir,
        error:
          e instanceof HostUnavailable
            ? "the recording helper is not reachable"
            : e instanceof HostRequestError && e.code === "unknown-root"
              ? "it is in a folder the recording helper has not used, so it may not delete there"
              : e.message,
      }),
    );
  }
  return { id: r.id, notDeleted };
}
