import type { Scan } from "@afflatus/comfy";
import { fileKey, folderOfFileInput, type Recipe } from "@afflatus/core";
import { OWNER } from "./db";
import { folderOf, keptHoldings, type KeptHoldings } from "./rentedVolumes";
import type { Services } from "./services";
import type { Machine } from "./settings";

/**
 * Where each model file is, across the machines (card #139): the lists to choose from are every answering ComfyUI's
 * together (machineScans.ts mergeScans), and a file only a pod has was counted and grouped as the user's own. What a
 * stopped pod holds is offered too: its network volume's files as last listed (volume_files), and the model set it was
 * deployed with, which it fetches. A pod deployed without a volume keeps nothing across a stop (its container disk is
 * erased; such a pod is terminated at its idle stop), so a volume and a set are all there is to know of a pod not up.
 */

/** A file a pod holds or fetches that no answering ComfyUI lists: offered greyed in the lists, picked as any other. */
export interface OfferedFile {
  file: string;
  /** The pod's machine id. */
  pod: string;
  /** "volume": on its network volume, as last listed; "set": in the model set it was deployed with, fetched by the pod. */
  via: "volume" | "set";
  /** The set's name, for "set". */
  set?: string;
  bytes?: number;
}

export interface FilePlaces {
  /**
   * By model folder and file, the machines whose ComfyUI lists it now (machine ids). Only with a rented pod in the
   * settings: with the user's own machines alone, nothing is said of where a file is.
   */
  on?: Record<string, Record<string, string[]>>;
  /** By model folder, what pods hold or fetch that they do not list now (a pod stopped, or still fetching its set). */
  offered: Record<string, OfferedFile[]>;
  /** The pods not up, by machine id, with what RunPod says of each ("stopped", "being stopped"…). */
  down: Record<string, string>;
}

/** The model folder each input of a recipe picks a file from: a model's, the LoRAs', a choice among a loader's files. */
export function inputFolders(recipe: Pick<Recipe<any>, "inputs">): Map<string, string> {
  const out = new Map<string, string>();
  for (const i of recipe.inputs) {
    if (i.type === "model") out.set(i.id, i.folder);
    else if (i.type === "loras") out.set(i.id, "loras");
    else if (i.type === "choice" && !Array.isArray(i.options)) {
      const folder = folderOfFileInput(i.options.node, i.options.input);
      if (folder) out.set(i.id, folder);
    }
  }
  return out;
}

/** Each answering machine's files by folder, from what its scan offers each recipe's inputs: folder → file → machine ids. */
export function filesOn(scans: ReadonlyArray<{ machine: Pick<Machine, "id">; scan: Scan }>, recipe: (id: string) => Pick<Recipe<any>, "inputs"> | undefined): Record<string, Record<string, string[]>> {
  const out: Record<string, Record<string, string[]>> = {};
  const folders = new Map<string, Map<string, string>>();
  for (const { machine, scan } of scans) {
    if (!scan.comfy.online) continue;
    // recipes share their lists (one array per folder): each is gone through once per machine
    const seen = new Set<string[]>();
    for (const r of scan.recipes) {
      let of = folders.get(r.id);
      if (!of) {
        const known = recipe(r.id);
        of = known ? inputFolders(known) : new Map();
        folders.set(r.id, of);
      }
      for (const [input, list] of Object.entries(r.options)) {
        const folder = of.get(input);
        if (!folder || seen.has(list)) continue;
        seen.add(list);
        const files = (out[folder] ??= {});
        for (const f of list) {
          const ids = (files[f] ??= []);
          if (!ids.includes(machine.id)) ids.push(machine.id);
        }
      }
    }
  }
  return out;
}

/**
 * What the pods hold or fetch beyond what they list now, by folder: a pod not up, its volume's files as last listed; any
 * pod, the files of the set it was deployed with that it does not list. A pod that only fills its volume takes no render:
 * left out. `listed`: folder → the keys (core fileKey) of the files a machine lists now, by machine id.
 */
export function offeredBy(
  pods: ReadonlyArray<Pick<Machine, "id"> & { rented?: Pick<NonNullable<Machine["rented"]>, "volume" | "set" | "setFiles" | "fill"> }>, down: (id: string) => string | null,
  holdings: ReadonlyMap<string, Pick<KeptHoldings, "listing">>, setNames: ReadonlyMap<string, string>, listed: (machine: string) => ReadonlySet<string>,
): Record<string, OfferedFile[]> {
  const out: Record<string, OfferedFile[]> = {};
  for (const m of pods) {
    if (!m.rented || m.rented.fill) continue;
    const has = listed(m.id);
    const taken = new Set<string>();
    const add = (folder: string, f: OfferedFile) => {
      const key = fileKey({ folder, file: f.file });
      if (has.has(key) || taken.has(key)) return;
      taken.add(key);
      (out[folder] ??= []).push(f);
    };
    if (down(m.id) && m.rented.volume) {
      for (const f of holdings.get(m.rented.volume)?.listing ?? []) add(folderOf(f), { file: f.name, pod: m.id, via: "volume", ...(f.bytes ? { bytes: f.bytes } : {}) });
    }
    // the files its deploy asked for, not the set as it is now (a file unticked in the dialog was never fetched)
    const set = setNames.get(m.rented.set) ?? "a model set";
    for (const f of m.rented.set ? m.rented.setFiles : []) add(f.folder, { file: f.file, pod: m.id, via: "set", set, ...(f.size ? { bytes: f.size } : {}) });
  }
  return out;
}

