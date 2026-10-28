import { loadShortcutKeys } from "../shared/shortcuts";
import { isPaused, type VideoClock } from "../shared/clock";
import { syncSessionClock } from "../shared/clock-sync";
import { appendEvent, emptyLog } from "../shared/event-log";
import { dirAt, listFiles, readFile, removePath, writeFile, type DirLike } from "../shared/fs";
import { closePause, openPause, scrubAnnotations, setMarkNote, setMarkShot, type MarkState } from "../shared/marks";
import type {
  DeleteResult,
  HelloReply,
  HostStatusReply,
  OffscreenPauseReply,
  OffscreenStartReply,
  OffscreenStopReply,
  PauseReply,
  StartReply,
  StatusReply,
  ToBackground,
  ToOffscreen,
} from "../shared/messages";
import { buildAiReadme } from "../shared/ai-readme";
import { buildPortableContext } from "../shared/context";
import type { BodyRecord } from "../shared/bodies";
import {
  BODY_ID_RE,
  CONTEXT_FILE,
  PRIVATE_README,
  PRIVATE_README_TEXT,
  README_FILE,
  REPORT_FILE,
  bodyFile,
  markFile,
  placeMarkImages,
  storageFile,
  storageSummaryFile,
} from "../shared/layout";
import { pngSize, sessionId, videoFile } from "../shared/paths";
import { MAX_KEYS, MAX_SNAPSHOT, MAX_VALUE, collectPageStorage, summarizeSnapshot, type RawSnapshot, type StorageSnapshot } from "../shared/storage-snapshot";
import { redactUrl, scrubSecrets } from "../shared/redact";
import type { Heartbeat } from "../shared/host";
import { RECENT_KEY, addRecent, hostOf, needsFolderCopy, removeRecent, updateEntry, type FolderCopy, type RecentSession } from "../shared/recent";
import { buildReport, type BodyStats, type Report, type StopReason } from "../shared/report";
import { BUILD_ID } from "../shared/setup";
import { copySessionToFolder, deleteSessionFiles, host, opfsSession, opfsSessions } from "../shared/store";
import type { SessionEnv, VideoInfo } from "../shared/types";

const VERSION = chrome.runtime.getManifest().version;
const MAX_VIDEO_EDGE = 2560;
const STATE_KEY = "session";
const START_CHECK_MS = 5000;
const SNAPSHOT_MS = 3000;
/** How long Stop waits for snapshots and body files still being written. */
const SETTLE_MS = 3000;
const BODY_FILES_MAX = 500;
const BODY_BYTES_MAX = 20 * 1024 * 1024;

interface Session extends MarkState {
  status: "starting" | "recording" | "stopping";
  tabId: number;
  windowId: number;
  /** `<YYYY-MM-DD_HHmmss>_<host>`: the session's folder name in the extension's storage and in the recordings folder. */
  id: string;
  startUrl: string;
  videoStart: number;
  env: SessionEnv;
  pageLoads: number;
  stopReason: StopReason;
  /** Storage snapshots taken so far; each left a summary file in OPFS. */
  snapshots?: number;
  bodies?: BodyStats;
}

let session: Session | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

// chrome.storage.session survives service-worker restarts (not browser restarts).
const ready = chrome.storage.session.get(STATE_KEY).then((r) => {
  session = (r[STATE_KEY] as Session | undefined) ?? null;
  if (session?.status === "starting") session = null;
  if (session?.status === "stopping") void finalize();
});

function persistSoon(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistNow();
  }, 200);
}

async function persistNow(): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (session) await chrome.storage.session.set({ [STATE_KEY]: session });
  else await chrome.storage.session.remove(STATE_KEY);
}

const clockOf = (s: Session): VideoClock => ({ videoStart: s.videoStart, pauses: s.pauses });

function setBadge(text: string, color = "#dc2626"): void {
  void chrome.action.setBadgeText({ text });
  void chrome.action.setBadgeBackgroundColor({ color });
}

// ── Offscreen ──────────────────────────────────────────────────────────────

async function hasOffscreen(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
  return contexts.length > 0;
}

async function ensureOffscreen(): Promise<void> {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: "Record the tab with MediaRecorder across page reloads.",
  });
}

function toOffscreen<T>(msg: ToOffscreen): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

// ── Content scripts ────────────────────────────────────────────────────────

