import { projectForNew, projectParam } from "./project";
import type { Known } from "@afflatus/core";
import type { InputSpec, ModelInfo, VideoTraits } from "@afflatus/core";

export type { ModelInfo };
import type { Bindings, Inspection, Wiring, WorkflowDef } from "@afflatus/workflows";

/** Shapes of the server's answers. Kept next to the calls so a change on one side is noticed on the other. */

export interface RecipeInfo {
  id: string;
  family: string;
  version: number;
  title: string;
  summary: string;
  output: "image" | "video" | "audio";
  inputs: InputSpec[];
  /** Of a video recipe: what it can do on a timeline. */
  traits: VideoTraits | null;
  /** The model files it names itself (an imported workflow's). */
  models?: string[];
  /** What a model file starts on the first time it is used, by its name (its line's recommended settings). */
  presets?: Array<{ match: string; values: Record<string, unknown>; note?: string }>;
}
export interface FamilyInfo {
  id: string;
  name: string;
  summary: string;
  /** Patterns that tell which LoRAs were made for this family. */
  loraMatch?: string[];
}

export interface RecipeStatus {
  id: string;
  ready: boolean;
  missingNodes: string[];
  missingSlots: string[];
  emptyInputs: string[];
  missingFiles: string[];
  /** The same files with the folder each belongs in and, when its author gave one, where it can be had. */
  missing: Array<{ file: string; folder: string | null; url?: string }>;
  /** What ComfyUI would refuse in it, in the checker's words. */
  problems: string[];
  limitedBy: string[];
  options: Record<string, string[]>;
}
export interface Scan {
  at: string;
  comfy:
    | { online: true; url: string; version: string; device: string; vramTotal: number; vramFree: number; nodes: number }
    | { online: false; url: string; error: string };
  families: Array<{ id: string; slots: Array<{ id: string; label: string; folder: string; file: string | null; choices: string[]; auto: string | null; chosen: boolean; optional: boolean; hint: string; get?: { file: string; url: string } }> }>;
  recipes: RecipeStatus[];
}

export interface SystemLoad {
  source: "dasiwa" | "crystools" | "comfyui";
  cpu?: number;
  ram?: { used: number; total: number; percent: number };
  swap?: number;
  disks: Array<{ path: string; percent: number; readMbS?: number; writeMbS?: number }>;
  gpus: Array<{ name: string; load?: number; temperature?: number; vramUsed: number; vramTotal: number; vramPercent: number }>;
}

