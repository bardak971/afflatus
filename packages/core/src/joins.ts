/**
 * How a timeline's clips meet: whether a take still follows the one before or lands on the one after, how a join
 * fades in, and H3's latent grid that joins are cut on. The same sums on the server (what plays, what the export
 * makes) and in the browser (what the player shows), so that the two agree.
 */

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

/**
 * How a take fades in over the clip before as it plays, in the export and the player alike: landed on (that clip's
 * guided tail shows the same moments) both moving, up to 170 ms; a continuation of a video clip, the clip before held
 * on its last frame, 170 ms. None for a cut, a seamless join (a plain cut is the whole chain decoded at once), or a
 * continuation with less than 80 ms of shared frames left (`sharedMs`: its head less what was trimmed off its start).
 */
export function joinFade(x: { landedMs?: number; joined: boolean; seamless: boolean; sharedMs: number }): { ms: number; mode: "hold" | "overlap" } | null {
  if (x.landedMs !== undefined) return x.landedMs >= 80 ? { ms: Math.min(170, x.landedMs), mode: "overlap" } : null;
  if (!x.joined || x.seamless || x.sharedMs < 80) return null;
  return { ms: 170, mode: "hold" };
}

/** H3's frames a second, the grid its latent's frames are on. */
export const MODEL_FPS = 24;

/**
 * The frame on H3's latent grid (17k + 5 frames) at or before `frame`: a clip handed over there continues in the
 * latent, cut on a whole chunk, rather than from frames.
 */
export const latentFrameAtOrBefore = (frame: number) => Math.floor((frame - 5) / 17) * 17 + 5;

/** The first frame of one of a latent's 17-frame chunks at or after `frame`: where a landing on it is made in the latent, on time. */
export const chunkAtOrAfter = (frame: number) => Math.ceil(frame / 17) * 17;
