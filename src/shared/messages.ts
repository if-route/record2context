import type { ShortcutKey } from "./shortcuts";
import type { BodyRecord } from "./bodies";
import type { ClockSync } from "./clock-sync";
import type { VideoClock } from "./clock";
import type { HostState } from "./host";
import type { FolderCopy } from "./recent";
import type { Annotation, RawEvent, ViewportInfo } from "./types";

/** Isolated world <-> main world (DOM CustomEvents, JSON string detail so it crosses worlds). */
export const MAIN_EVENT = "__record2context_evt";
export const MAIN_CONTROL = "__record2context_ctl";
export const MAIN_READY = "__record2context_main_ready";

export interface HelloReply {
  recording: boolean;
  /** The shortcut keys as Chrome has them now, for the HUD's buttons (read before it mounts, so its width never changes). */
  keys?: ShortcutKey[];
  clock?: VideoClock;
  /** True only for the first page_load of a session (the page open at Start). */
  initial?: boolean;
  /** Set while paused for a Mark: the note typed so far, so a reloaded page shows the note box again. */
  markDraft?: string;
  /** Set while paused for a Mark whose screenshot was saved: the editor reopens on it after a reload. */
  markShot?: MarkShot;
}

/** Reply to pause / resume: the clock after the change. */
export interface PauseReply {
  ok: boolean;
  error?: string;
  clock?: VideoClock;
  markDraft?: string;
  markShot?: MarkShot;
}

export interface StatusReply {
  status: "idle" | "starting" | "recording" | "stopping";
  clock?: VideoClock;
  tabId?: number;
  /** Id of the running session. */
  id?: string;
  error?: string;
}

export interface StartReply {
  ok: boolean;
  error?: string;
  /** Set when Start was refused because the recording helper is missing or broken. */
  setup?: HostState;
}

/** Saved while paused for a Mark: the plain screenshot of the moment, and what the editor needs to reopen it. */
export interface MarkShot {
  file: string;
  viewport: ViewportInfo;
  imageWidth: number;
  imageHeight: number;
}

export interface HudRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ToBackground =
  | { kind: "start"; tabId: number }
  | { kind: "stop"; note?: string }
  | { kind: "status" }
  | { kind: "hello" }
  | { kind: "events"; events: RawEvent[] }
  /** A fetch/XHR call's bodies, for the private folder only; `bodyId` is on its network event. */
  | { kind: "body"; bodyId: string; body: BodyRecord }
  | { kind: "capture" }
  /** While paused for a Mark: the plain capture of the moment, saved at once. */
  | { kind: "mark-shot"; dataUrl: string; viewport: ViewportInfo }
  /** The mark screenshot's image again (after a reload while paused), as a data: URL. */
  | { kind: "mark-shot-image" }
  /** Continue on a Mark: the drawn shapes, and the annotated image when anything was drawn. */
  | { kind: "mark-annotations"; annotations: Annotation[]; annotatedDataUrl?: string }
  | { kind: "rec-ended"; reason: string }
  | { kind: "pause"; path: string }
  | { kind: "mark-note"; note: string }
  | { kind: "resume"; note: string }
  /** The Screenshot shortcut was pressed in some frame; the top frame's HUD handles it. */
  | { kind: "mark-request" }
  /** The HUD timer's digits changed at `at` (drawn in that frame), at `rect` in a viewport of `viewport` (CSS px). */
  | { kind: "hud-tick"; at: number; rect: HudRect; viewport: { width: number; height: number } }
  /** Delete every copy of these sessions (extension storage and folder) and drop them from the list. */
  | { kind: "delete-recordings"; ids: string[] }
  /** Copy this session from the extension's storage into the recordings folder (through the helper). */
  | { kind: "save-to-folder"; id: string }
  /** Drop these sessions (all when `ids` is missing) from the list; the files stay. */
  | { kind: "forget-recordings"; ids?: string[] }
  /** Ping the helper with a heartbeat; with `sync`, then copy recordings not yet in the folder. Replies `HostState`. */
  | { kind: "host-status"; reason: string; sync?: boolean };

export type HostStatusReply = HostState;
/** Reply to save-to-folder. */
export type SaveToFolderReply = FolderCopy;

export type { DeleteOutcome as DeleteResult } from "./store";

export type ToContent = { kind: "stopping" } | { kind: "stopped" } | { kind: "mark" };

export interface OffscreenStartReply {
  ok: boolean;
  error?: string;
  videoStart?: number;
  mimeType?: string;
}

export interface OffscreenStopReply {
  ok: boolean;
  error?: string;
  /** The video, written to the session's folder in the extension's storage. */
  file?: string;
  mimeType?: string;
  sizeBytes?: number;
  durationMs?: number;
  width?: number;
  height?: number;
  seekableFix?: boolean;
  fixError?: string;
  /** Frame-measured video clock; missing when frame timing was unavailable (syncError says why). */
  sync?: ClockSync;
  syncError?: string;
}

export interface OffscreenPauseReply {
  ok: boolean;
  error?: string;
  /** Epoch ms of the pause() / resume() call. */
  at?: number;
}

export type ToOffscreen =
  | { target: "offscreen"; kind: "rec-start"; id: string; streamId: string; width: number; height: number }
  | { target: "offscreen"; kind: "rec-stop" }
  | { target: "offscreen"; kind: "rec-pause" }
  | { target: "offscreen"; kind: "rec-resume" }
  | { target: "offscreen"; kind: "rec-tick"; at: number; rect: HudRect; viewport: { width: number; height: number } };
