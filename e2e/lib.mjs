// Shared E2E helpers: launch Chromium with the built extension, drive recording, validate the output folder.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { repoExtensionId } from "../host/common.mjs";
import { install } from "../host/install.mjs";

export const ROOT = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
export const DIST = join(ROOT, "dist");
export const OUT = join(ROOT, "e2e", ".out");

// The devDependency; PLAYWRIGHT_PATH can point at another playwright/index.mjs.
export const { chromium } = await import(process.env.PLAYWRIGHT_PATH ?? "playwright");
export const CHANNEL = process.env.R2C_E2E_CHANNEL ?? "chromium";
/** Headless by default so runs never open windows; R2C_E2E_HEADED=1 shows the browser. */
export const HEADED = process.env.R2C_E2E_HEADED === "1";
const VIEWPORT = { width: 1280, height: 800 };

/** Fixed by the manifest's `key`, wherever dist/ is. */
export const EXTENSION_ID = repoExtensionId();

function freePort() {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

export function log(...a) {
  console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...a);
}

/**
 * Installs the recording helper for this suite's profile only: Chrome reads `<user-data-dir>/NativeMessagingHosts`,
 * so nothing global is touched. Show folder writes to `revealLog` instead of opening Finder.
 */
export async function installHost(env, { recordingsDir = env.folderPath } = {}) {
  return install({
    browsers: [],
    manifestDirs: [join(env.profile, "NativeMessagingHosts")],
    installDir: env.hostDir,
    recordingsDir,
    revealLog: env.revealLog,
  });
}

/**
 * Launch with the extension. `--allowlisted-extension-id` lets tabCapture run without a toolbar
 * click, which Playwright cannot perform; everything after getMediaStreamId is the real path.
 */
export async function launch(name, { extraExtensions = [], extensionsFirst = false, host = true } = {}) {
  if (!existsSync(join(DIST, "manifest.json"))) throw new Error("dist/ missing: run npm run build");
  const profile = join(OUT, `profile-${name}`);
  const downloads = join(OUT, `downloads-${name}`);
  rmSync(profile, { recursive: true, force: true });
  rmSync(downloads, { recursive: true, force: true });
  mkdirSync(join(profile, "Default"), { recursive: true });
  mkdirSync(downloads, { recursive: true });
  writeFileSync(
    join(profile, "Default", "Preferences"),
    JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false, directory_upgrade: true }, savefile: { default_directory: downloads } }),
  );
  const extId = EXTENSION_ID;
  // Measured: Chrome cannot start a host whose files are under ~/Documents (where this repo is), so it goes in the temp dir.
  const hostEnv = { profile, hostDir: join(tmpdir(), "record2context-e2e", `host-${name}`), folderPath: join(OUT, `folder-${name}`), revealLog: join(OUT, `reveal-${name}.log`) };
  for (const p of [hostEnv.hostDir, hostEnv.folderPath, hostEnv.revealLog]) rmSync(p, { recursive: true, force: true });
  // Before Chrome starts, so the extension's first heartbeat already finds it.
  if (host) await installHost(hostEnv);
  const port = await freePort();
  // `extensionsFirst` loads the extra extensions before ours, so Chrome sees ours as the most recently installed.
  const exts = extensionsFirst ? [...extraExtensions, DIST] : [DIST, ...extraExtensions];
  // R2C_E2E_CHANNEL=chrome runs the installed Google Chrome; it ignores --load-extension, so extensions load over CDP.
  const branded = CHANNEL !== "chromium";
  // The "chromium" channel keeps the full browser in new headless mode; the default headless shell cannot load extensions.
  // No emulated viewport: tabCapture records the real tab, so the window is sized to make the tab VIEWPORT instead.
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: CHANNEL,
    headless: !HEADED,
    viewport: null,
    ...(branded ? { ignoreDefaultArgs: ["--disable-extensions"] } : {}),
    args: [
      ...(branded ? ["--enable-unsafe-extension-debugging"] : [`--disable-extensions-except=${exts.join(",")}`, `--load-extension=${exts.join(",")}`]),
      ...(HEADED ? [] : ["--screen-info={0,0 1920x1200}"]),
      `--allowlisted-extension-id=${extId}`,
      `--remote-debugging-port=${port}`,
    ],
  });
  const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  let nextId = 0;
  const cdp = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const onMsg = (m) => {
        const d = JSON.parse(m.data);
        if (d.id !== id) return;
        ws.removeEventListener("message", onMsg);
        if (d.error) reject(new Error(`${method}: ${JSON.stringify(d.error)}`));
        else resolve(d.result);
      };
      ws.addEventListener("message", onMsg);
      ws.send(JSON.stringify({ id, method, params }));
    });
  if (branded) for (const path of exts) await cdp("Extensions.loadUnpacked", { path });
  const findSw = (id) => ctx.serviceWorkers().find((w) => w.url().includes(id));
  let sw = findSw(extId);
  for (let i = 0; i < 50 && !sw; i++) {
    await ctx.waitForEvent("serviceworker", { timeout: 10000 }).catch(() => undefined);
    sw = findSw(extId);
  }
  if (!sw) throw new Error(`service worker of ${extId} not found: ${ctx.serviceWorkers().map((w) => w.url()).join(", ")}`);
  await fitTabToViewport(sw);
  // Playwright renames downloads to GUIDs; hand download handling back to Chrome's own logic.
  await cdp("Browser.setDownloadBehavior", { behavior: "default" });
  ws.close();
  return { ctx, sw, extId, downloads, port, name, ...hostEnv, exported: new Set() };
}