const SCRIPTS: chrome.scripting.RegisteredContentScript[] = [
  { id: "r2c-main", js: ["main.js"], matches: ["<all_urls>"], runAt: "document_start", allFrames: true, world: "MAIN", persistAcrossSessions: false },
  { id: "r2c-content", js: ["content.js"], matches: ["<all_urls>"], runAt: "document_start", allFrames: true, persistAcrossSessions: false },
];

async function registerScripts(): Promise<void> {
  await unregisterScripts();
  await chrome.scripting.registerContentScripts(SCRIPTS);
}

async function unregisterScripts(): Promise<void> {
  const existing = await chrome.scripting.getRegisteredContentScripts();
  const ids = existing.map((s) => s.id).filter((id) => id.startsWith("r2c-"));
  if (ids.length) await chrome.scripting.unregisterContentScripts({ ids });
}

// ── Start ──────────────────────────────────────────────────────────────────

function captureSize(width: number, height: number, dpr: number): { width: number; height: number } {
  let w = Math.round(width * dpr);
  let h = Math.round(height * dpr);
  const k = Math.min(1, MAX_VIDEO_EDGE / Math.max(w, h));
  // Even dimensions keep VP8/VP9 encoders happy.
  w = Math.max(2, Math.round((w * k) / 2) * 2);
  h = Math.max(2, Math.round((h * k) / 2) * 2);
  return { width: w, height: h };
}

async function start(tabId: number): Promise<StartReply> {
  await ready;
  if (session) return { ok: false, error: `Already ${session.status}.` };
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !/^(https?|file):/.test(tab.url)) return { ok: false, error: "This page cannot be recorded." };

  // Placeholder blocks a double Start while the async steps run.
  session = { status: "starting" } as Session;
  // A recording that cannot reach the folder is not started (Decision 11); short timeout, the gesture grant is waiting.
  const helper = await host.status(heartbeat("start"), START_CHECK_MS);
  if (helper.state !== "ready") {
    session = null;
    return { ok: false, setup: helper, error: helper.state === "missing" ? "The recording helper is not set up." : `The recording helper reports a problem: ${helper.error}` };
  }
  try {
    // Needs the gesture grant from the toolbar click; call it before anything slow.
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    const [{ result: page }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const intl = (() => {
          try {
            return Intl.DateTimeFormat().resolvedOptions();
          } catch {
            return null;
          }
        })();
        return {
          w: innerWidth,
          h: innerHeight,
          dpr: devicePixelRatio || 1,
          ua: navigator.userAgent,
          language: navigator.language,
          languages: [...(navigator.languages ?? [])],
          locale: intl?.locale,
          timeZone: intl?.timeZone,
          utcOffsetMinutes: -new Date().getTimezoneOffset(),
        };
      },
    });
    if (!page) throw new Error("Could not read the page viewport.");
    const platform = await chrome.runtime.getPlatformInfo();
    const id = await freshId(sessionId(new Date(), tab.url));
    await ensureOffscreen();
    const size = captureSize(page.w, page.h, page.dpr);
    const rec = await toOffscreen<OffscreenStartReply>({ target: "offscreen", kind: "rec-start", id, streamId, ...size });
    if (!rec?.ok || !rec.videoStart) throw new Error(rec?.error ?? "Recorder did not start.");

    session = {
      status: "recording",
      tabId,
      windowId: tab.windowId,
      id,
      startUrl: tab.url,
      videoStart: rec.videoStart,
      pauses: [],
      marks: 0,
      env: {
        userAgent: page.ua,
        os: platform.os,
        arch: platform.arch,
        viewport: { width: page.w, height: page.h },
        dpr: page.dpr,
        language: page.language,
        languages: page.languages,
        ...(page.locale ? { locale: page.locale } : {}),
        ...(page.timeZone ? { timeZone: page.timeZone } : {}),
        utcOffsetMinutes: page.utcOffsetMinutes,
      },
      pageLoads: 0,
      stopReason: "user",
      log: emptyLog(),
    };
    await persistNow();
    await registerScripts();
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["main.js"], world: "MAIN" });
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content.js"] });
    setBadge("REC");
    void track(snapshotStorage(session, "start"));
    return { ok: true };
  } catch (e) {
    session = null;
    await persistNow();
    await unregisterScripts().catch(() => undefined);
    if (await hasOffscreen()) await chrome.offscreen.closeDocument().catch(() => undefined);
    return { ok: false, error: (e as Error).message };
  }
}

