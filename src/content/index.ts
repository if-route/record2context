// Isolated-world content script. Runs on every page load in every tab while a session is active,
// asks the background whether this tab records, and resumes capture if it does.
// Click/key capture adapted from TraceBug (MIT, Copyright (c) 2026 Prashant Singh Mangat), src/collectors.ts.
import { isPaused, type VideoClock } from "../shared/clock";
import { COLOR_KEY, DEFAULT_COLOR, swatch, type SwatchName } from "../shared/annotations";
import { MAIN_CONTROL, MAIN_EVENT, MAIN_READY, type HelloReply, type MarkShot, type PauseReply, type ToBackground, type ToContent } from "../shared/messages";
import { cutUtf8, type BodyPart, type BodyRecord } from "../shared/bodies";
import { pagePath, redactText, redactUrl } from "../shared/redact";
import type { FrameInfo, NavigationKind, RawEvent, ViewportInfo } from "../shared/types";
import { openEditor, type EditorOptions } from "./editor";
import { elementInfoAt } from "./element-info";
import { InputTracker, fieldFromTarget, type InputSnapshot } from "./inputs";
import { actionableTarget, buildSelector, elementLabel } from "./labels";
import { RecorderUI, nextPaint } from "./ui";

declare global {
  interface Window {
    __record2context?: { resume(): void };
  }
}

const KEYS = new Set(["Enter", "Escape", "Tab"]);
const isTop = window === window.top;

let active = false;
let videoStart = 0;
let clock: VideoClock = { videoStart: 0, pauses: [] };
let markBusy = false;
let noteTimer = 0;
let ui: RecorderUI | null = null;
let tracker: InputTracker | null = null;
let detach: (() => void)[] = [];
let mainState: "on" | "off" | null = null;
/** The Mark note as typed so far (in the editor or the note box), so Stop during a pause keeps it. */
let markNote = "";
let color: SwatchName = DEFAULT_COLOR;
const queue: RawEvent[] = [];
let flushTimer = 0;
let dead = false;

function send<T = unknown>(msg: ToBackground): Promise<T | undefined> {
  if (dead) return Promise.resolve(undefined);
  try {
    return chrome.runtime.sendMessage(msg).catch(() => undefined) as Promise<T | undefined>;
  } catch {
    // Extension reloaded or removed: this script is orphaned.
    dead = true;
    deactivate();
    return Promise.resolve(undefined);
  }
}

function flushQueue(): void {
  clearTimeout(flushTimer);
  flushTimer = 0;
  if (!queue.length) return;
  void send({ kind: "events", events: queue.splice(0) });
}

/** User actions go out immediately (a reload may follow); network/console are batched. */
function emit(ev: RawEvent, urgent = true): void {
  if (!active) return;
  const frame = frameInfo();
  queue.push(frame ? ({ ...ev, frame } as RawEvent) : ev);
  if (urgent) flushQueue();
  else if (!flushTimer) flushTimer = window.setTimeout(flushQueue, 300);
}

function setMain(on: boolean): void {
  mainState = on ? "on" : "off";
  document.dispatchEvent(new CustomEvent(MAIN_CONTROL, { detail: JSON.stringify({ on }) }));
}

// ── Coordinates ────────────────────────────────────────────────────────────

let frameOffsetCache: { x: number; y: number; translated: boolean } | null = null;
function frameOffset(): { x: number; y: number; translated: boolean } {
  if (isTop) return { x: 0, y: 0, translated: true };
  let x = 0;
  let y = 0;
  try {
    let w: Window = window;
    while (w !== w.top) {
      const fe = w.frameElement as HTMLElement | null;
      if (!fe) throw new Error("cross-origin");
      const r = fe.getBoundingClientRect();
      x += r.left + fe.clientLeft;
      y += r.top + fe.clientTop;
      w = w.parent;
    }
    frameOffsetCache = { x, y, translated: true };
  } catch {
    frameOffsetCache = { x: 0, y: 0, translated: false };
  }
  return frameOffsetCache;
}

function frameInfo(): FrameInfo | undefined {
  if (isTop) return undefined;
  return { url: redactUrl(location.href), translated: (frameOffsetCache ?? frameOffset()).translated };
}

