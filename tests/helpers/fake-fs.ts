import type { DirLike, FileLike, WritableLike } from "../../src/shared/fs";

const notFound = (name: string) => Object.assign(new Error(`${name} not found`), { name: "NotFoundError" });

/** In-memory stand-in for a FileSystemDirectoryHandle (OPFS). */
export class FakeDir implements DirLike {
  readonly kind = "directory" as const;
  dirs = new Map<string, FakeDir>();
  files = new Map<string, FakeFile>();
  /** Throws this on every write when set (e.g. a NotAllowedError). */
  failWrites: Error | null = null;
  constructor(readonly name: string, readonly root?: FakeDir) {}

  private get top(): FakeDir {
    return this.root ?? this;
  }

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeDir> {
    let d = this.dirs.get(name);
    if (!d) {
      if (!options?.create) throw notFound(name);
      d = new FakeDir(name, this.top);
      this.dirs.set(name, d);
    }
    return d;
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FakeFile> {
    let f = this.files.get(name);
    if (!f) {
      if (!options?.create) throw notFound(name);
      f = new FakeFile(name, this.top);
      this.files.set(name, f);
    }
    return f;
  }

  async removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> {
    if (this.files.delete(name)) return;
    const d = this.dirs.get(name);
    if (!d) throw notFound(name);
    if (!options?.recursive && (d.dirs.size || d.files.size)) throw Object.assign(new Error("not empty"), { name: "InvalidModificationError" });
    this.dirs.delete(name);
  }

  async *values(): AsyncIterable<DirLike | FileLike> {
    yield* this.dirs.values();
    yield* this.files.values();
  }
}

export class FakeFile implements FileLike {
  readonly kind = "file" as const;
  data = new Uint8Array(0);
  writes = 0;
  constructor(readonly name: string, private readonly top: FakeDir) {}

  async getFile(): Promise<File> {
    return new File([this.data], this.name);
  }

  async createWritable(): Promise<WritableLike> {
    const parts: Uint8Array[] = [];
    const top = this.top;
    return {
      write: async (data) => {
        if (top.failWrites) throw top.failWrites;
        this.writes++;
        if (typeof data === "string") parts.push(new TextEncoder().encode(data));
        else if (data instanceof Blob) parts.push(new Uint8Array(await data.arrayBuffer()));
        else if (data instanceof ArrayBuffer) parts.push(new Uint8Array(data));
        else parts.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      },
      close: async () => {
        const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let o = 0;
        for (const p of parts) {
          out.set(p, o);
          o += p.length;
        }
        this.data = out;
      },
      abort: async () => undefined,
    };
  }
}
