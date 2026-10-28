import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { buildAiReadme } from "../src/shared/ai-readme";
import { buildPortableContext } from "../src/shared/context";
import { appendEvent, emptyLog } from "../src/shared/event-log";
import { isSensitiveKey, redactStorageValue, redactText, redactValueText } from "../src/shared/redact";
import { buildReport } from "../src/shared/report";
import { collectPageStorage, summarizeSnapshot, PREVIEW, type RawSnapshot } from "../src/shared/storage-snapshot";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
const B64 = "dGhpcyBpcyBhIHNlY3JldCB2YWx1ZSB0aGF0IGlzIGxvbmc9";
const HEX = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const UUID = "123e4567-e89b-12d3-a456-426614174000";

const fakeStorage = (data: Record<string, string>) => ({
  get length() {
    return Object.keys(data).length;
  },
  key: (i: number) => Object.keys(data)[i] ?? null,
  getItem: (k: string) => data[k] ?? null,
});

describe("storage redaction", () => {
  it.each(["authToken", "access_token", "refreshToken", "sessionId", "api-key", "jwt", "csrf", "XSRF-TOKEN", "password", "user_pin", "sid", "cookieConsentId"])(
    "the whole value of %s is hidden",
    (key) => {
      expect(isSensitiveKey(key)).toBe(true);
      expect(redactStorageValue(key, "anything")).toEqual({ value: "[REDACTED]", redacted: true });
    },
  );

  it.each(["theme", "lang", "lastVisitedPage", "sidebarCollapsed", "pinned", "consider"])("%s is not a sensitive name", (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });

  it.each([
    ["a JWT", `x ${JWT} y`, "x [REDACTED_JWT] y"],
    ["a Bearer token", "Bearer abcdefgh12345678", "Bearer [REDACTED]"],
    ["long base64", B64, "[REDACTED]"],
    ["a hex hash", HEX, "[REDACTED]"],
    ["a UUID", UUID, "[REDACTED]"],
    ["an email", "owner is a.b@example.com", "owner is [EMAIL]"],
  ])("by shape: %s", (_name, input, out) => {
    expect(redactValueText(input)).toBe(out);
  });

  it("keeps ordinary values, words and short ids", () => {
    for (const v of ["dark", "th-TH", "42", "true", "/projects/17/overview", "a-long-but-plain-kebab-case-setting-name"]) expect(redactValueText(v)).toBe(v);
  });

  it("redacts JSON values per field and by shape, and says so", () => {
    const v = JSON.stringify({ user: { id: 7, email: "a@b.co", accessToken: "zzz" }, list: [B64, "ok"], theme: "dark" });
    const r = redactStorageValue("app-state", v);
    expect(r.redacted).toBe(true);
    expect(JSON.parse(r.value)).toEqual({ user: { id: 7, email: "[EMAIL]", accessToken: "[REDACTED]" }, list: ["[REDACTED]", "ok"], theme: "dark" });
    expect(redactStorageValue("app-state", '{"theme":"dark"}')).toEqual({ value: '{"theme":"dark"}', redacted: false });
  });
});

describe("storage snapshot", () => {
  afterEach(() => vi.unstubAllGlobals());


  it("reads keys and values within the caps, cookie names only, and records an unreadable area", () => {
    vi.stubGlobal("localStorage", fakeStorage({ a: "1".repeat(10), b: "2".repeat(10), c: "3" }));
    vi.stubGlobal("location", { origin: "https://app.test" });
    vi.stubGlobal("document", { cookie: "sid=SECRETCOOKIE; theme=dark; sid=again" });
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, get: () => { throw new Error("SecurityError: denied"); } });
    try {
      const raw = collectPageStorage(2, 6, 9);
      expect(raw.origin).toBe("https://app.test");
      expect(raw.local).toEqual({ keys: 3, entries: [{ key: "a", value: "111111", length: 10 }, { key: "b", value: "222", length: 10 }] });
      expect(raw.session).toEqual({ keys: 0, entries: [], error: "SecurityError: denied" });
      expect(raw.cookieNames).toEqual(["sid", "theme"]);
      expect(JSON.stringify(raw)).not.toContain("SECRETCOOKIE");
    } finally {
      delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
    }
  });

  it("summarises with redacted, shortened values and flags values past the size budget", () => {
    const raw: RawSnapshot = {
      origin: "https://app.test",
      local: { keys: 3, entries: [{ key: "token", value: "tok-SECRET", length: 10 }, { key: "notes", value: "x".repeat(500), length: 500 }, { key: "big", value: null, length: 9e6 }] },
      session: { keys: 0, entries: [] },
      cookieNames: ["sid"],
    };
    const s = summarizeSnapshot(raw, { n: 1, label: "start", at: 0, privateFile: "details/private-do-not-share/storage/01-start.json" });
    expect(s.local!.entries[0]).toEqual({ key: "token", value: "[REDACTED]", length: 10, redacted: true });
    expect(s.local!.entries[1]!.value).toHaveLength(PREVIEW + 1);
    expect(s.local!.entries[1]!.truncated).toBe(true);
    expect(s.local!.entries[2]).toEqual({ key: "big", length: 9e6, truncated: true });
  });
});

