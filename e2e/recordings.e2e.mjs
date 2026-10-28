// The Recordings page (recordings.html): list with where each recording really is, player that plays from the
// extension's storage (else from the recordings folder through the helper), long URLs with an expand toggle, annotations,
// Delete (one, selected), copies deleted by hand, Remove missing from list, helper removed mid-recording, then Save to folder.
// Run: npm run build && node e2e/recordings.e2e.mjs
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { uninstall } from "../host/install.mjs";
import { startServer } from "./server.mjs";
import { OUT, ROOT, installHost, launch, log, markViaHud, markWithShapes, recentList, startRecording, stopViaHud } from "./lib.mjs";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
};

async function record(ctx, extId, sw, page, body) {
  const before = (await recentList(sw)).length;
  await startRecording(ctx, extId, sw, page);
  await body();
  await stopViaHud(page);
  for (let i = 0; i < 120; i++) {
    const list = await recentList(sw);
    if (list.length > before) return list[0];
    await page.waitForTimeout(500);
  }
  throw new Error("session not saved");
}

/** Removes `id` from the extension's storage and/or the recordings folder on disk, as a person deleting files would. */
async function removeCopy(env, id, where) {
  if (where.includes("folder")) rmSync(join(env.folderPath, id), { recursive: true, force: true });
  if (!where.includes("sessions")) return;
  const p = await env.ctx.newPage();
  await p.goto(`chrome-extension://${env.extId}/recordings.html`);
  await p.evaluate(async (id) => (await (await navigator.storage.getDirectory()).getDirectoryHandle("sessions")).removeEntry(id, { recursive: true }).catch(() => undefined), id);
  await p.close();
}

const LONG = `/api/ping?${Array.from({ length: 12 }, (_, i) => `filter_${i}=${"value".repeat(4)}`).join("&")}`;