// ── Mark / pause ───────────────────────────────────────────────────────────

// Pause and resume each wait on the offscreen document; one at a time so a double press cannot interleave.
let pauseChain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = pauseChain.then(fn, fn);
  pauseChain = next.catch(() => undefined);
  return next;
}

function pause(tabId: number | undefined, path: string): Promise<PauseReply> {
  return serial(async () => {
    const s = session;
    if (!s || s.status !== "recording" || tabId !== s.tabId) return { ok: false, error: "not recording" };
    if (isPaused(clockOf(s))) return { ok: true, clock: clockOf(s), markDraft: s.markDraft?.note ?? "", ...(s.markDraft?.shot ? { markShot: s.markDraft.shot } : {}) };
    const r = await toOffscreen<OffscreenPauseReply>({ target: "offscreen", kind: "rec-pause" }).catch((e: Error) => ({ ok: false, error: e.message, at: undefined }));
    if (!r?.ok || r.at === undefined) return { ok: false, error: r?.error ?? "recorder did not pause" };
    openPause(s, r.at, path);
    await persistNow();
    setBadge("❚❚", "#d97706");
    void track(snapshotStorage(s, `mark-${s.marks + 1}`));
    return { ok: true, clock: clockOf(s), markDraft: "" };
  });
}

function resume(tabId: number | undefined, note: string): Promise<PauseReply> {
  return serial(async () => {
    const s = session;
    if (!s || s.status !== "recording" || tabId !== s.tabId) return { ok: false, error: "not recording" };
    if (!isPaused(clockOf(s))) return { ok: true, clock: clockOf(s) };
    setMarkNote(s, note);
    const r = await toOffscreen<OffscreenPauseReply>({ target: "offscreen", kind: "rec-resume" }).catch((e: Error) => ({ ok: false, error: e.message, at: undefined }));
    if (!r?.ok || r.at === undefined) return { ok: false, error: r?.error ?? "recorder did not resume" };
    closePause(s, r.at);
    await persistNow();
    setBadge("REC");
    return { ok: true, clock: clockOf(s) };
  });
}

// ── Files ──────────────────────────────────────────────────────────────────

async function sessionDir(id: string): Promise<DirLike> {
  return (await opfsSession(id, true))!;
}

async function dataUrlBlob(dataUrl: string): Promise<Blob> {
  return (await fetch(dataUrl)).blob();
}

