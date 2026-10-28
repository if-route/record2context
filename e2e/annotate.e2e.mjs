// Annotation tools: Screenshot (a Mark) opens the editor on the paused frame; two shapes with their own notes and colours,
// a note, Continue → countdown → resume; a second Screenshot by its shortcut with one pen shape. The HUD shows the keys. Checks report.json, the saved images and context.md.
// Run: npm run build && node e2e/annotate.e2e.mjs
import { readFileSync, readdirSync } from "node:fs";
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
} catch (e) {
  check("no exception", false, e.stack);
} finally {
  await ctx.close();
  server.close();
}
const failed = results.filter((r) => !r.ok);
log(`${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length ? 1 : 0;
