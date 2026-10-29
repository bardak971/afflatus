import type { EventEmitter } from "node:events";
import { chunkAtOrAfter, clipMusicOf, follows, joinFade as fadeOf, landsOn, LATENT_FPS, latentClockOf, plannedSeconds, transitionOf, windowPlaysSeconds, type ClipMusic, type JoinTake, type Recipe, type Transition } from "@afflatus/core";
import type { Db, Tables } from "./db";
import type { Registry } from "./registry";
import type { Storage } from "./storage";

/**
 * What every part of the timelines shares: the rows, a clip as placed with its takes, the arithmetic of
 * what a take plays and shows, and the door the range, media and export modules reach the model through.
 */

/** How many frames the trim bar asks for in a video's film strip: one a second, from sixteen up to a hundred and twenty (see Trim.tsx). */
const TRIM_STRIP_FRAMES = (durationMs: number) => Math.min(120, Math.max(16, Math.round(durationMs / 1000)));

/**
 * Where a video's film strip is kept (the track's, or one at a size: `30x48`). `-2` since the strips' last place stopped
 * coming out black (cut.ts, heldLast, 2026-10-15): the strips kept before are made again, and their names still swept.
 */
export const stripKey = (id: string, size?: string) => `strips/${id.slice(0, 2)}/${id}${size ? `-${size}` : ""}-2.jpg`;

/**
 * The keys of what the timeline works out of a video and keeps beside it: its film strip (the track's,
 * and the trim bar's when its length is known), its motion and loudness, its scene cuts, a sound's pauses, its colour along it, the join
 * scores of its takes. They go when the video goes, or when the file behind it changes (a linked folder's file written again).
 */
export function derivedKeys(asset: { id: string; duration_ms: number | null }): string[] {
  const dir = asset.id.slice(0, 2);
  const trim = asset.duration_ms ? `${TRIM_STRIP_FRAMES(asset.duration_ms)}x48` : null;
  return [
    stripKey(asset.id),
    ...(trim ? [stripKey(asset.id, trim)] : []),
    // the names before stripKey's `-2`
    `strips/${dir}/${asset.id}.jpg`,
    ...(trim ? [`strips/${dir}/${asset.id}-${trim}.jpg`] : []),
    `motion/${dir}/${asset.id}.json`,
    `scenes/${dir}/${asset.id}.json`,
    `pauses/${dir}/${asset.id}.json`,
    `means/${dir}/${asset.id}.json`,
    `joins/${dir}/${asset.id}.json`,
    `sounds/${dir}/${asset.id}.json`,
    `gains/${dir}/${asset.id}.json`,
  ];
}

/** The recipe id of a job that keeps a range of a video as new videos, instead of rendering something. */
export const CUT_JOB = "afflatus.cut";

/** The recipe id of a job that exports a timeline instead of rendering something. */
export const EXPORT_JOB = "afflatus.export";

export type TimelineRow = Tables["timelines"];
export type ClipRow = Tables["clips"];
export type TakeRow = Tables["takes"];
export type AssetRow = Tables["assets"];

/**
 * What stands for the opening picture of a clip that picks up from the last frame of the clip before it,
 * until that frame exists (the clip before may still be rendering when the job is queued).
 */
export const FROM_PREVIOUS = "the-clip-before";

