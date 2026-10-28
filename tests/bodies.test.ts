import { describe, expect, it } from "vitest";
import { BODY_MAX, cutUtf8, fetchRequestPart, fetchResponsePart, isTextType, readCapped, sentBodyPart, xhrResponsePart } from "../src/shared/bodies";

const enc = new TextEncoder();
/** A stream that yields `chunks` with `gapMs` between them, then closes (or never closes when `endless`). */
function slowStream(chunks: string[], gapMs: number, endless = false) {
  let i = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(c) {
      await new Promise((r) => setTimeout(r, gapMs));
      if (cancelled) return;
      if (i < chunks.length) c.enqueue(enc.encode(chunks[i++]!));
      else if (endless) c.enqueue(enc.encode("."));
      else c.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, wasCancelled: () => cancelled };
}

describe("body capture", () => {
  it("text types", () => {
    for (const t of ["text/plain", "application/json; charset=utf-8", "application/problem+json", "application/xml", "application/x-www-form-urlencoded", "text/event-stream", "application/graphql"]) expect(isTextType(t)).toBe(true);
    for (const t of ["image/png", "application/octet-stream", "video/webm", "application/pdf", "multipart/form-data; boundary=x", ""]) expect(isTextType(t)).toBe(false);
  });

  it("reads a clone while the page reads the original stream, chunk by chunk, unchanged", async () => {
    const { stream } = slowStream(["one,", "two,", "three"], 20);
    const res = new Response(stream, { headers: { "content-type": "text/plain" } });
    const part = fetchResponsePart(res);
    const reader = res.body!.getReader();
    const seen: string[] = [];
    for (let r = await reader.read(); !r.done; r = await reader.read()) seen.push(new TextDecoder().decode(r.value));
    expect(seen).toEqual(["one,", "two,", "three"]);
    expect(await part).toEqual({ contentType: "text/plain", text: "one,two,three", size: 13 });
  });

  it("stops at the size cap and leaves the page's body whole", async () => {
    const big = "x".repeat(BODY_MAX * 3);
    const res = new Response(big, { headers: { "content-type": "application/json" } });
    const part = await fetchResponsePart(res);
    expect(part).toMatchObject({ truncated: "size", size: BODY_MAX });
    expect(part.text).toHaveLength(BODY_MAX);
    expect(await res.text()).toHaveLength(BODY_MAX * 3);
  });

  it("an endless stream: our read stops at the time limit and the page keeps reading", async () => {
    const { stream } = slowStream([], 10, true);
    const res = new Response(stream, { headers: { "content-type": "text/event-stream" } });
    const part = fetchResponsePart(res);
    const reader = res.body!.getReader();
    let n = 0;
    for (; n < 5; n++) await reader.read();
    expect(n).toBe(5);
    void reader.cancel();
    // The default window is 10 s; a short one proves the cut-off without waiting.
    const quick = await readCapped(slowStream([], 10, true).stream, BODY_MAX, 100);
    expect(quick.truncated).toBe("time");
    void part;
  });

  it("cancelling our clone after the cap never cancels the page's stream", async () => {
    const s = slowStream(["a".repeat(BODY_MAX), "b".repeat(10), "c"], 5);
    const res = new Response(s.stream, { headers: { "content-type": "text/plain" } });
    await fetchResponsePart(res);
    const all = await res.text();
    expect(all.endsWith("b".repeat(10) + "c")).toBe(true);
    expect(s.wasCancelled()).toBe(false);
  });

  it("skips non-text, opaque, empty and used responses with the reason", () => {
    expect(fetchResponsePart(new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } }))).toEqual({ contentType: "image/png", skipped: "not a text type (image/png)" });
    expect(fetchResponsePart(new Response(null, { status: 204 }))).toMatchObject({ skipped: "no body" });
    const used = new Response("x", { headers: { "content-type": "text/plain" } });
    void used.text();
    expect(fetchResponsePart(used)).toMatchObject({ skipped: "already used" });
    expect(fetchResponsePart({ type: "opaque" } as Response)).toMatchObject({ skipped: expect.stringMatching(/opaque/) });
  });

  it("request bodies: text kept, everything else skipped with the reason, a Request read from a clone", async () => {
    expect(sentBodyPart('{"a":1}', "application/json")).toEqual({ contentType: "application/json", text: '{"a":1}', size: 7 });
    expect(sentBodyPart(new URLSearchParams({ q: "1" }))).toMatchObject({ text: "q=1" });
    expect(sentBodyPart(new FormData())).toMatchObject({ skipped: expect.stringMatching(/FormData/) });
    expect(sentBodyPart(new Blob(["x"]))).toMatchObject({ skipped: expect.stringMatching(/Blob/) });
    expect(sentBodyPart(new Uint8Array(3))).toMatchObject({ skipped: expect.stringMatching(/binary/) });
    expect(sentBodyPart(new ReadableStream())).toMatchObject({ skipped: expect.stringMatching(/stream/) });
    expect(sentBodyPart(undefined)).toBeUndefined();
    expect(fetchRequestPart("https://x.test", { method: "POST", body: "hi", headers: { "content-type": "text/plain" } })).toEqual({ contentType: "text/plain", text: "hi", size: 2 });
    const req = new Request("https://x.test", { method: "POST", body: '{"b":2}', headers: { "content-type": "application/json" } });
    const part = await fetchRequestPart(req, undefined);
    expect(part).toEqual({ contentType: "application/json", text: '{"b":2}', size: 7 });
    expect(await req.text()).toBe('{"b":2}');
    expect(fetchRequestPart("https://x.test", undefined)).toBeUndefined();
  });

  it("XHR: responseText for text types, never throws", () => {
    const xhr = (o: Record<string, unknown>) => ({ status: 200, responseType: "", responseText: "", getResponseHeader: () => o.ct ?? null, ...o }) as unknown as XMLHttpRequest;
    expect(xhrResponsePart(xhr({ ct: "application/json", responseText: '{"ok":1}' }))).toEqual({ contentType: "application/json", text: '{"ok":1}', size: 8 });
    expect(xhrResponsePart(xhr({ ct: "application/json", responseType: "json", response: { ok: 1 } }))).toMatchObject({ text: '{"ok":1}' });
    expect(xhrResponsePart(xhr({ ct: "image/png" }))).toMatchObject({ skipped: "not a text type (image/png)" });
    expect(xhrResponsePart(xhr({ status: 0 }))).toEqual({ skipped: "no response" });
    expect(xhrResponsePart(xhr({ ct: "text/plain", responseType: "blob" }))).toMatchObject({ skipped: expect.stringMatching(/responseType blob/) });
    const throwing = { status: 200, responseType: "", getResponseHeader: () => "text/plain", get responseText(): string { throw new Error("InvalidStateError"); } } as unknown as XMLHttpRequest;
    expect(xhrResponsePart(throwing)).toMatchObject({ skipped: expect.stringMatching(/InvalidStateError/) });
  });
});

describe("byte caps (review-3 F7)", () => {
  it("text bodies are cut at 256 KiB of UTF-8, never inside a character", () => {
    const thai = "ก".repeat(BODY_MAX); // 3 bytes each
    const p = sentBodyPart(thai)!;
    expect(new TextEncoder().encode(p.text!).length).toBeLessThanOrEqual(BODY_MAX);
    expect(p.text!.endsWith("ก")).toBe(true);
    expect(p).toMatchObject({ truncated: "size", size: BODY_MAX });
    expect(cutUtf8("abc")).toEqual({ text: "abc", bytes: 3, cut: false });
  });

  it("a streamed response cut inside a character ends cleanly", async () => {
    const res = new Response("ก".repeat(BODY_MAX), { headers: { "content-type": "text/plain" } });
    const p = await fetchResponsePart(res);
    expect(p.truncated).toBe("size");
    expect(p.text!.endsWith("�")).toBe(false);
  });
});
