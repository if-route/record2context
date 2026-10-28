import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHost } from "../host/record2context-host.mjs";
import { removePath, writeFile } from "../src/shared/fs";
import { HostClient, HostRequestError, HostUnavailable, READ_CHUNK, WRITE_CHUNK, chunkRanges, classifyDisconnect, fromBase64, toBase64, type PortLike } from "../src/shared/host";
import { copySessionToFolder, deleteSessionFiles, folderPresence, locate, openSessionFile } from "../src/shared/store";
import type { RecentSession } from "../src/shared/recent";
import { FakeDir } from "./helpers/fake-fs";

/** A port wired to the real host's request handler in-process; `fail` makes the next connect behave like Chrome's. */
function hostPort(handle: (m: unknown) => Promise<unknown>, log: any[] = []) {
  let fail: string | null = null;
  let lastError: string | undefined;
  let connects = 0;
  const connect = (): PortLike => {
    connects++;
    const onMsg: ((m: any) => void)[] = [];
    const onDis: (() => void)[] = [];
    const failing = fail;
    let open = true;
    const port: PortLike = {
      postMessage(m) {
        log.push(m);
        if (failing) return;
        void handle(m).then((r) => open && onMsg.forEach((f) => f(r)));
      },
      disconnect() {
        open = false;
      },
      onMessage: { addListener: (f) => void onMsg.push(f) },
      onDisconnect: { addListener: (f) => void onDis.push(f) },
    };
    // Chrome reports a missing host asynchronously, through onDisconnect + runtime.lastError.
    if (failing) setTimeout(() => ((lastError = failing), onDis.forEach((f) => f()), (lastError = undefined)), 0);
    return port;
  };
  return {
    client: (timeoutMs = 2000, idleMs = 50) => new HostClient(connect, () => lastError, timeoutMs, idleMs),
    failNext: (m: string | null) => (fail = m),
    connects: () => connects,
  };
}

let tmp: string;
let rec: string;
let handle: (m: unknown) => Promise<any>;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "r2c-client-"));
  rec = path.join(tmp, "recordings ทดสอบ");
  fs.writeFileSync(path.join(tmp, "config.json"), JSON.stringify({ recordingsDir: rec }));
  handle = createHost({ configFile: path.join(tmp, "config.json"), origin: "chrome-extension://x/", run: () => undefined });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe("helpers", () => {
  it("splits a file into chunk ranges; an empty file is one empty write", () => {
    expect(chunkRanges(0)).toEqual([[0, 0]]);
    expect(chunkRanges(10, 4)).toEqual([
      [0, 4],
      [4, 8],
      [8, 10],
    ]);
    expect(chunkRanges(WRITE_CHUNK)).toEqual([[0, WRITE_CHUNK]]);
  });

  it("base64 round-trips every byte value, also past the 32 KiB slice", () => {
    const bytes = new Uint8Array(70_000).map((_, i) => i % 256);
    const b64 = toBase64(bytes);
    expect(b64).toBe(Buffer.from(bytes).toString("base64"));
    expect([...fromBase64(b64)]).toEqual([...bytes]);
  });

  it("Chrome's not-found and forbidden mean the helper is not set up; anything else is broken", () => {
    expect(classifyDisconnect("Specified native messaging host not found.").kind).toBe("missing");
    expect(classifyDisconnect("Access to the specified native messaging host is forbidden.").kind).toBe("missing");
    expect(classifyDisconnect("Native host has exited.").kind).toBe("broken");
    expect(classifyDisconnect("Failed to start native messaging host.").kind).toBe("broken");
    expect(classifyDisconnect(undefined).kind).toBe("broken");
  });
});

