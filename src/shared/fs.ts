// The subset of the File System Access API the extension uses on its own storage (OPFS), typed structurally so the
// in-memory fake in tests is interchangeable. Real handles are cast with `asDir`.

export interface WritableLike {
  write(data: string | Blob | ArrayBuffer | ArrayBufferView): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
}

export interface FileLike {
  readonly kind: "file";
  readonly name: string;
  getFile(): Promise<File>;
  createWritable(options?: { keepExistingData?: boolean }): Promise<WritableLike>;
}

export interface DirLike {
  readonly kind: "directory";
  readonly name: string;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirLike>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileLike>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  values(): AsyncIterable<DirLike | FileLike>;
}

export function asDir(handle: unknown): DirLike {
  return handle as DirLike;
}

const isNotFound = (e: unknown) => (e as { name?: string })?.name === "NotFoundError" || (e as { name?: string })?.name === "TypeMismatchError";

export function splitPath(path: string): string[] {
  return path.split("/").filter((p) => p && p !== ".");
}

/** The directory at `path` under `root`; null when it does not exist and `create` is false. */
export async function dirAt(root: DirLike, path: string | string[], create = false): Promise<DirLike | null> {
  let dir = root;
  for (const part of Array.isArray(path) ? path : splitPath(path)) {
    try {
      dir = await dir.getDirectoryHandle(part, { create });
    } catch (e) {
      if (!create && isNotFound(e)) return null;
      throw e;
    }
  }
  return dir;
}

async function fileHandleAt(root: DirLike, path: string, create: boolean): Promise<FileLike | null> {
  const parts = splitPath(path);
  const name = parts.pop();
  if (!name) throw new Error(`not a file path: ${path}`);
  const dir = await dirAt(root, parts, create);
  if (!dir) return null;
  try {
    return await dir.getFileHandle(name, { create });
  } catch (e) {
    if (!create && isNotFound(e)) return null;
    throw e;
  }
}

/** Writes `data` to `path` (parents created), replacing any file there. Streams and blobs are written chunk by chunk. */
export async function writeFile(root: DirLike, path: string, data: string | Blob | ReadableStream<Uint8Array>): Promise<number> {
  const handle = (await fileHandleAt(root, path, true))!;
  const out = await handle.createWritable();
  let size = 0;
  try {
    if (typeof data === "string") {
      const bytes = new TextEncoder().encode(data);
      size = bytes.length;
      await out.write(bytes);
    } else {
      const reader = (data instanceof Blob ? data.stream() : data).getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        await out.write(value);
      }
    }
    await out.close();
  } catch (e) {
    await out.abort?.(e).catch(() => undefined);
    throw e;
  }
  return size;
}

/** The file at `path`, or null when it (or a parent) does not exist. */
export async function readFile(root: DirLike, path: string): Promise<File | null> {
  const handle = await fileHandleAt(root, path, false);
  return handle ? handle.getFile() : null;
}

export async function hasFile(root: DirLike, path: string): Promise<boolean> {
  return (await fileHandleAt(root, path, false)) !== null;
}

/** Every file under `dir`, as `a/b.png` paths, sorted. */
export async function listFiles(dir: DirLike, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of dir.values()) {
    if (entry.kind === "file") out.push(prefix + entry.name);
    else out.push(...(await listFiles(entry, `${prefix}${entry.name}/`)));
  }
  return out.sort();
}

/** Removes the file or directory (recursively) at `path`; false when it was not there. */
export async function removePath(root: DirLike, path: string): Promise<boolean> {
  const parts = splitPath(path);
  const name = parts.pop();
  if (!name) return false;
  const dir = await dirAt(root, parts);
  if (!dir) return false;
  try {
    await dir.removeEntry(name, { recursive: true });
    return true;
  } catch (e) {
    if (isNotFound(e)) return false;
    throw e;
  }
}
