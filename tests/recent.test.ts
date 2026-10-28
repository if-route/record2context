import { describe, expect, it } from "vitest";
import {
  NO_FOLDER_FOR_AI,
  WHERE_TEXT,
  addRecent,
  aiPointer,
  folderPath,
  hostOf,
  isGone,
  isReadable,
  needsFolderCopy,
  removeRecent,
  updateEntry,
  whereState,
  type RecentSession,
} from "../src/shared/recent";

const ID = "2026-10-22_140509_app-test";
const entry = (id: string, extra: Partial<RecentSession> = {}): RecentSession => ({
  id,
  host: "app.test",
  startedAt: new Date(2026, 9, 22, 14, 5, 9).toISOString(),
  durationMs: 83_400,
  marks: 2,
  context: "<details>…</details>",
  paths: ["AI-README.md", "context.md", "report.json", `${id}.webm`],
  ...extra,
});

describe("recent sessions", () => {
  it("puts the newest first, replaces a repeated id and keeps at most max", () => {
    let list: RecentSession[] = [];
    for (const id of ["a", "b", "c"]) list = addRecent(list, entry(id), 2);
    expect(list.map((r) => r.id)).toEqual(["c", "b"]);
    list = addRecent(list, entry("b", { marks: 5 }), 2);
    expect(list.map((r) => [r.id, r.marks])).toEqual([
      ["b", 5],
      ["c", 2],
    ]);
  });

  it("updates and removes entries by id", () => {
    const list = [entry("a"), entry("b")];
    const copy = { dir: "/Users/me/record2context-recordings/b" };
    expect(updateEntry(list, "b", { folderCopy: copy }).map((r) => r.folderCopy)).toEqual([undefined, copy]);
    expect(removeRecent(list, ["a"]).map((r) => r.id)).toEqual(["b"]);
  });

  it("Copy for my AI points at the folder the recording helper reported", () => {
    const r = entry(ID, { folderCopy: { dir: `/Users/me/my recordings ทดสอบ/${ID}` } });
    expect(aiPointer(r)).toBe(
      `Browser recording of what I did on app.test (1:23, recorded 2026-10-22 14:05): /Users/me/my recordings ทดสอบ/${ID} — read AI-README.md there for the format.`,
    );
  });

  it("has no pointer when the recording is only in the extension or the copy failed", () => {
    expect(aiPointer(entry("a"))).toBeNull();
    expect(folderPath(entry("a", { folderCopy: { error: "the recording helper is not set up" } }))).toBeNull();
    expect(folderPath(entry("a", { folderCopy: { dir: "/x/a", error: "disk full" } }))).toBeNull();
    expect(NO_FOLDER_FOR_AI).toBe("Not in the recordings folder yet: Save to folder first");
  });

  it("only recordings never copied, or whose copy failed, wait for the folder", () => {
    expect(needsFolderCopy(entry("a"))).toBe(true);
    expect(needsFolderCopy(entry("a", { folderCopy: { error: "the recording helper is not set up" } }))).toBe(true);
    expect(needsFolderCopy(entry("a", { folderCopy: { dir: "/x/a", error: "disk full" } }))).toBe(true);
    expect(needsFolderCopy(entry("a", { folderCopy: { dir: "/x/a" } }))).toBe(false);
  });

  it("names the host of the start page", () => {
    expect(hostOf("http://localhost:8080/x")).toBe("localhost:8080");
    expect(hostOf("file:///tmp/a.html")).toBe("a local file");
  });
});

describe("where a recording can be read", () => {
  it("combines the extension's copy and the folder's", () => {
    expect(whereState({ opfs: true, folder: "yes" })).toBe("both");
    expect(whereState({ opfs: true, folder: "none" })).toBe("extension");
    expect(whereState({ opfs: true, folder: "no" })).toBe("extension");
    expect(whereState({ opfs: true, folder: "unknown" })).toBe("extension-unchecked");
    expect(whereState({ opfs: false, folder: "yes" })).toBe("folder");
    expect(whereState({ opfs: false, folder: "unknown" })).toBe("folder-unchecked");
    expect(whereState({ opfs: false, folder: "no" })).toBe("missing");
    expect(whereState({ opfs: false, folder: "none" })).toBe("missing");
  });

  it("never says a file is there when it could not be read", () => {
    expect(isReadable("folder-unchecked")).toBe(false);
    expect(isReadable("missing")).toBe(false);
    expect(isReadable("extension-unchecked")).toBe(true);
    expect(Object.values(WHERE_TEXT).some((t) => /on disk/i.test(t))).toBe(false);
  });

  it("only recordings with nothing left are gone", () => {
    expect(isGone("missing")).toBe(true);
    expect(isGone("folder-unchecked")).toBe(false);
  });
});
