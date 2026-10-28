// Adapted from TraceBug (MIT, Copyright (c) 2026 Prashant Singh Mangat): collectApiRequests, collectXhrRequests,
// collectRouteChanges, collectErrors, collectConsoleErrors in src/collectors.ts.
// Runs in the page's MAIN world so it sees the page's own fetch/XHR/history/console.
import { fetchRequestPart, fetchResponsePart, sentBodyPart, xhrResponsePart, type BodyPart } from "../shared/bodies";
import { MAIN_CONTROL, MAIN_EVENT, MAIN_READY } from "../shared/messages";
import { pagePath, redactText, redactUrl } from "../shared/redact";

declare global {
  interface Window {
    __record2contextMain?: boolean;
  }
}

const MSG_MAX = 1000;
const STACK_LINES = 6;

(() => {
  if (window.__record2contextMain) {
    document.dispatchEvent(new CustomEvent(MAIN_READY));
    return;
  }
  window.__record2contextMain = true;

  // Until the isolated script says whether this tab records, keep a short buffer.
  let state: "pending" | "on" | "off" = "pending";
  const buffer: Record<string, unknown>[] = [];

  const send = (ev: Record<string, unknown>) => {
    if (state === "on") document.dispatchEvent(new CustomEvent(MAIN_EVENT, { detail: JSON.stringify(ev) }));
    else if (state === "pending" && buffer.length < 500 && ev.type !== "body") buffer.push(ev);
  };

  // Bodies go to the private folder only; the network event carries just the id that links to them.
  const pageNonce = Math.random().toString(36).slice(2, 10) || "x";
  let bodySeq = 0;
  const nextBodyId = () => `b${pageNonce}-${++bodySeq}`;
  const sendBody = (bodyId: string, base: { method: string; url: string }, status: number, request: BodyPart | Promise<BodyPart> | undefined, response: BodyPart | Promise<BodyPart>) => {
    const settle = (p: BodyPart | Promise<BodyPart> | undefined) => Promise.resolve(p).catch((e: unknown) => ({ skipped: `failed: ${String(e)}` }) as BodyPart);
    void Promise.all([settle(request), settle(response)]).then(([req, res]) => {
      if (state !== "on") return;
      send({ type: "body", bodyId, body: { method: base.method, url: base.url, status, ...(req ? { request: req } : {}), ...(res ? { response: res } : {}) } });
    });
  };

  document.addEventListener(MAIN_CONTROL, (e) => {
    try {
      const on = JSON.parse(String((e as CustomEvent).detail)).on === true;
      state = on ? "on" : "off";
      const queued = buffer.splice(0);
      if (on) queued.forEach(send);
    } catch {
      /* malformed control message */
    }
  });

  const path = () => pagePath(location);
  const skipUrl = (u: string) => /^(chrome-extension|data|blob|about|javascript):/i.test(u);
  const absolute = (u: string) => {
    try {
      return new URL(u, location.href).href;
    } catch {
      return u;
    }
  };

  // ── fetch ──
  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      let url = "";
      let method = "GET";
      try {
        if (typeof input === "string") url = input;
        else if (input instanceof URL) url = input.href;
        else if (input && typeof input === "object" && "url" in input) {
          url = input.url;
          method = input.method || "GET";
        }
        if (init?.method) method = init.method;
      } catch {
        /* never break the request */
      }
      const at = Date.now();
      const t0 = performance.now();
      const track = !!url && !skipUrl(url);
      // Only while this tab records: the script also runs in the other tabs during a session.
      const withBodies = track && state === "on";
      // Before fetch() runs: a Request's body can only be cloned while the page has not handed it over.
      let request: BodyPart | Promise<BodyPart> | undefined;
      if (withBodies) {
        try {
          request = fetchRequestPart(input, init);
        } catch {
          /* never break the request */
        }
      }
      // eslint-disable-next-line prefer-rest-params
      const p = origFetch.apply(this, arguments as unknown as [RequestInfo | URL, RequestInit?]);
      if (!track) return p;
      const bodyId = withBodies ? nextBodyId() : "";
      const base = { type: "network", at, path: path(), method: method.toUpperCase(), url: redactUrl(absolute(url)), source: "fetch", ...(bodyId ? { bodyId } : {}) };
      // Attached before the page gets the response, so the clone is made before the page can read it.
      p.then(
        (res) => {
          send({ ...base, status: res.status, durationMs: Math.round(performance.now() - t0) });
          if (!bodyId) return;
          let response: BodyPart | Promise<BodyPart> = { skipped: "not read" };
          try {
            response = fetchResponsePart(res);
          } catch {
            /* never break the response */
          }
          sendBody(bodyId, base, res.status, request, response);
        },
        (err) => {
          send({ ...base, status: 0, durationMs: Math.round(performance.now() - t0), error: redactText(String(err?.message ?? err)).slice(0, 200) });
          if (bodyId) sendBody(bodyId, base, 0, request, { skipped: "request failed" });
        },
      );
      return p;
    } as typeof window.fetch;
  }

  // ── XHR ──
  const XHR = window.XMLHttpRequest;
  if (XHR) {
    const meta = new WeakMap<XMLHttpRequest, { method: string; url: string }>();
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;
    XHR.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL) {
      try {
        meta.set(this, { method: String(method || "GET").toUpperCase(), url: String(url) });
      } catch {
        /* ignore */
      }
      // eslint-disable-next-line prefer-rest-params
      return (origOpen as (...a: unknown[]) => void).apply(this, Array.from(arguments));
    } as typeof XHR.prototype.open;
    XHR.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      try {
        const m = meta.get(this);
        if (m && !skipUrl(m.url)) {
          const at = Date.now();
          const t0 = performance.now();
          const p = path();
          const xhr = this;
          const bodyId = state === "on" ? nextBodyId() : "";
          const request = bodyId ? sentBodyPart(body, undefined) : undefined;
          let errored = "";
          xhr.addEventListener("error", () => (errored = "network error"));
          xhr.addEventListener("abort", () => (errored = "aborted"));
          xhr.addEventListener("timeout", () => (errored = "timeout"));
          xhr.addEventListener("loadend", () => {
            const url = redactUrl(absolute(m.url));
            send({
              type: "network",
              at,
              path: p,
              method: m.method,
              url,
              status: xhr.status,
              durationMs: Math.round(performance.now() - t0),
              source: "xhr",
              ...(bodyId ? { bodyId } : {}),
              ...(errored ? { error: errored } : {}),
            });
            if (bodyId) sendBody(bodyId, { method: m.method, url }, xhr.status, request, xhrResponsePart(xhr));
          });
        }
      } catch {
        /* never break the request */
      }
      return origSend.call(this, body);
    };
  }

  // ── Routes ──
  let lastPath = path();
  const route = (via: string) => {
    const now = path();
    if (now === lastPath) return;
    send({ type: "route_change", at: Date.now(), path: now, from: lastPath, to: now, via });
    lastPath = now;
  };
  for (const name of ["pushState", "replaceState"] as const) {
    const orig = history[name];
    history[name] = function (this: History, ...args: Parameters<History["pushState"]>) {
      const r = orig.apply(this, args);
      try {
        route(name);
      } catch {
        /* ignore */
      }
      return r;
    };
  }
  window.addEventListener("popstate", () => route("popstate"));
  window.addEventListener("hashchange", () => route("hashchange"));

  // ── Errors ──
  const cap = (raw: string) => {
    const s = redactText(raw);
    return s.length > MSG_MAX ? `${s.slice(0, MSG_MAX)}…` : s;
  };
  const shortStack = (s?: string) => (s ? cap(s.split("\n").slice(0, STACK_LINES).join("\n")) : undefined);
  const fmt = (a: unknown): string => {
    if (typeof a === "string") return a;
    if (a instanceof Error) return `${a.name}: ${a.message}`;
    try {
      return JSON.stringify(a) ?? String(a);
    } catch {
      return String(a);
    }
  };

  const origError = console.error;
  let inside = false;
  console.error = function (...args: unknown[]) {
    if (!inside) {
      inside = true;
      try {
        const err = args.find((a): a is Error => a instanceof Error);
        send({
          type: "console_error",
          at: Date.now(),
          path: path(),
          source: "console.error",
          message: cap(args.map(fmt).join(" ")),
          stack: shortStack(err?.stack ?? new Error().stack?.split("\n").slice(2).join("\n")),
        });
      } catch {
        /* ignore */
      } finally {
        inside = false;
      }
    }
    return origError.apply(this, args);
  };

  window.addEventListener("error", (e) => {
    if (!(e instanceof ErrorEvent)) return;
    send({
      type: "console_error",
      at: Date.now(),
      path: path(),
      source: "window.error",
      message: cap(e.message || "Script error"),
      stack: shortStack(e.error?.stack) ?? (e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : undefined),
    });
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    send({
      type: "console_error",
      at: Date.now(),
      path: path(),
      source: "unhandledrejection",
      message: cap(r instanceof Error ? `${r.name}: ${r.message}` : fmt(r)),
      stack: shortStack(r?.stack),
    });
  });

  document.dispatchEvent(new CustomEvent(MAIN_READY));
})();
