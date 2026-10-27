import { LIMITS, plural, presetFileSchema, provenanceSchema, type InputSpec, type LoraValue, type Recipe, type ReferenceRole, type ReferenceValue } from "@afflatus/core";
import { familyById, recipes } from "@afflatus/recipes";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { httpError } from "./errors";
import { oneAtATime } from "./keyedLock";
import { newId, now, OWNER, type Db, type Tables } from "./db";
import { SHIPPED } from "./presetFiles";
import type { Services } from "./services";
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

/** A name as "@name" finds it: case, spaces and signs left out ("@nicolas", "@Nicolas_D" for "Nicolas D"). */
const nameKey = (s: string) => s.toLowerCase().replace(/[^\p{L}\d]+/gu, "");

/**
 * "@Nicolas" in a form's texts (a prompt part, What happens): the Prompt kit person of that name cast for this render, as
 * if picked in the cast (their pictures, LoRA and voice come with them), and in the text the words that say how they look,
 * since a name means nothing to the model (the owner, 2026-10-20; H3 drew whoever it pleased for a bare name). A name that
 * is no one's stays as it was typed.
 */
export async function withMentions(db: Db, recipe: Recipe<any>, raw: Record<string, unknown>, look: Look | null | undefined): Promise<{ input: Record<string, unknown>; look: Look | null | undefined }> {
  const texts = (recipe.inputs as InputSpec[]).filter((i) => i.type === "prompt" && typeof raw[i.id] === "string" && (raw[i.id] as string).includes("@"));
  if (!texts.length) return { input: raw, look };
  const people = await db.selectFrom("entities").selectAll().where("kind", "=", "person").execute();
  const byName = new Map(people.map((p) => [nameKey(p.name), p]));
  const cast = [...(look?.cast ?? [])];
  const input = { ...raw };
  for (const spec of texts) {
    input[spec.id] = String(raw[spec.id]).replace(/@([\p{L}\d_-]+)/gu, (all, name: string) => {
      const row = byName.get(nameKey(name));
      if (!row) return all;
      if (!cast.some((c) => c.id === row.id)) cast.push({ id: row.id });
      const said = (defs.person.parse(JSON.parse(row.def)) as PersonDef).sentence.trim().replace(/[.\s]+$/, "");
      return said ? `the person (${said})` : "the person";
    });
  }
  return { input, look: cast.length === (look?.cast.length ?? 0) ? look : { cast, style: look?.style ?? null, snippets: look?.snippets ?? [] } };
}

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
/** Each kind's def, as a save checks it (MCP's new_kit_item and edit_kit_item check theirs with them). */
export const kitDefs = defs;
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
  added: { /** The words put in, whose they are and what kind of kit item gave them. */ words: Array<{ from: string; text: string; kind: "person" | "place" | "snippet" | "style" }>; loras: Array<{ from: string; file: string }>; references: number; /** The reference pictures added, and whose they are. */ refs: Array<{ asset: string; role: ReferenceRole; from: string }>; voice: string | null; /** The voice sample added: the form shows it in its sound field. */ voiceAsset: string | null; /** The part of it set on the person. */ voicePart?: { start: number; seconds: number }; skipped: string[]; /** The form's last frame is left out: the cast's pictures or voice make the model take the reference way (MiniMax H3). */ endDropped?: boolean };
}