describe("private data never reaches report.json, context.md or AI-README", () => {
  const START = Date.UTC(2026, 9, 28, 3, 0, 0);
  const SECRETS = ["tok-SECRET-1", JWT, B64, "owner@example.com", "COOKIEVALUE", "REQUEST-BODY-MARKER", "RESPONSE-BODY-MARKER"];

  function report() {
    const log = emptyLog();
    appendEvent(log, { type: "page_load", at: START + 10, path: "/", navigationType: "navigate", initial: true, url: "https://app.test/", title: "App" });
    appendEvent(log, { type: "network", at: START + 100, path: "/", method: "POST", url: "https://api.test/save", status: 200, durationMs: 5, source: "fetch", bodyId: "babc-1" });
    appendEvent(log, { type: "network", at: START + 200, path: "/", method: "GET", url: "https://api.test/list", status: 200, durationMs: 5, source: "fetch", bodyId: "babc-2" });
    const raw: RawSnapshot = {
      origin: "https://app.test",
      local: { keys: 4, entries: [{ key: "authToken", value: "tok-SECRET-1", length: 12 }, { key: "profile", value: JSON.stringify({ email: "owner@example.com", jwt: JWT }), length: 80 }, { key: "blob", value: B64, length: B64.length }, { key: "theme", value: "dark", length: 4 }] },
      session: { keys: 1, entries: [{ key: "x", value: `Bearer ${B64}`, length: 60 }] },
      cookieNames: ["sid"],
    };
    return buildReport({
      version: "0.2.0",
      clock: { videoStart: START, pauses: [] },
      stoppedAt: START + 5000,
      stopReason: "user",
      startUrl: "https://app.test/",
      env: { userAgent: "UA", os: "mac", arch: "arm64", viewport: { width: 1280, height: 800 }, dpr: 2, language: "th-TH", languages: ["th-TH", "en"], locale: "th-TH", timeZone: "Asia/Bangkok", utcOffsetMinutes: 420 },
      video: null,
      videoError: "no video",
      log,
      storage: [summarizeSnapshot(raw, { n: 1, label: "start", at: START + 50, privateFile: "details/private-do-not-share/storage/01-start.json" })],
      bodies: { saved: ["babc-1"], bytes: 300, skipped: { "not a text type (image/png)": 1 } },
    });
  }

  it("report.json keeps keys, redacted values, the env, the body link only, and the private folder by path", () => {
    const r = report();
    const json = JSON.stringify(r);
    for (const s of SECRETS) expect(json).not.toContain(s);
    expect(r.storage[0]).toMatchObject({ label: "start", t: 50, cookieNames: ["sid"] });
    expect(r.storage[0]!.local!.entries.find((e) => e.key === "theme")?.value).toBe("dark");
    expect(r.browser).toMatchObject({ language: "th-TH", locale: "th-TH", timeZone: "Asia/Bangkok", utcOffsetMinutes: 420 });
    const net = r.events.filter((e) => e.type === "network");
    expect(net.map((e) => (e as { bodyId?: string }).bodyId)).toEqual(["babc-1", undefined]);
    expect(r.privateData).toMatchObject({ dir: "details/private-do-not-share", storageFiles: ["details/private-do-not-share/storage/01-start.json"], bodies: { saved: 1, skipped: { "not a text type (image/png)": 1 } } });
  });

  it("context.md and AI-README carry none of it either, and context.md does not point at the private folder", () => {
    const r = report();
    const ctx = buildPortableContext(r, "2026-10-28_100000_app-test").markdown;
    const readme = buildAiReadme(r, "2026-10-28_100000_app-test");
    for (const s of SECRETS) {
      expect(ctx).not.toContain(s);
      expect(readme).not.toContain(s);
    }
    expect(ctx).not.toContain("private-do-not-share");
    expect(ctx).not.toContain("babc-1");
    expect(ctx).toMatch(/"timeZone": ?"Asia\/Bangkok"/);
  });
});

