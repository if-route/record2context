// The extension's side of the native messaging host (host/record2context-host.mjs): one port, requests matched by id,
// files sent in chunks. Usable from the background and from extension pages.
import { listFiles, readFile, type DirLike } from "./fs";

export const HOST_NAME = "com.record2context.host";
/** Raw bytes per write: about 1.4 MB of JSON, far below Chrome's limit for messages to a host. */
export const WRITE_CHUNK = 1024 * 1024;
/** Raw bytes per read; the host caps it too, since its replies must stay under 1 MB. */
export const READ_CHUNK = 512 * 1024;
const TIMEOUT_MS = 30000;
const IDLE_MS = 5000;

export interface PortLike {
  postMessage(msg: unknown): void;
  disconnect(): void;
  onMessage: { addListener(fn: (msg: any) => void): void };
  onDisconnect: { addListener(fn: () => void): void };
}

/** The host could not be reached: not installed (`missing`) or it failed to start or died (`broken`). */
export class HostUnavailable extends Error {
  constructor(
    readonly kind: "missing" | "broken",
    message: string,
  ) {
    super(message);
  }
}

/** The host answered, with an error. */
export class HostRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type HostState =
  | { state: "ready"; dir: string; hostVersion: string }
  | { state: "missing"; error: string }
  | { state: "broken"; error: string; dir?: string };

export interface Heartbeat {
  extensionId: string;
  extensionVersion: string;
  buildId: string;
  reason: string;
}

/** Chrome's disconnect messages: "Specified native messaging host not found." and "...forbidden." mean not installed for us. */
export function classifyDisconnect(message: string | undefined): HostUnavailable {
  const m = message || "the recording helper closed the connection";
  return new HostUnavailable(/not found|forbidden/i.test(m) ? "missing" : "broken", m);
}

export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Byte ranges for sending `size` bytes; an empty file is still one (empty) write so it gets created. */
export function chunkRanges(size: number, chunk = WRITE_CHUNK): [number, number][] {
  if (size === 0) return [[0, 0]];
  const out: [number, number][] = [];
  for (let at = 0; at < size; at += chunk) out.push([at, Math.min(size, at + chunk)]);
  return out;
}

interface Pending {
  resolve: (reply: any) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class HostClient {
  private port: PortLike | null = null;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private idle: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly connect: () => PortLike = () => chrome.runtime.connectNative(HOST_NAME) as unknown as PortLike,
    private readonly lastError: () => string | undefined = () => chrome.runtime.lastError?.message,
    private readonly timeoutMs = TIMEOUT_MS,
    private readonly idleMs = IDLE_MS,
  ) {}

  private open(): PortLike {
    if (this.port) return this.port;
    const port = this.connect();
    this.port = port;
    port.onMessage.addListener((msg) => {
      const p = this.pending.get(msg?.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg);
      else p.reject(new HostRequestError(String(msg.code ?? "error"), String(msg.error ?? "the recording helper refused")));
      this.armIdle();
    });
    port.onDisconnect.addListener(() => {
      const err = classifyDisconnect(this.lastError());
      if (this.port === port) this.port = null;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
    });
    return port;
  }

  /** Closes the port a while after the last reply, so the host process does not linger. */
  private armIdle(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    if (this.pending.size) return;
    this.idle = setTimeout(() => this.close(), this.idleMs);
  }

