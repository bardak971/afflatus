import { unkeptMs } from "../../keepFor";
import type { Asset } from "../../api";

/**
 * The library's grid in justified rows: every picture and video at its own shape, every row the same
 * height and as wide as the grid, as a photo library lays them out. Pure arithmetic, linear in the number
 * of items: a page of hundreds is laid out in well under a millisecond, again at each width.
 */

/** A tile's shape when the item's size is not known: the grid's old tile (3:4). A sound is a wide card. */
export const FALLBACK_ASPECT = 3 / 4;
export const SOUND_ASPECT = 2.2;
/** No tile narrower or wider than this, so a strip of a panorama or a sliver of a portrait stays a tile. */
const MIN_ASPECT = 0.4;
const MAX_ASPECT = 3;

/** The width over the height an item's tile has. */
export function aspectOf(a: Pick<Asset, "kind" | "width" | "height">): number {
  if (a.kind === "audio") return SOUND_ASPECT;
  const r = a.width && a.height ? a.width / a.height : FALLBACK_ASPECT;
  return Math.max(MIN_ASPECT, Math.min(MAX_ASPECT, r));
}

export interface Row {
  /** The items it holds, as indices into the list laid out: [start, end). */
  start: number;
  end: number;
  height: number;
  /** Each tile's width, whole pixels; a full row's add up, with the gaps, to the width exactly. */
  widths: number[];
}

/**
 * Rows of the given shapes: items are added to a row until it would be wider than `width` at `target`
 * height, then the row is scaled to the width (a little lower than the target, or higher when leaving the
 * last one out is nearer the target). The last row, not full, keeps the target height and is not stretched.
 */
export function justify(aspects: number[], width: number, target: number, gap: number): Row[] {
  const rows: Row[] = [];
  if (width <= 0 || target <= 0) return rows;
  const close = (start: number, end: number, sum: number, full: boolean) => {
    const room = width - gap * (end - start - 1);
    const height = full ? room / sum : target;
    const widths: number[] = [];
    let used = 0;
    for (let i = start; i < end; i++) {
      // whole pixels, the remainder to the last tile: a full row ends flush with the grid
      const w = full && i === end - 1 ? Math.max(1, room - used) : Math.max(1, Math.round(aspects[i]! * height));
      widths.push(w);
      used += w;
    }
    rows.push({ start, end, height: Math.round(height), widths });
  };
  let start = 0;
  let sum = 0;
  for (let i = 0; i < aspects.length; i++) {
    const a = aspects[i]!;
    const n = i - start + 1;
    if ((sum + a) * target + gap * (n - 1) < width) {
      sum += a;
      continue;
    }
    // full with this one: with it the row is lower than the target, without it (stretched) higher; the nearer wins
    const withIt = (width - gap * (n - 1)) / (sum + a);
    const without = n > 1 ? (width - gap * (n - 2)) / sum : Infinity;
    if (n > 1 && without - target < target - withIt) {
      close(start, i, sum, true);
      start = i;
      sum = a;
    } else {
      close(start, i + 1, sum + a, true);
      start = i + 1;
      sum = 0;
    }
  }
  if (start < aspects.length) close(start, aspects.length, sum, false);
  return rows;
}

/** The last hours of that day: the tile's clock mark turns to the warning colour. */
export const SOON_MS = 3 * 60 * 60_000;
/** How long an item nobody kept has before it goes to the bin by itself (Settings › Storage); null when nothing goes on its own. */
export const leftOf = (a: Pick<Asset, "countdownFrom" | "createdAt">, now = Date.now(), ms = unkeptMs()): number | null => (ms === null ? null : new Date(a.countdownFrom ?? a.createdAt).getTime() + ms - now);
