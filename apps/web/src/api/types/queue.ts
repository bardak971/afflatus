/** The queue: jobs as they wait, run and end, the machine's load, and the record of render times. */

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
  /** What went less well than asked, though the job finished: a latent that could not be read, a take that could not be placed. */
  warning?: string | null;
  generationId: string | null;
  /** The timeline clip it renders a take of, when it is one. */
  clipId: string | null;
  /** The draft it was sent from, when it was sent from one. */
  draftId: string | null;
  /** Of a clip render, once its graph is built: how it joins the clip before (in the latent, or on pinned frames); null when it starts on its own. */
  join: "seamless" | "latent" | "hybrid" | "pixels" | null;
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
  /** What the workflow showed on the way (its Preview nodes), oldest first: a strip under the live preview. */
  stages?: Array<{ n: number; node: string; title: string | null; count: number }>;
  /** Out of video memory, it seems: the memory full and twice what was expected already gone. Much slower than usual. */
  spilling?: boolean;
}
/**
 * What a "progress" live event carries: the running job's id and the figures that moved. The job in
 * the queue on screen is changed in place with them (live.ts), so a render that reports every step
 * costs no request. The id is the job's, not ComfyUI's prompt id.
 */
export type ProgressUpdate = Pick<RunningJob, "id" | "progress" | "eta" | "phase" | "step" | "steps" | "previewSeq" | "stages" | "previewMime" | "spilling">;
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
    /** Finishes and slow motions among the renders; runs that ran out of video memory, and the time that cost. */
    tools?: number; spills?: number; spillLostMs?: number;
  };
  /** The upscales' pace per stretch: a video route in minutes per second of video, a picture tool or a hires pass in seconds per megapixel. */
  upscale?: { video: Array<{ key: string; name: string; points: Line }>; pictures: Array<{ key: string; name: string; points: Line }> };
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
  /** It ran out of video memory, as far as the figures tell (memory full, twice what was expected). */
  spilled?: boolean;
}
