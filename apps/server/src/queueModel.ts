import type { EventEmitter } from "node:events";
import type { WaitOptions } from "@afflatus/comfy";
import type { BuiltGraph, Known, Phase, Recipe } from "@afflatus/core";
import type { Comfy } from "./comfy";
import type { Db, Tables } from "./db";
import type { Rate } from "./estimates";
import type { Registry } from "./registry";
import type { Storage } from "./storage";
import type { TakeLinks, Timelines } from "./timelines";

/** What the queue's parts share: the job row, the job under way, what is kept to wait for a prompt again, and the door to the queue's state. */

export type JobRow = Tables["jobs"];
/** The job under way: its abort switch, the prompt ComfyUI knows it by once it has one, and whether it holds the GPU. */
export interface Running {
  id: string;
  abort: AbortController;
  promptId?: string;
  gpu: boolean;
  /** The nodes' titles in the graph that was sent, for naming what a preview node shows on the way. */
  titles?: Record<string, string>;
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
}

export interface QueueOptions {
  /** How long to wait before looking for ComfyUI again while it is away. */
  offlineRetryMs: number;
  /** Queued jobs are given up after ComfyUI has been away this long (not by their own age). */
  offlineExpiryMs: number;
  maxAttempts: number;
  wait: Pick<WaitOptions, "timeoutMs" | "pollMs" | "offlineMs" | "queueCheckEvery">;
}
export const DEFAULT_QUEUE_OPTIONS: QueueOptions = {
  offlineRetryMs: 15_000,
  offlineExpiryMs: 2 * 60 * 60_000,
  maxAttempts: 3,
  // a cold model load plus a slow render; ComfyUI itself has no limit
  wait: { timeoutMs: 90 * 60_000 },
};

/** How long things usually take: the rates from before there was a record, and the record itself. */
export interface Usual {
  rates: Record<string, Rate>;
  record: Record<string, Known>;
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
  /** About how long a render will take. */
  expected(usual: Usual, recipe: Recipe<any>, input: Record<string, unknown>, cold: boolean): number | null;
  /** A job that needs no model, claimed and closed by the state machine; `work` is the job itself. */
  runTool(row: JobRow, work: (run: Running) => Promise<void>): Promise<void>;
}
