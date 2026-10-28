// Request and response bodies of fetch/XHR, for the private folder only. Runs in the page's main world: it reads a
// clone (or a copy) and never the page's own body, stops at a size cap or a time limit, and never throws.

export const BODY_MAX = 256 * 1024;
export const BODY_WAIT_MS = 10_000;

/** One side of a call: the text (maybe cut) or why it was not kept. */
export interface BodyPart {
  contentType?: string;
  text?: string;
  /** UTF-8 bytes kept (at most BODY_MAX). */
  size?: number;
  truncated?: "size" | "time";
  skipped?: string;
}

export interface BodyRecord {
  method: string;
  url: string;
  status?: number;
  request?: BodyPart;
  response?: BodyPart;
}

const TEXT_TYPE_RE = /^\s*(text\/|application\/(json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql|x-ndjson|ld\+json)\b|[^;]*\+(json|xml)\b)/i;

export function isTextType(contentType: string): boolean {
  return TEXT_TYPE_RE.test(contentType);
}

const errText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 200);

/**
 * Reads at most `max` bytes or for `waitMs` from a stream the page does not use (a clone's body), then cancels it.
 * Cancelling a clone's branch leaves the page's own branch running.
 */
export async function readCapped(stream: ReadableStream<Uint8Array>, max = BODY_MAX, waitMs = BODY_WAIT_MS): Promise<BodyPart> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated: BodyPart["truncated"];
  const deadline = Date.now() + waitMs;
  try {
    for (;;) {
      const left = deadline - Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeUp = new Promise<null>((r) => (timer = setTimeout(() => r(null), Math.max(0, left))));
      const r = await Promise.race([reader.read(), timeUp]);
      clearTimeout(timer);
      if (!r) {
        truncated = "time";
        break;
      }
      if (r.done) break;
      chunks.push(r.value);
      size += r.value.byteLength;
      if (size > max) {
        truncated = "size";
        break;
      }
    }
  } catch (e) {
    return { skipped: `could not be read: ${errText(e)}` };
  } finally {
    reader.cancel().catch(() => undefined);
  }
  const all = new Uint8Array(Math.min(size, max));
  let at = 0;
  for (const c of chunks) {
    if (at >= all.length) break;
    all.set(c.subarray(0, all.length - at), at);
    at += c.byteLength;
  }
  const text = new TextDecoder().decode(all);
  return { text: truncated ? text.replace(/\uFFFD+$/, "") : text, size: Math.min(size, max), ...(truncated ? { truncated } : {}) };
}

/** `text` cut to at most `max` UTF-8 bytes (never inside a character), with its full byte size. */
export function cutUtf8(text: string, max = BODY_MAX): { text: string; bytes: number; cut: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= max) return { text, bytes: bytes.length, cut: false };
  return { text: new TextDecoder().decode(bytes.subarray(0, max)).replace(/\uFFFD+$/, ""), bytes: bytes.length, cut: true };
}

function textPart(text: string, contentType?: string): BodyPart {
  const c = cutUtf8(text);
  return { ...(contentType ? { contentType } : {}), text: c.text, size: Math.min(c.bytes, BODY_MAX), ...(c.cut ? { truncated: "size" as const } : {}) };
}

function headerOf(headers: HeadersInit | undefined, name: string): string | undefined {
  try {
    return new Headers(headers).get(name) ?? undefined;
  } catch {
    return undefined;
  }
}

/** A body the page passed to fetch's init or XHR's send. Only plain text is kept; nothing is read from a stream. */
export function sentBodyPart(body: unknown, contentType?: string): BodyPart | undefined {
  try {
    if (body === undefined || body === null) return undefined;
    if (typeof body === "string") return textPart(body, contentType);
    if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) return textPart(body.toString(), contentType ?? "application/x-www-form-urlencoded");
    if (typeof FormData !== "undefined" && body instanceof FormData) return { skipped: "FormData (may hold files), not kept" };
    if (typeof Blob !== "undefined" && body instanceof Blob) return { contentType: body.type || contentType, skipped: "Blob, not kept" };
    if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) return { contentType, skipped: "stream, not read (it would consume the request)" };
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return { contentType, skipped: "binary, not kept" };
    if (typeof Document !== "undefined" && body instanceof Document) return { skipped: "Document, not kept" };
    return { skipped: `${Object.prototype.toString.call(body)}, not kept` };
  } catch (e) {
    return { skipped: `not readable: ${errText(e)}` };
  }
}

/** fetch's request body. A Request object's body is read from a clone, which must be made before fetch() is called. */
export function fetchRequestPart(input: unknown, init: RequestInit | undefined): BodyPart | Promise<BodyPart> | undefined {
  try {
    if (init && init.body !== undefined && init.body !== null) return sentBodyPart(init.body, headerOf(init.headers, "content-type"));
    if (typeof Request === "undefined" || !(input instanceof Request) || !input.body) return undefined;
    const ct = input.headers.get("content-type") ?? "";
    if (ct && !isTextType(ct)) return { contentType: ct, skipped: `not a text type (${ct})` };
    if (input.bodyUsed) return { contentType: ct, skipped: "already used" };
    const copy = input.clone();
    return readCapped(copy.body!).then((p) => ({ ...(ct ? { contentType: ct } : {}), ...p }));
  } catch (e) {
    return { skipped: `not readable: ${errText(e)}` };
  }
}

/** fetch's response body, read from a clone. Call it before the page can read the response (in fetch's own .then). */
export function fetchResponsePart(res: Response): BodyPart | Promise<BodyPart> {
  try {
    if (res.type === "opaque" || res.type === "opaqueredirect") return { skipped: "opaque (no-cors) response, not readable" };
    const ct = res.headers.get("content-type") ?? "";
    if (!res.body) return { ...(ct ? { contentType: ct } : {}), skipped: "no body" };
    if (!isTextType(ct)) return { ...(ct ? { contentType: ct } : {}), skipped: ct ? `not a text type (${ct})` : "no content-type" };
    if (res.bodyUsed) return { contentType: ct, skipped: "already used" };
    const copy = res.clone();
    return readCapped(copy.body!).then((p) => ({ contentType: ct, ...p }));
  } catch (e) {
    return { skipped: `not readable: ${errText(e)}` };
  }
}

/** XHR's response, after loadend. responseText never consumes anything. */
export function xhrResponsePart(xhr: XMLHttpRequest): BodyPart {
  try {
    const ct = xhr.getResponseHeader("content-type") ?? "";
    if (!xhr.status) return { skipped: "no response" };
    if (!isTextType(ct)) return { ...(ct ? { contentType: ct } : {}), skipped: ct ? `not a text type (${ct})` : "no content-type" };
    if (xhr.responseType === "" || xhr.responseType === "text") return textPart(xhr.responseText, ct);
    if (xhr.responseType === "json") return textPart(JSON.stringify(xhr.response) ?? "", ct);
    return { contentType: ct, skipped: `responseType ${xhr.responseType}, not kept` };
  } catch (e) {
    return { skipped: `not readable: ${errText(e)}` };
  }
}
