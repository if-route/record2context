import type { NetworkEvent, RecEvent } from "./types";

export type MarkerKind = "mark" | "click" | "input" | "key" | "nav" | "screenshot" | "net-error" | "console-error";

export interface Marker {
  t: number;
  kind: MarkerKind;
  label: string;
  /** Index into report.events. */
  index: number;
}

export const MARKER_KINDS: { kind: MarkerKind; label: string }[] = [
  { kind: "mark", label: "Screenshot" },
  { kind: "click", label: "Click" },
  { kind: "input", label: "Input" },
  { kind: "key", label: "Key" },
  { kind: "nav", label: "Page load / route" },
  { kind: "screenshot", label: "Screenshot (no pause)" },
  { kind: "net-error", label: "Network error" },
  { kind: "console-error", label: "Console error" },
];

/** Status 0 from resource-timing usually means "hidden by CORS", not a failure, so it only counts with an `error`. */
export function isNetworkError(e: NetworkEvent): boolean {
  if (e.status >= 400) return true;
  if (e.status === 0) return e.source !== "resource-timing" || !!e.error;
  return false;
}

export function isXhrOrFetch(e: NetworkEvent): boolean {
  return e.source === "fetch" || e.source === "xhr";
}

export function markerKind(e: RecEvent): MarkerKind | null {
  switch (e.type) {
    case "click":
    case "input":
    case "key":
      return e.type;
    // A Mark's own screenshot sits at the mark's t; the mark marker stands for both.
    case "screenshot":
      return e.mark ? null : "screenshot";
    case "page_load":
    case "route_change":
      return "nav";
    case "network":
      return isNetworkError(e) ? "net-error" : null;
    case "console_error":
      return "console-error";
    case "mark":
      return "mark";
    case "pause":
      return null;
  }
}

export function shortUrl(url: string, max = 90): string {
  let s = url;
  try {
    const u = new URL(url);
    s = u.pathname + u.search;
  } catch {
    /* keep raw */
  }
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function eventLabel(e: RecEvent): string {
  switch (e.type) {
    case "click":
      return e.labelSource === "heading" ? `Click near heading "${e.label}" (${e.tag})` : `Click "${e.label}"`;
    case "input":
      return `Type in "${e.label}": ${e.masked ? "[MASKED]" : JSON.stringify(e.value)}`;
    case "key":
      return `Key ${[...e.modifiers, e.key].join("+")} in "${e.label}"`;
    case "page_load":
      return e.initial ? `Page open at start: ${e.path}` : `Page ${e.navigationType}: ${e.path}`;
    case "route_change":
      return `Route ${e.from} → ${e.to}`;
    case "screenshot":
      return `${e.mark ? `Screenshot ${e.mark}` : "Screenshot"} ${e.file}${e.annotations?.length ? ` (${e.annotations.length} shape${e.annotations.length === 1 ? "" : "s"})` : ""}`;
    case "network":
      return `${e.method || "GET"} ${e.status || "-"} ${shortUrl(e.url)}`;
    case "console_error":
      return `${e.source}: ${e.message.split("\n")[0]}`;
    case "mark":
      return `Screenshot ${e.n}${e.note ? `: ${e.note.split("\n")[0]}` : " (no note)"}`;
    case "pause":
      return `Paused for ${(e.pausedMs / 1000).toFixed(1)} s (not in the video)`;
  }
}

export function buildMarkers(events: RecEvent[]): Marker[] {
  const out: Marker[] = [];
  events.forEach((e, index) => {
    const kind = markerKind(e);
    if (kind) out.push({ t: e.t, kind, label: eventLabel(e), index });
  });
  return out;
}

/** Index of the row whose time is closest to `t` (ties go to the earlier row). `times` must be sorted. */
export function nearestRow(times: readonly number[], t: number): number {
  if (times.length === 0) return -1;
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && t - times[lo - 1]! <= times[lo]! - t) {
    // Walk back to the first of equal times so ties resolve to the earliest row.
    let i = lo - 1;
    while (i > 0 && times[i - 1] === times[i]) i--;
    return i;
  }
  return lo;
}

/** Percent position on a scrubber, clamped to 0..100. */
export function timeToPercent(t: number, durationMs: number): number {
  if (!(durationMs > 0)) return 0;
  return Math.min(100, Math.max(0, (t / durationMs) * 100));
}
