// MediaRecorder writes "live" WebM: unknown Segment/Cluster sizes, no Duration, no Cues.
// This rewrites the container (not the frames) so players show a duration and can seek.

export const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  ReferenceBlock: 0xfb,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueClusterPosition: 0xf1,
  Void: 0xec,
  Tags: 0x1254c367,
  Chapters: 0x1043a770,
  Attachments: 0x1941a469,
} as const;

const SEGMENT_CHILDREN = new Set<number>([
  ID.SeekHead,
  ID.Info,
  ID.Tracks,
  ID.Cluster,
  ID.Cues,
  ID.Tags,
  ID.Chapters,
  ID.Attachments,
]);

export interface ElementHeader {
  id: number;
  start: number;
  dataStart: number;
  /** -1 when the size is "unknown" (all value bits set). */
  size: number;
}

export function readId(buf: Uint8Array, pos: number): { id: number; length: number } {
  const first = buf[pos];
  if (first === undefined || first === 0) throw new Error(`bad element id at ${pos}`);
  const length = Math.clz32(first) - 23;
  if (length > 4 || pos + length > buf.length) throw new Error(`bad element id at ${pos}`);
  let id = 0;
  for (let i = 0; i < length; i++) id = id * 256 + buf[pos + i];
  return { id, length };
}

export function readSize(buf: Uint8Array, pos: number): { size: number; length: number } {
  const first = buf[pos];
  if (first === undefined || first === 0) throw new Error(`bad size at ${pos}`);
  const length = Math.clz32(first) - 23;
  if (pos + length > buf.length) throw new Error(`truncated size at ${pos}`);
  const mask = 0xff >> length;
  // Unknown size = all value bits set; checked on bytes because 2^56-1 is not exact in a double.
  let allOnes = (first & mask) === mask;
  let value = first & mask;
  for (let i = 1; i < length; i++) {
    const b = buf[pos + i];
    if (b !== 0xff) allOnes = false;
    value = value * 256 + b;
  }
  return { size: allOnes ? -1 : value, length };
}

export function readHeader(buf: Uint8Array, pos: number): ElementHeader {
  const { id, length: idLen } = readId(buf, pos);
  const { size, length: sizeLen } = readSize(buf, pos + idLen);
  return { id, start: pos, dataStart: pos + idLen + sizeLen, size };
}

function readUint(buf: Uint8Array, start: number, end: number): number {
  let v = 0;
  for (let i = start; i < end; i++) v = v * 256 + buf[i];
  return v;
}

/** Known-size children of [start, end). */
export function children(buf: Uint8Array, start: number, end: number): ElementHeader[] {
  const out: ElementHeader[] = [];
  let pos = start;
  while (pos < end) {
    const h = readHeader(buf, pos);
    if (h.size < 0 || h.dataStart + h.size > end) break;
    out.push(h);
    pos = h.dataStart + h.size;
  }
  return out;
}

// ── Writing ────────────────────────────────────────────────────────────────

function idBytes(id: number): Uint8Array {
  const len = id >= 0x1000000 ? 4 : id >= 0x10000 ? 3 : id >= 0x100 ? 2 : 1;
  const out = new Uint8Array(len);
  for (let i = len - 1, v = id; i >= 0; i--, v = Math.floor(v / 256)) out[i] = v & 0xff;
  return out;
}

