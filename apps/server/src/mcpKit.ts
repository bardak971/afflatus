import { plural } from "@afflatus/core";
import { z } from "zod";
import { kitBody, kitDefs, kitEdit, kitList, kitNew, type EntityKind, type KitItem } from "./entities";
import { httpError } from "./errors";
import { tool, type ToolCtx } from "./mcpTool";
import { refusal } from "./mcpTokens";
import { SHIPPED } from "./presetFiles";
import type { Services } from "./services";

/**
 * The Prompt kit, from outside (MCP): its people, places, styles, snippets and presets listed and read, made and changed
 * through the kit's own save (entities.ts kitNew, kitEdit: the page's autosave path, one change at a time), each def
 * checked as a save checks it, and the library items it names (pictures, a voice sample) checked as the page's slots
 * take them. Each change an agent makes goes out as a "kit" live event (KitEdit), so that the kit open on that item shows
 * it at once, rings what changed with the token's name, and offers Undo (the web's agentEdits.ts), as a draft does.
 */

/** One part of an item's def an agent changed (its pictures, its words, its LoRAs): what it held before (`had` false: nothing) and holds now. */
export interface KitField { key: string; had: boolean; was?: unknown; now: unknown }

/**
 * What a "kit" live event says (events.ts relays it whole): the item, the token behind it, the parts of its def it changed
 * with their values before and after, and its name when that changed. The page lays `now` over what it shows and puts
 * `was` back on Undo. `made`: an item just made (the lists read again; nothing is open on it yet).
 */
export interface KitEdit {
  id: string;
  kind: string;
  by: string;
  token: string;
  at: string;
  fields: KitField[];
  name?: { was: string; now: string };
  made?: true;
  /** When the item was saved with it (its updatedAt then): a save of the page's answered with a later one was written over it. */
  saved?: string;
}

const KINDS = ["person", "place", "style", "snippet", "preset"] as const satisfies readonly EntityKind[];

/** How "@Name" casts a person in a prompt: the name with its spaces and signs as "_" (withMentions reads it without them). */
const mentionOf = (name: string) => `@${name.trim().replace(/[^\p{L}\d]+/gu, "_").replace(/^_+|_+$/g, "")}`;

/** A def as an object, for reading its parts. */
const defOf = (item: Pick<KitItem, "def">) => (item.def && typeof item.def === "object" ? (item.def as Record<string, unknown>) : {});

/** An item as list_kit says it: what it is, the words that say it, how many pictures, a voice. */
function summaryOf(item: KitItem & { source?: string }) {
  const d = defOf(item);
  const words = String(d.sentence || d.tags || d.text || "").trim();
  const pictures = Array.isArray(d.pictures) ? d.pictures.length : 0;
  return {
    id: item.id, kind: item.kind, name: item.name,
    ...(item.kind === "person" ? { mention: mentionOf(item.name) } : {}),
    ...(words ? { words: words.length > 160 ? `${words.slice(0, 157)}…` : words } : {}),
    ...(pictures ? { pictures } : {}),
    ...(d.voice ? { voice: true } : {}),
    ...(item.kind === "style" || item.kind === "person" ? { families: Object.keys((d.models as Record<string, unknown> | undefined) ?? {}) } : {}),
    ...(item.kind === "preset" && typeof d.recipe === "string" ? { form: d.recipe } : {}),
    ...(item.kind === "snippet" && d.category ? { category: d.category } : {}),
    ...(item.source === "shipped" ? { shipped: true } : {}),
  };
}

/** An item of the kit by id or name (a person's "@Name" too), refused with what there is. */
async function kitItem(s: Services, asked: string): Promise<KitItem & { source?: "shipped" }> {
  const all = await kitList(s);
  const key = (n: string) => n.toLowerCase().replace(/^@/, "").replace(/[^\p{L}\d]+/gu, "");
  const found = all.find((e) => e.id === asked) ?? all.find((e) => key(e.name) === key(asked));
  if (!found) throw httpError(`There is nothing called ${asked} in the Prompt kit: list_kit gives its items.`, 404);
  return found;
}

/**
 * The library items a def names, checked as the page's slots take them: pictures (a person's, a place's, an outfit's) that
 * are pictures, a voice sample that is a sound or a video with sound, none in the bin.
 */
