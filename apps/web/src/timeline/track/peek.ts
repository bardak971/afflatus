import type { Asset, Clip, Take } from "../../api";
import { cutAtJoinFigure, cutsAtJoin } from "@afflatus/core";
import { seconds, spell } from "../../format";
import { SHOWS } from "../attention";
import { driftOf, type Drift } from "../lookDrift";
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
  /** The frame card's width, what it holds without its padding (about 320 px with it): the frame, then the clip's form line and chips. */
  card: 302,
  /** A standing frame goes beside the clip's words, no wider than this; a lying one goes over them. */
  side: 120,
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

/** A line of the clip's figures: plain, dim, what failed (warn), what needs a look (attention), or the accent (something happening now). */
interface FactLine {
  text: string;
  tone?: "dim" | "warn" | "attention" | "accent";
}

/**
 * What a clip is, read without opening it, beside its frame on the hover card. Only what decides something:
 * its length and how long it took; how it joins the clip before (and how much the picture jumps there), how wide
 * its run-up came out, which take plays; how far its look slid along its run; its size and what is happening to
 * it; anything that needs attention. The prompt, the seed and the files stay in the Inspector.
 */
export interface ClipFacts {
  /** Its length in bold, then how it came to be. Null: a short card (a still, a clip not rendered). */
  head: { text: string; detail?: string } | null;
  /** attention: a join that jumps past what shows. */
  chips: Array<{ text: string; tone: "accent" | "neutral" | "attention" }>;
  /** Against the clip before and the run's start; null when it does not continue a measured run. */
  drift: Drift | null;
  /** The dim last line: size, frame rate, a render on its way. */
  foot: FactLine[];
  /** Whole lines: the short card's words, and what needs attention. */
  lines: FactLine[];
}

/** A join kind in a chip's words; "hybrid": takes made before 2026-10-08 only. */
function joinWords(clip: Clip, take: Take, index: number): string {
  // a seamless take after another take than the one it was decoded with (or that one trimmed) plays faded, as a latent join
  if (take.joinKind === "seamless") return take.seamless ? "seamless join" : "latent join, faded";
  if (take.joinKind === "latent") return "latent join";
  if (take.joinKind === "hybrid") return "frames + latent join";
  if (take.joinKind === "pixels") return "pixel join";
  if (take.joinKind === "carried") return "pixel join, sound carried";
  if (take.joinKind === "window") return "window join, crossfaded";
  // Wan without SVI 2.0 Pro there: opened on the clip before's last frame, still
  if (take.joinKind === "still") return "a cut: SVI's LoRAs aren't here";
  return clip.joined === "continue" ? `extends clip ${index}` : "cut";
}

/** The figures of clip `index` for the hover card; `jump`: how much the picture jumps where it meets the clip before, once measured (×1 = like its own motion). */
export function clipFacts(clip: Clip, index: number, clips: Clip[], jump: number | null): ClipFacts {
  const take = clip.kind === "video" ? clip.take : null;
  const facts: ClipFacts = { head: null, chips: [], drift: null, foot: [], lines: [] };
  const job: FactLine | null = clip.job ? (clip.job.status === "running" ? { text: take ? "rendering a new take" : "Rendering now", tone: "accent" } : { text: take ? "queued for a new take" : "Queued for a render", tone: take ? undefined : "dim" }) : null;
  if (clip.kind === "still") {
    facts.lines.push({ text: `Still · ${seconds(clip.lengthMs)}` });
  } else if (!take) {
    facts.lines.push(clip.failed && !clip.job ? { text: "The render failed", tone: "warn" } : job ?? { text: "Not rendered yet", tone: "dim" });
  } else {
    facts.head = { text: seconds(clip.lengthMs), detail: take.renderMs ? `rendered in ${spell(take.renderMs)}` : clip.recipe ? undefined : "imported" };
    if (index > 0) {
      const flows = clip.joined === "continue";
      facts.chips.push({ text: `${joinWords(clip, take, index)}${flows && jump !== null ? ` ×${jump.toFixed(1)}` : ""}`, tone: flows && jump !== null && jump > SHOWS ? "attention" : flows ? "accent" : "neutral" });
      // a take that cut to another shot where its run-up ends: the join shows whatever its kind says (card #161)
      if (flows && cutsAtJoin(take.measure)) facts.chips.push({ text: `cut at the join · ${cutAtJoinFigure(take.measure!)}`, tone: "attention" });
      // a join made in the latent: how wide its run-up came out against the latent it was guided by (1.00 = the same)
      if (take.measure?.drift) facts.chips.push({ text: `run-up ×${take.measure.drift.width.toFixed(2)}`, tone: "neutral" });
    }
    // how much the face is its person's along the take (ArcFace against the cast's photo or its first reference picture, a
    // Motion transfer's Picture): the figure itself, beside the table's change against the clip before (card #18)
    if (take.measure?.face != null) facts.chips.push({ text: `face ${take.measure.face.toFixed(2)}`, tone: "neutral" });
    const n = clip.takes.findIndex((t) => t.id === take.id) + 1;
    if (clip.takes.length > 1) facts.chips.push({ text: `take ${n} of ${clip.takes.length}`, tone: "neutral" });
    if (take.finishedFrom) {
      const draft = clip.takes.find((t) => t.id === take.finishedFrom);
      const by = draft?.asset.width && take.asset.width ? Math.round((take.asset.width / draft.asset.width) * 10) / 10 : null;
      facts.chips.push({ text: `upscaled${by && by !== 1 ? ` ×${by}` : ""}`, tone: "neutral" });
    }
    facts.drift = driftOf(clips, index);
    if (take.asset.width && take.asset.height) facts.foot.push({ text: `${take.asset.width} × ${take.asset.height}${take.asset.fps ? ` · ${Math.round(take.asset.fps)} fps` : ""}` });
    if (take.trimStartMs > 0 || take.trimEndMs > 0) facts.foot.push({ text: `trimmed${take.trimStartMs > 0 ? ` ${seconds(take.trimStartMs)} at the start` : ""}${take.trimStartMs > 0 && take.trimEndMs > 0 ? "," : ""}${take.trimEndMs > 0 ? ` ${seconds(take.trimEndMs)} at the end` : ""}` });
    if (job) facts.foot.push(job);
    if (clip.failed && !clip.job) facts.lines.push({ text: "The last render failed", tone: "warn" });
  }
  if (!take && clip.kind === "still" && job) facts.lines.push(job);
  // a look, not a failure: amber, as Needs a look says them
  if (clip.join === "stale") facts.lines.push({ text: `Join stale: clip ${index} changed since`, tone: "attention" });
  if (clip.mirrorChanged) facts.lines.push({ text: "Mirror changed since this take", tone: "attention" });
  return facts;
}
