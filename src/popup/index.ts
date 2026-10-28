import { elapsedMs, isPaused } from "../shared/clock";
import type { HostState } from "../shared/host";
import { fmtDuration, fmtLocalTime } from "../shared/format";
import type { HostStatusReply, StartReply, StatusReply } from "../shared/messages";
import { RECENT_KEY, folderPath, isGone, whereState, type RecentSession, type WhereState } from "../shared/recent";
import { copyButtons, deleteButton, deleteSummary, setupLine } from "../shared/session-actions";
import { NOT_SET_UP_ERROR, folderPresence, locate } from "../shared/store";
import { NO_KEY, loadShortcutKeys, shortcutLines } from "../shared/shortcuts";

/** Only the newest few are checked; the popup shows the newest one that can still be read. */
const CHECKED = 10;

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const btn = $<HTMLButtonElement>("#action");
const status = $<HTMLParagraphElement>("#status");
const warning = $<HTMLParagraphElement>("#warning");
const folderLine = $<HTMLParagraphElement>("#folder");
const recentBox = $<HTMLElement>("#recent");
const recentList = $<HTMLUListElement>("#recent-list");
const deleted = $<HTMLParagraphElement>("#deleted");

function openPage(path: string): void {
  void chrome.tabs.create({ url: chrome.runtime.getURL(path) }).then(() => window.close());
}

$<HTMLAnchorElement>("#all").onclick = (e) => {
  e.preventDefault();
  openPage("recordings.html");
};

function send<T>(msg: unknown): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

/** `?tabId=` lets the E2E harness open this page in a tab and target another tab. */
async function targetTabId(): Promise<number | undefined> {
  const q = new URLSearchParams(location.search).get("tabId");
  if (q) return Number(q);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

/** Where recordings go, or the one line to hand to the person's AI when the helper is missing or broken. */
function renderHost(state: HostState): void {
  folderLine.dataset.state = state.state;
  const line = setupLine(state);
  if (line) {
    folderLine.className = "folder warn";
    folderLine.replaceChildren(line);
    return;
  }
  folderLine.className = "folder";
  folderLine.replaceChildren(`Saving to ${(state as { dir: string }).dir}`);
}

async function recentSessions(): Promise<RecentSession[]> {
  return ((await chrome.storage.local.get(RECENT_KEY))[RECENT_KEY] as RecentSession[] | undefined) ?? [];
}

function renderRecent(r: RecentSession | undefined, state: WhereState | undefined): void {
  renderLatest(r);
  recentList.replaceChildren();
  recentBox.hidden = !r;
  if (!r) return;
  const li = document.createElement("li");
  li.dataset.id = r.id;
  if (state) li.dataset.where = state;
  const meta = document.createElement("div");
  meta.className = "meta";
  const host = document.createElement("b");
  host.textContent = r.host;
  const marks = r.marks ? ` · ${r.marks} screenshot${r.marks === 1 ? "" : "s"}` : "";
  meta.append(host, ` · ${fmtDuration(r.durationMs)} · ${fmtLocalTime(r.startedAt)}${marks}`);
  const acts = document.createElement("div");
  acts.className = "acts";
  acts.append(
    ...copyButtons(r),
    deleteButton(r, (results) => {
      deleted.hidden = false;
      deleted.textContent = deleteSummary(results);
      void draw();
    }),
  );
  li.append(meta, acts);
  recentList.append(li);
}

async function draw(): Promise<void> {
  const list = (await recentSessions()).slice(0, CHECKED);
  const present = await folderPresence(list);
  for (const r of list) {
    const state = whereState(await locate(r, present));
    if (!isGone(state)) return renderRecent(r, state);
  }
  renderRecent(undefined, undefined);
}

function renderLatest(latest: RecentSession | undefined): void {
  warning.hidden = true;
  if (!latest) {
    status.textContent = "Records this tab: video, actions, network and your screenshots.";
    return;
  }
  const parts: string[] = [];
  if (latest.error) parts.push(`Last recording had a problem: ${latest.error}`);
  const path = folderPath(latest);
  if (path) parts.push(`Saved to ${path}/`);
  else if (latest.folderCopy?.error && latest.folderCopy.error !== NOT_SET_UP_ERROR) {
    warning.hidden = false;
    warning.textContent = `Not copied to the recordings folder: ${latest.folderCopy.error}. It is kept in the extension; open All recordings and use Save to folder.`;
  } else if (!latest.error) parts.push("Saved in the extension; it goes to the recordings folder once the helper is set up.");
  status.textContent = parts.join(" ");
}

function setStartAllowed(allowed: boolean): void {
  btn.disabled = !allowed;
  btn.dataset.blocked = String(!allowed);
  btn.title = allowed ? "" : "Set up the recording helper first: copy the line above to your AI";
}

async function startNow(): Promise<void> {
  btn.disabled = true;
  status.textContent = "Starting…";
  const tabId = await targetTabId();
  if (tabId === undefined) {
    status.textContent = "No active tab.";
    btn.disabled = false;
    return;
  }
  const r = await send<StartReply>({ kind: "start", tabId });
  if (r.setup) {
    renderHost(r.setup);
    setStartAllowed(false);
    status.textContent = "";
    return;
  }
  if (!r.ok) {
    status.textContent = r.error ?? "Could not start.";
    btn.disabled = false;
    return;
  }
  window.close();
}

/** Always shown: the keys as Chrome has them now (the person may have changed or cleared them). */
async function renderKeys(): Promise<void> {
  const list = $<HTMLUListElement>("#keys-list");
  const lines = shortcutLines(await loadShortcutKeys().catch(() => []));
  list.replaceChildren(
    ...lines.map(({ key, label }) => {
      const li = document.createElement("li");
      const kbd = document.createElement("kbd");
      kbd.textContent = key;
      if (key === NO_KEY) {
        kbd.className = "none";
        li.append(`${label}: `, kbd);
      } else li.append(kbd, label);
      return li;
    }),
  );
}

let hostOnce: Promise<HostStatusReply> | null = null;

async function render(): Promise<void> {
  const st = await send<StatusReply>({ kind: "status" });
  // Opening the popup is also a heartbeat, and copies anything still waiting for the folder (once per opening).
  hostOnce ??= send<HostStatusReply>({ kind: "host-status", reason: "popup", sync: st.status === "idle" }).then((h) => (renderHost(h), h));
  if (st.status === "idle") {
    btn.textContent = "Start recording";
    btn.className = "start";
    btn.onclick = () => void startNow();
    // Start only once the helper answered ready: a recording that cannot reach the folder is not started (Decision 11).
    await Promise.all([hostOnce.then((h) => setStartAllowed(h.state === "ready")), draw()]);
    return;
  }
  btn.disabled = false;
  recentBox.hidden = true;
  warning.hidden = true;
  if (st.status === "recording") {
    btn.textContent = "Stop recording";
    btn.className = "stop";
    status.textContent = `${st.clock && isPaused(st.clock) ? "Paused at" : "Recording"} ${fmtDuration(st.clock ? elapsedMs(st.clock) : 0)}`;
    btn.onclick = async () => {
      btn.disabled = true;
      status.textContent = "Saving…";
      await send({ kind: "stop" });
      await render();
    };
    return;
  }
  btn.disabled = true;
  btn.textContent = st.status === "starting" ? "Starting…" : "Saving…";
  status.textContent = "";
  setTimeout(() => void render(), 500);
}

void render();
void renderKeys();