function viewportInfo(): ViewportInfo {
  let w: Window = window;
  try {
    if (!isTop && window.top && window.top.innerWidth) w = window.top;
  } catch {
    /* cross-origin top: report this frame's viewport */
  }
  return {
    width: w.innerWidth,
    height: w.innerHeight,
    dpr: w.devicePixelRatio || 1,
    scrollX: Math.round(w.scrollX),
    scrollY: Math.round(w.scrollY),
  };
}

const path = () => pagePath(location);

function deepTarget(e: Event): Element | null {
  const first = e.composedPath()[0];
  if (first instanceof Element) return first;
  return e.target instanceof Element ? e.target : null;
}

function testIdOf(el: Element): string | undefined {
  for (const a of ["data-testid", "data-test-id", "data-test", "data-cy", "data-qa"]) {
    const v = el.getAttribute(a);
    if (v) return redactText(v);
  }
  return undefined;
}

function safeSelector(el: Element): string {
  try {
    return buildSelector(el);
  } catch {
    return el.tagName.toLowerCase();
  }
}

// ── Collectors ─────────────────────────────────────────────────────────────

function onClick(e: MouseEvent): void {
  if (!active || ui?.isOwnEvent(e)) return;
  const raw = deepTarget(e);
  if (!raw) return;
  try {
    tracker?.flushAll();
    const el = actionableTarget(raw);
    const off = frameOffset();
    const r = el.getBoundingClientRect();
    const keyboard = e.detail === 0 && e.clientX === 0 && e.clientY === 0;
    const { label, source } = elementLabel(el);
    const role = el.getAttribute("role") ?? undefined;
    const href = el instanceof HTMLAnchorElement && el.href ? redactUrl(el.href) : undefined;
    emit({
      type: "click",
      at: Date.now(),
      path: path(),
      label,
      labelSource: source,
      tag: el.tagName.toLowerCase(),
      ...(role ? { role } : {}),
      ...(testIdOf(el) ? { testId: testIdOf(el) } : {}),
      selector: safeSelector(el),
      bbox: { x: Math.round(r.left + off.x), y: Math.round(r.top + off.y), width: Math.round(r.width), height: Math.round(r.height) },
      point: keyboard
        ? { x: Math.round(r.left + off.x + r.width / 2), y: Math.round(r.top + off.y + r.height / 2) }
        : { x: Math.round(e.clientX + off.x), y: Math.round(e.clientY + off.y) },
      viewport: viewportInfo(),
      ...(href ? { href } : {}),
    });
  } catch {
    /* never break the page */
  }
}

function onKey(e: KeyboardEvent): void {
  if (!active || !KEYS.has(e.key) || e.isComposing || ui?.isOwnEvent(e)) return;
  const raw = deepTarget(e);
  if (!raw) return;
  try {
    tracker?.flushAll();
    const el = fieldFromTarget(raw) ?? actionableTarget(raw);
    const modifiers = (["Shift", "Control", "Alt", "Meta"] as const).filter((m) => e.getModifierState(m));
    emit({
      type: "key",
      at: Date.now(),
      path: path(),
      key: e.key as "Enter" | "Escape" | "Tab",
      modifiers,
      selector: safeSelector(el),
      label: elementLabel(el).label,
      tag: el.tagName.toLowerCase(),
    });
  } catch {
    /* ignore */
  }
}

function isDiscrete(el: HTMLElement): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === "select") return true;
  const type = (el as HTMLInputElement).type;
  return tag === "input" && (type === "checkbox" || type === "radio");
}

function onInput(e: Event): void {
  if (!active || ui?.isOwnEvent(e)) return;
  const field = fieldFromTarget(deepTarget(e));
  if (field && !isDiscrete(field)) tracker?.touch(field);
}

function onChange(e: Event): void {
  if (!active || ui?.isOwnEvent(e)) return;
  const field = fieldFromTarget(deepTarget(e));
  if (field && isDiscrete(field)) tracker?.immediate(field);
}

/** The page world could send anything: keep only the expected fields, text within the cap. */
function cleanPart(p: unknown): BodyPart | undefined {
  if (!p || typeof p !== "object") return undefined;
  const o = p as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);
  const part: BodyPart = {};
  const ct = str(o.contentType, 200);
  if (ct) part.contentType = ct;
  if (typeof o.text === "string") part.text = cutUtf8(o.text).text;
  if (typeof o.size === "number") part.size = o.size;
  if (o.truncated === "size" || o.truncated === "time") part.truncated = o.truncated;
  const skipped = str(o.skipped, 300);
  if (skipped) part.skipped = skipped;
  return part;
}

