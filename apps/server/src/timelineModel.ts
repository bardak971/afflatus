import type { EventEmitter } from "node:events";
import type { JoinKind, Recipe } from "@afflatus/core";
import type { Db, Tables } from "./db";
import type { Registry } from "./registry";
import type { Storage } from "./storage";

/**
 * What every part of the timelines shares: the rows, a clip as placed with its takes, the arithmetic of
 * what a take plays and shows, and the door the range, media and export modules reach the model through.
 */

export type TimelineRow = Tables["timelines"];
export type ClipRow = Tables["clips"];
export type TakeRow = Tables["takes"];
export type AssetRow = Tables["assets"];

/** Two moments are the same when they are within about a frame of each other. */
export const near = (a: number | null, b: number) => a !== null && Math.abs(a - b) <= 45;

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
export const LEAD_MS = 167;
/**
 * A take's own take-over point at its start: none any more. The cut four frames early (inside the shared frames) still
 * stepped, ×2.9 the motion after its fade; the clip before now plays to its end and the continuation dissolves in from its
 * first own frame (DISSOLVE_MS, the export and the player), ×1.2 (2026-10-08). Takes made before keep a stored lead_ms,
 * set aside here; a timeline keeps its length (the clip before gains what the one after gave up). Landings keep LEAD_MS.
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
/** The take-over point a new take gets: none (see leadOf). */
export const leadFor = (_kind: JoinKind | null, _headMs: number) => 0;

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
/** H3's frames a second, the grid its latent's frames are on. */
const MODEL_FPS = 24;
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
  const chunk = Math.ceil(frame / 17) * 17;
  const at = Math.round((chunk * 1000) / MODEL_FPS);
  // the 22 frames landed on in its latent, and half a second of it left to play
  return chunk + 22 <= t.asset.latent_frames && at + 500 <= end ? Math.max(start, at) : start;
};
/**
 * How a take fades in over the clip before as it plays, in the export and the player alike: landed on (that clip's
 * guided tail shows the same moments) both moving, 170 ms; a continuation made in the latent, the clip before held on
 * its last frame, 170 ms (DISSOLVE_MS); one made from frames, the same over 170 ms. None for a cut.
 */
export const joinFade = (x: Taken, joined: boolean): { ms: number; mode: "hold" | "overlap" } | null => {
  if (x.landed !== undefined) return x.landed >= 80 ? { ms: Math.min(170, x.landed), mode: "overlap" } : null;
  if (!joined || seamless(x) || x.take.head_ms - x.take.trim_start_ms < 80) return null;
  return { ms: 170, mode: "hold" };
};
/** The part of a take that is seen: `plays`, moved by the take-over points, its own at the start and the clip after's at the end. */
export const visible = (t: Taken) => {
  const p = plays(t);
  const start = t.landed !== undefined ? p.start + t.landed : Math.max(0, p.start - leadOf(t));
  const end = Math.max(start, p.end - (t.give ?? 0));
  return { start, end };
};
/** How long a clip plays: its take's seen part, a still's time on screen, nothing when there is nothing to show. */
export const lengthOf = (p: Placed) => (p.clip.kind === "still" ? (p.still ? p.clip.still_ms : 0) : p.active ? visible(p.active).end - visible(p.active).start : 0);
/** What a take that opens on a still says it carried on from. */
export const stillRef = (assetId: string) => `still:${assetId}`;

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
 * Undo, marking a change, numbering clips, a new clip's settings, a frame of a video as a picture).
 */
export interface TimelineCore {
  db: Db;
  storage: Storage;
  registry: Registry;
  events: EventEmitter;
  row(id: string): Promise<TimelineRow>;
  clipRow(id: string): Promise<ClipRow>;
  assetRow(id: string | null): Promise<AssetRow | undefined>;
  /** The clips of a timeline in order, each with its takes (those whose video still exists). */
  placed(timelineId: string): Promise<Placed[]>;
  /** Keep what the timeline looks like now, before a change. `label` says what the change is, for the Undo button. */
  remember(timelineId: string, label: string): Promise<number>;
  touch(timelineId: string): Promise<void>;
  renumber(timelineId: string, order: string[], db?: Db): Promise<void>;
  /** What a new clip takes over from the nearest clip before it made with the same recipe: its settings, not its story or its pictures. */
  settingsOf(recipe: Recipe<any>, all: Placed[], index: number): Record<string, unknown>;
  /** One frame of a video as a picture in the library (timelineMedia.ts). */
  frame(video: AssetRow, atMs: number, once?: boolean): Promise<AssetRow>;
}
