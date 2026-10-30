// Every recording, newest first, and a player for one of them. No server: the list comes from chrome.storage; files are
// read from the extension's storage (OPFS) first, else from the recordings folder through the recording helper.
import { fmtDuration, fmtLocalTime } from "../shared/format";
import type { DeleteResult } from "../shared/messages";
import { HostClient, HostRequestError, HostUnavailable, type HostState } from "../shared/host";
import { browserLine } from "../shared/private-view";
import { RECENT_KEY, WHERE_TEXT, isGone, isReadable, whereState, type RecentSession, type WhereState } from "../shared/recent";
import type { Report } from "../shared/report";
import { actionButton, copyButtons, deleteButton, deleteRecordings, deleteSummary, saveToFolderButton, setupLine, storedContext } from "../shared/session-actions";
import { folderPresence, locate, openReport, openSessionFile } from "../shared/store";
import type { RecEvent } from "../shared/types";
import { clear, h } from "./dom";
import { Player } from "./player";

const app = document.querySelector<HTMLElement>("#app")!;
const crumb = document.querySelector<HTMLElement>("#crumb")!;

let list: RecentSession[] = [];
let where = new Map<string, WhereState>();
let hostState: HostState = { state: "missing", error: "not checked yet" };
const selected = new Set<string>();
let message = "";
/** The recording open in the player; list updates do not rebuild it. */
let openId: string | null = null;
let blobUrls: string[] = [];

async function loadList(): Promise<void> {
  list = ((await chrome.storage.local.get(RECENT_KEY))[RECENT_KEY] as RecentSession[] | undefined) ?? [];
}

/** Its own connection, closed after each look, so a helper removed meanwhile shows as missing (a running one keeps answering). */
const poller = new HostClient();

/**
 * Whether the helper answers and can write (a ping, which writes a probe file: only on load, on focus and while not
 * ready), and which recordings' folders still exist (cheap, every few seconds).
 */
async function loadFolder(ping: boolean): Promise<Map<string, boolean> | null> {
  try {
    if (ping || hostState.state !== "ready") hostState = await poller.status();
    else hostState = { ...hostState, dir: (await poller.listSessions()).dir };
    return hostState.state === "missing" ? null : await folderPresence(list, poller);
  } catch (e) {
    hostState =
      e instanceof HostUnavailable && e.kind === "missing"
        ? { state: "missing", error: e.message }
        : { state: "broken", error: e instanceof HostRequestError || e instanceof HostUnavailable ? e.message : String(e) };
    return null;
  } finally {
    poller.close();
  }
}

/** True when any recording's state (or the helper's) changed. */
async function loadWhere(ping = false): Promise<boolean> {
  const before = hostState.state;
  const present = await loadFolder(ping);
  const next = new Map<string, WhereState>();
  for (const r of list) next.set(r.id, whereState(await locate(r, present)));
  const changed = before !== hostState.state || next.size !== where.size || [...next].some(([id, s]) => where.get(id) !== s);
  where = next;
  return changed;
}

function send<T>(msg: unknown): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

function stateOf(r: RecentSession): WhereState {
  return where.get(r.id) ?? "missing";
}

function stateCell(r: RecentSession): HTMLElement {
  const s = stateOf(r);
  return h("span", { class: `state state-${s}`, "data-state": s, title: r.folderCopy?.error ? `Not copied to the folder: ${r.folderCopy.error}` : "" }, WHERE_TEXT[s]);
}

function afterDelete(results: DeleteResult[]): void {
  message = deleteSummary(results);
  for (const r of results) selected.delete(r.id);
  if (openId && results.some((r) => r.id === openId)) location.hash = "";
  else void refresh();
}

function rowActions(r: RecentSession): (HTMLElement | string)[] {
  const s = stateOf(r);
  const canSave = s === "extension" && hostState.state === "ready";
  return [
    isReadable(s) ? h("a", { href: `#/r/${encodeURIComponent(r.id)}` }, h("button", { type: "button", class: "open" }, "Open")) : "",
    ...copyButtons(r),
    canSave ? saveToFolderButton(r, () => void refresh()) : "",
    deleteButton(r, afterDelete),
  ];
}

// ── List ───────────────────────────────────────────────────────────────────

