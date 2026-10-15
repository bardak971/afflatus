/** The queue: jobs as they wait, run and end, the machine's load, and the record of render times. */
import type { RankedGpu } from "@afflatus/core";
import type { DeployAsk } from "./settings";

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
  /** Of a finish: what it upscales with (SeedVR2, RTX VSR, the upscale model's name). */
  upscaler?: string | null;
  /** Of a waiting job: about how long it will take, from past renders. */
  estimateMs: number | null;
  /** Of a failed job: what it was asked, so that a retry can change it. */
  input: Record<string, unknown> | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** The machine it runs or ran on (a Machine's id), or for a waiting job the one it will probably run on; null for a job that needs no ComfyUI. */
  machine: string | null;
  /** The machine it was pinned to by hand; null: whichever the queue picks. */
  pinned: string | null;
  /** Of a waiting job: in about how long it starts, when that can be told. */
  startsInMs: number | null;
  /** Of a waiting render, when not every machine can run it: the machines that have its files, with its family on (empty: none). */
  runsOn: string[] | null;
  /** Of such a render: what keeps it off each other machine, by machine id (its family off there, the files it lacks there). */
  lacks: Record<string, MachineLack> | null;
  /** Of a waiting render: the rented pods it can run on once its files are sent there, with them and how long they take (ms). */
  fetch: Record<string, { files: Array<{ file: string; folder: string }>; ms: number }> | null;
}
/** What keeps a waiting render off a machine: its family switched off there, and the files it lacks there (with where to get each, when known). */
export interface MachineLack {
  off: boolean;
  files: Array<{ file: string; folder: string; url?: string }>;
  /** A rented pod whose RunPod balance runs out before the job would end there: how long it lasts, how long the job takes (ms). */
  balance?: { leftMs: number; needMs: number };
  /** A rented pod its files cannot reach: why. */
  failed?: string;
  /** What keeps it from being sent there to get what it lacks (a node no pack has, ComfyUI refusing it), in a few words. */
  why?: string;
}

/** A pod's disk as its node pack last said it (0.19.0 on): the bytes free and in all. */
export interface PodDisk {
  free: number;
  total: number;
  at: number;
}

/** A model file a rented pod is getting: for a job that waits for it ("need"), or for later ("ahead"). */
export interface PodFile {
  file: string;
  folder: string;
  state: "next" | "fetching" | "ready" | "failed";
  tier: "need" | "ahead";
  bytes: number;
  total: number;
  via?: "hf" | "civitai" | "url" | "upload";
  error?: string;
  /** The waiting jobs that wait for it. */
  jobs: string[];
}
/** A finished job as the queue's history shows it: with what it made and how. (Not how long it would take, nor how a clip joined: GET /api/jobs leaves those out.) */
export interface HistoryJob extends Omit<Job, "estimateMs" | "join" | "machine" | "pinned" | "startsInMs" | "runsOn" | "lacks" | "fetch"> {
  tookMs: number | null;
  /** Of a job that failed in a ComfyUI node: the end of its Python traceback; null otherwise. */
  trace?: string | null;
  /** The model file's name, when the form has a model picker. */
  model: string | null;
  prompt: string;
  seed: number | null;
  /** The same for jobs asked for together ("Make 4"): shown as one card. */
  batch: string;
  made: Array<{ id: string; kind: "image" | "video" | "audio"; width: number | null; height: number | null; durationMs: number | null; kept: boolean; inBin: boolean; name: string }>;
  /** How much the face in what it made is the person of its photos (a picture for Motion transfer); null when not measured. */
  face?: number | null;
  /** Copies of that person elsewhere in the picture (pasted in beside the one kept): 0 when none, or not measured. */
  faceCopies?: number;
}
export interface HistoryPage {
  items: HistoryJob[];
  more: boolean;
  /** Where the next page starts (its `after`): the last job of this one. Null on the last page. */
  next: string | null;
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
  /** The seed its graph was built with, once it is sent to ComfyUI; null before, and for a job with none (an export, a cut). */
  seed?: number | null;
}
/**
 * What a "progress" live event carries: the running job's id and the figures that moved. The job in
 * the queue on screen is changed in place with them (live.ts), so a render that reports every step
 * costs no request. The id is the job's, not ComfyUI's prompt id.
 */
