// Real environment, end to end: the installed Google Chrome (headless, temp profile, minimal environment like a Dock
// launch) and the real helper, installed with INSTALL-FOR-AI.md's own commands into temp locations. Covers verify →
// NOT_READY (human step) → Load unpacked → heartbeat → READY; recordings on disk in folders with spaces and Thai
// names; a config edit moving the next recording; helper removed (setup line, kept in the extension) and installed
// again (Save to folder); Show folder; Delete; Copy for my AI; the upgrade from a temp copy of the QA Recorder install;
// the launch log telling a never-started helper from a failing one. Temp folders in ~/Downloads and ~/Documents are removed
// in `finally`. Nothing global is installed: Chrome reads this profile's own NativeMessagingHosts folder.
// Run: npm run build && node e2e/host.e2e.mjs
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { EXTENSION_ID, OUT, ROOT, log, recentList, startRecording, stopViaHud } from "./lib.mjs";
import { guideBlock, launchRealChrome } from "./real/harness.mjs";
import { startServer } from "./server.mjs";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${String(detail).slice(0, 400)}` : ""}`);
};

const tag = randomBytes(3).toString("hex");
const TMP = mkdtempSync(join(os.tmpdir(), "record2context-host-e2e-"));
const PROFILE = join(TMP, "profile");
const INSTALL_DIR = join(TMP, "record2context");
const MANIFEST_DIR = join(PROFILE, "NativeMessagingHosts");
const REVEAL_LOG = join(TMP, "reveal.log");
const REC1 = join(os.homedir(), "Downloads", `record2context e2e ทดสอบ ${tag}`);
const REC2 = join(os.homedir(), "Documents", `record2context-e2e-ทดสอบ-${tag}`);
for (const p of [REC1, REC2]) if (existsSync(p)) throw new Error(`refusing to reuse ${p}`);
const CONFIG = join(INSTALL_DIR, "config.json");
const STATUS = join(INSTALL_DIR, "status.json");
const LAUNCH_LOG = join(INSTALL_DIR, "launch.log");
// A temp copy of this machine's QA Recorder install (the earlier name), pointed at temp folders; never the real one.
const LEGACY = join(TMP, "QA Recorder");
const REAL_LEGACY = join(os.homedir(), "Library", "Application Support", "QA Recorder");
const REAL_LEGACY_MANIFEST = join(os.homedir(), "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts", "com.qa_recorder.host.json");

function makeLegacyCopy() {
  mkdirSync(LEGACY, { recursive: true });
  mkdirSync(MANIFEST_DIR, { recursive: true });
  const fromReal = existsSync(REAL_LEGACY);
  if (fromReal) for (const f of readdirSync(REAL_LEGACY)) if (statSync(join(REAL_LEGACY, f)).isFile()) copyFileSync(join(REAL_LEGACY, f), join(LEGACY, f));
  else for (const f of ["qa-recorder-host", "qa-recorder-host.mjs", "status.json"]) writeFileSync(join(LEGACY, f), "old");
  writeFileSync(join(LEGACY, "config.json"), JSON.stringify({ recordingsDir: REC1 }));
  writeFileSync(join(LEGACY, "roots.json"), JSON.stringify({ roots: [join(TMP, "older recordings")] }));
  const m = existsSync(REAL_LEGACY_MANIFEST) ? JSON.parse(readFileSync(REAL_LEGACY_MANIFEST, "utf8")) : { name: "com.qa_recorder.host", type: "stdio" };
  writeFileSync(join(MANIFEST_DIR, "com.qa_recorder.host.json"), JSON.stringify({ ...m, path: join(LEGACY, "qa-recorder-host") }));
  return fromReal;
}

