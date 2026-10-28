// Local E2E: typing, rich editors, masking, keys, network, route change, console error, screenshot, reload,
// two Marks (pauses) and the popup's copy / show buttons. Local test page only.
// Run: npm run build && node e2e/local.e2e.mjs
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { startServer } from "./server.mjs";
import {
  OUT,
  ROOT,
  exportSession,
  FRAME_MS,
  checkClickFrame,
  checkVideoInBrowser,
  flash,
  flashAtT,
  ffprobe,
  framesWithCentre,
  frameCrop,
  markViaHud,
  ripplePixels,
  toVideoPx,
  videoOf,
  launch,
  log,
  readReport,
  startRecording,
  status,
  stopViaHud,
  waitForOutput,
} from "./lib.mjs";

// Every address the fixture types, shows or requests; none may reach report.json or context.md.
const EMAIL_ANY = /tester@example|work\.person@example|qa\.person(@|%40)example/;

// Long Thai note with a line break; typed into the HUD, so it must never show up as page input.
const THAI_NOTE = [
  "ตรงนี้กดปุ่ม Settings แล้วหน้าจอไม่เปลี่ยน ทั้งที่ควรเปิดหน้าตั้งค่า ".repeat(6).trim(),
  "ลองกดซ้ำอีกสองครั้งก็ยังเหมือนเดิม และมี request ไปที่ /api/fail ได้ 500 กลับมา ".repeat(5).trim(),
].join("\n");
/** Click with a 100 ms press like a person; returns the page's own pointerdown-to-click gap (the ripple shows on press). */
async function heldClick(locator) {
  const page = locator.page();
  await page.evaluate(() => {
    addEventListener("pointerdown", () => (window.__qaDownAt = Date.now()), { capture: true, once: true });
    addEventListener("click", () => (window.__qaDownGap = Date.now() - window.__qaDownAt), { capture: true, once: true });
  });
  await locator.click({ delay: 100 });
  return page.evaluate(() => window.__qaDownGap);
}
const pad2 = (n) => String(n).padStart(2, "0");
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
};