describe("review-3 F1/F2: planted secrets never reach the redacted value", () => {
  const leaks = (out: string, planted: string[]) => planted.filter((p) => out.includes(p));

  it("JSON stored as a string inside JSON (redux-persist style), several levels deep", () => {
    const inner = JSON.stringify({ name: "A", accessToken: "PLANTED-NESTED-TOKEN", password: "PLANTED-NESTED-PW", deeper: JSON.stringify({ apiKey: "PLANTED-DEEP-KEY", ok: 1 }) });
    const r = redactStorageValue("persist:root", JSON.stringify({ user: inner, theme: "dark" }));
    expect(leaks(r.value, ["PLANTED-NESTED-TOKEN", "PLANTED-NESTED-PW", "PLANTED-DEEP-KEY"])).toEqual([]);
    const user = JSON.parse(JSON.parse(r.value).user);
    expect(user).toMatchObject({ name: "A", accessToken: "[REDACTED]", password: "[REDACTED]" });
    expect(JSON.parse(user.deeper)).toEqual({ apiKey: "[REDACTED]", ok: 1 });
    expect(JSON.parse(r.value).theme).toBe("dark");
  });

  it("nesting past the depth cap is hidden, not shown", () => {
    let v = JSON.stringify({ secretish: "PLANTED-AT-THE-BOTTOM" });
    for (let i = 0; i < 15; i++) v = JSON.stringify({ wrap: v });
    expect(redactStorageValue("x", v).value).not.toContain("PLANTED-AT-THE-BOTTOM");
  });

  it("a JSON value cut at the size cap (no longer parses) is hidden whole, before the preview is cut", () => {
    const big = JSON.stringify({ user: { password: "PLANTED-BIG-PW" }, pad: "a ".repeat(40000) }).slice(0, 64 * 1024);
    expect(redactStorageValue("big", big)).toEqual({ value: "[REDACTED]", redacted: true });
    const raw: RawSnapshot = { origin: "o", local: { keys: 1, entries: [{ key: "big", value: big, length: 80047 }] }, session: { keys: 0, entries: [] }, cookieNames: [] };
    expect(JSON.stringify(summarizeSnapshot(raw, { n: 1, label: "start", at: 0 }))).not.toContain("PLANTED-BIG-PW");
  });

  it.each(["pass", "userPass", "user_pw", "PW", "PHPSESSID", "loginPasscode"])("%s is a sensitive name", (key) => {
    expect(isSensitiveKey(key)).toBe(true);
    expect(redactStorageValue("prefs", JSON.stringify({ [key]: "PLANTED-PASS-1", user: "bob" })).value).not.toContain("PLANTED-PASS-1");
  });

  it.each(["passenger", "compass", "passive", "pinned", "spinner", "consider", "sidebar"])("%s is not", (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });

  it.each([
    ["an AWS key id under an innocent key", "AKIAPLANTED20CHARS01"],
    ["a 16-character session id", "a1b2c3d4e5f6g7h8"],
    ["an OpenAI key", "sk-proj-PLANTEDabc123XYZ7890qwe"],
    ["a GitHub token", "ghp_PLANTEDabcdefghijklmnopqrstu12345"],
    ["a GitHub fine-grained token", "github_pat_11PLANTED0abcdefghijkl_mnopqrstuvwxyz"],
    ["a Slack token", "xoxb-1234-PLANTED-abcdef"],
    ["a Google API key", "AIzaSyPLANTED-abcdefghijklmnopqrstu"],
    ["a GitLab token", "glpat-PLANTEDabcdefghij12"],
    ["a UUID (decided: ids are hidden too)", "123e4567-e89b-12d3-a456-426614174000"],
  ])("by shape: %s", (_name, secret) => {
    const r = redactStorageValue("u", `value ${secret} end`);
    expect(r.value).toBe("value [REDACTED] end");
    expect(r.redacted).toBe(true);
  });

  it.each([
    "/projects/12345/assets/67890/edit",
    "https://example.com/a/b?x=1",
    "api2.example.com",
    "2026-10-28T10:00:00Z",
    "th-TH",
    "1.2.3-beta.4",
    "abc123def456ghi",
    "a-long-but-plain-kebab-case-setting-name",
    "someVeryLongCamelCaseIdentifierWithoutDigitsAtAll",
    "1730112345678901",
  ])("kept: %s", (v) => {
    expect(redactStorageValue("u", v)).toEqual({ value: v, redacted: false });
  });
});

