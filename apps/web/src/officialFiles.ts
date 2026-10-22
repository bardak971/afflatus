import type { FamilyInfo, RecipeStatus } from "./api";

/** A family's official file, with its size when the server knows it. */
export interface Official {
  file: string;
  url: string;
  bytes: number | null;
}

/**
 * Whether two names are the same file at the same place, whatever the slash: ComfyUI on Windows lists "SDXL\\x.safetensors"
 * where a preset says "SDXL/x.safetensors". The whole path, not the bare name: the field, Generate and the form's
 * missing-model note all ask it, so a file elsewhere in a sub-folder is said missing by all three, not hidden by one.
 */
export const samePath = (a: string, b: string) => a.replace(/\\/g, "/") === b.replace(/\\/g, "/");

/** Whether a form's value is one of its family's official files (a slot's download), by its whole path: see samePath. */
export const isFamilyFile = (family: FamilyInfo | undefined, file: string) => Boolean(family?.slots?.some((s) => s.get && samePath(s.get.file, file)));

/** The folders whose files come with their model: never offered on their own (a VAE, a text encoder). */
const COME_WITH_MODEL = new Set(["vae", "text_encoders", "clip", "clip_vision"]);

/**
 * A family's official files for a model input, with their size when known: its slot's download when it stands for a slot,
 * else the family's downloads of that folder that no recipe alone uses. None for the files that come with their model.
 */
export function officialFiles(family: FamilyInfo | undefined, folder: string, slot: string | undefined, sizes?: Record<string, number>): Official[] {
  if (!family?.slots || COME_WITH_MODEL.has(folder)) return [];
  const slots = slot ? family.slots.filter((s) => s.id === slot) : family.slots.filter((s) => s.folder === folder && !s.onlyFor?.length);
  return slots.flatMap((s) => (s.get && s.folder === folder ? [{ file: s.get.file, url: s.get.url, bytes: sizes?.[s.get.url] ?? null }] : []));
}

/**
 * What a form starts from where its ComfyUI has nothing to pick for a model input (an empty one, a new install): the
 * family's official file, which the job then waits for (its Download here, or fetched by a pod). The lists the fields
 * show stay ComfyUI's own: only the start is taken from here.
 */
export function withOfficial<S extends { options: Record<string, string[]> } | undefined>(status: S, inputs: ReadonlyArray<{ id: string; type: string; folder?: string; slot?: string }>, family: FamilyInfo | undefined): S {
  if (!status || !family) return status;
  let options: Record<string, string[]> | null = null;
  for (const i of inputs) {
    if (i.type !== "model" || !i.folder || status.options[i.id]?.length) continue;
    const official = officialFiles(family, i.folder, i.slot);
    if (!official.length) continue;
    options ??= { ...status.options };
    options[i.id] = official.map((o) => o.file);
  }
  return options ? { ...status, options } : status;
}

/**
 * Whether a recipe here lacks only files that have an official download: its family's files not found (missingSlots), and
 * model inputs with nothing to pick (emptyInputs) that the family's official files fill. Nothing else (a node, a file of
 * an imported workflow, a problem): the job can wait for them where it runs, so the recipe is not "not ready".
 */
export function lacksOnlyFiles(status: Pick<RecipeStatus, "ready" | "missingNodes" | "missingSlots" | "emptyInputs" | "missingFiles" | "problems"> | undefined, recipe: { inputs: ReadonlyArray<{ id: string; type: string; folder?: string; slot?: string }> } | undefined, family: FamilyInfo | undefined): boolean {
  if (!status || status.ready || !recipe || !family) return false;
  if (status.missingNodes.length || status.missingFiles.length || status.problems?.length) return false;
  if (!status.missingSlots.length && !status.emptyInputs.length) return false;
  const slotComes = (id: string) => Boolean(family.slots?.find((s) => s.id === id)?.get);
  const inputComes = (id: string) => {
    const i = recipe.inputs.find((x) => x.id === id);
    return Boolean(i && i.type === "model" && i.folder && officialFiles(family, i.folder, i.slot).length);
  };
  return status.missingSlots.every(slotComes) && status.emptyInputs.every(inputComes);
}
