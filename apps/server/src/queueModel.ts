import type { EventEmitter } from "node:events";
import type { WaitOptions } from "@afflatus/comfy";
import type { BuiltGraph, Phase, Recipe } from "@afflatus/core";
import type { Comfy } from "./comfy";
import type { Db, Tables } from "./db";
import type { Rate } from "./forecast";
import type { Registry } from "./registry";
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

/** The job under way: its abort switch, the prompt ComfyUI knows it by once it has one, and whether it holds the GPU. */
export interface Running {
  id: string;
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
  /** The seed the graph was built with, once it is sent: said on the running card. */
  seed?: number;
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
}

export interface QueueOptions {
  /** How long to wait before looking for ComfyUI again while it is away. */
  offlineRetryMs: number;
  /** Queued jobs are given up after ComfyUI has been away this long (not by their own age). */
  offlineExpiryMs: number;
  maxAttempts: number;
  wait: Pick<WaitOptions, "timeoutMs" | "pollMs" | "offlineMs" | "queueCheckEvery">;
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
  /** About how long a waiting render will take, its model to load or not (the forecast, queueSubmit.forecastOf); null when nothing like it was rendered. */
  expected(recipe: Recipe<any>, input: Record<string, unknown>, cold: boolean): Promise<number | null>;
  /** A job that needs no model, claimed and closed by the state machine; `work` is the job itself. */
  runTool(row: JobRow, work: (run: Running) => Promise<void>): Promise<void>;
}