export type ProgressUpdate = Pick<RunningJob, "id" | "progress" | "eta" | "phase" | "step" | "steps" | "previewSeq" | "stages" | "previewMime" | "spilling" | "seed" | "machine">;
/** A ComfyUI as the queue sees it: its settings, whether it answered, whether it is paused on its own, what it holds and runs. */
export interface MachineState {
  id: string;
  name: string;
  url: string;
  takes: "all" | "image" | "video";
  paused: boolean;
  /** Whether it answered when last asked; null before it was asked (nothing waited for it). */
  online: boolean | null;
  /** Offline because it is locked against the token Afflatus has for it (Settings › ComfyUI: paste its token), not because it is away. */
  locked: boolean;
  /** A rented pod: started, stopped, what it has cost; null for a ComfyUI of its own. */
  rented: RentedState | null;
  /** Of a ComfyUI of its own: the model files downloading into it now (a pod's are in `rented.files`). */
  files?: PodFile[];
  /** The model it was last asked to load, by name; null when none is, or it is not known. */
  model: string | null;
  /** Its learned pace against the others (1 the common pace, 2 half as fast); null with nothing to compare yet. */
  pace: number | null;
  running: RunningJob | null;
}
export interface QueueStatus {
  /** Pause all; each machine says its own in `machines`. */
  paused: boolean;
  /** The model the first ComfyUI was last asked to load, by name. Null when none is, or when it is not known. */
  model: string | null;
  online: boolean;
  offlineForMs: number;
  /** The first running job (the screens that show one); every machine's is in `machines`. */
  running: RunningJob | null;
  machines: MachineState[];
  /** The job that needs no ComfyUI running beside them (an export, a cut by ffmpeg), when one is. */
  tool: RunningJob | null;
  /**
   * Every waiting job, in the line's order. The first `whole` of them as the server has them; the others in the few
   * figures the answer carries of them (`LaterJob`, the rest null): the list asks for their whole rows when it shows them
   * (api.queueWaiting).
   */
  waiting: Job[];
  /** How many of `waiting` came whole. */
  whole: number;
  /** In how long the plan has the last waiting job end (the machines sharing them), in ms; left out by a server without it. */
  waitingEndsInMs?: number | null;
  recent: Job[];
  /** The GPU hunt under way, as the status bar says it; null when there is none. */
  hunt: HuntSummary | null;
}
/** A waiting job past the first ones of the queue's answer, in a few figures, those it has none of left out (the server's queueView.ts paged). */
export type LaterJob = Pick<Job, "id" | "label" | "kind" | "recipe"> & { [K in "clipId" | "draftId" | "machine" | "pinned" | "estimateMs" | "startsInMs" | "runsOn"]?: NonNullable<Job[K]> };
/** The queue as GET /api/queue answers it: the first waiting jobs whole, the others in `later`; api.ts makes a QueueStatus of it. */
export type QueueAnswer = Omit<QueueStatus, "whole"> & { waitingCount: number; later: LaterJob[] };

