/** Timelines: clips and their takes, what was measured along them, and the patches that change them. */
import type { Asset } from "./library";
import type { ClipMusic, Transition } from "@afflatus/core";
import type { DesignerSession, Look } from "./designer";

/** One render of a clip. `startMs` to `endMs` is the part of its video that plays. */
export interface Take {
  id: string;
  asset: Asset;
  headMs: number;
  tailMs: number;
  trimStartMs: number;
  trimEndMs: number;
  startMs: number;
  endMs: number;
  createdAt: string;
  /** The take this one is the finished (upscaled) version of. */
  finishedFrom: string | null;
  /** How its start joins the clip before: in the latent (the clip before's own tokens continued), or pinned frames; null when it does not continue a clip. */
  joinKind: "seamless" | "latent" | "hybrid" | "pixels" | "carried" | "window" | "still" | null;
  /** The clip before lands on it: it starts this many ms after its own frames would (the take-over point is inside that clip's guided tail). */
  landedMs?: number;
  /** Decoded as one piece with the clip before, still the take it was made from: the join plays as a plain cut. */
  seamless?: boolean;
  /** Its head sounds of the clip before's own sound (an LTX join), still after the take it was made from: the sound hands over into it early (core soundHandover). */
  carried?: boolean;
  /** How much of its video can play at most: on the model's grid, without the parts it shares with its neighbours. */
  roomMs: number;
  /** How long its render took, when it was rendered here; null otherwise. */
  renderMs: number | null;
  /** How its own part looks, measured on its frames when it was rendered here; null otherwise. */
  measure: Measure | null;
  /** The recipe it was rendered with, when it was rendered here; null otherwise. */
  recipe: string | null;
  /** Made by a Face refine alone (a Face pass of the take it finishes): the same frames, its faces redrawn. */
  facePass?: boolean;
  /** Its sound is a recording laid after its head (Lip sync): the sound never hands over to its head early (core soundHandover). */
  laidSound?: boolean;
  /** Its head filed with the recording the clip before sang (the lead-in), not the model's guess: the sound hands over to it as to any. */
  headSung?: boolean;
  /** What it was made with, as its clip's form would hold it (its draft's, for a finish); null for a take rendered nowhere here. */
  made: TakeMade | null;
}
/** A take's form as it was rendered: what "Use this take's settings" puts back into its clip's form. */
export interface TakeMade {
  recipe: string;
  /** Its form as typed (the cast's additions and what the timeline fills in left out), with the seed it was rendered with. */
  form: Record<string, unknown>;
  /** Its first frame was the clip before's, handed on by the timeline: no picture was pinned on its form. */
  carried?: boolean;
  /** The pinned pictures it flipped (Mirror), by input id. */
  mirror: string[];
}
/** How a take's own part looks, measured on its real frames when it was rendered (the server's lookOf). Older takes carry the first two only. */
export interface Measure {
  /** Mean luma, 0 to 255. */
  luma: number;
  /** The mean absolute Laplacian of a small grey copy: 0 is flat, several units is crisp. Grain counts in it. */
  sharp: number;
  /** The same without the grain (on a copy cleaned of its fine noise); takes measured before 2026-10-14 have none. */
  edges?: number;
  /** The fine noise: how far the pixels sit from their cleaned copy, in luma steps. */
  grain?: number;
  /** How much the face along the clip is the person it is of (its Picture, its cast), -1 to 1: the median over a few frames, and the lowest. */
  face?: number;
  faceLow?: number;
  /** Mean chroma against neutral: U blue (+) to yellow (−), V red (+) to green (−). */
  chroma?: { u: number; v: number };
  /** Where the darkest and the brightest tenth of the picture sit in luma. */
  range?: { low: number; high: number };
  /** Mean change of the frame's mean luma from one sampled frame to the next, as a percentage. */
  flicker?: number;
  /** Mean frame-to-frame change: the ruler's motion figure. */
  pace?: number;
  /** The sound's spectral centroid in Hz; null without sound. */
  voice?: number | null;
  /** A join made in the latent: how wide the regenerated run-up came out against the tail it was guided by (1 = the same). */
  drift?: { width: number };
  /** A continuation: how much the picture jumps where the run-up ends and its own frames begin, against its own motion (×1 carries on; past ×3 a cut shows there). */
  handover?: number;
}
export interface Clip {
  id: string;
  /** "still": a picture held on screen instead of a video. */
  kind: "video" | "still";
  still: Asset | null;
  /** The pictures pinned on its form: first frame ("start"), last frame ("end"), keyframe ("mid"). */
  pictures: Array<{ input: string; role: string; asset: Asset }>;
  /** What is heard while it plays, and how loud (0 to 100). */
  sound: "own" | "muted" | "file";
  soundAsset: Asset | null;
  volume: number;
  /** Of another shape than the timeline: true = it fills the frame, false = shown whole with bars. */
  fill: boolean;
  /** Rendered to end where the next clip begins, when that one carries on from it: what every render goes by (a pinned last frame wins). */
  fitNext: boolean;
  /** Its own cast and style; null = the timeline's. */
  look: Look | null;
  /** The conversation with the designer about this clip. */
  chat: unknown[];
  /** The language model and instructions that conversation is held with; null = the usual ones. */
  designer: DesignerSession | null;
  /** What it asks of the music under it; null = as the rest of the video. */
  music: ClipMusic | null;
  /** Its pinned pictures flipped left to right at render time (Mirror), by input id; the library's pictures stay as they are. */
  pinMirror: string[];
  /** The take that plays was rendered with other flips than Mirror asks now: to render again. */
  mirrorChanged: boolean;
  /** How it starts: carrying on from the clip before, or on its own. */
  joined: "continue" | "cut";
  /** The cut's transition into it (a dissolve, a dip, a flash…), kept while it extends: it plays only on a cut. null = a plain cut. */
  transition: Transition | null;
  /** Whether it still follows the clip before: null when there is nothing to compare yet. */
  join: "fresh" | "stale" | "cut" | null;
  recipe: string | null;
  inputs: Record<string, unknown>;
  /** A source window run past a part kept removed: what its take will hide of its end, so it meets that part (card #114). */
  hiddenMs?: number;
  /** The take that plays: one of `takes` (sent by its id, found there by api.ts). */
  take: Take | null;
  takes: Take[];
  atMs: number;
  lengthMs: number;
  job: { id: string; status: "queued" | "running" } | null;
  failed: string | null;
}
export interface Timeline {
  id: string;
  name: string;
  width: number | null;
  height: number | null;
  updatedAt: string;
  durationMs: number;
  /** The project it belongs to, and the folder its renders land in (null: the project's root, or none). */
  projectId: string | null;
  folderId: string | null;
  /** The folder was chosen by hand; otherwise it is the default, or taken from the first material dropped on the timeline. */
  folderChosen: boolean;
  clips: Clip[];
  /** Who is in the video and how it looks, for every clip that has no cast of its own. */
  look: Look | null;
  /** The look and mood of the whole video, in words: added to what happens in every clip. */
  mood: string;
  /** The sound under the whole video: from `fromMs` of the song, starting with clip `startClip` (null: the first). */
  music: { asset: Asset; volume: number; fadeInMs: number; fadeOutMs: number; duck: boolean; duckDb: number; fromMs: number; startClip: string | null } | null;
  /** What Undo would take back, in a few words; and what Redo would do again. */
  undo: string | null;
  redo: string | null;
  exporting: { id: string; status: "queued" | "running" } | null;
  exported: Asset | null;
  exportFailed: string | null;
  /** Its source lane: a long video made into clips window by window; null = none. */
  source: TimelineSource | null;
  /**
   * Its voice recordings, each made into Lip sync clips (drawn under them on the Audio row), how many of its clips a trim set
   * aside, and of those the rendered; how it is cut into them (about `seconds` a clip, ± `window`).
   */
  /** `form`: the form its new clips are made in (its panel's New clips), the recording model's when none was set. */
  recordings?: Array<{ asset: Asset; parked: number; parkedTakes?: number; seconds?: number; window?: number; form?: string; removed?: RemovedPart[] }>;
}
/**
 * A stretch cut out of the middle of a recording or the source by removing its clips (card #75): set aside with its clips
 * and takes, kept with the clip after it (`before`, a cut since), `fromMs` to `toMs` of the recording or source; it comes
 * back with Undo or its mark's Bring back.
 */
