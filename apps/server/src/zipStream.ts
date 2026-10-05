import { PassThrough, type Readable } from "node:stream";
import { crc32 } from "./zip";

/**
 * A zip written as it goes, for a backup of many gigabytes: each file is streamed in once, stored as it is
 * (pictures and videos do not compress), its checksum and size written after it in a data descriptor,
 * and the central directory at the end. Plain zip; no zip64, so each file and the whole stay under 4 GB
 * per entry and 4 GB offsets, which fits a library backup split by folders if ever needed.
 */
export class ZipStream {
  readonly out = new PassThrough();
  private offset = 0;
  private readonly central: Buffer[] = [];
  private count = 0;

  private write(b: Buffer): Promise<void> {
    this.offset += b.length;
    if (this.out.write(b)) return Promise.resolve();
    return new Promise((r) => this.out.once("drain", r));
  }

  /** One file: its name inside the zip and a stream of its bytes. */
  async add(name: string, source: Readable, mtime = new Date()): Promise<void> {
    const nameBytes = Buffer.from(name.replace(/\\/g, "/"), "utf8");
    const start = this.offset;
    const year = Math.max(1980, mtime.getFullYear());
    const time = (mtime.getHours() << 11) | (mtime.getMinutes() << 5) | Math.floor(mtime.getSeconds() / 2);
    const date = ((year - 1980) << 9) | ((mtime.getMonth() + 1) << 5) | mtime.getDate();
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0808, 6); // bit 3: sizes and crc follow the data; bit 11: UTF-8 name
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(0, 18);
    local.writeUInt32LE(0, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    await this.write(Buffer.concat([local, nameBytes]));
    // the bytes, with a running checksum
    let crc = 0xffffffff;
    let size = 0;
    for await (const chunk of source) {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      crc = crcContinue(crc, b);
      size += b.length;
      await this.write(b);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const desc = Buffer.alloc(16);
    desc.writeUInt32LE(0x08074b50, 0);
    desc.writeUInt32LE(crc, 4);
    desc.writeUInt32LE(size, 8);
    desc.writeUInt32LE(size, 12);
    await this.write(desc);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0808, 8);
    dir.writeUInt16LE(0, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(date, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(size, 20);
    dir.writeUInt32LE(size, 24);
    dir.writeUInt16LE(nameBytes.length, 28);
    dir.writeUInt16LE(0, 30);
    dir.writeUInt16LE(0, 32);
    dir.writeUInt16LE(0, 34);
    dir.writeUInt16LE(0, 36);
    dir.writeUInt32LE(0, 38);
    dir.writeUInt32LE(start, 42);
    this.central.push(dir, nameBytes);
    this.count++;
  }

  /** The central directory and the end record; the stream ends. */
  async finish(): Promise<void> {
    const dirStart = this.offset;
    for (const b of this.central) await this.write(b);
    const dirSize = this.offset - dirStart;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(this.count, 8);
    end.writeUInt16LE(this.count, 10);
    end.writeUInt32LE(dirSize, 12);
    end.writeUInt32LE(dirStart, 16);
    end.writeUInt16LE(0, 20);
    await this.write(end);
    this.out.end();
  }

  /** The stream is given up half way (the download was cancelled): nothing more is written. */
  abort(err?: Error): void {
    this.out.destroy(err);
  }
}

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
/** The checksum carried on over another chunk (the running value, not yet inverted). */
function crcContinue(c: number, data: Uint8Array): number {
  for (let i = 0; i < data.length; i++) c = TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return c;
}
export { crc32 };