async function blobDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${blob.type || "image/png"};base64,${btoa(bin)}`;
}

// Snapshots and body files still being written; Stop waits for them (up to SETTLE_MS) before listing the files.
const pending = new Set<Promise<unknown>>();
function track<T>(p: Promise<T>): Promise<T> {
  pending.add(p);
  void p.finally(() => pending.delete(p)).catch(() => undefined);
  return p;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<never>((_, j) => (timer = setTimeout(() => j(new Error(what)), ms)))]).finally(() => clearTimeout(timer));
}

/** Storage of the recorded page: raw into the private folder, the redacted summary into a working file. Never throws. */
async function snapshotStorage(s: Session, label: string): Promise<void> {
  const n = (s.snapshots = (s.snapshots ?? 0) + 1);
  persistSoon();
  const at = Date.now();
  let summary: StorageSnapshot;
  try {
    const [res] = await withTimeout(
      chrome.scripting.executeScript({ target: { tabId: s.tabId, frameIds: [0] }, func: collectPageStorage, args: [MAX_KEYS, MAX_VALUE, MAX_SNAPSHOT] }),
      SNAPSHOT_MS,
      `the page did not answer within ${SNAPSHOT_MS / 1000} s`,
    );
    const raw = res?.result as RawSnapshot | undefined;
    if (!raw?.local) throw new Error("the page returned nothing");
    let privateFile: string | undefined = storageFile(n, label);
    await writeFile(await sessionDir(s.id), privateFile, `${JSON.stringify({ n, label, at: new Date(at).toISOString(), ...raw }, null, 2)}\n`).catch(() => (privateFile = undefined));
    summary = summarizeSnapshot(raw, { n, label, at, ...(privateFile ? { privateFile } : {}) });
  } catch (e) {
    summary = { n, label, at, error: String((e as Error)?.message ?? e).slice(0, 300) };
  }
  await writeFile(await sessionDir(s.id), storageSummaryFile(n), JSON.stringify(summary)).catch(() => undefined);
}

/** The summaries in snapshot order; their working files are removed once read. */
async function takeSnapshots(s: Session): Promise<StorageSnapshot[]> {
  const out: StorageSnapshot[] = [];
  const dir = await sessionDir(s.id);
  for (let n = 1; n <= (s.snapshots ?? 0); n++) {
    const file = storageSummaryFile(n);
    const blob = await readFile(dir, file).catch(() => null);
    if (!blob) continue;
    try {
      out.push(JSON.parse(await blob.text()) as StorageSnapshot);
    } catch {
      /* half-written at Stop: that snapshot is dropped */
    }
    await removePath(dir, file).catch(() => undefined);
  }
  return out;
}

/** One call's bodies into the private folder, within the per-recording caps; what is dropped is counted by reason. */
async function saveBody(s: Session, bodyId: string, body: BodyRecord): Promise<{ ok: boolean; skipped?: string }> {
  const stats = (s.bodies ??= { saved: [], bytes: 0, skipped: {} });
  const skip = (reason: string) => {
    stats.skipped[reason] = (stats.skipped[reason] ?? 0) + 1;
    persistSoon();
    return { ok: false, skipped: reason };
  };
  if (!BODY_ID_RE.test(bodyId) || stats.saved.includes(bodyId)) return skip("bad or repeated id");
  const json = `${JSON.stringify({ bodyId, ...body }, null, 2)}\n`;
  const bytes = new TextEncoder().encode(json).length;
  if (stats.saved.length >= BODY_FILES_MAX) return skip(`more than ${BODY_FILES_MAX} calls with bodies in one recording`);
  if (stats.bytes + bytes > BODY_BYTES_MAX) return skip(`more than ${BODY_BYTES_MAX / 1024 / 1024} MiB of bodies in one recording`);
  // Counted before the write, so calls arriving together cannot overshoot the caps.
  stats.saved.push(bodyId);
  stats.bytes += bytes;
  try {
    await writeFile(await sessionDir(s.id), bodyFile(bodyId), json);
  } catch {
    stats.saved = stats.saved.filter((id) => id !== bodyId);
    stats.bytes -= bytes;
    return skip("could not be written to the extension's storage");
  }
  persistSoon();
  return { ok: true };
}

/** A session id not used yet: two recordings started in the same second get `-2`, `-3`, ... */
async function freshId(base: string): Promise<string> {
  const root = await opfsSessions();
  for (let n = 1; ; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    if (!(await dirAt(root, id))) return id;
  }
}

/** The text files, then the copy to the recordings folder. The video is already in the session's OPFS folder. */
async function saveSessionFiles(s: Session, report: Report, videoError: string | undefined): Promise<RecentSession> {
  const errors: string[] = [];
  const context = buildPortableContext(report, s.id).markdown;
  const dir = await sessionDir(s.id);
  const files: [string, string][] = [
    [REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`],
    [README_FILE, buildAiReadme(report, s.id)],
    [CONTEXT_FILE, context],
    [PRIVATE_README, PRIVATE_README_TEXT],
  ];
  for (const [name, text] of files) await writeFile(dir, name, text).catch((e: Error) => errors.push(`${name}: ${e.message}`));
  if (videoError) errors.push(`video: ${videoError}`);
  const paths = (await listFiles(dir)).filter((f) => !f.split("/").pop()!.startsWith("."));
  const folderCopy = await copySessionToFolder(s.id);
  return {
    id: s.id,
    host: hostOf(s.startUrl),
    startUrl: scrubSecrets(redactUrl(s.startUrl)),
    startedAt: report.startedAt,
    durationMs: report.durationMs,
    marks: report.marks.length,
    context,
    emailsMasked: true,
    paths,
    folderCopy,
    ...(errors.length ? { error: errors.join("; ") } : {}),
  };
}

async function recentList(): Promise<RecentSession[]> {
  return ((await chrome.storage.local.get(RECENT_KEY))[RECENT_KEY] as RecentSession[] | undefined) ?? [];
}

