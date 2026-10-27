/** Longest edge of a library thumbnail: enough for a grid tile on a dense screen. */
const EDGE = 512;
/**
 * Longest edge of the small thumbnail, for a tile drawn at 256 px or less on a screen of one pixel per point (the grid's
 * tiles are 105 to 320 px wide): a quarter of the pixels, and about a third of the bytes, of the 512 one.
 */
export const SMALL_EDGE = 256;

type Sharp = typeof import("sharp").default;
let loading: Promise<Sharp | null> | null = null;

/**
 * The image library, loaded on first use. It ships prebuilt for the common platforms; where it does
 * not load, Afflatus still works and the library shows full-size pictures instead of thumbnails.
 */
function sharp(): Promise<Sharp | null> {
  loading ??= import("sharp").then(
    (m) => m.default,
    (err) => {
      console.warn(`[thumbs] thumbnails are off, the image library did not load: ${(err as Error).message}`);
      return null;
    },
  );
  return loading;
}

/** A small WebP of a picture, `edge` at most on its longest side, or null when it cannot be made (not a picture, a damaged file, no image library). */
export async function makeThumb(bytes: Uint8Array, edge = EDGE): Promise<Uint8Array | null> {
  const lib = await sharp();
  if (!lib) return null;
  try {
    return new Uint8Array(await lib(bytes).rotate().resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true }).webp({ quality: 80 }).toBuffer());
  } catch {
    return null;
  }
}

/**
 * A JPEG of a picture, `edge` at most on its longest side, for a notice (notify.ts): Telegram and Discord show a JPEG
 * everywhere, a WebP not always. Null when it cannot be made.
 */
export async function makeStill(bytes: Uint8Array, edge = 1280): Promise<Uint8Array | null> {
  const lib = await sharp();
  if (!lib) return null;
  try {
    return new Uint8Array(await lib(bytes).rotate().resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true }).flatten({ background: "#000" }).jpeg({ quality: 82 }).toBuffer());
  } catch {
    return null;
  }
}

/**
 * A picture mirrored as it is seen (turned upright first, as its metadata says), as a PNG: left and right swapped
 * ("horizontal") or top and bottom ("vertical"). Null when it cannot be made (not a picture, no image library).
 */
export async function mirrorPicture(bytes: Uint8Array, axis: "horizontal" | "vertical"): Promise<Uint8Array | null> {
  const lib = await sharp();
  if (!lib) return null;
  try {
    const upright = lib(bytes).rotate();
    return new Uint8Array(await (axis === "horizontal" ? upright.flop() : upright.flip()).png().toBuffer());
  } catch {
    return null;
  }
}

/** What a picture really is, read from its bytes: null when it is not a picture that can be opened. */
export async function readPicture(bytes: Uint8Array): Promise<{ mime: string; width: number; height: number } | null> {
  const lib = await sharp();
  if (!lib) return null;
  try {
    const m = await lib(bytes).metadata();
    const mime = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" }[m.format as string];
    // a photo taken sideways says so in its metadata: what is seen is turned
    const turned = (m.orientation ?? 1) >= 5;
    return mime && m.width && m.height ? { mime, width: turned ? m.height : m.width, height: turned ? m.width : m.height } : null;
  } catch {
    return null;
  }
}

/**
 * A picture's pixels as they are seen (turned upright, with an alpha channel) and its size, for a digest of what it shows
 * whatever file holds it: a PNG drawn again by the browser for the clipboard is other bytes, the same pixels. Null when it
 * cannot be read (not a picture, no image library).
 */
export async function picturePixels(bytes: Uint8Array): Promise<{ width: number; height: number; data: Uint8Array } | null> {
  const lib = await sharp();
  if (!lib) return null;
  try {
    const { data, info } = await lib(bytes).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
  } catch {
    return null;
  }
}

/**
 * Of a painted mask (white = the part to redo): its size, and the part that was painted with room
 * around it, because what is drawn there has to fit what is next to it. `box` is null when nothing is painted.
 */
