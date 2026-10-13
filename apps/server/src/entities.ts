import { LIMITS, plural, presetFileSchema, provenanceSchema, type InputSpec, type LoraValue, type Recipe, type ReferenceRole, type ReferenceValue } from "@afflatus/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { httpError } from "./errors";
import { oneAtATime } from "./keyedLock";
import { newId, now, OWNER, type Db, type Tables } from "./db";
import { SHIPPED } from "./presetFiles";
import type { Services } from "./services";
import { askCutouts } from "./kitCutouts";
import { dropFromUnwritten } from "./unwrittenDrafts";

/**
 * People, places and styles: written once, used with every model. A person is some pictures, a voice,
 * how they look in words (as tags and as a sentence: models read one or the other), a LoRA per model
 * when there is one, and outfits. A place is pictures and words. A style is LoRAs and words per model.
 * A preset is a whole setup: the model, its form, and who is in it.
 *
 * `compose` is the one place that turns "her, in the summer dress, film look" into what a recipe
 * takes: words in the prompt, LoRAs, reference pictures, a voice. A recipe never hears about people.
 */

/** Who is in it and how it looks: people and places (a person with the outfit picked), and one style. */
export const lookSchema = z.strictObject({
  cast: z.array(z.strictObject({ id: z.string().min(1), outfit: z.string().nullable().optional() })).max(LIMITS.cast).default([]),
  style: z.string().nullable().optional(),
  /** Snippets that are ticked: their text is added after what is written. */
  snippets: z.array(z.string().min(1)).max(LIMITS.snippets).default([]),
});
export type Look = z.infer<typeof lookSchema>;
export const emptyLook = (look: Look | null | undefined) => !look || (!look.cast.length && !look.style && !look.snippets?.length);

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
    pictures: z.array(z.string()).max(LIMITS.pictures).default([]),
    voice: z.string().nullable().default(null),
    /**
     * The part of the voice sample a model is given, in seconds (null: the form's own, from the start): set once, every
     * render of them speaks with the same few seconds.
     */
    voicePart: z.strictObject({ start: z.number().min(0).max(3600), seconds: z.number().min(0.5).max(60) }).nullable().default(null),
    tags: z.string().max(4000).default(""),
    sentence: z.string().max(4000).default(""),
    /** Per model family: the LoRA of this person, its strength and the word that calls it up. */
    models: z.record(z.string(), z.strictObject({ lora: z.string().nullable().default(null), weight: z.number().min(-4).max(4).default(0.8), trigger: z.string().max(200).default("") })).default({}),
    outfits: z.array(outfit).max(LIMITS.outfits).default([]),
    /**
     * Their pictures are sent to a model without their background (kitCutouts.ts): only who they are, never the room they
     * were taken in, which H3 was seen re-animating whole (2026-10-13). On unless switched off.
     */
    cutout: z.boolean().default(true),
    /** Picture → its cut-out (a kit file laid on grey), made once each. Written by the server alone: a save keeps what it has. */
    cutouts: z.record(z.string(), z.string()).default({}),
  }),
  place: z.strictObject({
    pictures: z.array(z.string()).max(LIMITS.pictures).default([]),
    tags: z.string().max(4000).default(""),
    sentence: z.string().max(4000).default(""),
  }),
  style: z.strictObject({
    /** Per model family: the LoRAs that make the look, and the words that go with them. */
    models: z.record(z.string(), z.strictObject({ loras: z.array(lora).max(8).default([]), words: z.string().max(2000).default("") })).default({}),
  }),
  // everything optional: a preset may set a model and its form, or only a prompt and who is in it, for any model
  preset: z.strictObject({
    recipe: z.string().min(1).optional(),
    inputs: z.record(z.string(), z.unknown()).default({}),
    // the same shape a draft holds: a preset is applied to one, and a look of another shape would make its every save fail
    look: lookSchema.nullable().optional(),
    /** The model files it is made for, with where each is had: the preset says what is missing and fetches it. */
    files: z.array(presetFileSchema).max(40).optional(),
    // where it comes from, kept on a copy of a shipped preset
    ...provenanceSchema,
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


// (a snippet kept before there were categories has none: it reads as one without)
const view = (e: Tables["entities"]) => ({ id: e.id, kind: e.kind, name: e.name, def: (e.kind === "snippet" ? defs.snippet.parse(JSON.parse(e.def)) : JSON.parse(e.def)) as unknown, updatedAt: e.updated_at });
/** A kit item as the routes answer it: what the web's types are held against (test/apiTypes.test.ts). @internal */
export type EntityView = ReturnType<typeof view>;

/** What was added to a form for its cast and its style, to show before it is sent. */
export interface Composed {
  input: Record<string, unknown>;
  added: { words: Array<{ from: string; text: string }>; loras: Array<{ from: string; file: string }>; references: number; /** The reference pictures added, and whose they are (a person's own without their background: cutout). */ refs: Array<{ asset: string; role: ReferenceRole; from: string; cutout?: boolean }>; voice: string | null; /** The voice sample added: the form shows it in its sound field. */ voiceAsset: string | null; /** The part of it set on the person. */ voicePart?: { start: number; seconds: number }; skipped: string[] };
}

/** The files an entity's definition names: its pictures, its outfits' pictures and its voice sample. */
const filesOf = (def: string): string[] => {
  const d = JSON.parse(def) as { pictures?: string[]; voice?: string | null; outfits?: Array<{ picture?: string | null }>; cutouts?: Record<string, string> };
  return [...(d.pictures ?? []), d.voice, ...(d.outfits ?? []).map((o) => o.picture), ...Object.values(d.cutouts ?? {})].filter((x): x is string => Boolean(x));
};

/**
 * The cut-outs a person keeps after a save: the ones the server made (the page's copy is not trusted: it may be older
 * than a cut-out that came in meanwhile), for the pictures they still have. A picture taken off drops its cut-out, which
 * then goes to the bin with it.
 */
function keptCutouts(before: string, next: Record<string, unknown>): Record<string, unknown> {
  const had = (JSON.parse(before) as { cutouts?: Record<string, string> }).cutouts ?? {};
  const pictures = new Set(Array.isArray(next.pictures) ? (next.pictures as string[]) : []);
  return { ...next, cutouts: Object.fromEntries(Object.entries(had).filter(([picture]) => pictures.has(picture))) };
}

/** Files uploaded for the Prompt kit (pictures, voice samples) that no person or place names any more: to the bin (the library never shows them). */
async function binUnwantedKit(db: Db, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const wanted = new Set((await db.selectFrom("entities").select("def").where("kind", "in", ["person", "place"]).execute()).flatMap((e) => filesOf(e.def)));
  const gone = ids.filter((id) => !wanted.has(id));
  if (gone.length) await db.updateTable("assets").set({ deleted_at: now() }).where("id", "in", gone).where("origin", "=", "kit").where("deleted_at", "is", null).execute();
}

/** How many pictures of one person, and of one place, are handed to a model that takes reference pictures. */
const PICTURES = LIMITS.sentPictures;

const join = (parts: Array<string | undefined | null>, by: string) => parts.map((p) => (p ?? "").trim().replace(/^[,\s]+|[,\s]+$/g, "")).filter(Boolean).join(by);

/**
 * What is written, with words put before and after it, each only where the text does not hold it yet: a
 * form that comes back with its cast's words already in it (a tool opened on a picture made with them)
 * gets them once, not twice. Tags count one by one; sentences as a whole.
 */
function withWords(own: string, before: string[], after: string[], tags: boolean): string {
  const key = (w: string) => w.trim().replace(/\s+/g, " ").toLowerCase();
  if (tags) {
    const seen = new Set(own.split(",").map(key).filter(Boolean));
    const fresh = (part: string) => join(part.split(",").filter((t) => {
      const k = key(t);
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    }), ", ");
    return join([...before.map(fresh), own, ...after.map(fresh)], ", ");
  }
  let held = key(own);
  const fresh = (part: string) => {
    const k = key(part);
    if (!k || held.includes(k)) return "";
    held += ` ${k}`;
    return part;
  };
  return join([...before.map(fresh), own, ...after.map(fresh)], " ");
}

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
  const added: Composed["added"] = { words: [], loras: [], references: 0, refs: [], voice: null, voiceAsset: null, skipped: [] };
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
  const refs: Array<ReferenceValue & { from: string; cutout?: boolean }> = [];
  const loras: Array<LoraValue & { from: string }> = [];
  let voice: { asset: string; from: string; part: { start: number; seconds: number } | null } | null = null;

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
      // without their background when they have it (a cut-out made once per picture), else the picture as it is
      for (const picture of p.pictures.slice(0, PICTURES.person)) {
        const cut = p.cutout ? p.cutouts[picture] : undefined;
        refs.push({ asset: cut ?? picture, role: "person", from: row.name, ...(cut ? { cutout: true } : {}) });
      }
      if (worn?.picture) refs.push({ asset: worn.picture, role: "clothing", from: row.name });
      if (p.voice && !voice) voice = { asset: p.voice, from: row.name, part: p.voicePart };
    } else if (row.kind === "place") {
      const p = defs.place.parse(JSON.parse(row.def)) as PlaceDef;
      const words = tags ? p.tags : p.sentence;
      if (words.trim()) {
        places.push(words);
        added.words.push({ from: row.name, text: words.trim() });
      }
      for (const asset of p.pictures.slice(0, PICTURES.place)) refs.push({ asset, role: "place", from: row.name });
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
    const all = [...have, ...more.map(({ asset, role }) => ({ asset, role }))].slice(0, refSpec.max);
    added.references = all.length - have.length;
    added.refs = more.slice(0, added.references);
    if (more.length > added.references) added.skipped.push(`${plural(more.length - added.references, "reference picture")} did not fit: this model takes ${refSpec.max}`);
    input[refSpec.id] = all;
    withRefs = all.length > 0;
  }
  if (voiceSpec && voice && !input[voiceSpec.id]) {
    const sound = await db.selectFrom("assets").select("id").where("id", "=", voice.asset).where("deleted_at", "is", null).executeTakeFirst();
    if (sound) {
      input[voiceSpec.id] = voice.asset;
      added.voice = voice.from;
      added.voiceAsset = voice.asset;
      // with the part set on the person, in place of the form's (a sample chosen in the form keeps the form's part)
      if (voice.part && voiceSpec.type === "audio" && voiceSpec.window) {
        input[voiceSpec.window.start] = voice.part.start;
        input[voiceSpec.window.seconds] = voice.part.seconds;
        added.voicePart = voice.part;
      }
    }
  }

  // ---- the words
  if (main) {
    const own = String(input[main.id] ?? "");
    if (tags) input[main.id] = withWords(own, people, [...bits, ...places, ...looks], true);
    else if (subjectSpec && withRefs) {
      // a recipe that follows reference pictures has a place of its own for how the people look
      input[subjectSpec.id] = withWords(String(input[subjectSpec.id] ?? ""), [], people, false);
      input[main.id] = withWords(own, places, [...bits, ...looks], false);
    } else input[main.id] = withWords(own, [...people, ...places], [...bits, ...looks], false);
  }

  // ---- the LoRAs
  if (loras.length) {
    if (loraSpec?.type === "loras") {
      const have = Array.isArray(input[loraSpec.id]) ? (input[loraSpec.id] as LoraValue[]) : [];
      const more = loras.filter((l, i) => !have.some((h) => h.file === l.file) && loras.findIndex((x) => x.file === l.file) === i);
      const room = Math.max(0, loraSpec.max - have.length);
      for (const l of more.slice(0, room)) added.loras.push({ from: l.from, file: l.file });
      if (more.length > room) added.skipped.push(`${plural(more.length - room, "LoRA")} did not fit: this model takes ${loraSpec.max}`);
      input[loraSpec.id] = [...have, ...more.slice(0, room).map((l) => ({ file: l.file, weight: l.weight }))];
    } else added.skipped.push("this model takes no LoRA");
  }
  return { input, added };
}

