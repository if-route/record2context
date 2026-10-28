import { describe, expect, it } from "vitest";
import { dirAt, hasFile, listFiles, readFile, removePath, writeFile } from "../src/shared/fs";
import { FakeDir } from "./helpers/fake-fs";

const text = async (d: FakeDir, p: string) => (await readFile(d, p))?.text();

describe("storage layer (OPFS-shaped handles)", () => {
  it("writes text, blobs and streams, creating parents, and reads them back", async () => {
    const root = new FakeDir("sessions");
    expect(await writeFile(root, "s1/report.json", '{"a":1}')).toBe(7);
    await writeFile(root, "s1/screenshots/01.png", new Blob([new Uint8Array([1, 2, 3])]));
    const chunks = [new Uint8Array([4, 5]), new Uint8Array([6])];
    const stream = new ReadableStream<Uint8Array>({ start: (c) => (chunks.forEach((x) => c.enqueue(x)), c.close()) });
    expect(await writeFile(root, "s1/s1.webm", stream)).toBe(3);
    expect(await text(root, "s1/report.json")).toBe('{"a":1}');
    expect([...new Uint8Array(await (await readFile(root, "s1/s1.webm"))!.arrayBuffer())]).toEqual([4, 5, 6]);
    expect(await listFiles((await dirAt(root, "s1"))!)).toEqual(["report.json", "s1.webm", "screenshots/01.png"]);
  });

  it("writes a blob as the chunks its stream gives, not one copy", async () => {
    const root = new FakeDir("r");
    const big = new Blob([new Uint8Array(100_000).fill(1), new Uint8Array(200_000).fill(2)]);
    let chunks = 0;
    for (const reader = big.stream().getReader(); !(await reader.read()).done; ) chunks++;
    await writeFile(root, "v.webm", big);
    const f = root.files.get("v.webm")!;
    expect(f.data.length).toBe(300_000);
    expect([f.data[0], f.data[299_999]]).toEqual([1, 2]);
    expect(f.writes).toBe(chunks);
  });

  it("missing files and folders are null / false, never a throw", async () => {
    const root = new FakeDir("r");
    expect(await readFile(root, "nope/report.json")).toBeNull();
    expect(await hasFile(root, "a.txt")).toBe(false);
    expect(await dirAt(root, "x/y")).toBeNull();
    expect(await removePath(root, "x")).toBe(false);
  });

  it("replaces a file on rewrite and removes folders recursively", async () => {
    const root = new FakeDir("r");
    await writeFile(root, "s/a.txt", "one");
    await writeFile(root, "s/a.txt", "two");
    expect(await text(root, "s/a.txt")).toBe("two");
    expect(await removePath(root, "s")).toBe(true);
    expect(await listFiles(root)).toEqual([]);
  });
});