export interface RemovedPart {
  before: string;
  fromMs: number;
  toMs: number;
  clips: number;
  takes: number;
}
/**
 * A timeline's source lane: the video, where its own start sits on the timeline (`atMs`, below 0 when it starts before the
 * timeline), the stretch made into clips, and the form they are made with. `clip`: the clip the stretch was taken from,
 * which the made clips replace.
 */
export interface TimelineSource {
  asset: string;
  video: Asset;
  atMs: number;
  fromMs: number;
  toMs: number;
  recipe: string | null;
  windowMs: number;
  /** The model's form every window is made with (what was touched): its picture, prompt and seed among it. */
  inputs: Record<string, unknown>;
  snap: boolean;
  clip: string | null;
  /** Who a swap replaces: the point clicked on the stretch's first frame, as shares of its width and height; gone when the start moves. */
  pick?: { x: number; y: number } | null;
  /** The clips set apart from the others, by id: the settings each keeps its own. */
  apart?: Record<string, string[]>;
  /** How many of the windows a trim set aside are rendered: moving the start leaves them behind too. */
  parkedTakes?: number;
  /** The stretches cut out of its middle by removing their windows. */
  removed?: RemovedPart[];
}
/** A change to the source lane: a new video, or its settings. */
export type SourcePatch = Partial<Omit<TimelineSource, "video" | "apart" | "parkedTakes" | "removed">>;
/** How a clip regenerated in a range meets its neighbours: with their video as context (the motion carries across), on a frame, or nothing there. */
export interface RangeContext {
  start: "clip" | "frame" | "none";
  end: "clip" | "frame" | "none";
}
export interface TimelineBrief {
  id: string;
  name: string;
  projectId: string | null;
  folderId: string | null;
  width: number | null;
  height: number | null;
  updatedAt: string;
  clips: number;
  durationMs: number;
  cover: string | null;
  /** A frame per clip, in order (up to 12): the playing take, or the clip's picture; null for a clip with neither. */
  strip?: Array<string | null>;
  /** How long each clip of the strip plays (ms), in the same order. */
  lengths?: number[];
  /** Clips with nothing to play yet. */
  toRender?: number;
  /** Joins that no longer follow on (a clip changed since the next was made from it). */
  staleJoins?: number;
}
export interface ClipPatch {
  recipe?: string;
  inputs?: Record<string, unknown>;
  joined?: "continue" | "cut";
  /** The cut's transition into it; null = a plain cut. Given to a clip that extends, it makes the join a cut. */
  transition?: Transition | null;
  take?: string;
  trimStartMs?: number;
  trimEndMs?: number;
  /** A trim asked by what is seen: the moment of the video it is to start, or stop, being seen (as the take's startMs and endMs say). The server works the trims out, whatever a landing or a seamless join moves. */
  shownFromMs?: number;
  shownToMs?: number;
  after?: string | null;
  sound?: "own" | "muted" | "file";
  soundAsset?: string | null;
  volume?: number;
  fill?: boolean;
  fitNext?: boolean;
  stillMs?: number;
  animate?: boolean;
  look?: Look | null;
  chat?: unknown[];
  designer?: DesignerSession | null;
  music?: ClipMusic | null;
  /** Mirror on a pinned picture, by input id: true flips it at render time, false turns it back. */
  pinMirror?: Record<string, boolean>;
  /** The take whose settings `recipe`, `inputs` and `pinMirror` put back (Use this take's settings): one Undo step, named after it. */
  settingsOf?: string;
  /** Of a clip made from the source: "apart" keeps this change to it, "inLine" brings its own settings back to the others', "toAll" gives them to every clip. */
  share?: "apart" | "inLine" | "toAll";
}
export interface TimelinePatch {
  name?: string;
  width?: number | null;
  height?: number | null;
  music?: { asset?: string | null; volume?: number; fadeInMs?: number; fadeOutMs?: number; duck?: boolean; duckDb?: number; fromMs?: number; startClip?: string | null };
  look?: Look | null;
  mood?: string;
  /** The project it belongs to (null: the Inbox), and the folder its renders land in (null: the project's root). */
  project?: string | null;
  folder?: string | null;
  /** Its source lane: a new video, changes to the one there, or null to take it away. */
  source?: SourcePatch | null;
}
