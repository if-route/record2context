const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** `m:ss.d` on the video clock. */
export function fmtVideoTime(ms: number): string {
  const tenths = Math.max(0, Math.round(ms / 100));
  const s = Math.floor(tenths / 10);
  return `${Math.floor(s / 60)}:${pad(s % 60)}.${tenths % 10}`;
}

/** `m:ss`, or `h:mm:ss` from an hour. */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/** `YYYY-MM-DD HH:mm` in the machine's local time zone. */
export function fmtLocalTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * JSON with one line per list row and short objects inline: readable without blowing up the size.
 * Backticks are escaped so no value can close a Markdown code fence.
 */
export function compactJson(v: unknown, depth = 0): string {
  const pad = "  ".repeat(depth);
  const inner = "  ".repeat(depth + 1);
  const flat = JSON.stringify(v) ?? "null";
  let out: string;
  if (Array.isArray(v)) {
    const primitives = v.every((x) => x === null || typeof x !== "object");
    if (v.length === 0 || depth >= 4 || (primitives && flat.length <= 140)) out = flat;
    else out = `[\n${v.map((x) => inner + compactJson(x, depth + 1)).join(",\n")}\n${pad}]`;
  } else if (v && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
    // Depth 2+ objects are list rows (an action, a request): one line each.
    if (depth >= 2 || entries.length === 0 || (depth > 0 && flat.length <= 140)) out = flat;
    else out = `{\n${entries.map(([k, x]) => `${inner}${JSON.stringify(k)}: ${compactJson(x, depth + 1)}`).join(",\n")}\n${pad}}`;
  } else {
    out = flat;
  }
  return out.replace(/`/g, "\\u0060");
}