/** The GPU hunt in a few figures, with the queue's status (the server's hunt.ts HuntSummary). */
export interface HuntSummary {
  /** hunting: RunPod asked every 30 s; deploying: the GPU found is being deployed; up: its pod made, followed until it stops. */
  status: "hunting" | "deploying" | "up";
  startedAt: string;
  giveUpAt: string;
  /** rest: the home machines paused for it; keep: they go on rendering. */
  hold: "rest" | "keep";
  /** The renders waiting for it. */
  held: number;
  /** The best-ranked usable GPU, as last ranked; null before the first ask, or with none usable. */
  firstPick: { name: string; price: number } | null;
  machine: string | null;
}
export type HuntMode = "value" | "fast" | "cheap";
/** The hunt as kept (GET /api/hunt): its choices and where it is. */
export interface HuntState {
  mode: HuntMode;
  ceiling: number;
  leftOut: string[];
  cloud: "SECURE" | "COMMUNITY";
  /** The data center its network volume pins the pod to; null: any. */
  dataCenter: string | null;
  /** The Deploy dialog's choices it deploys with, all but the GPU. */
  deploy: Omit<DeployAsk, "gpu">;
  hold: HuntSummary["hold"];
  startedAt: string;
  giveUpAt: string;
  status: HuntSummary["status"];
  machine: string | null;
  /** The home machines it paused, resumed when it ends. */
  pausedByHunt: string[];
  /** How many times RunPod's stock was asked. */
  asks: number;
  lastError: string | null;
  found: { gpu: string; name: string; price: number; dataCenter: string | null; at: string } | null;
}
/** What a deploy bills besides its renders, from the user's own sessions (the server's costs.ts deployOverhead), in ms of the pod's time. */
export interface DeployOverhead {
  bootMs: number;
  idleMs: number;
  /** The usual fetch of the files, for a deploy without a network volume; 0 with one. */
  fetchMs: number;
  sessions: number;
}
/** GET /api/hunt: the hunt (null: none), its last ranking and when RunPod was last asked. */
export interface HuntView {
  hunt: HuntState | null;
  ranking: RankedGpu[] | null;
  askedAt: string | null;
}
/** What a hunt is started with, and changed by (PATCH: the deploy choices are the start's). */
export interface HuntAsk {
  mode: HuntMode;
  ceiling: number;
  leftOut: string[];
  giveUpMinutes: number;
  hold: HuntSummary["hold"];
}
/**
 * What a form will take, as the server forecasts it from this machine's renders (POST /api/advice): the form's
 * Output line (`text`, `pace`) and the Generate button (`ms`, `loadMs`) are both read from it.
 */
export interface Advice {
  text: string;
  pace: "usual" | "untested" | "over";
  /** One render, its model's load included when the model is not the one in memory. */
  ms: number;
  /** The load in `ms`: a batch loads its model once. */
  loadMs: number;
  /** With several machines, one render on each (by machine id), from that machine's own renders, else the others' at its pace. */
  on?: Record<string, number> | null;
  /** The load in each of `on`: 0 on a machine that holds the model. */
  loadOn?: Record<string, number> | null;
  /** With several machines, the ones Auto may give it to now (open, taking it, with its files): a batch is shared between them. */
  auto?: string[] | null;
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
  /** The machine the figures are of (a Machine's id); null: every machine. One machine's are read from its renders kept one by one. */
  machine?: string | null;
  /** Each machine that rendered in the window: renders, GPU time, and its learned pace (1 the common pace, 2 half as fast; null: nothing to compare). */
  machines?: Array<{ id: string; renders: number; gpuMs: number; pace: number | null; /** A rented pod's GPU ("A40 pod"); null for a ComfyUI of its own. */ name: string | null }>;
  tiles: {
    done: number; images: number; videos: number; failed: number; cancelled: number;
    videoMs: number; lostMs: number; gpuMs: number; longestMs: number;
    loadMs: number; loads: number; loadUsualMs: number | null;
    waitedUsualMs: number | null; waitedSlowMs: number | null; off: number | null;
    vramPeak: number | null; vramUsual: number | null; heatPeak: number | null; heatUsual: number | null;
    /** Finishes and slow motions among the renders; runs that ran out of video memory, and the time that cost. */
    tools?: number; spills?: number; spillLostMs?: number;
    /** Failures that ran out of memory (OOM). */
    oom?: number;
    /** Of the failed and cancelled, those that never reached ComfyUI (refused before they were sent, stopped while they waited, ffmpeg). */
    unsent?: { failed: number; cancelled: number };
  };
  /** The period before, as long: what the headline figures are set against. Null for "all", or when the record does not reach back over it. */
  prior?: { from: number; to: number; gpuMs: number; done: number; failed: number; cancelled: number; videoMs: number } | null;
  /** The upscales' pace per stretch: a video route in minutes per second of video, a picture tool or a hires pass in seconds per megapixel. */
  upscale?: { video: Array<{ key: string; name: string; points: Line }>; pictures: Array<{ key: string; name: string; points: Line }> };
  finished: { images: number[]; videos: number[]; bad: number[]; videoMs?: number[] };
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
    /** What went wrong: failures, stops, the GPU time they took, the failures out of memory; and how many times it loaded. */
    failed?: number; cancelled?: number; lostMs?: number; oom?: number; loads?: number;
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
  /** The machine it ran on (a Machine's id); null when not known. */
  machine?: string | null;
  /** It failed out of memory (OOM). */
  oom?: boolean;
}

