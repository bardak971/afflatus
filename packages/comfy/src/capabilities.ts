import { choicesOf, folderOfFileInput, parseInput, type Family, type NodeCatalog, type Recipe } from "@studai/core";
import type { ComfyClient, ComfyStatus } from "./client";

/**
 * What this ComfyUI can do, per family and per recipe. One answer, read by the setup page (what is
 * missing), the composer (what to offer and what to grey out) and the queue (a last check before sending).
 * Read-only: it never loads a model.
 */

export interface SlotStatus {
  id: string;
  label: string;
  folder: string;
  /** The file found for this slot, or null. */
  file: string | null;
  optional: boolean;
  hint: string;
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
  /** Node classes only some options need: those options are off, the recipe still runs. */
  limitedBy: string[];
  /** What each model / choice input offers on this ComfyUI (input id → options). */
  options: Record<string, string[]>;
}

export interface Scan {
  at: string;
  comfy: ({ online: true } & ComfyStatus & { url: string; nodes: number }) | { online: false; url: string; error: string };
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
export type SlotOverrides = Record<string, Record<string, string>>;

export async function scan(
  client: ComfyClient, families: Family[], recipes: Recipe<any>[], overrides: SlotOverrides = {},
): Promise<Scan> {
  const at = new Date().toISOString();
  let status: ComfyStatus;
  let catalog: NodeCatalog;
  try {
    [status, catalog] = await Promise.all([client.status(), client.catalog()]);
  } catch (err) {
    return { at, comfy: { online: false, url: client.baseUrl, error: (err as Error).message }, families: [], recipes: [] };
  }

  // each folder is listed once, whoever asks for it
  const listings = new Map<string, Promise<string[]>>();
  const files = (folder: string) => {
    let p = listings.get(folder);
    if (!p) {
      p = client.models(folder).catch(() => [] as string[]);
      listings.set(folder, p);
    }
    return p;
  };

  const familyStatus = await Promise.all(
    families.map(async (f) => ({
      id: f.id,
      slots: await Promise.all(
        f.slots.map(async (s): Promise<SlotStatus> => {
          const list = await files(s.folder);
          const chosen = overrides[f.id]?.[s.id];
          return {
            id: s.id, label: s.label, folder: s.folder, optional: Boolean(s.optional), hint: s.hint,
            file: chosen && list.includes(chosen) ? chosen : detect(list, s.detect),
          };
        }),
      ),
    })),
  );

  const has = (cls: string) => cls in catalog;
  const recipeStatus = await Promise.all(
    recipes.map(async (r): Promise<RecipeStatus> => {
      // the first variant is the recipe's plainest form; the others exercise its options
      const nodeSets = r.variants.map((v) => r.nodes(parseInput(r, v.input)));
      const base = nodeSets[0] ?? [];
      const missingNodes = base.filter((n) => !has(n));
      // what only some options need, and the extras the recipe takes when they are there: without them it still runs
      const limitedBy = [...new Set([...nodeSets.flat(), ...(r.optionalNodes ?? [])])].filter((n) => !has(n) && !base.includes(n));
      const slots = familyStatus.find((f) => f.id === r.family)?.slots ?? [];
      const missingSlots = slots.filter((s) => !s.optional && !s.file).map((s) => s.id);

      const options: Record<string, string[]> = {};
      const emptyInputs: string[] = [];
      for (const input of r.inputs) {
        if (input.type === "model") {
          options[input.id] = await files(input.folder);
          if (!options[input.id]!.length) emptyInputs.push(input.id);
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
      const absent = (r.files ?? []).filter((f) => {
        const def = catalog[f.classType];
        const choices = choicesOf(def?.input.required?.[f.input] ?? def?.input.optional?.[f.input]);
        // no list to compare with means it cannot be said to be missing
        return choices !== null && choices.length > 0 && !choices.includes(f.file);
      });
      const missingFiles = [...new Set(absent.map((f) => f.file))];
      const missing = missingFiles.map((file) => {
        const f = absent.find((x) => x.file === file)!;
        return { file, folder: folderOfFileInput(f.classType, f.input), ...(f.url ? { url: f.url } : {}) };
      });
      return {
        id: r.id, missingNodes, missingSlots, emptyInputs, missingFiles, missing, limitedBy, options,
        ready: !missingNodes.length && !missingSlots.length && !emptyInputs.length && !missingFiles.length,
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
