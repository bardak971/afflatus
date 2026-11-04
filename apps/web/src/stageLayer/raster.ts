/**
 * The soft mask the Stage's layer paints, as one byte a pixel (0 nothing, 255 all of it): a brush with a core and a feather,
 * the rubber, box and lasso fills, invert, a mask from elsewhere added or taken away, and the mask at the picture's own size.
 * Pure (no canvas, no page), so every stroke is tested; the layer draws the plane and the browser makes the PNG of it
 * (maskImage.ts). The grey levels are kept to the end: the recipes read the mask's red channel as it is (`LoadImageMask`),
 * and Differential Diffusion fades the fix by them.
 */

/** A part of the plane, in its own pixels. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Plane {
  w: number;
  h: number;
  data: Uint8ClampedArray;
}

/** What a stroke or a fill does: put mask where it goes, or take it away. */
export type Ink = "add" | "subtract";

/**
 * The plane is never larger than this on its long side: enough to follow a hair's outline on a 2K picture, and a 4K one
 * still paints at once (a full plane is 4 MB). The mask is scaled up to the picture's size once, when it is saved.
 */
export const WORK_EDGE = 2048;

/** At or under this, a pixel counts as not masked: a feather's last breath is not a part to redo (the server's maskBox reads the same). */
export const EMPTY_BELOW = 8;

/** The plane's size for a picture: its own when it fits, else scaled down to WORK_EDGE on its long side. */
export function workSize(w: number, h: number, edge = WORK_EDGE): { w: number; h: number; k: number } {
  const k = Math.min(1, edge / Math.max(w, h, 1));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)), k };
}

export const newPlane = (w: number, h: number): Plane => ({ w, h, data: new Uint8ClampedArray(w * h) });

/** A rect held to the plane, whole pixels; null when nothing of it is on it. */
export function clip(r: Rect, p: { w: number; h: number }): Rect | null {
  const x0 = Math.max(0, Math.floor(r.x));
  const y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(p.w, Math.ceil(r.x + r.w));
  const y1 = Math.min(p.h, Math.ceil(r.y + r.h));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/** The smallest rect holding both (either may be nothing yet). */
export function union(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** How strong the feather is at `d` past the core, out of `feather`: 1 at the core's edge, 0 at its own, eased at both ends so no ring shows. */
export function falloff(d: number, feather: number): number {
  if (d <= 0) return 1;
  if (d >= feather) return 0;
  const t = 1 - d / feather;
  return t * t * (3 - 2 * t);
}

/** One value put down where `v` (0 to 255) says, by the ink: the most of the two adding, the least of what is left taking away. */
const put = (plane: Plane, i: number, v: number, ink: Ink) => {
  const was = plane.data[i]!;
  if (ink === "add") {
    if (v > was) plane.data[i] = v;
  } else if (255 - v < was) plane.data[i] = 255 - v;
};

/**
 * One dab of the brush at (x, y): full inside `radius` (its core), fading out over `feather` past it. Stamps take the most
 * of what is there rather than piling up, so a stroke's overlapping dabs stay as soft as one. Returns the part it touched.
 */
export function dab(plane: Plane, x: number, y: number, radius: number, feather: number, ink: Ink): Rect | null {
  const r = Math.max(0, radius);
  const f = Math.max(0, feather);
  // the smallest dab still marks the pixel it is on: a click with a tiny brush leaves a dot
  const out = Math.max(0.5, r + f);
  const box = clip({ x: x - out, y: y - out, w: out * 2, h: out * 2 }, plane);
  if (!box) return null;
  for (let py = box.y; py < box.y + box.h; py++) {
    const dy = py + 0.5 - y;
    for (let px = box.x; px < box.x + box.w; px++) {
      const dx = px + 0.5 - x;
      const d = Math.hypot(dx, dy);
      if (d > out) continue;
      const v = d <= Math.max(r, 0.5) ? 255 : f > 0 ? Math.round(255 * falloff(d - r, f)) : 0;
      if (v > 0) put(plane, py * plane.w + px, v, ink);
    }
  }
  return box;
}

/** The brush dragged from one point to the next: dabs close enough that the edge never beads, whatever the size. */
export function line(plane: Plane, from: { x: number; y: number }, to: { x: number; y: number }, radius: number, feather: number, ink: Ink, toRadius = radius): Rect | null {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  const gap = Math.max(0.5, Math.min(radius, toRadius) * 0.2 + feather * 0.1);
  const n = Math.max(1, Math.ceil(length / gap));
  let dirty: Rect | null = null;
  // the first point is the previous move's last dab: a stroke's first press stamps it (dab), every move after adds the rest
  for (let i = length === 0 ? 0 : 1; i <= n; i++) {
    const t = i / n;
    dirty = union(dirty, dab(plane, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, radius + (toRadius - radius) * t, feather, ink));
  }
  return dirty;
}

/**
 * The distance of every pixel of `w` × `h` to the nearest one set in `hard`, in pixels (0 on them): the two-pass 3-4
 * chamfer, within a few percent of the true distance, and in two sweeps whatever the shape. What a fill's feather fades by.
 */
export function distanceOut(hard: Uint8Array, w: number, h: number): Float32Array {
  const far = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = hard[i] ? 0 : far;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? far : d[y * w + x]!);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (d[i] === 0) continue;
      d[i] = Math.min(d[i]!, at(x - 1, y) + 3, at(x, y - 1) + 3, at(x - 1, y - 1) + 4, at(x + 1, y - 1) + 4);
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (d[i] === 0) continue;
      d[i] = Math.min(d[i]!, at(x + 1, y) + 3, at(x, y + 1) + 3, at(x + 1, y + 1) + 4, at(x - 1, y + 1) + 4);
    }
  for (let i = 0; i < d.length; i++) d[i] = d[i]! / 3;
  return d;
}