/** How free a GPU is on RunPod, overall or in a data center. */
export type Availability = "HIGH" | "MEDIUM" | "LOW" | "NONE";

/** A GPU a pod can be deployed on now: its price an hour on the cloud asked, and where it is free. */
export interface GpuOffer {
  id: string;
  name: string;
  /** Its memory, GB. */
  memory: number;
  price: number;
  availability: Availability;
  dataCenters: Array<{ id: string; availability: Availability }>;
}

/** A pod as a volume names it: its machine's name when it is one. */
export interface PodOn {
  pod: string;
  name: string;
  status: RentedState["status"];
}

/** A network volume of the RunPod account: the models kept between deploys, in one data center. */
export interface NetworkVolume {
  id: string;
  name: string;
  size: number;
  dataCenter: string;
  /** The pod running on it now: no other pod may use it meanwhile. */
  usedBy: PodOn | null;
  /** Every pod it is mounted on, stopped ones too: it cannot be deleted while one is. */
  mountedOn: PodOn[];
  /** USD a month. */
  perMonth: number;
  /** What it holds as the last pod on it listed; null: no pod Afflatus follows ran on it yet. */
  holds: { count: number; seenAt: string; seenBy: string } | null;
  /** When a pod last ran on it; null: never seen used. */
  usedAt: string | null;
  /** No pod ran on it for the days set in Settings: it bills for nothing. */
  unused: boolean;
  /** How its last Fill from a set… ended: when, the files that failed, and why it was cut short when it was (neither: all in). */
  lastFill: { at: string; failed: Array<{ file: string; error: string }>; interrupted?: string } | null;
  /** Each Model set as it held it last time a pod ran there: what it lacks (empty when nothing is known). */
  sets: Array<{ id: string; name: string; missing: { count: number; bytes: number; unknown: number } }>;
}

/** What Make a volume… says first: where (GPUs in stock now, the user's pods there), the size the sets want, whether it pays for itself. */
export interface VolumePlan {
  places: Array<{ dataCenter: string; gpus: Array<{ name: string; price: number }>; pods: number }>;
  sets: Array<{ id: string; name: string; bytes: number }>;
  sizeGb: number;
  /** The pods run in the last 30 days and their mean rate ($/h). */
  deploys: number;
  rate: number | null;
  /** How long fetching the sets takes each deploy, and its cost at the mean rate; null when never measured. */
  fetch: { fastMs: number; slowMs: number; lowUsd: number; highUsd: number } | null;
}

/** What Fill from a set… says first: the GPU it takes, what the volume lacks of the set, how long, what it costs. */
export interface FillPlan {
  gpu: { name: string; price: number } | null;
  missing: { count: number; bytes: number; unknown: number };
  estimate: { fastMs: number; slowMs: number; lowUsd: number; highUsd: number } | null;
  /** The presets of the set's files under a licence not accepted yet: each accepted before Fill. */
  licences: Array<{ id: string; name: string; licence: string }>;
}

/** A pod of the user's on RunPod, as the list for adding one says it. */
export interface RunpodPod {
  id: string;
  name: string;
  status: RentedState["status"];
  /** USD an hour while it runs (RunPod says 0 while it is stopped). */
  cost: number;
  gpu: string | null;
  gpuCount: number;
  dataCenter: string | null;
  diskGb: number;
  /** The network volume it is on, when it is one. */
  volumeId?: string | null;
  /** It exposes ComfyUI's port (8188, HTTP): it can be added. */
  comfy: boolean;
  /** The machine it is added as, when it is. */
  added: string | null;
}

