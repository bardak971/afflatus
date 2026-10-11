import { FRAME_SLACK_MS, secondsOf } from "@afflatus/core";
import type { Asset, Clip, ClipPatch, RecipeInfo, Take } from "../api";
import { clock } from "../format";

/** What the editor's parts share: how clips are laid out along the track, and a few words about them. */

export const DRAG_CLIP = "application/x-afflatus-clip";

/** The track is drawn to scale: this many pixels a second, within these limits. */
// pixels a second: down to 2 so that a long video (ten minutes on a wide screen) still fits whole (Fit all, a clip added)
// one zoom step (the - and + buttons, - and = on the keyboard): this much closer or farther
export const ZOOM = { least: 2, most: 110, start: 40, step: 1.3 };
/** Space before the first clip, and the width of the "New clip" button after the last one. */
export const PAD = 10;
export const NEW_CLIP = 116;

/** In and Out on the timeline, on the clock of what plays. */
export interface TimeRange {
  inMs: number;
  outMs: number;
}

/** "0:03.4": a moment on the timeline, to the tenth of a second. */
export const stamp = (ms: number) => clock(ms, { decimals: 1 });

/** One clip as it is drawn: where it starts and how long it is, in time and in pixels. */
export interface Slot {
  clip: Clip;
  index: number;
  startMs: number;
  lengthMs: number;
  left: number;
  width: number;
  /** Nothing to play yet: it is drawn at the length it will have. */
  planned: boolean;
}

/** How long a clip that is not rendered yet will be: the length its form asks for, or five seconds. */
function plannedMs(clip: Clip, recipe: RecipeInfo | undefined): number {
  return Math.max(1000, ((recipe ? secondsOf(recipe.inputs, clip.inputs) : null) ?? 5) * 1000);
}

/**
 * The clips side by side, each as wide as it is long. `stretch` replaces the length of one clip while
 * its edge is being dragged.
 */
export function layout(clips: Clip[], pps: number, recipes: RecipeInfo[], stretch?: { clip: string; lengthMs: number }): Slot[] {
  let at = 0;
  return clips.map((clip, index) => {
    const planned = clip.lengthMs <= 0;
    const lengthMs = stretch?.clip === clip.id ? stretch.lengthMs : planned ? plannedMs(clip, recipes.find((r) => r.id === clip.recipe)) : clip.lengthMs;
    const slot = { clip, index, startMs: at, lengthMs, left: PAD + (at / 1000) * pps, width: (lengthMs / 1000) * pps, planned };
    at += lengthMs;
    return slot;
  });
}

/** Where the playhead is drawn for a moment of what plays, and which clip it is in. */
export function placeOf(slots: Slot[], playMs: number): { slot: Slot; x: number; layoutMs: number } | null {
  const playable = slots.filter((s) => !s.planned);
  const slot = playable.find((s) => playMs >= s.clip.atMs && playMs < s.clip.atMs + s.clip.lengthMs) ?? playable.at(-1);
  if (!slot) return null;
  const local = Math.max(0, Math.min(slot.clip.lengthMs, playMs - slot.clip.atMs));
  const part = slot.clip.lengthMs ? local / slot.clip.lengthMs : 0;
  return { slot, x: slot.left + part * slot.width, layoutMs: slot.startMs + part * slot.lengthMs };
}

/**
 * Where a split at the playhead cuts a clip, in its video's own time: only inside what plays of it, never on a cut (a frame,
 * FRAME_SLACK_MS, from either end); else why not, for the note.
 */
export function splitPoint(c: Clip, assetMs: number): { at: number } | { why: string } {
  const take = c.take;
  if (!take) return { why: c.kind === "still" ? "a still has no take to split" : "nothing rendered to split yet" };
  if (assetMs < take.startMs + FRAME_SLACK_MS || assetMs > take.endMs - FRAME_SLACK_MS) return { why: "the playhead is on a cut" };
  return { at: assetMs };
}

/** The moment of what plays under a point of the track. Over a clip that is not rendered: where it would start. */
export function playAt(slots: Slot[], x: number): number {
  const slot = slots.find((s) => x < s.left + s.width) ?? slots.at(-1);
  if (!slot) return 0;
  if (slot.planned) return slot.clip.atMs;
  const part = Math.max(0, Math.min(1, (x - slot.left) / Math.max(1, slot.width)));
  return slot.clip.atMs + part * slot.clip.lengthMs;
}

/** A clip's name on the track: the start of what happens in it, or what it is. */
export function titleOf(clip: Clip, recipe: RecipeInfo | undefined): string {
  if (clip.kind === "still") return clip.still?.name || "Still";
  const main = recipe?.inputs.find((i) => i.type === "prompt");
  const text = main ? String(clip.inputs[main.id] ?? "").trim() : "";
  return text || (recipe ? "New clip" : clip.take?.asset.name || "Imported video");
}

export type Shape = "tall" | "wide" | "square";
export const shapeOf = (width: number, height: number): Shape => (Math.abs(width / height - 1) < 0.04 ? "square" : width > height ? "wide" : "tall");
/** The frames a timeline can be given by name. A model fits its own size inside them. */
export const SHAPES: Record<Shape, { label: string; ratio: string; width: number; height: number }> = {
  tall: { label: "Portrait", ratio: "9:16", width: 576, height: 1024 },
  wide: { label: "Landscape", ratio: "16:9", width: 1024, height: 576 },
  square: { label: "Square", ratio: "1:1", width: 768, height: 768 },
};

/** Whether what a clip shows has another shape than the timeline's frame (it is then shown with bars, or fills it). */
export function otherShape(clip: Clip, frame: { width: number | null; height: number | null }): boolean {
  const a = clip.kind === "still" ? clip.still : clip.take?.asset;
  if (!a?.width || !a.height || !frame.width || !frame.height) return false;
  return Math.abs(a.width / a.height - frame.width / frame.height) > 0.03;
}

