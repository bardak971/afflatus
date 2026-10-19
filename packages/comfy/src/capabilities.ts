import { checkGraph, choicesOf, dryContext, slotsRead, folderOfFileInput, parseInput, sameBase, sameFile, type Family, type ModelInfo, type NodeCatalog, type Recipe } from "@afflatus/core";
import { catalogKey, ComfyLocked, type ComfyClient, type ComfyStatus } from "./client";

/**
 * What this ComfyUI can do, per family and per recipe. One answer, read by the setup page (what is
 * missing), the composer (what to offer and what to grey out) and the queue (a last check before sending).
 * Read-only: it never loads a model.
 */

interface SlotStatus {
  id: string;
  label: string;
  folder: string;
  /** The file found for this slot, or null. */
  file: string | null;
  /** Every file of the folder that fits the slot's patterns: what can be chosen by hand. */
  choices: string[];
  /** The file its patterns would pick on their own (the choice when nothing is set by hand). */
  auto: string | null;
  /** `file` was chosen by hand (Settings). */
  chosen: boolean;
  optional: boolean;
  hint: string;
  /** Where its usual file can be had, when the family says. */
  get?: { file: string; url: string };
}

export interface RecipeStatus {
  id: string;
  /** The plain form of the recipe can run. */
  ready: boolean;
  /** Node classes its plain form needs and ComfyUI lacks. */
  missingNodes: string[];
  /** Required family files that were not found (slot ids). */
  missingSlots: string[];
  /** Model inputs whose folder is empty (input ids): there is nothing to pick. */
  emptyInputs: string[];
  /** Files the recipe names itself (an imported workflow's models) that ComfyUI does not list. */
  missingFiles: string[];
  /** The same files with what is known about each: the folder it belongs in, and an address when its author gave one. */
  missing: Array<{ file: string; folder: string | null; url?: string }>;
  /** What ComfyUI would refuse in its plain form, in the checker's words: a choice it does not offer, an input it does not know. */
  problems: string[];
  /** Node classes only some options need: those options are off, the recipe still runs. */
  limitedBy: string[];
  /** What each model / choice input offers on this ComfyUI (input id → options). */
  options: Record<string, string[]>;
  /** The files its family's slots use here (slot id → file): the form starts some settings by them (Recipe.starts). */
  slots?: Record<string, string>;
}

export interface Scan {
  at: string;
  /** Offline: `locked` when it answered, but Afflatus's node pack refused the token (a token to paste, not a ComfyUI to start). */
  comfy: ({ online: true } & ComfyStatus & { url: string; nodes: number }) | { online: false; url: string; error: string; locked?: boolean };
  families: Array<{ id: string; slots: SlotStatus[] }>;
  recipes: RecipeStatus[];
}

/** The first file of a folder matching one of the patterns, tried in order. */
export function detect(files: string[], patterns: string[]): string | null {
  for (const p of patterns) {
    const re = new RegExp(p, "i");
    const hit = files.find((f) => re.test(f));
    if (hit) return hit;
  }
  return null;
}

/** Slots can be set by hand (the setup page): family id → slot id → file. A file that is gone is ignored. */
type SlotOverrides = Record<string, Record<string, string>>;

/** What is known of a file from its header (folder, file → info), when it was read: a file whose weights say which model it is for fits that family whatever its name. */
export type InfoLookup = (folder: string, file: string) => ModelInfo | undefined;

/** A folder's files, listed once whoever asks. */
type Files = (folder: string) => Promise<string[]>;

/**
 * The model folders whose .gguf files ComfyUI does not list (its lists hold only the extensions its own loaders read): the
 * ComfyUI-GGUF pack lists them under a name of its own, the same files of the same folder.
 */
export const GGUF_LISTS: Readonly<Record<string, string>> = { diffusion_models: "unet_gguf", text_encoders: "clip_gguf" };
type FamilyStatus = Scan["families"][number];

/**
 * Each family's slots: the file found for each (by hand, by name, or by what its weights say), what can be
 * chosen, and the slots another one makes unneeded.
 */
