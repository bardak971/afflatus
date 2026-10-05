import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
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

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, bytes);
  }

  async putFile(key: string, path: string): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await copyFile(path, p);
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
}