// Saving and deleting both rewrite the list; one at a time so neither loses the other's change.
let recentChain: Promise<unknown> = Promise.resolve();
function updateRecent<T>(fn: (list: RecentSession[]) => Promise<{ list: RecentSession[]; result: T }>): Promise<T> {
  const next = recentChain.then(async () => {
    const current = await recentList();
    const { list, result } = await fn(current);
    if (list !== current) await chrome.storage.local.set({ [RECENT_KEY]: list });
    return result;
  });
  recentChain = next.catch(() => undefined);
  return next;
}

async function rememberSession(entry: RecentSession): Promise<void> {
  await updateRecent(async (list) => ({ list: addRecent(list, entry), result: undefined }));
}

const copying = new Map<string, Promise<FolderCopy>>();

/** Copies one recording to the folder and records the outcome; a second request while one runs gets the same result. */
function saveToFolder(id: string): Promise<FolderCopy> {
  let p = copying.get(id);
  if (!p) {
    p = (async () => {
      const folderCopy = await copySessionToFolder(id);
      await updateRecent(async (list) => ({ list: updateEntry(list, id, { folderCopy }), result: undefined }));
      return folderCopy;
    })().finally(() => copying.delete(id));
    copying.set(id, p);
  }
  return p;
}

let syncing: Promise<void> | null = null;

/** Copies every recording that is in the extension's storage but not in the folder yet (helper was missing or failed). */
function syncPending(): Promise<void> {
  syncing ??= (async () => {
    for (const r of await recentList()) {
      if (!needsFolderCopy(r)) continue;
      const own = await opfsSession(r.id).catch(() => null);
      if (!own) continue;
      const copy = await saveToFolder(r.id);
      // The helper went away mid-way: the rest would fail the same way.
      if (copy.error) break;
    }
  })().finally(() => (syncing = null));
  return syncing;
}

function heartbeat(reason: string): Heartbeat {
  return { extensionId: chrome.runtime.id, extensionVersion: VERSION, buildId: BUILD_ID, reason };
}

/** Pings the helper (it records the heartbeat in its status file); when it is ready, copies what is pending. */
async function hostStatus(reason: string, sync: boolean): Promise<HostStatusReply> {
  const state = await host.status(heartbeat(reason));
  if (state.state === "ready" && sync) void syncPending();
  return state;
}

/** Removes every copy the extension can reach (its storage, the recordings folder through the helper) and drops the entries. */
async function deleteRecordings(ids: string[]): Promise<DeleteResult[]> {
  return updateRecent(async (list) => {
    const results: DeleteResult[] = [];
    for (const r of list.filter((x) => ids.includes(x.id))) results.push(await deleteSessionFiles(r));
    return { list: removeRecent(list, ids), result: results };
  });
}

let finalizing: Promise<void> | null = null;

async function stop(reason: StopReason = "user", note?: string): Promise<void> {
  await ready;
  if (!session || session.status !== "recording") return finalizing ?? undefined;
  if (note !== undefined) setMarkNote(session, note);
  session.status = "stopping";
  session.stopReason = reason;
  await persistNow();
  setBadge("…", "#6b7280");
  await finalize();
}

function finalize(): Promise<void> {
  finalizing ??= doFinalize().finally(() => (finalizing = null));
  return finalizing;
}

