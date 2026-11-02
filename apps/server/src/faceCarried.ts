import type { Recipe, ReferenceValue } from "@afflatus/core";

/**
 * Whether a continuation carries the face on (card #223): it has the same person pictures as the render it carries on from.
 * H3 then samples it without them and draws the face towards them by Face refine (its recipe's faceCarried); a clip whose
 * person pictures changed is sampled with them, a new look being asked for there.
 */

/** A render as it was sent: its recipe and its form, the cast worked in. */
export interface Rendered {
  recipe: string;
  inputs: Record<string, unknown>;
}

/**
 * The library pictures a form gives as a person ("A person" references of its picture input, the cast's among them), in no
 * order and once each: the pictures the model is sent, whatever the cast chip picked or the clearest face put first.
 */
export function personPictures(recipe: Pick<Recipe<any>, "inputs"> | undefined, input: Record<string, unknown>): string[] {
  const spec = recipe?.inputs.find((i) => i.type === "references" && !i.media);
  const refs = spec && Array.isArray(input[spec.id]) ? (input[spec.id] as ReferenceValue[]) : [];
  return [...new Set(refs.filter((r) => r.role === "person").map((r) => r.asset))].sort();
}

/**
 * Whether a form gives the very person pictures another render gave (`before`, of its own recipe: a Lip sync clip after a
 * Video with audio one): the same set, not empty. Another picture, one more, one fewer, another person: not the same.
 */
export function sameFace(recipe: Pick<Recipe<any>, "inputs">, input: Record<string, unknown>, beforeRecipe: Pick<Recipe<any>, "inputs"> | undefined, before: Record<string, unknown>): boolean {
  const mine = personPictures(recipe, input);
  const theirs = personPictures(beforeRecipe, before);
  return mine.length > 0 && mine.length === theirs.length && mine.every((a, i) => a === theirs[i]);
}
