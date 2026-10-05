import { deflateRawSync } from "node:zlib";

/**
 * A zip file made in memory from a few entries: the node pack handed out by Settings, a backup of the data.
 * Plain zip (PKZIP 2.0): one local header and one central-directory entry per file, deflate for anything
 * that gets smaller, stored otherwise. No zip64, so each file and the whole stay under 4 GB; that is what
 * these are for. The streamed, zip64-capable writer for a backup is zipStream.ts; it shares the checksum.
 */

export interface ZipEntry {
  /** The path inside the zip, with forward slashes. */
  name: string;
  data: Uint8Array;
  /** When it was last changed; now when left out. */
  mtime?: Date;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** The checksum carried on over another chunk: the running value (start at 0xffffffff), not yet inverted. */
export function crcUpdate(c: number, data: Uint8Array): number {
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return c;
}

export function crc32(data: Uint8Array): number {
  return (crcUpdate(0xffffffff, data) ^ 0xffffffff) >>> 0;
}

/** A date as zip stores it: DOS time and date, local time, two-second steps, nothing before 1980. */
function dosTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export function zipOf(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const now = new Date();
  for (const e of entries) {
    const name = Buffer.from(e.name.replace(/\\/g, "/"), "utf8");
    const raw = Buffer.from(e.data.buffer, e.data.byteOffset, e.data.byteLength);
    const deflated = deflateRawSync(raw, { level: 6 });
    const stored = deflated.length >= raw.length;
    const body = stored ? raw : deflated;
    const method = stored ? 0 : 8;
    const crc = crc32(raw);
    const { time, date } = dosTime(e.mtime ?? now);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: the name is UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, body);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4); // made by
    dir.writeUInt16LE(20, 6); // needed
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(date, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt16LE(0, 30); // extra
    dir.writeUInt16LE(0, 32); // comment
    dir.writeUInt16LE(0, 34); // disk
    dir.writeUInt16LE(0, 36); // internal attributes
    dir.writeUInt32LE(0, 38); // external attributes
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);
    offset += local.length + name.length + body.length;
  }
  const dirSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dirSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, ...central, end]);
}

/**
 * The names of the files in a zip, read from its central directory: enough to check what one holds.
 * Reads the plain end record and, when the zip is zip64 (what zipStream.ts writes past 4 GB), the zip64
 * end record its locator points at.
 */
export function zipNames(zip: Uint8Array): string[] {
  const b = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  const endAt = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endAt < 0) return [];
  let count = b.readUInt16LE(endAt + 10);
  let at = b.readUInt32LE(endAt + 16);
  // a zip64 locator sits just before the end record; the zip64 end record it names has the real figures
  const locatorAt = endAt - 20;
  if (locatorAt >= 0 && b.readUInt32LE(locatorAt) === 0x07064b50) {
    const z64 = Number(b.readBigUInt64LE(locatorAt + 8));
    if (b.readUInt32LE(z64) === 0x06064b50) {
      count = Number(b.readBigUInt64LE(z64 + 32));
      at = Number(b.readBigUInt64LE(z64 + 48));
    }
  }
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    if (b.readUInt32LE(at) !== 0x02014b50) break;
    const nameLen = b.readUInt16LE(at + 28);
    const extraLen = b.readUInt16LE(at + 30);
    const commentLen = b.readUInt16LE(at + 32);
    names.push(b.subarray(at + 46, at + 46 + nameLen).toString("utf8"));
    at += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}
