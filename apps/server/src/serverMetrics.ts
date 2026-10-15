import { AsyncLocalStorage } from "node:async_hooks";
import { collectDefaultMetrics, Histogram, Registry } from "prom-client";

/**
 * The server's own figures, added at the end of /metrics (metrics.ts): Node's, as prom-client collects them (event-loop
 * lag, heap, RSS, garbage collection, CPU), and what Afflatus adds to each render on a machine: the time before ComfyUI
 * has the prompt and the time filing what it made, each with its parts. Those are the seconds a GPU waits on Afflatus,
 * so a machine where they grow (a pod's uploads, a slow disk) shows here. Labelled by the machine's id only: its name is
 * the user's words, and a registry gives one text to every scraper.
 */
export const serverRegistry = new Registry();
collectDefaultMetrics({ register: serverRegistry });

/** From 50 ms (a picture on this computer) to two minutes (a long clip cut and sent to a pod). */
const BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120];

const added = new Histogram({
  name: "afflatus_render_added_seconds",
  help: "Time Afflatus spent around a render on a machine: before ComfyUI had the prompt (stage=before), and filing what it made (stage=filing)",
  labelNames: ["machine", "stage"] as const,
  buckets: BUCKETS,
  registers: [serverRegistry],
});
const parted = new Histogram({
  name: "afflatus_render_added_part_seconds",
  help: "The parts of afflatus_render_added_seconds: checking the machine (scan), cutting and reading the media (cuts), sending them (uploads), freeing its memory for another model (free), measuring the result (measuring)",
  labelNames: ["machine", "part"] as const,
  buckets: BUCKETS,
  registers: [serverRegistry],
});

export type AddedPart = "scan" | "uploads" | "cuts" | "free" | "measuring";
type Parts = Partial<Record<AddedPart, number>>;

/** The parts of the stage under way, for the code it calls (queueSubmit, queueStore) to add to without passing them along. */
const current = new AsyncLocalStorage<Parts>();

/** Runs a stage of a render (submit, store), gathering the parts its code adds (addPart); `parts` holds them after. */
export function gathering<T>(parts: Parts, work: () => Promise<T>): Promise<T> {
  return current.run(parts, work);
}

/** Milliseconds of a part, added to the stage under way; nothing outside one (a forecast building a graph, the precompute). */
export function addPart(part: AddedPart, ms: number): void {
  const parts = current.getStore();
  if (parts) parts[part] = (parts[part] ?? 0) + ms;
}

/** Times `work` as a part of the stage under way. */
export async function timedPart<T>(part: AddedPart, work: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    return await work();
  } finally {
    addPart(part, performance.now() - t0);
  }
}

/** A stage of a render that went through, on its machine: its whole time and its parts (ms). */
export function observeAdded(machine: string, stage: "before" | "filing", ms: number, parts: Parts): void {
  added.observe({ machine, stage }, ms / 1000);
  for (const [part, partMs] of Object.entries(parts)) parted.observe({ machine, part }, partMs / 1000);
}
