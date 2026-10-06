/** Timelines: clips and their takes, what was measured along them, and the patches that change them. */
import type { Asset } from "./library";
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
  joinKind: "latent" | "hybrid" | "pixels" | null;
  /** Its take-over point: it starts to play this many ms before its shared frames end and the clip before stops as much earlier, a clean cut inside frames that show the same moment. 0: at its first own frame. */
  leadMs: number;
  /** How long its render took, when it was rendered here; null otherwise. */
  renderMs: number | null;
  /** How its own part looks, measured on its frames when it was rendered here; null otherwise. */
  measure: Measure | null;
}
/** How a take's own part looks, measured on its real frames when it was rendered (the server's lookOf). Older takes carry the first two only. */
export interface Measure {
  /** Mean luma, 0 to 255. */
  luma: number;
  /** The mean absolute Laplacian of a small grey copy: 0 is flat, several units is crisp. */
  sharp: number;
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
  /** Its own cast and style; null = the timeline's. */
  look: Look | null;
  /** The conversation with the designer about this clip. */
  chat: unknown[];
  /** The language model and instructions that conversation is held with; null = the usual ones. */
  designer: DesignerSession | null;
  /** How it starts: carrying on from the clip before, or on its own. */
  joined: "continue" | "cut";
  /** Whether it still follows the clip before: null when there is nothing to compare yet. */
  join: "fresh" | "stale" | "cut" | null;
  recipe: string | null;
  inputs: Record<string, unknown>;
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
  /** The sound under the whole video. */
  music: { asset: Asset; volume: number; fadeInMs: number; fadeOutMs: number; duck: boolean } | null;
  /** What Undo would take back, in a few words; and what Redo would do again. */
  undo: string | null;
  redo: string | null;
  exporting: { id: string; status: "queued" | "running" } | null;
  exported: Asset | null;
  exportFailed: string | null;
}
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
  /** Clips with nothing to play yet. */
  toRender?: number;
  /** Joins that no longer follow on (a clip changed since the next was made from it). */
  staleJoins?: number;
}
export interface ClipPatch {
  recipe?: string;
  inputs?: Record<string, unknown>;
  joined?: "continue" | "cut";
  take?: string;
  trimStartMs?: number;
  trimEndMs?: number;
  after?: string | null;
  sound?: "own" | "muted" | "file";
  soundAsset?: string | null;
  volume?: number;
  fill?: boolean;
  stillMs?: number;
  animate?: boolean;
  look?: Look | null;
  chat?: unknown[];
  designer?: DesignerSession | null;
}
export interface TimelinePatch {
  name?: string;
  width?: number | null;
  height?: number | null;
  music?: { asset?: string | null; volume?: number; fadeInMs?: number; fadeOutMs?: number; duck?: boolean };
  look?: Look | null;
  mood?: string;
  /** The project it belongs to (null: the Inbox), and the folder its renders land in (null: the project's root). */
  project?: string | null;
  folder?: string | null;
}