function forwardBody(ev: { bodyId?: unknown; body?: unknown }): void {
  const b = ev.body as Partial<BodyRecord> | undefined;
  if (typeof ev.bodyId !== "string" || !b || typeof b !== "object") return;
  const request = cleanPart(b.request);
  const response = cleanPart(b.response);
  const body: BodyRecord = {
    method: String(b.method ?? "").slice(0, 20),
    url: String(b.url ?? "").slice(0, 2000),
    ...(typeof b.status === "number" ? { status: b.status } : {}),
    ...(request ? { request } : {}),
    ...(response ? { response } : {}),
  };
  void send({ kind: "body", bodyId: ev.bodyId.slice(0, 40), body });
}

function onMainEvent(e: Event): void {
  if (!active) return;
  try {
    const parsed = JSON.parse(String((e as CustomEvent).detail));
    if (parsed?.type === "body") return forwardBody(parsed);
    const ev = parsed as RawEvent;
    if (!ev || typeof ev.type !== "string" || typeof ev.at !== "number") return;
    if (ev.type !== "network" && ev.type !== "route_change" && ev.type !== "console_error") return;
    emit(ev, ev.type === "route_change");
  } catch {
    /* ignore malformed */
  }
}

function onMainReady(): void {
  if (mainState) setMain(mainState === "on");
}

/** Only for the page that was already open at Start: catches fetches through references cached before patching. */
function observeResourceTiming(): () => void {
  if (typeof PerformanceObserver === "undefined") return () => {};
  const obs = new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as (PerformanceResourceTiming & { responseStatus?: number })[]) {
      if (entry.initiatorType !== "fetch" && entry.initiatorType !== "xmlhttprequest") continue;
      const at = Math.round(performance.timeOrigin + entry.startTime);
      if (at < videoStart) continue;
      emit(
        {
          type: "network",
          at,
          path: path(),
          method: "",
          url: redactUrl(entry.name),
          status: entry.responseStatus ?? 0,
          durationMs: Math.round(entry.duration),
          source: "resource-timing",
        },
        false,
      );
    }
  });
  try {
    obs.observe({ type: "resource", buffered: false });
  } catch {
    return () => {};
  }
  return () => obs.disconnect();
}

function navigationType(): NavigationKind {
  const nav = performance.getEntriesByType?.("navigation")[0] as PerformanceNavigationTiming | undefined;
  const t = nav?.type;
  return t === "navigate" || t === "reload" || t === "back_forward" || t === "prerender" ? t : "unknown";
}

// ── Screenshot ─────────────────────────────────────────────────────────────

const isOwnElement = (el: Element) => el === ui?.host || el.tagName === "RECORD2CONTEXT-UI";

function editorOptions(viewport: ViewportInfo): EditorOptions {
  return {
    dpr: viewport.dpr,
    viewportWidth: viewport.width,
    color,
    onColor: (c) => {
      color = c;
      void chrome.storage.local.set({ [COLOR_KEY]: c }).catch(() => undefined);
    },
    elementAt: (x, y) => elementInfoAt(x, y, isOwnElement),
  };
}

/** captureVisibleTab of the page alone (the bar, cursor and ripples hidden). Chrome allows 2 captures a second: one retry. */
async function captureTab(): Promise<{ dataUrl?: string; error?: string; viewport: ViewportInfo }> {
  ui?.setCaptureHidden(true);
  try {
    await nextPaint();
    const viewport = viewportInfo();
    let shot = await send<{ dataUrl?: string; error?: string }>({ kind: "capture" });
    if (!shot?.dataUrl) {
      await new Promise((r) => setTimeout(r, 600));
      shot = await send<{ dataUrl?: string; error?: string }>({ kind: "capture" });
    }
    return { ...(shot ?? { error: "no response" }), viewport };
  } finally {
    ui?.setCaptureHidden(false);
  }
}

// ── Mark ───────────────────────────────────────────────────────────────────

