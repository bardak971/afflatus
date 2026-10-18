import { folderOfFileInput } from "./models";
import { isModelFile } from "./modelFiles";
import { dryContext, parseInput, type Recipe } from "./recipe";

/**
 * The model files a built graph loads, read from its nodes: what a machine must have for that one job, and what a rented
 * pod is sent for it. Counted from the graph, not from the family's slots: a swap runs its own model as a hybrid and never
 * reads the family's video model, yet a pod deployed for one fetched it (2026-10-18), and so did every recipe whose build
 * leaves a required slot of its family unread (SDXL's checkpoint, picked per render; an edit's own model).
 */
export interface GraphFile {
  file: string;
  folder: string;
  /** The first node (its id and type) and input that name it: where a machine's node list says whether it has the file. */
  node: string;
  classType: string;
  input: string;
  /** The family slot the build was handed it as, when it was one. */
  slot?: string;
}

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

/**
 * Every file a graph names, each once. An input is a file when the build was handed it as a slot's file (`slots`, with
 * each slot's folder in `folders`: our own loaders' inputs, a Veda predictor, a tiny VAE, are not known by name), or when
 * its node input is a known loader's (`folderOfFileInput`: a LoRA, an upscaler, an imported workflow's models).
 */
export function graphFiles(graph: Graph, slots: Readonly<Record<string, string>> = {}, folders: Readonly<Record<string, string>> = {}): GraphFile[] {
  const bySlot = new Map<string, string>();
  for (const [id, file] of Object.entries(slots)) if (file && folders[id] && !bySlot.has(file)) bySlot.set(file, id);
  const out: GraphFile[] = [];
  const seen = new Set<string>();
  for (const [node, n] of Object.entries(graph)) {
    for (const [input, value] of Object.entries(n.inputs)) {
      if (typeof value !== "string" || !value) continue;
      const slot = bySlot.get(value);
      const folder = slot ? folders[slot]! : isModelFile(value) ? folderOfFileInput(n.class_type, input) : null;
      if (!folder) continue;
      const key = `${folder}|${value.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ file: value, folder, node, classType: n.class_type, input, ...(slot ? { slot } : {}) });
    }
  }
  return out;
}

/**
 * The name a required slot with no file is built with: a build that reads it names it in its graph (missingSlotIn), one
 * that never reads it does not, and the job runs without that file. Never a file anyone has.
 */
export const missingSlotFile = (slot: string) => `${MISSING}${slot}.safetensors`;
const MISSING = "afflatus-missing-slot.";

/**
 * Slots whose file makes a render better, not different (RIFE: twice the frames). A rented pod is sent it for a job that
 * asks for it; a machine of the user's own without it still takes the job, renders without it, and the job says so: kept
 * off every such machine, an H3 clip with "RIFE ×2" on (the default) would wait for ever where no machine had RIFE.
 */
export const SOFT_SLOTS: ReadonlySet<string> = new Set(["rife"]);

/** Whether a file name is missingSlotFile's: a file nobody has, that cannot be sent. */
export const isMissingSlotFile = (file: string) => file.startsWith(MISSING);

/** The slot a graph reads that had no file (missingSlotFile), or null. */
export function missingSlotIn(graph: Graph): string | null {
  for (const n of Object.values(graph)) {
    for (const value of Object.values(n.inputs)) {
      if (typeof value === "string" && value.startsWith(MISSING)) return value.slice(MISSING.length).replace(/\.safetensors$/, "");
    }
  }
  return null;
}

/**
 * Which of these slots any of a recipe's variants reads (they cover every branch of its build): a slot none reads is not
 * missing for it where its file is not (a swap without the family's video model is ready). Each variant is built with its
 * own files, a slot it leaves out named by missingSlotFile; a variant that cannot be built counts every slot as read.
 * Kept per recipe and slot list: the builds are pure.
 */
export function slotsRead(recipe: Recipe<any>, slots: readonly string[]): Set<string> {
  const key = slots.join("|");
  let kept = readKept.get(recipe);
  if (!kept) readKept.set(recipe, (kept = new Map()));
  const had = kept.get(key);
  if (had) return had;
  const read = new Set<string>();
  for (const v of recipe.variants) {
    const given = { ...Object.fromEntries(slots.map((id) => [id, missingSlotFile(id)])), ...(v.slots ?? {}) };
    let graph: Graph;
    try {
      graph = recipe.build(parseInput(recipe, v.input), dryContext({ slots: given, uploads: v.uploads ?? {}, media: v.media ?? {}, canvas: v.canvas })).graph;
    } catch {
      for (const id of slots) read.add(id);
      break;
    }
    const names = new Set<string>();
    for (const n of Object.values(graph)) for (const value of Object.values(n.inputs)) if (typeof value === "string") names.add(value);
    for (const id of slots) if (names.has(given[id]!)) read.add(id);
  }
  kept.set(key, read);
  return read;
}
const readKept = new WeakMap<Recipe<any>, Map<string, Set<string>>>();
