// Popup: without the recording helper (one "Not set up yet" line with the prompt for the person's AI; Start and the
// shortcut blocked), then with it (Saving to <folder>); helper removed during a recording (kept in the extension, copied
// by itself once the helper is back); the latest readable recording (one deleted by hand drops out), Delete (both
// copies), and "All recordings".
// Run: npm run build && node e2e/popup.e2e.mjs
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { startServer } from "./server.mjs";
import { uninstall } from "../host/install.mjs";
import { ROOT, installHost, launch, log, recentList, startRecording, status, stopViaHud } from "./lib.mjs";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
};

async function recordShort(ctx, extId, sw, page, during = () => page.waitForTimeout(1200)) {
  const before = (await recentList(sw)).length;
  await startRecording(ctx, extId, sw, page);
  await during();
  await stopViaHud(page);
  for (let i = 0; i < 120; i++) {
    const list = await recentList(sw);
    if (list.length > before) return list[0];
    await page.waitForTimeout(500);
  }
  throw new Error("session not saved");
}

/** Which copies of `id` exist: in the extension's storage and in the recordings folder on disk. */
async function copies(env, id) {
  const p = await env.ctx.newPage();
  await p.goto(`chrome-extension://${env.extId}/recordings.html`);
  const opfs = await p.evaluate(async (id) => {
    try {
      const root = await navigator.storage.getDirectory();
      await (await (await (await root.getDirectoryHandle("sessions")).getDirectoryHandle(id)).getDirectoryHandle("details")).getFileHandle("report.json");
      return true;
    } catch {
      return false;
    }
  }, id);
  await p.close();
  return { opfs, folder: existsSync(join(env.folderPath, id, "details", "report.json")) };
}

async function removeCopies(env, id) {
  const p = await env.ctx.newPage();
  await p.goto(`chrome-extension://${env.extId}/recordings.html`);
  await p.evaluate(async (id) => (await (await navigator.storage.getDirectory()).getDirectoryHandle("sessions")).removeEntry(id, { recursive: true }), id);
  await p.close();
  rmSync(join(env.folderPath, id), { recursive: true, force: true });
}

