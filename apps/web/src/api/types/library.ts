/** The library: items, their details and lineage, folders, projects, and what the disk holds. */
import type { Look } from "./designer";

export interface Asset {
  id: string;
  kind: "image" | "video" | "audio";
  origin: string;
  name: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  fps: number | null;
  hasSound: boolean;
  kept: boolean;
  inBin: boolean;
  folderId: string | null;
  generationId: string | null;
  createdAt: string;
  /** Not kept: when its day started, when that is not when it was made (it was unkept, or put back from the bin). */
  countdownFrom?: string | null;
  /** Of a file of a linked folder: where it is on the disk (in the bin: where it was). */
  path: string | null;
  /** Of a video that is a take of a timeline clip: which (only in listings). */
  clipOf?: ClipOf | null;
  /** Made in Create: the draft it came from (only in listings). */
  draftOf?: { id: string; name: string } | null;
}
/** A library video's place on a timeline. */
export interface ClipOf {
  timeline: string;
  timelineName: string;
  /** The clip's number on its timeline, from 1; the take's number among the clip's takes, from 1, and how many there are. */
  clip: number;
  take: number;
  takes: number;
  /** It is the take the clip plays. */
  playing: boolean;
  /** Of a take that is the finished version of another: how many times bigger (1 when the same size); null for the others. */
  upscaledBy: number | null;
}
export interface AssetDetail extends Asset {
  /** Who was in it and how it looked, as far back as it is known: what is made from it can start with the same. */
  look: Look | null;
  generation: null | {
    id: string;
    recipe: string;
    family: string;
    inputs: Record<string, unknown>;
    /** What was settled when it rendered: the seed that was drawn, the model files that were loaded. */
    resolved: { seed?: number; loads?: string[]; overlap?: { headMs: number; tailMs: number } };
    tookMs: number;
  };
  /** The pictures it was made from, and what each was for. */
  sources: Array<{ role: string; asset: Asset }>;
  /** What was made from it. */
  usedIn: Asset[];
  /** A frame or a cut: the video it was taken from, and the range when it is one. */
  source: { asset: Asset; range: { startMs: number; endMs: number } | null } | null;
}
export interface Folder {
  id: string;
  parentId: string | null;
  name: string;
  count: number;
  /** The project it is in; null: the Inbox. */
  projectId: string | null;
  /** The directory of the disk it is linked to, when it is; `root`: the one that was linked, not one of its sub-directories. */
  path: string | null;
  root: boolean;
}
/** A project: what drafts, timelines and folders are grouped under. */
export interface Project {
  id: string;
  name: string;
  /** Its root folder, where its things land unless another is chosen. */
  folderId: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  drafts: number;
  timelines: number;
  assets: number;
}
/** Where the space goes. */
export interface Storage {
  total: number;
  pictures: number;
  videos: number;
  sounds: number;
  idleTakes: { count: number; bytes: number };
  bin: { count: number; bytes: number };
  unkept: { count: number; bytes: number };
}
