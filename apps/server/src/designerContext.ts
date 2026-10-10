import { modelOf, secondsOf, type InputSpec, type LoraValue, type Recipe } from "@afflatus/core";
import { emptyLook, type Look } from "./entities";
import { madeIn } from "./provenance";
import type { Services } from "./services";

/** The text boxes of a recipe: what the designer may write in. */
export const boxesOf = (recipe: Recipe<any>) => (recipe.inputs as InputSpec[]).filter((i): i is Extract<InputSpec, { type: "prompt" }> => i.type === "prompt");

export interface DesignerContext {
  /** What each text box holds now (input id → text). */
  values: Record<string, string>;
  seconds?: number | null;
  /** What the clip before it says happens, when this clip carries on from it. */
  previous?: string;
  /** What the clip after it says happens, when this clip has to end where that one begins. */
  next?: string;
  /** The clip is put between two others, in place of a stretch that was cut out. */
  between?: boolean;
  /** The whole video this clip is part of: what every clip says happens, in the order they play, and which one is being written. */
  story?: { clips: string[]; index: number };
  opensOnPicture?: boolean;
  endsOnPicture?: boolean;
  /**
   * How the pictures of the form were made, when Afflatus made them: every step back to the first prompt
   * (a picture that was upscaled, edited, or saved out of a video has its story behind it). It is what a
   * picture shows, in words, for a language model that cannot look at it, and a help for one that can.
   */
  madeFrom?: Array<{ what: string; steps: Array<{ title: string; with?: string; text: string; more: Array<{ label: string; text: string }>; loras: Array<{ name: string; trigger?: string }> }> }>;
  /** Who is in it, as names with their words: they are added on their own, the designer must not repeat them. */
  cast?: Array<{ name: string; words: string }>;
  /** The look and mood of the whole video. */
  mood?: string;
  loras?: Array<{ name: string; weight: number; trigger?: string }>;
  /** Bits of text the user ticked: they are added after the main text on their own. */
  snippets?: Array<{ name: string; text: string }>;
  /** The model makes the sound too: people can speak in the clip. */
  speaks?: boolean;
  /** The model file picked in the form, by name, when the form has a model picker: a guide can speak by lineage. */
  model?: string | null;
  /** Whether the picture is given to the language model with the request. */
  seesPicture?: boolean;
}

/** A LoRA file's name as its words are filed under: lower case, without its sub-folder. */
const nameOf = (file: string) => (file.split(/[\\/]/).pop() ?? file).toLowerCase();
/** A LoRA file's name to say: without its folder and its extension. */
const shortName = (file: string) => (file.split(/[\\/]/).pop() ?? file).replace(/\.[a-z]+$/i, "");

/**
 * What the designer is told about a form, read from the database: who is in it, the picture it opens on,
 * how its pictures and the clip it carries on from were made, the LoRAs with their trigger words.
 */
