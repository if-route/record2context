// Page data (Decisions 15-16): storage snapshots, cookie names, locale, request/response bodies in the private folder
// only; the top level holds only what a tester uploads; a page reading streaming fetch still works while recording;
// a recording in the old layout (before details/) still plays and copies.
// Run: npm run build && node e2e/data.e2e.mjs
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startServer } from "./server.mjs";
import { ROOT, launch, log, markViaHud, readReport, startRecording, stopViaHud, waitForOutput } from "./lib.mjs";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
};

// Everything the fixture puts in storage, cookies or bodies that must stay in the private folder.
const PRIVATE = [
  "SECRET-LS-TOKEN-1",
  "SECRET-SS-CSRF-2",
  "SECRET-COOKIE-VALUE-3",
  "SECRET-COOKIE-VALUE-4",
  "secret.person@example.com",
  "eyJhbGciOiJIUzI1NiJ9",
  "U0VDUkVULUJBU0U2NC1WQUxVRS0xMjM0NTY3ODkwYWJj",
  "REQUEST-BODY-MARKER",
  "RESPONSE-BODY-MARKER",
  "chunk-3",
  "SECRET-NESTED-TOKEN",
  "SECRET-NESTED-PW",
  "SECRET-BIG-PW",
  "SECRET-PASS-WORD",
  "AKIASECRETKEYID12345",
  "SECRETCONSOLEKEY",
  "yyyyyyyyyy",
];
const leaks = (text) => PRIVATE.filter((s) => text.includes(s));

