import type { InputSpec, LoraValue, Recipe, ReferenceValue } from "@studai/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { newId, now, OWNER, type Db, type Tables } from "./db";
import type { Services } from "./services";

/**
 * People, places and styles: written once, used with every model. A person is some pictures, a voice,
 * how they look in words (as tags and as a sentence: models read one or the other), a LoRA per model
 * when there is one, and outfits. A place is pictures and words. A style is LoRAs and words per model.
 * A preset is a whole setup: the model, its form, and who is in it.
 *
 * `compose` is the one place that turns "her, in the summer dress, film look" into what a recipe
 * takes: words in the prompt, LoRAs, reference pictures, a voice. A recipe never hears about people.
 */

const lora = z.strictObject({ file: z.string().min(1), weight: z.number().min(-4).max(4) });
const outfit = z.strictObject({
  id: z.string().min(1),
  name: z.string().max(120),
  tags: z.string().max(2000).default(""),
  sentence: z.string().max(2000).default(""),
  /** A picture of the clothes, for models that take reference pictures. */
  picture: z.string().nullable().default(null),
});
const defs = {
  person: z.strictObject({
    pictures: z.array(z.string()).max(9).default([]),
    voice: z.string().nullable().default(null),
    tags: z.string().max(4000).default(""),
    sentence: z.string().max(4000).default(""),
    /** Per model family: the LoRA of this person, its strength and the word that calls it up. */
    models: z.record(z.string(), z.strictObject({ lora: z.string().nullable().default(null), weight: z.number().min(-4).max(4).default(0.8), trigger: z.string().max(200).default("") })).default({}),
    outfits: z.array(outfit).max(30).default([]),
  }),
  place: z.strictObject({
    pictures: z.array(z.string()).max(9).default([]),
    tags: z.string().max(4000).default(""),
    sentence: z.string().max(4000).default(""),
  }),
  style: z.strictObject({
    /** Per model family: the LoRAs that make the look, and the words that go with them. */
    models: z.record(z.string(), z.strictObject({ loras: z.array(lora).max(8).default([]), words: z.string().max(2000).default("") })).default({}),
  }),
  preset: z.strictObject({
    recipe: z.string().min(1),
    inputs: z.record(z.string(), z.unknown()).default({}),
    look: z.unknown().optional(),
  }),
  /**
   * A bit of text kept for prompts: ticked, it is added to what is written when something is made; or it
   * is written into the text. `category` is the user's own word for what it is about ("pose", "light").
   * `style` is the kind of prompt it was written for, when that is known: it is offered there first.
   */
  snippet: z.strictObject({
    text: z.string().max(4000).default(""),
    category: z.string().trim().max(40).default(""),
    style: z.enum(["tags", "sentences"]).nullable().default(null),
  }),
};
export type EntityKind = keyof typeof defs;
type PersonDef = z.infer<typeof defs.person>;
type PlaceDef = z.infer<typeof defs.place>;
type StyleDef = z.infer<typeof defs.style>;

/** Who is in it and how it looks: people and places (a person with the outfit picked), and one style. */
export const lookSchema = z.strictObject({
  cast: z.array(z.strictObject({ id: z.string().min(1), outfit: z.string().nullable().optional() })).max(8).default([]),
  style: z.string().nullable().optional(),
  /** Snippets that are ticked: their text is added after what is written. */
  snippets: z.array(z.string().min(1)).max(30).default([]),
});
export type Look = z.infer<typeof lookSchema>;
export const emptyLook = (look: Look | null | undefined) => !look || (!look.cast.length && !look.style && !look.snippets?.length);

// (a snippet kept before there were categories has none: it reads as one without)
const view = (e: Tables["entities"]) => ({ id: e.id, kind: e.kind, name: e.name, def: (e.kind === "snippet" ? defs.snippet.parse(JSON.parse(e.def)) : JSON.parse(e.def)) as unknown, updatedAt: e.updated_at });

/** What was added to a form for its cast and its style, to show before it is sent. */
export interface Composed {
  input: Record<string, unknown>;
  added: { words: Array<{ from: string; text: string }>; loras: Array<{ from: string; file: string }>; references: number; voice: string | null; skipped: string[] };
}

/** How many pictures of one person, and of one place, are handed to a model that takes reference pictures. */
const PICTURES = { person: 3, place: 2 };

const join = (parts: Array<string | undefined | null>, by: string) => parts.map((p) => (p ?? "").trim().replace(/^[,\s]+|[,\s]+$/g, "")).filter(Boolean).join(by);

/** The look and mood of a whole video go at the end of what happens, like a style's words. */
export function withMood(recipe: Recipe<any>, input: Record<string, unknown>, mood: string | null | undefined): Record<string, unknown> {
  const words = mood?.trim();
  const specs = recipe.inputs as InputSpec[];
  const main = specs.find((i) => i.type === "prompt" && !i.optional) ?? specs.find((i) => i.type === "prompt");
  if (!words || !main) return input;
  const own = String(input[main.id] ?? "");
  if (own.includes(words)) return input;
  return { ...input, [main.id]: join([own, words], main.type === "prompt" && main.style === "tags" ? ", " : " ") };
}