/** Every file under `<OPFS>/<base>/<id>` as { path: base64 } (read in 4 MB slices). */
async function readOpfsTree(env, base, id) {
  const page = await env.ctx.newPage();
  await page.goto(`chrome-extension://${env.extId}/recordings.html`);
  try {
    const paths = await page.evaluate(
      async ({ base, id }) => {
        let dir = await navigator.storage.getDirectory();
        for (const p of [...base.split("/"), id]) dir = await dir.getDirectoryHandle(p);
        const out = [];
        const walk = async (d, prefix) => {
          for await (const e of d.values()) e.kind === "file" ? out.push(prefix + e.name) : await walk(e, `${prefix}${e.name}/`);
        };
        await walk(dir, "");
        return out.sort();
      },
      { base, id },
    );
    const files = {};
    for (const path of paths) {
      const parts = [];
      for (let off = 0; ; off += 4 << 20) {
        const chunk = await page.evaluate(
          async ({ base, id, path, off }) => {
            let dir = await navigator.storage.getDirectory();
            for (const p of [...base.split("/"), id, ...path.split("/").slice(0, -1)]) dir = await dir.getDirectoryHandle(p);
            const file = await (await dir.getFileHandle(path.split("/").pop())).getFile();
            const bytes = new Uint8Array(await file.slice(off, off + (4 << 20)).arrayBuffer());
            let bin = "";
            for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
            return { b64: btoa(bin), done: off + (4 << 20) >= file.size };
          },
          { base, id, path, off },
        );
        parts.push(Buffer.from(chunk.b64, "base64"));
        if (chunk.done) break;
      }
      files[path] = Buffer.concat(parts);
    }
    return files;
  } finally {
    await page.close();
  }
}

/** Copies a session out of the extension's storage to `<dest>/<id>/` so ffprobe and friends can read it. Returns that folder. */
export async function exportSession(env, id, { dest = join(OUT, `opfs-${env.name}`) } = {}) {
  const files = await readOpfsTree(env, "sessions", id);
  const dir = join(dest, id);
  rmSync(dir, { recursive: true, force: true });
  for (const [path, buf] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), buf);
  }
  return dir;
}

export async function recentList(sw) {
  return sw.evaluate(async () => (await chrome.storage.local.get("recent")).recent ?? []);
}

/** Resize the window so its tab area (inside the toolbar) is exactly VIEWPORT; new pages open as tabs in it. */
async function fitTabToViewport(sw) {
  const size = await sw.evaluate(async (vp) => {
    const [win] = await chrome.windows.getAll({ populate: true });
    const tab = win.tabs[0];
    await chrome.windows.update(win.id, { width: win.width + vp.width - tab.width, height: win.height + vp.height - tab.height });
    const after = await chrome.tabs.get(tab.id);
    return { width: after.width, height: after.height };
  }, VIEWPORT);
  if (size.width !== VIEWPORT.width || size.height !== VIEWPORT.height) throw new Error(`tab is ${size.width}x${size.height}, wanted ${VIEWPORT.width}x${VIEWPORT.height}`);
}

export async function tabIdOf(sw, page) {
  const url = page.url();
  return sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, url);
}

