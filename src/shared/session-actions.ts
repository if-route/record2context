import { buildPortableContext } from "./context";
import { HostUnavailable, type HostState } from "./host";
import type { DeleteResult, SaveToFolderReply } from "./messages";
import { NO_FOLDER_FOR_AI, aiPointer, folderPath, type RecentSession } from "./recent";
import { scrubEmails } from "./redact";
import type { Report } from "./report";
import { HELPER_PROBLEM, NOT_SET_UP, problemPrompt, setupPrompt } from "./setup";
import { host, openReport } from "./store";

export const SHOW_FOLDER_TITLE = "Opens the recording's folder in Finder (Explorer on Windows)";

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

export function actionButton(label: string, cls: string, run: () => Promise<string | void>, ms = 1500): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.textContent = label;
  b.onclick = async () => {
    const done = await run().catch((e: Error) => `Failed: ${e.message}`);
    b.textContent = done || label;
    if (done) setTimeout(() => (b.textContent = label), done.length > 30 ? Math.max(ms, 4000) : ms);
  };
  return b;
}

/** Opens the session folder in Finder through the helper; without the helper the path is copied instead. */
export async function showFolder(r: RecentSession): Promise<string | void> {
  const path = folderPath(r);
  if (!path) return "Not in the recordings folder yet";
  try {
    await host.reveal(r.id, path);
  } catch (e) {
    await copyText(path);
    return e instanceof HostUnavailable ? "Helper not set up: path copied" : `Could not open it (${(e as Error).message}): path copied`;
  }
}

/** The kept context, or for an entry saved before email masking: rebuilt from report.json, else every address scrubbed. */
export async function copyableContext(r: RecentSession, readReport = () => openReport(r)): Promise<string> {
  if (r.emailsMasked) return r.context;
  try {
    const blob = await readReport();
    if (blob) return buildPortableContext(JSON.parse(await blob.text()) as Report, r.id).markdown;
  } catch {
    /* unreadable or not JSON: fall back to the kept text */
  }
  return storedContext(r);
}

/** The kept context as it can be shown; older entries lose every address, notes included, since the text cannot be told apart. */
export function storedContext(r: RecentSession): string {
  return r.emailsMasked ? r.context : scrubEmails(r.context);
}

/** Copy for my AI, Copy portable context and Show folder. */
export function copyButtons(r: RecentSession): HTMLButtonElement[] {
  const ai = actionButton("Copy for my AI", "ai", async () => {
    const text = aiPointer(r);
    if (!text) return NO_FOLDER_FOR_AI;
    await copyText(text);
    return "Copied";
  });
  if (!aiPointer(r)) ai.title = NO_FOLDER_FOR_AI;
  const show = actionButton("Show folder", "show", () => showFolder(r));
  show.title = SHOW_FOLDER_TITLE;
  return [ai, actionButton("Copy portable context", "ctx", async () => (await copyText(await copyableContext(r)), "Copied")), show];
}

/** Asks the background to copy the recording into the recordings folder through the helper. */
export function saveToFolderButton(r: RecentSession, onDone: () => void): HTMLButtonElement {
  const b = actionButton("Save to folder", "save-folder", async () => {
    const copy = (await chrome.runtime.sendMessage({ kind: "save-to-folder", id: r.id })) as SaveToFolderReply;
    onDone();
    return copy.error ? `Not saved: ${copy.error}` : "Saved";
  });
  b.title = "Copy this recording into the recordings folder";
  return b;
}

/**
 * The one line shown while the helper is missing or broken, with the prompt for the person's AI; null when ready.
 * The prompt is also in `data-prompt`, so a test (or a person) can read it without the clipboard.
 */
export function setupLine(state: HostState): HTMLElement | null {
  if (state.state === "ready") return null;
  const prompt = state.state === "missing" ? setupPrompt() : problemPrompt(state.error);
  const box = document.createElement("div");
  box.className = "setup-line";
  box.dataset.testid = "setup-line";
  box.dataset.state = state.state;
  box.dataset.prompt = prompt;
  const text = document.createElement("span");
  text.textContent = state.state === "missing" ? NOT_SET_UP : HELPER_PROBLEM;
  text.title = state.error;
  const copy = actionButton("Copy", "go copy-setup", async () => (await copyText(prompt), "Copied — paste it to your AI"));
  copy.dataset.testid = "copy-setup";
  box.append(text, copy);
  return box;
}

export function deleteRecordings(ids: string[]): Promise<DeleteResult[]> {
  return chrome.runtime.sendMessage({ kind: "delete-recordings", ids }) as Promise<DeleteResult[]>;
}

/** What to tell the person after a delete: anything that could not be deleted, so they can do it by hand. */
export function deleteSummary(results: DeleteResult[]): string {
  const left = results.flatMap((r) => r.notDeleted);
  const head = results.length === 1 ? "Recording deleted." : `${results.length} recordings deleted.`;
  if (!left.length) return head;
  const where = left.map((f) => `${f.what} (${f.error})`).join("; ");
  return `${head} Not deleted, delete by hand: ${where}.`;
}

export const DELETE_QUESTION = "Delete this recording (extension storage and folder copy)?";

/** A Delete button that asks first, in place. */
export function deleteButton(r: RecentSession, onDone: (results: DeleteResult[]) => void): HTMLElement {
  const box = document.createElement("span");
  box.className = "delete";
  const ask = actionButton("Delete", "danger", async () => {
    const q = document.createElement("span");
    q.className = "confirm";
    q.textContent = DELETE_QUESTION;
    const yes = actionButton("Delete files", "danger confirm-yes", async () => {
      yes.disabled = true;
      onDone(await deleteRecordings([r.id]));
    });
    const no = actionButton("Cancel", "confirm-no", async () => void box.replaceChildren(ask));
    box.replaceChildren(q, yes, no);
  });
  box.append(ask);
  return box;
}
