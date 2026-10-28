import type { Pause } from "./clock";
import { appendEvent, type EventLog } from "./event-log";
import type { MarkShot } from "./messages";
import { scrubSecrets } from "./redact";
import type { Annotation } from "./types";

/** The Mark's screenshot while paused: the plain capture, then (on Continue) its shapes and annotated copy. */
export interface MarkDraftShot extends MarkShot {
  annotations?: Annotation[];
  annotatedFile?: string;
}

/** The part of a session that Mark / Continue change. */
export interface MarkState {
  /** In order; the last one has no `end` while paused. */
  pauses: Pause[];
  /** While paused: where the Mark was pressed, the note typed so far and the screenshot of the moment. */
  markDraft?: { path: string; note: string; shot?: MarkDraftShot };
  marks: number;
  log: EventLog;
}

export function openPause(s: MarkState, at: number, path: string): void {
  const last = s.pauses[s.pauses.length - 1];
  if (last && last.end === undefined) return;
  s.pauses.push({ start: at });
  s.markDraft = { path, note: "" };
}

export function setMarkNote(s: MarkState, note: string): void {
  if (s.markDraft) s.markDraft.note = scrubSecrets(note);
}

export function setMarkShot(s: MarkState, shot: MarkDraftShot): void {
  if (s.markDraft) s.markDraft.shot = shot;
}

/** Shape notes go through the same scrubbing as the Mark note. */
export function scrubAnnotations(list: Annotation[]): Annotation[] {
  return list.map((a) => ({ ...a, note: scrubSecrets(a.note) }));
}

/** Ends an open pause at `end` and logs its mark (with its screenshot) and pause at the pause point. No-op when not paused. */
export function closePause(s: MarkState, end: number): void {
  const open = s.pauses[s.pauses.length - 1];
  if (!open || open.end !== undefined) return;
  open.end = Math.max(open.start, end);
  const draft = s.markDraft ?? { path: "", note: "" };
  s.markDraft = undefined;
  const n = ++s.marks;
  const shot = draft.shot;
  appendEvent(s.log, {
    type: "mark",
    at: open.start,
    path: draft.path,
    n,
    note: draft.note,
    ...(shot ? { screenshot: shot.file } : {}),
    ...(shot?.annotatedFile ? { annotatedScreenshot: shot.annotatedFile } : {}),
  });
  if (shot) {
    const annotations = shot.annotations ?? [];
    appendEvent(s.log, {
      type: "screenshot",
      at: open.start,
      path: draft.path,
      file: shot.file,
      viewport: shot.viewport,
      imageWidth: shot.imageWidth,
      imageHeight: shot.imageHeight,
      annotated: annotations.length > 0,
      ...(shot.annotatedFile ? { annotatedFile: shot.annotatedFile } : {}),
      mark: n,
      ...(annotations.length ? { annotations } : {}),
    });
  }
  appendEvent(s.log, { type: "pause", at: open.start, path: draft.path, pausedMs: open.end - open.start });
}
