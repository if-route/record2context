import { describe, expect, it } from "vitest";
import { listFiles, readFile, writeFile } from "../src/shared/fs";
import { markFile, markOriginalFile, placeMarkImages, readmeFor } from "../src/shared/layout";
import { FakeDir } from "./helpers/fake-fs";

const text = async (d: FakeDir, p: string) => (await readFile(d, p))?.text();

describe("recording layout", () => {
  it("a Screenshot without shapes keeps its plain frame at the top, nothing in details", async () => {
    const d = new FakeDir("s");
    await writeFile(d, markFile(1), "plain");
    expect(await placeMarkImages(d, 1, markFile(1), null)).toEqual({ file: "screenshot-01.png" });
    expect(await listFiles(d)).toEqual(["screenshot-01.png"]);
  });

  it("a Screenshot with shapes: the drawn copy at the top, the plain frame in details/screenshots", async () => {
    const d = new FakeDir("s");
    await writeFile(d, markFile(2), "plain");
    expect(await placeMarkImages(d, 2, markFile(2), new Blob(["drawn"]))).toEqual({ file: markOriginalFile(2), annotatedFile: "screenshot-02.png" });
    expect(await text(d, "screenshot-02.png")).toBe("drawn");
    expect(await text(d, "details/screenshots/screenshot-02-original.png")).toBe("plain");
  });

  it("re-edited after a reload: drawn again replaces the top copy; no shapes puts the plain frame back on top", async () => {
    const d = new FakeDir("s");
    await writeFile(d, markFile(3), "plain");
    const first = await placeMarkImages(d, 3, markFile(3), new Blob(["drawn"]));
    expect(await placeMarkImages(d, 3, first.file, new Blob(["drawn2"]))).toEqual({ file: markOriginalFile(3), annotatedFile: "screenshot-03.png" });
    expect(await text(d, "screenshot-03.png")).toBe("drawn2");
    expect(await placeMarkImages(d, 3, markOriginalFile(3), null)).toEqual({ file: "screenshot-03.png" });
    expect(await text(d, "screenshot-03.png")).toBe("plain");
    expect(await listFiles(d)).toEqual(["screenshot-03.png"]);
  });

  it("when the drawn copy cannot be written, the plain frame stays on top and no extra copy is left", async () => {
    const d = new FakeDir("s");
    await writeFile(d, markFile(4), "plain");
    let writes = 0;
    const realGet = d.getFileHandle.bind(d);
    d.getFileHandle = async (name, opts) => {
      const f = await realGet(name, opts);
      if (name === "screenshot-04.png" && opts?.create && ++writes === 1) d.failWrites = new Error("quota");
      return f;
    };
    expect(await placeMarkImages(d, 4, markFile(4), new Blob(["drawn"]))).toEqual({ file: "screenshot-04.png" });
    d.failWrites = null;
    expect(await text(d, "screenshot-04.png")).toBe("plain");
    expect(await listFiles(d)).toEqual(["screenshot-04.png"]);
  });

  it("Copy for my AI's entry file: details/AI-README.md, or AI-README.md for the old layout", () => {
    expect(readmeFor(["details/AI-README.md", "details/report.json", "x.webm"])).toBe("details/AI-README.md");
    expect(readmeFor(["AI-README.md", "report.json"])).toBe("AI-README.md");
    expect(readmeFor(undefined)).toBe("AI-README.md");
  });
});
