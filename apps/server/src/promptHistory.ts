import { sql } from "kysely";
import type { InputSpec, Recipe } from "@afflatus/core";
import { z } from "zod";
import { NOT_IN_LIBRARY } from "./library";
import type { Services } from "./services";

/**
 * The prompts that were rendered, for the command bar's `"` mode: each once, newest first, with the draft it was sent
 * from and a picture or video of it still in the library. Read from the generations, where a prompt lives inside the
 * form kept as JSON (the form as it was typed, `asked`, before the cast was worked into it, else the form as sent).
 *
 * A JSON column cannot be searched as a column on both databases, so this is a bounded scan: the newest SCAN renders,
 * narrowed in SQL first by the text searched for (a case-folded LIKE over the JSON), then read in JS a page at a time,
 * newest first, until the prompts asked for are found and each has its picture (most often in the first page). A prompt last
 * rendered before that many renders ago (that many renders matching the text, when searching) is not offered. SQLite
 * folds only ASCII letters in that LIKE: a search with an accented capital may miss a prompt written in lower case.
 */

/** How many of the newest renders are read, at most. */
const SCAN = 5000;
/** The renders read at a time: enough for the prompts of most libraries in one page. */
const PAGE = 500;
/** The renders of one prompt looked at for a picture of it still in the library. */
const GENS_PER_PROMPT = 50;

const query = z.object({
  q: z.preprocess((v) => (typeof v === "string" && !v.trim() ? undefined : v), z.string().trim().min(1).max(200).optional()),
  limit: z.coerce.number().int().min(1).max(200).default(30),
});

export interface PromptHistoryItem {
  prompt: string;
  recipe: string;
  draftId: string | null;
  /** Its first output still in the library (of its newest render that has one); null when all of them are gone. */
  assetId: string | null;
  createdAt: string;
}

/**
 * The main text of a form: a prompt input that is not the negative, those the recipe cannot do without first (a
 * recipe whose prompt is optional, like fixing a face, still has one). A recipe no longer known reads "prompt".
 */
function promptIds(recipe: Recipe<any> | undefined): string[] {
  if (!recipe) return ["prompt", "description"];
  const texts = (recipe.inputs as InputSpec[]).filter((i): i is Extract<InputSpec, { type: "prompt" }> => i.type === "prompt" && i.id !== "negative");
  return [...texts.filter((i) => !i.optional), ...texts.filter((i) => i.optional)].map((i) => i.id);
}

/** `%`, `_` and the escape itself taken as themselves in a LIKE pattern. */
const likeEscaped = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function promptHistory(s: Services, raw: unknown): Promise<{ items: PromptHistoryItem[] }> {
  const { q, limit } = query.parse(raw);
  const needle = q?.toLowerCase();
  let rows = s.db.selectFrom("generations").select(["id", "recipe_id", "inputs", "asked", "draft_id", "created_at"]);
  if (needle) {
    // the text as JSON writes it (a quote or a line break escaped), so that the stored form can hold it
    const pattern = `%${likeEscaped(JSON.stringify(needle).slice(1, -1))}%`;
    rows = rows.where(sql<boolean>`lower(coalesce(asked, inputs)) like ${pattern} escape '\\'`);
  }
  const byText = new Map<string, PromptHistoryItem & { gens: string[]; checked: number }>();
  const ids = new Map<string, string[]>();
  /** The generations of the items not looked at yet: their first output still in the library, each newest render first. */
  const resolve = async () => {
    const open = [...byText.values()].filter((i) => i.assetId === null && i.checked < i.gens.length);
    const gens = open.flatMap((i) => i.gens.slice(i.checked));
    if (!gens.length) return;
    const outputs = await s.db.selectFrom("assets").select(["id", "generation_id"])
      .where("generation_id", "in", gens).where("deleted_at", "is", null).where("origin", "not in", NOT_IN_LIBRARY)
      .orderBy("created_at").orderBy("id").execute();
    const first = new Map<string, string>();
    for (const a of outputs) if (a.generation_id && !first.has(a.generation_id)) first.set(a.generation_id, a.id);
    for (const i of open) {
      i.assetId = i.gens.slice(i.checked).map((g) => first.get(g)).find((a) => a !== undefined) ?? null;
      i.checked = i.gens.length;
    }
  };
  // a page at a time, from where the one before stopped (created_at, then id, newest first: the generations_by_time index)
  let after: { created_at: string; id: string } | null = null;
  for (let read = 0; read < SCAN; ) {
    const from: { created_at: string; id: string } | null = after;
    const found = await rows
      .$if(from !== null, (qb) => qb.where((eb) => eb.or([eb("created_at", "<", from!.created_at), eb.and([eb("created_at", "=", from!.created_at), eb("id", "<", from!.id)])])))
      .orderBy("created_at", "desc").orderBy("id", "desc").limit(Math.min(PAGE, SCAN - read)).execute();
    read += found.length;
    for (const g of found) {
      let form: Record<string, unknown>;
      try {
        form = JSON.parse(g.asked ?? g.inputs) as Record<string, unknown>;
      } catch {
        continue;
      }
      const recipe = s.registry.recipe(g.recipe_id);
      let ofRecipe = ids.get(g.recipe_id);
      if (!ofRecipe) ids.set(g.recipe_id, (ofRecipe = promptIds(recipe)));
      const prompt = ofRecipe.map((id) => form[id]).find((v): v is string => typeof v === "string" && v.trim() !== "")?.trim();
      if (!prompt || (needle && !prompt.toLowerCase().includes(needle))) continue;
      const seen = byText.get(prompt);
      if (seen) {
        if (seen.gens.length < GENS_PER_PROMPT) seen.gens.push(g.id);
        continue;
      }
      // the newest render of a prompt is read first: its recipe, draft and time are the item's
      if (byText.size >= limit) continue;
      byText.set(prompt, { prompt, recipe: g.recipe_id, draftId: g.draft_id, assetId: null, createdAt: g.created_at, gens: [g.id], checked: 0 });
    }
    const last = found.at(-1);
    if (!last || found.length < PAGE) break;
    after = { created_at: last.created_at, id: last.id };
    // the prompts are all there: read on only for one whose renders so far have nothing left in the library (an older one may)
    if (byText.size >= limit) {
      await resolve();
      if ([...byText.values()].every((i) => i.assetId !== null || i.gens.length >= GENS_PER_PROMPT)) break;
    }
  }
  await resolve();
  const items = [...byText.values()].map(({ gens: _, checked: __, ...i }) => i);
  return { items };
}