async function slotFiles(families: Family[], files: Files, overrides: SlotOverrides, infoOf: InfoLookup, shown: Set<string>): Promise<FamilyStatus[]> {
  const found = await Promise.all(
    families.map(async (f) => ({
      id: f.id,
      slots: await Promise.all(
        f.slots.map(async (s): Promise<SlotStatus> => {
          const list = await files(s.folder);
          const chosen = overrides[f.id]?.[s.id];
          // a file whose weights say they are this family's fits the slot whatever it is called (only the main model's folders: a VAE or a text encoder says nothing of a family)
          const byWeights = s.folder === "diffusion_models" || s.folder === "checkpoints" ? list.filter((x) => sameBase(infoOf(s.folder, x)?.base, f.name)) : [];
          const auto = detect(list, s.detect) ?? byWeights[0] ?? null;
          const byHand = Boolean(chosen && list.includes(chosen));
          const patterns = s.detect.map((d) => new RegExp(d, "i"));
          // a file only hidden recipes use is not offered for download: what it is for cannot be opened
          const offered = s.get && (!s.onlyFor || s.onlyFor.some((id) => shown.has(id)));
          return {
            id: s.id, label: s.label, folder: s.folder, optional: Boolean(s.optional), hint: s.hint, ...(offered ? { get: s.get } : {}),
            file: byHand ? chosen! : auto, auto, chosen: byHand,
            choices: [...new Set([...list.filter((x) => patterns.some((re) => re.test(x))), ...byWeights, ...(byHand ? [chosen!] : [])])],
          };
        }),
      ),
    })),
  );

  // a file that stands in for another way of having the model: with it, the files of the other way are not needed
  return found.map((f) => {
    const def = families.find((x) => x.id === f.id)!;
    const here = new Set(f.slots.filter((s) => s.file).map((s) => s.id));
    return { ...f, slots: f.slots.map((s) => { const unless = def.slots.find((x) => x.id === s.id)?.unless; return unless && here.has(unless) ? { ...s, optional: true } : s; }) };
  });
}

/** What each model and choice input of a recipe offers on this ComfyUI, and the inputs left with nothing to pick. */
async function recipeChoices(
  r: Recipe<any>, families: Family[], slots: SlotStatus[], files: Files, catalog: NodeCatalog, infoOf: InfoLookup,
): Promise<{ options: Record<string, string[]>; emptyInputs: string[] }> {
  const options: Record<string, string[]> = {};
  const emptyInputs: string[] = [];
  for (const input of r.inputs) {
    if (input.type === "model") {
      // quantized .gguf models sit in the same folders but are listed by the GGUF pack under its own name
      // (diffusion models only: no recipe loads a .gguf text encoder)
      const all = input.folder === "diffusion_models" ? [...(await files(input.folder)), ...(await files(GGUF_LISTS.diffusion_models!))] : await files(input.folder);
      // what a form starts on comes first: the family's own file when the input stands for a slot
      const usual = input.slot ? slots.find((s) => s.id === input.slot)?.file : null;
      const family = families.find((x) => x.id === r.family);
      const named = input.match ? all.filter((f) => input.match!.some((p) => new RegExp(p, "i").test(f))) : [];
      // then the files whose weights say they are this family's; a file known to be another family's goes last
      const byWeights = family ? all.filter((f) => !named.includes(f) && sameBase(infoOf(input.folder, f)?.base, family.name)) : [];
      const foreign = family ? all.filter((f) => { const b = infoOf(input.folder, f)?.base; return Boolean(b) && !named.includes(f) && !byWeights.includes(f) && !sameBase(b, family.name); }) : [];
      const fits = [...named, ...byWeights];
      // a file that fills another slot of the family (H3's reference model) is used on its own when a clip
      // needs it: it is not a choice for this one. A slot of one recipe's own (Swap's model) is that recipe's choice
      // among all of them: the family's video model included (a hybrid turbo fine-tune, 2026-10-17)
      const own = family?.slots.find((s) => s.id === input.slot);
      const taken = input.slot && !own?.onlyFor ? slots.filter((s) => s.id !== input.slot && s.folder === input.folder && s.file && s.file !== usual).map((s) => s.file) : [];
      options[input.id] = [...new Set([...(usual ? [usual] : []), ...fits, ...all.filter((f) => !foreign.includes(f)), ...foreign])].filter((f) => !taken.includes(f));
      // with a slot, a missing file is the slot's to report; with a file of its own (an imported workflow's), the list is not needed
      if (!options[input.id]!.length && !input.slot && !input.default) emptyInputs.push(input.id);
    } else if (input.type === "loras") {
      // every LoRA for now: sorting them by the family they fit needs their metadata, which is read later
      options[input.id] = await files("loras");
    } else if (input.type === "choice" && !Array.isArray(input.options)) {
      const def = catalog[input.options.node];
      const spec = def?.input.required?.[input.options.input] ?? def?.input.optional?.[input.options.input];
      options[input.id] = [...(input.extra ?? []), ...(choicesOf(spec) ?? [])];
      // a choice among files (an upscale model, a face finder): with none of them there, it cannot run
      if (input.prefer && !input.showWhen && def && !options[input.id]!.length) emptyInputs.push(input.id);
    }
  }
  return { options, emptyInputs };
}