function renderList(): void {
  openId = null;
  crumb.textContent = "";
  document.title = "record2context · Recordings";
  clear(app);
  const gone = list.filter((r) => isGone(stateOf(r))).map((r) => r.id);
  for (const id of [...selected]) if (!list.some((r) => r.id === id)) selected.delete(id);

  const bulk = h("span", { class: "bulk" });
  const deleteSelected = actionButton(`Delete selected (${selected.size})`, "danger", async () => {
    const ids = [...selected];
    const yes = actionButton("Delete files", "danger confirm-yes", async () => afterDelete(await deleteRecordings(ids)));
    const no = actionButton("Cancel", "confirm-no", async () => renderList());
    bulk.replaceChildren(h("span", { class: "confirm" }, `Delete ${ids.length} recording${ids.length === 1 ? "" : "s"} (extension storage and folder copies)?`), yes, no);
  });
  deleteSelected.disabled = selected.size === 0;
  deleteSelected.dataset.testid = "delete-selected";
  bulk.append(deleteSelected);
  const removeMissing = actionButton(`Remove missing from list (${gone.length})`, "", async () => {
    message = `Removed ${gone.length} recording${gone.length === 1 ? "" : "s"} whose files are gone from the list.`;
    await send({ kind: "forget-recordings", ids: gone });
  });
  removeMissing.disabled = gone.length === 0;
  const clearList = actionButton("Clear list", "", async () => {
    message = "List cleared. The files stay where they are.";
    await send({ kind: "forget-recordings" });
  });
  clearList.title = "Forget every entry; the files stay where they are";
  clearList.disabled = list.length === 0;

  app.append(
    h("h1", {}, "Recordings"),
    hostState.state === "ready"
      ? h("p", { class: "dim", "data-testid": "folder-line" }, `Saving to ${hostState.dir}`)
      : h("div", { class: "notice" }, setupLine(hostState), h("p", { class: "dim" }, "Recordings are kept in the extension until then; they are copied to the folder once the helper is set up.")),
    message ? h("p", { class: "notice", "data-testid": "message" }, message) : "",
    h(
      "div",
      { class: "toolbar" },
      h("span", { class: "dim" }, `${list.length} recording${list.length === 1 ? "" : "s"}, newest first`),
      h("span", { class: "spacer" }),
      bulk,
      removeMissing,
      clearList,
    ),
  );
  if (!list.length) {
    app.append(h("p", { class: "empty" }, "No recordings yet. Start one from the record2context toolbar button."));
    return;
  }
  const all = h("input", {
    type: "checkbox",
    title: "Select all",
    checked: list.length > 0 && selected.size === list.length,
    onchange: (e: Event) => {
      const on = (e.target as HTMLInputElement).checked;
      for (const r of list) on ? selected.add(r.id) : selected.delete(r.id);
      renderList();
    },
  });
  const rows = list.map((r) => {
    const pick = h("input", {
      type: "checkbox",
      checked: selected.has(r.id),
      onchange: (e: Event) => {
        if ((e.target as HTMLInputElement).checked) selected.add(r.id);
        else selected.delete(r.id);
        renderList();
      },
    });
    return h(
      "tr",
      { "data-id": r.id, class: isGone(stateOf(r)) ? "gone" : "" },
      h("td", {}, pick),
      h("td", {}, h("a", { href: `#/r/${encodeURIComponent(r.id)}`, class: "strong" }, r.host), r.startUrl ? h("span", { class: "start-url" }, r.startUrl) : ""),
      h("td", {}, fmtLocalTime(r.startedAt)),
      h("td", {}, fmtDuration(r.durationMs)),
      h("td", {}, r.marks),
      h("td", {}, stateCell(r)),
      h("td", {}, h("div", { class: "acts" }, ...rowActions(r))),
    );
  });
  app.append(
    h(
      "table",
      { class: "sessions" },
      h("thead", {}, h("tr", {}, h("th", {}, all), h("th", {}, "Recording"), h("th", {}, "Recorded"), h("th", {}, "Length"), h("th", {}, "Screenshots"), h("th", {}, "Files"), h("th", {}, ""))),
      h("tbody", {}, rows),
    ),
  );
}