/** "0:04", "0:04.5": a moment, for a cut's or a job's name (tenths only when they matter). */
export const clockOf = (ms: number) => {
  const tenths = Math.max(0, Math.round(ms / 100));
  const sec = Math.floor(tenths / 10);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}${tenths % 10 ? `.${tenths % 10}` : ""}`;
};

export const STILL_MS = { least: 500, most: 60_000 };

/** A take with its video, and what it gives up at its end to the clip after (that clip's take-over point, see `shown`). */
export interface Taken {
  take: TakeRow;
  asset: AssetRow;
  /** What it gives up at its end to the clip after; negative when it lands on that clip and plays on into the frames they share. */
  give?: number;
  /** The clip before lands on it (its tail was guided by this take's frames): it starts this many ms after where it plays, its own take-over point set aside. */
  landed?: number;
  /**
   * A seamless take placed after the very take it was decoded with, ending where it did: its join is a plain cut. A carried
   * one (an LTX join, the clip before's sound pinned at its head) after the take whose sound it carries: its sound hands over early.
   */
  seamed?: boolean;
}

export interface Placed {
  clip: ClipRow;
  takes: Taken[];
  active: Taken | null;
  /** Of a still: its picture. Of a clip with a sound file: that file. */
  still: AssetRow | null;
  sound: AssetRow | null;
  /** The pictures pinned on the clip's form: its first frame, last frame, keyframe (the input's id, and the picture). */
  pictures: Array<{ input: string; role: string; asset: AssetRow }>;
}

/** A clip that plays, on the timeline's clock: where it starts and how long. */
export interface Laid {
  p: Placed;
  /** Its place among all the clips, the ones with nothing to play included. */
  index: number;
  atMs: number;
  lengthMs: number;
}

/**
 * The take-over point of a join made in the latent: the continuation starts to play this many ms before its
 * shared frames end, and the clip before stops as much earlier. Four frames at 24 a second. Measured on 25
 * joins: a cut at the first own frame steps ×3.3 the clip's own motion (the model steps away from its guide
 * there), a cut four or five frames earlier, still inside the shared frames, ×0.8: invisible.
 */
const LEAD_MS = 167;
/**
 * A take's own take-over point at its start: none any more. The cut four frames early (inside the shared frames) still
 * stepped, ×2.9 the motion after its fade; the clip before now plays to its end and the continuation dissolves in from its
 * first own frame (DISSOLVE_MS, the export and the player), ×1.2 (2026-10-08). The lead takes kept per take is
 * dropped (0042); a timeline keeps its length (the clip before gains what the one after gave up). Landings keep LEAD_MS.
 */
export const leadOf = (t: Taken) => (seamless(t) ? seamLead(t.asset) : 0);
/**
 * A seamless take interpolated ×2 starts one of its frames early: the frame between the clip before's last and its own
 * first (both are in its file, decoded as one piece) then shows, as in the whole chain decoded and interpolated at once.
 * The clip before gives it back: an interpolated file is that frame short of its length on the model's grid.
 */
const seamLead = (asset: AssetRow) => ((asset.fps ?? 24) > 30 ? Math.round(1000 / (asset.fps ?? 48)) : 0);
/** A join decoded as one piece with the clip before: a plain cut is the whole chain decoded at once (no fade, no colour step). */
export const seamless = (t: Taken | null | undefined) => Boolean(t?.seamed) && t?.take.join_kind === "seamless" && t.landed === undefined;
/** A join whose head sounds of the clip before's own sound, still after that very take: the sound hands over into its head early (core soundHandover). */
export const carried = (t: Taken | null | undefined) => Boolean(t?.seamed) && t?.take.join_kind === "carried" && t.landed === undefined;

/**
 * The part of a take that plays, in its video's own time: after the frames it shares with the clip before
 * and before the ones it shares with the clip after, less what was trimmed by hand. The joins anchor here
 * (a continuation is cut from where this ends), whatever the take-over point does to what is seen.
 */
export const plays = (t: { take: TakeRow; asset: AssetRow }) => {
  const start = t.take.head_ms + t.take.trim_start_ms;
  const end = Math.max(start, lengthOnGrid(t.asset) - t.take.tail_ms - t.take.trim_end_ms);
  return { start, end };
};
/**
 * How long a take's video is on the model's own frame grid. A render interpolated ×2 has 2N − 1 frames at twice
 * the rate, one of them short of N frames' time: anchored on the file's length, a continuation's shared frames
 * were placed half a model frame early and every join skipped a frame (measured 2026-10-07). With the model's
 * frame count kept (its latent), the length is that count's; otherwise, and for a file that is not that render, the file's.
 */
export const lengthOnGrid = (asset: Pick<AssetRow, "duration_ms" | "latent_frames" | "latent_clock">) => {
  const file = asset.duration_ms ?? 0;
  // the count at its own model's rate: H3's 24, LTX 2.3's 25 (latent_clock)
  const { fps } = latentClockOf(asset.latent_clock);
  const grid = asset.latent_frames ? Math.round((asset.latent_frames * 1000) / fps) : 0;
  return grid && Math.abs(grid - file) <= 1000 / fps ? grid : file;
};
/**
 * Whether two takes went through the same enlargement, as far as their size tells: a clip enlarged ×2 in its render
 * (RTX, a model upscaler) has a colour of its own, a little shifted from the model's. Matched across, the clip after was
 * nudged toward that shift, and the nudge carried down the rest of the chain. Taken at a different size: not matched
 */
export const sameMaking = (a: AssetRow, b: AssetRow) => {
  const short = (x: AssetRow) => Math.min(x.width ?? 0, x.height ?? 0);
  return short(a) > 0 && short(b) > 0 && Math.abs(short(a) - short(b)) <= 0.1 * Math.max(short(a), short(b));
};
/**
 * Where a clip put before this take lands on it: where it starts playing, brought forward to where one of its latent's
 * 17-frame chunks begins when its latent was kept (at most 16 frames, ⅔ s), so that the landing is made in the latent and
 * on time (pack 0.6.0, H3_LANDING). Not when that leaves too little of it to land on: then where it plays, from its frames.
 */
export const landingOnGrid = (t: { take: TakeRow; asset: AssetRow }, landFrames: number) => {
  const { start, end } = plays(t);
  // landed on in the latent: H3's only (its chunks); another model's take is landed on from its frames, where it plays
  if (!t.asset.latent_key || !t.asset.latent_frames || latentClockOf(t.asset.latent_clock).family !== "h3") return start;
  const frame = Math.ceil((start * LATENT_FPS) / 1000 - 0.25);
  const chunk = chunkAtOrAfter(frame);
  const at = Math.round((chunk * 1000) / LATENT_FPS);
  // the frames landed on in its latent (the landing the form asks), and half a second of it left to play
  return chunk + landFrames <= t.asset.latent_frames && at + 500 <= end ? Math.max(start, at) : start;
};
/** How a take fades in over the clip before as it plays, in the export and the player alike (see joinFade in @afflatus/core). */
export const joinFade = (x: Taken, joined: boolean) =>
  fadeOf({ landedMs: x.landed, joined, seamless: seamless(x), sharedMs: x.take.head_ms - x.take.trim_start_ms, moving: x.take.join_kind === "window" });
/** The part of a take that is seen: `plays`, moved by the take-over points, its own at the start and the clip after's at the end. */
export const visible = (t: Taken) => {
  const p = plays(t);
  const start = t.landed !== undefined ? p.start + t.landed : Math.max(0, p.start - leadOf(t));
  const end = Math.max(start, p.end - (t.give ?? 0));
  return { start, end };
};
/** How long a clip plays: its take's seen part, a still's time on screen, nothing when there is nothing to show. */
export const lengthOf = (p: Placed) => (p.clip.kind === "still" ? (p.still ? p.clip.still_ms : 0) : p.active ? visible(p.active).end - visible(p.active).start : 0);
/**
 * How long a clip is drawn in the editor: what it plays, or, with nothing to play yet, the length its form asks for (five
 * seconds when it says none, one at least). The same sum as the editor's layout (apps/web/src/timeline/model.ts), so the
 * command bar says the length the editor's header does.
 */
export const plannedLengthOf = (p: Placed, recipe: Recipe<any> | undefined, hiddenMs = 0) => {
  const plays = lengthOf(p);
  if (plays > 0) return plays;
  // `hiddenMs`: what its take will hide of its end (a window run past a part kept removed: SourcePlan.hidden)
  // a window of a source plays what it shows of it, its carried frames not counted twice (windowPlaysSeconds)
  const inputs = JSON.parse(p.clip.inputs) as Record<string, unknown>;
  return Math.max(1000, ((recipe ? windowPlaysSeconds(recipe, inputs, p.clip.joined) ?? plannedSeconds(recipe.inputs, inputs) : null) ?? 5) * 1000 - hiddenMs);
};

/**
 * A video clip's form filled enough to render, as the editor's ready() reads it: its texts written, its pictures chosen,
 * an opening picture that the clip before gives not asked for. Whether ComfyUI and the model files are there is not said here.
 */
export function formFilled(recipe: Recipe<any>, inputs: Record<string, unknown>, from: { carries: boolean; afterStill: boolean }): boolean {
  for (const i of recipe.inputs) {
    if (i.type === "prompt" && ((!i.optional && i.default === undefined) || i.example) && !String(inputs[i.id] ?? "").trim()) return false;
    const given = from.carries && i.type === "image" && ((i.role === "start" && (recipe.traits?.continues === "frame" || from.afterStill)) || Boolean(i.opensOnly));
    if (i.type === "image" && !i.optional && !inputs[i.id] && !given) return false;
    if (i.type === "clip" && i.role === "source" && !i.optional && !inputs[i.id]) return false;
  }
  return true;
}
/** What a take that opens on a still says it carried on from. */
export const stillRef = (assetId: string) => `still:${assetId}`;

/** A take row as the joins see it (see @afflatus/core's joins). */
const joinTake = (t: TakeRow): JoinTake => ({ id: t.id, finishedFrom: t.finished_from });
/** `b` still follows `a`: made from it (or the draft it finishes), from where it now stops, its own start untrimmed. */
export const takeFollows = (b: TakeRow, a: Taken) => follows({ prevTakeId: b.prev_take_id, prevAtMs: b.prev_at_ms, trimStartMs: b.trim_start_ms }, joinTake(a.take), plays(a).end);
/** `a` still lands on `b`: made to end where it (or the draft it finishes) now starts, its own end untrimmed. */
export const takeLandsOn = (a: TakeRow, b: Taken) => landsOn({ nextTakeId: a.next_take_id, nextAtMs: a.next_at_ms, trimEndMs: a.trim_end_ms }, joinTake(b.take), plays(b).start);

/**
 * How the clips of a timeline meet, marked on their takes. A clip that lands on the clip after (its tail was guided by
 * that take's frames) plays on into its guided tail, four frames, and the clip after starts as much later: cut where it
 * is guided, the landing does not step; cut before, in the frames the model drew freely, it did (×5 the motion, measured
 * 2026-10-07). Only while both ends are where the landing put them: trimmed off its guided tail, or the clip after moved,
 * it is a plain cut; so too under a transition on the join. A seamless take plays as a plain cut only after the take it
 * was decoded with, still ending where it did; after another take, or that one trimmed, its join is faded like any other.
 * A clip followed by a seamless take gives it back its take-over point (leadOf). A finished take stands for its draft
 * throughout.
 */
export function markJoins(placed: Placed[]): void {
  for (let i = 0; i < placed.length - 1; i++) {
    const next = placed[i + 1]!;
    const mine = placed[i]!.active;
    // a transition on the join plays over the cut instead: the landing's shared moments would show twice around it, and
    // the export run longer than the timeline (the clip before playing on into its tail, the clip after from its own start)
    const crossed = next.clip.joined === "cut" && transitionOfRow(next.clip) !== null;
    if (mine && next.active && !crossed && mine.take.tail_ms >= 2 * LEAD_MS && takeLandsOn(mine.take, next.active)) {
      mine.give = -LEAD_MS;
      next.active.landed = LEAD_MS;
      continue;
    }
    if (mine && next.active && next.clip.joined === "continue" && (next.active.take.join_kind === "seamless" || next.active.take.join_kind === "carried")) next.active.seamed = takeFollows(next.active.take, mine);
    const give = next.clip.kind === "video" && next.clip.joined === "continue" && next.active ? leadOf(next.active) : 0;
    if (give > 0) for (const t of placed[i]!.takes) t.give = give;
  }
}

/**
 * The timeline as it would play with another take of the clip at `index` playing: the take-over points (what the clip
 * before gives up, where a landing or a seamless take starts) are marked again for it. The placed clips are copied; the
 * ones given are left as they are. For figures of a take that does not play, measured as it would if it did.
 */
export function playingAs(placed: Placed[], index: number, takeId: string): Placed[] {
  const copy = placed.map((p, i) => {
    const takes = p.takes.map((t) => ({ take: t.take, asset: t.asset }) as Taken);
    const wanted = i === index ? takeId : p.active?.take.id;
    return { ...p, takes, active: takes.find((t) => t.take.id === wanted) ?? null };
  });
  markJoins(copy);
  return copy;
}

/** The least a rendered clip is left to play, trimmed: trimmed to nothing it would show as a clip not rendered yet. */
export const LEAST_PLAY_MS = 100;
/**
 * A take's trims for what is asked: `shownFromMs` the moment of its video its first frame seen is to be, `shownToMs` the moment
 * it is to stop being seen (as `visible` says: the trims are worked out from what is shown, not from what plays, so that a
 * landed or seamless clip is cut where it was seen; trimmed, such a join is a plain cut, and what is seen is what plays), or
 * the trims themselves. What is not asked keeps its trim. At least LEAST_PLAY_MS is left to play: the end gives way first.
 */
export function trimsOf(x: Taken, ask: { shownFromMs?: number; shownToMs?: number; trimStartMs?: number; trimEndMs?: number }): { start: number; end: number } {
  const total = lengthOnGrid(x.asset);
  const room = Math.max(0, total - x.take.head_ms - x.take.tail_ms);
  let start = ask.shownFromMs !== undefined ? ask.shownFromMs - x.take.head_ms : ask.trimStartMs ?? x.take.trim_start_ms;
  let end = ask.shownToMs !== undefined ? total - x.take.tail_ms - ask.shownToMs : ask.trimEndMs ?? x.take.trim_end_ms;
  start = Math.max(0, Math.round(start));
  end = Math.max(0, Math.round(end));
  const over = start + end - Math.max(0, room - LEAST_PLAY_MS);
  if (over > 0) {
    const endAsked = ask.shownToMs !== undefined || ask.trimEndMs !== undefined;
    const fromEnd = endAsked ? Math.min(end, over) : Math.max(0, over - start);
    end -= fromEnd;
    start = Math.max(0, start - (over - fromEnd));
  }
  return { start, end };
}

/**
 * A take's trims written, and its draft's with them when it is a finished take: a finish is redone from its draft, and the
 * draft plays again when the finish is removed, so both play the same part (a finish keeps its draft's length: their trims
 * are in the same time). Written on the finished take alone, a redo put back the seconds a split or a hand-over had cut.
 */
export async function setTrims(db: Db, takeId: string, trims: { trim_start_ms?: number; trim_end_ms?: number }): Promise<void> {
  const draft = (await db.selectFrom("takes").select("finished_from").where("id", "=", takeId).executeTakeFirst())?.finished_from;
  await db.updateTable("takes").set(trims).where("id", "in", draft ? [takeId, draft] : [takeId]).execute();
}

/** The clips that play, on the timeline's clock. */
export function laidOut(all: Placed[]): Laid[] {
  let at = 0;
  const out: Laid[] = [];
  all.forEach((p, index) => {
    const lengthMs = lengthOf(p);
    if (lengthMs > 0) out.push({ p, index, atMs: at, lengthMs });
    at += lengthMs;
  });
  return out;
}

/**
 * The model as the range, media and export modules see it: the database, the files and the events, and
 * the few things only the model does (reading its rows, placing a timeline's clips, keeping a state for
 * Undo, marking a change, keeping a file, numbering clips, a new clip's settings, a frame of a video as a picture).
 */
export interface TimelineCore {
  db: Db;
  storage: Storage;
  registry: Registry;
  events: EventEmitter;
  row(id: string): Promise<TimelineRow>;
  clipRow(id: string): Promise<ClipRow>;
  assetRow(id: string | null): Promise<AssetRow | undefined>;
  /** The clips of a timeline in order, each with its takes (those whose video still exists). `db`: the transaction this is part of. */
  placed(timelineId: string, db?: Db): Promise<Placed[]>;
  /** How much moves along a video and how loud it is, and where people speak in it (timelineMedia.motion). */
  motion(assetId: string, row?: AssetRow): Promise<{ rate: number; values: number[]; sound: number[] | null; speech: number[] | null }>;
  /**
   * Keep what the timeline looks like now, before a change. `label` says what the change is, for the Undo button; `added`, a take
   * the change adds. `db`: the transaction the change is made in, only from inside the timeline's turn (oneAtATime).
   */
  remember(timelineId: string, label: string, added?: string, db?: Db): Promise<number>;
  /**
   * Work done in the timeline's turn (`key`: its id): Undo, Redo, a take landing and the edits of several statements never
   * run into one another. A transaction is opened inside the turn, never the other way round (the turn waits on work that
   * needs the database).
   */
  oneAtATime<T>(key: string, work: () => Promise<T>): Promise<T>;
  touch(timelineId: string): Promise<void>;
  /** What is on a timeline is wanted: it never goes to the bin on its own. `db`: the transaction this is part of. */
  keep(assetId: string, db?: Db): Promise<void>;
  renumber(timelineId: string, order: string[], db?: Db): Promise<void>;
  /** What a new clip takes over from the nearest clip before it made with the same recipe: its settings, not its story or its pictures. */
  settingsOf(recipe: Recipe<any>, all: Placed[], index: number): Record<string, unknown>;
  /** One frame of a video as a picture in the library (timelineMedia.ts), in the folder of the timeline it is taken in. */
  frame(video: AssetRow, atMs: number, once?: boolean, timeline?: string): Promise<AssetRow>;
  /**
   * Clips about to be removed that are part of a recording or the source cut their part out of it, as a clip removed does
   * (Timelines.cutRuns): those set aside are off the timeline after it, the rest are the caller's to delete. `db`: the
   * transaction the removal is made in.
   */
  cutRuns(timelineId: string, ids: string[], db: Db): Promise<void>;
}

/** A clip's music settings as stored: only what differs from the rest; null when nothing does. */
export const musicJson = (m: ClipMusic | null) => {
  const kept = clipMusicOf(m);
  return kept ? JSON.stringify(kept) : null;
};

/** A clip's music settings as its row keeps them. */
export function musicOfRow(c: Pick<ClipRow, "music">): ClipMusic | null {
  if (!c.music) return null;
  try {
    return clipMusicOf(JSON.parse(c.music));
  } catch {
    return null;
  }
}

/** A cut's transition as stored, checked (its length held within bounds); null for a plain cut. */
export const transitionJson = (t: Transition | null) => {
  const kept = transitionOf(t);
  return kept ? JSON.stringify(kept) : null;
};

/** A clip's transition as its row keeps it. */
export function transitionOfRow(c: Pick<ClipRow, "transition">): Transition | null {
  if (!c.transition) return null;
  try {
    return transitionOf(JSON.parse(c.transition));
  } catch {
    return null;
  }
}

/** The music's own settings for the plan (@afflatus/core's musicPlan), from the timeline and the song's row. */
export const musicBaseOf = (t: TimelineRow, song: Pick<AssetRow, "duration_ms"> | undefined | null) => ({
  volume: t.music_volume, fadeInMs: t.music_fade_in_ms, fadeOutMs: t.music_fade_out_ms, duck: Boolean(t.music_duck), duckDb: t.music_duck_db,
  fromMs: t.music_from_ms ?? 0, durationMs: song?.duration_ms ?? 0, startClip: t.music_start_clip_id ?? null,
});

/** The clips that play, as the music plan takes them. */
export const musicClipsOf = (laid: Laid[]) => laid.map((l) => ({ id: l.p.clip.id, atMs: l.atMs, lengthMs: l.lengthMs, music: musicOfRow(l.p.clip) }));

/** The pinned pictures a clip flips left to right at render time, as its row keeps them: their input ids. */
export function mirrorOfRow(c: Pick<ClipRow, "pin_mirror">): string[] {
  if (!c.pin_mirror) return [];
  try {
    const flips = JSON.parse(c.pin_mirror) as Record<string, unknown>;
    return Object.keys(flips).filter((k) => flips[k] === true).sort();
  } catch {
    return [];
  }
}

/** The flips as a row keeps them: null when none is left. */
export const mirrorJson = (ids: string[]) => (ids.length ? JSON.stringify(Object.fromEntries([...new Set(ids)].sort().map((k) => [k, true]))) : null);

/**
 * Which of `flips` a render of the clip makes: only on a picture the user pinned there. A first frame is not the user's when
 * the clip carries on from the one before (the frame comes from that clip, or the clip itself does), and a last frame not
 * when the clip lands on the one after: flipped, the join would no longer meet, so the flip is passed over there.
 */
export function mirroredPins(recipe: Recipe<any>, inputs: Record<string, unknown>, flips: readonly string[], from: { carries: boolean; lands?: boolean }): string[] {
  const out: string[] = [];
  for (const i of recipe.inputs) {
    if (i.type !== "image" || !flips.includes(i.id)) continue;
    const value = inputs[i.id];
    if (typeof value !== "string" || !value || value === FROM_PREVIOUS) continue;
    if (i.role === "start" ? !from.carries : i.role === "end" ? !from.lands : i.role === "mid") out.push(i.id);
  }
  return out.sort();
}
