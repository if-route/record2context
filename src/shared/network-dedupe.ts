// Adapted from TraceBug (MIT, Copyright (c) 2026 Prashant Singh Mangat), src/network-dedupe.ts.
import type { NetworkEvent } from "./types";

/** Resource Timing rows only exist to catch requests the fetch/XHR wrappers missed. */
export const DEDUPE_WINDOW_MS = 100;

export function normalizeUrl(url: string): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    u.hash = "";
    return u.href;
  } catch {
    return url;
  }
}

/**
 * Drop resource-timing rows that duplicate a wrapper row (same URL, start within the window).
 * Pairing consumes the wrapper row, so N polled requests keep N rows.
 */
export function dedupeNetwork<T extends Pick<NetworkEvent, "url" | "t" | "source">>(
  rows: T[],
  windowMs = DEDUPE_WINDOW_MS,
): T[] {
  const wrappers = new Map<string, { t: number; used: boolean }[]>();
  for (const r of rows) {
    if (r.source === "resource-timing") continue;
    const key = normalizeUrl(r.url);
    const list = wrappers.get(key) ?? [];
    list.push({ t: r.t, used: false });
    wrappers.set(key, list);
  }
  return rows.filter((r) => {
    if (r.source !== "resource-timing") return true;
    const candidates = wrappers.get(normalizeUrl(r.url));
    if (!candidates) return true;
    let best: { t: number; used: boolean } | null = null;
    for (const c of candidates) {
      const d = Math.abs(c.t - r.t);
      if (!c.used && d <= windowMs && (!best || d < Math.abs(best.t - r.t))) best = c;
    }
    if (!best) return true;
    best.used = true;
    return false;
  });
}