type Readiness = Pick<RecipeStatus, "missingNodes" | "limitedBy" | "missingFiles" | "missing" | "problems">;

/** Whether a recipe's plain form can run here: the nodes and the files it lacks, and what the checker says of it built. */
function recipeReadiness(r: Recipe<any>, catalog: NodeCatalog): Readiness {
  const has = (cls: string) => cls in catalog;
  // the first variant is the recipe's plainest form; the others exercise its options
  const nodeSets = r.variants.map((v) => r.nodes(parseInput(r, v.input)));
  const base = nodeSets[0] ?? [];
  const missingNodes = base.filter((n) => !has(n));
  // what only some options need, and the extras the recipe takes when they are there: without them it still runs
  const limitedBy = [...new Set([...nodeSets.flat(), ...(r.optionalNodes ?? [])])].filter((n) => !has(n) && !base.includes(n));
  const absent = (r.files ?? []).filter((f) => {
    const def = catalog[f.classType];
    const choices = choicesOf(def?.input.required?.[f.input] ?? def?.input.optional?.[f.input]);
    // no list to compare with means it cannot be said to be missing; the same file in another sub-folder is not missing
    return choices !== null && choices.length > 0 && !sameFile(choices, f.file);
  });
  const missingFiles = [...new Set(absent.map((f) => f.file))];
  const missing = missingFiles.map((file) => {
    const f = absent.find((x) => x.file === file)!;
    return { file, folder: folderOfFileInput(f.classType, f.input), ...(f.url ? { url: f.url } : {}) };
  });
  // its plainest form, built and checked like a render would be: a choice this ComfyUI does not offer shows here, not at render time
  let problems: string[] = [];
  const plain = r.variants[0];
  if (plain && !missingNodes.length) {
    try {
      const built = r.build(parseInput(r, plain.input), dryContext({ slots: plain.slots ?? {}, uploads: plain.uploads ?? {}, media: plain.media ?? {}, canvas: plain.canvas, has }));
      problems = checkGraph(built, catalog).slice(0, 4);
    } catch (err) {
      problems = [(err as Error).message.slice(0, 200)];
    }
  }
  return { missingNodes, limitedBy, missingFiles, missing, problems };
}

/** As recipeReadiness, for a recipe that cannot even say what it needs (a saved workflow gone wrong): not ready, and why. */
function readinessOrWhy(r: Recipe<any>, catalog: NodeCatalog): Readiness {
  try {
    return recipeReadiness(r, catalog);
  } catch (err) {
    return { missingNodes: [], limitedBy: [], missingFiles: [], missing: [], problems: [(err as Error).message.slice(0, 200)] };
  }
}

/**
 * Each recipe's readiness on a node list, kept for the last few lists by the list's hash (client.ts catalogKey): it depends
 * on the list alone, building and checking every recipe costs most of a scan, and several machines with the same nodes and
 * files (pods from one image) send the same list. A recipe changed is a new object, so it is worked out again.
 */