const { server, port } = await startServer(join(ROOT, "e2e", "fixtures"));
const env = await launch("recordings");
const { ctx, sw, extId } = env;
const pageUrl = `chrome-extension://${extId}/recordings.html`;
try {
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(`http://127.0.0.1:${port}/?token=secret123`);
  const a = await record(ctx, extId, sw, page, async () => {
    await page.waitForTimeout(800);
    await page.getByRole("button", { name: "Load data" }).click();
    await page.getByRole("button", { name: "Failing call" }).click();
    await page.evaluate((u) => fetch(u), LONG);
    await page.waitForTimeout(600);
    const ed = await markWithShapes(page, { note: "Total is wrong\nshould be 42", shapes: [{ tool: "box", color: "magenta", from: [0.02, 0.2], to: [0.2, 0.3], note: "here" }] });
    await ed.locator("button.continue").click();
    await page.locator("record2context-ui button.mark:not([disabled])").waitFor({ timeout: 10000 });
    await page.waitForTimeout(800);
    await page.getByRole("button", { name: "Log error" }).click();
    const m2 = await markViaHud(page, "");
    await m2.resume();
    await page.waitForTimeout(1500);
  });
  await page.waitForTimeout(1100);
  const b = await record(ctx, extId, sw, page, () => page.waitForTimeout(1200));
  check("start page is stored redacted", a.startUrl === `http://127.0.0.1:${port}/?token=[REDACTED]`, a.startUrl);
  const priv = "details/private-do-not-share/";
  check(
    "every file of the session is listed",
    a.paths.filter((p) => !p.startsWith(priv)).join(",") ===
      ["details/AI-README.md", "details/context.md", "details/report.json", "details/screenshots/screenshot-01-original.png", "screenshot-01.png", "screenshot-02.png", `${a.id}.webm`].sort().join(","),
    a.paths.join(","),
  );
  const privFiles = a.paths.filter((p) => p.startsWith(priv)).map((p) => p.slice(priv.length));
  check(
    "private folder: its README, a storage snapshot at Start, each Mark and Stop, one body file per fetch",
    ["README.txt", "storage/01-start.json", "storage/02-mark-1.json", "storage/03-mark-2.json", "storage/04-stop.json"].every((f) => privFiles.includes(f)) && privFiles.filter((f) => /^bodies\/b[a-z0-9]+-\d+\.json$/.test(f)).length === 3,
    privFiles.join(", "),
  );

  // ── List ──
  const rp = await ctx.newPage();
  await rp.goto(pageUrl);
  await rp.locator(`tr[data-id="${a.id}"]`).waitFor({ timeout: 5000 });
  const ids = await rp.locator("tbody tr").evaluateAll((trs) => trs.map((tr) => tr.dataset.id));
  check("list renders every recording, newest first", ids.join(",") === [b.id, a.id].join(","), ids.join(","));
  const stateOf = (id) => rp.locator(`tr[data-id="${id}"] [data-state]`).getAttribute("data-state");
  check("in the extension and the folder", (await stateOf(a.id)) === "both" && (await rp.locator(`tr[data-id="${a.id}"] [data-state]`).textContent()) === "In extension + folder");
  check("the helper is set up: the page names the folder, no setup line", (await rp.locator('[data-testid="folder-line"]').textContent()) === `Saving to ${env.folderPath}` && (await rp.locator('[data-testid="setup-line"]').count()) === 0);
  await rp.screenshot({ path: join(OUT, "recordings-list.png"), fullPage: true });

  // ── Player, from the extension's storage ──
  await rp.locator(`tr[data-id="${a.id}"]`).getByRole("button", { name: "Open" }).click();
  const video = rp.locator("video");
  await video.waitFor({ timeout: 5000 });
  const meta = await video.evaluate((v) => new Promise((r) => (v.readyState >= 1 ? r(v.duration) : (v.onloadedmetadata = () => r(v.duration)), (v.onerror = () => r(`error ${v.error?.code}`)))));
  check("video plays from the extension's storage (blob: URL), with a duration", typeof meta === "number" && meta > 3 && (await video.getAttribute("src")).startsWith("blob:"), `${meta} ${await video.getAttribute("src")}`);
  const report = JSON.parse(await rp.evaluate(async (id) => {
    const root = await navigator.storage.getDirectory();
    const d = await (await (await root.getDirectoryHandle("sessions")).getDirectoryHandle(id)).getDirectoryHandle("details");
    return (await (await d.getFileHandle("report.json")).getFile()).text();
  }, a.id));
  const marks = report.marks;
  check("both marks listed with their notes", (await rp.locator('[data-testid="mark-note"]').allTextContents()).join("|").includes("Total is wrong\nshould be 42") && (await rp.locator('[data-testid="mark-note"]').count()) === 2);
  const thumbs = await rp.locator('[data-testid="mark-thumb"]').evaluateAll((imgs) => Promise.all(imgs.map((i) => (i.complete ? i.naturalWidth : new Promise((r) => ((i.onload = () => r(i.naturalWidth)), (i.onerror = () => r(0))))))));
  check("each mark shows its screenshot", thumbs.length === 2 && thumbs.every((w) => w > 0), JSON.stringify(thumbs));
  const markerCount = await rp.locator('[data-testid="timeline-marker"]').count();
  check("timeline has colour-coded markers", markerCount >= 6 && (await rp.locator(".marker.k-mark").count()) === 2 && (await rp.locator(".marker.k-net-error").count()) >= 1, `${markerCount} markers`);
  await rp.locator(".marker.k-mark").nth(1).click();
  await rp.waitForTimeout(300);
  const t2 = await video.evaluate((v) => Math.round(v.currentTime * 1000));
  check("clicking a marker seeks the video", Math.abs(t2 - marks[1].t) <= 1, `${t2} vs ${marks[1].t}`);
  const currentEvent = await rp.locator(".list-events .row.current .main").first().textContent();
  check("the Events tab follows: current row is the mark", currentEvent.startsWith("Screenshot 2"), currentEvent);
  await rp.getByRole("tab", { name: /Network/ }).click();
  const failRow = rp.locator(".list-network .row.err").first();
  await failRow.click();
  await rp.waitForTimeout(300);
  const fail = report.events.find((e) => e.type === "network" && e.status >= 500);
  const t3 = await video.evaluate((v) => Math.round(v.currentTime * 1000));
  check("clicking a network row seeks to it", Math.abs(t3 - fail.t) <= 1 && (await failRow.getAttribute("class")).includes("current"), `${t3} vs ${fail.t}`);
  const longRow = rp.locator(".list-network .row", { hasText: "filter_0" }).first();
  const shortText = await longRow.locator(".long-value").textContent();
  await longRow.locator(".long-toggle").click();
  const fullText = await longRow.locator(".long-value").textContent();
  const t4 = await video.evaluate((v) => Math.round(v.currentTime * 1000));
  check("a long URL is shortened and expands with its toggle (without seeking)", shortText.length <= 90 && shortText.endsWith("…") && fullText.includes("filter_11=") && fullText.length > 200 && t4 === t3, `${shortText.length} → ${fullText.length} chars`);
  await rp.getByRole("tab", { name: /Console/ }).click();
  check("Console tab lists the error", (await rp.locator(".list-console .row").count()) >= 1);
  await rp.getByRole("tab", { name: /Screenshots/ }).click();
  const imgs = rp.locator(".list-screenshots img");
  await imgs.first().waitFor({ timeout: 5000 });
  const widths = await imgs.evaluateAll((list) => Promise.all(list.map((i) => (i.complete ? i.naturalWidth : new Promise((r) => (i.onload = () => r(i.naturalWidth)))))));
  check("screenshots load (two, one per Screenshot)", widths.length === 2 && widths.every((w) => w > 0), JSON.stringify(widths));
  const ann = await rp.locator('[data-testid="annotations"] li').allTextContents();
  check("annotations listed under their screenshot", ann.length === 1 && /^1 magenta box: here on /.test(ann[0]), ann.join(" | "));
  await rp.screenshot({ path: join(OUT, "recordings-screenshots.png"), fullPage: true });
  await rp.getByRole("tab", { name: /Events/ }).click();
  await rp.screenshot({ path: join(OUT, "recordings-player.png"), fullPage: true });

  // ── Plays from the folder (read back through the helper) when the extension's copy is gone ──
  await removeCopy(env, a.id, ["sessions"]);
  await rp.goto(pageUrl);
  await rp.locator(`tr[data-id="${a.id}"] [data-state="folder"]`).waitFor({ timeout: 8000 });
  check("only in the folder now: says so", (await rp.locator(`tr[data-id="${a.id}"] [data-state]`).textContent()) === "In folder");
  await rp.goto(`${pageUrl}#/r/${encodeURIComponent(a.id)}`);
  await video.waitFor({ timeout: 5000 });
  const fromFolder = await video.evaluate(async (v) => {
    await new Promise((r) => (v.readyState >= 1 ? r() : (v.onloadedmetadata = r)));
    v.currentTime = v.duration * 0.6;
    await new Promise((r) => (v.onseeked = r));
    return { d: v.duration, at: v.currentTime, src: v.src.slice(0, 5) };
  });
  check("the player falls back to the folder copy and seeks", fromFolder.d > 3 && Math.abs(fromFolder.at - fromFolder.d * 0.6) < 0.05 && fromFolder.src === "blob:", JSON.stringify(fromFolder));

  // ── Delete one, from the player ──
  await rp.locator(".head").getByRole("button", { name: "Delete", exact: true }).click();
  check("Delete asks first", (await rp.locator(".head .confirm").textContent()) === "Delete this recording (extension storage and folder copy)?");
  await rp.getByRole("button", { name: "Delete files" }).click();
  await rp.locator('[data-testid="message"]').waitFor({ timeout: 10000 });
  const msg = await rp.locator('[data-testid="message"]').textContent();
  check("back on the list with a summary", msg === "Recording deleted.", msg);
  check("entry gone from list and storage, and the folder from disk", (await rp.locator(`tr[data-id="${a.id}"]`).count()) === 0 && !(await recentList(sw)).some((r) => r.id === a.id) && !existsSync(join(env.folderPath, a.id)));

  // ── Copies deleted by hand, then Remove missing from list ──
  await removeCopy(env, b.id, ["sessions", "folder"]);
  const gone = await rp.locator(`tr[data-id="${b.id}"] [data-state="missing"]`).waitFor({ timeout: 12000 }).then(() => true, () => false);
  check("a recording deleted by hand shows Files missing", gone);
  await rp.getByRole("button", { name: /Remove missing from list \(1\)/ }).click();
  await rp.locator(`tr[data-id="${b.id}"]`).waitFor({ state: "detached", timeout: 5000 });
  check("Remove missing from list drops it", !(await recentList(sw)).some((r) => r.id === b.id));

  // ── Helper removed during a recording: kept in the extension only, the page says so; installed again, Save to folder ──
  const hostArgs = { browsers: [], manifestDirs: [join(env.profile, "NativeMessagingHosts")], installDir: env.hostDir };
  const c = await record(ctx, extId, sw, page, async () => {
    uninstall(hostArgs);
    // A host process already running keeps answering until its port closes (idle 5 s), so wait that out.
    await page.waitForTimeout(6500);
  });
  await rp.locator('[data-testid="setup-line"][data-state="missing"]').waitFor({ timeout: 12000 });
  await rp.locator(`tr[data-id="${c.id}"] [data-state="extension"]`).waitFor({ timeout: 8000 });
  check("no helper: the page shows the one setup line, the recording is in the extension only, no Save to folder yet", (await rp.locator('[data-testid="setup-line"] span').textContent()) === "Not set up yet — give this to your AI" && (await rp.locator(`tr[data-id="${c.id}"] [data-state]`).textContent()) === "In extension only" && (await rp.locator(`tr[data-id="${c.id}"] button.save-folder`).count()) === 0);
  await rp.screenshot({ path: join(OUT, "recordings-not-set-up.png"), fullPage: true });
  await installHost(env);
  await rp.locator(`tr[data-id="${c.id}"] button.save-folder`).waitFor({ timeout: 12000 });
  await rp.locator(`tr[data-id="${c.id}"]`).getByRole("button", { name: "Save to folder" }).click();
  await rp.locator(`tr[data-id="${c.id}"] [data-state="both"]`).waitFor({ timeout: 8000 });
  const cAfter = (await recentList(sw)).find((r) => r.id === c.id);
  check("Save to folder writes it through the helper and records where", cAfter.folderCopy?.dir === join(env.folderPath, c.id) && !cAfter.folderCopy.error && existsSync(join(env.folderPath, c.id, `${c.id}.webm`)), JSON.stringify(cAfter.folderCopy));

  // ── Delete selected ──
  await page.waitForTimeout(1100);
  const d = await record(ctx, extId, sw, page, () => page.waitForTimeout(1000));
  await rp.locator(`tr[data-id="${d.id}"]`).waitFor({ timeout: 5000 });
  await rp.locator(`tr[data-id="${c.id}"] input[type=checkbox]`).check();
  await rp.locator(`tr[data-id="${d.id}"] input[type=checkbox]`).check();
  await rp.getByRole("button", { name: "Delete selected (2)" }).click();
  check("Delete selected asks first", (await rp.locator(".bulk .confirm").textContent()) === "Delete 2 recordings (extension storage and folder copies)?");
  await rp.getByRole("button", { name: "Delete files" }).click();
  await rp.locator('[data-testid="message"]', { hasText: "2 recordings deleted." }).waitFor({ timeout: 10000 });
  check("both selected recordings deleted", (await recentList(sw)).length === 0);

} catch (err) {
  check("no exception", false, err.stack);
} finally {
  await ctx.close();
  server.close();
}
const failed = results.filter((r) => !r.ok);
log(`${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length ? 1 : 0;
