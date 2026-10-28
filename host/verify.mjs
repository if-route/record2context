#!/usr/bin/env node
// Mechanical check that record2context is installed and really works from Chrome. Prints a JSON verdict (READY or
// NOT_READY) with every check's evidence and who fixes a failure ("installer" or "human"). See VERIFY-FOR-AI.md.
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  LAUNCH_LOG,
  HOST_NAME,
  HOST_SOURCE,
  MINIMAL_PATH,
  REPO,
  expandHome,
  hasReport,
  hostSourceVersion,
  manifestDir,
  manifestFile,
  parseLauncher,
  repoExtensionId,
  talkToHost,
} from "./common.mjs";

export function parseVerifyArgs(argv) {
  const o = { browser: "chrome", manifestDir: process.env.RECORD2CONTEXT_MANIFEST_DIR || null, waitHeartbeat: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--browser") o.browser = argv[++i];
    else if (a === "--manifest-dir") o.manifestDir = argv[++i];
    else if (a === "--wait-heartbeat") o.waitHeartbeat = Number(argv[++i]);
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

const sha = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const isExec = (file) => {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** Newest mtime under `dir` (recursive), so a build older than its sources is caught. */
function newestMtime(dir) {
  let newest = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    newest = Math.max(newest, e.isDirectory() ? newestMtime(p) : fs.statSync(p).mtimeMs);
  }
  return newest;
}

/** Desktop, Documents or Downloads holding `p` (macOS may ask before Chrome reads there), else null. */
function guardedFolder(p) {
  const home = process.env.HOME ?? "";
  return ["Desktop", "Documents", "Downloads"].find((d) => p.startsWith(path.join(home, d) + path.sep)) ?? null;
}

// Facts about what the person must do; the installing AI words them for the person itself (Requirement 13).
const HUMAN = {
  loadUnpacked: (dist) => {
    const guarded = guardedFolder(dist);
    return [
      "Human step, once, in Google Chrome:",
      "open chrome://extensions and switch on Developer mode;",
      `if an older QA Recorder or record2context is listed and was loaded from ${dist}, its round-arrow reload button is enough (its recordings stay) and the next two steps are skipped; one loaded from another folder is removed (Remove deletes the recordings kept only inside it; Save to folder on its All recordings page keeps them);`,
      `click Load unpacked and choose the folder ${dist} (in the file dialog Cmd+Shift+G on a Mac accepts that path);`,
      `if macOS asks whether Google Chrome may access files in a folder, the person allows it${guarded ? ` (it can ask just for loading, because ${dist} is inside ${guarded})` : ""};`,
      "then click the record2context icon in Chrome's toolbar once (puzzle-piece menu if it is not pinned).",
      "The heartbeat then appears by itself; the person does not need to reply.",
    ].join(" ");
  },
  reload: "Human step: in chrome://extensions, click the round-arrow reload button on record2context once.",
  clickIcon: "Human step: click the record2context icon in Chrome's toolbar once (puzzle-piece menu if it is not pinned); the window it opens can be closed again.",
};

/**
 * Chrome's starts of the helper (the launcher logs one line per start, then node's stderr), oldest first; a rotated
 * `.1` file is read first. Starts by the installer and the verifier are not logged.
 */
export function readLaunchLog(file) {
  let text = "";
  for (const f of [`${file}.1`, file]) {
    try {
      text += fs.readFileSync(f, "utf8");
    } catch {
      /* missing: nothing logged yet */
    }
  }
  const launches = [];
  let afterLast = [];
  for (const line of text.split("\n")) {
    const m = /^(\S*) launch origin=(.*)$/.exec(line);
    if (m) {
      launches.push({ at: m[1], origin: m[2] });
      afterLast = [];
    } else if (line.trim() && launches.length) afterLast.push(line);
  }
  return { file, exists: !!text, launches: launches.length, lastLaunch: launches.at(-1) ?? null, stderrAfterLastLaunch: afterLast.slice(-20).join("\n").slice(-2000) };
}

export async function verify(o) {
  const checks = [];
  const add = (id, ok, evidence, fix = "", owner = "installer", required = true) => checks.push({ id, ok: !!ok, required, owner: ok ? null : owner, evidence, ...(ok ? {} : { fix }) });
  const dist = path.join(REPO, "dist");
  const extensionId = repoExtensionId();
  const origin = `chrome-extension://${extensionId}/`;
  const ctx = { extensionId, origin, dist, repo: REPO };

  const major = Number(process.versions.node.split(".")[0]);
  add("node", major >= 20, `node ${process.version} at ${process.execPath}`, "Install Node.js 20 or newer, then re-run the install.");

  let buildInfo = null;
  try {
    const m = readJson(path.join(dist, "manifest.json"));
    buildInfo = readJson(path.join(dist, "build-info.json"));
    const keyOk = m.key === readJson(path.join(REPO, "static", "manifest.json")).key;
    add("dist-built", keyOk && buildInfo.extensionId === extensionId && buildInfo.repo === REPO, { dist, buildId: buildInfo.buildId, extensionId: buildInfo.extensionId, repo: buildInfo.repo }, `Run: cd ${REPO} && npm ci && npm run build`);
    const built = fs.statSync(path.join(dist, "build-info.json")).mtimeMs;
    const src = Math.max(newestMtime(path.join(REPO, "src")), newestMtime(path.join(REPO, "static")));
    add("dist-current", built >= src, { builtAt: new Date(built).toISOString(), newestSource: new Date(src).toISOString() }, `Run: cd ${REPO} && npm run build (then the person reloads record2context in chrome://extensions)`);
  } catch (e) {
    add("dist-built", false, `dist/ is not built: ${e.message}`, `Run: cd ${REPO} && npm ci && npm run build`);
  }
  const guide = path.join(buildInfo?.repo ?? REPO, "INSTALL-FOR-AI.md");
  add("install-guide", fs.existsSync(guide), { setupPromptPoints: guide }, "The build's repo path must hold INSTALL-FOR-AI.md: rebuild from the repo that has it.");

  const mdir = path.resolve(expandHome(o.manifestDir ?? manifestDir(o.browser)));
  const mfile = manifestFile(mdir);
  let manifest = null;
  try {
    manifest = readJson(mfile);
  } catch (e) {
    add("host-manifest", false, `${mfile}: ${e.code === "ENOENT" ? "missing" : e.message}`, `Run: cd ${REPO} && npm run install-host`);
  }
  let launcher = null;
  if (manifest) {
    const problems = [];
    if (manifest.name !== HOST_NAME) problems.push(`name is ${manifest.name}, expected ${HOST_NAME}`);
    if (manifest.type !== "stdio") problems.push(`type is ${manifest.type}`);
    if (!path.isAbsolute(manifest.path ?? "")) problems.push(`path ${manifest.path} is not absolute`);
    else if (!fs.existsSync(manifest.path)) problems.push(`path ${manifest.path} does not exist`);
    else if (process.platform !== "win32" && !isExec(manifest.path)) problems.push(`path ${manifest.path} is not executable`);
    if (JSON.stringify(manifest.allowed_origins) !== JSON.stringify([origin])) problems.push(`allowed_origins is ${JSON.stringify(manifest.allowed_origins)}, expected ["${origin}"]`);
    add("host-manifest", !problems.length, { file: mfile, manifest, problems }, `Run: cd ${REPO} && npm run install-host`);
    if (!problems.length) launcher = manifest.path;
  }

  let paths = null;
  if (launcher) {
    paths = parseLauncher(fs.readFileSync(launcher, "utf8"));
    const problems = [];
    if (!paths) problems.push("launcher does not have the expected exec line");
    else {
      if (!fs.existsSync(paths.node) || !isExec(paths.node)) problems.push(`node ${paths.node} is missing or not executable`);
      if (!fs.existsSync(paths.host)) problems.push(`host ${paths.host} is missing`);
      if (!fs.existsSync(paths.config)) problems.push(`config ${paths.config} is missing`);
    }
    add("launcher", !problems.length, { launcher, ...(paths ?? {}), problems }, `Run: cd ${REPO} && npm run install-host (it writes absolute paths for the node it runs with)`);
    if (problems.length) paths = null;
  }

  let config = null;
  if (paths) {
    const guarded = guardedFolder(paths.host);
    add("host-location", !guarded, { hostDir: path.dirname(paths.host) }, `Chrome cannot start a host whose files are in ${guarded} (macOS privacy). Re-run: cd ${REPO} && npm run install-host (default install dir, no --install-dir).`);
    add("host-current", sha(paths.host) === sha(HOST_SOURCE), { installed: paths.host, repo: HOST_SOURCE }, `Run: cd ${REPO} && npm run install-host (updates the installed copy)`);
    try {
      config = readJson(paths.config);
      const raw = typeof config.recordingsDir === "string" ? expandHome(config.recordingsDir.trim()) : "";
      const dir = raw && path.isAbsolute(raw) ? path.resolve(raw) : "";
      const ok = !!dir && fs.existsSync(dir) && fs.statSync(dir).isDirectory();
      // Test-only keys: revealLog stops Show folder from opening Finder.
      const testKeys = ["revealLog"].filter((k) => k in config && config[k] !== process.env.RECORD2CONTEXT_REVEAL_LOG);
      add("config-test-keys", !testKeys.length, { testOnlyKeys: testKeys }, `Remove ${testKeys.map((k) => `"${k}"`).join(", ")} from ${paths.config} (test-only; it stops Show folder from opening Finder).`);
      add("config", ok, { file: paths.config, recordingsDir: config.recordingsDir, resolved: dir, exists: fs.existsSync(dir) }, `Set "recordingsDir" in ${paths.config} to an absolute folder path and create the folder (or re-run: npm run install-host -- --recordings-dir <folder>).`);
      config.resolved = dir;
      const chosen = config.folder?.chosen;
      const chosenDir = typeof chosen === "string" && chosen !== "default" ? path.resolve(expandHome(chosen)) : null;
      add(
        "folder-choice",
        chosen === "default" || (!!chosenDir && chosenDir === dir),
        { file: paths.config, chosen: chosen ?? null, recordingsDir: dir },
        chosen === undefined
          ? `No folder choice is recorded in ${paths.config}. Record the person's answer from step 0 (cd ${REPO} && npm run install-host -- --choose-folder "<absolute folder>", or --choose-folder default), then run npm run install-host.`
          : `The person chose ${chosenDir}, but recordingsDir is ${dir}. Run: cd ${REPO} && npm run install-host (it applies the recorded choice).`,
      );
    } catch (e) {
      add("config", false, `${paths.config}: ${e.message}`, `Re-run: cd ${REPO} && npm run install-host`);
    }
  }

  let ping = null;
  if (paths) {
    try {
      [ping] = await talkToHost(launcher, [{ id: 1, op: "ping" }], { origin, env: { HOME: process.env.HOME ?? "", PATH: MINIMAL_PATH }, caller: "verify" });
      const ok = ping.ok && ping.dirOk && ping.hostVersion === hostSourceVersion() && ping.dir === config?.resolved;
      add("minimal-env-run", ok, { env: `PATH=${MINIMAL_PATH} (like Chrome started from the Dock)`, reply: ping }, `The host must answer like this when Chrome starts it. Re-run: cd ${REPO} && npm run install-host; if dirOk is false, see dirError.`);
    } catch (e) {
      add("minimal-env-run", false, { env: `PATH=${MINIMAL_PATH}`, error: e.message }, `Re-run: cd ${REPO} && npm run install-host`);
    }
  }

  if (ping?.ok && ping.dirOk) {
    const session = `record2context-verify-${randomBytes(4).toString("hex")}`;
    const data = randomBytes(1500);
    const steps = [];
    try {
      const [w1, w2, ls, rd, del, after] = await talkToHost(
        launcher,
        [
          { id: 1, op: "write", session, path: "sub dir/ทดสอบ.bin", offset: 0, data: data.subarray(0, 1000).toString("base64") },
          { id: 2, op: "write", session, path: "sub dir/ทดสอบ.bin", offset: 1000, data: data.subarray(1000).toString("base64"), done: true },
          { id: 3, op: "list", session },
          { id: 4, op: "read", session, path: "sub dir/ทดสอบ.bin", offset: 0 },
          { id: 5, op: "delete", session },
          { id: 6, op: "list", session },
        ],
        { origin, env: { HOME: process.env.HOME ?? "", PATH: MINIMAL_PATH }, caller: "verify" },
      );
      const onDisk = path.join(ping.dir, session, "sub dir", "ทดสอบ.bin");
      steps.push({ write: w1.ok && w2.ok && w2.size === 1500, list: ls.files?.[0]?.size === 1500, read: rd.ok && Buffer.from(rd.data, "base64").equals(data), delete: del.existed === true, goneAfter: after.exists === false && !fs.existsSync(path.dirname(path.dirname(onDisk))) });
      add("host-roundtrip", Object.values(steps[0]).every(Boolean), { session, dir: ping.dir, steps: steps[0] }, "Writing, reading or deleting through the host failed: see steps; check the folder's permissions.");
    } catch (e) {
      fs.rmSync(path.join(ping.dir, session), { recursive: true, force: true });
      add("host-roundtrip", false, { session, error: e.message }, `Re-run: cd ${REPO} && npm run install-host`);
    }
  }

  add("copy-for-ai-path", !!ping?.dir && path.isAbsolute(ping.dir) && fs.existsSync(ping.dir), { recordingsDir: ping?.dir ?? null, example: ping?.dir ? path.join(ping.dir, "<YYYY-MM-DD_HHmmss>_<host>") : null }, "Copy for my AI names <recordings folder>/<session>; the host must report an existing absolute folder.");

  // Heartbeat: only Chrome, running this extension, can have written it (the host records the origin Chrome passed).
  const statusFile = paths ? path.join(path.dirname(paths.config), "status.json") : null;
  let status = null;
  try {
    status = statusFile ? readJson(statusFile) : null;
  } catch {
    status = null;
  }
  const hb = status?.lastHeartbeat;
  if (!paths) {
    add("heartbeat", false, { statusFile: null }, "Not checked: fix the installer failures above first, then verify again.", "installer");
  } else if (!hb) {
    // Never started by Chrome: the extension is not loaded (yet). Started but silent: the helper fails, see its stderr.
    const launch = readLaunchLog(path.join(path.dirname(paths.config), LAUNCH_LOG));
    if (!launch.launches) add("heartbeat", false, { state: "never-launched", statusFile, lastHeartbeat: null, launchLog: launch }, HUMAN.loadUnpacked(dist), "human");
    else
      add(
        "heartbeat",
        false,
        { state: "launched-no-heartbeat", statusFile, lastHeartbeat: null, launchLog: launch },
        `Chrome started the helper (${launch.launches} time(s), last at ${launch.lastLaunch.at}) but it never wrote a heartbeat, so it fails when Chrome runs it. Its error output: ${launch.stderrAfterLastLaunch ? JSON.stringify(launch.stderrAfterLastLaunch) : "(none)"}. Fix it from the shell (re-run: cd ${REPO} && npm run install-host; check the node path in the launcher), then verify again.`,
        "installer",
      );
  } else {
    const launch = readLaunchLog(path.join(path.dirname(paths.config), LAUNCH_LOG));
    // A start by Chrome after the last heartbeat that left error output: the helper broke since it last worked.
    const failingSince = launch.lastLaunch && Date.parse(launch.lastLaunch.at) > Date.parse(hb.at) + 1000 && launch.stderrAfterLastLaunch;
    if (failingSince) {
      add("heartbeat", false, { state: "launched-failing-since-heartbeat", statusFile, lastHeartbeat: hb, launchLog: launch }, `Chrome started the helper at ${launch.lastLaunch.at}, after its last heartbeat (${hb.at}), and it failed. Its error output: ${JSON.stringify(launch.stderrAfterLastLaunch)}. Fix it from the shell (re-run: cd ${REPO} && npm run install-host), then verify again.`, "installer");
    } else {
      add("heartbeat", hb.origin === origin && hb.extensionId === extensionId, { state: "heartbeat", statusFile, lastHeartbeat: hb, launchLog: launch }, `The heartbeat came from ${hb.origin}; expected ${origin}. ${HUMAN.loadUnpacked(dist)}`, "human");
    }
    const installedAt = paths ? Math.max(...[mfile, paths.host, launcher, paths.config].map((f) => fs.statSync(f).mtimeMs)) : 0;
    add("heartbeat-fresh", Date.parse(hb.at) >= installedAt, { heartbeatAt: hb.at, installChangedAt: new Date(installedAt).toISOString() }, `The last heartbeat is older than the current install. ${HUMAN.clickIcon}`, "human");
    add("heartbeat-build", !!buildInfo && hb.buildId === buildInfo.buildId, { heartbeatBuild: hb.buildId, distBuild: buildInfo?.buildId ?? null }, `Chrome runs another build than dist/ holds. ${HUMAN.reload} If it still differs, the extension was loaded from another folder: ${HUMAN.loadUnpacked(dist)}`, "human");
    const st = status.selfTest;
    const tcc = /operation not permitted|EPERM/i.test(st?.error ?? "");
    const shellWrites = checks.find((c) => c.id === "host-roundtrip")?.ok === true;
    add(
      "chrome-wrote-folder",
      !!st?.ok && st.dir === config?.resolved,
      { selfTest: st ?? null, configured: config?.resolved ?? null },
      tcc
        ? `macOS does not let Chrome use that folder yet. Human step: in System Settings > Privacy & Security > Files and Folders, find Google Chrome and switch on the folder (Desktop, Documents or Downloads) that holds ${config?.resolved}, then click the record2context icon in Chrome once. A folder directly in the home folder needs no such permission, if the person prefers to switch (re-run step 4 with it).`
        : st?.dir !== config?.resolved
          ? `The self-test ran on another folder than the config names (config changed since). ${HUMAN.clickIcon}`
          : shellWrites
            ? `Chrome's last self-test failed (${st?.error}), but the folder can be written now. ${HUMAN.clickIcon}`
            : `Chrome's host could not write the folder: ${st?.error}. Fix the folder (installer), then ${HUMAN.clickIcon}`,
      tcc || st?.dir !== config?.resolved || shellWrites ? "human" : "installer",
    );
  }
  if (status?.lastSave) {
    const ls = status.lastSave;
    add("last-save", hasReport(ls.dir), { lastSave: ls }, "The last recording Chrome saved is no longer at that path (moved or deleted by hand); not a blocker.", "installer", false);
  }

  // The person is asked only when nothing is left for the installer: their step may be moot once the install is fixed.
  if (checks.some((c) => c.required && !c.ok && c.owner === "installer")) {
    for (const c of checks) {
      if (c.required && !c.ok && c.owner === "human") {
        c.owner = "installer";
        c.deferredHumanStep = c.fix;
        c.fix = "Fix the other installer failures first, then verify again (this may then become a step for the person).";
      }
    }
  }
  const failed = checks.filter((c) => c.required && !c.ok);
  return {
    verdict: failed.length ? "NOT_READY" : "READY",
    checkedAt: new Date().toISOString(),
    ...ctx,
    manifest: mfile,
    config: paths?.config ?? null,
    statusFile,
    recordingsDir: config?.resolved ?? null,
    failures: failed.map(({ id, owner, fix, evidence }) => ({ id, owner, fix, evidence })),
    humanSteps: [...new Set(failed.filter((c) => c.owner === "human").map((c) => c.fix))],
    checks,
  };
}

/** Polls until the heartbeat checks pass (the person did their step) or `seconds` run out. */
export async function waitForHeartbeat(o, seconds, onTick = () => undefined) {
  const until = Date.now() + seconds * 1000;
  for (;;) {
    const r = await verify(o);
    const hb = r.checks.filter((c) => c.id.startsWith("heartbeat") || c.id === "chrome-wrote-folder");
    if ((hb.length && hb.every((c) => c.ok)) || Date.now() >= until) return r;
    onTick(r);
    await new Promise((res) => setTimeout(res, 3000));
  }
}

async function main() {
  const o = parseVerifyArgs(process.argv.slice(2));
  const r = o.waitHeartbeat > 0 ? await waitForHeartbeat(o, o.waitHeartbeat, () => process.stderr.write(".")) : await verify(o);
  if (o.waitHeartbeat > 0) process.stderr.write("\n");
  console.log(JSON.stringify(r, null, 2));
  process.exitCode = r.verdict === "READY" ? 0 : 1;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)) {
  main().catch((e) => {
    console.log(JSON.stringify({ verdict: "NOT_READY", error: e.stack }, null, 2));
    process.exitCode = 1;
  });
}
