/**
 * How a timeline's clips meet: whether a take still follows the one before or lands on the one after, how a join
 * fades in, and H3's latent grid that joins are cut on. The same sums on the server (what plays, what the export
 * makes) and in the browser (what the player shows), so that the two agree.
 */
import { chunkStartAtOrAfter, gridAtOrBefore, LATENT_GRID, type FrameGrid } from "./frameGrid";

/** Two moments are the same when they are within about a frame of each other. */
export const near = (a: number | null, b: number) => a !== null && Math.abs(a - b) <= 45;

/** A take as a join sees it: its own id, and the draft it is the finished version of (a finished take stands for its draft). */
export interface JoinTake {
  id: string;
  finishedFrom: string | null;
}

/** A link names this take: it was made against it, or against the draft it finishes (links are copied to the finished take). */
export const sameTake = (id: string | null, t: JoinTake) => id !== null && (id === t.id || id === t.finishedFrom);

/**
 * `b` still follows `a`: it was rendered carrying on from `a` (or the draft `a` finishes), from the moment `a` now stops
 * playing (`aEndMs`), and nothing was trimmed off its start since.
 */
export const follows = (b: { prevTakeId: string | null; prevAtMs: number | null; trimStartMs: number }, a: JoinTake, aEndMs: number) =>
  sameTake(b.prevTakeId, a) && near(b.prevAtMs, aEndMs) && b.trimStartMs === 0;

/**
 * `a` still lands on `b`: it was rendered to end where `b` (or the draft `b` finishes) starts playing (`bStartMs`), and
 * nothing was trimmed off its end since.
 */
export const landsOn = (a: { nextTakeId: string | null; nextAtMs: number | null; trimEndMs: number }, b: JoinTake, bStartMs: number) =>
  sameTake(a.nextTakeId, b) && near(a.nextAtMs, bStartMs) && a.trimEndMs === 0;

/** How long a join fades in: four frames at 24 a second (longer doubled a moving subject, see cut.ts DISSOLVE_MS). */
export const JOIN_FADE_MS = 170;
/** The shortest fade worth making: under it, the join is a cut. */
export const MIN_FADE_MS = 80;
/**
 * About one frame (41.7 ms at 24 a second): what a moment may be off by and still be the same frame, how far from a
 * clip's end a moment counts as its end, and the least a range must hold to hold anything.
 */
export const FRAME_SLACK_MS = 40;

/**
 * How a take fades in over the clip before as it plays, in the export and the player alike: landed on (that clip's
 * guided tail shows the same moments) both moving, up to 170 ms; a continuation of a video clip, the clip before held
 * on its last frame, 170 ms. None for a cut, a seamless join (a plain cut is the whole chain decoded at once), or a
 * continuation with less than 80 ms of shared frames left (`sharedMs`: its head less what was trimmed off its start). A window
 * whose head is the clip before's own last moments made again (`moving`, a SCAIL-2 window) fades over them both moving, as
 * a landing does: each window redraws the picture's fine detail, which a cut showed as a pop when little moved.
 */
export function joinFade(x: { landedMs?: number; joined: boolean; seamless: boolean; sharedMs: number; moving?: boolean }): { ms: number; mode: "hold" | "overlap" } | null {
  if (x.landedMs !== undefined) return x.landedMs >= MIN_FADE_MS ? { ms: Math.min(JOIN_FADE_MS, x.landedMs), mode: "overlap" } : null;
  if (!x.joined || x.seamless || x.sharedMs < MIN_FADE_MS) return null;
  if (x.moving) return { ms: Math.min(JOIN_FADE_MS, x.sharedMs), mode: "overlap" };
  return { ms: JOIN_FADE_MS, mode: "hold" };
}

/**
 * How long before a seamless join the sound hands over to the clip after, in the export and the player alike: its head
 * holds the same moments (the same latent decoded, its sound at the same time, measured r 0.95 to 0.99 on the owner's
 * chains, 2026-10-21), while the clip before's own sound ends early: 20 to 116 ms of silence at the end of every take
 * that carries on, measured on all of them, heard as a gap at every join. A seam's sound thus never plays a take's last
 * moments.
 */
export const SOUND_HANDOVER_MS = 120;

/**
 * How many ms before the join the sound hands over to the clip after (SOUND_HANDOVER_MS), or 0: only at a seamless join, or a
 * join whose head carries the clip before's own sound (`carried`: an LTX join, its head's sound pinned, still after that take), both
 * clips heard by their own sound, with as much of the clip after's head before where it plays (`shownFromMs`, its visible start
 * in its video) and of the clip before to play (`beforeMs`). Never into a clip whose head's sound is a guess (`guessedHead`: a
 * recording laid after its head, Lip sync's laysSound, without the lead-in, sungHead): the model's rough guess at it, while
 * the clip before plays the recording itself to its end; handed over, a song's joins played 120 ms of that guess. Into a head
 * filed with the recording, it hands over as any: the player switches from the clip after already running, hidden.
 */
export function soundHandover(x: { seamless: boolean; carried?: boolean; bothOwnSound: boolean; shownFromMs: number; beforeMs: number; guessedHead?: boolean }): number {
  if (!(x.seamless || x.carried) || !x.bothOwnSound || x.guessedHead) return 0;
  return x.shownFromMs >= SOUND_HANDOVER_MS && x.beforeMs > 2 * SOUND_HANDOVER_MS ? SOUND_HANDOVER_MS : 0;
}