/**
 * A shape filled, with the same feather as the brush's: full inside, fading out over `feather` past its edge. `inside`
 * says whether a pixel's middle is in the shape; only the shape's bounds and the feather around them are looked at.
 */
function fillShape(plane: Plane, bounds: Rect, feather: number, ink: Ink, inside: (x: number, y: number) => boolean): Rect | null {
  const f = Math.max(0, Math.ceil(feather));
  const box = clip({ x: bounds.x - f, y: bounds.y - f, w: bounds.w + 2 * f, h: bounds.h + 2 * f }, plane);
  if (!box) return null;
  const hard = new Uint8Array(box.w * box.h);
  let any = false;
  for (let y = 0; y < box.h; y++)
    for (let x = 0; x < box.w; x++)
      if (inside(box.x + x + 0.5, box.y + y + 0.5)) {
        hard[y * box.w + x] = 1;
        any = true;
      }
  if (!any) return null;
  const dist = f > 0 ? distanceOut(hard, box.w, box.h) : null;
  for (let y = 0; y < box.h; y++)
    for (let x = 0; x < box.w; x++) {
      const j = y * box.w + x;
      const v = hard[j] ? 255 : dist ? Math.round(255 * falloff(dist[j]!, feather)) : 0;
      if (v > 0) put(plane, (box.y + y) * plane.w + box.x + x, v, ink);
    }
  return box;
}

/** A box filled (corners in any order), feathered out past its edge. */
export function fillRect(plane: Plane, r: Rect, feather: number, ink: Ink): Rect | null {
  const n = normal(r);
  return fillShape(plane, n, feather, ink, (x, y) => x >= n.x && x < n.x + n.w && y >= n.y && y < n.y + n.h);
}

/** A rect with its width and height made positive (a box drawn up and to the left). */
export function normal(r: Rect): Rect {
  return { x: Math.min(r.x, r.x + r.w), y: Math.min(r.y, r.y + r.h), w: Math.abs(r.w), h: Math.abs(r.h) };
}

/** Whether a point is inside a polygon, by the even-odd rule (a lasso that crosses itself leaves its crossing out, as every editor's). */
export function insidePolygon(points: ReadonlyArray<{ x: number; y: number }>, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i]!;
    const b = points[j]!;
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** A lasso's outline filled (closed from its last point to its first), feathered out past its edge. Fewer than three points fill nothing. */
export function fillPolygon(plane: Plane, points: ReadonlyArray<{ x: number; y: number }>, feather: number, ink: Ink): Rect | null {
  if (points.length < 3) return null;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return fillShape(plane, { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }, feather, ink, (px, py) => insidePolygon(points, px, py));
}

