/** Longest edge of a library thumbnail: enough for a grid tile on a dense screen. */
const EDGE = 512;

type Sharp = typeof import("sharp").default;
let loading: Promise<Sharp | null> | null = null;

/**
 * The image library, loaded on first use. It ships prebuilt for the common platforms; where it does
 * not load, studai still works and the library shows full-size pictures instead of thumbnails.
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

/** A small WebP of a picture, or null when it cannot be made (not a picture, a damaged file, no image library). */
export async function makeThumb(bytes: Uint8Array): Promise<Uint8Array | null> {
  const lib = await sharp();
  if (!lib) return null;
  try {
    return new Uint8Array(await lib(bytes).rotate().resize({ width: EDGE, height: EDGE, fit: "inside", withoutEnlargement: true }).webp({ quality: 80 }).toBuffer());
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

export const thumbKey = (assetId: string) => `thumbs/${assetId.slice(0, 2)}/${assetId}.webp`;
