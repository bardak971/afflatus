import { createReadStream } from "node:fs";
import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";

/** Where files live: a folder on a PC, an S3 bucket on a cluster. Keys are "a/b/c.ext", made by the server. */
export interface Storage {
  put(key: string, bytes: Uint8Array): Promise<void>;
  /** The same from a file already on this machine's disk (an upload written as it arrived): copied, not read into memory. */
  putFile(key: string, path: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  /** For serving: the size, and a stream of the whole file or of one byte range (both ends included). */
  open(key: string, range?: { start: number; end: number }): Promise<{ size: number; stream: Readable }>;
  size(key: string): Promise<number>;
  delete(key: string): Promise<void>;
  /**
   * Where the file is on this machine's disk, for a tool that reads it there (ffmpeg) instead of from bytes held in memory;
   * null when it is not on a disk here (a bucket). Left out: never on a disk here.
   */
  localPath?(key: string): string | null;
  /**
   * Every file whose key starts with `prefix` ("assets/"), and when it was last written, read only when asked: the orphan
   * sweep needs it of the few files no item names, and a read of it for every file was 18,820 stats an hour at scale.
   * Null: the file went meanwhile. Left out: the storage cannot list.
   */
  list?(prefix: string): AsyncIterable<{ key: string; mtimeMs(): Promise<number | null> }>;
  /** Hold deletions until the function answered is called (see RoutedStorage.hold). Left out: deletions are never held. */
  hold?(): () => Promise<void>;
  /** A text that changes when the file under a key changes, for a key whose file can change (a linked folder's); null for the others. */
  version?(key: string): Promise<string | null>;
}

/** A stored file as ffmpeg can be handed it: its path on the disk when it has one, else its bytes. */
export async function sourceOf(storage: Storage, key: string): Promise<string | Uint8Array> {
  return storage.localPath?.(key) ?? (await storage.get(key));
}

/**
 * A rename over a file. On Windows two at once onto the same name (the same frame asked twice, two tabs measuring one
 * video), or one while the file is being read, can find the target held for a moment and fail with EPERM, EACCES or
 * EBUSY: tried again a few times, shortly after, as the other is done by then.
 */
export async function renameOver(from: string, to: string): Promise<void> {
  for (let tries = 0; ; tries++) {
    try {
      return await rename(from, to);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (tries >= 8 || (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY")) throw err;
      await new Promise((r) => setTimeout(r, 10 * 2 ** Math.min(tries, 5)));
    }
  }
}

export class LocalStorage implements Storage {
  private readonly root: string;

  constructor(dir: string) {
    this.root = resolve(dir);
  }

  /** Keys come from the server, but a key must still never leave the folder. */
  private path(key: string): string {
    const p = resolve(this.root, key);
    if (p !== this.root && !p.startsWith(this.root + sep)) throw new Error(`bad storage key: ${key}`);
    return p;
  }

  /**
   * Written beside the file under a passing name, then renamed over it: a write stopped half way (a full disk, the server
   * stopped) never leaves half a file under the key, which a cache (motion, strips) would then read as a whole one for good.
   */
  async put(key: string, bytes: Uint8Array): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await this.landed(p, (tmp) => writeFile(tmp, bytes));
  }

  async putFile(key: string, path: string): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await this.landed(p, (tmp) => copyFile(path, tmp));
  }

  private async landed(p: string, write: (tmp: string) => Promise<void>): Promise<void> {
    const tmp = `${p}.${randomBytes(4).toString("hex")}.part`;
    try {
      await write(tmp);
      await renameOver(tmp, p);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  async *list(prefix: string): AsyncIterable<{ key: string; mtimeMs(): Promise<number | null> }> {
    // a folder at a time (a few hundred names at most, each item folder sharded by its id's first two letters): the walk
    // gives the event loop back between two, where one read of the whole tree held it for up to 47 ms at scale
    const walk = async function* (dir: string, root: string): AsyncGenerator<{ key: string; mtimeMs(): Promise<number | null> }> {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) yield* walk(full, root);
        else if (e.isFile()) yield { key: relative(root, full).split(sep).join("/"), mtimeMs: () => stat(full).then((s) => s.mtimeMs, () => null) };
      }
    };
    yield* walk(this.path(prefix), this.root);
  }

  async get(key: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.path(key)));
  }

  async size(key: string): Promise<number> {
    return (await stat(this.path(key))).size;
  }

  async open(key: string, range?: { start: number; end: number }) {
    const p = this.path(key);
    const size = (await stat(p)).size;
    return { size, stream: createReadStream(p, range) as Readable };
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  localPath(key: string): string | null {
    return this.path(key);
  }
}
