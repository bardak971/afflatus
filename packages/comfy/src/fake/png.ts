import { crc32, deflateSync } from "node:zlib";

/** A real PNG, a soft vertical blend between two colours: something to look at without a GPU. */
export function makePng(width: number, height: number, top: [number, number, number], bottom: [number, number, number]): Uint8Array {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const t = height > 1 ? y / (height - 1) : 0;
    const rgb = [0, 1, 2].map((i) => Math.round(top[i]! + (bottom[i]! - top[i]!) * t));
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      // a faint diagonal band so that it does not read as a flat fill
      const band = (x + y) % 96 < 48 ? 6 : 0;
      raw[row + 1 + x * 3] = Math.min(255, rgb[0]! + band);
      raw[row + 2 + x * 3] = Math.min(255, rgb[1]! + band);
      raw[row + 3 + x * 3] = Math.min(255, rgb[2]! + band);
    }
  }
  return pngOf(width, height, raw);
}

/** An RGB PNG of these rows (each a filter byte, then its pixels). */
function pngOf(width: number, height: number, raw: Buffer): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "latin1");
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8 bits per channel, RGB
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]));
}

/** A colour from a seed, so that different seeds give visibly different pictures. */
export function tint(seed: number, shift: number): [number, number, number] {
  const h = ((seed * 0.618033988749895 + shift) % 1) * 6;
  const c = 90, m = 40;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const [r, g, b] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  return [Math.round(r + m), Math.round(g + m), Math.round(b + m)];
}

/**
 * A mask as a find returns one (white on black, grey at its soft edge): an ellipse of `rx` by `ry` around (cx, cy), in a
 * picture of `width` by `height`, `peak` at its middle. What the demo's pretend SAM finds around a click (scripts/demo.ts).
 */
export function makeMaskPng(width: number, height: number, cx: number, cy: number, rx: number, ry: number, peak = 255): Uint8Array {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      const d = Math.hypot((x - cx) / Math.max(1, rx), (y - cy) / Math.max(1, ry));
      // the last tenth of the radius fades out, as a soft mask does
      const v = Math.round(peak * Math.min(1, Math.max(0, (1 - d) / 0.1)));
      raw.fill(v, row + 1 + x * 3, row + 4 + x * 3);
    }
  }
  return pngOf(width, height, raw);
}