/**
 * A person, place, style or snippet deleted: taken out of every draft's, timeline's and clip's look, so it
 * neither lingers unseen nor counts toward the cast. Jobs keep theirs: that is what was sent. Each look is written
 * only as it was read: one changed in between (a save, another deletion) is read again, or the change was undone.
 */
async function dropFromLooks(db: Db, id: string): Promise<{ drafts: number; timelines: number }> {
  let drafts = 0;
  let timelines = 0;
  for (const table of ["drafts", "timelines", "clips"] as const) {
    // ids are quoted in the JSON: a rough match first, the look itself decides
    const rows = await db.selectFrom(table).select(["id", "look"]).where("look", "like", `%"${id}"%`).execute();
    for (const row of rows) {
      let r: { id: string; look: string | null } | undefined = row;
      for (let tries = 0; r?.look && tries < 5; tries++) {
        const look = lookSchema.safeParse(JSON.parse(r.look));
        if (!look.success) break;
        const l = look.data;
        const next: Look = { ...l, cast: l.cast.filter((c) => c.id !== id), style: l.style === id ? null : l.style, snippets: l.snippets.filter((x) => x !== id) };
        if (JSON.stringify(next) === JSON.stringify(l)) break;
        const done = await db.updateTable(table).set({ look: JSON.stringify(next) }).where("id", "=", r.id).where("look", "=", r.look).executeTakeFirst();
        if (Number(done.numUpdatedRows)) {
          if (table === "drafts") drafts++;
          else timelines++;
          break;
        }
        r = await db.selectFrom(table).select(["id", "look"]).where("id", "=", r.id).executeTakeFirst();
      }
    }
  }
  // the drafts not written yet (a tab's blank "New draft" with someone picked): held in memory only
  dropFromUnwritten(db, id);
  return { drafts, timelines };
}