/**
 * The frames a second of the latents the app keeps (H3's, on LATENT_GRID): frame N of a kept latent is at N / LATENT_FPS
 * seconds. A clip without a kept latent is on its own model's rate (traits.fps), never on this one.
 */
export const LATENT_FPS = 24;

/** A recipe's form as the joins read it: its inputs. */
type JoinForm = { inputs: ReadonlyArray<{ id: string; type: string; role?: string; frames?: number[]; framesFrom?: string; default?: unknown }> };

/**
 * How many frames of the clip before (`previous`) or after (`next`) a join of this recipe takes: the count its form asks in
 * the input its clip input names (`framesFrom`: H3's "Frames from the clip before", its Landing), else that input's default,
 * else the clip input's first count. 0 when the recipe takes no such clip.
 */
export function joinFrames(recipe: JoinForm | undefined, role: "previous" | "next", form: Record<string, unknown> = {}): number {
  const clip = recipe?.inputs.find((i) => i.type === "clip" && i.role === role);
  if (!clip) return 0;
  const counts = clip.framesFrom ? recipe!.inputs.find((i) => i.id === clip.framesFrom) : undefined;
  const asked = Number(clip.framesFrom ? form[clip.framesFrom] : NaN);
  if (Number.isFinite(asked) && asked > 0) return asked;
  const fallback = Number(counts?.default);
  return Number.isFinite(fallback) && fallback > 0 ? fallback : (clip.frames?.[0] ?? 0);
}

/**
 * How a kept latent counts its frames: the family whose model made it, that model's rate and frame grid, and (LTX) its size
 * in pixels. Stored beside it (assets.latent_clock); a latent stored without one is H3's, the one model whose latent was kept
 * before LTX's (pack 0.37.0). Frame N of a kept latent is at N / fps seconds, and a clip is handed over on its grid.
 */
export interface LatentClock {
  family: string;
  fps: number;
  grid: FrameGrid;
  width?: number;
  height?: number;
}
export const H3_CLOCK: LatentClock = { family: "h3", fps: LATENT_FPS, grid: LATENT_GRID };

/** A kept latent's clock as stored (latentClockText), H3's when none is. */
export function latentClockOf(stored: string | null | undefined): LatentClock {
  if (!stored) return H3_CLOCK;
  try {
    const c = JSON.parse(stored) as { family?: string; fps?: number; step?: number; offset?: number; width?: number; height?: number };
    if (!c.family || !(Number(c.fps) > 0) || !(Number(c.step) > 0) || !(Number(c.offset) > 0)) return H3_CLOCK;
    return { family: c.family, fps: Number(c.fps), grid: { step: Number(c.step), offset: Number(c.offset) }, ...(c.width && c.height ? { width: Number(c.width), height: Number(c.height) } : {}) };
  } catch {
    return H3_CLOCK;
  }
}

/** A clock as it is stored beside its latent. */
export const latentClockText = (c: LatentClock) =>
  JSON.stringify({ family: c.family, fps: c.fps, step: c.grid.step, offset: c.grid.offset, ...(c.width && c.height ? { width: c.width, height: c.height } : {}) });

/**
 * Whether a recipe can continue a latent of this clock: the same family, at the same rate, on the same grid. Across a change
 * of model (Extend kept on purpose) the clip before's latent is another model's and the join is made on frames.
 */
export const clockFits = (c: LatentClock, recipe: { family: string; traits?: { fps?: number; frameGrid?: FrameGrid } | null } | undefined) =>
  Boolean(recipe && recipe.family === c.family && recipe.traits?.fps === c.fps && recipe.traits.frameGrid?.step === c.grid.step && recipe.traits.frameGrid.offset === c.grid.offset);

/**
 * The frame on a kept latent's grid (H3's 17k + 5 frames unless another is given) at or before `frame`: a clip handed over
 * there continues in the latent, cut on a whole chunk, rather than from frames.
 */
export const latentFrameAtOrBefore = (frame: number, grid: FrameGrid = LATENT_GRID) => gridAtOrBefore(frame, grid);

/** The first frame of one of a latent's 17-frame chunks at or after `frame`: where a landing on it is made in the latent, on time. */
export const chunkAtOrAfter = (frame: number) => chunkStartAtOrAfter(frame, LATENT_GRID);

/** Seconds of a recording handed over before a clip's part, at most, for its head (a sound window's `leadIn`): more than H3's 917 ms run-up. */
export const LEAD_IN_S = 2;

/** How much of a recording is handed over before a part that starts `start` seconds into it, when its head is filed with it. */
export const leadInBefore = (start: number) => Math.max(0, Math.min(LEAD_IN_S, start));

/**
 * Whether the `pre` seconds of a recording handed over before a clip's part cover its head and the moment before its words
 * (`frames` in all, at `fps`). Only then does the graph sound them of the recording (Lip sync's sound), so only then may a
 * timeline say the head is sung (the window's `leadIn`): said with less, the player handed over early into the model's guess.
 */
export const leadInCovers = (pre: number, frames: number, fps: number) => frames > 0 && pre >= frames / fps - 1e-6;
