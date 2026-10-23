import { EITHER_PACKS, packOfNode, parseInput, type InputSpec, type NodeCatalog, type Recipe } from "@afflatus/core";
import { cannotWhy, lookAhead, packOfWant, type PackFacts } from "./jobPacks";
import type { QueueCore } from "./queueModel";
import { builtOf, withMedia } from "./queueSubmit";

/**
 * What a form says under an option whose node pack the machine it renders on lacks (the owner, 2026-10-20): the pack, that
 * it is installed on first use (or that the queue asks first), or why it cannot be and what the render does instead. It
 * never changes the option. Worked out as the queue will (jobPacks.ts): the form built with every option given the node
 * its pack brings; a node the form cannot run without (the GGUF loader) is tied to the input that pulls it in by building
 * the form's node list again with that input at its default.
 */
export interface FormPackNote {
  /** The input it is said under; null for what no single input pulls in (said at the top of the form). */
  input: string | null;
  pack: string;
  /** Packs that stand in for each other, as said ("NVIDIA's pack or DaSiWa's"), when the option takes either. */
  either?: string;
  /** "comes": installed on first use (or asked first); "cannot": done without, or it cannot render there. */
  state: "comes" | "cannot";
  why?: string;
  /** What the render is without it, and what it does instead; absent for a node it cannot run without. */
  without?: string;
  instead?: string;
  /** The other machines that have it. */
  has?: string[];
}

export async function formPacks(
  core: QueueCore, recipe: Recipe<any>, raw: Record<string, unknown>,
  on: { catalog: NodeCatalog; facts: PackFacts }, others: ReadonlyArray<{ label: string; catalog: NodeCatalog }>,
): Promise<FormPackNote[]> {
  const notes: FormPackNote[] = [];
  const hasIt = (nodes: readonly string[]) => others.filter((o) => nodes.some((n) => n in o.catalog)).map((o) => o.label);
  const withHas = (nodes: readonly string[]) => (hasIt(nodes).length ? { has: hasIt(nodes) } : {});
  const eitherOf = (nodes: readonly string[]) => EITHER_PACKS.find((e) => e.nodes.join() === nodes.join())?.said;
  // the options: built as the queue looks ahead (a form not complete enough to build says nothing of them)
  const ahead = lookAhead(on.catalog, on.facts);
  await builtOf(core, recipe.id, raw, { catalog: on.catalog, wants: ahead.wants }).catch(() => null);
  for (const w of ahead.missing) {
    const pack = packOfWant(w);
    if (!pack) continue;
    const either = eitherOf(w.nodes);
    notes.push({ input: w.input, pack, ...(either ? { either } : {}), state: "comes", without: w.without, ...(w.instead ? { instead: w.instead } : {}), ...withHas(w.nodes) });
  }
  for (const { w, why } of ahead.skipped) {
    const pack = packOfWant(w);
    if (!pack) continue;
    const either = eitherOf(w.nodes);
    notes.push({ input: w.input, pack, ...(either ? { either } : {}), state: "cannot", why, without: w.without, ...(w.instead ? { instead: w.instead } : {}), ...withHas(w.nodes) });
  }
  // the nodes it cannot run without, each with the input that pulls it in when one does
  let input: Record<string, unknown>;
  try {
    // a form without its media yet (Lip sync with no recording) is read with its settings all the same: they pull the nodes in
    input = parseInput(recipe, withMedia(recipe, raw)) as Record<string, unknown>;
  } catch {
    return notes;
  }
  const lacked = recipe.nodes(input).filter((n) => !(n in on.catalog));
  const inputs = (recipe.inputs as InputSpec[]).filter((spec) => "default" in spec && spec.default !== undefined && JSON.stringify(input[spec.id]) !== JSON.stringify(spec.default));
  const pulledBy = (node: string) => inputs.find((spec) => {
    try {
      return !recipe.nodes({ ...input, [spec.id]: (spec as { default: unknown }).default }).includes(node);
    } catch {
      return false;
    }
  })?.id ?? null;
  for (const node of lacked) {
    const pack = packOfNode(node);
    if (!pack || pack.own || notes.some((n) => n.pack === pack.name)) continue;
    const why = cannotWhy(on.facts, pack.name);
    notes.push({ input: pulledBy(node), pack: pack.name, state: why ? "cannot" : "comes", ...(why ? { why } : {}), ...withHas([node]) });
  }
  return notes;
}
