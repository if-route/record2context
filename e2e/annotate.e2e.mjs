// Annotation tools: Screenshot (a Mark) opens the editor on the paused frame; two shapes with their own notes and colours,
// a note, Continue → countdown → resume; a second Screenshot by its shortcut with one pen shape. The HUD shows the keys. Checks report.json, the saved images and context.md.
// Run: npm run build && node e2e/annotate.e2e.mjs
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { startServer } from "./server.mjs";
import { OUT, ROOT, launch, log, markWithShapes, readReport, startRecording, stopViaHud, waitForOutput } from "./lib.mjs";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
};

/** Pixels of `hex` (±tolerance) in a PNG, decoded by the browser. */
async function countColour(page, pngBase64, hex, tol = 40) {
  return page.evaluate(
    async ({ b64, hex, tol }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = new OffscreenCanvas(img.naturalWidth, img.naturalHeight);
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0);
      const { data } = g.getImageData(0, 0, c.width, c.height);
      const n = parseInt(hex.slice(1), 16);
      const [R, G, B] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
      let hits = 0;
      for (let i = 0; i < data.length; i += 4) if (Math.abs(data[i] - R) < tol && Math.abs(data[i + 1] - G) < tol && Math.abs(data[i + 2] - B) < tol) hits++;
      return hits;
    },
    { b64: pngBase64, hex, tol },
  );
}

/** Layout of the open editor in CSS px. */
const editorBoxes = (page) =>
  page.evaluate(() => {
    const r = document.querySelector("record2context-ui").shadowRoot;
    const box = (sel) => {
      const b = r.querySelector(sel).getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height, right: b.right, bottom: b.bottom };
    };
    const body = r.querySelector(".ed .body");
    return { bar: box(".ed .bar"), body: box(".ed .body"), stage: box(".ed .stage"), img: box(".ed img"), canvas: box(".ed canvas"), side: box(".ed .side"), cont: box(".ed button.continue"), scrollTop: body.scrollTop, vw: document.documentElement.clientWidth, iw: innerWidth };
  });
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;
const sameRect = (a, b) => near(a.x, b.x) && near(a.y, b.y) && near(a.w, b.w) && near(a.h, b.h);
const ARTIFACTS = process.env.R2C_E2E_ARTIFACTS ?? OUT;
mkdirSync(ARTIFACTS, { recursive: true });

