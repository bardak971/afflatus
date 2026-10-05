import { PassThrough, type Readable } from "node:stream";
import { crcUpdate } from "./zip";

/**
 * A zip written as it goes, for a backup of many gigabytes: each file is streamed in once, stored as it is
 * (pictures and videos do not compress), its checksum and size written after it in a data descriptor,
 * and the central directory at the end. Zip64 where it is needed: an entry whose size is not known ahead
 * or passes 4 GB gets the zip64 extra field in its local header and an 8-byte-sized descriptor, a
 * central-directory entry whose size or offset passes 4 GB carries the zip64 extra, and the zip64 end
 * record and its locator are written when anything did; a small backup stays a plain zip.
 *
 * The reader can go away half way (the download was cancelled): a write then fails instead of waiting
 * for room that never comes, so the producer stops and releases what it holds.
 */
const LIMIT32 = 0xffffffff;
const LIMIT16 = 0xffff;

export class ZipStream {
  readonly out = new PassThrough();
  private offset = 0;
  private readonly central: Buffer[] = [];
  private count = 0;
  private zip64 = false;
  private failed: Error | null = null;

  constructor() {
    const gone = (err?: Error) => {
      this.failed ??= err ?? new Error("the download was cancelled before the end");
    };
    this.out.on("error", gone);
    this.out.on("close", () => {
      if (!this.out.writableFinished) gone();
    });
  }

  private write(b: Buffer): Promise<void> {
    if (this.failed) return Promise.reject(this.failed);
    this.offset += b.length;
    if (this.out.write(b)) return Promise.resolve();
    return new Promise((done, fail) => {
      const stop = () => {
        this.out.off("drain", ok).off("close", broke).off("error", broke);
      };
      const ok = () => {
        stop();
        done();
      };
      const broke = (err?: Error) => {
        stop();
        fail(this.failed ?? err ?? new Error("the download was cancelled before the end"));
      };
      this.out.once("drain", ok).once("close", broke).once("error", broke);
    });
  }