/**
 * The form with its cast and style worked in: their words in the prompt (as tags or as sentences,
 * whichever the recipe's prompt is written in), their LoRAs for this model, their pictures as
 * references and a voice, for the recipes that take those.
 */
export async function compose(db: Db, recipe: Recipe<any>, raw: Record<string, unknown>, look: Look | null | undefined): Promise<Composed> {
  const input = { ...raw };
  const added: Composed["added"] = { words: [], loras: [], references: 0, voice: null, skipped: [] };
  if (emptyLook(look)) return { input, added };
  const ids = [...look!.cast.map((c) => c.id), ...(look!.style ? [look!.style] : []), ...(look!.snippets ?? [])];
  const rows = ids.length ? await db.selectFrom("entities").selectAll().where("id", "in", ids).execute() : [];
  const byId = new Map(rows.map((r) => [r.id, r]));

  const specs = recipe.inputs as InputSpec[];
  const main = specs.find((i) => i.type === "prompt" && !i.optional) ?? specs.find((i) => i.type === "prompt");
  const tags = main?.type === "prompt" && main.style === "tags";
  const subjectSpec = specs.find((i) => i.type === "prompt" && i.holds === "subject");
  const refSpec = specs.find((i) => i.type === "references" && !i.media);
  const voiceSpec = specs.find((i) => i.type === "audio" && i.role === "voice");
  const loraSpec = specs.find((i) => i.type === "loras");

  const people: string[] = [];
  const places: string[] = [];
  const looks: string[] = [];
  const bits: string[] = [];
  const refs: ReferenceValue[] = [];
  const loras: Array<LoraValue & { from: string }> = [];
  let voice: { asset: string; from: string } | null = null;

  for (const member of look!.cast) {
    const row = byId.get(member.id);
    if (!row) continue;
    if (row.kind === "person") {
      const p = defs.person.parse(JSON.parse(row.def)) as PersonDef;
      const worn = p.outfits.find((o) => o.id === member.outfit);
      const m = p.models[recipe.family];
      const words = tags ? join([m?.trigger, p.tags, worn?.tags], ", ") : join([p.sentence, worn?.sentence], " ");
      if (words) {
        people.push(words);
        added.words.push({ from: row.name, text: words });
      }
      if (m?.lora) loras.push({ file: m.lora, weight: m.weight, from: row.name });
      for (const asset of p.pictures.slice(0, PICTURES.person)) refs.push({ asset, role: "person" });
      if (worn?.picture) refs.push({ asset: worn.picture, role: "clothing" });
      if (p.voice && !voice) voice = { asset: p.voice, from: row.name };
    } else if (row.kind === "place") {
      const p = defs.place.parse(JSON.parse(row.def)) as PlaceDef;
      const words = tags ? p.tags : p.sentence;
      if (words.trim()) {
        places.push(words);
        added.words.push({ from: row.name, text: words.trim() });
      }
      for (const asset of p.pictures.slice(0, PICTURES.place)) refs.push({ asset, role: "place" });
    }
  }
  // the ticked snippets, in the order they were ticked
  for (const id of look!.snippets ?? []) {
    const row = byId.get(id);
    if (row?.kind !== "snippet") continue;
    const text = defs.snippet.parse(JSON.parse(row.def)).text.trim();
    if (!text) continue;
    bits.push(text);
    added.words.push({ from: row.name, text });
  }
  const styleRow = look!.style ? byId.get(look!.style) : undefined;
  if (styleRow?.kind === "style") {
    const m = (defs.style.parse(JSON.parse(styleRow.def)) as StyleDef).models[recipe.family];
    if (m?.words.trim()) {
      looks.push(m.words);
      added.words.push({ from: styleRow.name, text: m.words.trim() });
    }
    for (const l of m?.loras ?? []) loras.push({ ...l, from: styleRow.name });
    if (!m) added.skipped.push(`${styleRow.name} is not set up for this model`);
  }

  // ---- reference pictures and the voice, for the recipes that take them
  let withRefs = false;
  if (refSpec?.type === "references" && refs.length) {
    const have = Array.isArray(input[refSpec.id]) ? (input[refSpec.id] as ReferenceValue[]) : [];
    const alive = new Set((await db.selectFrom("assets").select("id").where("id", "in", refs.map((r) => r.asset)).where("deleted_at", "is", null).where("kind", "=", "image").execute()).map((a) => a.id));
    const more = refs.filter((r) => alive.has(r.asset) && refSpec.roles.includes(r.role) && !have.some((h) => h.asset === r.asset));
    const all = [...have, ...more].slice(0, refSpec.max);
    added.references = all.length - have.length;
    if (more.length > added.references) added.skipped.push(`${more.length - added.references} reference picture${more.length - added.references > 1 ? "s" : ""} did not fit: this model takes ${refSpec.max}`);
    input[refSpec.id] = all;
    withRefs = all.length > 0;
  }
  if (voiceSpec && voice && !input[voiceSpec.id]) {
    const sound = await db.selectFrom("assets").select("id").where("id", "=", voice.asset).where("deleted_at", "is", null).executeTakeFirst();
    if (sound) {
      input[voiceSpec.id] = voice.asset;
      added.voice = voice.from;
    }
  }

  // ---- the words
  if (main) {
    const own = String(input[main.id] ?? "");
    if (tags) input[main.id] = join([...people, own, ...bits, ...places, ...looks], ", ");
    else if (subjectSpec && withRefs) {
      // a recipe that follows reference pictures has a place of its own for how the people look
      input[subjectSpec.id] = join([String(input[subjectSpec.id] ?? ""), ...people], " ");
      input[main.id] = join([...places, own, ...bits, ...looks], " ");
    } else input[main.id] = join([...people, ...places, own, ...bits, ...looks], " ");
  }

  // ---- the LoRAs
  if (loras.length) {
    if (loraSpec?.type === "loras") {
      const have = Array.isArray(input[loraSpec.id]) ? (input[loraSpec.id] as LoraValue[]) : [];
      const more = loras.filter((l, i) => !have.some((h) => h.file === l.file) && loras.findIndex((x) => x.file === l.file) === i);
      const room = Math.max(0, loraSpec.max - have.length);
      for (const l of more.slice(0, room)) added.loras.push({ from: l.from, file: l.file });
      if (more.length > room) added.skipped.push(`${more.length - room} LoRA${more.length - room > 1 ? "s" : ""} did not fit: this model takes ${loraSpec.max}`);
      input[loraSpec.id] = [...have, ...more.slice(0, room).map((l) => ({ file: l.file, weight: l.weight }))];
    } else added.skipped.push("this model takes no LoRA");
  }
  return { input, added };
}

