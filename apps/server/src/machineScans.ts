import type { RecipeStatus, Scan } from "@afflatus/comfy";
import type { LoraValue, Recipe } from "@afflatus/core";
import type { Machine, Settings } from "./settings";

/**
 * Whether a family is on for one machine: switched there by hand, else by the switch of every machine, else by its files
 * there (`found`: one of its recipes is ready on it). The same rule as the page's (web machines.ts familyOnFor).
 */
export function familyOn(settings: Pick<Settings, "families">, machine: Pick<Machine, "families">, family: string, found: boolean): boolean {
  return machine.families[family] ?? settings.families[family] ?? found;
}

/** Whether a family has a recipe ready in a machine's scan. */
const foundIn = (scan: Scan, family: string, recipeFamily: (id: string) => string | undefined) =>
  scan.recipes.some((r) => r.ready && recipeFamily(r.id) === family);

/** A list of what the inputs offer, each file once, in the order the machines list them. */
function union(lists: Array<Record<string, string[]>>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const list of lists) for (const [k, v] of Object.entries(list)) out[k] = [...new Set([...(out[k] ?? []), ...v])];
  return out;
}

/**
 * What every machine together can do, for the lists to choose from (Studio, a clip's model): a recipe is ready when it is
 * ready on a machine where its family is on, and offers the files of all of those machines; one ready nowhere says what the
 * first machine where it is on lacks. A family's files are those of the first machine that has them all. ComfyUI's state is
 * the first machine's that answers. One machine: its own scan, unchanged.
 */
export function mergeScans(scans: Array<{ machine: Machine; scan: Scan }>, settings: Pick<Settings, "families">, recipeFamily: (id: string) => string | undefined): Scan {
  const online = scans.filter((x) => x.scan.comfy.online);
  if (scans.length === 1 || online.length === 0) return scans[0]!.scan;
  if (online.length === 1) return online[0]!.scan;
  const base = online[0]!.scan;
  const onFor = (family: string) => online.filter((x) => familyOn(settings, x.machine, family, foundIn(x.scan, family, recipeFamily)));
  const recipes = base.recipes.map((r): RecipeStatus => {
    const family = recipeFamily(r.id);
    const where = family ? onFor(family) : online;
    const statuses = where.map((x) => x.scan.recipes.find((y) => y.id === r.id)).filter((y): y is RecipeStatus => Boolean(y));
    const ready = statuses.filter((y) => y.ready);
    if (!ready.length) return statuses[0] ?? r;
    return { ...ready[0]!, options: union(ready.map((y) => y.options)) };
  });
  const families = base.families.map((f) => {
    const whole = onFor(f.id).map((x) => x.scan.families.find((y) => y.id === f.id)).find((y) => y && y.slots.every((s) => s.optional || s.file));
    return whole ?? f;
  });
  return { ...base, recipes, families };
}

/** The model files and LoRAs a job asks for, by input, with the folder each goes in: what a machine must list for the job to run there. */
function filesAsked(recipe: Pick<Recipe<any>, "inputs">, input: Record<string, unknown>): Array<{ input: string; file: string; folder: string }> {
  return recipe.inputs.flatMap((i) => {
    const v = input[i.id];
    if (i.type === "model" && typeof v === "string" && v) return [{ input: i.id, file: v, folder: i.folder }];
    if (i.type === "loras" && Array.isArray(v)) return (v as LoraValue[]).filter((l) => l?.file).map((l) => ({ input: i.id, file: l.file, folder: "loras" }));
    return [];
  });
}

/** What keeps a job off a machine: its family switched off there, and the files it lacks there (with where to get each, when known). */
export interface Lack {
  off: boolean;
  files: Array<{ file: string; folder: string; url?: string }>;
  /**
   * The files are all it lacks there: with them in its folders, it runs (no node missing, nothing else refused, no other
   * input with nothing to pick). A rented pod can be sent them (podFiles.ts).
   */
  onlyFiles: boolean;
  /** A rented pod whose RunPod balance runs out before this job would end there: how long it lasts, how long the job takes (ms). */
  balance?: { leftMs: number; needMs: number };
}

/**
 * What keeps a job off a machine, from that machine's scan, or null when it can run there: its recipe ready there, its
 * family on there, and the model files and LoRAs it asks for in that machine's lists (an input the scan does not list is
 * not held against it). A recipe not ready for another reason (a custom node missing) lacks no file but is kept off all the same.
 */
export function lackOn(recipe: Pick<Recipe<any>, "id" | "family" | "inputs">, input: Record<string, unknown>, scan: Scan, settings: Pick<Settings, "families">, machine: Pick<Machine, "families">, recipeFamily: (id: string) => string | undefined): Lack | null {
  const status = scan.recipes.find((r) => r.id === recipe.id);
  const on = familyOn(settings, machine, recipe.family, foundIn(scan, recipe.family, recipeFamily));
  // "off" is said only of a family switched off by hand (there, or on every machine): one off because its files are not
  // there is said by the files it lacks
  const off = !on && (machine.families[recipe.family] ?? settings.families[recipe.family]) === false;
  const wanted = filesAsked(recipe, input);
  const asked = wanted.filter(({ input: id, file }) => status?.options[id] && !status.options[id]!.includes(file));
  if (status?.ready && on && !asked.length) return null;
  const slots = scan.families.find((f) => f.id === recipe.family)?.slots ?? [];
  const files = [
    ...slots.filter((x) => status?.missingSlots.includes(x.id) && x.get).map((x) => ({ file: x.get!.file, folder: x.folder, url: x.get!.url })),
    ...(status?.missing ?? []).flatMap((m) => (m.folder ? [{ file: m.file, folder: m.folder, ...(m.url ? { url: m.url } : {}) }] : [])),
    ...asked.map(({ file, folder }) => ({ file, folder })),
  ];
  const unique = files.filter((f, i) => files.findIndex((g) => g.file === f.file && g.folder === f.folder) === i);
  // with these files there it runs: a family file missing is one of them (its usual file) or the file of an input that
  // stands for it, an input with nothing to pick is filled by a file it asks for (any other, a choice among files no job
  // names, is not), and nothing else keeps it from running. A family switched off by hand is never sent files.
  const filled = new Set(wanted.map((w) => w.input));
  const slotFilled = (id: string) => slots.some((x) => x.id === id && x.get) || recipe.inputs.some((i) => i.type === "model" && i.slot === id && filled.has(i.id));
  const onlyFiles = Boolean(status) && !off && unique.length > 0 && !status!.missingNodes.length && !status!.problems.length
    && status!.emptyInputs.every((id) => filled.has(id)) && status!.missingSlots.every(slotFilled);
  return { off, files: unique, onlyFiles };
}
