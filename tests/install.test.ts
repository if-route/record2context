import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REPO as REPO_ROOT, HOST_NAME as COMMON_HOST_NAME, extensionIdFromKey, parseLauncher, repoExtensionId, talkToHost } from "../host/common.mjs";
import { chooseFolder, install, parseInstallArgs, uninstall } from "../host/install.mjs";
import { HOST_NAME } from "../src/shared/host";

let tmp: string;
let o: ReturnType<typeof parseInstallArgs>;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "r2c-install-"));
  o = parseInstallArgs(["--install-dir", path.join(tmp, "record2context"), "--manifest-dir", path.join(tmp, "profile", "NativeMessagingHosts"), "--recordings-dir", path.join(tmp, "rec ทดสอบ")]);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("extension id", () => {
  it("comes from the manifest key, the same way Chrome derives it", () => {
    // Pinned because every host manifest's allowed_origins names it; e2e/host.e2e.mjs checks Chrome gives dist/ this id.
    expect(repoExtensionId()).toBe("cmjkjjacbelgggcnknblelhepfmahgon");
    expect(extensionIdFromKey(Buffer.from("x").toString("base64"))).toMatch(/^[a-p]{32}$/);
  });

  it("the extension and the installer use the same host name", () => {
    expect(HOST_NAME).toBe(COMMON_HOST_NAME);
  });
});

describe("installer", () => {
  it("writes the host, the launcher, the config and the manifest, and the host answers under a minimal environment", async () => {
    const r = await install(o);
    const id = repoExtensionId();
    const manifest = JSON.parse(fs.readFileSync(path.join(tmp, "profile", "NativeMessagingHosts", `${HOST_NAME}.json`), "utf8"));
    expect(manifest).toEqual({ name: HOST_NAME, description: expect.any(String), path: r.launcher, type: "stdio", allowed_origins: [`chrome-extension://${id}/`] });
    expect(fs.statSync(r.launcher).mode & 0o111).not.toBe(0);
    expect(parseLauncher(fs.readFileSync(r.launcher, "utf8"))).toEqual({ node: fs.realpathSync(process.execPath), host: r.hostFile, config: r.configFile });
    expect(JSON.parse(fs.readFileSync(r.configFile, "utf8"))).toEqual({ recordingsDir: path.join(tmp, "rec ทดสอบ"), folder: { chosen: path.join(tmp, "rec ทดสอบ"), at: expect.any(String) } });
    expect(fs.statSync(path.join(tmp, "rec ทดสอบ")).isDirectory()).toBe(true);
    expect(r.check).toMatchObject({ ok: true, reply: { dir: path.join(tmp, "rec ทดสอบ"), dirOk: true } });
    const [pong] = await talkToHost(r.launcher, [{ id: 1, op: "ping" }], { origin: `chrome-extension://${id}/`, env: { PATH: "/usr/bin:/bin" } });
    expect(pong).toMatchObject({ id: 1, ok: true, hostVersion: "1.1.0" });
  });

  it("is idempotent and keeps the folder (and other keys) from the config when run again without --recordings-dir", async () => {
    const first = await install(o);
    const cfg = JSON.parse(fs.readFileSync(first.configFile, "utf8"));
    fs.writeFileSync(first.configFile, JSON.stringify({ ...cfg, note: "kept" }));
    const again = await install(parseInstallArgs(["--install-dir", path.join(tmp, "record2context"), "--manifest-dir", path.join(tmp, "profile", "NativeMessagingHosts")]));
    expect(JSON.parse(fs.readFileSync(again.configFile, "utf8"))).toMatchObject({ recordingsDir: path.join(tmp, "rec ทดสอบ"), note: "kept", folder: { chosen: path.join(tmp, "rec ทดสอบ") } });
    expect(again.manifests).toEqual(first.manifests);
    expect(again.check.ok).toBe(true);
  });

  it("a repeat install with nothing new leaves every file's mtime alone (the last heartbeat stays fresh)", async () => {
    const r = await install(o);
    const files = [r.hostFile, r.launcher, r.configFile, r.manifests[0]!];
    const old = new Date("2026-01-01T00:00:00Z");
    for (const f of files) fs.utimesSync(f, old, old);
    await install(o);
    expect(files.map((f) => fs.statSync(f).mtimeMs)).toEqual(files.map(() => old.getTime()));
  });

  it("--recordings-dir on a later run moves the folder", async () => {
    await install(o);
    const r = await install({ ...o, recordingsDir: path.join(tmp, "elsewhere") });
    expect(r.check.reply.dir).toBe(path.join(tmp, "elsewhere"));
  });

  it("the self-check fails loudly when node is not where the launcher says", async () => {
    const fake = path.join(tmp, "node-gone");
    fs.writeFileSync(fake, "#!/bin/sh\nexit 3\n", { mode: 0o755 });
    const r = await install({ ...o, node: fake });
    expect(r.check.ok).toBe(false);
  });

  it("uninstall removes the manifest and the host files, never the recordings, and the config only with --purge", async () => {
    const r = await install(o);
    fs.writeFileSync(path.join(r.recordingsDir, "keep.txt"), "x");
    const u = uninstall(o);
    expect(u.removed).toEqual(expect.arrayContaining([r.manifests[0], r.launcher, r.hostFile]));
    expect(fs.existsSync(r.manifests[0]!)).toBe(false);
    expect(fs.existsSync(r.configFile)).toBe(true);
    expect(fs.readFileSync(path.join(r.recordingsDir, "keep.txt"), "utf8")).toBe("x");
    uninstall({ ...o, purge: true });
    expect(fs.existsSync(r.installDir)).toBe(false);
  });

  it("rejects unknown arguments and browsers", () => {
    expect(() => parseInstallArgs(["--nope"])).toThrow(/unknown argument/);
    expect(() => parseInstallArgs(["--browser", "safari"])).toThrow(/--browser/);
    expect(parseInstallArgs([]).browsers).toEqual(["chrome"]);
    expect(parseInstallArgs(["--browser", "all"]).browsers).toEqual(["chrome", "chromium", "edge", "brave"]);
  });
});