/** A pod with the network volume it is on: its deploy's, else RunPod's word (a pod added by hand names none). */
const withVolume = <M extends Pick<Machine, "id" | "rented">>(m: M, volume: (id: string) => string | null): M =>
  m.rented && !m.rented.volume ? { ...m, rented: { ...m.rented, volume: volume(m.id) ?? "" } } : m;

/** What the places are read from: the machines with their scans, RunPod's word on each pod, the volumes and the sets. */
export interface PlacesDeps {
  scans: ReadonlyArray<{ machine: Machine; scan: Scan | null }>;
  recipe(id: string): Pick<Recipe<any>, "inputs"> | undefined;
  down(machine: string): string | null;
  /** The network volume RunPod says the pod is on (rented.ts volumeOf). */
  volume(machine: string): string | null;
  holdings(): Promise<ReadonlyMap<string, Pick<KeptHoldings, "listing">>>;
  /** The model sets' names, by id. */
  setNames(): Promise<ReadonlyMap<string, string>>;
}

/** Where every file is (FilePlaces): read only when a pod is in the settings, its volume and its set only when it has one. */
export async function placesOf(d: PlacesDeps): Promise<FilePlaces> {
  const pods = d.scans.filter((x) => x.machine.rented).map((x) => ({ ...x, machine: withVolume(x.machine, d.volume) }));
  if (!pods.length) return { offered: {}, down: {} };
  const answering = d.scans.filter((x): x is { machine: Machine; scan: Scan } => Boolean(x.scan?.comfy.online));
  const on = filesOn(answering, d.recipe);
  const byMachine = new Map<string, Set<string>>();
  for (const [folder, files] of Object.entries(on)) {
    for (const [file, ids] of Object.entries(files)) for (const id of ids) {
      let keys = byMachine.get(id);
      if (!keys) byMachine.set(id, (keys = new Set()));
      keys.add(fileKey({ folder, file }));
    }
  }
  const down = Object.fromEntries(pods.flatMap((x) => {
    const why = d.down(x.machine.id);
    return why ? [[x.machine.id, why] as const] : [];
  }));
  const volumes = pods.some((x) => down[x.machine.id] && x.machine.rented!.volume);
  const withSet = pods.some((x) => x.machine.rented!.setFiles.length);
  const [holdings, setNames] = await Promise.all([volumes ? d.holdings() : new Map(), withSet ? d.setNames() : new Map<string, string>()]);
  const offered = offeredBy(pods.map((x) => x.machine), (id) => down[id] ?? null, holdings, setNames, (id) => byMachine.get(id) ?? new Set());
  return { on, offered, down };
}

/** placesOf as the server reads it: the volumes as kept, the sets' names from the database, RunPod's word on each pod. */
export function placesFrom(s: Pick<Services, "db" | "registry" | "rented">, scans: PlacesDeps["scans"]): Promise<FilePlaces> {
  return placesOf({
    scans,
    recipe: (id) => s.registry.recipe(id),
    down: (id) => s.rented.podDown(id),
    volume: (id) => s.rented.volumeOf(id),
    holdings: () => keptHoldings(s.db),
    setNames: async () => new Map((await s.db.selectFrom("model_sets").select(["id", "name"]).where("owner_id", "=", OWNER).execute()).map((r) => [r.id, r.name])),
  });
}

/**
 * What each pod not up holds or fetches, by pod id: the keys (core fileKey) of its volume's files as last listed and of the
 * files of the set it was deployed with. The queue reads it for a job no machine can run now: one whose files a stopped pod
 * has waits for that pod, its row offering Start (queuePlan.ts ableOf).
 */
export async function downPodFiles(s: Pick<Services, "db" | "rented">, machines: ReadonlyArray<Machine>): Promise<Map<string, Set<string>>> {
  const pods = machines.filter((m) => m.rented && s.rented.podDown(m.id)).map((m) => withVolume(m, (id) => s.rented.volumeOf(id)));
  const out = new Map<string, Set<string>>();
  if (!pods.length) return out;
  const holdings = pods.some((m) => m.rented!.volume) ? await keptHoldings(s.db) : new Map<string, KeptHoldings>();
  const offered = offeredBy(pods, (id) => s.rented.podDown(id), holdings, new Map(), () => new Set());
  for (const [folder, files] of Object.entries(offered)) {
    for (const f of files) {
      let keys = out.get(f.pod);
      if (!keys) out.set(f.pod, (keys = new Set()));
      keys.add(fileKey({ folder, file: f.file }));
    }
  }
  return out;
}