async function checkMedia(s: Services, kind: string, def: Record<string, unknown>): Promise<void> {
  if (kind !== "person" && kind !== "place") return;
  const pictures = [...((def.pictures as string[] | undefined) ?? []), ...((def.outfits as Array<{ picture: string | null }> | undefined) ?? []).flatMap((o) => (o.picture ? [o.picture] : []))];
  const voice = typeof def.voice === "string" ? def.voice : null;
  const ids = [...new Set([...pictures, ...(voice ? [voice] : [])])];
  if (!ids.length) return;
  const rows = await s.db.selectFrom("assets").select(["id", "kind", "has_sound", "deleted_at"]).where("id", "in", ids).execute();
  for (const id of pictures) {
    const a = rows.find((r) => r.id === id);
    if (!a || a.deleted_at) throw httpError(`There is no library item ${id}${a ? " outside the bin" : ""}: search_library gives the ids.`);
    if (a.kind !== "image") throw httpError(`${id} is ${a.kind === "video" ? "a video" : "a sound"}: a reference picture has to be a picture (save_frame takes one from a video).`);
  }
  if (voice) {
    const a = rows.find((r) => r.id === voice);
    if (!a || a.deleted_at) throw httpError(`There is no library item ${voice}${a ? " outside the bin" : ""}: search_library gives the ids.`);
    if (a.kind === "image" || (a.kind === "video" && !a.has_sound)) throw httpError(`The voice sample has to be a sound, or a video with sound: ${voice} is ${a.kind === "image" ? "a picture" : "a video without sound"}.`);
  }
}

