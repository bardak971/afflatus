import type { EventEmitter } from "node:events";
import { chunkAtOrAfter, clipMusicOf, follows, joinFade as fadeOf, landsOn, MODEL_FPS, secondsOf, type ClipMusic, type JoinTake, type Recipe } from "@afflatus/core";
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
 * The keys of what the timeline works out of a video and keeps beside it: its film strip (the track's,
 * and the trim bar's when its length is known), its motion and loudness, its scene cuts, its colour along it, the join
 * scores of its takes. They go when the video goes, or when the file behind it changes (a linked folder's file written again).
 */
export function derivedKeys(asset: { id: string; duration_ms: number | null }): string[] {
  const dir = asset.id.slice(0, 2);
  return [
    `strips/${dir}/${asset.id}.jpg`,
    ...(asset.duration_ms ? [`strips/${dir}/${asset.id}-${TRIM_STRIP_FRAMES(asset.duration_ms)}x48.jpg`] : []),
    `motion/${dir}/${asset.id}.json`,
    `scenes/${dir}/${asset.id}.json`,
    `means/${dir}/${asset.id}.json`,
    `joins/${dir}/${asset.id}.json`,
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
  /** A seamless take placed after the very take it was decoded with, ending where it did: its join is a plain cut. */
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
export const lengthOnGrid = (asset: AssetRow) => {
  const file = asset.duration_ms ?? 0;
  const grid = asset.latent_frames ? Math.round((asset.latent_frames * 1000) / MODEL_FPS) : 0;
  return grid && Math.abs(grid - file) <= 1000 / MODEL_FPS ? grid : file;
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
export const landingOnGrid = (t: { take: TakeRow; asset: AssetRow }) => {
  const { start, end } = plays(t);
  if (!t.asset.latent_key || !t.asset.latent_frames) return start;
  const frame = Math.ceil((start * MODEL_FPS) / 1000 - 0.25);
  const chunk = chunkAtOrAfter(frame);
  const at = Math.round((chunk * 1000) / MODEL_FPS);
  // the 22 frames landed on in its latent, and half a second of it left to play
  return chunk + 22 <= t.asset.latent_frames && at + 500 <= end ? Math.max(start, at) : start;
};
/** How a take fades in over the clip before as it plays, in the export and the player alike (see joinFade in @afflatus/core). */
export const joinFade = (x: Taken, joined: boolean) =>
  fadeOf({ landedMs: x.landed, joined, seamless: seamless(x), sharedMs: x.take.head_ms - x.take.trim_start_ms });
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
export const plannedLengthOf = (p: Placed, recipe: Recipe<any> | undefined) => {
  const plays = lengthOf(p);
  if (plays > 0) return plays;
  return Math.max(1000, ((recipe ? secondsOf(recipe.inputs, JSON.parse(p.clip.inputs) as Record<string, unknown>) : null) ?? 5) * 1000);
};

/**
 * A video clip's form filled enough to render, as the editor's ready() reads it: its texts written, its pictures chosen,
 * an opening picture that the clip before gives not asked for. Whether ComfyUI and the model files are there is not said here.
 */
export function formFilled(recipe: Recipe<any>, inputs: Record<string, unknown>, from: { carries: boolean; afterStill: boolean }): boolean {
  for (const i of recipe.inputs) {
    if (i.type === "prompt" && ((!i.optional && i.default === undefined) || i.example) && !String(inputs[i.id] ?? "").trim()) return false;
    const given = from.carries && i.type === "image" && i.role === "start" && (recipe.traits?.continues === "frame" || from.afterStill);
    if (i.type === "image" && !i.optional && !inputs[i.id] && !given) return false;
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
 * it is a plain cut. A seamless take plays as a plain cut only after the take it was decoded with, still ending where it
 * did; after another take, or that one trimmed, its join is faded like any other. A clip followed by a seamless take
 * gives it back its take-over point (leadOf). A finished take stands for its draft throughout.
 */
export function markJoins(placed: Placed[]): void {
  for (let i = 0; i < placed.length - 1; i++) {
    const next = placed[i + 1]!;
    const mine = placed[i]!.active;
    if (mine && next.active && mine.take.tail_ms >= 2 * LEAD_MS && takeLandsOn(mine.take, next.active)) {
      mine.give = -LEAD_MS;
      next.active.landed = LEAD_MS;
      continue;
    }
    if (mine && next.active && next.clip.joined === "continue" && next.active.take.join_kind === "seamless") next.active.seamed = takeFollows(next.active.take, mine);
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
  motion(assetId: string): Promise<{ rate: number; values: number[]; sound: number[] | null; speech: number[] | null }>;
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

/** The music's own settings for the plan (@afflatus/core's musicPlan), from the timeline and the song's row. */
export const musicBaseOf = (t: TimelineRow, song: Pick<AssetRow, "duration_ms"> | undefined | null) => ({
  volume: t.music_volume, fadeInMs: t.music_fade_in_ms, fadeOutMs: t.music_fade_out_ms, duck: Boolean(t.music_duck), duckDb: t.music_duck_db,
  fromMs: t.music_from_ms ?? 0, durationMs: song?.duration_ms ?? 0, startClip: t.music_start_clip_id ?? null,
});

/** The clips that play, as the music plan takes them. */
export const musicClipsOf = (laid: Laid[]) => laid.map((l) => ({ id: l.p.clip.id, atMs: l.atMs, lengthMs: l.lengthMs, music: musicOfRow(l.p.clip) }));