/**
 * A found mask (SAM's, a detector's: hard edged) given the brush's feather: full inside (half masked and over), fading out
 * over `feather` past that edge, so the fade starts from full and shows no ring where a soft edge it came with met the new
 * one. A copy; the found mask is left as it came.
 */
export function feathered(plane: Plane, feather: number): Plane {
  const out: Plane = { w: plane.w, h: plane.h, data: plane.data.slice() };
  if (feather <= 0) return out;
  const hard = new Uint8Array(plane.w * plane.h);
  for (let i = 0; i < hard.length; i++) hard[i] = plane.data[i]! > 127 ? 1 : 0;
  const dist = distanceOut(hard, plane.w, plane.h);
  for (let i = 0; i < hard.length; i++) {
    if (hard[i]) {
      out.data[i] = 255;
      continue;
    }
    const v = Math.round(255 * falloff(dist[i]!, feather));
    if (v > out.data[i]!) out.data[i] = v;
  }
  return out;
}

/**
 * The magic wand: the pixels of a picture (RGBA, at the plane's size) close in colour to the one at (x, y), as a hard mask.
 * Close is each channel within `tolerance` (0 to 100: from that colour alone to every colour) of the clicked pixel's.
 * `contiguous`: only those reached from it through close neighbours (left, right, up, down), as every editor's wand;
 * else every close pixel of the picture. A click off the picture finds nothing.
 */
export function wand(rgba: Uint8ClampedArray, w: number, h: number, x: number, y: number, tolerance: number, contiguous: boolean): Plane {
  const out = newPlane(w, h);
  const sx = Math.floor(x);
  const sy = Math.floor(y);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return out;
  const t = Math.round((Math.min(100, Math.max(0, tolerance)) / 100) * 255);
  const o = (sy * w + sx) * 4;
  const r = rgba[o]!, g = rgba[o + 1]!, b = rgba[o + 2]!;
  const close = (i: number) => Math.abs(rgba[i * 4]! - r) <= t && Math.abs(rgba[i * 4 + 1]! - g) <= t && Math.abs(rgba[i * 4 + 2]! - b) <= t;
  if (!contiguous) {
    for (let i = 0; i < w * h; i++) if (close(i)) out.data[i] = 255;
    return out;
  }
  // a stack of pixels to look at, each looked at once: no recursion, whatever the size of the part
  const stack = new Int32Array(w * h);
  let top = 0;
  stack[top++] = sy * w + sx;
  out.data[sy * w + sx] = 255;
  while (top > 0) {
    const i = stack[--top]!;
    const px = i % w;
    const next = [px > 0 ? i - 1 : -1, px < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < w * (h - 1) ? i + w : -1];
    for (const j of next) {
      if (j < 0 || out.data[j] || !close(j)) continue;
      out.data[j] = 255;
      stack[top++] = j;
    }
  }
  return out;
}

/** Masked and not swapped: the rest of the picture is redone instead. */
export function invert(plane: Plane): Rect {
  for (let i = 0; i < plane.data.length; i++) plane.data[i] = 255 - plane.data[i]!;
  return { x: 0, y: 0, w: plane.w, h: plane.h };
}

/** Everything taken off. */
export function clear(plane: Plane): Rect {
  plane.data.fill(0);
  return { x: 0, y: 0, w: plane.w, h: plane.h };
}

/**
 * Another mask of the same size (one found by a click, a detector's face) added to this one or taken away from it, by its
 * own grey levels. Returns the part it changed, or null when it brought nothing.
 */
