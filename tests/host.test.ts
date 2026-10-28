import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_READ, MessageReader, PART_SUFFIX, checkRelPath, checkSession, createHost, encodeMessage, loadConfig, parseArgs } from "../host/record2context-host.mjs";

let tmp: string;
let rec: string;
let configFile: string;
let ran: [string, string[]][];
let handle: (msg: unknown) => Promise<any>;
const ORIGIN = "chrome-extension://cmjkjjacbelgggcnknblelhepfmahgon/";
const NOW = new Date("2026-10-28T09:00:00.000Z");

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "r2c-host-"));
  rec = path.join(tmp, "rec ทดสอบ");
  configFile = path.join(tmp, "install", "config.json");
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify({ recordingsDir: rec }));
  ran = [];
  handle = createHost({ configFile, origin: ORIGIN, now: () => NOW, run: (cmd, args) => void ran.push([cmd, args]) });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");
const status = () => JSON.parse(fs.readFileSync(path.join(tmp, "install", "status.json"), "utf8"));

describe("framing", () => {
  it("reads messages whatever the chunk boundaries, several per chunk or one split over many", () => {
    const bytes = Buffer.concat([encodeMessage({ a: 1 }), encodeMessage({ b: "ทดสอบ" }), encodeMessage({ c: [1, 2] })]);
    const r = new MessageReader();
    const out: unknown[] = [];
    for (let i = 0; i < bytes.length; i += 3) out.push(...r.push(bytes.subarray(i, i + 3)));
    expect(out).toEqual([{ a: 1 }, { b: "ทดสอบ" }, { c: [1, 2] }]);
    expect(new MessageReader().push(bytes)).toHaveLength(3);
  });

  it("length is little-endian and counts UTF-8 bytes", () => {
    const m = encodeMessage({ t: "ก" });
    expect(m.readUInt32LE(0)).toBe(Buffer.byteLength('{"t":"ก"}'));
  });
});

describe("config", () => {
  it("expands ~/ and resolves the status file next to the config", () => {
    fs.writeFileSync(configFile, JSON.stringify({ recordingsDir: "~/record2context-recordings" }));
    expect(loadConfig(configFile)).toEqual({ recordingsDir: path.join(os.homedir(), "record2context-recordings"), statusFile: path.join(tmp, "install", "status.json") });
  });

  it("refuses a relative or missing recordingsDir and an unreadable config", async () => {
    fs.writeFileSync(configFile, JSON.stringify({ recordingsDir: "rel/dir" }));
    expect(() => loadConfig(configFile)).toThrow(/absolute/);
    fs.writeFileSync(configFile, "{nope");
    const r = await handle({ id: 1, op: "list" });
    expect(r).toMatchObject({ id: 1, ok: false, code: "config" });
    const p = await handle({ id: 2, op: "ping" });
    expect(p).toMatchObject({ ok: true, dirOk: false });
    expect(p.dirError).toMatch(/cannot read config/);
  });

  it("takes --config and the origin Chrome passes", () => {
    expect(parseArgs(["--config", "/x/c.json", ORIGIN])).toEqual({ configFile: "/x/c.json", origin: ORIGIN });
    expect(parseArgs([ORIGIN, "--parent-window=0"]).origin).toBe(ORIGIN);
  });
});

