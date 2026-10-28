// Closing the recorded tab must still produce the video and report (stopReason "tab-closed").
// Run: npm run build && node e2e/tab-close.e2e.mjs
import { join } from "node:path";
import { startServer } from "./server.mjs";
import { ROOT, ffprobe, launch, log, readReport, startRecording, videoOf, waitForOutput } from "./lib.mjs";

const { server, port } = await startServer(join(ROOT, "e2e", "fixtures"));
const env = await launch("tabclose");
const { ctx, sw, extId } = env;
let ok = false;
try {
  const keep = await ctx.newPage(); // keeps the window open after the recorded tab closes
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await startRecording(ctx, extId, sw, page);
  await page.getByRole("button", { name: "Load data" }).click();
  await page.waitForTimeout(2000);
  await page.close();
  const dir = await waitForOutput(env, { timeoutMs: 60000 });
  const report = readReport(dir);
  const probe = ffprobe(videoOf(dir, report));
  log("stopReason:", report.stopReason, "duration:", probe.duration, "events:", report.counts.events);
  const stopSnap = report.storage?.at(-1);
  log("stop snapshot:", JSON.stringify(stopSnap));
  // The tab is gone, so the Stop snapshot can only record why it is missing; the recording is saved regardless.
  ok = ["tab-closed", "capture-ended"].includes(report.stopReason) && probe.duration > 1.5 && report.events.some((e) => e.type === "click") && stopSnap?.label === "stop" && !!stopSnap.error;
  await keep.close();
} catch (e) {
  log("FAIL", e.stack);
} finally {
  await ctx.close();
  server.close();
}
log(ok ? "PASS tab close yields video + report" : "FAIL tab close");
process.exit(ok ? 0 : 1);
