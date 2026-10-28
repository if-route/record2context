// Shared by the installer, the verifier and the E2E tests: names, default locations and the extension id.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MessageReader, encodeMessage, expandHome, hasReport } from "./record2context-host.mjs";

export { expandHome, hasReport };

export const HOST_NAME = "com.record2context.host";
export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const HOST_SOURCE = path.join(REPO, "host", "record2context-host.mjs");
export const HOST_FILE = "record2context-host.mjs";
export const LAUNCHER_FILE = process.platform === "win32" ? "record2context-host.cmd" : "record2context-host";
/** Roughly what macOS launchd gives an app started from the Dock: no shell profile, no nvm. */
export const MINIMAL_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/** Chrome's id for an extension with this manifest `key`: sha256 of the DER public key, first 32 hex digits as a-p. */
export function extensionIdFromKey(key) {
  const hex = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

export function repoExtensionId(manifestFile = path.join(REPO, "static", "manifest.json")) {
  return extensionIdFromKey(JSON.parse(fs.readFileSync(manifestFile, "utf8")).key);
}

export function hostSourceVersion() {
  return /HOST_VERSION = "([^"]+)"/.exec(fs.readFileSync(HOST_SOURCE, "utf8"))[1];
}

export function defaultInstallDir() {
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "record2context");
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "record2context");
  return path.join(home, ".local", "share", "record2context");
}

// Directly in home: macOS asks no privacy question for it. Not ~/record2context, where people clone this repo.
export const DEFAULT_RECORDINGS_DIR = path.join(os.homedir(), "record2context-recordings");

/** The project's earlier name: the installer removes this install and carries its config and roots over. */
export const LEGACY = {
  hostName: "com.qa_recorder.host",
  files: ["qa-recorder-host", "qa-recorder-host.cmd", "qa-recorder-host.mjs", "status.json", "status.json.tmp", "roots.json.tmp"],
};

export function legacyInstallDir() {
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "QA Recorder");
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "QA Recorder");
  return path.join(home, ".local", "share", "qa-recorder");
}

/** Chrome's starts of the helper and node's stderr, next to config.json; read by verify-install. */
export const LAUNCH_LOG = "launch.log";
export const LAUNCH_LOG_MAX = 256 * 1024;
/** Set by the installer, the verifier and the guide's manual check, so only Chrome's starts are logged. */
export const CALLER_ENV = "R2C_CALLER";

/** Per-user user-data dirs: their `NativeMessagingHosts` subfolder is where Chrome looks (macOS, Linux). */
const USER_DATA = {
  darwin: {
    chrome: "Library/Application Support/Google/Chrome",
    chromium: "Library/Application Support/Chromium",
    edge: "Library/Application Support/Microsoft Edge",
    brave: "Library/Application Support/BraveSoftware/Brave-Browser",
  },
  linux: {
    chrome: ".config/google-chrome",
    chromium: ".config/chromium",
    edge: ".config/microsoft-edge",
    brave: ".config/BraveSoftware/Brave-Browser",
  },
};

/** Windows registry keys (HKCU) whose default value is the manifest's path. */
export const WINDOWS_REGISTRY = {
  chrome: "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts",
  chromium: "HKCU\\Software\\Chromium\\NativeMessagingHosts",
  edge: "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts",
  brave: "HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts",
};

export const BROWSERS = ["chrome", "chromium", "edge", "brave"];

/** Where the host manifest goes for `browser`; on Windows the manifest sits in the install dir and the registry points at it. */
export function manifestDir(browser, installDir = defaultInstallDir()) {
  if (process.platform === "win32") return installDir;
  const rel = USER_DATA[process.platform === "darwin" ? "darwin" : "linux"][browser];
  if (!rel) throw new Error(`unknown browser ${browser}`);
  return path.join(os.homedir(), rel, "NativeMessagingHosts");
}

export function manifestFile(dir) {
  return path.join(dir, `${HOST_NAME}.json`);
}

/** The launcher Chrome runs: absolute paths only, so it works with Chrome's minimal environment. */
export function launcherScript({ node, host, config, log }) {
  if (process.platform === "win32") {
    const run = `"${node}" "${host}" --config "${config}" %*`;
    return `@echo off\r\nif not "%${CALLER_ENV}%"=="" goto tool\r\necho %DATE% %TIME% launch origin=%1>>"${log}"\r\n${run} 2>>"${log}"\r\nexit /b %ERRORLEVEL%\r\n:tool\r\n${run}\r\n`;
  }
  const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
  const run = `exec ${q(node)} ${q(host)} --config ${q(config)} "$@"`;
  // A log that cannot be written must never stop the helper: exec only redirects once the append worked.
  return `#!/bin/sh
# record2context native messaging host launcher (written by host/install.mjs).
# A start without ${CALLER_ENV} is Chrome's: logged with node's stderr for npm run verify-install.
if [ -z "$${CALLER_ENV}" ]; then
  log=${q(log)}
  size=$(/usr/bin/wc -c 2>/dev/null < "$log")
  if [ \${size:-0} -gt ${LAUNCH_LOG_MAX} ]; then /bin/mv -f "$log" "$log.1" 2>/dev/null; fi
  if { echo "$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ) launch origin=$1" >> "$log"; } 2>/dev/null; then
    ${run} 2>> "$log"
  fi
fi
${run}
`;
}

/** Reads node, host and config paths back out of a launcher written by `launcherScript`. */
export function parseLauncher(text) {
  const unq = (s) => s.replace(/^'|'$/g, "").replace(/'\\''/g, "'");
  const m = process.platform === "win32" ? /"([^"]+)" "([^"]+)" --config "([^"]+)"/.exec(text) : /exec ('(?:[^']|'\\'')*') ('(?:[^']|'\\'')*') --config ('(?:[^']|'\\'')*')/.exec(text);
  if (!m) return null;
  return { node: unq(m[1]), host: unq(m[2]), config: unq(m[3]) };
}

/**
 * Starts the launcher like Chrome does (origin as the argument, a minimal environment), sends `messages` in order and
 * returns the replies. Rejects when it exits early or takes longer than `timeoutMs`.
 * @param {string} launcher @param {object[]} messages
 * @param {{ origin?: string, env?: Record<string, string>, timeoutMs?: number, caller?: string }} [opts]
 */
export function talkToHost(launcher, messages, { origin, env, timeoutMs = 15000, caller = "tool" } = {}) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...(env ?? { HOME: os.homedir(), USER: os.userInfo().username, TMPDIR: os.tmpdir(), PATH: MINIMAL_PATH }), ...(caller ? { [CALLER_ENV]: caller } : {}) };
    const child = spawn(launcher, origin ? [origin] : [], { env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
    const reader = new MessageReader();
    const replies = [];
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`no reply within ${timeoutMs} ms; stderr: ${stderr.trim()}`));
    }, timeoutMs);
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (replies.length < messages.length) reject(new Error(`host exited (code ${code}) after ${replies.length}/${messages.length} replies; stderr: ${stderr.trim()}`));
    });
    child.stdout.on("data", (chunk) => {
      replies.push(...reader.push(chunk));
      if (replies.length >= messages.length) {
        clearTimeout(timer);
        child.stdin.end();
        resolve(replies);
      }
    });
    for (const m of messages) child.stdin.write(encodeMessage(m));
  });
}