describe("path safety", () => {
  it.each(["", ".", "..", "a/b", "a\\b", "a\0b", "x".repeat(256), 5, null])("rejects session %j", (s) => {
    expect(() => checkSession(s)).toThrow(/bad session/);
  });

  it.each(["/etc/passwd", "../x", "a/../../x", "a//b", "a/./b", "a\\b", "", "x.webm" + PART_SUFFIX])("rejects path %j", (p) => {
    expect(() => checkRelPath(p)).toThrow(/bad path/);
  });

  it("accepts spaces, Thai and nested folders", () => {
    expect(checkRelPath("screenshots/01 ทดสอบ.png")).toEqual(["screenshots", "01 ทดสอบ.png"]);
    expect(checkSession("2026-10-28_090000_app test")).toBe("2026-10-28_090000_app test");
  });

  it("refuses traversal through the protocol and writes nothing outside", async () => {
    for (const msg of [
      { op: "write", session: "..", path: "x", offset: 0, data: b64("x"), done: true },
      { op: "write", session: "s", path: "../../escape.txt", offset: 0, data: b64("x"), done: true },
      { op: "read", session: "s", path: "/etc/hosts" },
      { op: "delete", session: "../" },
      { op: "reveal", session: ".." },
    ]) {
      expect(await handle({ id: 1, ...msg })).toMatchObject({ ok: false, code: "path" });
    }
    expect(fs.existsSync(path.join(tmp, "escape.txt"))).toBe(false);
  });

  it("refuses a session folder or subfolder that is a symlink pointing outside", async () => {
    const outside = path.join(tmp, "outside");
    fs.mkdirSync(outside);
    fs.mkdirSync(rec, { recursive: true });
    fs.symlinkSync(outside, path.join(rec, "evil"));
    expect(await handle({ id: 1, op: "write", session: "evil", path: "a.txt", offset: 0, data: b64("x"), done: true })).toMatchObject({ ok: false, code: "path" });
    fs.mkdirSync(path.join(rec, "s"));
    fs.symlinkSync(outside, path.join(rec, "s", "shots"));
    expect(await handle({ id: 2, op: "write", session: "s", path: "shots/a.png", offset: 0, data: b64("x"), done: true })).toMatchObject({ ok: false, code: "path" });
    expect(await handle({ id: 3, op: "delete", session: "evil" })).toMatchObject({ ok: false, code: "path" });
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});

describe("path safety: partial files and new folders (review-1 F6)", () => {
  it("refuses a .r2c-part that is a symlink, leaving the file it points at untouched", async () => {
    const outside = path.join(tmp, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "victim.txt"), "ORIGINAL CONTENT");
    fs.mkdirSync(path.join(rec, "s1"), { recursive: true });
    fs.symlinkSync(path.join(outside, "victim.txt"), path.join(rec, "s1", "report.json" + PART_SUFFIX));
    expect(await handle({ id: 1, op: "write", session: "s1", path: "report.json", offset: 0, data: b64("ATTACKER"), done: true })).toMatchObject({ ok: false, code: "path" });
    expect(fs.readFileSync(path.join(outside, "victim.txt"), "utf8")).toBe("ORIGINAL CONTENT");
  });

  it("creates no folder outside when a parent is a symlink, refusing before the deeper levels exist", async () => {
    const outside = path.join(tmp, "outside");
    fs.mkdirSync(outside);
    fs.mkdirSync(path.join(rec, "s2"), { recursive: true });
    fs.symlinkSync(outside, path.join(rec, "s2", "link"));
    expect(await handle({ id: 1, op: "write", session: "s2", path: "link/new/deep/f.png", offset: 0, data: b64("x"), done: true })).toMatchObject({ ok: false, code: "path" });
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("still writes nested folders with spaces and Thai names", async () => {
    expect(await handle({ id: 1, op: "write", session: "s 3", path: "a b/ทดสอบ/f.png", offset: 0, data: b64("x"), done: true })).toMatchObject({ ok: true });
    expect(fs.readFileSync(path.join(rec, "s 3", "a b", "ทดสอบ", "f.png"), "utf8")).toBe("x");
  });
});

describe("recordings left in an earlier recordings folder (review-1 F2)", () => {
  const write = (id: number, session: string) => handle({ id, op: "write", session, path: "report.json", offset: 0, data: b64("{}"), done: true });
  let old: string;
  let next: string;
  beforeEach(async () => {
    old = rec;
    next = path.join(tmp, "next folder");
    await write(1, "a");
    fs.writeFileSync(configFile, JSON.stringify({ recordingsDir: next }));
    await write(2, "b");
  });

  it("remembers every folder it wrote to; writes go only to the current one", () => {
    expect(JSON.parse(fs.readFileSync(path.join(tmp, "install", "roots.json"), "utf8")).roots).toEqual([old, next]);
    expect(fs.existsSync(path.join(next, "b", "report.json")) && !fs.existsSync(path.join(old, "b"))).toBe(true);
  });

  it("exists, list, read, reveal and delete work at the recorded folder in the old one", async () => {
    const a = path.join(old, "a");
    expect(await handle({ id: 1, op: "exists", dirs: [a, path.join(next, "b"), path.join(next, "a")] })).toMatchObject({
      ok: true,
      found: { [a]: true, [path.join(next, "b")]: true, [path.join(next, "a")]: false },
      refused: {},
    });
    expect(await handle({ id: 2, op: "list", session: "a", dir: a })).toMatchObject({ ok: true, exists: true, files: [{ path: "report.json", size: 2 }] });
    expect(Buffer.from((await handle({ id: 3, op: "read", session: "a", dir: a, path: "report.json" })).data, "base64").toString()).toBe("{}");
    expect(await handle({ id: 4, op: "reveal", session: "a", dir: a })).toMatchObject({ ok: true, path: a });
    expect(await handle({ id: 5, op: "delete", session: "a", dir: a })).toMatchObject({ ok: true, existed: true, dir: a });
    expect(fs.existsSync(a)).toBe(false);
    expect(fs.existsSync(old)).toBe(true);
  });

  it("refuses a folder it never used, a dir that is not that session's, and a relative dir", async () => {
    const stranger = path.join(tmp, "stranger");
    fs.mkdirSync(path.join(stranger, "a"), { recursive: true });
    fs.writeFileSync(path.join(stranger, "a", "report.json"), "{}");
    expect(await handle({ id: 1, op: "delete", session: "a", dir: path.join(stranger, "a") })).toMatchObject({ ok: false, code: "unknown-root" });
    expect(fs.existsSync(path.join(stranger, "a"))).toBe(true);
    expect(await handle({ id: 2, op: "delete", session: "a", dir: path.join(old, "b") })).toMatchObject({ ok: false, code: "path" });
    expect(await handle({ id: 3, op: "delete", session: "a", dir: "rel/a" })).toMatchObject({ ok: false, code: "path" });
    expect(await handle({ id: 4, op: "delete", session: "a", dir: path.join(old, "..", "stranger", "a") })).toMatchObject({ ok: false, code: "unknown-root" });
    expect(await handle({ id: 5, op: "exists", dirs: [path.join(stranger, "a")] })).toMatchObject({ ok: true, found: {}, refused: { [path.join(stranger, "a")]: expect.stringMatching(/not a recordings folder/) } });
  });

  it("refuses a session folder in an old root that is a symlink pointing outside", async () => {
    const outside = path.join(tmp, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "keep.txt"), "x");
    fs.symlinkSync(outside, path.join(old, "evil"));
    expect(await handle({ id: 1, op: "delete", session: "evil", dir: path.join(old, "evil") })).toMatchObject({ ok: false, code: "path" });
    expect(fs.readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("x");
  });

  it("refuses to read or delete a folder that is, or holds, a recordings folder (review-2 N2)", async () => {
    // Current root nested directly in the old one, and another known root nested deeper.
    const nested = path.join(old, "sub");
    fs.writeFileSync(configFile, JSON.stringify({ recordingsDir: nested }));
    await write(3, "c");
    const deeper = path.join(old, "holder", "inner");
    fs.writeFileSync(configFile, JSON.stringify({ recordingsDir: deeper }));
    await write(4, "d");
    expect(await handle({ id: 5, op: "delete", session: "sub", dir: nested })).toMatchObject({ ok: false, code: "path" });
    expect(await handle({ id: 6, op: "delete", session: "holder", dir: path.join(old, "holder") })).toMatchObject({ ok: false, code: "path" });
    expect(await handle({ id: 7, op: "read", session: "sub", dir: nested, path: "c/report.json" })).toMatchObject({ ok: false, code: "path" });
    expect(await handle({ id: 8, op: "exists", dirs: [nested] })).toMatchObject({ ok: true, found: {}, refused: { [nested]: expect.stringMatching(/holds a recordings folder/) } });
    expect(fs.existsSync(path.join(nested, "c", "report.json")) && fs.existsSync(path.join(deeper, "d", "report.json"))).toBe(true);
    // Ordinary old sessions next to them still work.
    expect(await handle({ id: 9, op: "delete", session: "a", dir: path.join(old, "a") })).toMatchObject({ ok: true, existed: true });
  });

  it("a deleted recording reports existed: false", async () => {
    fs.rmSync(path.join(old, "a"), { recursive: true });
    expect(await handle({ id: 1, op: "delete", session: "a", dir: path.join(old, "a") })).toMatchObject({ ok: true, existed: false });
  });
});

describe("protocol", () => {
  it("ping reports the folder from the config, creates it and runs a self-test", async () => {
    const r = await handle({ id: 7, op: "ping" });
    expect(r).toMatchObject({ id: 7, ok: true, hostVersion: "1.1.0", protocol: 1, dir: rec, dirOk: true, configFile });
    expect(fs.statSync(rec).isDirectory()).toBe(true);
    expect(fs.readdirSync(rec)).toEqual([]);
    expect(fs.existsSync(path.join(tmp, "install", "status.json"))).toBe(false);
  });

  it("a heartbeat is recorded in status.json with the caller origin and the self-test", async () => {
    await handle({ id: 1, op: "ping", heartbeat: { extensionId: "cmjk", extensionVersion: "0.1.0", buildId: "b1", reason: "worker-start" } });
    expect(status()).toMatchObject({
      hostVersion: "1.1.0",
      lastHeartbeat: { at: NOW.toISOString(), origin: ORIGIN, extensionId: "cmjk", extensionVersion: "0.1.0", buildId: "b1", reason: "worker-start" },
      selfTest: { ok: true, dir: rec },
    });
  });

  it("ping and the self-test report a folder that cannot be written", async () => {
    fs.writeFileSync(path.join(tmp, "file"), "");
    fs.writeFileSync(configFile, JSON.stringify({ recordingsDir: path.join(tmp, "file", "sub") }));
    const r = await handle({ id: 1, op: "ping", heartbeat: { extensionId: "x", extensionVersion: "1", buildId: "b", reason: "t" } });
    expect(r).toMatchObject({ ok: true, dirOk: false });
    expect(status().selfTest).toMatchObject({ ok: false });
    expect(await handle({ id: 2, op: "selftest" })).toMatchObject({ ok: false, code: "selftest" });
  });

  it("writes a file in chunks into a partial file, renames it on the last one, and lists it", async () => {
    const data = Buffer.from(Array.from({ length: 3000 }, (_, i) => i % 251));
    const parts = [data.subarray(0, 1024), data.subarray(1024, 2048), data.subarray(2048)];
    let offset = 0;
    for (const [i, p] of parts.entries()) {
      const r = await handle({ id: i, op: "write", session: "s 1", path: "v ทดสอบ.webm", offset, data: b64(p), done: i === 2 });
      offset += p.length;
      expect(r).toMatchObject({ ok: true, size: offset });
      expect(fs.existsSync(path.join(rec, "s 1", "v ทดสอบ.webm" + PART_SUFFIX))).toBe(i < 2);
    }
    expect(fs.readFileSync(path.join(rec, "s 1", "v ทดสอบ.webm")).equals(data)).toBe(true);
    await handle({ id: 9, op: "write", session: "s 1", path: "screenshots/01.png", offset: 0, data: "", done: true });
    expect(await handle({ id: 10, op: "list", session: "s 1" })).toMatchObject({
      ok: true,
      exists: true,
      files: [
        { path: "screenshots/01.png", size: 0 },
        { path: "v ทดสอบ.webm", size: 3000 },
      ],
    });
  });

  it("refuses a chunk whose offset does not match what is on disk (lost or repeated chunk)", async () => {
    await handle({ id: 1, op: "write", session: "s", path: "a.bin", offset: 0, data: b64("abc") });
    expect(await handle({ id: 2, op: "write", session: "s", path: "a.bin", offset: 10, data: b64("x") })).toMatchObject({ ok: false, code: "offset" });
    expect(await handle({ id: 3, op: "write", session: "s", path: "b.bin", offset: 3, data: b64("x") })).toMatchObject({ ok: false, code: "offset" });
    expect(await handle({ id: 4, op: "write", session: "s", path: "a.bin", offset: -1, data: b64("x") })).toMatchObject({ ok: false, code: "offset" });
  });

  it("rewriting from offset 0 replaces the file", async () => {
    await handle({ id: 1, op: "write", session: "s", path: "a.txt", offset: 0, data: b64("first version"), done: true });
    await handle({ id: 2, op: "write", session: "s", path: "a.txt", offset: 0, data: b64("2nd"), done: true });
    expect(fs.readFileSync(path.join(rec, "s", "a.txt"), "utf8")).toBe("2nd");
  });

  it("finish checks every file arrived and records the save", async () => {
    await handle({ id: 1, op: "write", session: "s", path: "report.json", offset: 0, data: b64("{}"), done: true });
    expect(await handle({ id: 2, op: "finish", session: "s", files: ["report.json", "s.webm"] })).toMatchObject({ ok: false, code: "missing" });
    expect(await handle({ id: 3, op: "finish", session: "s", files: ["report.json"] })).toMatchObject({ ok: true, dir: path.join(rec, "s") });
    expect(status().lastSave).toEqual({ at: NOW.toISOString(), session: "s", dir: path.join(rec, "s"), files: 1 });
  });

  it("lists only session folders that hold a report.json", async () => {
    await handle({ id: 1, op: "write", session: "b", path: "report.json", offset: 0, data: b64("{}"), done: true });
    await handle({ id: 2, op: "write", session: "a", path: "report.json", offset: 0, data: b64("{}"), done: true });
    await handle({ id: 3, op: "write", session: "c", path: "x.txt", offset: 0, data: b64("x"), done: true });
    expect(await handle({ id: 4, op: "list" })).toMatchObject({ ok: true, dir: rec, sessions: ["a", "b"] });
    expect(await handle({ id: 5, op: "list", session: "nope" })).toMatchObject({ ok: true, exists: false, files: [] });
  });

  it("reads back in chunks no larger than MAX_READ", async () => {
    const data = Buffer.alloc(MAX_READ + 100, 7);
    fs.mkdirSync(path.join(rec, "s"), { recursive: true });
    fs.writeFileSync(path.join(rec, "s", "v.webm"), data);
    const a = await handle({ id: 1, op: "read", session: "s", path: "v.webm", offset: 0, length: 10 * MAX_READ });
    expect([Buffer.from(a.data, "base64").length, a.eof, a.size]).toEqual([MAX_READ, false, MAX_READ + 100]);
    const b = await handle({ id: 2, op: "read", session: "s", path: "v.webm", offset: MAX_READ });
    expect([Buffer.from(b.data, "base64").length, b.eof]).toEqual([100, true]);
    expect(await handle({ id: 3, op: "read", session: "s", path: "nope.txt" })).toMatchObject({ ok: false, code: "not-found" });
  });

  it("deletes a session folder, and says when it was not there", async () => {
    await handle({ id: 1, op: "write", session: "s", path: "screenshots/01.png", offset: 0, data: b64("x"), done: true });
    expect(await handle({ id: 2, op: "delete", session: "s" })).toMatchObject({ ok: true, existed: true });
    expect(fs.existsSync(path.join(rec, "s"))).toBe(false);
    expect(await handle({ id: 3, op: "delete", session: "s" })).toMatchObject({ ok: true, existed: false });
    expect(fs.existsSync(rec)).toBe(true);
  });

  it("reveal opens the session folder (or the recordings folder) with the platform's opener", async () => {
    await handle({ id: 1, op: "write", session: "s", path: "report.json", offset: 0, data: b64("{}"), done: true });
    expect(await handle({ id: 2, op: "reveal", session: "s" })).toMatchObject({ ok: true, path: path.join(rec, "s") });
    expect(await handle({ id: 3, op: "reveal" })).toMatchObject({ ok: true, path: rec });
    const opener = process.platform === "darwin" ? "/usr/bin/open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
    expect(ran).toEqual([
      [opener, [path.join(rec, "s")]],
      [opener, [rec]],
    ]);
    expect(await handle({ id: 4, op: "reveal", session: "gone" })).toMatchObject({ ok: false, code: "not-found" });
  });

  it("reveal writes to revealLog instead when the config sets it (tests)", async () => {
    const log = path.join(tmp, "reveal.log");
    fs.writeFileSync(configFile, JSON.stringify({ recordingsDir: rec, revealLog: log }));
    await handle({ id: 1, op: "reveal" });
    expect(fs.readFileSync(log, "utf8")).toBe(`${rec}\n`);
    expect(ran).toEqual([]);
  });

  it("the self-test leaves nothing behind", async () => {
    expect(await handle({ id: 1, op: "selftest" })).toMatchObject({ ok: true, dir: rec });
    expect(fs.readdirSync(rec)).toEqual([]);
  });

  it("reads the config on every request, so editing it moves the next recording", async () => {
    const other = path.join(tmp, "other folder");
    await handle({ id: 1, op: "write", session: "a", path: "report.json", offset: 0, data: b64("{}"), done: true });
    fs.writeFileSync(configFile, JSON.stringify({ recordingsDir: other }));
    await handle({ id: 2, op: "write", session: "b", path: "report.json", offset: 0, data: b64("{}"), done: true });
    expect(fs.readdirSync(rec)).toEqual(["a"]);
    expect(fs.readdirSync(other)).toEqual(["b"]);
  });

  it("unknown ops are refused with the id echoed", async () => {
    expect(await handle({ id: 5, op: "rm -rf" })).toMatchObject({ id: 5, ok: false, code: "op" });
    expect(await handle({ id: 6, op: "constructor" })).toMatchObject({ id: 6, ok: false, code: "op" });
  });
});

describe("recording layouts", () => {
  it("list and exists count a recording by details/report.json (current) or report.json (before details/)", async () => {
    for (const [s, f] of [["new", "details/report.json"], ["old", "report.json"], ["none", "x.webm"]]) {
      fs.mkdirSync(path.dirname(path.join(rec, s!, f!)), { recursive: true });
      fs.writeFileSync(path.join(rec, s!, f!), "{}");
    }
    expect((await handle({ id: 1, op: "list" })).sessions).toEqual(["new", "old"]);
    const r = await handle({ id: 2, op: "exists", dirs: ["new", "old", "none"].map((s) => path.join(rec, s)) });
    expect(Object.values(r.found)).toEqual([true, true, false]);
  });
});