describe("upgrade from the qa_recorder install (the project's earlier name)", () => {
  const legacyDir = () => path.join(tmp, "QA Recorder");
  const nmh = () => path.join(tmp, "profile", "NativeMessagingHosts");
  function oldInstall() {
    fs.mkdirSync(legacyDir(), { recursive: true });
    fs.mkdirSync(nmh(), { recursive: true });
    const oldRec = path.join(tmp, "old recordings");
    fs.mkdirSync(path.join(oldRec, "2026-10-28_150000_app"), { recursive: true });
    fs.writeFileSync(path.join(oldRec, "2026-10-28_150000_app", "report.json"), "{}");
    fs.writeFileSync(path.join(legacyDir(), "config.json"), JSON.stringify({ recordingsDir: oldRec }));
    fs.writeFileSync(path.join(legacyDir(), "roots.json"), JSON.stringify({ roots: [path.join(tmp, "older"), oldRec] }));
    for (const f of ["qa-recorder-host", "qa-recorder-host.mjs", "status.json"]) fs.writeFileSync(path.join(legacyDir(), f), "old");
    fs.writeFileSync(path.join(nmh(), "com.qa_recorder.host.json"), JSON.stringify({ name: "com.qa_recorder.host" }));
    return oldRec;
  }
  const args = (...extra: string[]) => parseInstallArgs(["--install-dir", path.join(tmp, "record2context"), "--manifest-dir", nmh(), "--legacy-install-dir", legacyDir(), ...extra]);

  it("keeps the recordings folder and the roots, removes the old manifest and helper files, never a recording", async () => {
    const oldRec = oldInstall();
    const r = await install(args());
    expect(r.check.ok).toBe(true);
    expect(r.recordingsDir).toBe(oldRec);
    expect(r.legacy.recordingsDirFrom).toBe(path.join(legacyDir(), "config.json"));
    expect(JSON.parse(fs.readFileSync(path.join(r.installDir, "roots.json"), "utf8")).roots).toEqual(expect.arrayContaining([path.join(tmp, "older"), oldRec]));
    expect(fs.existsSync(path.join(nmh(), "com.qa_recorder.host.json"))).toBe(false);
    expect(fs.existsSync(path.join(nmh(), `${HOST_NAME}.json`))).toBe(true);
    expect(fs.existsSync(legacyDir())).toBe(false);
    expect(fs.readFileSync(path.join(oldRec, "2026-10-28_150000_app", "report.json"), "utf8")).toBe("{}");
  });

  it("removes only the files it knows from the old folder and keeps the folder when anything else is in it", async () => {
    oldInstall();
    fs.mkdirSync(path.join(legacyDir(), "recordings", "s1"), { recursive: true });
    fs.writeFileSync(path.join(legacyDir(), "recordings", "s1", "report.json"), "{}");
    const r = await install(args());
    expect(r.legacy.removed).toEqual(expect.arrayContaining([path.join(legacyDir(), "qa-recorder-host"), path.join(legacyDir(), "config.json")]));
    expect(fs.readFileSync(path.join(legacyDir(), "recordings", "s1", "report.json"), "utf8")).toBe("{}");
  });

  it("--recordings-dir wins over the old config", async () => {
    oldInstall();
    const r = await install(args("--recordings-dir", path.join(tmp, "new rec")));
    expect(r.recordingsDir).toBe(path.join(tmp, "new rec"));
  });

  it("leaves the old install alone while the new one fails its self-check, so the next run can still migrate", async () => {
    oldInstall();
    const fake = path.join(tmp, "node-gone");
    fs.writeFileSync(fake, "#!/bin/sh\nexit 3\n", { mode: 0o755 });
    const r = await install({ ...args(), node: fake });
    expect(r.check.ok).toBe(false);
    expect(r.legacy.removed).toEqual([]);
    expect(fs.existsSync(path.join(legacyDir(), "config.json"))).toBe(true);
    expect(fs.existsSync(path.join(nmh(), "com.qa_recorder.host.json"))).toBe(true);
  });

  it("an old install without roots.json: its folder still counts as a recordings folder after moving to a new one (review-3 F5)", async () => {
    fs.mkdirSync(legacyDir(), { recursive: true });
    const oldRec = path.join(tmp, "old recs");
    fs.mkdirSync(path.join(oldRec, "s1"), { recursive: true });
    fs.writeFileSync(path.join(oldRec, "s1", "report.json"), "{}");
    fs.writeFileSync(path.join(legacyDir(), "config.json"), JSON.stringify({ recordingsDir: oldRec }));
    const r = await install(args("--recordings-dir", path.join(tmp, "new recs")));
    expect(r.recordingsDir).toBe(path.join(tmp, "new recs"));
    expect(JSON.parse(fs.readFileSync(path.join(r.installDir, "roots.json"), "utf8")).roots).toContain(oldRec);
    const [reply] = await talkToHost(r.launcher, [{ id: 1, op: "exists", dirs: [path.join(oldRec, "s1")] }], { origin: `chrome-extension://${repoExtensionId()}/` });
    expect(reply.found[path.join(oldRec, "s1")]).toBe(true);
  });

  it("a custom --install-dir (every test install) never looks at the real earlier install", async () => {
    const r = await install(o);
    expect(r.legacy).toMatchObject({ dir: null, found: false, removed: [] });
  });
});

