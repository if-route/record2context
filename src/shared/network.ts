import { redactUrl } from "./redact";
import type { NetworkEvent } from "./types";

/** Status 0 from resource-timing usually means "hidden by CORS", not a failure, so it only counts with an `error`. */
export function isNetworkError(e: NetworkEvent): boolean {
  if (e.status >= 400) return true;
  if (e.status === 0) return e.source !== "resource-timing" || !!e.error;
  return false;
}

export interface NetworkGroup {
  t: number;
  method: string;
  host: string;
  /** Redacted path + query, truncated. */
  path: string;
  statuses: number[];
  count: number;
  maxDurationMs: number;
}

const ASSET_RE = /\.(?:js|mjs|css|map|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|otf|eot|mp4|webm|html?)$/i;

function parse(url: string): { host: string; pathname: string; search: string } | null {
  try {
    const u = new URL(redactUrl(url));
    return { host: u.host, pathname: u.pathname, search: u.search };
  } catch {
    return null;
  }
}

export function endpointKey(e: NetworkEvent): string {
  const u = parse(e.url);
  return `${e.method || "GET"} ${u ? u.host + u.pathname : e.url}`;
}

/** Static files and resource-timing rows: noise for reproduce steps unless they failed. */
export function isAssetRequest(e: NetworkEvent): boolean {
  if (e.source === "resource-timing") return true;
  const u = parse(e.url);
  return !!u && ASSET_RE.test(u.pathname);
}

/** Endpoints called more than `threshold` times without an error: background polling, listed once instead of per step. */
export function pollingEndpoints(rows: NetworkEvent[], threshold = 20): Set<string> {
  const counts = new Map<string, number>();
  for (const e of rows) if (!isNetworkError(e)) counts.set(endpointKey(e), (counts.get(endpointKey(e)) ?? 0) + 1);
  return new Set([...counts].filter(([, n]) => n > threshold).map(([k]) => k));
}

export function displayPath(url: string, max = 140): { host: string; path: string } {
  const u = parse(url);
  const path = u ? u.pathname + u.search : redactUrl(url);
  return { host: u?.host ?? "", path: path.length > max ? `${path.slice(0, max - 1)}…` : path };
}

/** Collapses repeated calls to one endpoint into one row with a count; URLs are redacted. */
export function groupNetwork(rows: NetworkEvent[]): NetworkGroup[] {
  const groups = new Map<string, NetworkGroup>();
  for (const e of rows) {
    const key = endpointKey(e);
    const g = groups.get(key);
    if (g) {
      g.count++;
      if (!g.statuses.includes(e.status)) g.statuses.push(e.status);
      g.maxDurationMs = Math.max(g.maxDurationMs, e.durationMs);
    } else {
      const { host, path } = displayPath(e.url);
      groups.set(key, { t: e.t, method: e.method || "GET", host, path, statuses: [e.status], count: 1, maxDurationMs: e.durationMs });
    }
  }
  return [...groups.values()].sort((a, b) => a.t - b.t);
}