describe("review-3 Q2: the same shapes in console text, errors and labels (redactText)", () => {
  it("hides keys and ids, keeps the message", () => {
    expect(redactText("Request failed: key sk-proj-PLANTEDCONSOLEKEY1234567890 rejected")).toBe("Request failed: key [REDACTED] rejected");
    expect(redactText("session a1b2c3d4e5f6g7h8i9 expired at /projects/12/edit")).toBe("session [REDACTED] expired at /projects/12/edit");
    expect(redactText("Save changes")).toBe("Save changes");
  });

  it("a console error with a key reaches neither report.json nor context.md", () => {
    const START = Date.UTC(2026, 9, 28, 3, 0, 0);
    const log = emptyLog();
    appendEvent(log, { type: "console_error", at: START + 10, path: "/", source: "console.error", message: redactText("bad key AKIAPLANTEDCONSOLE001") });
    const r = buildReport({ version: "1", clock: { videoStart: START, pauses: [] }, stoppedAt: START + 1000, stopReason: "user", startUrl: "https://app.test/", env: { userAgent: "UA", os: "mac", arch: "arm64", viewport: { width: 1, height: 1 }, dpr: 1 }, video: null, log });
    expect(JSON.stringify(r)).not.toContain("AKIAPLANTEDCONSOLE001");
    expect(buildPortableContext(r, "s").markdown).not.toContain("AKIAPLANTEDCONSOLE001");
  });
});

describe("review-4 N1: base64 secrets with `/` are judged as one token", () => {
  const b64 = (s: string) => Buffer.from(s).toString("base64");
  const SLASHY = b64('{"pw":"???>>>???>>>~~~"}');
  const BLOB2 = b64(JSON.stringify({ user: "bob", password: "a?b?c?d?e?f?g?h?" }));

  it("hides the probe values whole, in storage and in console text", () => {
    expect(SLASHY).toContain("/");
    expect(redactStorageValue("blob", SLASHY).value).toBe("[REDACTED]");
    expect(redactStorageValue("blob2", BLOB2).value).toBe("[REDACTED]");
    expect(redactText(`Request failed: b64 ${SLASHY}`)).toBe("Request failed: b64 [REDACTED]");
  });

  it.each([32, 48])("random %i-byte base64 keys inside text are never shown in part", (n) => {
    for (let i = 0; i < 300; i++) {
      const key = randomBytes(n).toString("base64");
      const out = redactText(`token ${key} sent`);
      for (const piece of key.split(/[/+=.]/).filter((p) => p.length >= 4)) expect(out).not.toContain(piece);
    }
  });

  it("paths and host names stay readable", () => {
    for (const s of ["/projects/12345/assets/67890/edit", "src/components/Button2.tsx", "https://deploy-preview-123--myapp.netlify.app/x"]) expect(redactText(s)).toBe(s);
  });
});

describe("review-4 N2: redaction runs before a size cut", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("a key cut by the storage budget leaves no fragment", () => {
    vi.stubGlobal("localStorage", fakeStorage({ filler: "x".repeat(100), tok: "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345" }));
    vi.stubGlobal("sessionStorage", fakeStorage({}));
    vi.stubGlobal("location", { origin: "o" });
    vi.stubGlobal("document", { cookie: "" });
    const s = summarizeSnapshot(collectPageStorage(500, 64 * 1024, 110), { n: 1, label: "start", at: 0 });
    expect(s.local!.entries[1]).toEqual({ key: "tok", value: "", length: 40 });
    expect(JSON.stringify(s)).not.toContain("sk-proj");
  });
});

describe("review-4 N3: ids made of words and short numbers stay readable", () => {
  it.each(["checkout-step-2-continue", "react-select-3-input", "headlessui-menu-button-1", "order-row-123456", "data-testid=order-row-12345"])("%s", (s) => {
    expect(redactText(s)).toBe(s);
  });

  it("planted secrets are still hidden", () => {
    for (const s of ["AKIAIOSFODNN7EXAMPLE", "sk-proj-ABCDEFGHIJ0123456789", "ghp_ABCDEFGHIJKLMNOPQRST0123456789", "a1b2c3d4e5f6g7h8i9", "Zq8Lm3Np7Rt2Vx9Kb4Hd6Fj1", UUID, HEX, JWT, B64])
      expect(redactText(`x ${s} y`)).not.toContain(s);
  });
});