  close(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    const port = this.port;
    this.port = null;
    port?.disconnect();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new HostUnavailable("broken", "connection closed"));
    }
    this.pending.clear();
  }

  request<T = Record<string, unknown>>(msg: Record<string, unknown>, timeoutMs = this.timeoutMs): Promise<T & { id: number; ok: true }> {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    return new Promise((resolve, reject) => {
      let port: PortLike;
      try {
        port = this.open();
      } catch (e) {
        reject(classifyDisconnect((e as Error).message));
        return;
      }
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HostUnavailable("broken", `the recording helper did not answer ${String(msg.op)} within ${timeoutMs / 1000} s`));
        this.close();
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        port.postMessage({ ...msg, id });
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(classifyDisconnect(this.lastError() ?? (e as Error).message));
      }
    });
  }

  /** Whether recordings can be saved now; with `heartbeat` the host also records it in its status file. */
  async status(heartbeat?: Heartbeat, timeoutMs?: number): Promise<HostState> {
    try {
      const r = await this.request<{ dir: string; dirOk: boolean; dirError?: string; hostVersion: string }>({ op: "ping", ...(heartbeat ? { heartbeat } : {}) }, timeoutMs);
      return r.dirOk ? { state: "ready", dir: r.dir, hostVersion: r.hostVersion } : { state: "broken", error: r.dirError ?? "the recordings folder cannot be written", ...(r.dir ? { dir: r.dir } : {}) };
    } catch (e) {
      if (e instanceof HostUnavailable) return e.kind === "missing" ? { state: "missing", error: e.message } : { state: "broken", error: e.message };
      return { state: "broken", error: (e as Error).message };
    }
  }

  async writeBlob(session: string, path: string, blob: Blob, chunk = WRITE_CHUNK): Promise<number> {
    const ranges = chunkRanges(blob.size, chunk);
    let size = 0;
    for (const [i, [from, to]] of ranges.entries()) {
      const data = toBase64(new Uint8Array(await blob.slice(from, to).arrayBuffer()));
      const r = await this.request<{ size: number }>({ op: "write", session, path, offset: from, data, done: i === ranges.length - 1 });
      size = r.size;
    }
    return size;
  }

  /** Sends every file of `src` (dot-files left out) into `<recordings folder>/<session>/`; returns that absolute folder. */
  async saveSession(session: string, src: DirLike, chunk = WRITE_CHUNK): Promise<{ dir: string; files: string[] }> {
    const files = (await listFiles(src)).filter((f) => !f.split("/").pop()!.startsWith("."));
    for (const f of files) {
      const blob = await readFile(src, f);
      if (!blob) throw new Error(`${f} is missing`);
      await this.writeBlob(session, f, blob, chunk);
    }
    const r = await this.request<{ dir: string }>({ op: "finish", session, files });
    return { dir: r.dir, files };
  }

  /** Session folders in the recordings folder that hold a report.json. */
  async listSessions(): Promise<{ dir: string; sessions: string[] }> {
    return this.request<{ dir: string; sessions: string[] }>({ op: "list" });
  }

  /** Which recorded session folders still hold a report.json; folders in a recordings folder the helper never used are `refused`. */
  async exists(dirs: string[]): Promise<{ found: Record<string, boolean>; refused: Record<string, string> }> {
    return this.request<{ found: Record<string, boolean>; refused: Record<string, string> }>({ op: "exists", dirs });
  }

  /** `dir` is the session folder the recording was saved to (it may be in an earlier recordings folder). */
  async readFile(session: string, path: string, type = "", dir?: string): Promise<Blob> {
    const parts: BlobPart[] = [];
    for (let offset = 0; ; ) {
      const r = await this.request<{ data: string; eof: boolean; size: number }>({ op: "read", session, path, offset, length: READ_CHUNK, ...(dir ? { dir } : {}) });
      const bytes = fromBase64(r.data);
      parts.push(bytes as unknown as BlobPart);
      offset += bytes.length;
      if (r.eof || !bytes.length) break;
    }
    return new Blob(parts, { type });
  }

  async deleteSession(session: string, dir?: string): Promise<{ dir: string; existed: boolean }> {
    return this.request<{ dir: string; existed: boolean }>({ op: "delete", session, ...(dir ? { dir } : {}) });
  }

  /** Opens the session's folder (or the recordings folder) in Finder / Explorer. */
  async reveal(session?: string, dir?: string): Promise<string> {
    return (await this.request<{ path: string }>({ op: "reveal", ...(session ? { session } : {}), ...(dir ? { dir } : {}) })).path;
  }
}