/** The recipe inputs that hold a clip's pictures: the one it opens on, the one it ends on, one it passes through (with the input that says when). */
export function pinInputs(recipe: RecipeInfo | undefined) {
  const find = (role: "start" | "end" | "mid") => recipe?.inputs.find((i) => i.type === "image" && i.role === role);
  const mid = find("mid");
  return { start: find("start")?.id, end: find("end")?.id, mid: mid?.type === "image" && mid.at ? mid.id : undefined, midAt: mid?.type === "image" ? mid.at : undefined };
}

/** Where a picture is pinned on a clip: its first frame, its last frame, its keyframe. */
export type PinWhere = "start" | "end" | "mid";

/** A pinned frame's words: "first frame", "last frame", "keyframe". */
export const PIN_WORDS: Record<PinWhere, string> = { start: "first frame", end: "last frame", mid: "keyframe" };

/** What a clip's pinned frame's Mirror says, its menus and the command bar alike. */
export interface PinMirror {
  where: PinWhere;
  /** The recipe input that holds the picture. */
  input: string;
  /** The picture pinned there. */
  asset: string;
  /** It is flipped left to right at render time. */
  on: boolean;
  /** Why it cannot be flipped (the item is off, this its note); null when it can. */
  why: string | null;
}

/**
 * Mirror on the picture pinned at `where` of a clip: null when nothing is pinned there. `inputs`: its form as it stands
 * (the Inspector's, written or not yet). A first frame carried on from the clip before is that clip's: flipped, the join
 * would no longer meet, so it cannot be (the server passes the flip over there too). A last frame the user pinned always
 * wins over a landing on the clip after, so it is always the user's own.
 */
export function pinMirrorOf(clip: Pick<Clip, "pinMirror" | "joined">, recipe: RecipeInfo | undefined, inputs: Record<string, unknown>, where: PinWhere, carries: boolean): PinMirror | null {
  const input = pinInputs(recipe)[where];
  const asset = input ? inputs[input] : undefined;
  if (!input || typeof asset !== "string" || !asset) return null;
  const why = where === "start" && carries ? "carried on from the clip before: the join would no longer meet" : null;
  return { where, input, asset, on: !why && (clip.pinMirror ?? []).includes(input), why };
}

/** The pinned frames of a clip, with what their Mirror says, in the order they play. */
export const pinMirrors = (clip: Pick<Clip, "pinMirror" | "joined">, recipe: RecipeInfo | undefined, inputs: Record<string, unknown>, carries: boolean): PinMirror[] =>
  (["start", "mid", "end"] as const).flatMap((w) => pinMirrorOf(clip, recipe, inputs, w, carries) ?? []);

/** How much of a take can play at most: its video on the model's grid, without the parts it shares with its neighbours (the server's roomMs). */
export const roomOf = (take: Take) => take.roomMs;

/** Past this a finished take's file and its draft's are not the same length (a frame or two of rounding is not). */
const SAME_LENGTH_MS = 150;

/**
 * What is wrong with a take as it stands, in a sentence; null when nothing is. A take of which nothing is left to play,
 * or a finished take whose file is not its draft's length (it must keep it: its trims and joins are counted in the
 * draft's time), is broken, and its row says so rather than showing "0.0 s" as a length like any other.
 */
export function takeTrouble(take: Take, takes: Take[]): string | null {
  const s = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  const file = take.asset.durationMs ?? null;
  const draft = take.finishedFrom ? takes.find((t) => t.id === take.finishedFrom) : undefined;
  const draftFile = draft?.asset.durationMs ?? null;
  if (draft && file !== null && draftFile !== null && Math.abs(file - draftFile) > SAME_LENGTH_MS) {
    return `Its file is ${s(file)}, its draft's ${s(draftFile)}: a finished take keeps its draft's length, so its trims and joins no longer line up. Finish the draft again, or remove this take.`;
  }
  if (take.endMs - take.startMs <= 0) return `Nothing of it is left to play${file !== null ? ` (its file is ${s(file)})` : ""}. Remove this take, or render another.`;
  return null;
}

/** A clip's change as the server takes it, a trim asked by what is seen (shownFromMs, shownToMs) included. */
export type ShownPatch = ClipPatch;

/** The version of a file, for an address the browser may keep for good: it changes when a linked file is written again. */
export const fileVersion = (a: Asset) => `${a.bytes}-${Date.parse(a.createdAt) || 0}`;

/** Where a clip moved one place earlier (-1) or later (1) goes: the clip it then comes after, null for first; undefined when it is at that end already. */
export function moveAfter(clips: Clip[], id: string, by: -1 | 1): string | null | undefined {
  const i = clips.findIndex((c) => c.id === id);
  if (i < 0 || (by < 0 && i === 0) || (by > 0 && i === clips.length - 1)) return undefined;
  if (by > 0) return clips[i + 1]!.id;
  return i >= 2 ? clips[i - 2]!.id : null;
}

/**
 * What the player plays changes only when this does: the clips that play, their takes and pictures, where they start, how
 * long, what is heard and how they join. A timeline read again with nothing of that changed keeps the player's frame loop.
 */
export const playSignature = (clips: Clip[]) =>
  clips
    .filter((c) => c.lengthMs > 0 && (c.take || c.still))
    .map((c) => [c.id, c.take?.id ?? c.still?.id, c.atMs, c.lengthMs, c.take?.startMs, c.take?.headMs, c.take?.trimStartMs, c.take?.landedMs ?? "", c.take?.seamless ? 1 : 0, c.joined, c.sound, c.soundAsset?.id ?? "", c.volume, c.fill ? 1 : 0].join(":"))
    .join("|");
