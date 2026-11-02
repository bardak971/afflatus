/**
 * The family files a recipe variant's graph loads against the ones a machine is sent for it before any build (card #226),
 * for check-graphs.ts and its test.
 */
import { neededSlots, pickedFiles, podSlotFiles, type BuildContext, type Recipe, type Variant } from "@afflatus/core";
import { familyById } from "@afflatus/recipes";

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

/**
 * What fileGaps does not report, each with why: a file a graph loads only where it is there by design, with nothing lost
 * without it, or one asked for on a route only the build can tell.
 */
const BY_DESIGN: Array<{ slot: string; way: "loads" | "asks"; recipe?: RegExp; when?: (input: Record<string, unknown>, v: Variant<any>) => boolean; why: string }> = [
  { slot: "tinyVae", way: "loads", why: "the live preview's decoder only: the render is the same without it" },
  { slot: "temporal", way: "loads", recipe: /^ltx/, when: (i) => i.smoothWith === "Auto", why: "Auto takes LTX's temporal upscaler only where its file is there, else RIFE (ltxRecipe's needsWith)" },
  { slot: "temporal", way: "asks", recipe: /^ltx/, when: (i) => Boolean(i.previous), why: "a clip that carries on may do so in the clip before's latent (RIFE) or not (the temporal upscaler): only its build knows, so both are asked" },
  { slot: "rife", way: "asks", recipe: /^ltx/, when: (i) => Boolean(i.previous), why: "the same: RIFE is asked for any clip that carries on" },
  { slot: "swapSam", way: "asks", recipe: /^h3\.swap$/, when: (_i, v) => Boolean(v.has), why: "an older node pack without the Swap Mask swaps unmasked; a pod has the image's pack" },
];
const byDesign = (recipe: Recipe<any>, v: Variant<any>, input: Record<string, unknown>, slot: string, way: "loads" | "asks") =>
  BY_DESIGN.some((b) => b.slot === slot && b.way === way && (!b.recipe || b.recipe.test(recipe.id)) && (!b.when || b.when(input, v)));
/** Every text a graph's nodes are given: the files it loads among them. */
const named = (graph: Graph) => new Set(Object.values(graph).flatMap((n) => Object.values(n.inputs)).filter((x): x is string => typeof x === "string"));

/**
 * The family files a variant's graph loads against the ones a machine is sent for it before any build (card #226): the
 * required slots, and the optional ones its needs and needsWith ask for (podSlotFiles, as the queue and Deploy read them).
 * Each time the two parted a pod was billed for a job that lacked a file: Turbo's LoRA (35f5fda5), a swap's latent
 * upscaler (blurred), Wan's SVI LoRAs (card #107); or one was asked for that the graph never loads, and a pod's job
 * failed on its absence (9e0d8a81).
 * - loads: built on a machine that has every file of its family (the variant's own names, else the download's), an
 *   optional slot's file its graph loads and its needs do not ask for: a pod builds it without, its render worse or refused;
 * - asks: built with what a fresh pod is sent (and, `own`, a machine of the user's own with the variant's files), an
 *   optional slot its needs ask for that its graph never loads: fetched for nothing, or waited for.
 */
export function fileGaps(recipe: Recipe<any>, v: Variant<any>, input: Record<string, unknown>, ctx: (slots: Record<string, string>) => BuildContext): string[] {
  const family = familyById(recipe.family);
  if (!family) return [];
  const optional = new Set(family.slots.filter((s) => s.optional).map((s) => s.id));
  const picked = new Set(pickedFiles(recipe.inputs, input).map((f) => f.file));
  const found = (slots: Record<string, string>) => Object.entries(slots).map(([id, file]) => ({ id, file }));
  const out: string[] = [];
  // a fresh pod's files with every optional one beside them, each optional file not named by the variant given a name of its
  // own (a default choice of the same name as a download is no read of its slot)
  const sent = podSlotFiles(recipe, input, family.slots, null, found(v.slots ?? {}));
  const every = { ...Object.fromEntries([...optional].map((id) => [id, v.slots?.[id] ?? `zz-${id}.safetensors`])), ...sent };
  const loads = named(recipe.build(input, ctx(every)).graph);
  for (const id of optional) if (loads.has(every[id]!) && !picked.has(every[id]!) && !sent[id] && !byDesign(recipe, v, input, id, "loads")) out.push(`loads ${every[id]} (${id}), which its needs do not ask for: a pod is never sent it`);
  for (const own of [false, true]) {
    const files = own ? podSlotFiles(recipe, input, family.slots, found(v.slots ?? {}), null, true) : podSlotFiles(recipe, input, family.slots, null, found(v.slots ?? {}));
    const asked = [...neededSlots(recipe, input), ...(recipe.needsWith?.(input, files, { own }) ?? [])].filter((id) => optional.has(id) && files[id]);
    const graph = named(recipe.build(input, ctx(files)).graph);
    for (const id of new Set(asked)) if (!graph.has(files[id]!) && !byDesign(recipe, v, input, id, "asks")) out.push(`${own ? "on a machine of the user's own, " : ""}its needs ask for ${files[id]} (${id}), which its graph never loads`);
  }
  return out;
}