/** Alt+Shift+S, the Screenshot shortcut. `code`, because on a Mac Alt changes `key` (Alt+Shift+S types "Í"). */
function isScreenshotShortcut(e: KeyboardEvent): boolean {
  return e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === "KeyS";
}

function onShortcut(e: KeyboardEvent): void {
  if (!active || !isScreenshotShortcut(e)) return;
  e.preventDefault();
  e.stopPropagation();
  if (isTop) void mark();
  else void send({ kind: "mark-request" });
}

/** Screenshot (internally a Mark): pause, capture, then the editor. */
async function mark(): Promise<void> {
  if (!ui || markBusy || isPaused(clock)) return;
  markBusy = true;
  try {
    // Typing so far belongs before the pause point.
    tracker?.flushAll();
    flushQueue();
    const r = await send<PauseReply>({ kind: "pause", path: path() });
    if (!r?.ok || !r.clock) {
      ui.toast(`Screenshot failed, could not pause: ${r?.error ?? "no response"}`);
      return;
    }
    clock = r.clock;
    ui.setClock(clock);
    markNote = r.markDraft ?? "";
    // The video is paused, so the capture and the editor never reach it.
    ui.setPaused(true, markNote, false);
    const shot = await captureTab();
    const saved = shot.dataUrl
      ? await send<{ file?: string; error?: string }>({ kind: "mark-shot", dataUrl: shot.dataUrl, viewport: shot.viewport })
      : undefined;
    if (!shot.dataUrl || !saved?.file) {
      ui.toast(`Screenshot failed: ${shot.error ?? saved?.error ?? "no response"}`);
      ui.setPaused(true, markNote);
      return;
    }
    void markEditor(shot.dataUrl, shot.viewport);
  } finally {
    markBusy = false;
  }
}

/** The editor on the Mark's screenshot: shapes, their notes and the note for the moment; Continue resumes. */
async function markEditor(dataUrl: string, viewport: ViewportInfo): Promise<void> {
  if (!ui) return;
  ui.setHudVisible(false);
  const edited = await openEditor(ui.root, dataUrl, { ...editorOptions(viewport), note: markNote, onNoteInput });
  if (!ui || !active || stopRequested || !edited) return;
  ui.setHudVisible(true);
  markNote = edited.note;
  await send({ kind: "mark-annotations", annotations: edited.annotations, ...(edited.annotated ? { annotatedDataUrl: edited.dataUrl } : {}) });
  // The editor gone and the bar back on screen before the countdown's first lag sample.
  await nextPaint();
  await continueRecording(edited.note);
}

/** After a reload while paused: the editor again, on the Mark's saved screenshot (shapes drawn before the reload are lost). */
async function reopenMarkEditor(shot: MarkShot): Promise<void> {
  const r = await send<{ dataUrl?: string }>({ kind: "mark-shot-image" });
  if (!r?.dataUrl) return void ui?.setPaused(true, markNote);
  await markEditor(r.dataUrl, shot.viewport);
}

function onNoteInput(note: string): void {
  markNote = note;
  clearTimeout(noteTimer);
  noteTimer = window.setTimeout(() => void send({ kind: "mark-note", note }), 300);
}

const COUNTDOWN_S = 3;
// After the countdown is hidden: paint it away, then wait so no frame captured during the pause reaches the recorder after resume().
const RESUME_SETTLE_MS = 100;
let stopRequested = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Continue: the note box goes, a 3-2-1 countdown runs while the recorder is still paused, then it resumes. Stop still works. */
async function continueRecording(note: string): Promise<void> {
  if (!ui || markBusy) return;
  markBusy = true;
  clearTimeout(noteTimer);
  markNote = note;
  try {
    ui.hideNote();
    void send({ kind: "mark-note", note });
    for (let q = COUNTDOWN_S * 4; q > 0; q--) {
      ui.setCountdown({ n: Math.ceil(q / 4), part: ((q - 1) % 4) + 1 });
      await sleep(250);
      if (stopRequested) return;
    }
    ui.setCountdown(null);
    await nextPaint();
    await sleep(RESUME_SETTLE_MS);
    if (stopRequested) return;
    const r = await send<PauseReply>({ kind: "resume", note });
    if (!r?.ok || !r.clock) {
      if (stopRequested) return;
      ui.setPaused(true, note);
      ui.toast(`Could not continue: ${r?.error ?? "no response"}`);
      return;
    }
    clock = r.clock;
    ui.setClock(clock);
    ui.setPaused(false);
  } finally {
    markBusy = false;
  }
}

