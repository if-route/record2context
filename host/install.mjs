#!/usr/bin/env node
// Installs (or with --uninstall removes) record2context's native messaging host. Idempotent: run it again to repair or
// update. Usage and every file it writes: INSTALL-FOR-AI.md.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  BROWSERS,
  DEFAULT_RECORDINGS_DIR,
  LAUNCH_LOG,
  LEGACY,
  HOST_FILE,
  HOST_NAME,
  HOST_SOURCE,
  LAUNCHER_FILE,
  WINDOWS_REGISTRY,
  defaultInstallDir,
  expandHome,
  launcherScript,
  legacyInstallDir,
  manifestDir,
  manifestFile,
  repoExtensionId,
  talkToHost,
} from "./common.mjs";

export function parseInstallArgs(argv) {
  const o = { browsers: [], manifestDirs: [], uninstall: false, purge: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--recordings-dir") o.recordingsDir = next();
    else if (a === "--choose-folder") o.chooseFolder = next();
    else if (a === "--install-dir") o.installDir = next();
    else if (a === "--browser") o.browsers.push(next());
    else if (a === "--manifest-dir") o.manifestDirs.push(next());
    else if (a === "--node") o.node = next();
    else if (a === "--reveal-log") o.revealLog = next();
    else if (a === "--legacy-install-dir") o.legacyInstallDir = next();
    else if (a === "--uninstall") o.uninstall = true;
    else if (a === "--purge") o.purge = true;
    else if (a === "--json") o.json = true;
    else throw new Error(`unknown argument ${a}`);
  }
  // Test-only overrides, so the E2E runs the guide's literal commands against temp locations.
  const env = process.env;
  if (!o.installDir && env.RECORD2CONTEXT_INSTALL_DIR) o.installDir = env.RECORD2CONTEXT_INSTALL_DIR;
  if (!o.manifestDirs.length && !o.browsers.length && env.RECORD2CONTEXT_MANIFEST_DIR) o.manifestDirs.push(env.RECORD2CONTEXT_MANIFEST_DIR);
  if (!o.revealLog && env.RECORD2CONTEXT_REVEAL_LOG) o.revealLog = env.RECORD2CONTEXT_REVEAL_LOG;
  if (!o.legacyInstallDir && env.RECORD2CONTEXT_LEGACY_INSTALL_DIR) o.legacyInstallDir = env.RECORD2CONTEXT_LEGACY_INSTALL_DIR;
  if (o.browsers.includes("all")) o.browsers = [...BROWSERS];
  for (const b of o.browsers) if (!BROWSERS.includes(b)) throw new Error(`--browser must be one of ${BROWSERS.join(", ")}, all`);
  if (!o.browsers.length && !o.manifestDirs.length) o.browsers = ["chrome"];
  return o;
}