export function designerContext(s: Services) {
  /** Who is in it, with their words in the form the recipe's main text is written in. */
  async function castOf(recipe: Recipe<any>, look: Look | null | undefined) {
    if (emptyLook(look)) return [];
    const rows = await s.db.selectFrom("entities").selectAll().where("id", "in", look!.cast.map((c) => c.id)).execute();
    const tags = boxesOf(recipe).find((b) => !b.optional)?.style === "tags";
    return look!.cast.flatMap((member) => {
      const row = rows.find((r) => r.id === member.id);
      if (!row) return [];
      const d = JSON.parse(row.def) as { tags?: string; sentence?: string; outfits?: Array<{ id: string; tags: string; sentence: string }> };
      const worn = d.outfits?.find((o) => o.id === member.outfit);
      return [{ name: row.name, words: [tags ? d.tags : d.sentence, tags ? worn?.tags : worn?.sentence].filter(Boolean).join(tags ? ", " : " ") }];
    });
  }

  /** The picture a form opens on, small, as something a language model that reads pictures can be shown. */
  async function pictureOf(recipe: Recipe<any>, values: Record<string, unknown>): Promise<string | null> {
    const spec = (recipe.inputs as InputSpec[]).find((i) => i.type === "image" && (i.role === "start" || i.role === "source"));
    const id = spec ? values[spec.id] : undefined;
    if (typeof id !== "string") return null;
    const asset = await s.db.selectFrom("assets").select(["thumb_key", "file_key", "mime", "kind"]).where("id", "=", id).executeTakeFirst();
    if (!asset || asset.kind !== "image") return null;
    const bytes = await s.storage.get(asset.thumb_key ?? asset.file_key).catch(() => null);
    return bytes ? `data:${asset.thumb_key ? "image/webp" : asset.mime};base64,${Buffer.from(bytes).toString("base64")}` : null;
  }

  /** What a LoRA is called up by: the user's own words for it, else what its file says, else what its page gave. */
  async function triggersOf(files: string[]): Promise<(file: string) => string | undefined> {
    if (!files.length) return () => undefined;
    const info = await s.db.selectFrom("model_info").select(["file", "info"]).where("folder", "=", "loras").where("file", "in", files).execute();
    const words = await s.db.selectFrom("model_words").select(["name", "own", "found"]).where("folder", "=", "loras").where("name", "in", files.map(nameOf)).execute();
    return (file) =>
      words.find((w) => w.name === nameOf(file))?.own || (JSON.parse(info.find((x) => x.file === file)?.info ?? "{}") as { trigger?: string }).trigger || words.find((w) => w.name === nameOf(file))?.found || undefined;
  }

  /** The pictures of a form that have a story: the one it opens on, ends on or starts from. */
  const PICTURES: Record<string, string> = { start: "The picture that is the first frame", end: "The picture that is the last frame", source: "The picture it starts from" };

  /**
   * How the pictures of a form were made: for each picture the form starts from, opens on or ends on
   * that Afflatus made itself, every step back to its first prompt.
   */
  async function madeFrom(recipe: Recipe<any>, values: Record<string, unknown>): Promise<NonNullable<DesignerContext["madeFrom"]>> {
    const out: NonNullable<DesignerContext["madeFrom"]> = [];
    const told = async (what: string, id: string) => {
      const steps = await madeIn(s, id);
      // a trail with no text anywhere says nothing about what it shows
      if (!steps.some((x) => x.text)) return;
      const trigger = await triggersOf(steps.flatMap((x) => x.loras.map((l) => l.file)));
      out.push({
        what,
        steps: steps.map((x) => ({
          title: x.title, with: x.family, text: x.text, more: x.more,
          loras: x.loras.map((l) => ({ name: shortName(l.file), trigger: trigger(l.file) })),
        })),
      });
    };
    for (const spec of recipe.inputs as InputSpec[]) {
      const value = values[spec.id];
      if (spec.type === "image" && spec.role && spec.role in PICTURES && typeof value === "string") await told(PICTURES[spec.role]!, value);
      // the clip it carries on from: its whole story, the clips before it and the picture it opened on included
      const from = spec.type === "clip" && spec.role === "previous" ? (value as { asset?: string } | undefined)?.asset : undefined;
      if (typeof from === "string") await told("The clip this one carries on from", from);
    }
    return out;
  }

  /** What the clip a form carries on from says happens, when Afflatus made that clip: its own text, the latest step of its story. */
  async function carriedOn(recipe: Recipe<any>, values: Record<string, unknown>): Promise<string | undefined> {
    const spec = (recipe.inputs as InputSpec[]).find((i) => i.type === "clip" && i.role === "previous");
    const from = spec ? (values[spec.id] as { asset?: string } | undefined)?.asset : undefined;
    if (typeof from !== "string") return undefined;
    const steps = await madeIn(s, from);
    return [...steps].reverse().find((x) => x.kind === "video" && x.text)?.text;
  }

  /** Everything the designer is told about a form, as the system prompt says it (see systemPrompt). */
  async function context(recipe: Recipe<any>, values: Record<string, unknown>, extra: { previous?: string; story?: DesignerContext["story"]; look?: Look | null; mood?: string }, sees: boolean): Promise<DesignerContext> {
    const specs = recipe.inputs as InputSpec[];
    const text: Record<string, string> = {};
    for (const b of boxesOf(recipe)) text[b.id] = typeof values[b.id] === "string" ? (values[b.id] as string) : "";
    const has = (role: "start" | "end") => specs.some((i) => i.type === "image" && i.role === role && typeof values[i.id] === "string");
    const loraSpec = specs.find((i) => i.type === "loras");
    const loras = loraSpec && Array.isArray(values[loraSpec.id]) ? (values[loraSpec.id] as LoraValue[]) : [];
    const trigger = await triggersOf(loras.map((l) => l.file));
    const ticked = extra.look?.snippets?.length ? await s.db.selectFrom("entities").select(["id", "name", "def"]).where("kind", "=", "snippet").where("id", "in", extra.look.snippets).execute() : [];
    return {
      values: text,
      seconds: secondsOf(specs, values),
      // on a timeline the clip before is told by the page; in Studio, a clip that carries on from a video Afflatus made knows that video's text
      previous: extra.previous ?? (await carriedOn(recipe, values)),
      story: extra.story,
      opensOnPicture: has("start"),
      endsOnPicture: has("end"),
      madeFrom: await madeFrom(recipe, values),
      cast: await castOf(recipe, extra.look),
      mood: extra.mood,
      loras: loras.filter((l) => l.weight !== 0).map((l) => ({ name: shortName(l.file), weight: l.weight, trigger: trigger(l.file) })),
      snippets: ticked.map((r) => ({ name: r.name, text: String((JSON.parse(r.def) as { text?: string }).text ?? "") })).filter((x) => x.text.trim()),
      speaks: Boolean(recipe.traits?.sound),
      seesPicture: sees,
      model: modelOf(specs, values),
    };
  }

  return { castOf, pictureOf, triggersOf, madeFrom, carriedOn, context };
}