function sizeBytes(size: number, fixedLength?: number): Uint8Array {
  let len = fixedLength ?? 1;
  if (!fixedLength) while (size >= 2 ** (7 * len) - 1) len++;
  const out = new Uint8Array(len);
  let v = size;
  for (let i = len - 1; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  out[0] |= 0x80 >> (len - 1);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function el(id: number, payload: Uint8Array): Uint8Array {
  return concat([idBytes(id), sizeBytes(payload.length), payload]);
}

/** Fixed 8-byte uint so element lengths never depend on the value (offsets settle in one pass). */
function uint8El(id: number, value: number): Uint8Array {
  const p = new Uint8Array(8);
  let v = value;
  for (let i = 7; i >= 0; i--) {
    p[i] = v % 256;
    v = Math.floor(v / 256);
  }
  return el(id, p);
}

function float64El(id: number, value: number): Uint8Array {
  const p = new Uint8Array(8);
  new DataView(p.buffer).setFloat64(0, value);
  return el(id, p);
}

// ── Fix ────────────────────────────────────────────────────────────────────

interface ClusterInfo {
  /** Offset of the cluster element in the source buffer. */
  start: number;
  childrenStart: number;
  childrenEnd: number;
  timecode: number;
  /** Absolute timecode of the first video block when that block is a keyframe. */
  keyframeTime: number | null;
}

export interface WebmFixResult {
  /** Output file as parts (large cluster payloads are views into the input, not copies). */
  parts: Uint8Array[];
  durationMs: number;
  width: number;
  height: number;
  clusters: number;
  cues: number;
  /** Every video frame's time in ms, in file order. */
  videoTimesMs: number[];
}

function parseBlock(buf: Uint8Array, dataStart: number): { track: number; rel: number; flags: number } {
  const { size: track, length } = readSize(buf, dataStart);
  const p = dataStart + length;
  const rel = ((buf[p] << 8) | buf[p + 1]) << 16 >> 16;
  return { track, rel, flags: buf[p + 2] };
}

export function fixWebm(buf: Uint8Array): WebmFixResult {
  const ebml = readHeader(buf, 0);
  if (ebml.id !== ID.EBML || ebml.size < 0) throw new Error("not an EBML file");
  const ebmlEnd = ebml.dataStart + ebml.size;
  const seg = readHeader(buf, ebmlEnd);
  if (seg.id !== ID.Segment) throw new Error("no Segment element");
  const segEnd = seg.size < 0 ? buf.length : Math.min(buf.length, seg.dataStart + seg.size);

  let info: ElementHeader | null = null;
  let tracks: ElementHeader | null = null;
  const others: ElementHeader[] = [];
  const clusters: ClusterInfo[] = [];

  let pos = seg.dataStart;
  while (pos < segEnd) {
    let h: ElementHeader;
    try {
      h = readHeader(buf, pos);
    } catch {
      break;
    }
    if (h.id === ID.Cluster) {
      const limit = h.size < 0 ? segEnd : Math.min(segEnd, h.dataStart + h.size);
      let p = h.dataStart;
      let end = p;
      while (p < limit) {
        let c: ElementHeader;
        try {
          c = readHeader(buf, p);
        } catch {
          break;
        }
        if (SEGMENT_CHILDREN.has(c.id) || c.size < 0 || c.dataStart + c.size > limit) break;
        p = end = c.dataStart + c.size;
      }
      if (end > h.dataStart) {
        clusters.push({ start: h.start, childrenStart: h.dataStart, childrenEnd: end, timecode: 0, keyframeTime: null });
      }
      const next = h.size < 0 ? end : limit;
      if (next <= h.start) break;
      pos = next;
      continue;
    }
    if (h.size < 0 || h.dataStart + h.size > segEnd) break;
    if (h.id === ID.Info) info = h;
    else if (h.id === ID.Tracks) tracks = h;
    else if (h.id !== ID.SeekHead && h.id !== ID.Cues && h.id !== ID.Void) others.push(h);
    pos = h.dataStart + h.size;
  }
  if (!info || !tracks) throw new Error("missing Info or Tracks");

  // Track info
  let videoTrack = 1;
  let width = 0;
  let height = 0;
  for (const te of children(buf, tracks.dataStart, tracks.dataStart + tracks.size)) {
    if (te.id !== ID.TrackEntry) continue;
    let num = 0;
    let type = 0;
    let w = 0;
    let hgt = 0;
    for (const c of children(buf, te.dataStart, te.dataStart + te.size)) {
      if (c.id === ID.TrackNumber) num = readUint(buf, c.dataStart, c.dataStart + c.size);
      if (c.id === ID.TrackType) type = readUint(buf, c.dataStart, c.dataStart + c.size);
      if (c.id === ID.Video) {
        for (const v of children(buf, c.dataStart, c.dataStart + c.size)) {
          if (v.id === ID.PixelWidth) w = readUint(buf, v.dataStart, v.dataStart + v.size);
          if (v.id === ID.PixelHeight) hgt = readUint(buf, v.dataStart, v.dataStart + v.size);
        }
      }
    }
    if (type === 1) {
      videoTrack = num;
      width = w;
      height = hgt;
      break;
    }
  }

  // Timing
  let scale = 1_000_000;
  const infoChildren = children(buf, info.dataStart, info.dataStart + info.size);
  for (const c of infoChildren) {
    if (c.id === ID.TimecodeScale) scale = readUint(buf, c.dataStart, c.dataStart + c.size) || scale;
  }
  let maxTc = 0;
  const videoTimes: number[] = [];
  for (const cl of clusters) {
    for (const c of children(buf, cl.childrenStart, cl.childrenEnd)) {
      if (c.id === ID.Timecode) cl.timecode = readUint(buf, c.dataStart, c.dataStart + c.size);
    }
    let firstVideo = true;
    for (const c of children(buf, cl.childrenStart, cl.childrenEnd)) {
      let block: { track: number; rel: number; flags: number } | null = null;
      let key = false;
      if (c.id === ID.SimpleBlock) {
        block = parseBlock(buf, c.dataStart);
        key = (block.flags & 0x80) !== 0;
      } else if (c.id === ID.BlockGroup) {
        const kids = children(buf, c.dataStart, c.dataStart + c.size);
        const b = kids.find((k) => k.id === ID.Block);
        if (b) block = parseBlock(buf, b.dataStart);
        key = !kids.some((k) => k.id === ID.ReferenceBlock);
      }
      if (!block) continue;
      const abs = cl.timecode + block.rel;
      maxTc = Math.max(maxTc, abs);
      if (block.track === videoTrack) {
        videoTimes.push(abs);
        if (firstVideo && key) cl.keyframeTime = abs;
        firstVideo = false;
      }
    }
  }
  const msPerTick = scale / 1_000_000;
  const deltas = videoTimes
    .slice(1)
    .map((v, i) => v - videoTimes[i])
    .filter((d) => d > 0)
    .sort((a, b) => a - b);
  // Last frame is shown for about one frame interval; clamp to sane frame rates.
  const lastFrameMs = Math.min(100, Math.max(1, deltas.length ? deltas[deltas.length >> 1] * msPerTick : 33));
  const durationMs = Math.round(maxTc * msPerTick + lastFrameMs);

  // Rebuilt elements
  const infoPayload = concat([
    ...infoChildren.filter((c) => c.id !== ID.Duration).map((c) => buf.subarray(c.start, c.dataStart + c.size)),
    float64El(ID.Duration, durationMs / msPerTick),
  ]);
  const infoEl = el(ID.Info, infoPayload);
  const tracksEl = buf.subarray(tracks.start, tracks.dataStart + tracks.size);
  const otherEls = others.map((o) => buf.subarray(o.start, o.dataStart + o.size));
  const clusterHeaders = clusters.map((cl) =>
    concat([idBytes(ID.Cluster), sizeBytes(cl.childrenEnd - cl.childrenStart, 8)]),
  );
  const cued = clusters.map((cl, i) => ({ cl, i })).filter(({ cl }) => cl.keyframeTime !== null);

  const buildCues = (positions: number[]) =>
    cued.length
      ? el(
          ID.Cues,
          concat(
            cued.map(({ cl, i }) =>
              el(
                ID.CuePoint,
                concat([
                  uint8El(ID.CueTime, cl.keyframeTime ?? 0),
                  el(ID.CueTrackPositions, concat([el(ID.CueTrack, new Uint8Array([videoTrack])), uint8El(ID.CueClusterPosition, positions[i] ?? 0)])),
                ]),
              ),
            ),
          ),
        )
      : new Uint8Array(0);
  const buildSeekHead = (infoPos: number, tracksPos: number, cuesPos: number | null) =>
    el(
      ID.SeekHead,
      concat(
        [
          [ID.Info, infoPos],
          [ID.Tracks, tracksPos],
          ...(cuesPos === null ? [] : [[ID.Cues, cuesPos]]),
        ].map(([id, p]) => el(ID.Seek, concat([el(ID.SeekID, idBytes(id)), uint8El(ID.SeekPosition, p)])))),
    );

  const seekLen = buildSeekHead(0, 0, cued.length ? 0 : null).length;
  const cuesLen = buildCues([]).length;
  const infoPos = seekLen;
  const tracksPos = infoPos + infoEl.length;
  const othersLen = otherEls.reduce((n, o) => n + o.length, 0);
  const cuesPos = tracksPos + tracksEl.length + othersLen;
  const positions: number[] = [];
  let clusterPos = cuesPos + cuesLen;
  clusters.forEach((cl, i) => {
    positions.push(clusterPos);
    clusterPos += clusterHeaders[i].length + (cl.childrenEnd - cl.childrenStart);
  });
  const seekHead = buildSeekHead(infoPos, tracksPos, cued.length ? cuesPos : null);
  const cues = buildCues(positions);
  const segmentSize = clusterPos;

  const parts: Uint8Array[] = [
    buf.subarray(0, ebmlEnd),
    concat([idBytes(ID.Segment), sizeBytes(segmentSize, 8)]),
    seekHead,
    infoEl,
    tracksEl,
    ...otherEls,
    cues,
  ];
  clusters.forEach((cl, i) => parts.push(clusterHeaders[i], buf.subarray(cl.childrenStart, cl.childrenEnd)));

  return { parts, durationMs, width, height, clusters: clusters.length, cues: cued.length, videoTimesMs: videoTimes.map((v) => v * msPerTick) };
}

export function concatParts(parts: Uint8Array[]): Uint8Array {
  return concat(parts);
}
