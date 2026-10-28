// Offscreen document: owns the tab MediaStream and MediaRecorder, so page reloads and service-worker restarts never
// touch the recording. Each second of video is appended to a file in the extension's storage (OPFS) as it arrives; Stop
// fixes the container and writes `<id>.webm` next to it, so the video is never held in memory while recording.
import { syncClock, type FrameSeen, type HudTick, type RecorderCalls } from "../shared/clock-sync";
import { readFile, removePath, writeFile, type DirLike, type WritableLike } from "../shared/fs";
import type { OffscreenPauseReply, OffscreenStartReply, OffscreenStopReply, ToOffscreen } from "../shared/messages";
import { opfsSession } from "../shared/store";
import { fixWebm } from "./webm-fix";

const KEYFRAME_INTERVAL_MS = 1000;
// Capture runs at 60 fps so the frame log sees every frame the page draws (a HUD change then shows in the very next
// captured frame, so each lag sample is exact); the recorder's own track is limited to 30 fps.
const CAPTURE_FPS = 60;
const VIDEO_FPS = 30;
const STOP_TIMEOUT_MS = 10_000;

const RAW_FILE = ".recording.webm";

let recorder: MediaRecorder | null = null;
let stream: MediaStream | null = null;
let sessionId = "";
let sessionDir: DirLike | null = null;
let rawOut: WritableLike | null = null;
// Chunks are appended one at a time, in order.
let writes: Promise<void> = Promise.resolve();
let writeError = "";
let mimeType = "";
let lastResult: OffscreenStopReply | null = null;
let stopping: Promise<OffscreenStopReply> | null = null;

// Every captured frame's timestamp, read from a clone of the track, so stop can line them up with the file's frames.
let frames: FrameSeen[] = [];
let calls: RecorderCalls = { startCall: 0, start: 0, pauses: [] };
let frameTrack: MediaStreamTrack | null = null;
let frameError = "";
let ticks: HudTick[] = [];
let frameSize = { width: 0, height: 0 };
// Where the HUD timer is in frame pixels (even, for I420), so each frame can tell whether its digits changed.
type Spot = { key: string; rect: { x: number; y: number; width: number; height: number } };
let spot = null as Spot | null;
let spotBuf = new Uint8Array(0);
let onFrame: (() => void) | null = null;
const now = () => performance.timeOrigin + performance.now();

interface TrackProcessor {
  readable: ReadableStream<VideoFrame>;
}
declare const MediaStreamTrackProcessor: { new (init: { track: MediaStreamTrack }): TrackProcessor } | undefined;

/** The HUD timer changed at `at`; `rect` is CSS px in a viewport of `viewport` (mapped like report.json's formula). */
function onTick(at: number, rect: { x: number; y: number; width: number; height: number }, viewport: { width: number; height: number }): void {
  const { width: fw, height: fh } = frameSize;
  if (!fw || !viewport.width || !viewport.height) return;
  const k = Math.min(fw / viewport.width, fh / viewport.height);
  const ox = (fw - viewport.width * k) / 2;
  const oy = (fh - viewport.height * k) / 2;
  const even = (n: number) => Math.max(0, Math.floor(n / 2) * 2);
  const x = even(ox + rect.x * k);
  const y = even(oy + rect.y * k);
  const w = Math.min(fw - x, even(rect.width * k + 2));
  const h = Math.min(fh - y, even(rect.height * k + 2));
  if (w < 2 || h < 2) return;
  const key = `${x},${y},${w},${h}`;
  if (spot?.key !== key) {
    spot = { key, rect: { x, y, width: w, height: h } };
    spotBuf = new Uint8Array(w * h * 2);
  }
  ticks.push({ at, spot: key });
}

function logFrames(track: MediaStreamTrack): void {
  frames = [];
  ticks = [];
  spot = null;
  frameError = "";
  if (typeof MediaStreamTrackProcessor === "undefined") {
    frameError = "MediaStreamTrackProcessor unavailable";
    return;
  }
  frameTrack = track.clone();
  const reader = new MediaStreamTrackProcessor({ track: frameTrack }).readable.getReader();
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        const f: FrameSeen = { ts: value.timestamp / 1000, arrival: now() };
        const at = spot as Spot | null;
        if (at) {
          try {
            const layout = await value.copyTo(spotBuf, { rect: at.rect });
            const y = layout[0]!;
            let sum = 0;
            for (let r = 0; r < at.rect.height; r++) for (let c = 0; c < at.rect.width; c++) sum += spotBuf[y.offset + r * y.stride + c]!;
            f.spot = at.key;
            f.sum = sum;
          } catch {
            // A rect the frame cannot give (resized tab) only costs this frame its lag sample.
          }
        }
        frames.push(f);
        value.close();
        onFrame?.();
      }
    } catch (e) {
      frameError = `frame log: ${(e as Error).message}`;
    }
  })();
}

/** Resolves on the next frame (or after `ms`): starting right after one leaves a whole frame interval before the next. */
function nextFrame(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => ((onFrame = null), resolve()), ms);
    onFrame = () => {
      clearTimeout(timer);
      onFrame = null;
      resolve();
    };
  });
}