const { server, port } = await startServer(join(ROOT, "e2e", "fixtures"));
const base = `http://127.0.0.1:${port}`;
const env = await launch("local");
const { ctx, sw, extId, downloads } = env;
let videoServer;
try {
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(`${base}/`);
  await page.waitForFunction(() => window.joditReady === true, null, { timeout: 20000 });

  await startRecording(ctx, extId, sw, page);
  check("recording started", (await status(sw)) === "recording");
  await page.waitForTimeout(800);

  await page.locator("input[name=title]").click();
  await page.keyboard.type("Hello QA", { delay: 20 });
  await page.keyboard.press("Tab");
  await page.keyboard.type("n".repeat(250));
  await page.locator("select[name=unit]").selectOption("GWh");
  await page.locator("input[name=password]").fill("hunter2");
  await page.locator("input[name=api_token]").fill("tok-123");
  await page.locator("input[name=login]").fill("tester@example.com");
  await page.locator("input[name=work]").fill("work.person@example.com");
  await page.locator("input[name=agree]").check();
  await page.locator("#plain").click();
  await page.keyboard.type("Plain rich text", { delay: 10 });
  const jodit = page.locator(".jodit-wysiwyg");
  await jodit.click();
  await page.keyboard.type("Jodit line 1", { delay: 10 });
  await page.keyboard.press("Enter");
  await page.keyboard.type("Jodit line 2", { delay: 10 });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(700);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.locator("span.card-body").click();
  await page.getByRole("button", { name: "Load data" }).click();
  await page.getByRole("button", { name: "XHR call" }).click();
  await page.getByRole("button", { name: "Failing call" }).click();
  await page.getByRole("button", { name: /^Find / }).click();
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "Go to details" }).click();
  // The Settings ripple sits inside Log error's crop; let it go (800 ms) so the frame before this click is clean.
  await page.waitForTimeout(1000);
  const logErrGap = await heldClick(page.getByRole("button", { name: "Log error" }));
  await page.waitForTimeout(500);

  // Kill the service worker mid-recording: state must come back from chrome.storage.session.
  await sw.evaluate(() => (self.__qaMarker = 1));
  const extPage = await ctx.newPage();
  await extPage.goto(`chrome-extension://${extId}/popup.html`);
  const cdp = await ctx.newCDPSession(extPage);
  await cdp.send("ServiceWorker.enable");
  await cdp.send("ServiceWorker.stopAllWorkers");
  await extPage.waitForTimeout(1000);
  await extPage.reload(); // its status request wakes a fresh worker
  await extPage.waitForTimeout(1000);
  const fresh = ctx.serviceWorkers().at(-1);
  const marker = await Promise.race([fresh.evaluate(() => self.__qaMarker ?? null), new Promise((r) => setTimeout(() => r("timeout"), 3000))]);
  check("service worker restarted mid-recording", marker === null, `marker=${marker}`);
  check("still recording after worker restart", (await status(fresh)) === "recording");
  await extPage.close();
  await page.bringToFront();
  await page.getByRole("button", { name: "Settings" }).click();
  await page.waitForTimeout(500);

  await flash(page, "before-pause");
  await page.waitForTimeout(300);
  // Mark 1: long Thai note, page events while paused, Enter continues.
  const mark1 = await markViaHud(page, THAI_NOTE);
  check("Screenshot opens the editor on the paused frame, HUD hidden", (await page.locator("record2context-ui .ed canvas").isVisible()) && !(await page.locator("record2context-ui .hud").isVisible()) && (await page.locator("record2context-ui button.mark").isDisabled()));
  await page.evaluate(() => {
    void fetch("/api/ping?during=pause");
    console.error("error while paused");
  });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(OUT, "local-mark-note.png") });
  await mark1.resume();
  await page.waitForTimeout(700);
  await flash(page, "after-pause");
  await page.waitForTimeout(400);
  const xhrAfterGap = await heldClick(page.getByRole("button", { name: "XHR call" }));
  await page.waitForTimeout(800);

  await page.reload();
  await page.locator("record2context-ui .hud").waitFor({ timeout: 10000 });
  check("HUD back after reload", true);
  await page.waitForTimeout(500);
  // Mark 2: shortcut, empty note, the Continue button.
  const mark2 = await markViaHud(page, "", { shortcut: true, continueWith: "button" });
  await page.waitForTimeout(1500);
  await mark2.resume();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Load data" }).click();
  await page.waitForTimeout(1500);

  const stopClickedAt = Date.now();
  await stopViaHud(page);
  const dir = await waitForOutput(env);
  log("output:", dir);
  const sw2 = ctx.serviceWorkers().at(-1);
  check("idle after stop", (await status(sw2)) === "idle");

  const report = readReport(dir);
  const ev = report.events;
  const of = (type) => ev.filter((e) => e.type === type);
  const inputs = of("input");
  const byName = (re) => inputs.filter((e) => re.test(e.selector) || re.test(e.label));

  check("t is non-decreasing", ev.every((e, i) => i === 0 || e.t >= ev[i - 1].t));
  check("initial page_load", of("page_load")[0]?.initial === true);
  check("reload page_load", of("page_load").some((e) => e.navigationType === "reload" && !e.initial));
  const title = byName(/title/i).at(-1);
  check("text input value", title?.value === "Hello QA", JSON.stringify(title));
  const notes = byName(/notes/i).at(-1);
  check("textarea truncated with true length", notes?.value.length === 200 && notes?.valueLength === 250 && notes?.truncated, JSON.stringify({ len: notes?.value.length, valueLength: notes?.valueLength }));
  check("select value", byName(/unit/i).at(-1)?.value === "GWh");
  const pw = byName(/password/i).at(-1);
  check("password masked", pw?.value === "[MASKED]" && pw?.valueLength === 7 && !JSON.stringify(report).includes("hunter2"));
  const tok = byName(/api_token|API token/i).at(-1);
  check("sensitive-named field masked", tok?.masked === true && !JSON.stringify(report).includes("tok-123"));
  const login = byName(/login|Email Address/i).at(-1);
  check("email-labelled field masked", login?.value === "[MASKED]" && login?.valueLength === "tester@example.com".length, JSON.stringify(login));
  const work = inputs.filter((e) => e.inputType === "email").at(-1);
  check("type=email field masked", work?.masked === true && work?.valueLength === "work.person@example.com".length, JSON.stringify(work));
  const find = of("click").find((c) => /^Find /.test(c.label));
  check("click label email replaced", find?.label === "Find [EMAIL]", find?.label);
  check("fetch query emails replaced", of("network").some((n) => n.url.includes("user=[EMAIL]&owner=[EMAIL]")));
  check("console error email replaced", of("console_error").some((e) => e.message === "no access for [EMAIL]"));
  check("report.json has no email address", !EMAIL_ANY.test(JSON.stringify(report)), EMAIL_ANY.exec(JSON.stringify(report))?.[0]);
  check("checkbox", byName(/agree/i).at(-1)?.value === "checked");
  const plain = inputs.filter((e) => e.inputType === "contenteditable" && /Plain/.test(e.value)).at(-1);
  check("contenteditable input", plain?.value === "Plain rich text", JSON.stringify(plain));
  const jod = inputs.filter((e) => e.inputType === "contenteditable" && /Jodit line 1/.test(e.value)).at(-1);
  check("Jodit input (multi-line)", /Jodit line 1\s*\n+\s*Jodit line 2/.test(jod?.value ?? ""), JSON.stringify(jod?.value));
  check("Jodit field label", jod?.label?.length > 0, jod?.label);
  const keys = of("key").map((e) => e.key);
  check("Tab/Enter/Escape keys", ["Tab", "Enter", "Escape"].every((k) => keys.includes(k)), keys.join(","));
  const enter = of("key").find((e) => e.key === "Enter");
  const jodBeforeEnter = inputs.find((e) => e.inputType === "contenteditable" && /Jodit line 1/.test(e.value) && e.t <= enter?.t);
  check("input flushed before Enter", !!jodBeforeEnter);
  const clicks = of("click");
  check("every click labelled", clicks.length > 0 && clicks.every((c) => c.label && c.label.trim()), clicks.map((c) => `${c.label}(${c.labelSource})`).join(" | "));
  check("icon button labelled by aria-label", clicks.some((c) => c.label === "Settings" && c.labelSource === "aria-label"));
  check("class hint label", clicks.some((c) => c.label === "card body" && c.labelSource === "class"));
  check("wrapping label excludes options", byName(/unit/i).at(-1)?.label === "Unit");
  const net = of("network");
  const ping = net.find((n) => n.source === "fetch" && n.url.includes("/api/ping"));
  check("fetch logged with redacted token", ping?.status === 200 && ping.url.includes("token=[REDACTED]") && !JSON.stringify(report).includes("secret123"), ping?.url);
  check("xhr logged", net.some((n) => n.source === "xhr" && n.method === "POST" && n.status === 200));
  check("failing call logged", net.some((n) => n.url.includes("/api/fail") && n.status === 500));
  check("network after reload", net.some((n) => n.url.includes("/api/ping") && n.t > of("page_load").find((p) => p.navigationType === "reload").t));
  const rc = of("route_change")[0];
  check("route_change", rc?.from === "/" && rc?.to === "/details?id=7" && rc?.via === "pushState", JSON.stringify(rc));
  const ce = of("console_error").find((e) => e.message.includes("boom"));
  check("console_error", ce?.message.includes("boom") && ce?.message.includes("kaboom") && !!ce?.stack, ce?.message);

  const id = basename(dir);
  const files = readdirSync(dir, { recursive: true }).map(String).sort();
  check("folder has <id>.webm, details/report.json, details/AI-README.md, details/context.md, screenshot", ["details/AI-README.md", "details/context.md", "details/report.json", `${id}.webm`, "screenshot-01.png"].every((f) => files.includes(f)) && !files.some((f) => f.endsWith(".recording.webm")), files.join(", "));
  const top = readdirSync(dir).sort();
  check("top level holds exactly the video and the Screenshot images (plus details/)", JSON.stringify(top) === JSON.stringify([`${id}.webm`, "details", "screenshot-01.png", "screenshot-02.png"].sort()), top.join(", "));
  check("no working files left over (storage summaries are dot-files in OPFS only)", !files.some((f) => basename(f).startsWith(".")), files.filter((f) => basename(f).startsWith(".")).join(", "));
  check("report names the video after the session", report.video.file === `${id}.webm`, report.video.file);
  check("schema version 5", report.schemaVersion === 5);
  check("nothing went through Chrome's downloads", !existsSync(join(downloads, "record2context")) && readdirSync(downloads).length === 0, readdirSync(downloads).join(", "));
  const entry = env.last;
  check("saved in the extension and written to the recordings folder by the helper", dir === join(env.folderPath, id) && entry.folderCopy?.dir === dir && !entry.folderCopy.error && entry.paths.includes("details/report.json"), JSON.stringify(entry.folderCopy));
  const opfsFiles = (await exportSession(env, id).then((d) => readdirSync(d, { recursive: true }).map(String).sort()));
  check("the extension's own copy has the same files", JSON.stringify(opfsFiles) === JSON.stringify(files), opfsFiles.join(", "));

  const marks = of("mark");
  const pauses = of("pause");
  check("two marks, Thai note kept exactly, second empty", marks.length === 2 && marks[0].note === THAI_NOTE && marks[1].note === "" && marks[0].n === 1 && marks[1].n === 2, JSON.stringify(marks.map((m) => ({ n: m.n, t: m.t, len: m.note.length }))));
  check("each mark has a pause at the same t", pauses.length === 2 && pauses.every((p, i) => p.t === marks[i].t && p.pausedMs > 1000), JSON.stringify(pauses));
  check(
    "report.marks / report.pauses index them",
    JSON.stringify(report.marks) === JSON.stringify(marks.map((m) => ({ n: m.n, t: m.t, note: m.note, ...(m.screenshot ? { screenshot: m.screenshot } : {}) }))) && report.pausedMs === pauses[0].pausedMs + pauses[1].pausedMs,
  );
  check("each mark captured its frame as a screenshot", marks.every((m, i) => m.screenshot === `screenshot-0${i + 1}.png` && files.includes(m.screenshot)), marks.map((m) => m.screenshot).join(", "));
  const during = net.find((n) => n.url.includes("during=pause"));
  check("network during the pause kept at the pause point", during?.duringPause === true && during.t === marks[0].t, JSON.stringify(during && { t: during.t, duringPause: during.duringPause }));
  const ceDuring = of("console_error").find((e) => e.message.includes("error while paused"));
  check("console error during the pause kept at the pause point", ceDuring?.duringPause === true && ceDuring.t === marks[0].t);
  const noteBits = [THAI_NOTE.slice(0, 20), THAI_NOTE.split("\n")[1].slice(0, 20)];
  const nonMark = JSON.stringify(ev.filter((e) => e.type !== "mark"));
  check("HUD note typing never logged as page input or keys", noteBits.every((b) => !nonMark.includes(b)) && !inputs.some((e) => /note-text/.test(e.selector) || e.label === "Note") && !of("key").some((k) => k.t >= marks[0].t && k.t <= marks[0].t + 50), "");
  check("every t within the video", ev.every((e) => e.t <= report.durationMs + 100), `max t ${Math.max(...ev.map((e) => e.t))}, duration ${report.durationMs}`);

  const probe = ffprobe(videoOf(dir, report));
  check("ffprobe duration", Math.abs(probe.duration * 1000 - report.durationMs) < 150, `${probe.duration}s vs ${report.durationMs}ms`);
  const wall = stopClickedAt - Date.parse(report.startedAt);
  const excluded = wall - report.pausedMs;
  check(
    "video duration leaves out the paused time",
    probe.duration * 1000 > excluded - 300 && probe.duration * 1000 < excluded + 1500,
    `video ${Math.round(probe.duration * 1000)} ms; wall to Stop ${wall} ms; paused ${report.pausedMs} ms; wall − paused ${excluded} ms`,
  );
  check("video size matches report", probe.width === report.video.width && probe.height === report.video.height, `${probe.width}x${probe.height}`);

  const settingsClicks = clicks.filter((c) => c.label === "Settings");
  check("events before and after the worker restart are kept", settingsClicks.length === 2 && clicks[0].label === "Title", `${settingsClicks.length} Settings clicks`);
  const logErr = clicks.find((c) => c.label === "Log error");
  const frame = checkClickFrame(dir, report, logErr, "local-log-error", logErrGap);
  check("ripple at bbox-mapped point in frame at click t, not before", frame.ok, JSON.stringify(frame));
  const xhrAfter = clicks.find((c) => c.label === "XHR call" && c.t > marks[0].t);
  const frameAfter = checkClickFrame(dir, report, xhrAfter, "local-xhr-after-pause", xhrAfterGap);
  check("after a pause: ripple at the click's t, not before", frameAfter.ok, JSON.stringify(frameAfter));
  // The AI-README command, exactly: ffmpeg -ss <t/1000> -i <video> -frames:v 1 frame.png
  const cut = join(OUT, "frame-at-click-after-pause.png");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", String(xhrAfter.t / 1000), "-i", videoOf(dir, report), "-frames:v", "1", cut]);
  const p = toVideoPx(report, xhrAfter.viewport, xhrAfter.point.x, xhrAfter.point.y);
  const half = Math.round(40 * p.s);
  const atT = ripplePixels(frameCrop(videoOf(dir, report), xhrAfter.t, { x: p.x - half, y: p.y - half, w: 2 * half, h: 2 * half }));
  check("frame cut at that click's t (AI-README command) shows the click", existsSync(cut) && atT > 20, `${atT} ripple px at t=${xhrAfter.t}; ${cut}`);

  // Alignment: pts of the first frame showing each flash, before and after the first pause.
  const frames = framesWithCentre(videoOf(dir, report));
  const flashT = ev.find((e) => e.type === "console_error" && e.message === "r2c-flash before-pause")?.t;
  const flashAfterT = ev.find((e) => e.type === "console_error" && e.message === "r2c-flash after-pause")?.t;
  const fb = flashT === undefined ? { offset: null } : flashAtT(frames, flashT);
  const fa = flashAfterT === undefined ? { offset: null } : flashAtT(frames, flashAfterT);
  const [before, after] = [fb.offset, fa.offset];
  // The frame drawn with the flash is recorded, or the next one is (the video keeps every other 60 Hz frame): 0..1 frame after t.
  const inFrame = (f) => f.offset !== null && f.offset >= -5 && f.offset <= FRAME_MS;
  check(
    "t still matches the video after a pause (first flash frame within one frame after t, before and after the pause)",
    inFrame(fb) && inFrame(fa) && Math.abs(after - before) <= FRAME_MS,
    `first flash frame at t${before >= 0 ? "+" : ""}${before} ms before the pause, t${after >= 0 ? "+" : ""}${after} ms after it`,
  );
  writeFileSync(join(OUT, "local-alignment.json"), JSON.stringify({ before, after, flashT, flashAfterT }, null, 2));

  // Session files for an AI.
  const readme = readFileSync(join(dir, "details", "AI-README.md"), "utf8");
  check("AI-README.md names this video and the frame command", readme.includes(`\`${id}.webm\``) && readme.includes(`ffmpeg -ss <t/1000> -i ${id}.webm -frames:v 1 frame.png`));
  const contextMd = readFileSync(join(dir, "details", "context.md"), "utf8");
  const ctxJson = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(contextMd)[1]);
  check(
    "context.md is the collapsed portable context",
    contextMd.startsWith("<details><summary>Context for AI (record2context)</summary>") && ctxJson.session === id && ctxJson.video.file === `${id}.webm` && ctxJson.marks.length === 2 && ctxJson.marks[0].note === THAI_NOTE,
  );
  check("context.md replay has goto, click, fill, key, navigate, reload", ["goto", "click", "fill", "key", "navigate", "reload"].every((d) => ctxJson.replay.some((r) => r.do === d)), [...new Set(ctxJson.replay.map((r) => r.do))].join(","));
  check("context.md has no secrets", !/hunter2|tok-123|secret123/.test(contextMd));
  check("context.md has no email address", !EMAIL_ANY.test(contextMd), EMAIL_ANY.exec(contextMd)?.[0]);
  writeFileSync(join(OUT, "local-context.md"), contextMd);

  // Popup: copy buttons (clipboard stubbed) and Show folder (the helper's reveal, logged instead of opening Finder).
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.locator("#recent-list li").first().waitFor({ timeout: 5000 });
  await popup.evaluate(() => {
    window.__copied = [];
    navigator.clipboard.writeText = async (t) => void window.__copied.push(t);
  });
  const item = popup.locator("#recent-list li").first();
  await item.getByRole("button", { name: "Copy for my AI" }).click();
  await item.getByRole("button", { name: "Copy portable context" }).click();
  await item.getByRole("button", { name: "Show folder" }).click();
  for (let i = 0; i < 40 && !existsSync(env.revealLog); i++) await popup.waitForTimeout(100);
  await popup.waitForTimeout(200);
  const { copied, statusText, folderText } = await popup.evaluate(() => ({ copied: window.__copied, statusText: document.querySelector("#status").textContent, folderText: document.querySelector("#folder").textContent }));
  const secs = Math.round(report.durationMs / 1000);
  const d = new Date(report.startedAt);
  const local = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const expectedPointer = `Browser recording of what I did on 127.0.0.1:${port} (${Math.floor(secs / 60)}:${pad2(secs % 60)}, recorded ${local}): ${dir} — read details/AI-README.md there for the format.`;
  check("Copy for my AI copies the neutral pointer to the folder copy", copied[0] === expectedPointer, copied[0]);
  check("Copy portable context copies context.md", copied[1] === contextMd, `${copied[1]?.length} vs ${contextMd.length} chars`);
  const revealed = existsSync(env.revealLog) ? readFileSync(env.revealLog, "utf8") : "";
  check("Show folder asks the helper to open the session folder", revealed === `${dir}\n`, JSON.stringify(revealed));
  check("popup says where it was saved", statusText === `Saved to ${dir}/`, statusText);
  check("popup names the folder recordings go to", folderText.startsWith(`Saving to ${env.folderPath}`), folderText);
  await popup.screenshot({ path: join(OUT, "local-popup.png") });
  writeFileSync(join(OUT, "local-pointer.txt"), `${copied[0]}\n`);
  await popup.close();

  videoServer = await startServer(dir);
  const play = await checkVideoInBrowser(ctx, `http://127.0.0.1:${videoServer.port}`, report.video.file);
  check(
    "Chromium <video> duration + seek",
    Number.isFinite(play.duration) && Math.abs(play.duration * 1000 - report.durationMs) < 150 && play.seekableEnd > 0 && Math.abs(play.seekedTo - play.target) < 0.05,
    JSON.stringify(play),
  );
} catch (e) {
  check("run completed", false, e.stack);
} finally {
  await ctx.close();
  server.close();
  videoServer?.server.close();
}

const failed = results.filter((r) => !r.ok);
log(`${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
