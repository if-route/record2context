#!/usr/bin/env node
// record2context's native messaging host: Chrome starts it through the installer's launcher, and it writes recordings only
// into `recordingsDir` from its config. Node built-ins only, because the installer copies this one file.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HOST_VERSION = "1.1.0";
export const PROTOCOL = 1;
/** Largest raw chunk `read` returns: base64 + JSON must stay under Chrome's 1 MB host-to-extension limit. */
export const MAX_READ = 512 * 1024;
export const PART_SUFFIX = ".r2c-part";
const SELFTEST_PREFIX = ".record2context-selftest-";

/** A recording folder holds its report here (details/ since 1.1.0, the folder itself before). */
export const REPORT_PATHS = ["details/report.json", "report.json"];

/** @param {string} dir */
export function hasReport(dir) {
  return REPORT_PATHS.some((p) => fs.existsSync(path.join(dir, p)));
}

export class HostError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ── Framing: 4-byte little-endian length, then UTF-8 JSON ────────────────────

/** @param {unknown} msg */
export function encodeMessage(msg) {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

/** Splits a byte stream into messages, whatever the chunk boundaries. */
export class MessageReader {
  constructor() {
    this.buf = Buffer.alloc(0);
  }
  /** @param {Buffer} chunk @returns {unknown[]} */
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    while (this.buf.length >= 4) {
      const n = this.buf.readUInt32LE(0);
      if (this.buf.length < 4 + n) break;
      out.push(JSON.parse(this.buf.subarray(4, 4 + n).toString("utf8")));
      this.buf = this.buf.subarray(4 + n);
    }
    return out;
  }
}

// ── Config ─────────────────────────────────────────────────────────────────

/** @param {string} p */
export function expandHome(p) {
  return p === "~" ? os.homedir() : p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

/**
 * @param {string} configFile
 * @returns {{ recordingsDir: string, statusFile: string, revealLog?: string }}
 */
export function loadConfig(configFile) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configFile, "utf8"));
  } catch (e) {
    throw new HostError("config", `cannot read config ${configFile}: ${/** @type {Error} */ (e).message}`);
  }
  const dir = typeof raw.recordingsDir === "string" ? expandHome(raw.recordingsDir.trim()) : "";
  if (!dir || !path.isAbsolute(dir)) throw new HostError("config", `recordingsDir in ${configFile} must be an absolute path (or start with ~/)`);
  return {
    recordingsDir: path.resolve(dir),
    statusFile: typeof raw.statusFile === "string" ? expandHome(raw.statusFile) : path.join(path.dirname(configFile), "status.json"),
    ...(typeof raw.revealLog === "string" ? { revealLog: expandHome(raw.revealLog) } : {}),
  };
}

// ── Path safety ────────────────────────────────────────────────────────────

/** @param {unknown} name */
function checkComponent(name, what) {
  if (typeof name !== "string" || !name || name === "." || name === ".." || /[/\\\0]/.test(name) || name.length > 255) {
    throw new HostError("path", `bad ${what}: ${JSON.stringify(name)}`);
  }
  return name;
}

/** A session is one folder name directly in the recordings folder. */
export function checkSession(session) {
  return checkComponent(session, "session");
}

/** A file inside a session: `a/b.png`, never absolute, never `..`. Returns its components. */
export function checkRelPath(rel) {
  if (typeof rel !== "string" || !rel || rel.startsWith("/")) throw new HostError("path", `bad path: ${JSON.stringify(rel)}`);
  const parts = rel.split("/");
  for (const p of parts) checkComponent(p, "path");
  if (parts.at(-1).endsWith(PART_SUFFIX)) throw new HostError("path", `bad path: ${JSON.stringify(rel)}`);
  return parts;
}

