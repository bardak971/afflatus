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
  give?: number;
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
/** The take-over point a new take gets: four frames early on a latent or hybrid join with room for it, else none. */
export const leadFor = (kind: JoinKind | null, headMs: number) => (kind && kind !== "pixels" && headMs >= 2 * LEAD_MS ? LEAD_MS : 0);

/**
 * The part of a take that plays, in its video's own time: after the frames it shares with the clip before
 * and before the ones it shares with the clip after, less what was trimmed by hand. The joins anchor here
 * (a continuation is cut from where this ends), whatever the take-over point does to what is seen.
 */
export const plays = (t: { take: TakeRow; asset: AssetRow }) => {
  const start = t.take.head_ms + t.take.trim_start_ms;
  const end = Math.max(start, (t.asset.duration_ms ?? 0) - t.take.tail_ms - t.take.trim_end_ms);
  return { start, end };
};
/** The part of a take that is seen: `plays`, moved by the take-over points, its own at the start and the clip after's at the end. */
export const visible = (t: Taken) => {
  const p = plays(t);
  const start = Math.max(0, p.start - (t.take.lead_ms ?? 0));
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