const readinessKept = new Map<unknown, WeakMap<Recipe<any>, Readiness>>();
const KEPT_LISTS = 16;
function keptFor(catalog: NodeCatalog): WeakMap<Recipe<any>, Readiness> {
  const key = catalogKey(catalog) ?? catalog;
  let kept = readinessKept.get(key);
  if (kept) readinessKept.delete(key);
  else kept = new WeakMap();
  // the last one used goes to the end: the oldest goes first
  readinessKept.set(key, kept);
  if (readinessKept.size > KEPT_LISTS) readinessKept.delete(readinessKept.keys().next().value);
  return kept;
}

/** Every recipe's readiness on this node list; what is worked out anew is done a slice at a time, so that requests are answered meanwhile. */
async function readinessOf(recipes: Recipe<any>[], catalog: NodeCatalog): Promise<Map<Recipe<any>, Readiness>> {
  const kept = keptFor(catalog);
  const out = new Map<Recipe<any>, Readiness>();
  let since = performance.now();
  for (const r of recipes) {
    let got = kept.get(r);
    if (!got) {
      got = readinessOrWhy(r, catalog);
      // kept before the turn is given up: another machine's scan of the same list finds it done
      kept.set(r, got);
      if (performance.now() - since > YIELD_MS) {
        await new Promise((go) => setImmediate(go));
        since = performance.now();
      }
    }
    out.set(r, got);
  }
  return out;
}
/** The longest the readiness work holds the event loop before it lets other work in. */
const YIELD_MS = 10;

/**
 * What this ComfyUI can do now. `catalogOf` gives its node list: a kept one (the server's Comfy.catalog) spares the fetch
 * of several MB and, with readinessOf, the rebuild of every recipe; its model folders are always listed afresh.
 */
export async function scan(
  client: ComfyClient, families: Family[], recipes: Recipe<any>[], overrides: SlotOverrides = {}, infoOf: InfoLookup = () => undefined,
  catalogOf: () => Promise<NodeCatalog> = () => client.catalog(),
): Promise<Scan> {
  const at = new Date().toISOString();
  let status: ComfyStatus;
  let catalog: NodeCatalog;
  try {
    [status, catalog] = await Promise.all([client.status(), catalogOf()]);
  } catch (err) {
    return { at, comfy: { online: false, url: client.baseUrl, error: (err as Error).message, ...(err instanceof ComfyLocked ? { locked: true } : {}) }, families: [], recipes: [] };
  }

  // each folder is listed once, whoever asks for it
  const listings = new Map<string, Promise<string[]>>();
  const files: Files = (folder) => {
    let p = listings.get(folder);
    if (!p) {
      p = client.models(folder).catch(() => [] as string[]);
      listings.set(folder, p);
    }
    return p;
  };

  const familyStatus = await slotFiles(families, files, overrides, infoOf, new Set(recipes.filter((r) => !r.hidden).map((r) => r.id)));
  const readiness = await readinessOf(recipes, catalog);
  const recipeStatus = await Promise.all(
    recipes.map(async (r): Promise<RecipeStatus> => {
      const slots = familyStatus.find((f) => f.id === r.family)?.slots ?? [];
      // a slot none of its variants reads is not missing for it, whatever the family needs (a swap runs its own model, never
      // the family's video model; SDXL's checkpoint is picked per render)
      const required = slots.filter((s) => !s.optional || r.needs?.includes(s.id));
      const read = slotsRead(r, required.map((s) => s.id));
      const missingSlots = required.filter((s) => read.has(s.id) && !s.file).map((s) => s.id);
      const { options, emptyInputs } = await recipeChoices(r, families, slots, files, catalog, infoOf);
      // a recipe that cannot even say what it needs (a saved workflow gone wrong) is not ready, and says why; the others are still scanned
      const { missingNodes, limitedBy, missingFiles, missing, problems } = readiness.get(r)!;
      return {
        id: r.id, missingNodes, missingSlots, emptyInputs, missingFiles, missing, problems, limitedBy, options,
        slots: Object.fromEntries(slots.filter((s) => s.file).map((s) => [s.id, s.file!])),
        ready: !missingNodes.length && !missingSlots.length && !emptyInputs.length && !missingFiles.length && !problems.length,
      };
    }),
  );

  return {
    at,
    comfy: { online: true, url: client.baseUrl, nodes: Object.keys(catalog).length, ...status },
    families: familyStatus,
    recipes: recipeStatus,
  };
}