describe("launch log (Chrome's starts of the helper)", () => {
  const origin = () => `chrome-extension://${repoExtensionId()}/`;
  const chromeStart = (launcher: string) => talkToHost(launcher, [{ id: 1, op: "ping" }], { origin: origin(), caller: null as unknown as string });

  it("logs a start without the caller marker (Chrome's) with its origin, and none by the installer or other tools", async () => {
    const r = await install(o);
    expect(fs.existsSync(r.launchLog)).toBe(false);
    await talkToHost(r.launcher, [{ id: 1, op: "ping" }], { origin: origin() });
    expect(fs.existsSync(r.launchLog)).toBe(false);
    await chromeStart(r.launcher);
    expect(fs.readFileSync(r.launchLog, "utf8")).toMatch(new RegExp(`^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ launch origin=${origin()}\\n$`));
  });

  it("appends node's stderr after the start line", async () => {
    const fake = path.join(tmp, "bad-node");
    fs.writeFileSync(fake, "#!/bin/sh\necho 'helper exploded' >&2\nexit 3\n", { mode: 0o755 });
    const r = await install({ ...o, node: fake });
    await chromeStart(r.launcher).catch(() => undefined);
    expect(fs.readFileSync(r.launchLog, "utf8")).toMatch(/launch origin=chrome-extension:\/\/[a-p]{32}\/\nhelper exploded\n$/);
  });

  it("rotates the log above its size cap", async () => {
    const r = await install(o);
    fs.writeFileSync(r.launchLog, "x".repeat(300 * 1024));
    await chromeStart(r.launcher);
    expect(fs.statSync(`${r.launchLog}.1`).size).toBe(300 * 1024);
    expect(fs.readFileSync(r.launchLog, "utf8")).toMatch(/^\S+ launch origin=/);
  });

  it("a log that cannot be written never stops the helper", async () => {
    const r = await install(o);
    fs.mkdirSync(r.launchLog);
    const [pong] = await chromeStart(r.launcher);
    expect(pong).toMatchObject({ ok: true, dirOk: true });
  });
});

describe("the person's folder choice survives separate commands (review-3 F4)", () => {
  const base = () => ["--install-dir", path.join(tmp, "record2context"), "--manifest-dir", path.join(tmp, "nmh")];

  it("--choose-folder records it; a later plain install-host applies it", async () => {
    const chosen = path.join(tmp, "My recordings ทดสอบ");
    expect(chooseFolder(parseInstallArgs([...base(), "--choose-folder", chosen])).chosen).toBe(chosen);
    expect(fs.existsSync(chosen)).toBe(false);
    const r = await install(parseInstallArgs(base()));
    expect(r.recordingsDir).toBe(chosen);
    expect(r.check.ok).toBe(true);
  });

  it("default keeps the folder already configured", async () => {
    await install(parseInstallArgs([...base(), "--recordings-dir", path.join(tmp, "existing")]));
    chooseFolder(parseInstallArgs([...base(), "--choose-folder", "default"]));
    expect((await install(parseInstallArgs(base()))).recordingsDir).toBe(path.join(tmp, "existing"));
  });

  it("refuses a relative folder, which would land inside the repo", () => {
    expect(() => chooseFolder(parseInstallArgs([...base(), "--choose-folder", "My recordings"]))).toThrow(/absolute/);
  });

  it("the command line records the choice and installs nothing", () => {
    const out = execFileSync("node", [path.join(REPO_ROOT, "host", "install.mjs"), ...base(), "--choose-folder", path.join(tmp, "x y")], { encoding: "utf8" });
    expect(out).toMatch(/Folder choice recorded: .*x y/);
    expect(fs.existsSync(path.join(tmp, "record2context", "record2context-host"))).toBe(false);
  });
});
