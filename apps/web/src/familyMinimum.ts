import type { RecipeInfo, Scan } from "./api";
import { size } from "./format";

/** One of a family's files, as a ComfyUI has it (the setup scan's slot). */
type Slot = Scan["families"][number]["slots"][number];

/**
 * The operation a family's minimum is for: its first one offered, the most basic of what it makes (Text to picture for
 * the image families, Video with audio for H3, Motion transfer for SCAIL). The recipes list each family's in that order.
 */
export const firstOperation = <R extends Pick<RecipeInfo, "hidden" | "imported">>(recipes: readonly R[]): R | undefined =>
  recipes.find((r) => !r.hidden && !r.imported) ?? recipes.find((r) => !r.hidden);

/**
 * A slot another way of having the model makes unneeded, that other way being the one fetched (LTX 2.3: one checkpoint,
 * or a diffusion model, two VAEs and a projection). With neither here, the scan says both ways are needed, and "Download
 * all" fetched the checkpoint and the split VAEs together; the way with an official download is the one kept. A split
 * file already here keeps its way: the checkpoint is then the optional one (the scan's own rule).
 */
export function otherWay(s: Pick<Slot, "unless">, slots: readonly Pick<Slot, "id" | "optional" | "file" | "get">[]): boolean {
  if (!s.unless) return false;
  const other = slots.find((x) => x.id === s.unless);
  return Boolean(other && !other.optional && (other.file || other.get));
}

/**
 * The slots a family's first operation cannot run without: its files that are not optional, and the optional ones it
 * needs itself (core's Recipe.needs), the other way of having the model left out. What "Get the minimum" fetches: H3's
 * Video with audio never brings Swap's reference model and LoRA, which only Swap needs.
 */
export function minimumSlots<S extends Pick<Slot, "id" | "optional" | "file" | "get" | "unless">>(slots: readonly S[], first: Pick<RecipeInfo, "needs"> | undefined): S[] {
  if (!first) return [];
  return slots.filter((s) => (!s.optional || first.needs?.includes(s.id)) && !otherWay(s, slots));
}

/**
 * What files weigh, as said beside a fetch: the sum of the sizes known ("31.8 GB"), a "+" when some are not known yet
 * (asked in the background, never with lookups off), nothing when none is. Never a guess.
 */
export function sizeSaid(urls: ReadonlyArray<string | undefined>, sizes: Readonly<Record<string, number>> | undefined): string {
  const known = urls.map((u) => (u ? sizes?.[u] ?? 0 : 0));
  const bytes = known.reduce((n, b) => n + b, 0);
  if (!bytes) return "";
  return `${size(bytes)}${known.some((b) => !b) ? "+" : ""}`;
}

/**
 * What an optional file is for, in a few words, from what its line already says: "for Face refine" from "For Face
 * refine, 52 MB: …", or the operations it alone serves (onlyFor); null when its hint is the only way to say it.
 */
export function forSaid(hint: string, only: readonly string[] = []): string | null {
  const said = /^(?:optional[:,]\s*)?for ([^:,.(]+)[:,.]/i.exec(hint)?.[1]?.trim();
  if (said && said.length <= 32) return `for ${said}`;
  return only.length ? `for ${only.join(", ")} only` : null;
}