/** @param {string} child @param {string} root */
function isInside(child, root) {
  const rel = path.relative(root, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Throws unless the existing directory `dir` really (after symlinks) lies inside the recordings folder. */
function assertRealInside(dir, root) {
  const realRoot = fs.realpathSync(root);
  const real = fs.realpathSync(dir);
  if (!isInside(real, realRoot)) throw new HostError("path", `${dir} resolves outside the recordings folder`);
}

function isLink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Same folder, after symlinks when both exist (macOS /tmp vs /private/tmp). */
function samePath(a, b) {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

// ── Host ───────────────────────────────────────────────────────────────────

/**
 * The request handler; `main()` wires it to stdio. `origin` is what Chrome passed (chrome-extension://<id>/).
 * @param {{ configFile: string, origin?: string, now?: () => Date, run?: (cmd: string, args: string[]) => void }} opts
 */
export function createHost({ configFile, origin = "", now = () => new Date(), run = defaultRun }) {
  const config = () => loadConfig(configFile);

  // Every recordings folder this helper has written to, so recordings left in an earlier one can still be read and deleted.
  const rootsFile = path.join(path.dirname(configFile), "roots.json");

  function knownRoots() {
    try {
      const roots = JSON.parse(fs.readFileSync(rootsFile, "utf8")).roots;
      return Array.isArray(roots) ? roots.filter((r) => typeof r === "string" && path.isAbsolute(r)) : [];
    } catch {
      return [];
    }
  }

  function rememberRoot(dir) {
    const roots = knownRoots();
    if (roots.includes(dir)) return;
    try {
      fs.writeFileSync(`${rootsFile}.tmp`, `${JSON.stringify({ roots: [...roots, dir] }, null, 2)}\n`);
      fs.renameSync(`${rootsFile}.tmp`, rootsFile);
    } catch {
      /* only costs the ability to delete in that folder later */
    }
  }

  /** Recordings folder from the config, created when missing (the config is the source of truth). Writes go only here. */
  function root() {
    const { recordingsDir } = config();
    fs.mkdirSync(recordingsDir, { recursive: true });
    rememberRoot(recordingsDir);
    return recordingsDir;
  }

  function sessionDir(session, create) {
    const r = root();
    const dir = path.join(r, checkSession(session));
    if (create && !fs.existsSync(dir)) fs.mkdirSync(dir);
    if (fs.existsSync(dir)) assertRealInside(dir, r);
    return dir;
  }

  /**
   * For reading and deleting: the session folder at `msg.dir` (where the extension recorded it, maybe an earlier
   * recordings folder) or in the current one. `msg.dir` must sit directly in a folder this helper has used.
   */
  function existingSessionDir(msg) {
    const session = checkSession(msg.session);
    if (msg.dir === undefined) return sessionDir(session, false);
    if (typeof msg.dir !== "string" || !path.isAbsolute(msg.dir)) throw new HostError("path", `bad dir: ${JSON.stringify(msg.dir)}`);
    const dir = path.resolve(msg.dir);
    if (path.basename(dir) !== session) throw new HostError("path", `${dir} is not the folder of ${session}`);
    const parent = path.dirname(dir);
    const roots = [root(), ...knownRoots()];
    if (!roots.some((r) => samePath(r, parent))) throw new HostError("unknown-root", `${parent} is not a recordings folder this helper has used`);
    if (fs.existsSync(dir)) assertRealInside(dir, parent);
    // A recordings folder nested in an earlier one must never be read or deleted as if it were a session.
    const real = (p) => (fs.existsSync(p) ? fs.realpathSync(p) : path.resolve(p));
    if (roots.some((r) => isInside(real(r), real(dir)))) throw new HostError("path", `${dir} is or holds a recordings folder`);
    return dir;
  }

  /** Absolute target of `rel` inside the session folder `dir` (which lies in `base`); parents created one level at a time. */
  function target(dir, base, rel, create) {
    const parts = checkRelPath(rel);
    let parent = dir;
    for (const part of parts.slice(0, -1)) {
      parent = path.join(parent, part);
      if (create && !fs.existsSync(parent)) fs.mkdirSync(parent);
      if (fs.existsSync(parent)) assertRealInside(parent, base);
    }
    const file = path.join(parent, parts.at(-1));
    if (isLink(file)) throw new HostError("path", `${rel} is a symlink`);
    return file;
  }

  function readStatus() {
    try {
      return JSON.parse(fs.readFileSync(config().statusFile, "utf8"));
    } catch {
      return {};
    }
  }

  function writeStatus(patch) {
    let statusFile;
    try {
      statusFile = config().statusFile;
    } catch {
      return;
    }
    const next = { ...readStatus(), ...patch, hostVersion: HOST_VERSION, configFile, updatedAt: now().toISOString() };
    try {
      fs.mkdirSync(path.dirname(statusFile), { recursive: true });
      fs.writeFileSync(`${statusFile}.tmp`, `${JSON.stringify(next, null, 2)}\n`);
      fs.renameSync(`${statusFile}.tmp`, statusFile);
    } catch {
      /* the status file is a diagnostic; never fail a request over it */
    }
  }

  /** Writes, reads back and deletes a probe file in the recordings folder. */
  function selftest() {
    const at = now().toISOString();
    let dir = "";
    try {
      dir = root();
      const probe = path.join(dir, `${SELFTEST_PREFIX}${randomBytes(6).toString("hex")}`);
      const token = randomBytes(16).toString("hex");
      fs.writeFileSync(probe, token);
      const back = fs.readFileSync(probe, "utf8");
      fs.unlinkSync(probe);
      if (back !== token) throw new Error("the probe file read back differently");
      return { at, ok: true, dir };
    } catch (e) {
      return { at, ok: false, dir, error: /** @type {Error} */ (e).message };
    }
  }

  const ops = {
    ping(msg) {
      let dir = "";
      let dirError;
      try {
        dir = config().recordingsDir;
      } catch (e) {
        dirError = /** @type {Error} */ (e).message;
      }
      const test = selftest();
      if (!dirError && !test.ok) dirError = test.error;
      if (msg.heartbeat && typeof msg.heartbeat === "object") {
        const hb = msg.heartbeat;
        writeStatus({
          lastHeartbeat: {
            at: now().toISOString(),
            hostVersion: HOST_VERSION,
            origin,
            extensionId: String(hb.extensionId ?? ""),
            extensionVersion: String(hb.extensionVersion ?? ""),
            buildId: String(hb.buildId ?? ""),
            reason: String(hb.reason ?? ""),
          },
          selfTest: test,
        });
      }
      let statusFile = "";
      try {
        statusFile = config().statusFile;
      } catch {
        /* reported through dirError */
      }
      return { hostVersion: HOST_VERSION, protocol: PROTOCOL, dir, dirOk: !dirError, ...(dirError ? { dirError } : {}), configFile, statusFile, platform: process.platform };
    },

    write(msg) {
      const file = target(sessionDir(msg.session, true), root(), msg.path, true);
      const part = file + PART_SUFFIX;
      if (isLink(part)) throw new HostError("path", `${msg.path}${PART_SUFFIX} is a symlink`);
      const offset = Number(msg.offset ?? 0);
      if (!Number.isSafeInteger(offset) || offset < 0) throw new HostError("offset", `bad offset ${msg.offset}`);
      if (offset === 0) fs.writeFileSync(part, "");
      const have = fs.existsSync(part) ? fs.statSync(part).size : -1;
      if (have !== offset) throw new HostError("offset", `offset ${offset} does not match the ${have < 0 ? "missing" : `${have}-byte`} partial file`);
      const data = typeof msg.data === "string" ? Buffer.from(msg.data, "base64") : Buffer.alloc(0);
      if (data.length) fs.appendFileSync(part, data);
      const size = offset + data.length;
      if (msg.done) fs.renameSync(part, file);
      return { size, ...(msg.done ? { file } : {}) };
    },

    finish(msg) {
      const dir = sessionDir(msg.session, false);
      const files = Array.isArray(msg.files) ? msg.files : [];
      const missing = files.filter((f) => !fs.existsSync(target(dir, root(), f, false)));
      if (missing.length) throw new HostError("missing", `not written: ${missing.join(", ")}`);
      writeStatus({ lastSave: { at: now().toISOString(), session: msg.session, dir, files: files.length } });
      return { dir };
    },

    list(msg) {
      const r = root();
      if (msg.session === undefined) {
        const sessions = fs
          .readdirSync(r, { withFileTypes: true })
          .filter((d) => d.isDirectory() && hasReport(path.join(r, d.name)))
          .map((d) => d.name)
          .sort();
        return { dir: r, sessions };
      }
      const dir = existingSessionDir(msg);
      if (!fs.existsSync(dir)) return { dir, exists: false, files: [] };
      const files = [];
      const walk = (abs, prefix) => {
        for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
          if (e.isDirectory()) walk(path.join(abs, e.name), `${prefix}${e.name}/`);
          else if (e.isFile() && !e.name.endsWith(PART_SUFFIX)) files.push({ path: prefix + e.name, size: fs.statSync(path.join(abs, e.name)).size });
        }
      };
      walk(dir, "");
      files.sort((a, b) => (a.path < b.path ? -1 : 1));
      return { dir, exists: true, files };
    },

    /** For each recorded session folder (`dirs`): does it still hold a report.json (either layout)? Folders the helper never used are `refused`. */
    exists(msg) {
      const found = {};
      const refused = {};
      for (const dir of Array.isArray(msg.dirs) ? msg.dirs : []) {
        try {
          const d = existingSessionDir({ session: path.basename(String(dir)), dir });
          found[dir] = hasReport(d);
        } catch (e) {
          refused[dir] = /** @type {Error} */ (e).message;
        }
      }
      return { found, refused };
    },

    read(msg) {
      const dir = existingSessionDir(msg);
      const file = target(dir, path.dirname(dir), msg.path, false);
      if (!fs.existsSync(file)) throw new HostError("not-found", `${msg.session}/${msg.path} not found`);
      const size = fs.statSync(file).size;
      const offset = Math.max(0, Number(msg.offset ?? 0));
      const length = Math.min(MAX_READ, Math.max(0, Number(msg.length ?? MAX_READ)), Math.max(0, size - offset));
      const buf = Buffer.alloc(length);
      const fd = fs.openSync(file, "r");
      try {
        fs.readSync(fd, buf, 0, length, offset);
      } finally {
        fs.closeSync(fd);
      }
      return { size, offset, data: buf.toString("base64"), eof: offset + length >= size };
    },

    delete(msg) {
      const dir = existingSessionDir(msg);
      const existed = fs.existsSync(dir);
      if (existed) fs.rmSync(dir, { recursive: true, force: true });
      return { dir, existed };
    },

    reveal(msg) {
      const r = root();
      const where = msg.session === undefined ? r : existingSessionDir(msg);
      if (!fs.existsSync(where)) throw new HostError("not-found", `${where} does not exist`);
      const { revealLog } = config();
      if (revealLog) fs.appendFileSync(revealLog, `${where}\n`);
      else if (process.platform === "darwin") run("/usr/bin/open", [where]);
      else if (process.platform === "win32") run("explorer.exe", [where]);
      else run("xdg-open", [where]);
      return { path: where };
    },

    selftest() {
      const test = selftest();
      writeStatus({ selfTest: test });
      if (!test.ok) throw new HostError("selftest", test.error);
      return test;
    },
  };

  /** @param {any} msg */
  return async function handle(msg) {
    const id = msg?.id;
    const op = msg?.op;
    if (typeof op !== "string" || !Object.hasOwn(ops, op)) return { id, ok: false, code: "op", error: `unknown op ${JSON.stringify(op)}` };
    try {
      return { id, ok: true, ...(await ops[op](msg)) };
    } catch (e) {
      const err = /** @type {HostError} */ (e);
      return { id, ok: false, code: err.code ?? "io", error: err.message };
    }
  };
}

function defaultRun(cmd, args) {
  spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
}

/** `--config <file>` and the origin Chrome passes as the first argument. */
export function parseArgs(argv) {
  let configFile = "";
  let origin = "";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--config") configFile = argv[++i] ?? "";
    else if (argv[i].startsWith("chrome-extension://")) origin = argv[i];
  }
  return { configFile: configFile || path.join(path.dirname(fileURLToPath(import.meta.url)), "config.json"), origin };
}

function main() {
  const { configFile, origin } = parseArgs(process.argv.slice(2));
  const handle = createHost({ configFile, origin });
  const reader = new MessageReader();
  let chain = Promise.resolve();
  process.stdin.on("data", (chunk) => {
    for (const msg of reader.push(chunk)) {
      chain = chain.then(async () => {
        process.stdout.write(encodeMessage(await handle(msg)));
      });
    }
  });
  process.stdin.on("end", () => void chain.then(() => process.exit(0)));
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) main();