async function doFinalize(): Promise<void> {
  const s = session;
  if (!s) return;
  // Before the scripts go: the page is still there unless its tab was closed (then the snapshot records why).
  await snapshotStorage(s, "stop");
  await unregisterScripts().catch(() => undefined);
  // Let every frame flush pending input before the log is closed.
  await chrome.tabs.sendMessage(s.tabId, { kind: "stopping" }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 300));

  const stoppedAt = Date.now();
  await Promise.race([Promise.allSettled([...pending]), new Promise((r) => setTimeout(r, SETTLE_MS))]);
  const storage = await takeSnapshots(s).catch(() => []);
  let video: VideoInfo | null = null;
  let videoError: string | undefined;
  let res: OffscreenStopReply | undefined;
  try {
    res = await toOffscreen<OffscreenStopReply>({ target: "offscreen", kind: "rec-stop" });
  } catch (e) {
    videoError = `recorder unreachable: ${(e as Error).message}`;
  }
  if (res?.ok && res.file) {
    video = {
      file: videoFile(s.id),
      mimeType: res.mimeType ?? "video/webm",
      width: res.width ?? 0,
      height: res.height ?? 0,
      durationMs: res.durationMs ?? 0,
      sizeBytes: res.sizeBytes ?? 0,
      seekableFix: !!res.seekableFix,
      ...(res.fixError ? { fixError: res.fixError } : {}),
    };
  } else if (!videoError) videoError = res?.error ?? "no video";

  // Stopped while paused: the video ends at the pause point and the note typed so far is kept.
  closePause(s, stoppedAt);
  const synced = syncSessionClock(clockOf(s), s.log, res?.sync, res?.syncError ?? videoError ?? "no video");
  const report = buildReport({
    version: VERSION,
    clock: synced.clock,
    clockSync: synced.report,
    stoppedAt,
    stopReason: s.stopReason,
    startUrl: s.startUrl,
    env: s.env,
    video,
    videoError,
    log: s.log,
    storage,
    bodies: s.bodies ?? { saved: [], bytes: 0, skipped: {} },
  });
  if (await hasOffscreen()) await chrome.offscreen.closeDocument().catch(() => undefined);
  const saved = await saveSessionFiles(s, report, videoError);

  await rememberSession(saved);
  session = null;
  await persistNow();
  setBadge("");
  await chrome.tabs.sendMessage(s.tabId, { kind: "stopped" }).catch(() => undefined);
  if (!saved.folderCopy?.error) void syncPending();
}

// ── Messages ───────────────────────────────────────────────────────────────

async function handle(msg: ToBackground, sender: chrome.runtime.MessageSender): Promise<unknown> {
  await ready;
  const tabId = sender.tab?.id;
  switch (msg.kind) {
    case "start":
      return start(msg.tabId);
    case "stop":
      await stop("user", msg.note);
      return { ok: true };
    case "pause":
      return pause(tabId, msg.path);
    case "resume":
      return resume(tabId, msg.note);
    case "hud-tick":
      if (session?.status === "recording" && tabId === session.tabId) {
        void toOffscreen({ target: "offscreen", kind: "rec-tick", at: msg.at, rect: msg.rect, viewport: msg.viewport }).catch(() => undefined);
      }
      return { ok: true };
    case "mark-note": {
      if (!session || tabId !== session.tabId || !session.markDraft) return { ok: false };
      setMarkNote(session, msg.note);
      persistSoon();
      return { ok: true };
    }
    case "mark-request":
      if (session?.status === "recording" && tabId === session.tabId) await requestMark(session.tabId);
      return { ok: true };
    case "status": {
      const reply: StatusReply = session
        ? { status: session.status, clock: clockOf(session), tabId: session.tabId, id: session.id }
        : { status: "idle" };
      return reply;
    }
    case "hello": {
      if (!session || session.status !== "recording" || tabId !== session.tabId) return { recording: false } satisfies HelloReply;
      const isTopFrame = sender.frameId === 0;
      const initial = isTopFrame && session.pageLoads === 0;
      if (isTopFrame) {
        session.pageLoads++;
        persistSoon();
      }
      // Read on every page load: the person may have changed a key at chrome://extensions/shortcuts.
      const keys = isTopFrame ? await loadShortcutKeys().catch(() => undefined) : undefined;
      return {
        recording: true,
        clock: clockOf(session),
        ...(keys ? { keys } : {}),
        initial,
        ...(session.markDraft ? { markDraft: session.markDraft.note } : {}),
        ...(session.markDraft?.shot ? { markShot: session.markDraft.shot } : {}),
      } satisfies HelloReply;
    }
    case "body": {
      if (!session || session.status !== "recording" || tabId !== session.tabId) return { ok: false };
      return track(saveBody(session, msg.bodyId, msg.body));
    }
    case "events": {
      if (!session || session.status === "starting" || tabId !== session.tabId) return { ok: false };
      for (const raw of msg.events) appendEvent(session.log, raw);
      persistSoon();
      return { ok: true };
    }
    case "capture": {
      if (!session || tabId !== session.tabId) return { error: "not recording" };
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab(session.windowId, { format: "png" });
        return { dataUrl };
      } catch (e) {
        return { error: (e as Error).message };
      }
    }
    case "mark-shot": {
      const s = session;
      if (!s || tabId !== s.tabId || !s.markDraft) return { error: "not paused" };
      // Its number is the mark's own, assigned when this pause closes.
      const file = markFile(s.marks + 1);
      let size: { width: number; height: number } | null = null;
      try {
        const blob = await dataUrlBlob(msg.dataUrl);
        size = pngSize(new Uint8Array(await blob.slice(0, 24).arrayBuffer()));
        await writeFile(await sessionDir(s.id), file, blob);
      } catch (e) {
        return { error: (e as Error).message };
      }
      setMarkShot(s, { file, viewport: msg.viewport, imageWidth: size?.width ?? 0, imageHeight: size?.height ?? 0 });
      await persistNow();
      return { file };
    }
    case "mark-shot-image": {
      const shot = session?.markDraft?.shot;
      if (!session || tabId !== session.tabId || !shot) return { error: "no mark screenshot" };
      const blob = await readFile(await sessionDir(session.id), shot.file).catch(() => null);
      return blob ? { dataUrl: await blobDataUrl(blob), shot } : { error: "screenshot missing" };
    }
    case "mark-annotations": {
      const s = session;
      const shot = s?.markDraft?.shot;
      if (!s || tabId !== s.tabId || !shot) return { error: "no mark screenshot" };
      const annotations = scrubAnnotations(msg.annotations ?? []);
      const drawn = msg.annotatedDataUrl ? await dataUrlBlob(msg.annotatedDataUrl).catch(() => null) : null;
      const placed = await placeMarkImages(await sessionDir(s.id), s.marks + 1, shot.file, drawn).catch(() => ({ file: shot.file }) as { file: string; annotatedFile?: string });
      const annotated = placed.annotatedFile;
      const { annotatedFile: _old, ...plain } = shot;
      setMarkShot(s, { ...plain, file: placed.file, annotations, ...(annotated ? { annotatedFile: annotated } : {}) });
      await persistNow();
      return { ok: true, ...(annotated ? { file: annotated } : {}) };
    }
    case "rec-ended":
      void stop("capture-ended");
      return { ok: true };
    case "delete-recordings":
      return deleteRecordings(msg.ids);
    case "save-to-folder":
      return saveToFolder(msg.id);
    case "forget-recordings": {
      const ids = msg.ids;
      await updateRecent(async (list) => ({ list: ids ? removeRecent(list, ids) : [], result: undefined }));
      return { ok: true };
    }
    case "host-status":
      return hostStatus(msg.reason, !!msg.sync);
  }
}