/** Writes only when the content differs, so a repeat install keeps mtimes and the last heartbeat stays fresh. */
function writeIfChanged(file, content, mode) {
  const same = fs.existsSync(file) && fs.readFileSync(file).equals(Buffer.from(content));
  if (!same) fs.writeFileSync(file, content);
  if (mode !== undefined && (fs.statSync(file).mode & 0o777) !== mode) fs.chmodSync(file, mode);
  return !same;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Every manifest location this run targets: `--manifest-dir`s as given, plus each `--browser`'s per-user folder. */
function targets(o, installDir) {
  return [...o.manifestDirs.map((dir) => ({ browser: null, dir: path.resolve(expandHome(dir)) })), ...o.browsers.map((b) => ({ browser: b, dir: manifestDir(b, installDir) }))];
}

/**
 * The qa_recorder install this one replaces. Only looked for at its default place when this install uses the default
 * dir too, so a test install (or any custom --install-dir) never reads or removes a real earlier install.
 */
function legacyDirFor(o, installDir) {
  if (o.legacyInstallDir) return path.resolve(expandHome(o.legacyInstallDir));
  if (o.installDir) return null;
  const dir = legacyInstallDir();
  return path.resolve(dir) === installDir ? null : dir;
}

function nodeVersion(node) {
  try {
    return execFileSync(node, ["--version"], { encoding: "utf8", timeout: 10000 }).trim();
  } catch {
    return null;
  }
}

/** Old host manifests (every browser folder this run targets, or all of them for a real install) and old helper files. */
function removeLegacy(o, legacyDir, installDir) {
  const removed = [];
  const rm = (f) => {
    if (fs.existsSync(f)) {
      fs.rmSync(f, { force: true });
      removed.push(f);
    }
  };
  const dirs = new Set(targets(o, installDir).map((t) => t.dir));
  if (o.browsers.length && process.platform !== "win32") for (const b of BROWSERS) dirs.add(manifestDir(b, installDir));
  if (legacyDir) dirs.add(legacyDir);
  for (const d of dirs) rm(path.join(d, `${LEGACY.hostName}.json`));
  if (process.platform === "win32" && o.browsers.length) {
    for (const b of BROWSERS) {
      try {
        execFileSync("reg", ["delete", `${WINDOWS_REGISTRY[b]}\\${LEGACY.hostName}`, "/f"], { stdio: "ignore" });
        removed.push(`${WINDOWS_REGISTRY[b]}\\${LEGACY.hostName}`);
      } catch {
        /* not registered */
      }
    }
  }
  // Known files only, never a recursive delete: a recordings folder could have been put inside the old dir.
  if (legacyDir && fs.existsSync(legacyDir)) {
    for (const f of [...LEGACY.files, "config.json", "roots.json"]) rm(path.join(legacyDir, f));
    if (!fs.readdirSync(legacyDir).length) {
      fs.rmdirSync(legacyDir);
      removed.push(legacyDir);
    }
  }
  return removed;
}

/**
 * Records the person's folder answer in config.json before anything is installed, so a later run in another shell
 * still applies it and verify can compare. `default` keeps the folder already in use, else ~/record2context-recordings.
 */
export function chooseFolder(o) {
  const installDir = path.resolve(expandHome(o.installDir ?? defaultInstallDir()));
  const configFile = path.join(installDir, "config.json");
  const raw = String(o.chooseFolder).trim();
  const chosen = raw === "default" ? "default" : expandHome(raw);
  if (chosen !== "default" && !path.isAbsolute(chosen)) throw new Error(`--choose-folder needs an absolute folder (or ~/...), or the word default; got ${JSON.stringify(raw)}`);
  const value = chosen === "default" ? "default" : path.resolve(chosen);
  const config = readJson(configFile) ?? {};
  fs.mkdirSync(installDir, { recursive: true });
  if (config.folder?.chosen !== value) writeIfChanged(configFile, `${JSON.stringify({ ...config, folder: { chosen: value, at: new Date().toISOString() } }, null, 2)}\n`);
  return { configFile, chosen: value };
}

export async function install(o) {
  const installDir = path.resolve(expandHome(o.installDir ?? defaultInstallDir()));
  const node = o.node ? path.resolve(expandHome(o.node)) : fs.realpathSync(process.execPath);
  if (!fs.existsSync(node)) throw new Error(`node not found at ${node}`);
  const extensionId = repoExtensionId();
  const origin = `chrome-extension://${extensionId}/`;
  const hostFile = path.join(installDir, HOST_FILE);
  const launcher = path.join(installDir, LAUNCHER_FILE);
  const configFile = path.join(installDir, "config.json");
  const rootsFile = path.join(installDir, "roots.json");
  const launchLog = path.join(installDir, LAUNCH_LOG);
  const legacyDir = legacyDirFor(o, installDir);
  const legacyConfig = legacyDir ? readJson(path.join(legacyDir, "config.json")) : null;
  const legacyRoots = legacyDir ? readJson(path.join(legacyDir, "roots.json"))?.roots : null;

  fs.mkdirSync(installDir, { recursive: true });
  writeIfChanged(hostFile, fs.readFileSync(HOST_SOURCE), 0o644);

  const config = readJson(configFile) ?? {};
  const chosen = typeof config.folder?.chosen === "string" && config.folder.chosen !== "default" ? config.folder.chosen : undefined;
  const fromLegacy = !o.recordingsDir && !chosen && !config.recordingsDir && typeof legacyConfig?.recordingsDir === "string";
  const recordingsDir = path.resolve(expandHome(o.recordingsDir ?? chosen ?? config.recordingsDir ?? (fromLegacy ? legacyConfig.recordingsDir : DEFAULT_RECORDINGS_DIR)));
  fs.mkdirSync(recordingsDir, { recursive: true });
  // --recordings-dir is a choice too; keep the recorded one in step so verify sees no mismatch.
  const folder = o.recordingsDir && config.folder?.chosen !== recordingsDir ? { folder: { chosen: recordingsDir, at: new Date().toISOString() } } : {};
  const nextConfig = { ...config, recordingsDir, ...folder, ...(o.revealLog ? { revealLog: path.resolve(o.revealLog) } : {}) };
  writeIfChanged(configFile, `${JSON.stringify(nextConfig, null, 2)}\n`);
  // Earlier recordings folders stay readable and deletable after the rename.
  // The old config's folder too: an install from before roots.json existed never listed it.
  const legacyDirs = [...(Array.isArray(legacyRoots) ? legacyRoots : []), ...(typeof legacyConfig?.recordingsDir === "string" ? [path.resolve(expandHome(legacyConfig.recordingsDir))] : [])];
  if (legacyDirs.length) {
    const roots = readJson(rootsFile)?.roots ?? [];
    const merged = [...new Set([...roots, ...legacyDirs.filter((r) => typeof r === "string" && path.isAbsolute(r))])];
    if (merged.length !== roots.length) writeIfChanged(rootsFile, `${JSON.stringify({ roots: merged }, null, 2)}\n`);
  }
  writeIfChanged(launcher, launcherScript({ node, host: hostFile, config: configFile, log: launchLog }), 0o755);

  const manifest = { name: HOST_NAME, description: "record2context: saves recordings to the folder in config.json", path: launcher, type: "stdio", allowed_origins: [origin] };
  const manifests = [];
  for (const t of targets(o, installDir)) {
    fs.mkdirSync(t.dir, { recursive: true });
    const file = manifestFile(t.dir);
    writeIfChanged(file, `${JSON.stringify(manifest, null, 2)}\n`);
    if (process.platform === "win32" && t.browser) execFileSync("reg", ["add", `${WINDOWS_REGISTRY[t.browser]}\\${HOST_NAME}`, "/ve", "/t", "REG_SZ", "/d", file, "/f"]);
    manifests.push(file);
  }

  let check;
  try {
    const [reply] = await talkToHost(launcher, [{ id: 1, op: "ping" }], { origin, caller: "installer" });
    check = { ok: !!reply.ok && !!reply.dirOk && reply.dir === recordingsDir, reply };
  } catch (e) {
    check = { ok: false, error: e.message };
  }
  // The old install goes only once the new one works, so a failed run can still read the old config next time.
  const legacy = {
    dir: legacyDir,
    found: !!legacyConfig || !!legacyRoots,
    recordingsDirFrom: fromLegacy ? path.join(legacyDir, "config.json") : null,
    roots: Array.isArray(legacyRoots) ? legacyRoots.length : 0,
    removed: check.ok ? removeLegacy(o, legacyDir, installDir) : [],
  };
  return {
    installed: true,
    extensionId,
    origin,
    hostName: HOST_NAME,
    installDir,
    node,
    nodeVersion: nodeVersion(node),
    hostFile,
    launcher,
    configFile,
    recordingsDir,
    statusFile: path.join(installDir, "status.json"),
    launchLog,
    manifests,
    legacy,
    check,
  };
}

/** Removes the manifests, the launcher, the host copy and its status file. Recordings are never touched; config and roots only with --purge. */
export function uninstall(o) {
  const installDir = path.resolve(expandHome(o.installDir ?? defaultInstallDir()));
  const removed = [];
  const rm = (f) => {
    if (fs.existsSync(f)) {
      fs.rmSync(f, { force: true });
      removed.push(f);
    }
  };
  for (const t of targets(o, installDir)) {
    rm(manifestFile(t.dir));
    if (process.platform === "win32" && t.browser) {
      try {
        execFileSync("reg", ["delete", `${WINDOWS_REGISTRY[t.browser]}\\${HOST_NAME}`, "/f"], { stdio: "ignore" });
      } catch {
        /* not registered */
      }
    }
  }
  for (const f of [LAUNCHER_FILE, HOST_FILE, "status.json", LAUNCH_LOG, `${LAUNCH_LOG}.1`, ...(o.purge ? ["config.json", "roots.json"] : [])]) rm(path.join(installDir, f));
  if (o.purge && fs.existsSync(installDir) && !fs.readdirSync(installDir).length) fs.rmdirSync(installDir);
  return { installed: false, installDir, removed };
}

async function main() {
  const o = parseInstallArgs(process.argv.slice(2));
  if (o.chooseFolder !== undefined) {
    const c = chooseFolder(o);
    if (o.json) console.log(JSON.stringify(c, null, 2));
    else console.log(`Folder choice recorded: ${c.chosen}\n  config  ${c.configFile}\nNow run: npm run install-host`);
    return;
  }
  const result = o.uninstall ? uninstall(o) : await install(o);
  if (o.json) console.log(JSON.stringify(result, null, 2));
  else if (o.uninstall) console.log(`Removed:\n${result.removed.map((f) => `  ${f}`).join("\n") || "  (nothing was installed)"}`);
  else {
    console.log(`record2context host installed.
  extension id     ${result.extensionId}
  recordings dir   ${result.recordingsDir}
  config           ${result.configFile}
  launcher         ${result.launcher}
  node             ${result.node} (${result.nodeVersion ?? "version unknown"}); removing this Node version stops the helper until install-host runs again
  manifest(s)      ${result.manifests.join("\n                   ")}
  status file      ${result.statusFile}
  launch log       ${result.launchLog} (Chrome's starts of the helper)${result.legacy.removed.length ? `\n  replaced old     ${result.legacy.removed.join("\n                   ")}` : ""}${result.legacy.recordingsDirFrom ? `\n  folder kept from ${result.legacy.recordingsDirFrom}` : ""}
  host self-check  ${result.check.ok ? "OK" : `FAILED: ${result.check.error ?? JSON.stringify(result.check.reply)}`}`);
  }
  if (!o.uninstall && !result.check.ok) process.exitCode = 1;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)) {
  main().catch((e) => {
    console.error(`install failed: ${e.message}`);
    process.exitCode = 1;
  });
}
