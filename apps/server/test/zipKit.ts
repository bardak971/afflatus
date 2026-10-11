// For the tests: what a zip made by zip.ts or zipStream.ts holds.

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
