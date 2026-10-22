import type { EventEmitter } from "node:events";
import type { WaitOptions } from "@afflatus/comfy";
import type { BuiltGraph, Phase, Recipe } from "@afflatus/core";
import type { Comfy } from "./comfy";
import type { Db, Tables } from "./db";
import type { FamilyReads, Rate, StatRows } from "./forecast";
import type { PackFacts } from "./jobPacks";
import type { Registry } from "./registry";
import type { Machine } from "./settings";
import type { Storage } from "./storage";
import type { TakeLinks, Timelines } from "./timelines";

/** What the queue's parts share: the job row, the job under way, what is kept to wait for a prompt again, and the door to the queue's state. */

export type JobRow = Tables["jobs"];

/** A JSON column read back: what it holds, or `fallback` when it is empty or cannot be read (one damaged row never breaks a whole list). */
export function readJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/**
 * The reason the job under way is aborted with when the process shuts down. A stop by hand drops the prompt in ComfyUI too;
 * a shutdown leaves it running there, so that the next start follows it (taken) instead of sending it again.
 */
export const SHUTDOWN = "shutting down";

/**
 * Why a rented pod takes no new job once a spending cap is reached (rented.ts unavailable): the render it runs goes on and
 * the pod stops after it, so nothing new may start there. A render it already has is still followed (an Afflatus restart).
 */
export const CAP_REACHED = "a spending cap is reached";

/** The GPU's load (percent) from which a render or a tool that says nothing is taken as at work, not stuck. */
export const GPU_AT_WORK = 30;

/**
 * The reason a render is aborted with when ComfyUI said nothing of it for too long on a rented GPU (rented.ts): it fails
 * with this message, and the pod, billed meanwhile, is free again for its next job or its idle time.
 */
export class Stuck {
  constructor(readonly message: string) {}
}

/**
 * The reason a render fails with when the ComfyUI it ran on died under it: a pod's report of it (rentedFollow), or a pod's
 * ComfyUI found started again without it. Never queued again on its own, as a machine merely gone is: a render that killed
 * ComfyUI would likely kill the next one's too, billed each time. `trace`: the pod's report and ComfyUI's last lines, kept
 * with the job.
 */
export class Died {
  /** `job`: the render it failed (machineDied), so that a later job on the same machine is never taken for it. */
  constructor(readonly message: string, readonly trace: string | null = null, readonly job: string | null = null) {}
}

/** The job under way: its abort switch, the prompt ComfyUI knows it by once it has one, and whether it holds the GPU. */
export interface Running {
  id: string;
  /** The machine it runs on; null for a job that needs no ComfyUI. */
  machine: string | null;
  abort: AbortController;
  promptId?: string;
  gpu: boolean;
  /** A job that needs no model: what it is doing, as the queue screen says it while it has no prompt to follow. */
  tool?: "exporting" | "cutting";
  /** The nodes' titles in the graph that was sent, for naming what a preview node shows on the way. */
  titles?: Record<string, string>;
  /** What it was expected to take, and when it started on the GPU: a run at twice that with the memory full is spilling. */
  expectedMs?: number | null;
  startedAt?: number;
  /** When ComfyUI last said something of it (a step, a node starting, a preview): a render silent for long is stuck. */
  movedAt?: number;
  /** When a system feed last read its GPU's load: with a fresh one, a silent render is known to leave its GPU idle. */
  loadAt?: number;
  /** The seed the graph was built with, once it is sent: said on the running card. */
  seed?: number;
  /** Whether its models had to be loaded (none were in memory): until its first step, "loading" or only "preparing". */
  cold?: boolean;
}

