import { checkGraph, choicesOf, dryContext, folderOfFileInput, parseInput, sameFile, type Family, type NodeCatalog, type Recipe } from "@afflatus/core";
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

  const found = await Promise.all(
    families.map(async (f) => ({
      id: f.id,
      slots: await Promise.all(
        f.slots.map(async (s): Promise<SlotStatus> => {
          const list = await files(s.folder);
          const chosen = overrides[f.id]?.[s.id];
          const auto = detect(list, s.detect);
          const byHand = Boolean(chosen && list.includes(chosen));
          const patterns = s.detect.map((d) => new RegExp(d, "i"));
          return {
            id: s.id, label: s.label, folder: s.folder, optional: Boolean(s.optional), hint: s.hint, ...(s.get ? { get: s.get } : {}),
            file: byHand ? chosen! : auto, auto, chosen: byHand,
            choices: [...new Set([...list.filter((x) => patterns.some((re) => re.test(x))), ...(byHand ? [chosen!] : [])])],
          };
        }),
      ),
    })),
  );

  // a file that stands in for another way of having the model: with it, the files of the other way are not needed
  const familyStatus = found.map((f) => {
    const def = families.find((x) => x.id === f.id)!;
    const here = new Set(f.slots.filter((s) => s.file).map((s) => s.id));
    return { ...f, slots: f.slots.map((s) => { const unless = def.slots.find((x) => x.id === s.id)?.unless; return unless && here.has(unless) ? { ...s, optional: true } : s; }) };
  });

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
      const missingSlots = slots.filter((s) => (!s.optional || r.needs?.includes(s.id)) && !s.file).map((s) => s.id);

      const options: Record<string, string[]> = {};
      const emptyInputs: string[] = [];
      for (const input of r.inputs) {
        if (input.type === "model") {
          // quantized .gguf models sit in the same folders but are listed by the GGUF pack under its own name
          const all = input.folder === "diffusion_models" ? [...(await files(input.folder)), ...(await files("unet_gguf"))] : await files(input.folder);
          // what a form starts on comes first: the family's own file when the input stands for a slot
          const usual = input.slot ? slots.find((s) => s.id === input.slot)?.file : null;
          const fits = input.match ? all.filter((f) => input.match!.some((p) => new RegExp(p, "i").test(f))) : [];
          // a file that fills another slot of the family (H3's reference model) is used on its own when a clip
          // needs it: it is not a choice for this one
          const taken = input.slot ? slots.filter((s) => s.id !== input.slot && s.folder === input.folder && s.file && s.file !== usual).map((s) => s.file) : [];
          options[input.id] = [...new Set([...(usual ? [usual] : []), ...fits, ...all])].filter((f) => !taken.includes(f));
          // with a slot, a missing file is the slot's to report
          if (!options[input.id]!.length && !input.slot) emptyInputs.push(input.id);
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
      return {
        id: r.id, missingNodes, missingSlots, emptyInputs, missingFiles, missing, problems, limitedBy, options,
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