const body = z.strictObject({ kind: z.enum(["person", "place", "style", "preset", "snippet"]), name: z.string().trim().min(1).max(120), def: z.unknown().optional() });
const patch = z.strictObject({ name: z.string().trim().min(1).max(120).optional(), def: z.unknown().optional() });

export function registerEntities(app: FastifyInstance, s: Services): void {
  const missing = () => httpError("this was not found", 404);
  const changed = () => s.queue.events.emit("entities");

  app.get("/api/entities", async (req) => {
    const { kind } = z.object({ kind: z.enum(Object.keys(defs) as [EntityKind, ...EntityKind[]]).optional() }).parse(req.query);
    let q = s.db.selectFrom("entities").selectAll().where("owner_id", "=", OWNER);
    if (kind) q = q.where("kind", "=", kind);
    const items: Array<ReturnType<typeof view> & { source?: "shipped" }> = (await q.orderBy("name").execute()).map(view);
    // the presets that ship with Afflatus come after the user's own: read-only, to apply or to copy
    if (!kind || kind === "preset") items.push(...s.shippedPresets.list().map((p) => s.shippedPresets.entity(p)));
    return { items };
  });

  /**
   * The kit is changed one change at a time: a person's pictures taken off go to the bin unless someone else names them,
   * which is read across the whole kit, and a change saved from the row as read put back what another had changed meanwhile.
   */
  const inTurn = <T>(work: () => Promise<T>) => oneAtATime(s.db, "kit", work);

  // a person's cut-outs (kitCutouts.ts) are asked for once they are saved: their pictures may be new, or the switch on
  const askFor = (view: { id: string; kind: string }) => {
    if (view.kind === "person") void askCutouts(s, [view.id]).catch((err: Error) => console.warn(`[kit] cut-outs not asked for: ${err.message}`));
    return view;
  };

  app.post("/api/entities", async (req) => askFor(await inTurn(async () => {
    const b = body.parse(req.body);
    // (a person's cut-outs are the server's to write: a new one has none yet)
    const def = b.kind === "person" ? { ...defs.person.parse(b.def ?? {}), cutouts: {} } : defs[b.kind].parse(b.def ?? {});
    const at = now();
    const row: Tables["entities"] = { id: newId(), owner_id: OWNER, kind: b.kind, name: b.name, def: JSON.stringify(def), created_at: at, updated_at: at };
    await s.db.insertInto("entities").values(row).execute();
    await keepTheirs(row.kind, row.def);
    changed();
    return view(row);
  })));

  /** Their pictures and voices are wanted: they never go to the bin on their own. */
  const keepTheirs = async (kind: string, def: string) => {
    if (kind !== "person" && kind !== "place") return;
    const d = JSON.parse(def) as { pictures: string[]; voice?: string | null; outfits?: Array<{ picture: string | null }> };
    const used = [...d.pictures, d.voice, ...(d.outfits ?? []).map((o) => o.picture)].filter((x): x is string => Boolean(x));
    if (used.length) await s.db.updateTable("assets").set({ kept_at: now() }).where("id", "in", used).where("kept_at", "is", null).execute();
  };

  const builtIn = () => httpError("a built-in preset cannot be changed: copy it to your presets first");

  app.put<{ Params: { id: string } }>("/api/entities/:id", async (req) => askFor(await inTurn(async () => {
    if (req.params.id.startsWith(SHIPPED)) throw builtIn();
    const b = patch.parse(req.body);
    const row = await s.db.selectFrom("entities").selectAll().where("id", "=", req.params.id).executeTakeFirst();
    if (!row) throw missing();
    const parsed = b.def === undefined ? null : (defs[row.kind].parse(b.def) as Record<string, unknown>);
    const next = { name: b.name ?? row.name, def: parsed === null ? row.def : JSON.stringify(row.kind === "person" ? keptCutouts(row.def, parsed) : parsed), updated_at: now() };
    await s.db.updateTable("entities").set(next).where("id", "=", row.id).execute();
    // a picture uploaded for them and taken off again, wanted by no one else: to the bin
    if (b.def !== undefined) await binUnwantedKit(s.db, filesOf(row.def).filter((id) => !filesOf(next.def).includes(id)));
    if (b.def !== undefined) await keepTheirs(row.kind, next.def);
    changed();
    return view({ ...row, ...next });
  })));

  app.delete<{ Params: { id: string } }>("/api/entities/:id", async (req) => inTurn(async () => {
    if (req.params.id.startsWith(SHIPPED)) throw builtIn();
    const row = await s.db.selectFrom("entities").select("def").where("id", "=", req.params.id).executeTakeFirst();
    const r = await s.db.deleteFrom("entities").where("id", "=", req.params.id).executeTakeFirst();
    if (!Number(r.numDeletedRows)) throw missing();
    // the pictures uploaded for them (not those picked from the library), wanted by no one else: to the bin
    if (row) await binUnwantedKit(s.db, filesOf(row.def));
    const cut = await dropFromLooks(s.db, req.params.id);
    changed();
    if (cut.timelines) s.queue.events.emit("timeline");
    return { ok: true };
  }));

  /** What a form becomes once its cast and style are worked in: shown before it is sent. Nothing is queued. */
  app.post("/api/compose", async (req) => {
    const b = z.strictObject({ recipe: z.string().min(1), input: z.record(z.string(), z.unknown()), look: lookSchema }).parse(req.body);
    const recipe = s.registry.recipe(b.recipe);
    if (!recipe) throw httpError(`there is no recipe called ${b.recipe}`);
    return compose(s.db, recipe, b.input, b.look);
  });
}
