import type { Asset, Take } from "../../api";
import { fileVersion, stamp } from "../model";

/**
 * What the hover cards over the track work out: how big a picture is drawn, where the card sits, what its
 * footer says, which moment of a take stands against a pinned picture, and the pictures loaded lately.
 * Kept apart from the cards themselves so that all of it is tested without a browser.
 */

/** The cards' pictures: the frame under the pointer, a pinned picture alone, and the two side by side. */
export const PEEK = {
  frame: { w: 320, h: 240 },
  pin: { w: 380, h: 380 },
  pair: { w: 260, h: 260 },
  /** The card's padding and border around what it holds, on each side. */
  chrome: 9,
  /** Room the footer takes under the picture, for how tall a picture can be. */
  footer: 62,
  /** The least room kept between a card and the edge of the window or the editor. */
  margin: 8,
} as const;

/** The gestures the ruler and the clips take: the card's last line. */
export const HINTS = {
  ruler: "click: playhead · Shift-drag: range · Ctrl+wheel: zoom",
  clip: "click: select · Shift: range · Ctrl: pick · drag: move",
} as const;

/** A picture of this width and height drawn in a box: as wide as the box when it lies, as tall as it allows when it stands. */
export function fitFrame(width: number | null | undefined, height: number | null | undefined, box: { w: number; h: number }): { w: number; h: number } {
  const aspect = width && height ? width / height : 16 / 9;
  let w = box.w;
  let h = w / aspect;
  if (h > box.h) {
    h = box.h;
    w = h * aspect;
  }
  return { w: Math.round(w), h: Math.round(h) };
}

/**
 * Where a card of `width` sits for a pointer at `x`: centred on it, kept between `lo` and `hi`; and where its
 * arrow points from, inside the card, never on its rounded corners. All in viewport pixels.
 */
export function placeCard(x: number, width: number, lo: number, hi: number): { left: number; arrow: number } {
  const left = hi - lo <= width ? lo : Math.max(lo, Math.min(hi - width, x - width / 2));
  return { left, arrow: Math.max(16, Math.min(width - 16, x - left)) };
}

/** The height asked of the peek route for a frame drawn this tall: twice it, for a sharp picture, within what the route gives (48 to 480). */
export const peekHeight = (shown: number) => Math.max(48, Math.min(480, Math.round(shown * 2)));

/**
 * A moment put on the start of the video's frame that shows then: the pointer moving inside one frame asks for
 * the same picture again. Never later than the moment (a moment just before the end must not land past the last frame).
 */
export function onFrame(ms: number, fps: number | null | undefined): number {
  const frame = 1000 / (fps && fps > 0 ? fps : 24);
  return Math.max(0, Math.floor(Math.floor(ms / frame + 1e-6) * frame));
}

/** The address of one frame of a video, sharp for a picture drawn `shown` pixels tall; kept by the browser for good. */
export const frameUrl = (asset: Asset, atMs: number, shown: number) => `/api/assets/${asset.id}/peek?at=${onFrame(atMs, asset.fps)}&h=${peekHeight(shown)}&v=${fileVersion(asset)}`;

export type PinPlace = "start" | "end" | "mid";

/** What is pinned to a clip, said in a few words: "last frame pinned"; null when nothing is. */
export function pinnedNote(pins: Partial<Record<PinPlace, boolean>>): string | null {
  if (pins.start && pins.end) return pins.mid ? "first, key and last frames pinned" : "first and last frames pinned";
  const names = [pins.start && "first frame", pins.mid && "keyframe", pins.end && "last frame"].filter(Boolean);
  return names.length ? `${names.join(" and ")} pinned` : null;
}

/** A pinned picture's name on its card: "Last frame · clip 4", "Keyframe at 2.5 s · clip 4". */
export function pinTitle(where: PinPlace, clipNumber: number, midAtS?: number): string {
  const what = where === "start" ? "First frame" : where === "end" ? "Last frame" : `Keyframe at ${midAtS ?? 2.5} s`;
  return `${what} · clip ${clipNumber}`;
}

/**
 * The moment of a take that stands against a picture pinned to its clip: the frame it really starts on, the one
 * it ends on (a moment inside its last frames: its end is past the last one), or the frame at the keyframe's moment of
 * what the model made (its run-up before it). `shownMs`: where that is in the clip as it plays; null when a
 * trim has cut it away.
 */
export function pinCompare(take: Pick<Take, "headMs" | "startMs" | "endMs">, where: PinPlace, midAtS = 2.5): { atMs: number; shownMs: number | null } {
  if (where === "start") return { atMs: take.startMs, shownMs: 0 };
  // a moment within the last frame or two: ffmpeg finds no picture at the very last frame's start (sound runs a little past it)
  if (where === "end") return { atMs: Math.max(take.startMs, take.endMs - 60), shownMs: take.endMs - take.startMs };
  const atMs = take.headMs + midAtS * 1000;
  return { atMs, shownMs: atMs >= take.startMs && atMs <= take.endMs ? atMs - take.startMs : null };
}

/** The label under a take's frame on a pin's card: "take 2 · 0:07.3". */
export const takeLabel = (takeNumber: number, shownMs: number | null) => `take ${takeNumber} · ${shownMs === null ? "trimmed off" : stamp(shownMs)}`;

/** A few things kept by key, the one used longest ago let go first. */
export class Lru<K, V> {
  private readonly items = new Map<K, V>();
  constructor(private readonly size: number) {}
  get(key: K): V | undefined {
    const v = this.items.get(key);
    if (v === undefined) return undefined;
    // used now: it moves to the end, the last to go
    this.items.delete(key);
    this.items.set(key, v);
    return v;
  }
  set(key: K, value: V): void {
    this.items.delete(key);
    this.items.set(key, value);
    while (this.items.size > this.size) this.items.delete(this.items.keys().next().value as K);
  }
  has(key: K): boolean {
    return this.items.has(key);
  }
  get count(): number {
    return this.items.size;
  }
}