export interface Job {
  id: string;
  recipe: string;
  label: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  error: string | null;
  generationId: string | null;
  /** The timeline clip it renders a take of, when it is one. */
  clipId: string | null;
  /** The draft it was sent from, when it was sent from one. */
  draftId: string | null;
  /** "export": it puts a timeline together as one video instead of rendering. "load": it only loads the models of a render. "cut": a range of a video kept as new videos. */
  kind: "render" | "export" | "load" | "cut";
  /** Of a waiting job: about how long it will take, from past renders. */
  estimateMs: number | null;
  /** Of a failed job: what it was asked, so that a retry can change it. */
  input: Record<string, unknown> | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
/** A finished job as the queue's history shows it: with what it made and how. */
export interface HistoryJob extends Job {
  tookMs: number | null;
  /** The model file's name, when the form has a model picker. */
  model: string | null;
  prompt: string;
  seed: number | null;
  /** The same for jobs asked for together ("Make 4"): shown as one card. */
  batch: string;
  made: Array<{ id: string; kind: "image" | "video" | "audio"; width: number | null; height: number | null; durationMs: number | null; kept: boolean; inBin: boolean; name: string }>;
}
export interface HistoryPage {
  items: HistoryJob[];
  more: boolean;
  counts: { done: number; failed: number; cancelled: number };
}
export interface RunningJob extends Job {
  progress: number;
  eta: number;
  phase: string;
  step: number;
  steps: number;
  previewSeq: number;
  /** What the preview is: a picture, or (video/…) a short clip of what is forming. */
  previewMime?: string | null;
}
export interface QueueStatus {
  paused: boolean;
  /** The model ComfyUI was last asked to load, by name. Null when none is, or when it is not known. */
  model: string | null;
  online: boolean;
  offlineForMs: number;
  running: RunningJob | null;
  waiting: Job[];
  recent: Job[];
}

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
  /** Of a file of a linked folder: where it is on the disk (in the bin: where it was). */
  path: string | null;
}
/** Where ComfyUI shows a workflow Afflatus put there: straight from the address, or from its Workflows sidebar. */
export interface Opened {
  url: string;
  direct: boolean;
  path?: string;
  restart?: boolean;
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
export interface DraftBrief {
  id: string;
  recipe: string;
  /** The start of what was written in it. */
  title: string;
  /** The name it was given, when it was given one. */
  name: string | null;
  target: string;
  updatedAt: string;
  /** Nothing was done in it yet. */
  empty: boolean;
  projectId: string | null;
}
export interface Draft extends DraftBrief {
  /** Recipe id → the values of its form. */
  forms: Record<string, Record<string, unknown>>;
  count: number;
  /** Who is in it and how it looks. */
  look: Look | null;
  /** The conversation with the designer about it. */
  chat: unknown[];
  /** The language model and instructions that conversation is held with; null = the usual ones. */
  designer: DesignerSession | null;
}

/** Which language model and which instructions a conversation with the designer is held with ("" = no instructions). */
export interface DesignerSession {
  llm?: string;
  instruction?: string;
}
/** What the designer answers: the full new text of the boxes it changes, or one question, or a plan of clips. */
export interface DesignerReply {
  /** proposal: text to put in the form. question: it needs to know one thing. answer: it only talks. plan: several clips. */
  kind: "proposal" | "question" | "answer" | "plan";
  note: string;
  changes: Record<string, string>;
  question: string;
  options: string[];
  clips: Array<Record<string, string>>;
  /** Whether the language model was shown the picture the form opens on. */
  sawPicture?: boolean;
  /** What the tag check did to what was written: tags put right, and tags danbooru does not have. */
  tags?: { fixed: Array<{ from: string; to: string }>; unknown: string[] };
  /** It was asked a second time, and this is what it sent then. */
  retried?: boolean;
  /** It said it changed something and sent no text, twice: its note is not to be believed. */
  empty?: boolean;
  /** Parts whose new text is far shorter than what is written (the lengths): it may be a fragment. */
  short?: Record<string, { was: number; now: number }>;
  /** It wrote the clip before again, twice, in place of what comes next. */
  repeats?: boolean;
  /** What the language model sent, when something was off with it. */
  raw?: string;
}

/** A tag of a prompt that danbooru does not have, with what to write instead when that is known. */
export interface TagIssue {
  tag: string;
  status: "alias" | "unknown";
  suggestion?: string;
}

/** The words that call a model file up beyond what the file says: the user's own, and the ones its page gave. */
export interface ModelWords {
  own: string | null;
  found: string | null;
}

/** A bit of text kept for prompts, in a category of the user's own, for one kind of prompt when that is known. */
export interface SnippetDef {
  text: string;
  category: string;
  style: "tags" | "sentences" | null;
}

/** Who is in it and how it looks: people and places (a person with the outfit picked), and one style. */
export interface Look {
  cast: Array<{ id: string; outfit?: string | null }>;
  style?: string | null;
  /** Snippets that are ticked: their text is added after what is written. */
  snippets?: string[];
}
/** Whether a look adds anything to a form. */
export const lookAdds = (look: Look | null | undefined): look is Look => Boolean(look && (look.cast.length || look.style || look.snippets?.length));
export interface Outfit {
  id: string;
  name: string;
  tags: string;
  sentence: string;
  picture: string | null;
}
export interface PersonDef {
  pictures: string[];
  voice: string | null;
  tags: string;
  sentence: string;
  /** Per model family: this person's LoRA, its strength, the word that calls it up. */
  models: Record<string, { lora: string | null; weight: number; trigger: string }>;
  outfits: Outfit[];
}
export interface PlaceDef {
  pictures: string[];
  tags: string;
  sentence: string;
}
export interface StyleDef {
  models: Record<string, { loras: Array<{ file: string; weight: number }>; words: string }>;
}
/** A preset: the model and operation it is for (none: any), what it sets of the form, and who is in it. Everything optional. */
export interface PresetDef {
  recipe?: string;
  inputs: Record<string, unknown>;
  look?: Look | null;
  /** The model files it is made for, with where each is had. */
  files?: PresetFile[];
  author?: string;
  note?: string;
  homepage?: string;
  licence?: { name: string; url?: string; note?: string };
}
export type Entity =
  | { id: string; kind: "person"; name: string; def: PersonDef; updatedAt: string }
  | { id: string; kind: "place"; name: string; def: PlaceDef; updatedAt: string }
  | { id: string; kind: "style"; name: string; def: StyleDef; updatedAt: string }
  | { id: string; kind: "preset"; name: string; def: PresetDef; updatedAt: string; source?: "shipped" }
  | { id: string; kind: "snippet"; name: string; def: SnippetDef; updatedAt: string };
/** What a form becomes once its cast and style are worked in. */
export interface Composed {
  input: Record<string, unknown>;
  added: { words: Array<{ from: string; text: string }>; loras: Array<{ from: string; file: string }>; references: number; voice: string | null; skipped: string[] };
}
export interface ModelSettings {
  family: string;
  file: string;
  /** Input id → the value this model file starts with. */
  values: Record<string, unknown>;
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
/** An imported workflow, as the list shows it. */
export interface WorkflowBrief {
  id: string;
  title: string;
  model: string;
  source: string;
  output: "image" | "video" | "audio";
  nodes: number;
}
/** What is saved for a workflow: the workflow itself and which of its parts Afflatus fills in. */
export interface WorkflowBody {
  title: string;
  model: string;
  source: string;
  graph: WorkflowDef["graph"];
  wiring?: Wiring;
  /** The editor's own file, when the workflow came from one. */
  editor?: unknown;
  bindings: Bindings;
}
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
}
export interface Clip {
  id: string;
  /** "still": a picture held on screen instead of a video. */
  kind: "video" | "still";
  still: Asset | null;
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
/** How long a recipe usually takes on this machine, from what was rendered before each render was put on record. */
export interface Rate {
  perJobMs: number;
  perSecondMs: number | null;
  samples: number;
}
export type TimesPeriod = "day" | "week" | "month" | "all";
/** A window of time to look at, ms since the epoch. */
export interface TimesWindow { from: number; to: number }
/** One render among the longest of a stretch of time. */
export interface TopRender { id: string; name: string; model: string; totalMs: number; status: "done" | "failed" | "cancelled"; assetId: string | null }
/** The parts of a render's time, in milliseconds. */
export interface TimeParts { loading: number; sampling: number; refining: number; finishing: number }
type Line = Array<number | null>;
/** What the "Render times" tab shows for a period. Every list has one entry per stretch of `times`. */
export interface TimesSummary {
  period: TimesPeriod | "window";
  /** The window the figures cover, and the length of a stretch of it, in milliseconds, and where each one starts. */
  from: number;
  to: number;
  step: number;
  times: number[];
  /** Per stretch: how many renders, and the longest of them. */
  buckets: Array<{ renders: number; top: TopRender[] }>;
  /** How many days each render is kept one by one (0: for good), and when the first one on record was made. */
  keepDays: number;
  since: string | null;
  spanMs: number;
  tiles: {
    done: number; images: number; videos: number; failed: number; cancelled: number;
    videoMs: number; lostMs: number; gpuMs: number; longestMs: number;
    loadMs: number; loads: number; loadUsualMs: number | null;
    waitedUsualMs: number | null; waitedSlowMs: number | null; off: number | null;
    vramPeak: number | null; vramUsual: number | null; heatPeak: number | null; heatUsual: number | null;
  };
  finished: { images: number[]; videos: number[]; bad: number[] };
  phases: { loading: number[]; sampling: number[]; refining: number[]; finishing: number[] };
  wait: { usual: Line; slow: Line };
  gpu: { vram: Line; heat: Line };
  models: Array<{
    /** The recipe's id. */
    key: string;
    name: string;
    kind: "image" | "video" | "audio" | null;
    renders: number;
    usualMs: number | null; slowMs: number | null; stepMs: number | null; loadMs: number | null; gpuMs: number;
    trend: number[];
    usual: Line; slow: Line; cold: Line;
    /** Its pace against its own usual, in percent: 100 is as ever. */
    pace: Line;
    phases: TimeParts;
    /** The setting used most, and what its render is made of. */
    setting: { width: number | null; height: number | null; seconds: number | null; steps: number; model: string; samples: number; stepMs: number | null; sampleMs: number; refineMs: number; finishMs: number; warmMs: number; loadMs: number } | null;
    files: Array<{ file: string; name: string; renders: number; stepMs: number | null; step: Line }>;
  }>;
}
/** One render on record. */
export interface RenderItem {
  id: string;
  at: string;
  recipe: string;
  name: string;
  model: string;
  kind: "image" | "video" | "audio" | null;
  width: number | null;
  height: number | null;
  seconds: number | null;
  steps: number;
  stepMs: number | null;
  phases: TimeParts;
  totalMs: number;
  expectedMs: number | null;
  cold: boolean;
  /** Measured from its first moment (not when Afflatus started while it was already rendering). */
  whole: boolean;
  waitedMs: number;
  vram: number | null;
  heat: number | null;
  status: "done" | "failed" | "cancelled";
  /** What it made, while that is still in the library. */
  assetId: string | null;
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
/** What a pasted link to a model leads to. */
export interface LinkFound {
  source: "civitai" | "huggingface" | "address";
  title: string;
  about: string;
  page: string;
  version?: number;
  versions?: Array<{ id: number; name: string }>;
  url?: string;
  files: Array<{ name: string; bytes: number; note: string }>;
  folder: string | null;
  why?: string;
  /** ComfyUI's model folders. */
  folders: string[];
  /** Files ComfyUI already has under the same name: file name to the folder it is in. */
  have: Record<string, string>;
}
/** The page of a model file on the site it came from. */
export interface ModelPage {
  url: string;
  title: string;
}
export interface PageCandidate extends ModelPage {
  site: string;
  about: string;
}
/** One language model the designer can write with. Its key never comes back: only whether one is saved. */
export interface LlmInfo {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  vision: boolean;
  /** How much it can read at once, in tokens. */
  contextSize: number;
  /** The longest answer it may write, in tokens. */
  maxOutputTokens: number;
}
export interface FinishSettings {
  route: "seedvr" | "latent" | "rtx" | "model";
  factor: number;
  colour: "lab" | "wavelet" | "adain" | "none";
  upscaleModel: string;
  latentDenoise: number;
  latentSteps: number;
}

/** One model file a preset is made for, and where it is had. */
export interface PresetFile {
  file: string;
  folder: string;
  url?: string;
  civitai?: { version: number; pick?: string; page?: string };
  page?: string;
  size?: number;
  note?: string;
  optional?: boolean;
}
export interface PresetFileView extends PresetFile {
  have: boolean;
}
/** A preset's files against this ComfyUI, and whether their licence was accepted. */
export interface PresetFilesView {
  id: string;
  files: PresetFileView[];
  accepted: boolean;
  /** The family of its recipe and which of the family's own files are missing (Settings' to fetch). */
  needs?: { family: string; name: string; missing: string[] };
}

export interface Settings {
  comfyUrl: string;
  /** ComfyUI's folder on Afflatus's computer, when they share one; empty otherwise. */
  comfyDir: string;
  /** ComfyUI's models are unloaded after this many minutes without a render; 0 for never. */
  unloadAfterMinutes: number;
  /** The model in use, the short way. */
  llm: { baseUrl: string; model: string; hasApiKey: boolean; vision: boolean };
  llms: LlmInfo[];
  /** The one the designer writes with. */
  designerLlm: string;
  /** The user's own instructions for the designer, each under a name. */
  designerInstructions: Array<{ id: string; name: string; text: string }>;
  /** The ones in use; empty for none. */
  designerInstruction: string;
  /** Tags written for an anime model are compared with danbooru's list. */
  tagCheck: boolean;
  /** Model families switched on or off by hand; one that is not named follows its files. */
  families: Record<string, boolean>;
  hasCivitaiKey: boolean;
  /** The user's defaults for "Finish all clips" on a timeline. */
  finish: FinishSettings;
  /** A family's file chosen by hand where several fit: family id → slot id → file. */
  slotFiles: Record<string, Record<string, string>>;
  /** The presets whose files' licence was accepted. */
  acceptedPresets: string[];
  /** Missing model files may be looked for on Civitai. */
  civitaiLookups: boolean;
  /** Missing model files may be fetched into ComfyUI, through ComfyUI-Manager. */
  downloadModels: boolean;
  /** How many days the time of each render is kept one by one; 0 for good. Older ones become daily figures. */
  renderHistoryDays: number;
}
/** What a dropped file carries about how it was made. */
export interface Embedded {
  settings: null | {
    recipe: string;
    input: Record<string, unknown>;
    source: "a1111" | "comfyui";
    notes: string[];
    /** Its model and LoRAs that this ComfyUI does not have. */
    missing: Array<{ file: string; folder: string; civitai?: number }>;
    model: { name: string; found: boolean } | null;
    loras: Array<{ name: string; weight: number; found: boolean }>;
    /** The forms these settings can fill, the likeliest first, with why when there is a reason. */
    targets: Array<{ id: string; why?: string }>;
  };
  /** A ComfyUI workflow, when the file has one. */
  workflow: unknown | null;
  why: string | null;
}
/** A model file being fetched into ComfyUI. */
export interface Download {
  id: string;
  file: string;
  folder: string;
  title: string;
  bytes: number;
  total: number;
  status: "starting" | "downloading" | "saving" | "done" | "error" | "stopped";
  error?: string;
  /** While starting: what it waits for (ComfyUI-Manager fetches one file at a time). */
  waiting?: string;
}
/** A word about one choice of a form: slow, or probably too much, on the card it will run on. */
export interface Advice {
  input: string;
  level: "slow" | "heavy";
  text: string;
}
/** A file of exactly the name that is missing, found in a repository on Hugging Face. */
export interface HuggingFaceFind {
  repo: string;
  path: string;
  url: string;
  page: string;
  downloads: number;
  gated: boolean;
}
/** A model found on Civitai for a file that is missing. */
export interface CivitaiFind {
  name: string;
  kind: string;
  url: string;
  version: string;
  base: string;
  words: string[];
  exact: boolean;
  /** What a download of it fetches: the version, the file's own name, and how large it is (0 when Civitai does not say). */
  versionId: number | null;
  file: string;
  bytes: number;
  /** The site that has it: civitai.com, or civitai.red. */
  site: string;
  /** It is the kind of model the folder holds (a workflow found by the same words is not). */
  fits: boolean;
  /** The words of the name asked for that are in its own names, and how many words that name has. */
  hits: string[];
  of: number;
  /** This ComfyUI already has the file a download of it would fetch: in which kind of folder, under which name. */
  have?: { folder: string; file: string };
}

/** The server always answers errors as { error }, written for a person to read. */
export class ApiError extends Error {}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(data.error ?? `the server answered ${res.status}`);
  return data as T;
}

export const api = {
  recipes: () => call<{ families: FamilyInfo[]; recipes: RecipeInfo[] }>("GET", "/recipes"),
  setup: (fresh = false) => call<Scan>("GET", `/setup${fresh ? "?fresh=1" : ""}`),
  health: () => call<{ ok: true; version: string; database: string }>("GET", "/health"),
  settings: () => call<Settings>("GET", "/settings"),
  saveSettings: (patch: Record<string, unknown>) => call<Settings>("PUT", "/settings", patch),
  presetFiles: () => call<{ online: boolean; items: PresetFilesView[] }>("GET", "/presets/files"),
  getPresetFiles: (id: string, body: { accept?: boolean; optional?: boolean } = {}) => call<{ started: Download[]; failed: Array<{ file: string; error: string }>; skipped: number }>("POST", `/presets/${encodeURIComponent(id)}/get`, body),
  queue: () => call<QueueStatus>("GET", "/queue"),
  jobs: (filter: { status?: "done" | "failed" | "cancelled"; q?: string; model?: string; offset?: number; limit?: number }) =>
    call<HistoryPage>("GET", `/jobs?${new URLSearchParams(Object.fromEntries(Object.entries(filter).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)])))}`),
  pause: () => call<QueueStatus>("POST", "/queue/pause"),
  resume: () => call<QueueStatus>("POST", "/queue/resume"),
  /** `into`: the draft it is sent from, and the folder that is open, where its results are filed. */
  enqueue: (recipe: string, input: Record<string, unknown>, count: number, look?: Look | null, into?: { draft?: string; folder?: string }) =>
    call<{ ids: string[] }>("POST", "/jobs", { recipe, input, count, ...(lookAdds(look) ? { look } : {}), ...(into?.draft ? { draft: into.draft } : {}), ...(into?.folder ? { folder: into.folder } : {}) }),
  /** Load the models this form would render with, ahead of the render. A job in the queue that makes nothing. */
  warm: (recipe: string, input: Record<string, unknown>, look?: Look | null) => call<{ id: string }>("POST", "/jobs/warm", { recipe, input, ...(lookAdds(look) ? { look } : {}) }),
  /** Whether the models this form would render with are the ones ComfyUI was last asked to load. Null: it cannot be told. */
  loaded: (recipe: string, input: Record<string, unknown>, look?: Look | null) => call<{ loaded: boolean | null }>("POST", "/comfy/loaded", { recipe, input, ...(lookAdds(look) ? { look } : {}) }),
  entities: () => call<{ items: Entity[] }>("GET", "/entities"),
  createEntity: (kind: Entity["kind"], name: string, def?: unknown) => call<Entity>("POST", "/entities", def === undefined ? { kind, name } : { kind, name, def }),
  saveEntity: (id: string, patch: { name?: string; def?: unknown }) => call<Entity>("PUT", `/entities/${id}`, patch),
  deleteEntity: (id: string) => call<{ ok: true }>("DELETE", `/entities/${id}`),
  /** What the form becomes with its cast and style worked in. Nothing is queued. */
  compose: (recipe: string, input: Record<string, unknown>, look: Look) => call<Composed>("POST", "/compose", { recipe, input, look }),
  cancel: (id: string) => call<{ ok: true }>("POST", `/jobs/${id}/cancel`),
  /** The waiting jobs, in the order they should run. */
  queueOrder: (ids: string[]) => call<QueueStatus>("POST", "/queue/order", { ids }),
  /** A finished job again; `input` changes some of what it was asked. */
  retryJob: (id: string, input?: Record<string, unknown>) => call<{ id: string }>("POST", `/jobs/${id}/retry`, input ? { input } : {}),
  dismissJob: (id: string) => call<{ ok: true }>("DELETE", `/jobs/${id}`),
  estimates: () => call<{ rates: Record<string, Rate>; known: Record<string, Known> }>("GET", "/estimates"),
  renderTimes: (range: TimesPeriod | TimesWindow) => call<TimesSummary>("GET", typeof range === "string" ? `/renders/summary?period=${range}` : `/renders/summary?from=${Math.round(range.from)}&to=${Math.round(range.to)}`),
  renders: (opts: { recipe?: string; trouble?: boolean; before?: string; limit?: number; from?: number; to?: number }) =>
    call<{ total: number; more: boolean; items: RenderItem[] }>("GET", `/renders?${new URLSearchParams({ ...(opts.recipe ? { recipe: opts.recipe } : {}), ...(opts.trouble ? { only: "trouble" } : {}), ...(opts.before ? { before: opts.before } : {}), ...(opts.from ? { from: String(Math.round(opts.from)) } : {}), ...(opts.to ? { to: String(Math.round(opts.to)) } : {}), limit: String(opts.limit ?? 50) })}`),
  renderRecordSize: () => call<{ renders: number; days: number; bytes: number }>("GET", "/renders/size"),
  /** ComfyUI's terminal log, the last few hundred lines (`t`: when, `m`: the line). */
  comfyLogs: () => call<{ lines: Array<{ t: string; m: string }> }>("GET", "/comfy/logs"),
  clearRenderRecord: () => call<{ ok: true }>("DELETE", "/renders"),
  advice: (recipe: string, input: Record<string, unknown>) => call<{ items: Advice[] }>("POST", "/advice", { recipe, input }),
  civitaiFind: (file: string, folder: string | null, hints: string[] = []) =>
    call<{ items: CivitaiFind[]; exact: HuggingFaceFind[]; asked: string[]; silent: string[] }>(
      "GET", `/civitai/find?${new URLSearchParams({ file, ...(folder ? { folder } : {}), ...(hints.length ? { hints: hints.join("|") } : {}) })}`,
    ),
  /** What a file from the computer says about how it was made. The file is the request body; nothing is stored. */
  embedded: async (file: File, recipe?: string) => {
    const res = await fetch(`/api/embedded${recipe ? `?recipe=${encodeURIComponent(recipe)}` : ""}`, { method: "POST", headers: { "Content-Type": /^(image|video|audio)\//.test(file.type) ? file.type : "application/octet-stream" }, body: file });
    const data = (await res.json().catch(() => ({}))) as Embedded & { error?: string };
    if (!res.ok) throw new ApiError(data.error ?? `the server answered ${res.status}`);
    return data;
  },
  /** The same for a picture or a video already in the library. */
  assetEmbedded: (id: string, recipe?: string) => call<Embedded>("GET", `/assets/${id}/embedded${recipe ? `?recipe=${encodeURIComponent(recipe)}` : ""}`),
  downloads: () => call<{ on: boolean; items: Download[]; manager: { found: boolean; version?: string } }>("GET", "/downloads"),
  stopDownload: (id: string) => call<{ ok: true }>("DELETE", `/downloads/${id}`),
  startDownload: (body: { file: string; folder: string; page?: ModelPage } & ({ civitai: number; pick?: string } | { url: string })) => call<Download>("POST", "/downloads", body),
  /** What a pasted link leads to: its files, the folder it most likely belongs in, ComfyUI's folders, and what ComfyUI has already. */
  resolveLink: (link: string) => call<LinkFound>("POST", "/downloads/resolve", { link }),
  storage: () => call<Storage>("GET", "/storage"),
  binIdleTakes: () => call<{ moved: number }>("POST", "/storage/bin-idle-takes"),
  emptyBin: () => call<{ erased: number }>("POST", "/storage/empty-bin"),
  assetFamilies: () => call<{ items: string[] }>("GET", "/assets/families"),
  /** The model files and the LoRAs things in the library were made with, the most used first. */
  assetModels: () => call<{ models: Array<{ file: string; count: number }>; loras: Array<{ file: string; count: number }> }>("GET", "/assets/models"),
  /** Which tags of a prompt danbooru does not have. */
  checkTags: (text: string, ignore: string[]) => call<{ issues: TagIssue[] }>("POST", "/tags/check", { text, ignore }),
  /** The words known for the files of a model folder beyond what the files say, by file name (lower case, without sub-folder). */
  modelWords: (folder: string) => call<{ items: Record<string, ModelWords> }>("GET", `/models/${folder}/words`),
  /** The user's own words for a file; empty takes them away. */
  setModelWords: (folder: string, file: string, words: string | null) => call<{ items: Record<string, ModelWords> }>("PUT", `/models/${folder}/words`, { file, words }),
  /** Ask Civitai, by fingerprint, for the words of files that say none: once per file, and only when lookups are on. */
  findModelWords: (folder: string, files: string[]) => call<{ items: Record<string, ModelWords>; lookups: boolean }>("POST", `/models/${folder}/words/find`, { files }),
  /** The sound of a video, as a sound of its own in the library. */
  takeSound: (video: string) => call<Asset>("POST", `/assets/${video}/sound`),
  assets: (opts: { kind?: string; bin?: boolean; folder?: string; after?: string; q?: string; family?: string; kept?: boolean; model?: string; lora?: string; draft?: string; since?: string; all?: boolean }) => {
    const q = new URLSearchParams({ limit: "40" });
    // within the project the app looks at, unless a folder, the bin or a draft says where to look, or `all` asks for everything
    if (!opts.folder && !opts.bin && !opts.draft && !opts.all && projectParam()) q.set("project", projectParam()!);
    if (opts.since) q.set("since", opts.since);
    if (opts.kind) q.set("kind", opts.kind);
    if (opts.bin) q.set("bin", "1");
    if (opts.folder) q.set("folder", opts.folder);
    if (opts.after) q.set("after", opts.after);
    if (opts.q?.trim()) q.set("q", opts.q.trim());
    if (opts.family) q.set("family", opts.family);
    if (opts.kept) q.set("kept", "1");
    if (opts.model) q.set("model", opts.model);
    if (opts.lora) q.set("lora", opts.lora);
    if (opts.draft) q.set("draft", opts.draft);
    return call<{ items: Asset[]; next: string | null }>("GET", `/assets?${q}`);
  },
  asset: (id: string) => call<AssetDetail>("GET", `/assets/${id}`),
  keep: (id: string, kept: boolean) => call<Asset>("POST", `/assets/${id}/keep`, { kept }),
  /** Several items at once: kept or not, to the bin, or back from it. */
  bulkAssets: (ids: string[], action: "keep" | "unkeep" | "bin" | "restore") => call<{ changed: number }>("POST", "/assets/bulk", { ids, action }),
  bin: (id: string) => call<{ ok: true }>("DELETE", `/assets/${id}`),
  restore: (id: string) => call<Asset>("POST", `/assets/${id}/restore`),
  /** The drafts of the project the app looks at (see project.ts). */
  drafts: () => call<{ items: DraftBrief[] }>("GET", `/drafts${projectParam() ? `?project=${encodeURIComponent(projectParam()!)}` : ""}`),
  draft: (id: string) => call<Draft>("GET", `/drafts/${id}`),
  /** A new draft, in the project the app looks at unless another is named. */
  createDraft: (body: { recipe: string; forms?: Draft["forms"]; count?: number; look?: Look | null; project?: string | null }) => call<Draft>("POST", "/drafts", { ...body, project: body.project === undefined ? projectForNew() : body.project }),
  saveDraft: (id: string, patch: { recipe?: string; forms?: Draft["forms"]; count?: number; look?: Look | null; chat?: unknown[]; designer?: DesignerSession | null; name?: string }) => call<Draft>("PUT", `/drafts/${id}`, patch),
  /** One turn of the conversation with the designer about a form. */
  /** What the designer will know about a form before anything is said: the pictures whose story it has, and the clip it carries on from. */
  designerKnows: (recipe: string, values: Record<string, unknown>) =>
    call<{ pictures: Array<{ what: string; steps: Array<{ title: string; with: string | null; said: boolean }> }>; continues: boolean }>("POST", "/designer/knows", { recipe, values }),
  designer: (body: { recipe: string; values: Record<string, unknown>; messages: Array<{ role: "user" | "assistant"; content: string }>; mode: "chat" | "enhance"; llm?: string; instruction?: string; previous?: string; story?: { clips: string[]; index: number }; look?: Look | null; mood?: string }) =>
    call<DesignerReply>("POST", "/designer", body),
  /** A scene written as several clips: the text of each. */
  designerPlan: (body: { recipe: string; idea: string; clips: number; values?: Record<string, unknown>; look?: Look | null; mood?: string }) =>
    call<{ note: string; clips: Array<Record<string, string>> }>("POST", "/designer/plan", body),
  /** The pages known for the files of a model folder, by file name (lower case, without sub-folder). */
  modelPages: (folder: string) => call<{ items: Record<string, ModelPage> }>("GET", `/models/${folder}/pages`),
  /** Look for a file's page: the one known, or the one found for sure, or the ones it may be. */
  findModelPage: (folder: string, file: string) => call<{ page: ModelPage | null; candidates: PageCandidate[]; lookups: boolean }>("POST", `/models/${folder}/page`, { file }),
  /** Say which page is the file's; null forgets it. */
  setModelPage: (folder: string, file: string, url: string | null, title = "") => call<{ page: ModelPage | null }>("PUT", `/models/${folder}/page`, { file, url, title }),
  /** Unload ComfyUI's models now. */
  freeMemory: () => call<{ ok: true }>("POST", "/comfy/free"),
  designerTest: (id?: string) => call<{ ok: true; model: string; answer: string }>("POST", "/designer/test", id ? { id } : {}),
  /** Every conversation with the designer, in drafts and on timelines, is forgotten. */
  forgetConversations: () => call<{ forgotten: number }>("DELETE", "/designer/conversations"),
  /** New clips at the end of a timeline, one per planned text, each flowing on from the one before. */
  planTimeline: (id: string, recipe: string, clips: Array<Record<string, string>>) => call<{ clips: string[]; timeline: Timeline }>("POST", `/timelines/${id}/plan`, { recipe, clips }),
  deleteDraft: (id: string) => call<{ ok: true }>("DELETE", `/drafts/${id}`),
  modelSettings: () => call<{ items: ModelSettings[] }>("GET", "/model-settings"),
  saveModelSettings: (body: ModelSettings) => call<ModelSettings>("PUT", "/model-settings", body),
  forgetModelSettings: (family: string, file: string) => call<{ ok: true }>("DELETE", `/model-settings?${new URLSearchParams({ family, file })}`),
  /** What the files of one model folder say about themselves; `pending` are still being read. */
  modelInfo: (folder: string) => call<{ items: Record<string, ModelInfo>; pending: number }>("GET", `/models/${folder}/info`),
  folders: () => call<{ items: Folder[] }>("GET", "/folders"),
  /** A folder inside another, or at the top of a project (null: the Inbox). */
  createFolder: (name: string, parentId: string | null, project?: string | null) => call<Folder>("POST", "/folders", { name, parentId, ...(parentId ? {} : { project: project ?? null }) }),
  /** Link a directory of the disk the server runs on: it becomes a folder, read where it is. */
  linkFolder: (path: string, name?: string) => call<Folder>("POST", "/folders/link", name ? { path, name } : { path }),
  /** Read a linked folder's directory again. */
  scanFolder: (id: string) => call<{ files: number; folders: number }>("POST", `/folders/${id}/scan`, {}),
  editFolder: (id: string, patch: { name?: string; parentId?: string | null }) => call<{ ok: true }>("PATCH", `/folders/${id}`, patch),
  deleteFolder: (id: string) => call<{ ok: true }>("DELETE", `/folders/${id}`),
  moveAssets: (ids: string[], folderId: string | null) => call<{ moved: number }>("POST", "/assets/move", { ids, folderId }),
  /** A picture, a video or a sound from this computer, into the library. The file is the request body. */
  upload: async (file: File, opts: { /** The painted part of a picture: kept, but not shown in the library. */ mask?: boolean; /** The folder it goes into. */ folder?: string; /** Without a folder: the project whose root folder it goes into. */ project?: string | null } = {}) => {
    if (!/^(image|video|audio)\//.test(file.type)) throw new ApiError("This file is not a picture, a video or a sound.");
    const res = await fetch(`/api/assets?name=${encodeURIComponent(file.name)}${opts.mask ? "&as=mask" : ""}${opts.folder ? `&folder=${encodeURIComponent(opts.folder)}` : ""}${opts.project ? `&project=${encodeURIComponent(opts.project)}` : ""}`, { method: "POST", headers: { "Content-Type": file.type }, body: file });
    const data = (await res.json().catch(() => ({}))) as Asset & { error?: string };
    if (!res.ok) throw new ApiError(data.error ?? `the server answered ${res.status}`);
    return data as Asset;
  },
  workflows: () => call<{ items: WorkflowBrief[] }>("GET", "/workflows"),
  workflow: (id: string) => call<WorkflowDef>("GET", `/workflows/${id}`),
  /** Takes the file as it is (ComfyUI's own save, an export) or a workflow Afflatus holds; answers with it in the form Afflatus keeps. */
  inspectWorkflow: (file: unknown) => call<Inspection & { graph: WorkflowDef["graph"]; wiring?: Wiring; editor?: unknown }>("POST", "/workflows/inspect", file),
  /** Put the workflow in ComfyUI's own workflows folder; where ComfyUI is, and the file's path there. */
  openWorkflow: (id: string) => call<Opened>("POST", `/workflows/${id}/open`),
  /** Show a result's graph in ComfyUI's editor: built again from its generation parameters. */
  openRender: (assetId: string) => call<Opened>("POST", `/assets/${assetId}/open`),
  createWorkflow: (body: WorkflowBody) => call<WorkflowBrief>("POST", "/workflows", body),
  saveWorkflow: (id: string, body: WorkflowBody) => call<WorkflowBrief>("PUT", `/workflows/${id}`, body),
  deleteWorkflow: (id: string) => call<{ ok: true }>("DELETE", `/workflows/${id}`),
  /** The timelines of the project the app looks at. */
  timelines: () => call<{ items: TimelineBrief[] }>("GET", `/timelines${projectParam() ? `?project=${encodeURIComponent(projectParam()!)}` : ""}`),
  timeline: (id: string) => call<Timeline>("GET", `/timelines/${id}`),
  /** A new timeline, in the project the app looks at unless another is named. */
  createTimeline: (name?: string, project?: string | null) => call<Timeline>("POST", "/timelines", { ...(name ? { name } : {}), project: project === undefined ? projectForNew() : project }),
  projects: () => call<{ items: Project[]; inbox: { drafts: number; timelines: number; assets: number } }>("GET", "/projects"),
  createProject: (name: string) => call<Project>("POST", "/projects", { name }),
  editProject: (id: string, patch: { name?: string; archived?: boolean }) => call<Project>("PATCH", `/projects/${id}`, patch),
  /** The project goes; its drafts, timelines and folders go to the Inbox. */
  deleteProject: (id: string) => call<{ ok: true }>("DELETE", `/projects/${id}`),
  editTimeline: (id: string, patch: TimelinePatch) => call<Timeline>("PATCH", `/timelines/${id}`, patch),
  undoTimeline: (id: string) => call<{ undone: string }>("POST", `/timelines/${id}/undo`),
  redoTimeline: (id: string) => call<{ redone: string }>("POST", `/timelines/${id}/redo`),
  /** A copy of the clip right after it, with its takes. */
  duplicateClip: (id: string) => call<{ clip: string }>("POST", `/clips/${id}/duplicate`),
  deleteTimeline: (id: string) => call<{ ok: true }>("DELETE", `/timelines/${id}`),
  /** A new clip: empty, or from a video or a picture of the library. After `after`, first when null, last when left out. */
  addClip: (timeline: string, body: { after?: string | null; asset?: string; recipe?: string; as?: "still" | "clip" }) => call<{ clip: string; timeline: Timeline }>("POST", `/timelines/${timeline}/clips`, body),
  editClip: (id: string, patch: ClipPatch) => call<{ ok: true }>("PATCH", `/clips/${id}`, patch),
  deleteClip: (id: string) => call<{ ok: true }>("DELETE", `/clips/${id}`),
  /** One clip becomes two at a moment of its take (the video's own time). */
  splitClip: (id: string, atMs: number) => call<{ clip: string }>("POST", `/clips/${id}/split`, { atMs: Math.round(atMs) }),
  /**
   * The range between In and Out on the timeline's clock: split there, remove it, regenerate it as a new
   * clip (it comes back selected, not rendered; In = Out on a cut inserts a clip between), or copy it to the
   * library through the export queue.
   */
  timelineRange: (id: string, opts: { inMs: number; outMs: number; action: "split" | "remove" | "regenerate" | "loop" | "copy" | "slow"; scale?: number; factor?: 2 | 4 }) =>
    call<{ ok: true } | { clip: string; context: RangeContext; arrive?: string } | { job: string } | { clips: string[]; jobs: string[]; engine: "rife" | "ffmpeg" }>("POST", `/timelines/${id}/range`, { ...opts, inMs: Math.round(opts.inMs), outMs: Math.round(opts.outMs) }),
  deleteTake: (id: string) => call<{ ok: true }>("DELETE", `/takes/${id}`),
  /** The designer writes a clip put between two others: what takes the action from the one to the other. `was` is what the form held when it was asked. */
  writeBetween: (clip: string, arrive?: string) => call<{ changes: Record<string, string>; note: string; was: Record<string, string> }>("POST", `/clips/${clip}/between`, arrive ? { arrive } : undefined),
  renderClips: (timeline: string, clips: Array<{ id: string; input: Record<string, unknown>; fit?: boolean; takes?: number }>) => call<{ ids: string[] }>("POST", `/timelines/${timeline}/render`, { clips }),
  /** Asks for the export: it runs in the queue, and the timeline says when it is there. */
  exportTimeline: (id: string, opts: { scale: 1 | 1.5 | 2; music: boolean; smooth: boolean; range?: { inMs: number; outMs: number }; blend?: boolean; match?: boolean; fit?: "timeline" | "largest" }) => call<{ id: string }>("POST", `/timelines/${id}/export`, opts),
  /** Every clip's selected take brought to its final quality by an upscale route, as a new take each; the drafts stay. */
  finishTimeline: (id: string, opts: Partial<FinishSettings> & { route: FinishSettings["route"]; factor: number; redo?: boolean; clips?: string[] }) => call<{ jobs: string[]; skipped: Array<{ clip: number; why: string }> }>("POST", `/timelines/${id}/finish`, opts),
  /** One frame of a video, saved as a picture in the library. */
  frame: (video: string, atMs: number) => call<Asset>("POST", `/assets/${video}/frame`, { atMs }),
  /** A range of a video as new videos, in the queue: copied, split out, or removed. */
  /** A range of a video: copied, split out, removed, or slowed down ("slow", ×2 or ×4: RIFE on the GPU when ComfyUI has it, else ffmpeg; `engine` says which). */
  range: (video: string, opts: { startMs: number; endMs: number; action: "copy" | "split" | "remove" | "slow"; crf?: number; factor?: 2 | 4 }) => call<{ id: string; engine?: "rife" | "ffmpeg" }>("POST", `/assets/${video}/range`, opts),
  /** How much moves along a video and how loud it is, `rate` samples a second (motion 0 = still; sound in dB, about -60 = silence): the curves on the track, the quiet moments and pauses a range snaps to. */
  motion: (asset: string) => call<{ rate: number; values: number[]; sound: number[] | null }>("GET", `/assets/${asset}/motion`),
  /** How smoothly each take of a clip meets its neighbours: ×1 = like the clip's own motion, higher = a catch; null where there is no neighbour. */
  joins: (clip: string) => call<{ items: Array<{ take: string; in: number | null; out: number | null }> }>("GET", `/clips/${clip}/joins`),
};

export const fileUrl = (id: string) => `/api/assets/${id}/file`;
export const thumbUrl = (id: string) => `/api/assets/${id}/thumb`;
/** Twelve frames of a video side by side, spread over its length. */
export const stripUrl = (id: string) => `/api/assets/${id}/strip`;
export const STRIP_FRAMES = 12;
export const previewUrl = (jobId: string, seq: number) => `/api/jobs/${jobId}/preview?s=${seq}`;
