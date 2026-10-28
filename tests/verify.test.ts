import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { install, parseInstallArgs } from "../host/install.mjs";
import { repoExtensionId } from "../host/common.mjs";
import { verify } from "../host/verify.mjs";

let tmp: string;
let r: Awaited<ReturnType<typeof install>>;
const o = () => ({ browser: "chrome", manifestDir: path.join(tmp, "nmh"), waitHeartbeat: 0 });
const check = (v: any, id: string) => v.checks.find((c: any) => c.id === id);

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "r2c-verify-"));
  r = await install(parseInstallArgs(["--install-dir", path.join(tmp, "inst"), "--manifest-dir", path.join(tmp, "nmh"), "--recordings-dir", path.join(tmp, "rec")]));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const heartbeat = (extra: object = {}) =>
  fs.writeFileSync(
    path.join(tmp, "inst", "status.json"),
    JSON.stringify({
      lastHeartbeat: { at: new Date(Date.now() + 60_000).toISOString(), origin: `chrome-extension://${repoExtensionId()}/`, extensionId: repoExtensionId(), buildId: "x" },
      selfTest: { ok: true, dir: path.join(tmp, "rec") },
      ...extra,
    }),
  );

describe("verify-install: who fixes what (review-1 F3)", () => {
  it.each([
    ["wrong allowed_origins", () => {
      const m = JSON.parse(fs.readFileSync(r.manifests[0]!, "utf8"));
      fs.writeFileSync(r.manifests[0]!, JSON.stringify({ ...m, allowed_origins: ["chrome-extension://abcdefghijklmnopabcdefghijklmnop/"] }));
    }, "host-manifest"],
    ["launcher not executable", () => fs.chmodSync(r.launcher, 0o644), "host-manifest"],
    ["node gone", () => {
      const text = fs.readFileSync(r.launcher, "utf8").replace(r.node, path.join(tmp, "gone", "node"));
      fs.writeFileSync(r.launcher, text);
    }, "launcher"],
  ])("%s: installer-owned only, nothing for the person", async (_name, breakIt, failing) => {
    breakIt();
    const v = await verify(o());
    expect(v.verdict).toBe("NOT_READY");
    expect(check(v, failing)).toMatchObject({ ok: false, owner: "installer" });
    expect(check(v, "heartbeat")).toMatchObject({ ok: false, owner: "installer" });
    expect(v.failures.every((f: any) => f.owner === "installer")).toBe(true);
    expect(v.humanSteps).toEqual([]);
  });

  it("no heartbeat yet: the person's Load unpacked step (deferred to the installer only while the installer has something to fix)", async () => {
    const v = await verify(o());
    const hb = check(v, "heartbeat");
    const installerLeft = v.failures.some((f: any) => f.id !== "heartbeat" && f.owner === "installer");
    if (installerLeft) expect(hb.deferredHumanStep).toMatch(/Load unpacked/);
    else expect(hb).toMatchObject({ owner: "human", fix: expect.stringMatching(/Load unpacked/) });
  });

  it("macOS refusing Chrome the folder is the person's System Settings step, not a folder swap", async () => {
    heartbeat({ selfTest: { ok: false, dir: path.join(tmp, "rec"), error: "EPERM: operation not permitted, open '...'" } });
    const c = check(await verify(o()), "chrome-wrote-folder");
    expect(c.ok).toBe(false);
    expect(c.owner === "human" ? c.fix : c.deferredHumanStep).toMatch(/System Settings > Privacy & Security > Files and Folders/);
  });

  it("a stale Chrome self-test error is the person's click once the folder can be written again (review-2 N1)", async () => {
    heartbeat({ selfTest: { ok: false, dir: path.join(tmp, "rec"), error: "EACCES: permission denied, open 'probe'" } });
    const c = check(await verify(o()), "chrome-wrote-folder");
    // Owned by the person; when something else is still the installer's, it is deferred but keeps the person's text.
    expect(c.owner === "human" ? c.fix : c.deferredHumanStep).toMatch(/can be written now.*click the record2context icon/);
  });

  it("the same error while the folder still cannot be written stays the installer's", async () => {
    heartbeat({ selfTest: { ok: false, dir: path.join(tmp, "rec"), error: "EACCES: permission denied, open 'probe'" } });
    fs.chmodSync(path.join(tmp, "rec"), 0o555);
    try {
      const c = check(await verify(o()), "chrome-wrote-folder");
      expect(c).toMatchObject({ owner: "installer", fix: expect.stringMatching(/Fix the folder \(installer\)/) });
      expect(c.deferredHumanStep).toBeUndefined();
    } finally {
      fs.chmodSync(path.join(tmp, "rec"), 0o755);
    }
  });

  it("flags the test-only revealLog key in config.json (review-1 O3)", async () => {
    const cfg = JSON.parse(fs.readFileSync(r.configFile, "utf8"));
    fs.writeFileSync(r.configFile, JSON.stringify({ ...cfg, revealLog: path.join(tmp, "reveal.log") }));
    expect(check(await verify(o()), "config-test-keys")).toMatchObject({ ok: false, owner: "installer" });
  });

  it("compares the heartbeat with file times as instants, whatever the local time zone (review-1 F4)", async () => {
    heartbeat({ lastHeartbeat: { at: new Date(Date.now() - 3_600_000).toISOString(), origin: `chrome-extension://${repoExtensionId()}/`, extensionId: repoExtensionId(), buildId: "x" } });
    const stale = check(await verify(o()), "heartbeat-fresh");
    expect(stale.ok).toBe(false);
    heartbeat();
    expect(check(await verify(o()), "heartbeat-fresh").ok).toBe(true);
  });
});