const { server, port } = await startServer(join(ROOT, "e2e", "fixtures"));
const env = await launch("popup", { host: false });
const { ctx, sw, extId } = env;
try {
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(`http://127.0.0.1:${port}/`);
  const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, page.url());
  const openPopup = async () => {
    const p = await ctx.newPage();
    await p.goto(`chrome-extension://${extId}/popup.html?tabId=${tabId}`);
    await p.locator("#folder[data-state]").waitFor({ timeout: 10000 });
    return p;
  };

  // ── No helper ──
  let popup = await openPopup();
  const line = popup.locator('[data-testid="setup-line"]');
  check("no helper: one line says so", (await popup.locator("#folder").getAttribute("data-state")) === "missing" && (await line.locator("span").textContent()) === "Not set up yet — give this to your AI");
  const prompt = await line.getAttribute("data-prompt");
  check("its prompt names the install guide by absolute path", prompt === `Set up record2context's recording helper on this computer: follow ${ROOT}/INSTALL-FOR-AI.md from start to finish, including its verify loop.`, prompt);
  await popup.evaluate(() => {
    window.__copied = [];
    navigator.clipboard.writeText = async (t) => void window.__copied.push(t);
  });
  await line.getByRole("button", { name: "Copy" }).click();
  check("Copy puts that prompt on the clipboard", (await popup.evaluate(() => window.__copied))[0] === prompt);
  check("Start is blocked while the helper is missing", (await popup.locator("#action").isDisabled()) && (await popup.locator("#action").getAttribute("data-blocked")) === "true");
  await popup.screenshot({ path: join(ROOT, "e2e", ".out", "popup-not-set-up.png") });
  await popup.close();
  const pagesBefore = ctx.pages().length;
  const blocked = await sw.evaluate(async (id) => {
    await self.record2contextTest.command("toggle-recording", await chrome.tabs.get(id));
    const popups = await chrome.runtime.getContexts({ contextTypes: ["POPUP"] });
    return { popups: popups.length, tabs: (await chrome.tabs.query({})).map((t) => t.url) };
  }, tabId);
  check("Alt+Shift+R does not record either; it shows the setup line (popup, or the Recordings page)", (await status(sw)) === "idle" && (await recentList(sw)).length === 0 && (blocked.popups > 0 || blocked.tabs.some((u) => u.endsWith("/recordings.html"))), JSON.stringify(blocked));
  for (const p of ctx.pages().slice(pagesBefore)) await p.close();

  // ── With the helper ──
  await installHost(env);
  popup = await openPopup();
  const cmd = await sw.evaluate(async () => ({
    mac: (await chrome.runtime.getPlatformInfo()).os === "mac",
    keys: Object.fromEntries((await chrome.commands.getAll()).map((c) => [c.name, c.shortcut ?? ""])),
  }));
  const keyText = (name, mac, other) => (cmd.keys[name] ? (cmd.mac ? mac : other) : "");
  const wantKeys = [
    [keyText("toggle-recording", "⌥⇧R", "Alt+Shift+R"), "Start / Stop recording"],
    [keyText("screenshot", "⌥⇧S", "Alt+Shift+S"), "Screenshot"],
  ].map(([k, label]) => (k ? `${k}${label}` : `${label}: no key set (chrome://extensions/shortcuts)`));
  await popup.locator("#keys-list li").nth(1).waitFor({ timeout: 5000 });
  const keyLines = await popup.locator("#keys-list li").allTextContents();
  check("the popup always lists the shortcuts with Chrome's keys", cmd.keys.screenshot && (await popup.locator("#keys").isVisible()) && JSON.stringify(keyLines) === JSON.stringify(wantKeys), JSON.stringify({ keyLines, cmd }));
  check("helper set up: the popup names the folder and Start is allowed", (await popup.locator("#folder").getAttribute("data-state")) === "ready" && (await popup.locator("#folder").textContent()) === `Saving to ${env.folderPath}` && !(await popup.locator("#action").isDisabled()), await popup.locator("#folder").textContent());
  await popup.close();

  // ── Helper removed during a recording: kept in the extension, copied by itself once it is back ──
  const hostArgs = { browsers: [], manifestDirs: [join(env.profile, "NativeMessagingHosts")], installDir: env.hostDir };
  const waiting = await recordShort(ctx, extId, sw, page, async () => {
    uninstall(hostArgs);
    // A helper already running answers until its port has been idle 5 s.
    await page.waitForTimeout(6500);
  });
  check("helper removed mid-recording: kept in the extension, copy marked as not set up", waiting.folderCopy?.error === "the recording helper is not set up" && JSON.stringify(await copies(env, waiting.id)) === '{"opfs":true,"folder":false}', JSON.stringify(waiting.folderCopy));
  await installHost(env);
  popup = await openPopup();
  let synced;
  for (let i = 0; i < 40 && !synced; i++) {
    synced = (await recentList(sw)).find((r) => r.id === waiting.id && r.folderCopy?.dir && !r.folderCopy.error);
    if (!synced) await page.waitForTimeout(250);
  }
  check("opening the popup copied the waiting recording to the folder by itself", synced?.folderCopy.dir === join(env.folderPath, waiting.id) && JSON.stringify(await copies(env, waiting.id)) === '{"opfs":true,"folder":true}', JSON.stringify(synced?.folderCopy));
  await popup.close();
  await page.waitForTimeout(1100);
  const a = await recordShort(ctx, extId, sw, page);
  await page.waitForTimeout(1100);
  const b = await recordShort(ctx, extId, sw, page);
  check("both copies exist", JSON.stringify(await copies(env, b.id)) === '{"opfs":true,"folder":true}' && b.folderCopy?.dir === join(env.folderPath, b.id));
  popup = await openPopup();
  await popup.locator(`#recent-list li[data-id="${b.id}"]`).waitFor({ timeout: 5000 });
  check("popup shows only the latest recording", (await popup.locator("#recent-list li").count()) === 1 && (await popup.locator("#recent-list li").getAttribute("data-where")) === "both");
  await popup.close();

  await removeCopies(env, b.id);
  popup = await openPopup();
  const shown = await popup.locator(`#recent-list li[data-id="${a.id}"]`).waitFor({ timeout: 10000 }).then(() => true, () => false);
  check("a recording whose copies were deleted drops out; the popup shows the one before it", shown && (await popup.locator(`#recent-list li[data-id="${b.id}"]`).count()) === 0);
  check("status names that recording's folder", (await popup.locator("#status").textContent()) === `Saved to ${join(env.folderPath, a.id)}/`);
  check("the entry itself is kept in storage (only hidden)", (await recentList(sw)).some((r) => r.id === b.id));

  await popup.getByRole("button", { name: "Delete", exact: true }).click();
  check("Delete asks first", (await popup.locator("#recent .confirm").textContent()) === "Delete this recording (extension storage and folder copy)?");
  await popup.getByRole("button", { name: "Cancel" }).click();
  check("Cancel keeps both copies", JSON.stringify(await copies(env, a.id)) === '{"opfs":true,"folder":true}');
  await popup.getByRole("button", { name: "Delete", exact: true }).click();
  await popup.getByRole("button", { name: "Delete files" }).click();
  await popup.locator("#deleted").waitFor({ state: "visible", timeout: 10000 });
  check("Delete removes both copies, the folder on disk included", JSON.stringify(await copies(env, a.id)) === '{"opfs":false,"folder":false}' && !existsSync(join(env.folderPath, a.id)), await popup.locator("#deleted").textContent());
  check("and the entry", !(await recentList(sw)).some((r) => r.id === a.id));

  // A copy that failed for another reason than a missing helper shows its real error (review-1 O1).
  await sw.evaluate((id) => chrome.storage.local.get("recent").then(({ recent }) => chrome.storage.local.set({ recent: recent.map((r) => (r.id === id ? { ...r, folderCopy: { error: "ENOSPC: no space left on device" } } : r)) })), waiting.id);
  const p4 = await openPopup();
  await p4.locator(`#recent-list li[data-id="${waiting.id}"]`).waitFor({ timeout: 10000 });
  check("a copy that failed for another reason shows that reason", (await p4.locator("#warning").textContent()) === "Not copied to the recordings folder: ENOSPC: no space left on device. It is kept in the extension; open All recordings and use Save to folder." && !(await p4.locator("#warning").isHidden()));
  await p4.close();

  const [tab] = await Promise.all([ctx.waitForEvent("page"), popup.getByRole("link", { name: "All recordings" }).click()]);
  await tab.waitForLoadState();
  check("All recordings opens the Recordings page", tab.url() === `chrome-extension://${extId}/recordings.html`, tab.url());
} catch (e) {
  check("no exception", false, e.stack);
} finally {
  await ctx.close();
  server.close();
}
const failed = results.filter((r) => !r.ok);
log(`${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length ? 1 : 0;