const { server, port } = await startServer(join(ROOT, "e2e", "fixtures"));
const env = await launch("data");
const { ctx, extId, sw } = env;
try {
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(`http://127.0.0.1:${port}/data.html`);
  await startRecording(ctx, extId, sw, page);
  await page.getByRole("button", { name: "Run calls" }).click();
  await page.waitForFunction(() => window.results?.done === true, null, { timeout: 30000 });
  const r = await page.evaluate(() => window.results);

  // ── The page is not disturbed ──
  check("streaming fetch: the page read all 5 chunks in order", r.stream.text === "chunk-1\nchunk-2\nchunk-3\nchunk-4\nchunk-5\n", JSON.stringify(r.stream.text));
  check("streaming fetch: chunks arrived as they were sent, not all at the end", r.stream.times.length >= 4 && r.stream.times.at(-1) - r.stream.times[0] >= 450, JSON.stringify(r.stream.times));
  check("an endless event stream: the page read its events and cancelled", JSON.stringify(r.endless) === JSON.stringify(["data: 1", "data: 2", "data: 3"]), JSON.stringify(r.endless));
  check("a 1 MiB response reaches the page whole (the recorder stops reading its copy at 256 KiB)", r.bigLength === 1024 * 1024 + 3 && r.bigEnd === "END", `${r.bigLength} ${r.bigEnd}`);
  check("fetch with a body, a Request object and XHR all get their echo", r.echo.got.includes("REQUEST-BODY-MARKER-1") && r.requestObject.got === "REQUEST-BODY-MARKER-2" && r.xhr.got === "REQUEST-BODY-MARKER-3");
  check("a binary response is untouched", r.imageBytes === 11, r.imageBytes);

  await page.evaluate(() => localStorage.setItem("beforeMark", "1"));
  const m = await markViaHud(page, "after the calls");
  await m.resume();
  await page.evaluate(() => localStorage.setItem("beforeStop", "1"));
  await page.waitForTimeout(800);
  await stopViaHud(page);
  const dir = await waitForOutput(env);
  const report = readReport(dir);
  const id = report.video.file.replace(/\.webm$/, "");
  const files = readdirSync(dir, { recursive: true }).map(String).sort();

  // ── Layout ──
  const top = readdirSync(dir).sort();
  check("top level: exactly the video and the Screenshot image, plus details/", JSON.stringify(top) === JSON.stringify([`${id}.webm`, "details", "screenshot-01.png"]), top.join(", "));
  const priv = "details/private-do-not-share/";
  check("details/ has the report, the AI README, context.md and the private folder", ["details/report.json", "details/AI-README.md", "details/context.md", `${priv}README.txt`].every((f) => files.includes(f)), files.join(", "));

  // ── Storage, cookies, locale ──
  const labels = (report.storage ?? []).map((s) => s.label);
  check("storage snapshots at Start, the Mark and Stop", JSON.stringify(labels) === JSON.stringify(["start", "mark-1", "stop"]), JSON.stringify(labels));
  const [start, atMark, atStop] = report.storage;
  const entry = (snap, area, key) => snap?.[area]?.entries.find((e) => e.key === key);
  check("sensitive keys hidden, plain values kept", entry(start, "local", "authToken")?.value === "[REDACTED]" && entry(start, "session", "csrf")?.value === "[REDACTED]" && entry(start, "local", "theme")?.value === "dark" && entry(start, "session", "step")?.value === "2");
  const profile = JSON.parse(entry(start, "local", "profile")?.value ?? "{}");
  check("JSON values redacted per field (email, jwt), the rest kept", profile.id === 7 && profile.email === "[EMAIL]" && profile.jwt === "[REDACTED]" && profile.lang === "th", JSON.stringify(profile));
  check("a long random value is redacted by its shape", entry(start, "local", "blob")?.value === "[REDACTED]");
  const nested = JSON.parse(JSON.parse(entry(start, "local", "persist:root")?.value ?? "{}").user ?? "{}");
  check("JSON kept as a string inside JSON is redacted per field (review-3 F1)", nested.name === "A" && nested.accessToken === "[REDACTED]" && nested.password === "[REDACTED]", JSON.stringify(nested));
  check("a JSON value cut at 64 KiB is hidden whole; a pass field and a short key id are hidden", entry(start, "local", "bigState")?.value === "[REDACTED]" && JSON.parse(entry(start, "local", "prefs")?.value ?? "{}").pass === "[REDACTED]" && entry(start, "local", "u")?.value === "[REDACTED]");
  check("a key in a console error is hidden, the message kept (review-3 Q2)", report.events.some((e) => e.type === "console_error" && e.message === "upstream rejected key [REDACTED]"));
  check("cookie names only", JSON.stringify(start?.cookieNames) === JSON.stringify(["sid", "prefs"]), JSON.stringify(start?.cookieNames));
  check("each snapshot is of its moment", !entry(start, "local", "beforeMark") && !!entry(atMark, "local", "beforeMark") && !!entry(atStop, "local", "beforeStop"));
  check("the Mark's snapshot is at the mark's t", atMark?.t === report.marks[0].t, `${atMark?.t} vs ${report.marks[0].t}`);
  const rawStart = JSON.parse(readFileSync(join(dir, start.privateFile), "utf8"));
  check("the private snapshot has the unredacted values (cookie values never read)", rawStart.local.entries.find((e) => e.key === "authToken")?.value === "SECRET-LS-TOKEN-1" && !JSON.stringify(rawStart).includes("SECRET-COOKIE-VALUE"), start.privateFile);
  check("language, locale and time zone in report.browser", typeof report.browser.language === "string" && typeof report.browser.locale === "string" && typeof report.browser.timeZone === "string" && Number.isInteger(report.browser.utcOffsetMinutes), JSON.stringify(report.browser));

  // ── Bodies ──
  const net = report.events.filter((e) => e.type === "network" && e.source !== "resource-timing");
  const bodyOf = (pathPart) => {
    const ev = net.find((e) => e.url.includes(pathPart));
    return ev?.bodyId && existsSync(join(dir, priv, "bodies", `${ev.bodyId}.json`)) ? JSON.parse(readFileSync(join(dir, priv, "bodies", `${ev.bodyId}.json`), "utf8")) : null;
  };
  const echo1 = bodyOf("/api/echo?n=1");
  check("fetch: request and response text in the private folder, linked by bodyId", echo1?.request?.text?.includes("REQUEST-BODY-MARKER-1") && echo1.response?.text?.includes("RESPONSE-BODY-MARKER-1") && echo1.response.contentType === "application/json", JSON.stringify(echo1));
  check("a Request object's body read from a clone", bodyOf("/api/echo?n=2")?.request?.text === "REQUEST-BODY-MARKER-2");
  check("XHR request and response", bodyOf("/api/echo?n=3")?.request?.text === "REQUEST-BODY-MARKER-3" && bodyOf("/api/echo?n=3")?.response?.text?.includes("RESPONSE-BODY-MARKER-3"));
  check("the streamed response kept whole", bodyOf("/api/stream")?.response?.text === r.stream.text);
  const big = bodyOf("/api/big")?.response;
  check("a body over 256 KiB is cut there and says so", big?.truncated === "size" && big.size === 256 * 1024 && big.text.length === 256 * 1024, JSON.stringify({ ...big, text: big?.text?.length }));
  check("a binary response is skipped with the reason", bodyOf("/api/image")?.response?.skipped === "not a text type (image/png)", JSON.stringify(bodyOf("/api/image")?.response));
  check("privateData names the folder and counts the bodies", report.privateData?.dir === "details/private-do-not-share" && report.privateData.bodies.saved === net.filter((e) => e.bodyId).length && report.privateData.storageFiles.length === 3, JSON.stringify(report.privateData));

  // ── Nothing private in what gets shared ──
  const reportText = readFileSync(join(dir, "details", "report.json"), "utf8");
  const contextMd = readFileSync(join(dir, "details", "context.md"), "utf8");
  const portable = env.last.context;
  check("report.json holds no body text and no unredacted storage value", !leaks(reportText).length, leaks(reportText).join(", "));
  check("context.md holds none of it either", !leaks(contextMd).length, leaks(contextMd).join(", "));
  check("the portable context (Copy portable context) holds none of it", portable === contextMd && !leaks(portable).length, leaks(portable).join(", "));
  check("context.md does not point at the private folder", !contextMd.includes("private-do-not-share"));
  const readme = readFileSync(join(dir, "details", "AI-README.md"), "utf8");
  check("AI-README.md holds none of it, and names the private folder", !leaks(readme).length && readme.includes("details/private-do-not-share/"), leaks(readme).join(", "));

  // ── A recording in the old layout, on disk only: still listed, played and copied ──
  const oldId = "2026-01-02_030405_old-layout";
  const oldDir = join(env.folderPath, oldId);
  mkdirSync(join(oldDir, "screenshots"), { recursive: true });
  copyFileSync(join(dir, `${id}.webm`), join(oldDir, `${oldId}.webm`));
  copyFileSync(join(dir, "screenshot-01.png"), join(oldDir, "screenshots", "01.png"));
  const oldReport = JSON.parse(reportText.replaceAll(`${id}.webm`, `${oldId}.webm`).replaceAll('"screenshot-01.png"', '"screenshots/01.png"'));
  delete oldReport.storage;
  delete oldReport.privateData;
  oldReport.schemaVersion = 4;
  writeFileSync(join(oldDir, "report.json"), JSON.stringify(oldReport));
  writeFileSync(join(oldDir, "AI-README.md"), "# old");
  writeFileSync(join(oldDir, "context.md"), "old context");
  const oldPaths = ["AI-README.md", "context.md", "report.json", "screenshots/01.png", `${oldId}.webm`];
  await sw.evaluate(
    async ({ oldId, oldDir, oldPaths }) => {
      const { recent = [] } = await chrome.storage.local.get("recent");
      recent.push({ id: oldId, host: "old.test", startedAt: "2026-01-02T03:04:05.000Z", durationMs: 3000, marks: 1, context: "old context", emailsMasked: true, paths: oldPaths, folderCopy: { dir: oldDir } });
      await chrome.storage.local.set({ recent });
    },
    { oldId, oldDir, oldPaths },
  );
  const rp = await ctx.newPage();
  await rp.goto(`chrome-extension://${extId}/recordings.html`);
  const row = rp.locator(`tr[data-id="${oldId}"]`);
  await row.waitFor({ timeout: 5000 });
  check("old layout: listed as in the folder", (await row.locator("[data-state]").getAttribute("data-state")) === "folder");
  await rp.evaluate(() => {
    window.__copied = [];
    navigator.clipboard.writeText = async (t) => void window.__copied.push(t);
  });
  await row.getByRole("button", { name: "Copy for my AI" }).click();
  await row.getByRole("button", { name: "Copy portable context" }).click();
  await rp.waitForTimeout(300);
  const copied = await rp.evaluate(() => window.__copied);
  check("old layout: Copy for my AI points at its AI-README.md", copied[0]?.endsWith(`${oldDir} — read AI-README.md there for the format.`), copied[0]);
  check("old layout: Copy portable context gives its context", copied[1] === "old context", copied[1]);
  await row.getByRole("button", { name: "Open" }).click();
  const video = rp.locator("video");
  await video.waitFor({ timeout: 10000 });
  const duration = await video.evaluate((v) => new Promise((res) => (v.readyState >= 1 ? res(v.duration) : (v.onloadedmetadata = () => res(v.duration)), (v.onerror = () => res(`error ${v.error?.code}`)))));
  check("old layout: the video plays from the folder", typeof duration === "number" && duration > 1, String(duration));
  const thumb = rp.locator('[data-testid="mark-thumb"]').first();
  await thumb.waitFor({ timeout: 5000 });
  const w = await thumb.evaluate((i) => (i.complete ? i.naturalWidth : new Promise((res) => ((i.onload = () => res(i.naturalWidth)), (i.onerror = () => res(0))))));
  check("old layout: the mark's screenshot shows", w > 0, String(w));
} catch (e) {
  check("no exception", false, e.stack);
} finally {
  await ctx.close();
  server.close();
}
const failed = results.filter((r) => !r.ok);
log(`${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length ? 1 : 0;
