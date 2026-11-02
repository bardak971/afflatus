import { folderOfFileInput } from "./models";
import { isModelFile } from "./modelFiles";
import { pickedFiles, type InputSpec } from "./inputs";
import { dryContext, parseInput, type Family, type Recipe } from "./recipe";

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

/** The loaders whose file input reads one folder only: the input, and that folder. */
const FIXED_FOLDER: Record<string, [input: string, folder: string]> = {
  UNETLoader: ["unet_name", "diffusion_models"],
  CheckpointLoaderSimple: ["ckpt_name", "checkpoints"],
};

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
      // ComfyUI's own two model loaders read one folder each, whatever slot the name is also the file of: LTX 2.3's one
      // checkpoint given to UNETLoader was counted in checkpoints, a pod had it there and was taken to have what the
      // graph loads, and UNETLoader found no such diffusion model (card #103, 2026-10-26)
      const fixed = FIXED_FOLDER[n.class_type]?.[0] === input ? FIXED_FOLDER[n.class_type]![1] : null;
      const named = bySlot.get(value);
      const slot = named && (!fixed || folders[named] === fixed) ? named : undefined;
      const folder = slot ? folders[slot]! : fixed ?? (isModelFile(value) ? folderOfFileInput(n.class_type, input) : null);
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
 * Slots whose file makes a render better, not different (RIFE: twice the frames; H3's latent upscaler, else a plain resize;
 * Face refine's person detector and SAM, else no head where no face is found and a paste over the face's box; Wan's SVI 2.0 Pro
 * LoRAs, else a continuation opens on the clip before's last frame, still; LTX 2.5's MSR LoRA, else the cast's pictures and
 * voice are left out, as words and LoRAs alone made the clip before). A rented pod is sent it for a job that
 * asks for it; a machine of the user's own without it still takes the job, renders without it, and the job says so: kept
 * off every such machine, an H3 clip with "RIFE ×2" on (the default) would wait for ever where no machine had RIFE.
 */
export const SOFT_SLOTS: ReadonlySet<string> = new Set(["rife", "latentUpscaler", "faceSeg", "faceSam", "sviHigh", "sviLow", "msr"]);

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

type ModelSlot = Pick<Family["slots"][number], "id" | "folder" | "optional" | "get">;
/** A slot's file as a machine's scan found it (null: none). */
type SlotFound = { id: string; file?: string | null };

/**
 * The family's files a job is built with on a machine, one name per slot: the machine's own file, else the family's
 * download, else this PC's (sent up from here); a required one with none of those is named by missingSlotFile, and only a
 * graph that reads it says so. An optional slot is there only as the machine has it, unless the recipe or this input asks
 * for it (`needs`, `needsWith`: Turbo's LoRAs, SAM with the Mask on), when it comes as a required one does. The Deploy
 * dialog and the pod's own check both name the slots so, so a slot is never fetched under two names. `own`: a machine of the
 * user's own, never asked a file its build does without there (Recipe.needsWith's `own`).
 */
export function podSlotFiles(
  recipe: Pick<Recipe<any>, "needs" | "needsWith" | "unneeded"> & { inputs?: readonly InputSpec[] }, input: Record<string, unknown>, slots: readonly ModelSlot[],
  there: readonly SlotFound[] | null, here: readonly SlotFound[] | null, own = false,
): Record<string, string> {
  const at = (list: readonly SlotFound[] | null, id: string) => list?.find((x) => x.id === id)?.file ?? null;
  const fill = (s: ModelSlot) => at(there, s.id) ?? s.get?.file ?? at(here, s.id) ?? missingSlotFile(s.id);
  const needs = neededSlots(recipe, input);
  const out: Record<string, string> = {};
  for (const s of slots) {
    if (!s.optional || needs.includes(s.id)) out[s.id] = fill(s);
    else if (at(there, s.id)) out[s.id] = at(there, s.id)!;
  }
  // what this input asks for, read against the files it is built with (a model made for few steps asks no turbo LoRA)
  for (const id of recipe.needsWith?.(input, out, { own }) ?? []) {
    const s = slots.find((x) => x.id === id);
    if (s && !out[id]) out[id] = fill(s);
  }
  return out;
}

/**
 * The slots a recipe cannot run without (Recipe.needs) that this input asks for: less the ones it does without
 * (Recipe.unneeded), and the ones a model input of its form picks another file for (InputSpec.slot: the pick is loaded in
 * the slot's place). Asked as needs, a fine-tune picked on Edit had a pod sent FLUX.1 Kontext beside it, and a swap's
 * Show the mask waited for the swap's model and LoRA, neither of which it loads (card #226).
 */
export function neededSlots(recipe: Pick<Recipe<any>, "needs" | "unneeded"> & { inputs?: readonly InputSpec[] }, input: Record<string, unknown>): string[] {
  if (!recipe.needs?.length) return [];
  const inputs = recipe.inputs ?? [];
  const picked = new Set(pickedFiles(inputs, input).map((m) => m.input));
  const without = new Set(recipe.unneeded?.(input as never) ?? []);
  return recipe.needs.filter((id) => !without.has(id) && !inputs.some((i) => i.type === "model" && i.slot === id && picked.has(i.id)));
}