describe("verify-install: the launch log tells apart never started, failing and working", () => {
  const log = (text: string) => fs.writeFileSync(path.join(tmp, "inst", "launch.log"), text);

  it("no status.json and no launch log (normal before Load unpacked): the person's step", async () => {
    expect(fs.existsSync(path.join(tmp, "inst", "status.json"))).toBe(false);
    expect(fs.existsSync(path.join(tmp, "inst", "launch.log"))).toBe(false);
    const hb = check(await verify(o()), "heartbeat");
    expect(hb.evidence.state).toBe("never-launched");
    expect(hb.owner === "human" ? hb.fix : hb.deferredHumanStep).toMatch(/loaded from \/.+\/dist, its round-arrow reload button is enough \(its recordings stay\).*one loaded from another folder is removed.*Load unpacked/s);
  });

  it("started by Chrome but no heartbeat: the installer's, with the helper's error text", async () => {
    log(`2026-10-28T09:00:00Z launch origin=chrome-extension://${repoExtensionId()}/\nError: Cannot find module '/x/record2context-host.mjs'\n`);
    const hb = check(await verify(o()), "heartbeat");
    expect(hb).toMatchObject({ ok: false, owner: "installer", evidence: { state: "launched-no-heartbeat", launchLog: { launches: 1 } } });
    expect(hb.fix).toMatch(/never wrote a heartbeat.*Cannot find module/);
    expect(hb.deferredHumanStep).toBeUndefined();
  });

  it("a heartbeat is the working state, whatever the log says", async () => {
    log(`2026-10-28T09:00:00Z launch origin=chrome-extension://${repoExtensionId()}/\n`);
    heartbeat();
    expect(check(await verify(o()), "heartbeat")).toMatchObject({ ok: true, evidence: { state: "heartbeat" } });
  });

  it("the human step's text is a fact list, not a message to send, and covers every part of the step", async () => {
    const fix = check(await verify(o()), "heartbeat");
    const text = fix.owner === "human" ? fix.fix : fix.deferredHumanStep;
    expect(text).not.toMatch(/Ask the person|word for word|^>/);
    for (const part of [/older QA Recorder or record2context is listed and was loaded from \/.+\/dist, its round-arrow reload button is enough/, /loaded from another folder is removed/, /Load unpacked and choose the folder \/.+\/dist/, /macOS asks/, /click the record2context icon/]) expect(text).toMatch(part);
  });
});

describe("verify-install: a helper that broke after its last heartbeat (review-3 F6)", () => {
  it("a later Chrome start with error output is the installer's, not another click for the person", async () => {
    heartbeat({ lastHeartbeat: { at: new Date(Date.now() - 60_000).toISOString(), origin: `chrome-extension://${repoExtensionId()}/`, extensionId: repoExtensionId(), buildId: "x" } });
    fs.writeFileSync(path.join(tmp, "inst", "launch.log"), `${new Date().toISOString().slice(0, 19)}Z launch origin=chrome-extension://${repoExtensionId()}/\nError: broken since\n`);
    const hb = check(await verify(o()), "heartbeat");
    expect(hb).toMatchObject({ ok: false, owner: "installer", evidence: { state: "launched-failing-since-heartbeat" } });
    expect(hb.fix).toMatch(/after its last heartbeat.*broken since/);
  });

  it("a later start without error output is not a failure", async () => {
    heartbeat();
    fs.writeFileSync(path.join(tmp, "inst", "launch.log"), `${new Date().toISOString().slice(0, 19)}Z launch origin=chrome-extension://${repoExtensionId()}/\n`);
    expect(check(await verify(o()), "heartbeat")).toMatchObject({ ok: true, evidence: { state: "heartbeat" } });
  });
});

describe("verify-install: the recorded folder choice (review-3 F4)", () => {
  it("passes when the config uses the chosen folder", async () => {
    expect(check(await verify(o()), "folder-choice")).toMatchObject({ ok: true });
  });

  it("a config whose folder differs from the person's choice is the installer's to fix", async () => {
    const cfg = JSON.parse(fs.readFileSync(r.configFile, "utf8"));
    fs.mkdirSync(path.join(tmp, "other"));
    fs.writeFileSync(r.configFile, JSON.stringify({ ...cfg, recordingsDir: path.join(tmp, "other") }));
    const c = check(await verify(o()), "folder-choice");
    expect(c).toMatchObject({ ok: false, owner: "installer" });
    expect(c.fix).toMatch(/The person chose .*rec, but recordingsDir is .*other/);
  });

  it("no recorded choice at all fails, pointing at step 0's command", async () => {
    const { folder: _f, ...cfg } = JSON.parse(fs.readFileSync(r.configFile, "utf8"));
    fs.writeFileSync(r.configFile, JSON.stringify(cfg));
    expect(check(await verify(o()), "folder-choice")).toMatchObject({ ok: false, owner: "installer", fix: expect.stringMatching(/--choose-folder/) });
  });
});