chrome.runtime.onMessage.addListener((msg: ToBackground | ToOffscreen, sender, sendResponse) => {
  if (!msg || (msg as ToOffscreen).target === "offscreen") return false;
  handle(msg as ToBackground, sender).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
  return true;
});

// Every worker start (install, browser start, any wake) proves Chrome -> extension -> helper -> disk in the helper's status file.
void ready.then(() => hostStatus("worker-start", true));

chrome.tabs.onRemoved.addListener((tabId) => {
  void ready.then(() => {
    if (session?.status === "recording" && session.tabId === tabId) void stop("tab-closed");
  });
});

/** The shortcut has no UI of its own: show the popup with the setup line, else the Recordings page (it has the same line). */
async function showSetup(): Promise<void> {
  try {
    await chrome.action.openPopup();
  } catch {
    await chrome.tabs.create({ url: chrome.runtime.getURL("recordings.html") });
  }
}

/** The HUD in the top frame owns the note box, so a Screenshot (a Mark) from a shortcut goes there. */
async function requestMark(tabId: number): Promise<void> {
  await chrome.tabs.sendMessage(tabId, { kind: "mark" }, { frameId: 0 }).catch(() => undefined);
}

async function onCommand(command: string, tab?: chrome.tabs.Tab): Promise<void> {
  await ready;
  if (command === "screenshot") {
    if (session?.status === "recording") await requestMark(session.tabId);
    return;
  }
  if (command !== "toggle-recording") return;
  if (session?.status === "recording") await stop("user");
  else if (!session && tab?.id !== undefined) {
    const r = await start(tab.id);
    if (r.setup) await showSetup();
    else if (!r.ok) setBadge("ERR");
  }
}

chrome.commands.onCommand.addListener((command, tab) => void onCommand(command, tab));

// E2E hook: a test cannot press a chrome.commands shortcut, so it calls the same handler.
(globalThis as { record2contextTest?: unknown }).record2contextTest = { command: onCommand };