// ── One recording ──────────────────────────────────────────────────────────

function releaseUrls(): void {
  for (const u of blobUrls) URL.revokeObjectURL(u);
  blobUrls = [];
}

async function renderRecording(r: RecentSession): Promise<void> {
  openId = r.id;
  message = "";
  releaseUrls();
  crumb.textContent = ` / ${r.id}`;
  document.title = `record2context · ${r.host} ${fmtLocalTime(r.startedAt)}`;
  clear(app);
  const marks = r.marks ? ` · ${r.marks} screenshot${r.marks === 1 ? "" : "s"}` : "";
  const s = stateOf(r);
  app.append(
    h(
      "div",
      { class: "head" },
      h("a", { href: "#" }, "← All recordings"),
      h("h1", {}, r.host),
      h("span", { class: "dim" }, `${fmtLocalTime(r.startedAt)} · ${fmtDuration(r.durationMs)}${marks} · `),
      stateCell(r),
      h("span", { class: "acts" }, ...copyButtons(r), s === "extension" && hostState.state === "ready" ? saveToFolderButton(r, () => void refresh()) : "", deleteButton(r, afterDelete)),
    ),
    r.startUrl ? h("p", { class: "dim url" }, r.startUrl) : "",
  );
  const contextOnly = (why: HTMLElement) =>
    app.append(why, h("h2", {}, "Portable context (kept by the extension)"), h("pre", { class: "context", "data-testid": "context" }, storedContext(r)));
  const open = (file: string) => openSessionFile(r, file);
  let report: Report;
  try {
    const blob = await openReport(r);
    if (!blob) throw new Error(s === "folder-unchecked" ? "the recording helper is not reachable" : "not found");
    report = JSON.parse(await blob.text()) as Report;
  } catch (e) {
    return contextOnly(h("div", { class: "notice", "data-testid": "report-missing" }, h("p", {}, `Could not read report.json: ${(e as Error).message}.`)));
  }
  if (openId !== r.id) return;
  // Blob URLs from disk-backed files: the video streams from storage, nothing is copied into memory.
  const urls = new Map<string, string>();
  const shots = (report.events as RecEvent[]).flatMap((e) => (e.type === "screenshot" ? [e.file, ...(e.annotatedFile ? [e.annotatedFile] : [])] : []));
  for (const file of [report.video?.file, ...shots]) {
    if (!file || urls.has(file)) continue;
    const blob = await open(file);
    if (!blob) continue;
    const u = URL.createObjectURL(blob);
    blobUrls.push(u);
    urls.set(file, u);
  }
  if (openId !== r.id) return;
  const player = new Player(report, (file) => urls.get(file) ?? "", open);
  const browser = browserLine(report.browser ?? {});
  if (browser) app.append(h("p", { class: "dim", "data-testid": "browser-line" }, browser));
  app.append(player.el);
  if (report.videoError) app.prepend(h("p", { class: "notice" }, `No video: ${report.videoError}`));
  else if (report.video && !urls.has(report.video.file)) app.prepend(h("p", { class: "notice", "data-testid": "video-missing" }, `Could not read ${report.video.file}.`));
}

// ── Routing and live updates ───────────────────────────────────────────────

function routeId(): string | null {
  const m = /^#\/r\/(.+)$/.exec(location.hash);
  return m ? decodeURIComponent(m[1]!) : null;
}

async function route(): Promise<void> {
  const id = routeId();
  const r = id ? list.find((x) => x.id === id) : undefined;
  if (r) await renderRecording(r);
  else {
    releaseUrls();
    renderList();
  }
}

/** Reloads the list and where each recording is; the player stays as it is. */
async function refresh(): Promise<void> {
  await loadList();
  await loadWhere();
  if (openId && list.some((r) => r.id === openId)) return;
  await route();
}

addEventListener("hashchange", () => void route());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[RECENT_KEY]) void refresh();
});
// Files can be deleted in Finder at any time; look again now and then.
setInterval(() => void loadWhere().then((changed) => (changed && !openId ? renderList() : undefined)), 5000);
addEventListener("focus", () => void loadWhere(true).then((changed) => (changed && !openId ? renderList() : undefined)));

void (async () => {
  await loadList();
  await loadWhere();
  await route();
})();