  /**
   * One file: its name inside the zip and a stream of its bytes. `size`, when known, says whether the
   * entry can be a plain one; an entry of unknown size is written as zip64 so that it can hold anything.
   */
  async add(name: string, source: Readable, mtime = new Date(), size?: number): Promise<void> {
    const nameBytes = Buffer.from(name.replace(/\\/g, "/"), "utf8");
    const start = this.offset;
    const year = Math.max(1980, mtime.getFullYear());
    const time = (mtime.getHours() << 11) | (mtime.getMinutes() << 5) | Math.floor(mtime.getSeconds() / 2);
    const date = ((year - 1980) << 9) | ((mtime.getMonth() + 1) << 5) | mtime.getDate();
    const wide = size === undefined || size >= LIMIT32 || start >= LIMIT32;
    // the zip64 extra of a local header holds both sizes (zero here: the descriptor has them) and marks the entry as one with an 8-byte descriptor
    const extra = wide ? Buffer.alloc(20) : Buffer.alloc(0);
    if (wide) {
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(16, 2);
    }
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(wide ? 45 : 20, 4);
    local.writeUInt16LE(0x0808, 6); // bit 3: sizes and crc follow the data; bit 11: UTF-8 name
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(wide ? LIMIT32 : 0, 18);
    local.writeUInt32LE(wide ? LIMIT32 : 0, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(extra.length, 28);
    await this.write(Buffer.concat([local, nameBytes, extra]));
    // the bytes, with a running checksum
    let crc = 0xffffffff;
    let written = 0;
    try {
      for await (const chunk of source) {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        crc = crcUpdate(crc, b);
        written += b.length;
        await this.write(b);
      }
    } finally {
      // a write that failed leaves the loop by its error: the source is let go of
      source.destroy();
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    if (!wide && written >= LIMIT32) throw new Error(`${name} is larger than it was said to be: the backup cannot hold it as a plain entry`);
    const desc = Buffer.alloc(wide ? 24 : 16);
    desc.writeUInt32LE(0x08074b50, 0);
    desc.writeUInt32LE(crc, 4);
    if (wide) {
      desc.writeBigUInt64LE(BigInt(written), 8);
      desc.writeBigUInt64LE(BigInt(written), 16);
    } else {
      desc.writeUInt32LE(written, 8);
      desc.writeUInt32LE(written, 12);
    }
    await this.write(desc);

    // the central entry: a size or an offset that does not fit its 4 bytes goes in the zip64 extra, in that order
    const bigSize = written >= LIMIT32;
    const bigStart = start >= LIMIT32;
    const fields: bigint[] = [];
    if (bigSize) fields.push(BigInt(written), BigInt(written));
    if (bigStart) fields.push(BigInt(start));
    const dirExtra = Buffer.alloc(fields.length ? 4 + 8 * fields.length : 0);
    if (fields.length) {
      dirExtra.writeUInt16LE(0x0001, 0);
      dirExtra.writeUInt16LE(8 * fields.length, 2);
      fields.forEach((v, i) => dirExtra.writeBigUInt64LE(v, 4 + 8 * i));
      this.zip64 = true;
    }
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(45, 4);
    dir.writeUInt16LE(wide || fields.length ? 45 : 20, 6);
    dir.writeUInt16LE(0x0808, 8);
    dir.writeUInt16LE(0, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(date, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(bigSize ? LIMIT32 : written, 20);
    dir.writeUInt32LE(bigSize ? LIMIT32 : written, 24);
    dir.writeUInt16LE(nameBytes.length, 28);
    dir.writeUInt16LE(dirExtra.length, 30);
    dir.writeUInt16LE(0, 32);
    dir.writeUInt16LE(0, 34);
    dir.writeUInt16LE(0, 36);
    dir.writeUInt32LE(0, 38);
    dir.writeUInt32LE(bigStart ? LIMIT32 : start, 42);
    this.central.push(dir, nameBytes, dirExtra);
    this.count++;
  }

  /** The central directory and the end record (the zip64 ones first when they are needed); the stream ends. */
  async finish(): Promise<void> {
    const dirStart = this.offset;
    for (const b of this.central) await this.write(b);
    const dirSize = this.offset - dirStart;
    const zip64 = this.zip64 || this.count >= LIMIT16 || dirSize >= LIMIT32 || dirStart >= LIMIT32;
    if (zip64) {
      const z64At = this.offset;
      const z64 = Buffer.alloc(56);
      z64.writeUInt32LE(0x06064b50, 0);
      z64.writeBigUInt64LE(BigInt(44), 4); // the record's size after this field
      z64.writeUInt16LE(45, 12);
      z64.writeUInt16LE(45, 14);
      z64.writeUInt32LE(0, 16);
      z64.writeUInt32LE(0, 20);
      z64.writeBigUInt64LE(BigInt(this.count), 24);
      z64.writeBigUInt64LE(BigInt(this.count), 32);
      z64.writeBigUInt64LE(BigInt(dirSize), 40);
      z64.writeBigUInt64LE(BigInt(dirStart), 48);
      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(0x07064b50, 0);
      locator.writeUInt32LE(0, 4);
      locator.writeBigUInt64LE(BigInt(z64At), 8);
      locator.writeUInt32LE(1, 16);
      await this.write(Buffer.concat([z64, locator]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(Math.min(this.count, LIMIT16), 8);
    end.writeUInt16LE(Math.min(this.count, LIMIT16), 10);
    end.writeUInt32LE(Math.min(dirSize, LIMIT32), 12);
    end.writeUInt32LE(Math.min(dirStart, LIMIT32), 16);
    end.writeUInt16LE(0, 20);
    await this.write(end);
    this.out.end();
  }

  /** The stream is given up half way (the source failed): nothing more is written, and the reader is told. */
  abort(err?: Error): void {
    this.failed ??= err ?? new Error("the backup was given up");
    this.out.destroy(err);
  }
}
