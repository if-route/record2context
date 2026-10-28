const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** Filesystem-safe host: `:` → `_`, everything else but letters, digits, `_` and `-` → `-`.
 *  No dots, so a folder never ends in `.app` (a macOS bundle Chrome will not save into) or another extension. */
export function safeHost(host: string): string {
  return host.replace(/:/g, "_").replace(/[^a-zA-Z0-9_-]/g, "-");
}

/** `<YYYY-MM-DD_HHmmss>_<host>` in local time; host made filesystem-safe. Also the session's folder name. */
export function sessionId(startedAt: Date, url: string): string {
  const d = startedAt;
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(
    d.getMinutes(),
  )}${pad(d.getSeconds())}`;
  let host = "page";
  try {
    host = new URL(url).host || (url.startsWith("file:") ? "file" : "page");
  } catch {
    /* keep default */
  }
  return `${stamp}_${safeHost(host)}`;
}

/** Named after the session so several clips attached to one issue never collide. */
export function videoFile(id: string): string {
  return `${id}.webm`;
}

/** Width and height from a PNG's IHDR chunk; null when the bytes are not a PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || sig.some((b, i) => bytes[i] !== b)) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: v.getUint32(16), height: v.getUint32(20) };
}
