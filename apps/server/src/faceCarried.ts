import type { Recipe, ReferenceValue } from "@afflatus/core";
import { toRun, type Db } from "./db";
import type { Look } from "./entities";

/**
 * Whether a continuation carries the face on (card #223): it has the same person as the render it carries on from. H3 then
 * samples it without their pictures and draws the face towards them by Face refine (its recipe's faceCarried); a clip whose
 * person changed is sampled with them, a new look being asked for there.
 */

/** A render as it was sent: its recipe, its form with the cast worked in, and the look it was sent with (its job's). */
export interface Rendered {
  recipe: string;
  inputs: Record<string, unknown>;
  look: Look | null;
}

/** Whose each Prompt kit person's picture is: the picture's id to the person's. One read for many forms. */
export async function pictureOwners(db: Db): Promise<Map<string, string>> {
  const people = await db.selectFrom("entities").select(["id", "def"]).where("kind", "=", "person").orderBy("created_at").execute();
  const owners = new Map<string, string>();
  for (const p of people) {
    const pictures = (JSON.parse(p.def) as { pictures?: unknown }).pictures;
    for (const asset of Array.isArray(pictures) ? pictures : []) if (typeof asset === "string" && !owners.has(asset)) owners.set(asset, p.id);
  }
  return owners;
}

/**
 * Who a form gives as a person ("A person" references of its picture input, the cast's among them), in no order and once
 * each: a Prompt kit person by their id and the picture picked on their chip (none: their clearest face), any other picture
 * by itself. Not the pictures sent: compose sends a cast person's first few, clearest face first, and which ones changed as
 * the faces were read or a picture was added (card #231), while nothing the user did changed.
 */
export function faceOf(recipe: Pick<Recipe<any>, "inputs"> | undefined, input: Record<string, unknown>, look: Look | null | undefined, owners: ReadonlyMap<string, string>): string[] {
  const spec = recipe?.inputs.find((i) => i.type === "references" && !i.media && !i.noCast);
  const refs = spec && Array.isArray(input[spec.id]) ? (input[spec.id] as ReferenceValue[]) : [];
  // (a pick no longer theirs is left aside, as compose leaves it)
  const picked = (who: string) => {
    const pick = look?.cast.find((c) => c.id === who)?.picture;
    return pick && owners.get(pick) === who ? pick : "";
  };
  return [...new Set(refs.filter((r) => r.role === "person").map((r) => {
    const who = owners.get(r.asset);
    return who ? `${who}:${picked(who)}` : r.asset;
  }))].sort();
}

/** Whether two forms give the same person (faceOf of each): the same, not empty. Another person, another pick, one more: not. */
export const sameFace = (mine: readonly string[], theirs: readonly string[]): boolean =>
  mine.length > 0 && mine.length === theirs.length && mine.every((a, i) => a === theirs[i]);

/** A look as a row keeps it (JSON), or null. */
export const lookOf = (json: string | null | undefined): Look | null => (json ? (JSON.parse(json) as Look) : null);

/** The render waiting or running for a clip, its take to come (its recipe, the form and the look it was sent), or null. */
export async function takeComing(db: Db, clipId: string): Promise<Rendered | null> {
  const job = await db.selectFrom("jobs").select(["recipe_id", "inputs", "look"]).where("clip_id", "=", clipId).where(toRun).executeTakeFirst();
  return job ? { recipe: job.recipe_id, inputs: JSON.parse(job.inputs) as Record<string, unknown>, look: lookOf(job.look) } : null;
}

/** What a take was rendered from (its generation's recipe and inputs, its job's look), or null for a take rendered nowhere here. */
export async function renderedWith(db: Db, generation: string | null): Promise<Rendered | null> {
  if (!generation) return null;
  const row = await db.selectFrom("generations").select(["recipe_id", "inputs"]).where("id", "=", generation).executeTakeFirst();
  if (!row) return null;
  const job = await db.selectFrom("jobs").select("look").where("generation_id", "=", generation).executeTakeFirst();
  return { recipe: row.recipe_id, inputs: JSON.parse(row.inputs) as Record<string, unknown>, look: lookOf(job?.look) };
}
