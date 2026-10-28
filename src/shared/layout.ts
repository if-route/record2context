// Where each file of a recording goes. The top level holds only what a tester uploads (the video and their images);
// everything else is in details/, and raw page data in details/private-do-not-share/. Same layout in OPFS and on disk.
import { readFile, removePath, writeFile, type DirLike } from "./fs";

const pad = (n: number) => String(n).padStart(2, "0");

export const DETAILS = "details";
export const REPORT_FILE = `${DETAILS}/report.json`;
export const README_FILE = `${DETAILS}/AI-README.md`;
export const CONTEXT_FILE = `${DETAILS}/context.md`;
export const PRIVATE_DIR = `${DETAILS}/private-do-not-share`;
export const PRIVATE_README = `${PRIVATE_DIR}/README.txt`;

/** Recordings saved before details/ existed keep every file at the top. */
export const LEGACY_REPORT_FILE = "report.json";
export const LEGACY_README_FILE = "AI-README.md";
/** Where to look for a recording's report, newest layout first. */
export const REPORT_PATHS = [REPORT_FILE, LEGACY_REPORT_FILE] as const;

/** The image a tester uploads for Screenshot (mark) `n`: with the shapes when they drew, else the plain frame. Older recordings used `mark-NN.png`. */
export function markFile(n: number): string {
  return `screenshot-${pad(n)}.png`;
}

/** The plain frame of Screenshot (mark) `n`, kept only when shapes were drawn on the top-level copy. */
export function markOriginalFile(n: number): string {
  return `${DETAILS}/screenshots/screenshot-${pad(n)}-original.png`;
}

/** Unredacted storage at Start, a Mark or Stop. `label` is `start`, `mark-N` or `stop`. */
export function storageFile(n: number, label: string): string {
  return `${PRIVATE_DIR}/storage/${pad(n)}-${label}.json`;
}

/** Working copy of a snapshot's redacted summary until Stop puts it in report.json; dot-files are never copied. */
export function storageSummaryFile(n: number): string {
  return `${DETAILS}/.storage-${pad(n)}.json`;
}

export const BODY_ID_RE = /^b[a-z0-9]{1,12}-\d{1,7}$/;

export function bodyFile(id: string): string {
  return `${PRIVATE_DIR}/bodies/${id}.json`;
}

/** The README an AI should open first: details/AI-README.md, or AI-README.md for a recording in the old layout. */
export function readmeFor(paths: readonly string[] | undefined): string {
  return paths?.includes(README_FILE) ? README_FILE : LEGACY_README_FILE;
}

/** Continue on a Screenshot: the drawn copy becomes screenshot-NN.png and the plain frame moves to details/screenshots/. */
export async function placeMarkImages(
  dir: DirLike,
  n: number,
  shotFile: string,
  drawn: Blob | null,
): Promise<{ file: string; annotatedFile?: string }> {
  const top = markFile(n);
  const original = markOriginalFile(n);
  if (drawn) {
    const movedHere = shotFile !== original;
    if (movedHere) {
      const plain = await readFile(dir, shotFile);
      if (!plain) return { file: shotFile };
      await writeFile(dir, original, plain);
    }
    try {
      await writeFile(dir, top, drawn);
    } catch {
      // The plain frame is still at the top (OPFS writes are atomic), so the extra copy goes.
      if (movedHere) await removePath(dir, original).catch(() => undefined);
      return { file: movedHere ? shotFile : original, ...(movedHere ? {} : { annotatedFile: top }) };
    }
    return { file: original, annotatedFile: top };
  }
  // Re-edited after a reload and continued without shapes: the plain frame goes back to the top.
  if (shotFile === original) {
    const plain = await readFile(dir, original);
    if (!plain) return { file: original };
    await writeFile(dir, top, plain);
    await removePath(dir, original).catch(() => undefined);
  }
  return { file: top };
}

export const PRIVATE_README_TEXT = `Do not share or upload anything in this folder.

It holds raw data from the recorded page, as the recorder saw it, for an AI or a developer working on this computer:
- storage/: localStorage, sessionStorage and cookie names at Start, at each Mark and at Stop, with unredacted values.
- bodies/: request and response bodies of fetch/XHR calls (text types only, size-capped), one file per call, named by
  the bodyId of its network event in ../report.json.
report.json, context.md and "Copy portable context" never contain anything from this folder.
`;