export function combine(plane: Plane, other: Plane, ink: Ink): Rect | null {
  if (other.w !== plane.w || other.h !== plane.h) throw new Error(`a ${other.w}×${other.h} mask cannot go on a ${plane.w}×${plane.h} one`);
  let x0 = plane.w, y0 = plane.h, x1 = -1, y1 = -1;
  for (let y = 0; y < plane.h; y++)
    for (let x = 0; x < plane.w; x++) {
      const i = y * plane.w + x;
      const v = other.data[i]!;
      if (v === 0) continue;
      put(plane, i, v, ink);
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** The part that is masked (above EMPTY_BELOW), or null when nothing is: what "the mask is empty" is said by. */
export function bounds(plane: Plane, below = EMPTY_BELOW): Rect | null {
  let x0 = plane.w, y0 = plane.h, x1 = -1, y1 = -1;
  for (let y = 0; y < plane.h; y++)
    for (let x = 0; x < plane.w; x++)
      if (plane.data[y * plane.w + x]! > below) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** A stray is under this share of the largest part's pixels: SAM's specks are a few dozen pixels on a part of tens of thousands. */
const STRAY_SHARE = 0.01;

/**
 * A found mask without its strays: SAM 3 answers a click with the thing and, at times, a speck elsewhere (73 pixels on the
 * other bicycle of the street, 20 in the umbrella over it, on a pod in card #274's test), which would be redone with it and
 * stretch the part the inpaint crops around. A part (8-connected, above EMPTY_BELOW) goes only when it is both tiny beside
 * the largest and outside the largest's box: a wheel's spokes cut off from the frame stay, and so do two things of a size
 * clicked together. Changes the plane in place.
 */
export function dropStrays(plane: Plane): Plane {
  const { w, h, data } = plane;
  const part = new Int32Array(w * h).fill(-1);
  const parts: Array<{ n: number; x0: number; y0: number; x1: number; y1: number }> = [];
  const stack = new Int32Array(w * h);
  for (let s = 0; s < w * h; s++) {
    if (part[s] !== -1 || data[s]! <= EMPTY_BELOW) continue;
    const id = parts.length;
    const p = { n: 0, x0: w, y0: h, x1: -1, y1: -1 };
    let top = 0;
    stack[top++] = s;
    part[s] = id;
    while (top > 0) {
      const i = stack[--top]!;
      const x = i % w, y = (i - x) / w;
      p.n++;
      if (x < p.x0) p.x0 = x;
      if (x > p.x1) p.x1 = x;
      if (y < p.y0) p.y0 = y;
      if (y > p.y1) p.y1 = y;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (part[j] !== -1 || data[j]! <= EMPTY_BELOW) continue;
          part[j] = id;
          stack[top++] = j;
        }
    }
    parts.push(p);
  }
  if (parts.length < 2) return plane;
  const big = parts.reduce((a, b) => (b.n > a.n ? b : a));
  const stray = parts.map((p) => p.n < big.n * STRAY_SHARE && (p.x1 < big.x0 || p.x0 > big.x1 || p.y1 < big.y0 || p.y0 > big.y1));
  for (let i = 0; i < w * h; i++) if (part[i]! >= 0 && stray[part[i]!]) data[i] = 0;
  return plane;
}

/** The plane at another size, read between its pixels (bilinear): the work plane up to the picture's own size for the saved mask, a loaded one down to the plane's. */
export function resample(plane: Plane, w: number, h: number): Plane {
  if (w === plane.w && h === plane.h) return { w, h, data: plane.data.slice() };
  const out = newPlane(w, h);
  const kx = plane.w / w;
  const ky = plane.h / h;
  for (let y = 0; y < h; y++) {
    const sy = Math.min(plane.h - 1, Math.max(0, (y + 0.5) * ky - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(plane.h - 1, y0 + 1);
    const ty = sy - y0;
    for (let x = 0; x < w; x++) {
      const sx = Math.min(plane.w - 1, Math.max(0, (x + 0.5) * kx - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(plane.w - 1, x0 + 1);
      const tx = sx - x0;
      const a = plane.data[y0 * plane.w + x0]! * (1 - tx) + plane.data[y0 * plane.w + x1]! * tx;
      const b = plane.data[y1 * plane.w + x0]! * (1 - tx) + plane.data[y1 * plane.w + x1]! * tx;
      out.data[y * w + x] = Math.round(a * (1 - ty) + b * ty);
    }
  }
  return out;
}

/** A mask read from a picture's pixels (RGBA, as a canvas gives them): its red channel, as the recipes read it. */
export function fromRgba(rgba: Uint8ClampedArray, w: number, h: number): Plane {
  const plane = newPlane(w, h);
  for (let i = 0; i < plane.data.length; i++) plane.data[i] = rgba[i * 4]!;
  return plane;
}

/** The mask as a picture's pixels: grey, opaque, white where it is masked. What the PNG is made of. */
export function toRgba(plane: Plane): Uint8ClampedArray {
  const out = new Uint8ClampedArray(plane.w * plane.h * 4);
  for (let i = 0; i < plane.data.length; i++) {
    const v = plane.data[i]!;
    out[i * 4] = v;
    out[i * 4 + 1] = v;
    out[i * 4 + 2] = v;
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** The mask laid over the picture: one colour, as strong as the mask. Only `rect` of it when given (a stroke's part, drawn again alone). */
export function tint(plane: Plane, rgb: readonly [number, number, number], strength: number, rect?: Rect): { data: Uint8ClampedArray; rect: Rect } {
  const r = rect ?? { x: 0, y: 0, w: plane.w, h: plane.h };
  const out = new Uint8ClampedArray(r.w * r.h * 4);
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) {
      const v = plane.data[(r.y + y) * plane.w + r.x + x]!;
      const o = (y * r.w + x) * 4;
      out[o] = rgb[0];
      out[o + 1] = rgb[1];
      out[o + 2] = rgb[2];
      out[o + 3] = Math.round(v * strength);
    }
  return { data: out, rect: r };
}

/** The pixels of a part of the plane, copied out. */
export function cut(plane: Plane, r: Rect): Uint8ClampedArray {
  const out = new Uint8ClampedArray(r.w * r.h);
  for (let y = 0; y < r.h; y++) out.set(plane.data.subarray((r.y + y) * plane.w + r.x, (r.y + y) * plane.w + r.x + r.w), y * r.w);
  return out;
}

/** Pixels cut out before put back where they came from. */
export function paste(plane: Plane, r: Rect, pixels: Uint8ClampedArray) {
  for (let y = 0; y < r.h; y++) plane.data.set(pixels.subarray(y * r.w, (y + 1) * r.w), (r.y + y) * plane.w + r.x);
}

interface Patch {
  rect: Rect;
  before: Uint8ClampedArray;
  after: Uint8ClampedArray;
}

/**
 * Undo and redo by the part each step changed, not the whole plane: a dot on a 2048 px plane keeps a few hundred bytes, not
 * 4 MB. A step is opened before it changes anything (a copy of the plane is held while it lasts) and closed with the part
 * it touched. Steps go past `most` bytes or `count` steps from the oldest.
 */
export class History {
  private open: Uint8ClampedArray | null = null;
  private back: Patch[] = [];
  private ahead: Patch[] = [];
  constructor(private readonly most = 96 * 1024 * 1024, private readonly count = 100) {}

  get steps() {
    return this.back.length;
  }
  get redos() {
    return this.ahead.length;
  }

  /** Before a stroke or a fill: what the plane is now. */
  begin(plane: Plane) {
    this.open = plane.data.slice();
  }

  /** After it: kept as one step of the part it touched (none when it touched nothing). A new step drops what Undo took back. */
  commit(plane: Plane, dirty: Rect | null) {
    const was = this.open;
    this.open = null;
    const r = dirty && clip(dirty, plane);
    if (!was || !r) return;
    const before = cut({ w: plane.w, h: plane.h, data: was }, r);
    const after = cut(plane, r);
    if (before.every((v, i) => v === after[i])) return;
    this.back.push({ rect: r, before, after });
    this.ahead = [];
    let bytes = this.back.reduce((n, p) => n + p.before.length * 2, 0);
    while (this.back.length > this.count || (bytes > this.most && this.back.length > 1)) bytes -= this.back.shift()!.before.length * 2;
  }

  /** A step left half done (a stroke cut short by a second finger, a pinch): the plane as it was before it. */
  abandon(plane: Plane): Rect | null {
    const was = this.open;
    this.open = null;
    if (!was) return null;
    plane.data.set(was);
    return { x: 0, y: 0, w: plane.w, h: plane.h };
  }

  /** The last step taken back; the part it changed, to draw again. */
  undo(plane: Plane): Rect | null {
    const p = this.back.pop();
    if (!p) return null;
    paste(plane, p.rect, p.before);
    this.ahead.push(p);
    return p.rect;
  }

  redo(plane: Plane): Rect | null {
    const p = this.ahead.pop();
    if (!p) return null;
    paste(plane, p.rect, p.after);
    this.back.push(p);
    return p.rect;
  }
}