describe("HostClient", () => {
  it("matches replies to requests by id, even when they come back in another order", async () => {
    const delays: Record<string, number> = { slow: 30, fast: 0 };
    const p = hostPort(async (m: any) => {
      await new Promise((r) => setTimeout(r, delays[m.tag] ?? 0));
      return { id: m.id, ok: true, tag: m.tag };
    });
    const c = p.client();
    const [a, b] = await Promise.all([c.request({ op: "x", tag: "slow" }), c.request({ op: "x", tag: "fast" })]);
    expect([a.tag, b.tag]).toEqual(["slow", "fast"]);
    expect(p.connects()).toBe(1);
  });

  it("a host error rejects with its code; the connection stays usable", async () => {
    const c = hostPort(handle).client();
    await expect(c.request({ op: "read", session: "..", path: "x" })).rejects.toMatchObject({ code: "path" });
    await expect(c.request({ op: "read", session: "..", path: "x" })).rejects.toBeInstanceOf(HostRequestError);
    expect((await c.status()).state).toBe("ready");
  });

  it("status: ready with the folder, missing when Chrome finds no host, broken when it dies or times out", async () => {
    const p = hostPort(handle);
    const c = p.client();
    expect(await c.status()).toEqual({ state: "ready", dir: rec, hostVersion: "1.1.0" });
    c.close();
    p.failNext("Specified native messaging host not found.");
    expect(await c.status()).toEqual({ state: "missing", error: "Specified native messaging host not found." });
    p.failNext("Native host has exited.");
    expect(await c.status()).toMatchObject({ state: "broken", error: "Native host has exited." });
    p.failNext(null);
    const silent = hostPort(() => new Promise(() => undefined)).client(30);
    expect(await silent.status()).toMatchObject({ state: "broken", error: expect.stringMatching(/did not answer ping/) });
  });

  it("status: broken with the reason when the folder cannot be written", async () => {
    fs.writeFileSync(path.join(tmp, "f"), "");
    fs.writeFileSync(path.join(tmp, "config.json"), JSON.stringify({ recordingsDir: path.join(tmp, "f", "x") }));
    expect(await hostPort(handle).client().status()).toMatchObject({ state: "broken", dir: path.join(tmp, "f", "x") });
  });

  it("sends a heartbeat with the ping when given one", async () => {
    const log: any[] = [];
    await hostPort(handle, log).client().status({ extensionId: "id", extensionVersion: "0.1.0", buildId: "b", reason: "popup" });
    expect(log[0]).toMatchObject({ op: "ping", heartbeat: { extensionId: "id", reason: "popup" } });
    expect(JSON.parse(fs.readFileSync(path.join(tmp, "status.json"), "utf8")).lastHeartbeat.reason).toBe("popup");
  });

  it("closes the port after being idle and reconnects on the next request", async () => {
    const p = hostPort(handle);
    const c = p.client(2000, 10);
    await c.status();
    await new Promise((r) => setTimeout(r, 40));
    await c.status();
    expect(p.connects()).toBe(2);
  });

  it("writes a blob in chunks with running offsets and only the last one done; the file on disk is identical", async () => {
    const log: any[] = [];
    const c = hostPort(handle, log).client();
    const bytes = new Uint8Array(10_000).map((_, i) => (i * 7) % 256);
    expect(await c.writeBlob("s", "v.webm", new Blob([bytes]), 4096)).toBe(10_000);
    expect(log.map((m) => [m.offset, Buffer.from(m.data, "base64").length, m.done])).toEqual([
      [0, 4096, false],
      [4096, 4096, false],
      [8192, 1808, true],
    ]);
    expect(fs.readFileSync(path.join(rec, "s", "v.webm")).equals(Buffer.from(bytes))).toBe(true);
  });

  it("saves a session (dot-files left out), finishes it, lists it, reads a file back and deletes it", async () => {
    const src = new FakeDir("s");
    await writeFile(src, "report.json", '{"ok":true}');
    await writeFile(src, "s.webm", new Blob([new Uint8Array(READ_CHUNK + 5).fill(3)]));
    await writeFile(src, "screenshots/01 ทดสอบ.png", "png");
    await writeFile(src, ".video.part", "scratch");
    const c = hostPort(handle).client();
    expect(await c.saveSession("2026-10-28_090000_app", src, 1000)).toEqual({ dir: path.join(rec, "2026-10-28_090000_app"), files: ["report.json", "s.webm", "screenshots/01 ทดสอบ.png"] });
    expect(fs.existsSync(path.join(rec, "2026-10-28_090000_app", ".video.part"))).toBe(false);
    expect(await c.listSessions()).toEqual(expect.objectContaining({ dir: rec, sessions: ["2026-10-28_090000_app"] }));
    const back = await c.readFile("2026-10-28_090000_app", "s.webm", "video/webm");
    expect([back.size, back.type]).toEqual([READ_CHUNK + 5, "video/webm"]);
    expect(await c.deleteSession("2026-10-28_090000_app")).toMatchObject({ existed: true });
    expect(fs.readdirSync(rec)).toEqual([]);
  });

  it("a request on a host that is not installed rejects as missing", async () => {
    const p = hostPort(handle);
    p.failNext("Specified native messaging host not found.");
    const e = await p.client().listSessions().catch((x) => x);
    expect(e).toBeInstanceOf(HostUnavailable);
    expect(e.kind).toBe("missing");
  });
});