const { server, port } = await startServer(join(ROOT, "e2e", "fixtures"));
const env = await launch("annotate");
const { ctx, sw, extId } = env;
try {
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(`http://127.0.0.1:${port}/`);
  await startRecording(ctx, extId, sw, page);
  const chromeKeys = await sw.evaluate(async () => ({
    mac: (await chrome.runtime.getPlatformInfo()).os === "mac",
    keys: Object.fromEntries((await chrome.commands.getAll()).map((c) => [c.name, c.shortcut ?? ""])),
  }));
  const want = chromeKeys.mac ? ["⌥⇧S", "⌥⇧R"] : ["Alt+Shift+S", "Alt+Shift+R"];
  const hudKeys = await page.locator("record2context-ui button.mark kbd, record2context-ui button.stop kbd").allTextContents();
  check("the HUD shows Chrome's keys on Screenshot and Stop", chromeKeys.keys.screenshot && chromeKeys.keys["toggle-recording"] && JSON.stringify(hudKeys) === JSON.stringify(want), JSON.stringify({ hudKeys, chromeKeys }));
  check("the HUD button is named Screenshot; no separate Screenshot button", (await page.locator("record2context-ui button.mark").textContent()).startsWith("Screenshot") && (await page.locator("record2context-ui button.shot").count()) === 0);
  await page.waitForTimeout(1000);

  // Where the Title field and the page title are on the live page, as image fractions (the tab is 1280x800).
  const at = await page.evaluate(() => {
    const b = document.querySelector("input[name=title]").getBoundingClientRect();
    const h = document.querySelector("#page-title").getBoundingClientRect();
    return { b: { x: b.x, y: b.y, w: b.width, h: b.height }, h: { x: h.x, y: h.y, w: h.width, h: h.height }, vw: innerWidth, vh: innerHeight };
  });
  const fx = (x) => x / at.vw;
  const fy = (y) => y / at.vh;
  const ed = await markWithShapes(page, {
    note: "Title field too small; heading too close",
    shapes: [
      { tool: "box", color: "yellow", from: [fx(at.b.x - 6), fy(at.b.y - 6)], to: [fx(at.b.x + at.b.w + 6), fy(at.b.y + at.b.h + 6)], note: "field too narrow" },
      { tool: "arrow", color: "cyan", from: [fx(at.h.x + 300), fy(at.h.y + 80)], to: [fx(at.h.x + at.h.w / 4), fy(at.h.y + at.h.h / 2)], note: "ตัวหนังสือชิดขอบ" },
    ],
  });
  const listed = await ed.locator(".shapes li .what").allTextContents();
  check("editor lists both shapes with the element under each", listed.length === 2 && /box · yellow · input "Title"/.test(listed[0]) && /arrow · cyan · h1 "Local test page"/.test(listed[1]), listed.join(" | "));
  const paused = await sw.evaluate(async () => (await chrome.storage.session.get("session")).session?.pauses?.at(-1)?.end === undefined);
  check("the video is paused while the editor is open", paused);
  await page.screenshot({ path: join(OUT, "annotate-editor.png") });
  const wide = await editorBoxes(page);
  check("wide layout: the side panel (300px + padding) sits beside the image", wide.vw === 1280 && near(wide.side.w, 312) && wide.side.x >= wide.stage.right - 1 && near(wide.side.y, wide.stage.y) && wide.canvas.w > 800, JSON.stringify(wide));
  await page.screenshot({ path: join(ARTIFACTS, "editor-1280.png") });
  check("the last colour is remembered", (await sw.evaluate(async () => (await chrome.storage.local.get("annotateColor")).annotateColor)) === "cyan");

  await ed.locator("button.continue").click();
  const seen = [];
  for (let i = 0; i < 200; i++) {
    const st = await page.evaluate(() => {
      const r = document.querySelector("record2context-ui")?.shadowRoot;
      const c = r?.querySelector(".countdown");
      return { n: c && !c.classList.contains("off") ? c.textContent : "", editor: !!r?.querySelector(".ed"), resumed: r?.querySelector("button.mark")?.disabled === false };
    });
    if (st.n && seen.at(-1) !== st.n) seen.push(st.n);
    if (st.resumed) break;
    await page.waitForTimeout(50);
  }
  check("Continue: editor gone, countdown 3-2-1, then recording resumes", seen.join("") === "321", seen.join(","));
  await page.waitForTimeout(800);

  // Second Screenshot, by its page-level shortcut: one red pen stroke with a note.
  await page.keyboard.press("Alt+Shift+KeyS");
  const sed = page.locator("record2context-ui .ed");
  await sed.locator("canvas").waitFor({ timeout: 10000 });
  await page.waitForFunction(() => document.querySelector("record2context-ui")?.shadowRoot?.querySelector(".ed canvas")?.width > 0);
  check("the Screenshot editor starts with the remembered colour", (await sed.locator('.sw[aria-pressed="true"]').getAttribute("data-color")) === "cyan");
  await sed.locator('button[data-tool="pen"]').click();
  await sed.locator('.sw[data-color="red"]').click();
  const cb = await sed.locator("canvas").boundingBox();
  await page.mouse.move(cb.x + cb.width * 0.3, cb.y + cb.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(cb.x + cb.width * 0.5, cb.y + cb.height * 0.7, { steps: 6 });
  await page.mouse.up();
  await sed.locator('input.shape-note[data-n="1"]').fill("this area");
  await page.screenshot({ path: join(OUT, "annotate-screenshot-editor.png") });
  await sed.locator("button.continue").click();
  await sed.waitFor({ state: "detached", timeout: 10000 });
  await page.locator("record2context-ui button.mark:not([disabled])").waitFor({ timeout: 10000 });
  await page.waitForTimeout(500);
  await stopViaHud(page);

  const dir = await waitForOutput(env);
  const report = readReport(dir);
  const mark = report.marks[0];
  const markShot = report.screenshots.find((s) => s.mark === 1);
  check("the mark references its screenshot and t", mark?.screenshot === "details/screenshots/screenshot-01-original.png" && mark.annotatedScreenshot === "screenshot-01.png" && markShot?.t === mark.t && mark.note === "Title field too small; heading too close", JSON.stringify(mark));
  const [box, arrow] = markShot?.annotations ?? [];
  check(
    "two numbered shapes with colour, note and geometry in image and CSS px",
    box?.n === 1 && box.shape === "box" && box.color === "yellow" && box.note === "field too narrow" && arrow?.n === 2 && arrow.shape === "arrow" && arrow.color === "cyan" && arrow.note === "ตัวหนังสือชิดขอบ",
    JSON.stringify(markShot?.annotations?.map((a) => [a.n, a.shape, a.color, a.note])),
  );
  const ev = report.events.find((e) => e.type === "screenshot" && e.mark === 1);
  const k = ev.viewport.width / ev.imageWidth;
  const g = box.geometry;
  check(
    "CSS geometry = image geometry × viewport.width / imageWidth, and lands on the field",
    Math.abs(g.css.x - g.image.x * k) < 0.06 && Math.abs(g.css.width - g.image.width * k) < 0.06 && Math.abs(g.css.x - (at.b.x - 6)) < 3 && Math.abs(g.css.y - (at.b.y - 6)) < 3,
    JSON.stringify(g),
  );
  check(
    "element under the box: label, selector, bbox and computed styles",
    box.element?.tag === "input" && box.element.label === "Title" && box.element.labelSource === "label" && !box.element.text && box.element.selector && Math.abs(box.element.bbox.x - at.b.x) <= 1 && /^rgb/.test(box.element.style.color) && box.element.style.display,
    JSON.stringify(box.element),
  );
  check("element at the arrow's tip", arrow.element?.tag === "h1" && arrow.element.text === "Local test page", JSON.stringify(arrow.element));
  const shot2 = report.screenshots.find((s) => s.mark === 2);
  check("second Screenshot: one pen shape with its note, no element, drawn copy at the top", shot2?.annotatedFile === "screenshot-02.png" && shot2.annotations?.length === 1 && shot2.annotations[0].shape === "pen" && shot2.annotations[0].note === "this area" && !shot2.annotations[0].element, JSON.stringify(shot2));

  const b64 = (f) => readFileSync(join(dir, f)).toString("base64");
  const plainYellow = await countColour(page, b64("details/screenshots/screenshot-01-original.png"), "#facc15");
  const annYellow = await countColour(page, b64("screenshot-01.png"), "#facc15");
  const annCyan = await countColour(page, b64("screenshot-01.png"), "#06b6d4");
  check("the plain mark frame has no drawing; the annotated copy has both shapes and badges", plainYellow < 50 && annYellow > 400 && annCyan > 400, `yellow plain ${plainYellow}, annotated ${annYellow}; cyan ${annCyan}`);

  const ctxJson = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(readFileSync(join(dir, "details", "context.md"), "utf8"))[1]);
  const ctxShot = ctxJson.screenshots.find((s) => s.mark === 1);
  check("context.md lists the shapes compactly", ctxShot?.shapes?.length === 2 && ctxShot.shapes[0].on?.label === "Title" && ctxShot.shapes[1].note === "ตัวหนังสือชิดขอบ" && ctxJson.marks[0].screenshot === "details/screenshots/screenshot-01-original.png", JSON.stringify(ctxShot));
  const readme = readFileSync(join(dir, "details", "AI-README.md"), "utf8");
  const top = readdirSync(dir).sort();
  check("top level: the video and the two drawn Screenshots, then details/", JSON.stringify(top) === JSON.stringify([`${report.video.file}`, "details", "screenshot-01.png", "screenshot-02.png"].sort()), top.join(", "));
  check("AI-README.md explains the shapes", readme.includes("## Screenshots and shapes") && readme.includes("`screenshot-01.png` at t="));

  // Decision 26: DevTools device mode (iPhone SE, touch) stacks the image over the panel; leaving it while open keeps shapes in place.
  await startRecording(ctx, extId, sw, page);
  // Make the fixture responsive like the reported app page; otherwise mobile emulation widens the layout viewport to its content.
  await page.evaluate(() => document.head.insertAdjacentHTML("beforeend", '<meta name="viewport" content="width=device-width, initial-scale=1"><style>body * { max-width: 100%; box-sizing: border-box; }</style>'));
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 375, height: 667, deviceScaleFactor: 2, mobile: true });
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  await page.waitForFunction(() => document.documentElement.clientWidth === 375);
  const ned = page.locator("record2context-ui .ed");
  await page.keyboard.press("Alt+Shift+KeyS");
  await page.waitForFunction(() => document.querySelector("record2context-ui")?.shadowRoot?.querySelector(".ed canvas")?.width > 0);
  await page.waitForTimeout(200);
  const narrow = await editorBoxes(page);
  check(
    "375px: image on top at full width, panel below it, toolbar clear of both",
    narrow.vw === 375 && narrow.canvas.w >= 300 && sameRect(narrow.canvas, narrow.img) && narrow.side.y >= narrow.stage.bottom - 1 && narrow.bar.bottom <= narrow.body.y + 1 && narrow.cont.bottom <= narrow.bar.bottom && narrow.cont.right <= 375,
    JSON.stringify(narrow),
  );
  await page.screenshot({ path: join(ARTIFACTS, "editor-375.png") });
  /** Drag on the canvas between image fractions; `touch` sends real touch events, as DevTools device mode does for the mouse. */
  const drawBox = async (from, to, { touch = false } = {}) => {
    const b = await ned.locator("canvas").boundingBox();
    const pt = ([fx, fy]) => ({ x: b.x + b.width * fx, y: b.y + b.height * fy });
    if (!touch) {
      await page.mouse.move(pt(from).x, pt(from).y);
      await page.mouse.down();
      await page.mouse.move(pt(to).x, pt(to).y, { steps: 8 });
      await page.mouse.up();
      return;
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [pt(from)] });
    for (let i = 1; i <= 8; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [pt([from[0] + ((to[0] - from[0]) * i) / 8, from[1] + ((to[1] - from[1]) * i) / 8])] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  await ned.locator('button[data-tool="box"]').click();
  await drawBox([0.2, 0.1], [0.7, 0.3], { touch: true });
  check("375px: a box drawn by a touch drag is added", (await ned.locator(".shapes li").count()) === 1);
  await page.mouse.move(narrow.stage.x + narrow.stage.w / 2, narrow.body.y + 50);
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(300);
  check("375px: the wheel scrolls the editor down to the panel", (await editorBoxes(page)).scrollTop > 0);

  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await cdp.send("Emulation.clearDeviceMetricsOverride");
  await page.waitForFunction(() => innerWidth === 1280);
  await page.waitForTimeout(200);
  const back = await editorBoxes(page);
  check("back to 1280 while open: panel beside the image again, canvas over the image", near(back.side.w, 312) && back.side.x >= back.stage.right - 1 && sameRect(back.canvas, back.img) && back.canvas.w > narrow.canvas.w, JSON.stringify(back));
  await drawBox([0.3, 0.6], [0.8, 0.9]);
  await page.screenshot({ path: join(ARTIFACTS, "editor-375-then-1280.png") });
  await ned.locator("button.continue").click();
  await ned.waitFor({ state: "detached", timeout: 10000 });
  await page.locator("record2context-ui button.mark:not([disabled])").waitFor({ timeout: 10000 });
  await stopViaHud(page);
  const r2 = readReport(await waitForOutput(env));
  const nshot = r2.screenshots.find((s) => s.mark === 1);
  const nev = r2.events.find((e) => e.type === "screenshot" && e.mark === 1);
  const [n1, n2] = nshot?.annotations ?? [];
  const at2 = (g, fx, fy, fw, fh) => near(g.x, fx * nev.imageWidth, 4) && near(g.y, fy * nev.imageHeight, 4) && near(g.width, fw * nev.imageWidth, 4) && near(g.height, fh * nev.imageHeight, 4);
  check(
    "shapes drawn before and after the resize land where they were drawn on the image",
    nshot?.annotations?.length === 2 && at2(n1.geometry.image, 0.2, 0.1, 0.5, 0.2) && at2(n2.geometry.image, 0.3, 0.6, 0.5, 0.3),
    JSON.stringify({ w: nev?.imageWidth, h: nev?.imageHeight, g: nshot?.annotations?.map((a) => a.geometry.image) }),
  );
} catch (e) {
  check("no exception", false, e.stack);
} finally {
  await ctx.close();
  server.close();
}
const failed = results.filter((r) => !r.ok);
log(`${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length ? 1 : 0;
