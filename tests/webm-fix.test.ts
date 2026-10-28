import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { ID, children, concatParts, fixWebm, readHeader } from "../src/offscreen/webm-fix";

// ── Minimal EBML writer for building MediaRecorder-shaped files ──
const idB = (id: number) => {
  const out: number[] = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v & 0xff);
  return out;
};
const size = (n: number) => {
  let len = 1;
  while (n >= 2 ** (7 * len) - 1) len++;
  const out: number[] = [];
  for (let i = 0, v = n; i < len; i++, v = Math.floor(v / 256)) out.unshift(v & 0xff);
  out[0] |= 0x80 >> (len - 1);
  return out;
};
const UNKNOWN = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
const el = (id: number, payload: number[]) => [...idB(id), ...size(payload.length), ...payload];
const elUnknown = (id: number, payload: number[]) => [...idB(id), ...UNKNOWN, ...payload];
const uint = (id: number, v: number) => el(id, v < 256 ? [v] : [v >> 8, v & 0xff]);
const str = (id: number, s: string) => el(id, [...Buffer.from(s)]);
const block = (rel: number, key: boolean, bytes = 20) =>
  el(ID.SimpleBlock, [0x81, (rel >> 8) & 0xff, rel & 0xff, key ? 0x80 : 0x00, ...new Array(bytes).fill(0xab)]);

function liveWebm(): Uint8Array {
  const header = el(ID.EBML, [...uint(0x4286, 1), ...str(0x4282, "webm")]);
  const info = el(ID.Info, [...el(ID.TimecodeScale, [0x0f, 0x42, 0x40]), ...str(0x4d80, "Chrome")]);
  const tracks = el(ID.Tracks, [
    ...el(ID.TrackEntry, [
      ...uint(ID.TrackNumber, 1),
      ...uint(ID.TrackType, 1),
      ...str(0x86, "V_VP9"),
      ...el(ID.Video, [...uint(ID.PixelWidth, 1280), ...uint(ID.PixelHeight, 720)]),
    ]),
  ]);
  // Two clusters: keyframe at 0 and at 1000 ms, frames every ~33 ms, last block at 1966.
  const c1 = elUnknown(ID.Cluster, [...uint(ID.Timecode, 0), ...block(0, true), ...block(33, false), ...block(66, false)]);
  const c2 = elUnknown(ID.Cluster, [...uint(ID.Timecode, 1000), ...block(0, true), ...block(933, false), ...block(966, false)]);
  return new Uint8Array([...header, ...elUnknown(ID.Segment, [...info, ...tracks, ...c1, ...c2])]);
}

function segmentChildren(buf: Uint8Array) {
  const ebml = readHeader(buf, 0);
  const seg = readHeader(buf, ebml.dataStart + ebml.size);
  expect(seg.id).toBe(ID.Segment);
  return { seg, kids: children(buf, seg.dataStart, seg.dataStart + seg.size) };
}