/** Click "Start recording" in the real popup page (opened as a tab, targeting the test tab). */
export async function startRecording(ctx, extId, sw, page) {
  const tabId = await tabIdOf(sw, page);
  if (!tabId) throw new Error("tab id not found");
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html?tabId=${tabId}`);
  await popup.getByRole("button", { name: "Start recording" }).click();
  await popup.waitForEvent("close", { timeout: 15000 }).catch(async () => {
    throw new Error(`popup did not close: ${await popup.locator("#status").textContent()}`);
  });
  await page.bringToFront();
  await page.locator("record2context-ui .hud").waitFor({ timeout: 10000 });
  return tabId;
}

export async function status(sw) {
  return sw.evaluate(async () => (await chrome.storage.session.get("session")).session?.status ?? "idle");
}

export async function stopViaHud(page) {
  await page.locator("record2context-ui button.stop").click();
}

/** Screenshot (a Mark) from the HUD (or with Alt+Shift+S), type `note` into the note box, and continue with Enter or the button. */
export async function markViaHud(page, note, { shortcut = false, continueWith = "enter" } = {}) {
  if (shortcut) await page.keyboard.press("Alt+Shift+KeyS");
  else await page.locator("record2context-ui button.mark").click();
  // Mark opens the editor on the paused frame; its note box takes the typing.
  const box = page.locator("record2context-ui .ed textarea.mark-note");
  await box.waitFor({ state: "visible", timeout: 10000 }).catch(async (e) => {
    const toasts = await page.locator("record2context-ui .toast").allTextContents().catch(() => []);
    const st = await page.evaluate(() => {
      const r = document.querySelector("record2context-ui")?.shadowRoot;
      return { mark: r?.querySelector(".mark")?.disabled, hud: r?.querySelector(".hud")?.className, note: r?.querySelector(".note")?.className, hosts: document.querySelectorAll("record2context-ui").length };
    });
    throw new Error(`note box did not open; toasts: ${JSON.stringify(toasts)}; ${JSON.stringify(st)}; ${e.message.split("\n")[0]}`);
  });
  const lines = note.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (i) await page.keyboard.press("Shift+Enter");
    if (lines[i]) await page.keyboard.insertText(lines[i]);
  }
  return {
    box,
    /** Continue, then wait out the countdown until recording resumes; returns the countdown digits seen. */
    async resume() {
      if (continueWith === "enter") await page.keyboard.press("Enter");
      else await page.locator("record2context-ui .ed button.continue").click();
      await box.waitFor({ state: "detached", timeout: 10000 });
      const seen = [];
      const until = Date.now() + 10000;
      while (Date.now() < until) {
        const st = await page.evaluate(() => {
          const r = document.querySelector("record2context-ui")?.shadowRoot;
          const c = r?.querySelector(".countdown");
          return { n: c && !c.classList.contains("off") ? c.textContent : "", resumed: r?.querySelector("button.mark")?.disabled === false };
        });
        if (st.n && seen.at(-1) !== st.n) seen.push(st.n);
        if (st.resumed) return seen;
        await page.waitForTimeout(50);
      }
      throw new Error(`recording did not resume after the countdown; saw ${seen.join(",")}`);
    },
  };
}

/**
 * The newest recording not looked at yet, once Stop has saved it: the folder the helper wrote, or (no helper, or
 * `{ from: "sessions" }`) the extension's copy exported to disk. Returns the folder on disk.
 */
export async function waitForOutput(env, { timeoutMs = 120000, from } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const sw = env.ctx.serviceWorkers().find((w) => w.url().includes(env.extId)) ?? env.sw;
    const list = await recentList(sw).catch(() => []);
    const fresh = list.find((r) => !env.exported.has(r.id));
    if (fresh) {
      env.exported.add(fresh.id);
      env.last = fresh;
      const dir = fresh.folderCopy?.dir && !fresh.folderCopy.error ? fresh.folderCopy.dir : null;
      return dir && from !== "sessions" ? dir : exportSession(env, fresh.id);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("recording was not saved");
}

/** Mark from the HUD and draw on its screenshot: `shapes` are { tool, color, from: [fx, fy], to: [fx, fy], note } in image fractions. */
export async function markWithShapes(page, { note = "", shapes = [] } = {}) {
  await page.locator("record2context-ui button.mark").click();
  const ed = page.locator("record2context-ui .ed");
  const canvas = ed.locator("canvas");
  await canvas.waitFor({ timeout: 10000 });
  await page.waitForFunction(() => document.querySelector("record2context-ui")?.shadowRoot?.querySelector(".ed canvas")?.width > 0);
  for (const [i, s] of shapes.entries()) {
    await ed.locator(`button[data-tool="${s.tool}"]`).click();
    if (s.color) await ed.locator(`.sw[data-color="${s.color}"]`).click();
    const b = await canvas.boundingBox();
    await page.mouse.move(b.x + b.width * s.from[0], b.y + b.height * s.from[1]);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width * s.to[0], b.y + b.height * s.to[1], { steps: 8 });
    await page.mouse.up();
    if (process.env.R2C_E2E_DEBUG) await page.screenshot({ path: join(OUT, `debug-shape-${i}.png`) });
    if (s.note) await ed.locator(`input.shape-note[data-n="${i + 1}"]`).fill(s.note);
  }
  if (note) await ed.locator("textarea.mark-note").fill(note);
  return ed;
}

export function videoOf(dir, report) {
  return join(dir, report.video.file);
}

export function ffprobe(file) {
  const j = JSON.parse(
    execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=width,height,codec_name", "-of", "json", file]).toString(),
  );
  return { duration: Number(j.format.duration), ...j.streams[0] };
}

/** Decode the frame at `ms` and return RGB bytes of a crop. */
export function frameCrop(file, ms, crop, png) {
  const args = ["-v", "error", "-ss", (ms / 1000).toFixed(3), "-i", file, "-frames:v", "1"];
  if (png) execFileSync("ffmpeg", [...args, "-y", png]);
  return execFileSync("ffmpeg", [...args, "-vf", `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], {
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Pixels close to the click-ripple colour (#ff2d55). */
export function ripplePixels(rgb) {
  let n = 0;
  for (let i = 0; i < rgb.length; i += 3) {
    const [r, g, b] = [rgb[i], rgb[i + 1], rgb[i + 2]];
    // Loose on purpose: VP9 4:2:0 desaturates a thin red ring, more so over dark backgrounds.
    if (r > 140 && r - g > 80 && r - b > 30) n++;
  }
  return n;
}

/**
 * Full-page green flash for 500 ms, added at the start of a frame (so the harness adds no paint delay). With `label`, also
 * logs console.error("r2c-flash <label>") then, so report.json holds the flash's own t. Returns the wall-clock time.
 */
export async function flash(page, label) {
  return page.evaluate(
    (label) =>
      new Promise((resolve) =>
        requestAnimationFrame(() => {
          const d = document.createElement("div");
          d.style.cssText = "position:fixed;inset:0;background:#00ff00;z-index:2147483646;pointer-events:none";
          document.documentElement.appendChild(d);
          const at = Date.now();
          if (label) console.error(`r2c-flash ${label}`);
          setTimeout(() => (d.remove(), resolve(at)), 500);
        }),
      ),
    label,
  );
}

/**
 * Every frame's pts (ms) and centre colour. Exact, unlike seeking: `ffmpeg -ss X` returns the first frame at or after X,
 * so a seek scan reports the frame *before* a change, which depends on how far apart the frames are.
 */
export function framesWithCentre(video) {
  const pts = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v", "-show_entries", "frame=pts_time", "-of", "csv=p=0", video])
    .toString()
    .trim()
    .split("\n")
    .map((l) => Math.round(Number(l) * 1000));
  const rgb = execFileSync("ffmpeg", ["-v", "error", "-i", video, "-fps_mode", "passthrough", "-vf", "crop=20:20:iw/2-10:ih/2-10,scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return pts.map((ms, i) => ({ ms, r: rgb[i * 3], g: rgb[i * 3 + 1], b: rgb[i * 3 + 2] }));
}

/**
 * The flash's first frame relative to `t`, and whether the video has any frame between `t` and it. With none (capture made
 * no frame for a while), the frame at `t` is the flash frame however late it is, so its offset says nothing about the clock.
 */
export function flashAtT(frames, t) {
  const offset = flashFrameOffset(frames, t);
  const captureGap = offset !== null && offset > 0 && !frames.some((f) => f.ms >= t && f.ms < t + offset);
  return { offset, captureGap };
}

/** ms from `t` to the first frame that shows the full-page flash green (pts-exact). */
export function flashFrameOffset(frames, t) {
  const f = frames.find((x) => x.ms >= t - 300 && x.r < 60 && x.g > 200 && x.b < 60);
  return f ? f.ms - t : null;
}

/** First video time (ms, 10 ms steps) whose centre crop is the flash green, relative to `t`. */
export function flashOnset(dir, report, t) {
  const video = videoOf(dir, report);
  const crop = { x: Math.round(report.video.width / 2) - 10, y: Math.round(report.video.height / 2) - 10, w: 20, h: 20 };
  for (let d = -200; d <= 400; d += 10) {
    const rgb = frameCrop(video, Math.max(0, t + d), crop);
    let green = 0;
    for (let i = 0; i < rgb.length; i += 3) if (rgb[i] < 60 && rgb[i + 1] > 200 && rgb[i + 2] < 60) green++;
    if (green > rgb.length / 3 / 2) return d;
  }
  return null;
}

/** Map a viewport CSS point to video pixels using the report's documented formula. */
export function toVideoPx(report, viewport, x, y) {
  const s = Math.min(report.video.width / viewport.width, report.video.height / viewport.height);
  const ox = (report.video.width - viewport.width * s) / 2;
  const oy = (report.video.height - viewport.height * s) / 2;
  return { x: Math.round(ox + x * s), y: Math.round(oy + y * s), s };
}

function clickCrop(report, click) {
  const p = toVideoPx(report, click.viewport, click.point.x, click.point.y);
  const half = Math.round(40 * p.s);
  const even = (n) => n - (n % 2);
  const x = even(Math.max(0, p.x - half));
  const y = even(Math.max(0, p.y - half));
  // ffmpeg rounds odd crops of 4:2:0 video down to even, which would break slicing frames out of the raw stream.
  return { x, y, w: even(Math.min(2 * half, report.video.width - x)), h: even(Math.min(2 * half, report.video.height - y)) };
}

/** Ripple pixels of `crop` in every frame, keyed by exact pts (ms). */
function rippleFrames(video, crop) {
  const pts = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v", "-show_entries", "frame=pts_time", "-of", "csv=p=0", video])
    .toString()
    .trim()
    .split("\n")
    .map((l) => Math.round(Number(l) * 1000));
  const rgb = execFileSync("ffmpeg", ["-v", "error", "-i", video, "-fps_mode", "passthrough", "-vf", `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], {
    maxBuffer: 256 * 1024 * 1024,
  });
  const size = crop.w * crop.h * 3;
  return pts.map((ms, i) => ({ ms, n: ripplePixels(rgb.subarray(i * size, (i + 1) * size)) }));
}

// Ripple is drawn on pointerdown, `t` is the click. Capture emits a frame only when the page changes, so the first ripple
// frame lands paint + capture latency after the press: measured +27..+92 ms (flash: +17..+91). Early allows one frame of stamp jitter.
export const RIPPLE_EARLY_MS = 40;
/** The recorder caps capture at 30 fps (src/offscreen). */
export const FRAME_MS = 1000 / 30;
export const RIPPLE_LATE_MS = 120;

/**
 * Pts-exact: the first frame showing the ripple lands within RIPPLE_EARLY/LATE_MS of the pointerdown (`click.t - downGapMs`),
 * the frame a player shows at `t` has it, and the one shown 200 ms before the press does not.
 */
export function checkClickFrame(dir, report, click, label, downGapMs = 0) {
  const video = videoOf(dir, report);
  const frames = rippleFrames(video, clickCrop(report, click));
  const shownAt = (ms) => frames.findLast((f) => f.ms <= ms) ?? frames[0];
  const downT = click.t - downGapMs;
  const first = frames.find((f) => f.ms >= downT - 300 && f.n > 20);
  const onsetMs = first ? first.ms - downT : null;
  const at = shownAt(click.t);
  const before = shownAt(downT - 200);
  frameCrop(video, at.ms, { x: 0, y: 0, w: 2, h: 2 }, join(OUT, `frame-${label}-after.png`));
  frameCrop(video, before.ms, { x: 0, y: 0, w: 2, h: 2 }, join(OUT, `frame-${label}-before.png`));
  const ok = at.n > 20 && before.n < at.n / 4 && onsetMs !== null && onsetMs >= -RIPPLE_EARLY_MS && onsetMs <= RIPPLE_LATE_MS;
  return { atT: at.n, before: before.n, downGapMs, onsetMs, ok };
}

/** Check the video plays, has a finite duration and seeks in Chromium, served with Range support. */
export async function checkVideoInBrowser(ctx, url, file) {
  const page = await ctx.newPage();
  await page.goto(`${url}/player.html?v=${encodeURIComponent(file)}`);
  const result = await page.evaluate(async () => {
    const v = document.querySelector("video");
    await new Promise((r, j) => {
      if (v.readyState >= 1) r();
      v.onloadedmetadata = r;
      v.onerror = () => j(new Error("video error " + v.error?.code));
    });
    const duration = v.duration;
    const target = Math.min(duration * 0.6, duration - 0.2);
    const t0 = performance.now();
    v.currentTime = target;
    await new Promise((r) => (v.onseeked = r));
    return {
      duration,
      seekableEnd: v.seekable.length ? v.seekable.end(0) : 0,
      seekedTo: v.currentTime,
      target,
      seekMs: Math.round(performance.now() - t0),
      w: v.videoWidth,
      h: v.videoHeight,
    };
  });
  await page.close();
  return result;
}

export function fileSize(f) {
  return statSync(f).size;
}

export function readReport(dir) {
  return JSON.parse(readFileSync(join(dir, "details", "report.json"), "utf8"));
}