/** Runs a block of INSTALL-FOR-AI.md through /bin/sh from the repo, pointed at the temp locations. */
function runGuide(name, vars = {}, folder = "") {
  const env = { ...process.env, RECORD2CONTEXT_INSTALL_DIR: INSTALL_DIR, RECORD2CONTEXT_MANIFEST_DIR: MANIFEST_DIR, RECORD2CONTEXT_REVEAL_LOG: REVEAL_LOG, ...vars };
  // The AI writes the literal folder into the command, as the guide says; the test does the same.
  const block = guideBlock(name).replace(/<[^>]*folder[^>]*>/, folder.replace(/"/g, '\\"'));
  try {
    return { code: 0, out: execFileSync("/bin/sh", ["-c", block], { cwd: ROOT, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

/** `npm run verify-install` (the JSON verdict) against the temp manifest folder. */
function verdict(extra = []) {
  const r = (() => {
    try {
      return execFileSync("node", ["host/verify.mjs", ...extra], { cwd: ROOT, env: { ...process.env, RECORD2CONTEXT_MANIFEST_DIR: MANIFEST_DIR, RECORD2CONTEXT_REVEAL_LOG: REVEAL_LOG }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return e.stdout;
    }
  })();
  return JSON.parse(r);
}
const failed = (v) => v.checks.filter((c) => c.required && !c.ok).map((c) => `${c.id}:${c.owner}`);

async function recordShort(env, page, ms = 1500, during = async () => undefined) {
  const before = (await recentList(env.sw)).length;
  await startRecording(env.ctx, env.extId, env.sw, page);
  await page.getByRole("button", { name: "Load data" }).click();
  await page.waitForTimeout(ms);
  await during();
  await stopViaHud(page);
  for (let i = 0; i < 120; i++) {
    const list = await recentList(env.sw);
    if (list.length > before) return list[0];
    await page.waitForTimeout(500);
  }
  throw new Error("recording was not saved");
}

/** The person's click on the icon: opening the popup pings the helper with a heartbeat. */
async function page0Click(chrome, id) {
  const p = await chrome.ctx.newPage();
  await p.goto(`chrome-extension://${id}/popup.html`);
  await p.waitForTimeout(1500);
  await p.close();
}

let chrome;
const site = await startServer(join(ROOT, "e2e", "fixtures"));
try {
  const base = `http://127.0.0.1:${site.port}`;

  // ── The guide, steps 1-4, as written ──
  const prereq = runGuide("prereq");
  check("guide step 1: prerequisites run", prereq.code === 0 && /^v(\d+)/.test(prereq.out) && Number(/^v(\d+)/.exec(prereq.out)[1]) >= 20, prereq.out.trim().replace(/\n/g, " "));
  const build = runGuide("build");
  check("guide step 2: build", build.code === 0 && existsSync(join(ROOT, "dist", "build-info.json")), build.code);
  const fromReal = makeLegacyCopy();
  const chose = runGuide("choose", {}, "default");
  check("guide step 0: the person keeps the folder in use; the choice is recorded in its own command", chose.code === 0 && JSON.parse(readFileSync(CONFIG, "utf8")).folder?.chosen === "default", chose.out.trim().split("\n").at(-2));
  const inst = runGuide("install", { RECORD2CONTEXT_LEGACY_INSTALL_DIR: LEGACY });
  check("guide step 4: install-host succeeds and its self-check is OK", inst.code === 0 && /host self-check\s+OK/.test(inst.out), inst.out.split("\n").slice(-2).join(" "));
  check("install prints the node the helper uses and that removing it needs a re-install", /node\s+\/\S.*\(v\d+\.\d+\.\d+\); removing this Node version stops the helper/.test(inst.out), inst.out.split("\n").find((l) => /^\s+node\s/.test(l)));
  check(
    `upgrade from a temp copy of the QA Recorder install (${fromReal ? "copied from this machine" : "made up: none on this machine"}): folder and roots kept, old manifest and files gone`,
    JSON.parse(readFileSync(CONFIG, "utf8")).recordingsDir === REC1 &&
      JSON.parse(readFileSync(join(INSTALL_DIR, "roots.json"), "utf8")).roots.includes(join(TMP, "older recordings")) &&
      !existsSync(join(MANIFEST_DIR, "com.qa_recorder.host.json")) &&
      !existsSync(LEGACY),
    inst.out.split("\n").filter((l) => /replaced old|folder kept|^\s+\//.test(l)).join(" | "),
  );
  check("the real QA Recorder install was not touched", !fromReal || (existsSync(join(REAL_LEGACY, "config.json")) && existsSync(REAL_LEGACY_MANIFEST)));
  const manifest = JSON.parse(readFileSync(join(MANIFEST_DIR, "com.record2context.host.json"), "utf8"));
  check("host manifest allows exactly this extension and points at the launcher", JSON.stringify(manifest.allowed_origins) === `["chrome-extension://${EXTENSION_ID}/"]` && manifest.path === join(INSTALL_DIR, "record2context-host"));
  let v = verdict();
  check("verify before Chrome: NOT_READY, and the only failure is the human's Load unpacked", v.verdict === "NOT_READY" && failed(v).join(",") === "heartbeat:human" && v.humanSteps[0]?.includes("Load unpacked"), failed(v).join(","));
  const hb0 = v.checks.find((c) => c.id === "heartbeat");
  check("before the extension is loaded: no status.json, no launch log, state never-launched", !existsSync(STATUS) && !existsSync(LAUNCH_LOG) && hb0.evidence.state === "never-launched");
  check(
    "the human step names every part: remove an older extension, Load unpacked with the absolute dist path, macOS access (dist is in Documents), click the icon",
    /was loaded from \S+\/dist, its round-arrow reload button is enough/.test(hb0.fix) &&
      /loaded from another folder is removed/.test(hb0.fix) &&
      hb0.fix.includes(`Load unpacked and choose the folder ${join(ROOT, "dist")} `) &&
      /macOS asks/.test(hb0.fix) &&
      (!ROOT.startsWith(join(os.homedir(), "Documents") + "/") || hb0.fix.includes("is inside Documents")) &&
      /click the record2context icon/.test(hb0.fix),
    hb0.fix,
  );

  // ── HUMAN STEP stand-in: Chrome started like from the Dock, then Load unpacked ──
  chrome = await launchRealChrome(PROFILE);
  const { id, sw } = await chrome.loadUnpacked();
  check("Chrome gives dist/ the id fixed by the manifest key", id === EXTENSION_ID, id);
  const env = { ctx: chrome.ctx, sw, extId: id };
  const wait = runGuide("wait", { RECORD2CONTEXT_REVEAL_LOG: REVEAL_LOG });
  v = JSON.parse(wait.out.slice(wait.out.indexOf("{")));
  check("guide step 5: waiting for the heartbeat ends READY by itself", wait.code === 0 && v.verdict === "READY", failed(v).join(","));
  const hb = JSON.parse(readFileSync(STATUS, "utf8"));
  const launches = existsSync(LAUNCH_LOG) ? readFileSync(LAUNCH_LOG, "utf8").split("\n").filter((l) => / launch origin=/.test(l)) : [];
  check("launch log: Chrome's starts of the helper, each with the extension's origin", launches.length > 0 && launches.every((l) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ launch origin=chrome-extension:\/\/[a-p]{32}\/$/.test(l)), launches.join(" | "));
  check("heartbeat: written by the helper Chrome started, with this build and a passing self-test in the folder", hb.lastHeartbeat.origin === `chrome-extension://${id}/` && hb.lastHeartbeat.buildId === JSON.parse(readFileSync(join(ROOT, "dist", "build-info.json"), "utf8")).buildId && hb.selfTest.ok && hb.selfTest.dir === REC1, JSON.stringify(hb.lastHeartbeat));

  // ── A helper that fails only when Chrome starts it: the launch log makes it the installer's, with the error ──
  const hostCopy = join(INSTALL_DIR, "record2context-host.mjs");
  const goodHost = readFileSync(hostCopy, "utf8");
  writeFileSync(hostCopy, goodHost.replace("\n", `\nthrow new Error("e2e-broken-helper");\n`));
  rmSync(STATUS);
  const bp = await chrome.ctx.newPage();
  // A helper already running answers until its port has been idle for 5 s; only a new start runs the broken copy.
  await bp.waitForTimeout(6000);
  await bp.goto(`chrome-extension://${id}/popup.html`);
  for (let i = 0; i < 50 && !readFileSync(LAUNCH_LOG, "utf8").includes("e2e-broken-helper"); i++) await bp.waitForTimeout(200);
  await bp.close();
  v = verdict();
  const hbBroken = v.checks.find((c) => c.id === "heartbeat");
  check("helper failing under Chrome: heartbeat is launched-no-heartbeat, the installer's, with the helper's error text", hbBroken.evidence.state === "launched-no-heartbeat" && hbBroken.owner === "installer" && hbBroken.fix.includes("e2e-broken-helper"), hbBroken.fix);
  check("…and nothing is asked of the person while that is so", v.humanSteps.length === 0, JSON.stringify(v.humanSteps));
  writeFileSync(hostCopy, goodHost);
  // Opening the popup is the click that writes a fresh heartbeat with the repaired helper.
  await page0Click(chrome, id);
  const healed = runGuide("wait", { RECORD2CONTEXT_REVEAL_LOG: REVEAL_LOG });
  v = JSON.parse(healed.out.slice(healed.out.indexOf("{")));
  check("helper repaired: READY again after one click", v.verdict === "READY", failed(v).join(","));

  // ── Record → files on disk (space + Thai in the folder name) ──
  const page = chrome.ctx.pages()[0] ?? (await chrome.ctx.newPage());
  await page.goto(`${base}/`);
  const a = await recordShort(env, page);
  const aDir = join(REC1, a.id);
  const aFiles = existsSync(aDir) ? readdirSync(aDir, { recursive: true }).map(String).sort() : [];
  check("recording lands in the recordings folder on disk", a.folderCopy?.dir === aDir && ["details/AI-README.md", "details/context.md", "details/report.json", `${a.id}.webm`].every((f) => aFiles.includes(f)), aFiles.join(", "));
  const report = JSON.parse(readFileSync(join(aDir, "details", "report.json"), "utf8"));
  check("the video on disk is complete (size matches the report)", readFileSync(join(aDir, `${a.id}.webm`)).length === report.video.sizeBytes && report.video.sizeBytes > 10000, report.video.sizeBytes);
  check("no partial files left behind", !aFiles.some((f) => f.endsWith(".r2c-part")));
  check("status.json records the last save", JSON.parse(readFileSync(STATUS, "utf8")).lastSave?.dir === aDir);

  // ── Popup: Copy for my AI and Show folder ──
  const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, page.url());
  const popup = await chrome.ctx.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html?tabId=${tabId}`);
  await popup.locator(`#recent-list li[data-id="${a.id}"]`).waitFor({ timeout: 10000 });
  check("popup names the recordings folder", (await popup.locator("#folder").textContent()) === `Saving to ${REC1}`, await popup.locator("#folder").textContent());
  await popup.evaluate(() => {
    window.__copied = [];
    navigator.clipboard.writeText = async (t) => void window.__copied.push(t);
  });
  await popup.locator("#recent-list li").getByRole("button", { name: "Copy for my AI" }).click();
  const pointer = (await popup.evaluate(() => window.__copied))[0] ?? "";
  const pointed = / (\/.+) — read details\/AI-README\.md there/.exec(pointer)?.[1];
  check("Copy for my AI gives the real absolute path, which exists and holds AI-README.md", pointed === aDir && existsSync(join(pointed, "details", "AI-README.md")), pointer);
  await popup.locator("#recent-list li").getByRole("button", { name: "Show folder" }).click();
  for (let i = 0; i < 40 && !existsSync(REVEAL_LOG); i++) await popup.waitForTimeout(100);
  check("Show folder asks the helper to open that folder", existsSync(REVEAL_LOG) && readFileSync(REVEAL_LOG, "utf8") === `${aDir}\n`);
  await popup.close();

  // ── The AI edits config.json and creates the folder (as the guide says): the next recording goes there, no reinstall ──
  const cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
  writeFileSync(CONFIG, `${JSON.stringify({ ...cfg, recordingsDir: REC2, folder: { chosen: REC2 } }, null, 2)}\n`);
  mkdirSync(REC2);
  v = verdict();
  check("verify after the edit: Chrome has not written the new folder yet, so the human clicks the icon once", failed(v).join(",") === "heartbeat-fresh:human,chrome-wrote-folder:human", failed(v).join(","));
  // Starting a recording opens the popup: that is the click, and its heartbeat proves Chrome can write the new folder.
  await page.waitForTimeout(1100);
  const b = await recordShort(env, page);
  check("after editing config.json the next recording lands in the new folder", b.folderCopy?.dir === join(REC2, b.id) && existsSync(join(REC2, b.id, "details", "report.json")) && !existsSync(join(REC1, b.id)), JSON.stringify(b.folderCopy));
  v = verdict();
  check("…and verify is READY again", v.verdict === "READY", failed(v).join(","));

  // ── Older recordings stay in the old folder: shown, opened, revealed, copied and deleted there (review-1 F2) ──
  const rp0 = await chrome.ctx.newPage();
  await rp0.goto(`chrome-extension://${id}/recordings.html`);
  const rowA = rp0.locator(`tr[data-id="${a.id}"]`);
  await rowA.locator('[data-state="both"]').waitFor({ timeout: 12000 });
  check("after the folder change the old recording still reads In extension + folder, with no Save to folder", (await rowA.locator("button.save-folder").count()) === 0);
  await rp0.evaluate(async (rid) => (await (await navigator.storage.getDirectory()).getDirectoryHandle("sessions")).removeEntry(rid, { recursive: true }), a.id);
  await rp0.reload();
  await rowA.locator('[data-state="folder"]').waitFor({ timeout: 12000 });
  check("only on disk in the old folder: In folder (not Files missing)", (await rowA.locator("[data-state]").textContent()) === "In folder");
  await rp0.evaluate(() => {
    window.__copied = [];
    navigator.clipboard.writeText = async (t) => void window.__copied.push(t);
  });
  await rowA.getByRole("button", { name: "Copy for my AI" }).click();
  check("its Copy for my AI names the old folder", ((await rp0.evaluate(() => window.__copied))[0] ?? "").includes(`: ${aDir} — read details/AI-README.md`));
  await rowA.getByRole("button", { name: "Show folder" }).click();
  for (let i = 0; i < 40 && !readFileSync(REVEAL_LOG, "utf8").includes(`${aDir}\n${aDir}\n`); i++) await rp0.waitForTimeout(100);
  check("Show folder opens it in the old folder", readFileSync(REVEAL_LOG, "utf8") === `${aDir}\n${aDir}\n`);
  await rp0.goto(`chrome-extension://${id}/recordings.html#/r/${encodeURIComponent(a.id)}`);
  const vid = rp0.locator("video");
  await vid.waitFor({ timeout: 10000 });
  const dur = await vid.evaluate((v) => new Promise((r) => (v.readyState >= 1 ? r(v.duration) : ((v.onloadedmetadata = () => r(v.duration)), (v.onerror = () => r(-1))))));
  check("it plays from the old folder through the helper", dur > 0.5, dur);
  await rp0.locator(".head").getByRole("button", { name: "Delete", exact: true }).click();
  await rp0.getByRole("button", { name: "Delete files" }).click();
  await rp0.locator('[data-testid="message"]').waitFor({ timeout: 10000 });
  check("Delete removes it from the old folder", !existsSync(aDir) && existsSync(REC1) && (await rp0.locator('[data-testid="message"]').textContent()) === "Recording deleted.", await rp0.locator('[data-testid="message"]').textContent());
  await rp0.close();

  // ── Helper missing: one clear line, Start and the shortcut blocked ──
  const un = runGuide("uninstall");
  check("guide: uninstall-host removes the manifest", un.code === 0 && !existsSync(join(MANIFEST_DIR, "com.record2context.host.json")), un.out.trim().split("\n").join(" "));
  v = verdict();
  check("verify without the helper: NOT_READY, every failure the installer's, nothing asked of the person (review-1 F3)", v.verdict === "NOT_READY" && failed(v)[0] === "host-manifest:installer" && failed(v).every((f) => f.endsWith(":installer")) && v.humanSteps.length === 0, failed(v).join(","));
  // A helper already running answers until its port closes (5 s idle).
  await page.waitForTimeout(6000);
  const p3 = await chrome.ctx.newPage();
  await p3.goto(`chrome-extension://${id}/popup.html?tabId=${tabId}`);
  const line = p3.locator('[data-testid="setup-line"]');
  await line.waitFor({ timeout: 10000 });
  check("popup: one line \"Not set up yet — give this to your AI\" with the install prompt", (await line.locator("span").textContent()) === "Not set up yet — give this to your AI" && (await line.getAttribute("data-prompt")).includes(`${ROOT}/INSTALL-FOR-AI.md`));
  check("popup: Start recording is blocked (Decision 11)", await p3.locator("#action").isDisabled());
  await p3.screenshot({ path: join(OUT, "host-popup-not-set-up.png") });
  await p3.close();
  const nBefore = (await recentList(sw)).length;
  const viaShortcut = await sw.evaluate(async (t) => {
    await self.record2contextTest.command("toggle-recording", await chrome.tabs.get(t));
    return (await chrome.storage.session.get("session")).session?.status ?? "idle";
  }, tabId);
  await page.waitForTimeout(1000);
  check("Alt+Shift+R does not record without the helper", viaShortcut === "idle" && (await recentList(sw)).length === nBefore, viaShortcut);
  for (const p of chrome.ctx.pages()) if (p.url().startsWith(`chrome-extension://${id}/`)) await p.close();

  // ── Helper removed during a recording: kept in the extension ──
  // Two separate shells, as many agent tools run them: the folder written into the first command still applies in the second.
  runGuide("choose", {}, REC2);
  check("guide step 0 then step 4 in separate shells: the chosen folder (Thai name) is installed", runGuide("install").code === 0 && JSON.parse(readFileSync(CONFIG, "utf8")).recordingsDir === REC2);
  await page.waitForTimeout(1100);
  const c = await recordShort(env, page, 1000, async () => {
    runGuide("uninstall");
    await page.waitForTimeout(6500);
  });
  check("helper removed mid-recording: the recording is kept in the extension", c.folderCopy?.error === "the recording helper is not set up" && !existsSync(join(REC2, c.id)), JSON.stringify(c.folderCopy));

  // ── Installed again: Save to folder on the Recordings page, then Delete ──
  // Kept within the idle window, so no worker restart copies it before the click (the heartbeat would).
  const re = runGuide("install");
  check("guide step 4 again (repair) succeeds", re.code === 0, re.out.split("\n").slice(-1).join(""));
  const rp = await chrome.ctx.newPage();
  await rp.goto(`chrome-extension://${id}/recordings.html`);
  const row = rp.locator(`tr[data-id="${c.id}"]`);
  await row.locator("button.save-folder").waitFor({ timeout: 12000 });
  check("Recordings page: In extension only, with Save to folder", (await row.locator("[data-state]").textContent()) === "In extension only");
  await row.getByRole("button", { name: "Save to folder" }).click();
  await row.locator('[data-state="both"]').waitFor({ timeout: 15000 });
  check("Save to folder writes it through the helper", existsSync(join(REC2, c.id, `${c.id}.webm`)) && (await recentList(sw)).find((r) => r.id === c.id)?.folderCopy?.dir === join(REC2, c.id));
  await row.getByRole("button", { name: "Delete", exact: true }).click();
  await rp.getByRole("button", { name: "Delete files" }).click();
  await rp.locator('[data-testid="message"]').waitFor({ timeout: 10000 });
  check("Delete removes the folder on disk and the entry", !existsSync(join(REC2, c.id)) && !(await recentList(sw)).some((r) => r.id === c.id), await rp.locator('[data-testid="message"]').textContent());
  await rp.close();
} catch (e) {
  check("no exception", false, e.stack);
} finally {
  await chrome?.ctx.close().catch(() => undefined);
  site.server.close();
  for (const p of [REC1, REC2, TMP]) rmSync(p, { recursive: true, force: true });
  check("temp folders removed", ![REC1, REC2, TMP].some(existsSync));
}
const bad = results.filter((r) => !r.ok);
log(`${results.length - bad.length}/${results.length} passed`);
process.exitCode = bad.length ? 1 : 0;