describe("fixWebm", () => {
  const input = liveWebm();
  const res = fixWebm(input);
  const out = concatParts(res.parts);

  it("reads video size and duration from the stream", () => {
    expect(res).toMatchObject({ width: 1280, height: 720, clusters: 2, cues: 2 });
    expect(res.durationMs).toBe(1966 + 33);
  });

  it("writes a known Segment size covering the whole file", () => {
    const { seg } = segmentChildren(out);
    expect(seg.size).toBeGreaterThan(0);
    expect(seg.dataStart + seg.size).toBe(out.length);
  });

  it("writes Info.Duration", () => {
    const { kids } = segmentChildren(out);
    const info = kids.find((k) => k.id === ID.Info)!;
    const dur = children(out, info.dataStart, info.dataStart + info.size).find((k) => k.id === ID.Duration)!;
    expect(dur.size).toBe(8);
    expect(new DataView(out.buffer, out.byteOffset + dur.dataStart, 8).getFloat64(0)).toBe(1999);
  });

  it("gives every cluster a known size and Cues/SeekHead pointing at real elements", () => {
    const { seg, kids } = segmentChildren(out);
    expect(kids.map((k) => k.id)).toEqual([ID.SeekHead, ID.Info, ID.Tracks, ID.Cues, ID.Cluster, ID.Cluster]);
    const pos = (k: { start: number }) => k.start - seg.dataStart;

    const cues = kids.find((k) => k.id === ID.Cues)!;
    const points = children(out, cues.dataStart, cues.dataStart + cues.size);
    const clusterPositions = kids.filter((k) => k.id === ID.Cluster).map(pos);
    const cuePositions = points.map((p) => {
      const ctp = children(out, p.dataStart, p.dataStart + p.size).find((k) => k.id === ID.CueTrackPositions)!;
      const cp = children(out, ctp.dataStart, ctp.dataStart + ctp.size).find((k) => k.id === ID.CueClusterPosition)!;
      return Number(new DataView(out.buffer, out.byteOffset + cp.dataStart, 8).getBigUint64(0));
    });
    expect(cuePositions).toEqual(clusterPositions);

    const seekHead = kids[0];
    const seeks = children(out, seekHead.dataStart, seekHead.dataStart + seekHead.size).map((s) => {
      const [sid, sp] = children(out, s.dataStart, s.dataStart + s.size);
      const id = out.subarray(sid.dataStart, sid.dataStart + sid.size).reduce((a, b) => a * 256 + b, 0);
      return [id, Number(new DataView(out.buffer, out.byteOffset + sp.dataStart, 8).getBigUint64(0))];
    });
    expect(seeks).toEqual([
      [ID.Info, pos(kids[1])],
      [ID.Tracks, pos(kids[2])],
      [ID.Cues, pos(kids[3])],
    ]);
  });

  it("keeps frame data byte-identical", () => {
    const blocksOf = (buf: Uint8Array) => {
      const found: string[] = [];
      for (let i = 0; i < buf.length - 4; i++) if (buf[i] === ID.SimpleBlock && buf[i + 1] === 0x98) found.push(Buffer.from(buf.subarray(i, i + 26)).toString("hex"));
      return found;
    };
    expect(blocksOf(out)).toEqual(blocksOf(input));
  });

  it("is idempotent on an already fixed file", () => {
    const again = fixWebm(out);
    expect(again.durationMs).toBe(res.durationMs);
    expect(concatParts(again.parts)).toEqual(out);
  });

  it("survives a truncated final cluster", () => {
    const cut = input.subarray(0, input.length - 7);
    const r = fixWebm(cut);
    expect(r.clusters).toBe(2);
    // Sparse frames: the last-frame allowance is the median gap, clamped to 100 ms.
    expect(r.durationMs).toBe(1933 + 100);
  });

  it("handles a paused recording: Chrome drops paused time, so the resumed cluster continues the timeline", () => {
    // Paused at ~1000 ms; the first frame after resume is a keyframe ~110 ms later on the video clock, not seconds later.
    const header = el(ID.EBML, [...uint(0x4286, 1), ...str(0x4282, "webm")]);
    const info = el(ID.Info, [...el(ID.TimecodeScale, [0x0f, 0x42, 0x40]), ...str(0x4d80, "Chrome")]);
    const tracks = el(ID.Tracks, [...el(ID.TrackEntry, [...uint(ID.TrackNumber, 1), ...uint(ID.TrackType, 1), ...el(ID.Video, [...uint(ID.PixelWidth, 640), ...uint(ID.PixelHeight, 400)])])]);
    const before = elUnknown(ID.Cluster, [...uint(ID.Timecode, 0), ...block(0, true), ...block(500, false), ...block(980, false)]);
    const resumed = elUnknown(ID.Cluster, [...uint(ID.Timecode, 1090), ...block(0, true), ...block(33, false), ...block(400, false)]);
    const r = fixWebm(new Uint8Array([...header, ...elUnknown(ID.Segment, [...info, ...tracks, ...before, ...resumed])]));
    expect(r).toMatchObject({ clusters: 2, cues: 2, width: 640, height: 400 });
    // Last block 1490 plus the median frame gap (clamped to 100 ms).
    expect(r.durationMs).toBe(1490 + 100);
  });

  it("rejects non-WebM input", () => {
    expect(() => fixWebm(new Uint8Array([1, 2, 3, 4]))).toThrow();
  });
});

function hasFfmpeg(): boolean {
  try {
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasFfmpeg())("fixWebm with a real encoder (ffmpeg live WebM)", () => {
  it("makes ffprobe report the duration and seek correctly", () => {
    const dir = mkdtempSync(join(tmpdir(), "r2c-webm-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const live = join(dir, "live.webm");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30", "-t", "4", "-c:v", "libvpx", "-g", "30", "-live", "1", "-f", "webm", live]);
    const probe = (f: string) =>
      execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString().trim();
    expect(probe(live)).toBe("N/A");

    const fixed = join(dir, "fixed.webm");
    const r = fixWebm(new Uint8Array(readFileSync(live)));
    writeFileSync(fixed, concatParts(r.parts));
    expect(Number(probe(fixed))).toBeCloseTo(4, 1);
    expect(r.cues).toBeGreaterThan(1);
    // Decoding every frame proves the container is still valid.
    const frames = execFileSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", fixed]).toString().trim();
    expect(Number(frames)).toBe(120);
    // Seek to 3 s and grab a frame.
    execFileSync("ffmpeg", ["-v", "error", "-ss", "3", "-i", fixed, "-frames:v", "1", "-y", join(dir, "f.png")]);
  });
});