/** What is stored once ComfyUI accepted the graph: enough to wait for it again after a restart. */
export interface Resume {
  promptId: string;
  seed: number;
  outputs: BuiltGraph["outputs"];
  totalSteps: number;
  phases: Record<string, Phase>;
  passes?: BuiltGraph["passes"];
  /** The client id ComfyUI knows this prompt by: its progress is only sent to that client. */
  clientId?: string;
  /** The nodes' titles in the graph sent, for naming what its preview nodes show on the way. */
  titles?: Record<string, string>;
  loads: string[];
  startedAt: number;
  /** The inputs as they were sent, when some were filled in at the last moment (a timeline clip's neighbours). */
  input?: Record<string, unknown>;
  overlap?: BuiltGraph["overlap"];
  /** A timeline clip: the takes it was joined onto, and what else it was made from. */
  links?: TakeLinks;
  sources?: Array<{ asset: string; role: string }>;
  /** A timeline clip: the pinned pictures it flipped left to right as they were uploaded (its Mirror), kept with what it makes. */
  mirror?: string[];
  /** For the record of render times: what it is filed under, whether its model had to load, and what was expected of it. */
  timing?: { model: string; modelFile: string; timeKey: string; cold: boolean; expectedMs: number | null; expect: { laterMs?: number; finishMs?: number }; work?: number };
  /** What was sent otherwise than asked (a latent join made on frames, a whole sound for its part): said on the job. */
  warnings?: string[];
  /**
   * The steps counted so far, saved now and then while it runs (QueueOptions.stepsSaveMs): a process started again
   * mid-render picks the count up there instead of at the start of the pass that runs.
   */
  stepsDone?: number;
  /**
   * Saved just before the prompt went to ComfyUI, under the id it is sent with: a process that stops before
   * hearing back asks ComfyUI for that id when it starts again, and follows the prompt instead of sending it twice.
   */
  unsent?: true;
  /**
   * When its machine was found gone under it (ms since the epoch), the job queued again: it waits for that machine (its
   * machine_id), which may still be rendering it, until the machine has been away past the offline limit.
   */
  lostAt?: number;
}

export interface QueueOptions {
  /** How long to wait before looking for ComfyUI again while it is away. */
  offlineRetryMs: number;
  /** Queued jobs are given up after ComfyUI has been away this long (not by their own age). */
  offlineExpiryMs: number;
  maxAttempts: number;
  wait: Pick<WaitOptions, "timeoutMs" | "pollMs" | "offlineMs" | "queueCheckEvery">;
  /** How long before the model folders of a machine a job waits on for files are read again (Queue filesWait); a minute when left out. */
  filesRetryMs?: number;
  /** At most how often the running render's step count is saved on its job (Resume.stepsDone); 5 s when left out. */
  stepsSaveMs?: number;
}
export const DEFAULT_QUEUE_OPTIONS: QueueOptions = {
  offlineRetryMs: 15_000,
  offlineExpiryMs: 2 * 60 * 60_000,
  maxAttempts: 3,
  // a cold model load plus a slow render; ComfyUI itself has no limit
  wait: { timeoutMs: 90 * 60_000 },
};

/** What the forecast falls back on where it cannot place a form: per recipe, how long its renders usually took (forecast.ts). */
export interface Usual {
  rates: Record<string, Rate>;
}

/**
 * The queue as its submitting, storing, tools and view modules see it: what it was built with, its state
 * as it stands (read live, never copied), and the few things only the state machine does.
 */