/** The files an entity's definition names: its pictures, its outfits' pictures and its voice sample. */
const filesOf = (def: string): string[] => {
  const d = JSON.parse(def) as { pictures?: string[]; voice?: string | null; outfits?: Array<{ picture?: string | null }> };
  return [...(d.pictures ?? []), d.voice, ...(d.outfits ?? []).map((o) => o.picture)].filter((x): x is string => Boolean(x));
};

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
  // sentences put one after another each end with a full stop, or a person's words run into what is written ("…sweater She turns")
  const parts = [...before.map(fresh), own, ...after.map(fresh)].map((p) => p.trim().replace(/^[,\s]+|[,\s]+$/g, "")).filter(Boolean);
  return parts.map((p, i) => (i < parts.length - 1 && !/[.!?…:;]["'”’)\]]*$/.test(p) ? `${p}.` : p)).join(" ");
}

/** Another model of the same maker and output whose form takes reference pictures ("LTX 2.5" for LTX 2.3), when there is one. */
function takesReferences(recipe: Recipe<any>, name: string): string | undefined {
  const maker = name.split(" ")[0]!.toLowerCase();
  const other = recipes.find((r) => r.family !== recipe.family && r.output === recipe.output && !r.hidden && (r.inputs as InputSpec[]).some((i) => i.type === "references" && !i.media) && familyById(r.family)?.name.split(" ")[0]!.toLowerCase() === maker);
  return other && familyById(other.family)?.name;
}

/** The look and mood of a whole video go at the end of what happens, like a style's words. */
export function withMood(recipe: Recipe<any>, input: Record<string, unknown>, mood: string | null | undefined): Record<string, unknown> {
  const words = mood?.trim();
  const specs = recipe.inputs as InputSpec[];
  // (nor a text the recipe builds its own prompt from: a swap's "who to replace")
  const main = specs.find((i) => i.type === "prompt" && !i.optional && !i.noCast) ?? specs.find((i) => i.type === "prompt" && !i.noCast);
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
export async function compose(db: Db, recipe: Recipe<any>, asked: Record<string, unknown>, askedLook: Look | null | undefined): Promise<Composed> {
  // a Prompt kit person named "@Nicolas" in a text: cast for this render, and said by how they look (withMentions)
  const { input: raw, look } = await withMentions(db, recipe, asked, askedLook);
  const input = { ...raw };
  // the picture a take's face is scored against is the cast's of this render alone: one carried over in a form copied from an
  // older job's (a take used again) would score against someone no longer cast
  const faceSpec = (recipe.inputs as InputSpec[]).find((i) => i.type === "image" && i.role === "face");
  if (faceSpec) delete input[faceSpec.id];
  const added: Composed["added"] = { words: [], loras: [], references: 0, refs: [], voice: null, voiceAsset: null, skipped: [] };
  if (emptyLook(look)) return { input, added };
  const ids = [...look!.cast.map((c) => c.id), ...(look!.style ? [look!.style] : []), ...(look!.snippets ?? [])];
  const rows = ids.length ? await db.selectFrom("entities").selectAll().where("id", "in", ids).execute() : [];
  const byId = new Map(rows.map((r) => [r.id, r]));

  const specs = recipe.inputs as InputSpec[];
  // (a text the recipe builds its own prompt from takes no words of the cast: a swap's "who to replace")
  const main = specs.find((i) => i.type === "prompt" && !i.optional && !i.noCast) ?? specs.find((i) => i.type === "prompt" && !i.noCast);
  const tags = main?.type === "prompt" && main.style === "tags";
  const subjectSpec = specs.find((i) => i.type === "prompt" && i.holds === "subject");
  const refSpec = specs.find((i) => i.type === "references" && !i.media);
  // each picture a subject of its own (LTX 2.5's MSR slots): one per person and one per place, not more views of the same one
  const subjects = refSpec?.type === "references" && Boolean(refSpec.subjects);
  const sent = subjects ? { person: 1, place: 1 } : PICTURES;
  const voiceSpec = specs.find((i) => i.type === "audio" && i.role === "voice");
  const loraSpec = specs.find((i) => i.type === "loras");

  // each person's words are put together once the pictures sent are known (see below)
  const persons: Array<{ name: string; trigger: string; look: string; worn: string; pictures: string[] }> = [];
  const places: string[] = [];
  const looks: string[] = [];
  const bits: string[] = [];
  const refs: Array<ReferenceValue & { from: string }> = [];
  const loras: Array<LoraValue & { from: string }> = [];
  let voice: { asset: string; from: string; part: { start: number; seconds: number } | null } | null = null;

  for (const member of look!.cast) {
    const row = byId.get(member.id);
    if (!row) continue;
    if (row.kind === "person") {
      const p = defs.person.parse(JSON.parse(row.def)) as PersonDef;
      const worn = p.outfits.find((o) => o.id === member.outfit);
      const m = p.models[recipe.family];
      persons.push({ name: row.name, trigger: m?.trigger ?? "", look: (tags ? p.tags : p.sentence) ?? "", worn: (tags ? worn?.tags : worn?.sentence) ?? "", pictures: p.pictures.slice(0, sent.person) });
      if (m?.lora) loras.push({ file: m.lora, weight: m.weight, from: row.name });
      for (const asset of p.pictures.slice(0, sent.person)) refs.push({ asset, role: "person", from: row.name });
      if (worn?.picture) refs.push({ asset: worn.picture, role: "clothing", from: row.name });
      if (p.voice && !voice) voice = { asset: p.voice, from: row.name, part: p.voicePart };
    } else if (row.kind === "place") {
      const p = defs.place.parse(JSON.parse(row.def)) as PlaceDef;
      const words = tags ? p.tags : p.sentence;
      if (words.trim()) {
        places.push(words);
        added.words.push({ from: row.name, text: words.trim(), kind: "place" });
      }
      for (const asset of p.pictures.slice(0, sent.place)) refs.push({ asset, role: "place", from: row.name });
    }
  }
  // the ticked snippets, in the order they were ticked
  for (const id of look!.snippets ?? []) {
    const row = byId.get(id);
    if (row?.kind !== "snippet") continue;
    const text = defs.snippet.parse(JSON.parse(row.def)).text.trim();
    if (!text) continue;
    bits.push(text);
    added.words.push({ from: row.name, text, kind: "snippet" });
  }
  const styleRow = look!.style ? byId.get(look!.style) : undefined;
  if (styleRow?.kind === "style") {
    const m = (defs.style.parse(JSON.parse(styleRow.def)) as StyleDef).models[recipe.family];
    if (m?.words.trim()) {
      looks.push(m.words);
      added.words.push({ from: styleRow.name, text: m.words.trim(), kind: "style" });
    }
    for (const l of m?.loras ?? []) loras.push({ ...l, from: styleRow.name });
    if (!m) added.skipped.push(`${styleRow.name} is not set up for this model`);
  }

  // ---- reference pictures and the voice, for the recipes that take them
  // the voice goes with the first picture where each is a subject of its own: its owner's picture is put first, and their
  // words, so that the first person described is the first picture
  if (subjects && voice) {
    const owner = voice.from;
    refs.sort((a, b) => Number(!(a.from === owner && a.role === "person")) - Number(!(b.from === owner && b.role === "person")));
    persons.sort((a, b) => Number(a.name !== owner) - Number(b.name !== owner));
  }
  let withRefs = false;
  const before = refSpec ? (Array.isArray(input[refSpec.id]) ? (input[refSpec.id] as unknown[]).length : 0) : 0;
  const hadVoice = Boolean(voiceSpec && input[voiceSpec.id]);
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

  // the picture the take's face is scored against, on a model that takes no reference pictures (LTX 2.3, Wan): the first cast
  // person's first, as H3's take is scored against its cast's
  const faced = refs.find((r) => r.role === "person");
  if (faceSpec && faced) {
    const alive = await db.selectFrom("assets").select("id").where("id", "=", faced.asset).where("deleted_at", "is", null).where("kind", "=", "image").executeTakeFirst();
    if (alive) input[faceSpec.id] = faced.asset;
  }
  // and that model is told it in words: only the face score reads those pictures, so a cast person's look comes from their words
  // and LoRA alone. A model of the same name that does take them is named (LTX 2.3's, LTX 2.5).
  if (faceSpec && !refSpec) {
    const pictured = [...new Set(refs.map((r) => r.from))];
    if (pictured.length) {
      const name = familyById(recipe.family)?.name ?? recipe.family;
      const other = takesReferences(recipe, name);
      added.skipped.push(`${pictured.length === 1 ? `${pictured[0]}'s pictures aren't` : `The pictures of ${pictured.join(" and ")} aren't`} used: ${name} takes no reference pictures${other ? ` (${other} does)` : ""}`);
    }
  }

  // a model that follows reference pictures and was given an end frame makes the clip from the references instead (MiniMax H3);
  // one that takes each picture as a subject of its own guides with them beside its last frame (LTX 2.5)
  const endSpec = specs.find((i) => i.type === "image" && i.role === "end");
  if (endSpec && !subjects && input[endSpec.id] && !before && !hadVoice && (added.references > 0 || added.voiceAsset)) {
    added.endDropped = true;
    added.skipped.push(`The last frame is not used: with ${added.references > 0 ? "the cast's reference images" : "the cast's voice sample"}, it renders with its reference model, which takes no last frame`);
  }

  // ---- the people's words. A model that takes who someone is from their pictures alone (Klein, Qwen edit: no
  // place of its own for how people look) is not told it again in words: its guides say a face a picture shows
  // is pointed at, never described, and words that describe it fight the picture. What they wear stays. A model that takes
  // each picture as a subject of its own is told how each one looks as well: its LoRA's authors ask for it (LTX 2.5's MSR).
  const given = new Set(refSpec?.type === "references" && Array.isArray(input[refSpec.id]) ? (input[refSpec.id] as ReferenceValue[]).map((r) => r.asset) : []);
  const pictured = (who: (typeof persons)[number]) => !tags && !subjectSpec && !subjects && who.pictures.some((a) => given.has(a));
  const people = persons.flatMap((who) => {
    // a trigger is a LoRA's own words, a tag in either way of writing: in sentences it opens them, as a line of its own
    const trigger = who.trigger.trim().replace(/[,.\s]+$/, "");
    const words = tags
      ? join([trigger, who.look, who.worn], ", ")
      : join([trigger && `${trigger}.`, pictured(who) ? "" : who.look, who.worn], " ");
    if (!words) return [];
    added.words.push({ from: who.name, text: words, kind: "person" });
    return [words];
  });

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

export const kitBody = z.strictObject({ kind: z.enum(["person", "place", "style", "preset", "snippet"]), name: z.string().trim().min(1).max(120), def: z.unknown().optional() });
const patch = z.strictObject({ name: z.string().trim().min(1).max(120).optional(), def: z.unknown().optional() });

/**
 * The kit is changed one change at a time: a person's pictures taken off go to the bin unless someone else names them,
 * which is read across the whole kit, and a change saved from the row as read put back what another had changed meanwhile.
 */
const inTurn = <T>(s: Services, work: () => Promise<T>) => oneAtATime(s.db, "kit", work);

/** Their pictures and voices are wanted: they never go to the bin on their own. */
async function keepTheirs(s: Services, kind: string, def: string): Promise<void> {
  if (kind !== "person" && kind !== "place") return;
  const d = JSON.parse(def) as { pictures: string[]; voice?: string | null; outfits?: Array<{ picture: string | null }> };
  const used = [...d.pictures, d.voice, ...(d.outfits ?? []).map((o) => o.picture)].filter((x): x is string => Boolean(x));
  if (used.length) await s.db.updateTable("assets").set({ kept_at: now() }).where("id", "in", used).where("kept_at", "is", null).execute();
}

const builtIn = () => httpError("a built-in preset cannot be changed: copy it to your presets first");

/** An item of the kit as the page reads it. */
export type KitItem = ReturnType<typeof view>;

/** The kit, of one kind or all, the shipped presets after the user's own (GET /api/entities, MCP's list_kit). */
export async function kitList(s: Services, kind?: EntityKind): Promise<Array<KitItem & { source?: "shipped" }>> {
  let q = s.db.selectFrom("entities").selectAll().where("owner_id", "=", OWNER);
  if (kind) q = q.where("kind", "=", kind);
  const items: Array<KitItem & { source?: "shipped" }> = (await q.orderBy("name").execute()).map(view);
  // the presets that ship with Afflatus come after the user's own: read-only, to apply or to copy
  if (!kind || kind === "preset") items.push(...s.shippedPresets.list().map((p) => s.shippedPresets.entity(p)));
  return items;
}

/** A new item of the kit (POST /api/entities, MCP's new_kit_item): its def checked as its kind takes it, its pictures kept. */
export const kitNew = (s: Services, b: z.output<typeof kitBody>) => inTurn(s, async () => {
  const def = defs[b.kind].parse(b.def ?? {});
  const at = now();
  const row: Tables["entities"] = { id: newId(), owner_id: OWNER, kind: b.kind, name: b.name, def: JSON.stringify(def), created_at: at, updated_at: at };
  await s.db.insertInto("entities").values(row).execute();
  await keepTheirs(s, row.kind, row.def);
  s.queue.events.emit("entities");
  return view(row);
});

/**
 * An item of the kit changed (PUT /api/entities/:id, the page's autosave; MCP's edit_kit_item): its name, or its whole
 * def checked as its kind takes it. `change` works the def out from the item as it is in the kit's turn (an agent's
 * change laid over what the page saved meanwhile). Answers it before and after.
 */
export const kitEdit = (s: Services, id: string, change: (row: KitItem) => z.output<typeof patch>) => inTurn(s, async () => {
  if (id.startsWith(SHIPPED)) throw builtIn();
  const row = await s.db.selectFrom("entities").selectAll().where("id", "=", id).executeTakeFirst();
  if (!row) throw httpError("this was not found", 404);
  const b = change(view(row));
  const next = { name: b.name ?? row.name, def: b.def === undefined ? row.def : JSON.stringify(defs[row.kind].parse(b.def)), updated_at: now() };
  await s.db.updateTable("entities").set(next).where("id", "=", row.id).execute();
  // a picture uploaded for them and taken off again, wanted by no one else: to the bin
  if (b.def !== undefined) await binUnwantedKit(s.db, filesOf(row.def).filter((f) => !filesOf(next.def).includes(f)));
  if (b.def !== undefined) await keepTheirs(s, row.kind, next.def);
  s.queue.events.emit("entities");
  return { before: view(row), after: view({ ...row, ...next }) };
});

export function registerEntities(app: FastifyInstance, s: Services): void {
  const missing = () => httpError("this was not found", 404);
  const changed = () => s.queue.events.emit("entities");

  app.get("/api/entities", async (req) => {
    const { kind } = z.object({ kind: z.enum(Object.keys(defs) as [EntityKind, ...EntityKind[]]).optional() }).parse(req.query);
    return { items: await kitList(s, kind) };
  });

  app.post("/api/entities", async (req) => kitNew(s, kitBody.parse(req.body)));

  app.put<{ Params: { id: string } }>("/api/entities/:id", async (req) => {
    const b = patch.parse(req.body);
    return (await kitEdit(s, req.params.id, () => b)).after;
  });

  app.delete<{ Params: { id: string } }>("/api/entities/:id", async (req) => inTurn(s, async () => {
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
