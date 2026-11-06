import type { Scan } from "@afflatus/comfy";
import { fileKey, type GridJob } from "@afflatus/core";
import type { MachineComfy } from "./comfy";
import { downPodFiles } from "./filePlaces";
import { filesUsed, lackOn, type Lack } from "./machineScans";
import type { PodFileWant } from "./podFiles";
import type { Services } from "./services";
import { readSettings, type Machine } from "./settings";

/**
 * What a grid's cells need on the machines they may go to, before any is queued (card #294). A grid whose Model axis runs
 * across families has a pod fetch every family's model files: that is time billed before the first cell renders, which the
 * plan, the card and the ask before queuing count (each file once, however many cells use it), as a deploy says its files'
 * size and time. And a cell on another family that no machine it may go to can run (that family switched off, a file no
 * download is known for) is said before queuing, not failed after.
 */

/** What a rented pod would fetch for a grid: its files (each once), their bytes (null when one's size is not known) and their time there (ms; Infinity when one has no source). */
export interface PodFetchPlan {
  files: PodFileWant[];
  bytes: number | null;
  ms: number;
}

export interface GridFit {
  /** By rented pod id: what it would fetch for these cells. */
  fetch: Map<string, PodFetchPlan>;
  /** The first cell on another family that none of the machines can run, and why; null when each can run somewhere. */
  refused: string | null;
}

/**
 * Each machine with its scan as it is now (null: it did not answer), for gridFit. A pod the queue knows to be down (stopped,
 * at a cap) is not asked: a dead pod's address would hold the plan.
 */
export const scansOf = (s: Services, all: readonly MachineComfy[]) =>
  Promise.all(all.map(async (m) => ({ machine: m.machine, scan: s.queue.unavailable(m.machine.id) ? null : await m.comfy.scan().catch(() => null) })));

const nameOf = (m: Machine) => m.name || (m.rented ? "the rented pod" : "this PC's ComfyUI");
const keyOf = (f: { folder: string; file: string }) => `${f.folder}|${f.file.toLowerCase()}`;

/**
 * The files each rented pod of `machines` would fetch for these cells, and whether each cell on another family than the
 * grid's (`base`) can run on one of them. A pod whose ComfyUI answers is asked what it lacks (machineScans.ts lackOn). One
 * stopped or not answering is counted as fetching every file of the other families' cells it is not known to hold (what
 * a pod stopped keeps on a volume, filePlaces.ts), as the Deploy dialog counts a new pod; the grid's own family's files
 * are what the pod was rendering with, counted as a grid of one family always was (not at all), so that a plain grid on
 * Auto beside a stopped pod keeps its figure. A machine whose scan cannot be read is not held against a cell.
 */
export async function gridFit(s: Services, jobs: readonly Pick<GridJob, "recipe" | "input" | "label">[], base: string, machines: ReadonlyArray<{ machine: Machine; scan: Scan | null }>): Promise<GridFit> {
  const settings = await readSettings(s.db);
  const familyOf = (id: string) => s.registry.recipe(id)?.family;
  // a ComfyUI that does not answer has nothing known on it
  const scans = machines.map((m) => ({ machine: m.machine, scan: m.scan?.comfy.online ? m.scan : null }));
  // a form's lack is the same for every cell with the same files: worked out once per form a machine
  const lacks = new Map<string, Lack | null>();
  const lackOf = (machine: Machine, scan: Scan, j: Pick<GridJob, "recipe" | "input">): Lack | null => {
    const key = `${machine.id}\u0001${j.recipe}\u0001${JSON.stringify(j.input)}`;
    if (!lacks.has(key)) {
      const recipe = s.registry.recipe(j.recipe);
      lacks.set(key, recipe ? lackOn(recipe, j.input, scan, settings, machine, familyOf) : null);
    }
    return lacks.get(key)!;
  };
  const fetch = new Map<string, PodFetchPlan>();
  // what the pods not up hold on their disk or volume (filePlaces.ts): a stopped pod keeps what it fetched
  const held = scans.some((m) => m.machine.rented && !m.scan) ? await downPodFiles(s, scans.map((m) => m.machine)).catch(() => new Map<string, Set<string>>()) : new Map<string, Set<string>>();
  for (const { machine, scan } of scans) {
    if (!machine.rented) continue;
    const files = new Map<string, PodFileWant>();
    const has = held.get(machine.id);
    for (const j of jobs) {
      const recipe = s.registry.recipe(j.recipe);
      if (!recipe || (!scan && j.recipe === base)) continue;
      const want = scan ? (lackOf(machine, scan, j)?.files ?? []) : filesUsed(recipe, j.input, null, s.registry.family(recipe.family)?.slots ?? []).filter((f) => !has?.has(fileKey(f)));
      for (const f of want) if (!files.has(keyOf(f))) files.set(keyOf(f), f);
    }
    const list = [...files.values()];
    const sizes = await Promise.all(list.map(async (f) => (await s.podFiles.about(f).catch(() => null))?.size ?? null));
    const ms = list.length ? await s.podFiles.untilThere(machine.id, list).catch(() => Infinity) : 0;
    fetch.set(machine.id, { files: list, bytes: sizes.some((n) => n === null) ? null : sizes.reduce<number>((n, b) => n + b!, 0), ms });
  }
  let refused: string | null = null;
  // with no machine set up at all, the cells wait for a GPU as any render does
  if (!scans.length) return { fetch, refused };
  for (const j of jobs) {
    if (j.recipe === base || refused) continue;
    const recipe = s.registry.recipe(j.recipe);
    if (!recipe) {
      refused = `${j.label}: this model is not offered any more`;
      continue;
    }
    // runs on a machine that lacks nothing of it, or that can be sent what it lacks; one not read now is not held against it
    const kept = scans.map(({ machine, scan }) => ({ machine, lack: scan ? lackOf(machine, scan, j) : null, read: Boolean(scan) }));
    if (kept.some((k) => !k.read || !k.lack || (k.lack.sendable && (!k.machine.rented || Number.isFinite(fetch.get(k.machine.id)?.ms ?? 0))))) continue;
    const first = kept[0];
    const family = s.registry.family(recipe.family)?.name ?? recipe.family;
    const why = !first?.lack ? "no machine to run it" : first.lack.off ? `${family} is switched off on ${nameOf(first.machine)}` : `${nameOf(first.machine)} cannot run it: ${first.lack.why ?? "files it lacks cannot be had there"}`;
    refused = `${j.label}: ${why}`;
  }
  return { fetch, refused };
}