export interface QueueCore {
  db: Db;
  storage: Storage;
  registry: Registry;
  events: EventEmitter;
  opts: QueueOptions;
  /** The machine (settings.ts `machines`) this core is the queue of: its ComfyUI, its running job, what it holds. Null for the lane of the jobs that need no ComfyUI. */
  readonly machineId: string | null;
  comfy(): Promise<Comfy>;
  /** The timelines, for jobs that render a clip of one (set once both exist). */
  readonly clips: Timelines | null;
  readonly running: Running | null;
  readonly paused: boolean;
  /** The base models the last job loaded, file names joined by "|"; null when not known. The name of the model that is loaded. */
  readonly lastLoads: string | null;
  readonly lastModel: string | null;
  readonly offlineSince: number | null;
  /** Note what ComfyUI was last asked to load, here and in the database. */
  loaded(loads: string | null, model?: string | null): Promise<void>;
  usual(): Promise<Usual>;
  /** A model's past renders as forecasts read them (forecast.ts statRows), kept until the record of render times changes. */
  statRows(modelFile: string): Promise<StatRows>;
  /** A model's family's renders and loads as forecasts read them (forecast.ts familyReads), kept as `statRows` are; left out, read at each ask. */
  familyReads?: FamilyReads;
  /** Each machine's learned pace (forecast.ts machinePaces), for a forecast on one machine read from another's renders. */
  paces(): Promise<ReadonlyMap<string, number>>;
  /** About how long a waiting render will take, its model to load or not (the forecast, queueSubmit.forecastOf), built as its job will be (a finish on its draft, a clip with what it joins onto), on `machine` when it is said; null when nothing like it was rendered. */
  expected(recipe: Recipe<any>, input: Record<string, unknown>, cold: boolean, job?: Pick<JobRow, "finished_from" | "clip_id" | "clip_fit"> | null, machine?: string | null): Promise<number | null>;
  /** The model a waiting render's graph loads, as the plan reads it: its form's, else the one its family's slot gives (SCAIL-2, the tools). */
  loadsModel?(recipe: Recipe<any>, input: Record<string, unknown>, job?: Pick<JobRow, "finished_from" | "clip_id" | "clip_fit"> | null): Promise<string | null>;
  /** A job that needs no model, claimed and closed by the state machine; `work` is the job itself. */
  runTool(row: JobRow, work: (run: Running) => Promise<void>): Promise<void>;
  /** What node packs can come to this machine (jobPacks.ts): its card, its Manager, the packs that failed there. Left out: anything may. */
  packFacts?(): Promise<PackFacts>;
}

/** A machine's lane: its ComfyUI, the job it runs, what it was last asked to load, whether it is paused by hand. */
export interface Lane {
  id: string;
  machine: Machine | null;
  comfy: Comfy | null;
  running: Running | null;
  /** The job being started on it, from the moment the pass picks it until it runs or turns out taken. */
  starting: string | null;
  /** ComfyUI holds a model this app had it load. Unknown after a restart: taken as not. */
  holds: boolean;
  unloadTimer: NodeJS.Timeout | null;
  /**
   * The base models the last job loaded (checkpoint or diffusion model, text encoders, VAE), file names joined by "|". A job
   * that needs a base model that is not among them frees the memory first; another LoRA or upscaler does not. Stored, so
   * that a restart of this app does not have ComfyUI unload a model the next job uses again; unknown (null) only before
   * the first job ever and after the memory was freed by hand.
   */
  lastLoads: string | null;
  /** The name of the model that is loaded, when it is known. */
  lastModel: string | null;
  /** Paused by hand on its own (Pause all is the queue's). */
  paused: boolean;
  /** Whether its ComfyUI answered the last time it was asked; null before. */
  reachable: boolean | null;
  /** The GPU its ComfyUI renders on, as it said when it last answered (its first device); null before. */
  device: string | null;
  /**
   * The prompts its ComfyUI has that are not Afflatus's (queued from its own page, another tool), running and waiting, as
   * its queue was last read; null before that, or when it could not be read. A machine with any takes no new job: its GPU
   * is someone else's until they are done.
   */
  outside: { running: number; pending: number } | null;
  /** When its queue was last read for them (readOutside), and the read under way with whether another is wanted after it. */
  outsideAt: number;
  outsideRead: Promise<void> | null;
  outsideAgain: boolean;
  /** Its state as kept across restarts, read once. */
  ready: Promise<void>;
  core: QueueCore;
}

/**
 * How long the queue's plan and forecasts wait for a machine's node list: a ComfyUI on this PC or the LAN answers within a
 * second, and one slower is read on in the background (comfy.ts keeps it) for the next ask.
 */
export const CATALOG_WAIT_MS = 2_000;

/** What a promise gives, or null when it fails or has not settled within `ms`. */
export function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([p.catch(() => null), new Promise<null>((done) => (timer = setTimeout(() => done(null), ms)))]).finally(() => clearTimeout(timer));
}