async function stopFromHud(): Promise<void> {
  stopRequested = true;
  tracker?.flushAll();
  flushQueue();
  clearTimeout(noteTimer);
  await send({ kind: "stop", ...(ui && isPaused(clock) ? { note: markNote } : {}) });
}

// ── Lifecycle ──────────────────────────────────────────────────────────────

function on<K extends keyof DocumentEventMap>(type: K, fn: (e: DocumentEventMap[K]) => void): void {
  document.addEventListener(type, fn, { capture: true });
  detach.push(() => document.removeEventListener(type, fn, { capture: true }));
}

function activate(reply: HelloReply): void {
  if (active) return;
  active = true;
  stopRequested = false;
  markNote = reply.markDraft ?? "";
  void chrome.storage.local.get(COLOR_KEY).then((r) => (color = swatch(r[COLOR_KEY] as string | undefined).name), () => undefined);
  clock = reply.clock ?? { videoStart: Date.now(), pauses: [] };
  videoStart = clock.videoStart;
  tracker = new InputTracker((snap: InputSnapshot, at: number) => emit({ type: "input", at, path: path(), ...snap }));
  on("click", onClick);
  on("keydown", onKey);
  on("input", onInput);
  on("change", onChange);
  window.addEventListener("keydown", onShortcut, { capture: true });
  detach.push(() => window.removeEventListener("keydown", onShortcut, { capture: true }));
  const onMain = (e: Event) => onMainEvent(e);
  document.addEventListener(MAIN_EVENT, onMain);
  detach.push(() => document.removeEventListener(MAIN_EVENT, onMain));
  const hide = () => {
    tracker?.flushAll();
    flushQueue();
  };
  window.addEventListener("pagehide", hide);
  detach.push(() => window.removeEventListener("pagehide", hide));
  if (reply.initial) detach.push(observeResourceTiming());
  setMain(true);

  if (!isTop) return;
  emit({
    type: "page_load",
    // Reloads and navigations are stamped at navigation start, when the user acted.
    at: reply.initial ? Date.now() : Math.round(performance.timeOrigin),
    path: path(),
    navigationType: navigationType(),
    initial: !!reply.initial,
    url: redactUrl(location.href),
    title: redactText(document.title),
  });
  const mountUi = () => {
    if (!active) return;
    ui = new RecorderUI(clock, {
      onStop: () => void stopFromHud(),
      onMark: () => void mark(),
      onContinue: (note) => void continueRecording(note),
      onTick: (at, rect, viewport) => void send({ kind: "hud-tick", at, rect, viewport }),
      onNoteInput,
    }, reply.keys ?? []);
    ui.mount();
    if (isPaused(clock) && reply.markShot) {
      ui.setPaused(true, markNote, false);
      void reopenMarkEditor(reply.markShot);
    } else if (isPaused(clock)) ui.setPaused(true, markNote);
  };
  if (document.documentElement) mountUi();
  else document.addEventListener("DOMContentLoaded", mountUi, { once: true });
}

function deactivate(): void {
  if (!active) return;
  tracker?.flushAll();
  flushQueue();
  active = false;
  tracker?.dispose();
  tracker = null;
  detach.forEach((f) => f());
  detach = [];
  ui?.unmount();
  ui = null;
  setMain(false);
}

async function hello(): Promise<void> {
  const reply = await send<HelloReply>({ kind: "hello" });
  if (reply?.recording) activate(reply);
  else {
    deactivate();
    setMain(false);
  }
}

if (window.__record2context) {
  window.__record2context.resume();
} else {
  window.__record2context = { resume: () => void hello() };
  document.addEventListener(MAIN_READY, onMainReady);
  chrome.runtime.onMessage.addListener((msg: ToContent, _sender, sendResponse) => {
    if (msg?.kind === "stopping" || msg?.kind === "stopped") {
      stopRequested = true;
      deactivate();
      sendResponse({ ok: true });
    }
    if (msg?.kind === "mark" && isTop) {
      void mark();
      sendResponse({ ok: true });
    }
    return false;
  });
  void hello();
}