export async function maskBox(bytes: Uint8Array): Promise<{ width: number; height: number; box: { x: number; y: number; width: number; height: number } | null } | null> {
  const lib = await sharp();
  if (!lib) return null;
  try {
    const { data, info } = await lib(bytes).removeAlpha().extractChannel(0).raw().toBuffer({ resolveWithObject: true });
    const { width, height } = info;
    let x0 = width, y0 = height, x1 = -1, y1 = -1;
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        if (data[row + x]! <= 127) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (x1 < 0) return { width, height, box: null };
    const room = Math.max(48, Math.round(Math.max(x1 - x0 + 1, y1 - y0 + 1) * 0.35));
    const x = Math.max(0, x0 - room);
    const y = Math.max(0, y0 - room);
    return { width, height, box: { x, y, width: Math.min(width, x1 + 1 + room) - x, height: Math.min(height, y1 + 1 + room) - y } };
  } catch {
    return null;
  }
}

/**
 * Pictures side by side in one JPEG, each brought to `height` and numbered in its corner (1, 2…), on black: what MCP's
 * compare shows an agent, which sees one picture more easily than four. Null when it cannot be made (no image library, a
 * picture that does not open).
 */
export function sideBySide(pictures: readonly Uint8Array[], height = 512): Promise<Uint8Array | null> {
  return contactSheet(pictures.map((bytes, i) => ({ bytes, label: String(i + 1) })), { height, perRow: pictures.length });
}

/**
 * Pictures in rows of `perRow`, each brought to `height` with its label in its corner ("3", "2→3"), on black: a timeline's
 * contact sheet (MCP's view_timeline), and compare's row. A row is as wide as its pictures (each at most 4 × `height` wide); the
 * sheet as wide as its widest row. Null when it cannot be made (no image library, a picture that does not open).
 */
export async function contactSheet(cells: ReadonlyArray<{ bytes: Uint8Array; label: string }>, o: { height: number; perRow: number }): Promise<Uint8Array | null> {
  const lib = await sharp();
  if (!lib || !cells.length) return null;
  try {
    const gap = 8;
    const { height } = o;
    const each = await Promise.all(cells.map(async (c) => {
      // at most 4 × as wide as high: brought to the height alone, a 65000×16 picture became ~268 Mpx in memory (review I3)
      const { data, info } = await lib(c.bytes).rotate().resize({ width: 4 * height, height, fit: "inside", withoutEnlargement: false }).png().toBuffer({ resolveWithObject: true });
      return { data, width: info.width, high: info.height, label: c.label };
    }));
    const rows: Array<typeof each> = [];
    for (let i = 0; i < each.length; i += Math.max(1, o.perRow)) rows.push(each.slice(i, i + Math.max(1, o.perRow)));
    const width = Math.max(...rows.map((r) => r.reduce((sum, e) => sum + e.width, 0) + gap * (r.length - 1)));
    const layers = rows.flatMap((row, k) => {
      let left = 0;
      const top = k * (height + gap);
      return row.flatMap((e) => {
        const at = left;
        left += e.width + gap;
        // as wide as its words: "12→13" does not fit the square a single number does
        const w = Math.max(44, 18 + 16 * e.label.length);
        const text = e.label.replace(/[<&>]/g, "");
        const label = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="44"><rect width="${w}" height="44" rx="8" fill="#000" fill-opacity="0.7"/><text x="${w / 2}" y="31" font-family="sans-serif" font-size="26" font-weight="700" fill="#fff" text-anchor="middle">${text}</text></svg>`);
        // a picture held to the width cap is lower than the row: centred in it
        return [{ input: e.data, left: at, top: top + Math.floor((height - e.high) / 2) }, { input: label, left: at + 8, top: top + 8 }];
      });
    });
    const total = rows.length * height + gap * (rows.length - 1);
    return new Uint8Array(await lib({ create: { width, height: total, channels: 3, background: "#000" } }).composite(layers).jpeg({ quality: 82 }).toBuffer());
  } catch {
    return null;
  }
}

export const thumbKey = (assetId: string) => `thumbs/${assetId.slice(0, 2)}/${assetId}.webp`;
/**
 * The small thumbnail's key, beside the other: made from it on first ask (thumb route), never named in the item's row, so
 * erased with the item (sweep.ts eraseAsset), and named after the item's id, so the sweep of files no item names finds it.
 */
export const smallThumbKey = (assetId: string) => `thumbs/${assetId.slice(0, 2)}/${assetId}-${SMALL_EDGE}.webp`;
