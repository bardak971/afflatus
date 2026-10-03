import { z } from "zod";
import type { Db } from "./db";

/** One language model the designer can write with: any OpenAI-compatible endpoint. */
export const llmSchema = z.object({
  id: z.string().min(1).max(40),
  /** What the user calls it, for the list ("Local Qwen"). Empty: the model's own name is shown. */
  name: z.string().max(60).default(""),
  baseUrl: z.string().default(""), model: z.string().default(""), apiKey: z.string().default(""),
  /** The model can read pictures: the designer is shown the picture a form opens on. */
  vision: z.boolean().default(false),
  /** How much the model can read at once, in tokens: the conversation is cut to what fits, oldest first. */
  contextSize: z.number().int().min(2048).max(2_000_000).default(16384),
  /** The longest answer it may write, in tokens. A model that thinks before it answers spends these on thinking too. */
  maxOutputTokens: z.number().int().min(256).max(65536).default(3000),
});
export type Llm = z.infer<typeof llmSchema>;

/** Instructions of the user's own for the designer, under a name: a way of writing to pick per conversation. */
const instructionSchema = z.object({ id: z.string().min(1).max(40), name: z.string().trim().min(1).max(60), text: z.string().max(8000).default("") });

/** Everything the setup page edits. Stored as one JSON value per key. */
export const settingsSchema = z.object({
  comfyUrl: z.string().url().default("http://127.0.0.1:8188"),
  /** ComfyUI's models are unloaded after this many minutes without a render. 0: never, they stay until something else needs the room. */
  unloadAfterMinutes: z.number().min(0).max(24 * 60).default(0),
  /** The language models of the prompt designer. None = the designer is off. */
  llms: z.array(llmSchema).max(12).default([]),
  /** The one the designer writes with (an id of `llms`); the first when it names none. */
  designerLlm: z.string().default(""),
  designerInstructions: z.array(instructionSchema).max(30).default([]),
  /** The instructions in use (an id of `designerInstructions`); empty for none. */
  designerInstruction: z.string().default(""),
  /** Tags written for an anime model are compared with danbooru's list, under the prompt and in what the designer writes. */
  tagCheck: z.boolean().default(true),
  /**
   * Model families switched on or off by hand, by family id. One that is not named follows its files:
   * offered when they are found on ComfyUI, left out when they are not. Off only takes it out of the
   * lists to choose from: what was made with it, and drafts that use it, stay as they are.
   */
  families: z.record(z.string().max(120), z.boolean()).default({}),
  civitaiKey: z.string().default(""),
  /** Missing model files may be looked for on Civitai. Off: studai never contacts Civitai. */
  civitaiLookups: z.boolean().default(false),
  /** Missing model files may be fetched into ComfyUI, through ComfyUI-Manager. Off: studai never asks ComfyUI to download anything. */
  downloadModels: z.boolean().default(false),
  /**
   * How many days the time of each render is kept one by one. Older ones are folded into figures per
   * model and day, which stay for good. 0: each one is kept for good.
   */
  renderHistoryDays: z.number().int().min(0).max(3650).default(90),
});
export type Settings = z.infer<typeof settingsSchema>;

/** The language model the designer writes with. */
export const llmInUse = (s: Settings): Llm | undefined => s.llms.find((l) => l.id === s.designerLlm) ?? s.llms[0];
/** The user's own instructions in use, when there are some. */
export const instructionsInUse = (s: Settings): string => s.designerInstructions.find((i) => i.id === s.designerInstruction)?.text.trim() ?? "";

export async function readSettings(db: Db): Promise<Settings> {
  const rows = await db.selectFrom("settings").select(["key", "value"]).execute();
  const raw: Record<string, unknown> = {};
  for (const r of rows) {
    try {
      raw[r.key] = JSON.parse(r.value);
    } catch {
      // a value that isn't JSON falls back to its default
    }
  }
  // before there was a list, there was one model under "llm": it is the first of the list
  const { llm: one, ...rest } = raw;
  if (rest.llms === undefined && one && typeof one === "object" && (one as { baseUrl?: string }).baseUrl) rest.llms = [{ id: "main", ...one }];
  return settingsSchema.parse(rest);
}

const KEYS = [...Object.keys(settingsSchema.shape), "llm"];

/** Merges a partial update, validates the whole, stores only the keys that were sent. */
export async function writeSettings(db: Db, patch: unknown): Promise<Settings> {
  // which keys were sent is read from the body itself: parsing it would fill in every default
  const sent = { ...z.record(z.string(), z.unknown()).parse(patch) };
  const unknown = Object.keys(sent).filter((k) => !KEYS.includes(k));
  if (unknown.length) throw Object.assign(new Error(`unknown setting: ${unknown.join(", ")}`), { statusCode: 400 });
  const current = await readSettings(db);
  // "llm" changes the model in use (or makes the first one): the short way, for one model
  if (sent.llm && typeof sent.llm === "object") {
    const used = llmInUse(current);
    const next = { ...(used ?? { id: "main" }), ...(sent.llm as object) };
    sent.llms = used ? current.llms.map((l) => (l.id === used.id ? next : l)) : [...current.llms, next];
  } else if (Array.isArray(sent.llms)) {
    // a key that is not sent again stays: the browser is never given it back to send
    sent.llms = (sent.llms as Array<{ id?: string; apiKey?: string }>).map((l) => (l.apiKey === undefined ? { ...l, apiKey: current.llms.find((c) => c.id === l.id)?.apiKey ?? "" } : l));
  }
  delete sent.llm;
  const next = settingsSchema.parse({ ...current, ...sent });
  const ids = new Set(next.llms.map((l) => l.id));
  if (ids.size !== next.llms.length) throw Object.assign(new Error("two language models have the same id"), { statusCode: 400 });
  const now = new Date().toISOString();
  for (const key of Object.keys(sent) as Array<keyof Settings>) {
    const value = JSON.stringify(next[key]);
    await db
      .insertInto("settings")
      .values({ key, value, updated_at: now })
      .onConflict((oc) => oc.column("key").doUpdateSet({ value, updated_at: now }))
      .execute();
  }
  return next;
}

/** What the browser may see: secrets are replaced by whether they are set. */
export function publicSettings(s: Settings) {
  const open = ({ apiKey, ...l }: Llm) => ({ ...l, hasApiKey: Boolean(apiKey) });
  const used = llmInUse(s);
  return {
    comfyUrl: s.comfyUrl,
    unloadAfterMinutes: s.unloadAfterMinutes,
    /** The model in use, the short way: what tells whether the designer can work. */
    llm: { baseUrl: used?.baseUrl ?? "", model: used?.model ?? "", hasApiKey: Boolean(used?.apiKey), vision: used?.vision ?? false },
    llms: s.llms.map(open),
    designerLlm: used?.id ?? "",
    designerInstructions: s.designerInstructions,
    designerInstruction: s.designerInstructions.some((i) => i.id === s.designerInstruction) ? s.designerInstruction : "",
    tagCheck: s.tagCheck,
    families: s.families,
    hasCivitaiKey: Boolean(s.civitaiKey),
    civitaiLookups: s.civitaiLookups,
    downloadModels: s.downloadModels,
    renderHistoryDays: s.renderHistoryDays,
  };
}