/** A def checked as a save of its kind checks it (entities.ts), said in the tool's words. */
function checkedDef(kind: EntityKind, def: unknown): Record<string, unknown> {
  const got = kitDefs[kind].safeParse(def);
  if (!got.success) throw httpError(`${kind}: ${got.error.issues.map((i) => `${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}`).join("; ")}`);
  return got.data as Record<string, unknown>;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** What changed between an item before and after an agent's save: the event the open kit gets. */
export function kitEditOf(before: KitItem, after: KitItem, ctx: Pick<ToolCtx, "token">): KitEdit {
  const was = defOf(before);
  const now = defOf(after);
  const fields: KitField[] = [];
  for (const key of new Set([...Object.keys(was), ...Object.keys(now)])) {
    if (same(was[key], now[key])) continue;
    fields.push({ key, had: key in was, ...(key in was ? { was: was[key] } : {}), now: now[key] });
  }
  return {
    id: after.id, kind: after.kind, by: ctx.token.name, token: ctx.token.id, at: new Date().toISOString(), fields, saved: after.updatedAt,
    ...(before.name !== after.name ? { name: { was: before.name, now: after.name } } : {}),
  };
}

/** The shape of each kind's def, said to the agent (the parts it may set). */
const DEF_HELP = "person: pictures (library picture ids, the first is the main one), voice (a sound's id, or a video with sound), voicePart ({start, seconds}), tags, sentence (how they look, as tags and as natural language), models ({family: {lora, weight, trigger}}), outfits ([{id, name, tags, sentence, picture}]). place: pictures, tags, sentence. style: models ({family: {loras: [{file, weight}], words}}). snippet: text, category, style (\"tags\" | \"sentences\" | null). preset: recipe (a form's id), inputs ({input: value}), look ({cast: [{id}], style, snippets}), files (the model files it is made for: [{file, folder, url | civitai: {version}}]).";

const listKit = tool({
  name: "list_kit",
  scope: "look",
  title: "Prompt kit",
  description: "The Prompt kit: people (with the @Name that casts them in a prompt: their pictures, LoRA and voice come with them), places, styles (looks: LoRAs and words per model), snippets and presets (the user's own, then the shipped ones). Each with the words that say it, how many pictures, a voice.",
  input: { kind: z.enum(KINDS).optional() },
  async run({ kind }, ctx) {
    const items = await kitList(ctx.s, kind);
    ctx.said(`Listed the Prompt kit${kind ? `'s ${kind}s` : ""}: ${plural(items.length, "item")}`);
    return items.map(summaryOf);
  },
});

const readKitItem = tool({
  name: "read_kit_item",
  scope: "look",
  title: "Read a kit item",
  description: `One item of the Prompt kit, whole: its def as the kit holds it (${DEF_HELP}). view_item shows a picture or the voice by its id.`,
  input: { item: z.string().min(1).describe("Its id, its name, or a person's @Name.") },
  async run({ item }, ctx) {
    const e = await kitItem(ctx.s, item);
    ctx.said(`Read ${e.kind} “${e.name}”`);
    return { ...summaryOf(e), def: e.def, updatedAt: e.updatedAt };
  },
});

const newKitItem = tool({
  name: "new_kit_item",
  scope: "make",
  title: "New kit item",
  description: `A new item of the Prompt kit: a person (say from a picture of the library: its id in pictures, how they look in sentence and tags), a place, a style, a snippet or a preset. ${DEF_HELP} Checked as the kit's save checks it; its pictures and voice are kept from then on. A person is cast with @Name in a prompt (edit_draft), or in a draft's cast.`,
  input: {
    kind: z.enum(KINDS),
    name: z.string().trim().min(1).max(120),
    def: z.record(z.string(), z.unknown()).optional().describe("Its parts, as above; what is left out starts empty."),
  },
  async run(a, ctx) {
    const { s } = ctx;
    const def = checkedDef(a.kind, a.def ?? {});
    await checkMedia(s, a.kind, def);
    const made = await kitNew(s, kitBody.parse({ kind: a.kind, name: a.name, def }));
    s.queue.events.emit("kit", { id: made.id, kind: made.kind, by: ctx.token.name, token: ctx.token.id, at: new Date().toISOString(), fields: [], made: true } satisfies KitEdit);
    ctx.said(`Made the ${a.kind} “${made.name}”`);
    return { ...summaryOf(made), def: made.def };
  },
});

const editKitItem = tool({
  name: "edit_kit_item",
  scope: "make",
  title: "Edit a kit item",
  description: `Change an item of the Prompt kit: its name, and any part of its def (\`set\`, each part whole: pictures is the whole list; null puts a part back to empty). ${DEF_HELP} Checked as the kit's save checks it; a picture uploaded for it and taken off goes to the bin, one of the library stays. Saved through the kit's own save path; the kit open on this item shows the change at once, ringed with this token's name, with Undo. A shipped preset cannot be changed.`,
  input: {
    item: z.string().min(1).describe("Its id, its name, or a person's @Name."),
    name: z.string().trim().min(1).max(120).optional(),
    set: z.record(z.string(), z.unknown()).optional().describe("Parts of its def → their new value (null: back to empty)."),
  },
  async run(a, ctx) {
    const { s } = ctx;
    const found = await kitItem(s, a.item);
    if (found.source === "shipped" || found.id.startsWith(SHIPPED)) throw refusal(`${found.name} ships with Afflatus and cannot be changed: new_kit_item with its def makes a copy of the user's own.`);
    const kind = found.kind as EntityKind;
    // the parts asked, laid over the item as it is in the kit's turn (the page may have saved meanwhile); null: the part's
    // empty start, or taken out for one that may be left out (a preset's form, cast, files). The parts are the def's shape:
    // an empty def leaves the optional ones out, which refused a preset's recipe, look and files
    const starts = checkedDef(kind, {});
    const parts = Object.keys(kitDefs[kind].shape);
    const lay = (def: Record<string, unknown>) => {
      const next = { ...def };
      for (const [k, v] of Object.entries(a.set ?? {})) {
        if (!parts.includes(k)) throw httpError(`A ${kind} has no part ${k}: its parts are ${parts.join(", ")}.`);
        if (v !== null) next[k] = v;
        else if (k in starts) next[k] = starts[k];
        else delete next[k];
      }
      const checked = checkedDef(kind, next);
      if (kind === "preset" && a.set && typeof a.set.recipe === "string" && !s.registry.recipe(a.set.recipe)) throw httpError(`There is no form ${a.set.recipe}: list_forms gives the forms.`);
      return checked;
    };
    // checked before the save turn too: a picture of the wrong kind is refused with nothing written
    if (a.set) await checkMedia(s, kind, lay(defOf(found)));
    const { before, after } = await kitEdit(s, found.id, (row) => ({ ...(a.name !== undefined ? { name: a.name } : {}), ...(a.set ? { def: lay(defOf(row)) } : {}) }));
    const edit = kitEditOf(before, after, ctx);
    const n = edit.fields.length + (edit.name ? 1 : 0);
    if (n) s.queue.events.emit("kit", edit);
    ctx.said(n ? `Changed ${plural(n, "part")} of ${kind} “${after.name}”` : `Left ${kind} “${after.name}” as it was`);
    return { changed: [...edit.fields.map((f) => f.key), ...(edit.name ? ["name"] : [])], item: { ...summaryOf(after), def: after.def } };
  },
});

export const KIT_TOOLS = [listKit, readKitItem, newKitItem, editKitItem];
