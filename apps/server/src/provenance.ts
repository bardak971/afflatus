import type { InputSpec, LoraValue, Recipe } from "@afflatus/core";
import { lookSchema, type Look } from "./entities";
import type { Services } from "./services";

/**
 * How something in the library came to be, as far back as Afflatus knows: a picture that was upscaled
 * was a picture before, which was made from a prompt; a frame saved from a video is that video's, which
 * opened on a picture. Each step is a render Afflatus made, with what it was told.
 */
export interface Step {
  recipe: string;
  /** What the operation is called ("txt2img", "Upscale 2x", "Video with sound"). */
  title: string;
  /** The model family it was made with, by name. */
  family?: string;
  kind: "image" | "video" | "audio";
  /** What its main text said: empty for a step that had none (an upscale, a face pass left to itself). */
  text: string;
  /** What its other texts said, by their label (a clip's sounds and music): not the negative prompt. */
  more: Array<{ label: string; text: string }>;
  /** The LoRAs that were on it. */
  loras: LoraValue[];
  /** Who was in it and how it looked, when that is known: the cast it was sent with, else that of the draft it came from. */
  look: Look | null;
}

/** The roles of what a render was made from that carry on what it shows, the nearest to it first. */
const FROM = ["source", "previous", "start"];
/** How far back the trail is followed. */
const MOST = 8;

const boxesOf = (recipe: Recipe<any>) => (recipe.inputs as InputSpec[]).filter((i): i is Extract<InputSpec, { type: "prompt" }> => i.type === "prompt");
const lookOf = (raw: unknown): Look | null => {
  const parsed = lookSchema.safeParse(raw);
  return parsed.success && (parsed.data.cast.length || parsed.data.style) ? parsed.data : null;
};

/** The steps something was made in, the oldest first. Nothing for what Afflatus did not make (an upload, a file of a linked folder). */
export async function madeIn(s: Pick<Services, "db" | "registry">, assetId: string): Promise<Step[]> {
  const steps: Step[] = [];
  const seen = new Set<string>();
  let id: string | null = assetId;
  while (id && !seen.has(id) && steps.length < MOST) {
    seen.add(id);
    const a: { generation_id: string | null; source_id: string | null; kind: Step["kind"] } | undefined = await s.db.selectFrom("assets").select(["generation_id", "source_id", "kind"]).where("id", "=", id).executeTakeFirst();
    if (!a) break;
    if (!a.generation_id) {
      // something taken out of something else (a frame of a video, the sound of one): its story is that one's
      id = a.source_id;
      continue;
    }
    const g = await s.db.selectFrom("generations").selectAll().where("id", "=", a.generation_id).executeTakeFirst();
    if (!g) break;
    const recipe = s.registry.recipe(g.recipe_id);
    const inputs = JSON.parse(g.inputs) as Record<string, unknown>;
    const resolved = JSON.parse(g.resolved) as { look?: unknown };
    const boxes = recipe ? boxesOf(recipe) : [];
    const main = boxes.find((b) => !b.optional && b.id !== "negative") ?? boxes.find((b) => b.id !== "negative");
    const text = typeof inputs[main?.id ?? "prompt"] === "string" ? (inputs[main?.id ?? "prompt"] as string).trim() : "";
    const more = boxes
      .filter((b) => b !== main && b.id !== "negative" && typeof inputs[b.id] === "string" && (inputs[b.id] as string).trim())
      .map((b) => ({ label: b.label, text: (inputs[b.id] as string).trim() }));
    const loras = (recipe?.inputs as InputSpec[] | undefined ?? []).filter((i) => i.type === "loras").flatMap((i) => (Array.isArray(inputs[i.id]) ? (inputs[i.id] as LoraValue[]) : [])).filter((l) => l?.file && l.weight !== 0);
    // the cast it was sent with; for what was made before that was recorded, that of its draft as it is now
    let look = lookOf(resolved.look);
    if (!look && g.draft_id) {
      const draft = await s.db.selectFrom("drafts").select("look").where("id", "=", g.draft_id).executeTakeFirst();
      look = draft?.look ? lookOf(JSON.parse(draft.look)) : null;
    }
    steps.push({ recipe: g.recipe_id, title: recipe?.title ?? g.recipe_id, family: s.registry.family(g.family)?.name, kind: a.kind, text, more, loras, look });
    // what it was made from: the picture it redraws, the clip it carries on, the picture it opens on
    const from = await s.db.selectFrom("generation_inputs").select(["asset_id", "role"]).where("generation_id", "=", g.id).where("role", "in", FROM).execute();
    id = FROM.map((role) => from.find((f) => f.role === role)?.asset_id).find(Boolean) ?? null;
  }
  return steps.reverse();
}

/** Who was in it, from the latest step that says. */
export const castOf = (steps: Step[]): Look | null => [...steps].reverse().find((x) => x.look)?.look ?? null;