const body = z.strictObject({ kind: z.enum(["person", "place", "style", "preset", "snippet"]), name: z.string().trim().min(1).max(120), def: z.unknown().optional() });
const patch = z.strictObject({ name: z.string().trim().min(1).max(120).optional(), def: z.unknown().optional() });

export function registerEntities(app: FastifyInstance, s: Services): void {
  const missing = () => Object.assign(new Error("this was not found"), { statusCode: 404 });
  const changed = () => s.queue.events.emit("entities");

  app.get<{ Querystring: { kind?: string } }>("/api/entities", async (req) => {
    let q = s.db.selectFrom("entities").selectAll().where("owner_id", "=", OWNER);
    if (req.query.kind) q = q.where("kind", "=", req.query.kind as EntityKind);
    return { items: (await q.orderBy("name").execute()).map(view) };
  });

  app.post("/api/entities", async (req) => {
    const b = body.parse(req.body);
    const def = defs[b.kind].parse(b.def ?? (b.kind === "preset" ? undefined : {}));
    const at = now();
    const row: Tables["entities"] = { id: newId(), owner_id: OWNER, kind: b.kind, name: b.name, def: JSON.stringify(def), created_at: at, updated_at: at };
    await s.db.insertInto("entities").values(row).execute();
    changed();
    return view(row);
  });

  app.put<{ Params: { id: string } }>("/api/entities/:id", async (req) => {
    const b = patch.parse(req.body);
    const row = await s.db.selectFrom("entities").selectAll().where("id", "=", req.params.id).executeTakeFirst();
    if (!row) throw missing();
    const next = { name: b.name ?? row.name, def: b.def === undefined ? row.def : JSON.stringify(defs[row.kind].parse(b.def)), updated_at: now() };
    await s.db.updateTable("entities").set(next).where("id", "=", row.id).execute();
    // their pictures and voices are wanted: they never go to the bin on their own
    if (b.def !== undefined && (row.kind === "person" || row.kind === "place")) {
      const d = JSON.parse(next.def) as { pictures: string[]; voice?: string | null; outfits?: Array<{ picture: string | null }> };
      const used = [...d.pictures, d.voice, ...(d.outfits ?? []).map((o) => o.picture)].filter((x): x is string => Boolean(x));
      if (used.length) await s.db.updateTable("assets").set({ kept_at: now() }).where("id", "in", used).where("kept_at", "is", null).execute();
    }
    changed();
    return view({ ...row, ...next });
  });

  app.delete<{ Params: { id: string } }>("/api/entities/:id", async (req) => {
    const r = await s.db.deleteFrom("entities").where("id", "=", req.params.id).executeTakeFirst();
    if (!Number(r.numDeletedRows)) throw missing();
    changed();
    return { ok: true };
  });

  /** What a form becomes once its cast and style are worked in: shown before it is sent. Nothing is queued. */
  app.post("/api/compose", async (req) => {
    const b = z.strictObject({ recipe: z.string().min(1), input: z.record(z.string(), z.unknown()), look: lookSchema }).parse(req.body);
    const recipe = s.registry.recipe(b.recipe);
    if (!recipe) throw Object.assign(new Error(`there is no recipe called ${b.recipe}`), { statusCode: 400 });
    return compose(s.db, recipe, b.input, b.look);
  });
}