function pickMime(): string {
  for (const t of ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

async function start(id: string, streamId: string, width: number, height: number): Promise<OffscreenStartReply> {
  if (recorder) return { ok: false, error: "already recording" };
  lastResult = null;
  stopping = null;
  sessionId = id;
  writeError = "";
  writes = Promise.resolve();
  try {
    sessionDir = await opfsSession(id, true);
    rawOut = await (await sessionDir!.getFileHandle(RAW_FILE, { create: true })).createWritable();
  } catch (e) {
    return { ok: false, error: `extension storage unavailable: ${(e as Error).message}` };
  }
  try {
    // min == max pins the frame size so viewport -> video pixel mapping stays a fixed scale.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
          minWidth: width,
          maxWidth: width,
          minHeight: height,
          maxHeight: height,
          maxFrameRate: CAPTURE_FPS,
        },
      } as MediaTrackConstraints,
    });
  } catch (e) {
    return { ok: false, error: `tab capture failed: ${(e as Error).message}` };
  }
  const track = stream.getVideoTracks()[0]!;
  frameSize = { width, height };
  logFrames(track);
  await track.applyConstraints({ frameRate: { max: VIDEO_FPS } }).catch(() => undefined);
  mimeType = pickMime();
  const opts: MediaRecorderOptions & { videoKeyFrameIntervalDuration?: number } = {
    mimeType,
    videoBitsPerSecond: 3_000_000,
    // Regular keyframes keep seeking and frame extraction accurate.
    videoKeyFrameIntervalDuration: KEYFRAME_INTERVAL_MS,
  };
  const rec = new MediaRecorder(stream, opts);
  recorder = rec;
  rec.ondataavailable = (e) => {
    if (!e.data || e.data.size === 0) return;
    const data = e.data;
    writes = writes.then(async () => {
      if (!writeError) await rawOut?.write(data);
    }).catch((err: Error) => void (writeError ||= err.message));
  };
  stream.getVideoTracks()[0]?.addEventListener("ended", () => {
    void chrome.runtime.sendMessage({ kind: "rec-ended", reason: "capture-ended" }).catch(() => undefined);
  });
  calls = { startCall: 0, start: 0, pauses: [] };
  await nextFrame(100);
  const started = new Promise<number>((resolve) =>
    rec.addEventListener(
      "start",
      () => {
        calls.start = now();
        resolve(Date.now());
      },
      { once: true },
    ),
  );
  calls.startCall = now();
  rec.start(1000);
  const videoStart = await started;
  return { ok: true, videoStart, mimeType: mimeType || rec.mimeType };
}

async function finish(): Promise<OffscreenStopReply> {
  const rec = recorder;
  if (!rec) return lastResult ?? { ok: false, error: "not recording" };
  if (rec.state !== "inactive") {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, STOP_TIMEOUT_MS);
      rec.addEventListener(
        "stop",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      try {
        rec.requestData();
        rec.stop();
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }
  stream?.getTracks().forEach((t) => t.stop());
  frameTrack?.stop();
  frameTrack = null;
  recorder = null;
  stream = null;
  const type = (mimeType || "video/webm").split(";")[0];
  await writes;
  await rawOut?.close().catch((e: Error) => void (writeError ||= e.message));
  rawOut = null;
  const dir = sessionDir;
  const raw = dir ? await readFile(dir, RAW_FILE).catch(() => null) : null;
  if (!dir || !raw || writeError) return (lastResult = { ok: false, error: `video not saved: ${writeError || "no file"}` });
  if (raw.size === 0) return (lastResult = { ok: false, error: "recording is empty" });

  // Disk-backed until read: the raw file is loaded once here to rewrite the container.
  let out: Blob = raw;
  let result: OffscreenStopReply = { ok: true, mimeType: type, seekableFix: false };
  try {
    const fixed = fixWebm(new Uint8Array(await raw.arrayBuffer()));
    out = new Blob(fixed.parts as BlobPart[], { type });
    result = { ...result, durationMs: fixed.durationMs, width: fixed.width, height: fixed.height, seekableFix: true };
    const sync = frameError ? null : syncClock(frames, calls, fixed.videoTimesMs, ticks);
    if (sync) result.sync = sync;
    else result.syncError = frameError || "frames did not line up with the file";
  } catch (e) {
    // Keep the playable original rather than losing the recording.
    result.fixError = (e as Error).message;
    result.syncError = "no frame times without the WebM fix";
  }
  frames = [];
  try {
    result.sizeBytes = await writeFile(dir, `${sessionId}.webm`, out);
    await removePath(dir, RAW_FILE);
  } catch (e) {
    return (lastResult = { ok: false, error: `video not saved: ${(e as Error).message}` });
  }
  result.file = `${sessionId}.webm`;
  lastResult = result;
  return result;
}

/** `at` is taken at the call: Chrome's muxer leaves out the time from pause() to resume(). */
function setPaused(paused: boolean): OffscreenPauseReply {
  const rec = recorder;
  if (!rec || rec.state === "inactive") return { ok: false, error: "not recording" };
  try {
    if (paused && rec.state === "recording") {
      const at = Date.now();
      calls.pauses.push({ pause: now() });
      rec.pause();
      return { ok: true, at };
    }
    if (!paused && rec.state === "paused") {
      const at = Date.now();
      const open = calls.pauses[calls.pauses.length - 1];
      if (open) open.resume = now();
      rec.resume();
      return { ok: true, at };
    }
    return { ok: false, error: `recorder is ${rec.state}` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

chrome.runtime.onMessage.addListener((msg: ToOffscreen, _sender, sendResponse) => {
  if (msg?.target !== "offscreen") return false;
  if (msg.kind === "rec-start") {
    start(msg.id, msg.streamId, msg.width, msg.height).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.kind === "rec-stop") {
    // A repeated stop (e.g. after a service-worker restart) gets the same result, not a second file.
    stopping ??= finish();
    stopping.then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.kind === "rec-pause" || msg.kind === "rec-resume") {
    sendResponse(setPaused(msg.kind === "rec-pause"));
    return false;
  }
  if (msg.kind === "rec-tick") {
    onTick(msg.at, msg.rect, msg.viewport);
    return false;
  }
  return false;
});