describe("store over the helper", () => {
  const entry = (id: string, extra: Partial<RecentSession> = {}): RecentSession => ({ id, host: "app.test", startedAt: "2026-10-28T09:00:00.000Z", durationMs: 1000, marks: 0, context: "", ...extra });
  let opfs: FakeDir;
  beforeEach(() => {
    opfs = new FakeDir("root");
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => opfs } });
  });

  it("copies a recording from the extension's storage and records the folder the helper reports", async () => {
    await writeFile(opfs, "sessions/a/report.json", "{}");
    await writeFile(opfs, "sessions/a/a.webm", "v");
    const c = hostPort(handle).client();
    expect(await copySessionToFolder("a", c)).toEqual({ dir: path.join(rec, "a") });
    expect(fs.readdirSync(path.join(rec, "a")).sort()).toEqual(["a.webm", "report.json"]);
  });

  it("never throws: no helper, or nothing in the extension's storage, is an error on the copy", async () => {
    const p = hostPort(handle);
    expect(await copySessionToFolder("nope", p.client())).toEqual({ error: "not in the extension's storage" });
    await writeFile(opfs, "sessions/a/report.json", "{}");
    p.failNext("Specified native messaging host not found.");
    expect(await copySessionToFolder("a", p.client())).toEqual({ error: "the recording helper is not set up" });
  });

  it("where a recording is: each recorded folder checked in one request; unknown when the helper cannot be reached", async () => {
    await writeFile(opfs, "sessions/a/report.json", "{}");
    const p = hostPort(handle);
    await copySessionToFolder("a", p.client());
    const a = entry("a", { folderCopy: { dir: path.join(rec, "a") } });
    const b = entry("b", { folderCopy: { dir: path.join(rec, "b") } });
    const present = await folderPresence([a, b, entry("c")], p.client());
    expect([...present!]).toEqual([
      [path.join(rec, "a"), true],
      [path.join(rec, "b"), false],
    ]);
    expect(await locate(a, present)).toEqual({ opfs: true, folder: "yes" });
    expect(await locate(b, present)).toEqual({ opfs: false, folder: "no" });
    expect(await locate(entry("a", { folderCopy: { error: "x" } }), present)).toEqual({ opfs: true, folder: "none" });
    p.failNext("Specified native messaging host not found.");
    expect(await folderPresence([a], p.client())).toBeNull();
    expect(await locate(a, null)).toEqual({ opfs: true, folder: "unknown" });
  });

  it("after the recordings folder changes, older recordings are found, opened and deleted where they were saved (review-1 F2)", async () => {
    await writeFile(opfs, "sessions/a/report.json", "{}");
    await writeFile(opfs, "sessions/b/report.json", "{}");
    const p = hostPort(handle);
    const aDir = (await copySessionToFolder("a", p.client())).dir!;
    const bDir = (await copySessionToFolder("b", p.client())).dir!;
    const next = path.join(tmp, "next folder");
    fs.writeFileSync(path.join(tmp, "config.json"), JSON.stringify({ recordingsDir: next }));
    const a = entry("a", { folderCopy: { dir: aDir } });
    const b = entry("b", { folderCopy: { dir: bDir } });
    await removePath(opfs, "sessions/a");
    // a: only on disk in the old folder; b: in the extension and the old folder.
    const present = await folderPresence([a, b], p.client());
    expect(await locate(a, present)).toEqual({ opfs: false, folder: "yes" });
    expect(await locate(b, present)).toEqual({ opfs: true, folder: "yes" });
    expect(await (await openSessionFile(a, "report.json", p.client()))!.text()).toBe("{}");
    expect(await deleteSessionFiles(b, p.client())).toEqual({ id: "b", notDeleted: [] });
    expect(fs.existsSync(bDir)).toBe(false);
    expect(await locate(b, await folderPresence([b], p.client()))).toEqual({ opfs: false, folder: "no" });
    expect(fs.existsSync(path.join(next, "a")) || fs.existsSync(path.join(next, "b"))).toBe(false);
  });

  it("Delete names a copy it may not remove (a folder the helper never used) instead of saying it is gone", async () => {
    const stranger = path.join(tmp, "stranger", "x");
    fs.mkdirSync(stranger, { recursive: true });
    fs.writeFileSync(path.join(stranger, "report.json"), "{}");
    const r = await deleteSessionFiles(entry("x", { folderCopy: { dir: stranger } }), hostPort(handle).client());
    expect(r.notDeleted).toEqual([{ what: stranger, error: "it is in a folder the recording helper has not used, so it may not delete there" }]);
    expect(fs.existsSync(stranger)).toBe(true);
  });

  it("opens a file from the extension first, else from the folder through the helper", async () => {
    fs.mkdirSync(path.join(rec, "a"), { recursive: true });
    fs.writeFileSync(path.join(rec, "a", "report.json"), "from folder");
    const c = hostPort(handle).client();
    const r = entry("a", { folderCopy: { dir: path.join(rec, "a") } });
    expect(await (await openSessionFile(r, "report.json", c))!.text()).toBe("from folder");
    await writeFile(opfs, "sessions/a/report.json", "from opfs");
    expect(await (await openSessionFile(r, "report.json", c))!.text()).toBe("from opfs");
    expect(await openSessionFile(entry("b"), "report.json", c)).toBeNull();
  });

  it("Delete removes both copies; without the helper it says which folder to delete by hand", async () => {
    await writeFile(opfs, "sessions/a/report.json", "{}");
    const p = hostPort(handle);
    const dir = (await copySessionToFolder("a", p.client())).dir!;
    expect(await deleteSessionFiles(entry("a", { folderCopy: { dir } }), p.client())).toEqual({ id: "a", notDeleted: [] });
    expect(fs.existsSync(dir)).toBe(false);
    p.failNext("Specified native messaging host not found.");
    expect(await deleteSessionFiles(entry("a", { folderCopy: { dir } }), p.client())).toEqual({ id: "a", notDeleted: [{ what: dir, error: "the recording helper is not reachable" }] });
  });
});