/** What the rented GPUs cost (Afflatus's figures: their time × their rate), the caps, and RunPod's balance. */
export interface RentedSpending {
  today: number;
  month: number;
  caps: { day: number; month: number };
  balance: number | null;
  lowBalance: boolean;
  /** What the account spends an hour now on RunPod (every pod and volume). */
  spendPerHr: number | null;
  /** How long the balance lasts at that spend (ms); null when nothing is spent, or not known. */
  runwayMs: number | null;
  /** What a day costs at this pace: the pods over the last 7 days (Afflatus's count) and storage as the account stands. */
  perDay: { pods: number; storage: number };
  /** How long the balance lasts at that pace (days): the runway said in Settings and Queue › Costs alike. */
  runwayDays: number | null;
  /** Today and this month are RunPod's own bill (the last hours counted by Afflatus); false: Afflatus's count alone. */
  billed: boolean;
  /** What storage costs (volumes, the pods' own disks); null when RunPod was not read. Never counted against the caps. */
  storage: {
    /** The volumes' bill this month, as RunPod has written it; null when it did not give it. */
    volumesMonth: number | null;
    /** Of this month's spending, the pods' own disks (in it already). */
    disksMonth: number;
    /** What storage costs a month with nothing running, as the account stands now. */
    perMonth: number;
    volumes: number;
    stoppedDisks: number;
    /** The volumes no pod ran on for the days set in Settings. */
    unused: Array<{ id: string; name: string; perMonth: number; usedAt: string | null }>;
  } | null;
}

/** What a machine row says of a rented pod. Afflatus never starts one on its own. */
export interface RentedState {
  provider: "runpod";
  pod: string;
  /** As RunPod says it; GONE: not on RunPod (terminated there, or another account's key); UNKNOWN: not read yet, or RunPod did not answer. */
  status: "PROVISIONING" | "STARTING" | "RUNNING" | "EXITED" | "ERROR" | "TERMINATED" | "GONE" | "UNKNOWN";
  /** USD an hour while it runs (the last rate seen): its GPU and its own disks, as RunPod bills it. */
  rate: number | null;
  /** Of it, the GPU's price alone, while it runs. */
  gpuRate: number | null;
  gpu: string | null;
  dataCenter: string | null;
  /** When the running session began (ms), and what it has cost so far (USD). */
  since: number | null;
  spent: number;
  /** What its own disk costs a day while it is stopped (USD). */
  diskPerDay: number;
  /** It has a volume: a stop keeps something. Without, a stop keeps nothing. */
  volume: boolean;
  /** Its public ports besides ComfyUI's ("8080/http", "22/tcp"), outside the lock. */
  otherPorts: string[];
  /** The ports Afflatus closed on it. */
  closedPorts: string[];
  /** The node pack's watchdog on it. */
  watchdog: "on" | "none" | "unknown";
  /** Its ComfyUI answers, while it runs: false while it boots, or when it went down on the pod. */
  answers: boolean | null;
  /** When it stops for being idle (ms since the epoch), while it runs idle: the page counts down to it. */
  idleAt: number | null;
  /** A spending cap is reached: it stops once its render ends. */
  capped: boolean;
  /** Afflatus is stopping it now: it takes no new work. */
  stopping: boolean;
  /** Why Afflatus stopped or terminated it last: "boot" when its ComfyUI never answered. */
  stoppedBy: "idle" | "cap" | "you" | "boot" | "gpu" | "watchdog" | "filled" | "cut" | "start" | null;
  /** Deployed and on its first start (its image pulled, ComfyUI starting): a normal step. */
  booting: boolean;
  /**
   * While it boots, where it is: its image pulled (RunPod says no uptime yet), ComfyUI starting (its container up), or the
   * step its boot log says (the Afflatus image, 0.1.12 on), `failed` when its start stopped there; `from`: its deploy (ms).
   */
  boot?: { phase: "pulling" | "starting" | "step"; step: string | null; failed: boolean; from: number } | null;
  error: string | null;
  /** The model files it is getting: what its jobs wait for, then what was asked ahead. */
  files: PodFile[];
  /** The node packs it gets for its jobs (through its ComfyUI-Manager, then a restart of its ComfyUI). */
  packs: PodPack[];
  /** Its disk as its node pack last said it (0.19.0 on); null: not known (not read yet, or an older pack). */
  disk: PodDisk | null;
}

/** A node pack a rented pod gets for its waiting jobs. */
export interface PodPack {
  name: string;
  state: "next" | "installing" | "installed" | "ready" | "failed";
  error?: string;
  jobs: string[];
}
