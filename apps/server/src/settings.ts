import { z } from "zod";
import type { Db } from "./db";
import { httpError } from "./errors";

/** An address the server will talk to: http or https, nothing else (no file:, no ftp:). */
const httpUrl = z.url({ protocol: /^https?$/ });

/** One language model the designer can write with: any OpenAI-compatible endpoint. */
export const llmSchema = z.object({
  id: z.string().min(1).max(40),
  /** What the user calls it, for the list ("Local Qwen"). Empty: the model's own name is shown. */
  name: z.string().max(60).default(""),
  /** The endpoint's address (an http or https URL), or empty for a model not yet set up. */
  baseUrl: httpUrl.or(z.literal("")).default(""), model: z.string().default(""), apiKey: z.string().default(""),
  /** The model can read pictures: the designer is shown the picture a form opens on. */
  vision: z.boolean().default(false),
  /** How much the model can read at once, in tokens: the conversation is cut to what fits, oldest first. */
  contextSize: z.number().int().min(2048).max(2_000_000).default(16384),
  /** The longest answer it may write, in tokens. A model that thinks before it answers spends these on thinking too. */
  maxOutputTokens: z.number().int().min(256).max(65536).default(3000),
  /** Ask the model not to think before it answers (enable_thinking=false for llama.cpp, vLLM and SGLang; think=false for Ollama). A server that rejects fields it does not know answers with an error: then off. */
  noThinking: z.boolean().default(false),
});
export type Llm = z.infer<typeof llmSchema>;

/** Instructions of the user's own for the designer, under a name: a way of writing to pick per conversation. */
const instructionSchema = z.object({ id: z.string().min(1).max(40), name: z.string().trim().min(1).max(60), text: z.string().max(8000).default("") });

/** Everything the setup page edits. Stored as one JSON value per key. */
export const finishSchema = z.object({
  /** SeedVR2 (restores + enlarges, any clip), H3's latent re-sample (H3 clips; others take SeedVR2), RTX VSR, a pixel upscale model. */
  route: z.enum(["seedvr", "latent", "rtx", "model"]).default("seedvr"),
  factor: z.number().min(1).max(4).default(2),
  colour: z.enum(["lab", "wavelet", "adain", "none"]).default("lab"),
  /** The pixel route's model file; empty = the first found. */
  upscaleModel: z.string().max(200).default(""),
  latentDenoise: z.number().min(0.05).max(0.6).default(0.25),
  latentSteps: z.number().int().min(1).max(6).default(2),
  /** SeedVR2: frames restored together, 0 = by the frame's size. */
  seedvrFrames: z.number().int().min(0).max(49).default(0),
});
export type FinishSettings = z.infer<typeof finishSchema>;

export const settingsSchema = z.object({
  comfyUrl: httpUrl.default("http://127.0.0.1:8188"),
  /**
   * ComfyUI's own folder on the computer Afflatus runs on (the one with main.py), when they share a disk.
   * Lets Afflatus put a workflow where ComfyUI's page opens it straight away. Empty when ComfyUI is elsewhere.
   */
  comfyDir: z.string().max(400).default(""),
  /** ComfyUI's models are unloaded after this many minutes without a render. 0: never, they stay until something else needs the room. */
  unloadAfterMinutes: z.number().min(0).max(24 * 60).default(0),
  /** The language models of the prompt designer. None = the designer is off. */
  llms: z.array(llmSchema).max(12).default([]),
  /** The one the designer writes with (an id of `llms`); the first when it names none. */
  designerLlm: z.string().default(""),
  designerInstructions: z.array(instructionSchema).max(30).default([]),
  /** The instructions in use (an id of `designerInstructions`); empty for none. */
  designerInstruction: z.string().default(""),
  /** The user's own prompting guide for a model family (family id → text), in place of the built-in one; empty = the built-in. */
  designerGuides: z.record(z.string().max(120), z.string().max(12000)).default({}),
  /** Tags written for an anime model are compared with danbooru's list, under the prompt and in what the designer writes. */
  tagCheck: z.boolean().default(true),
  /**
   * Model families switched on or off by hand, by family id. One that is not named follows its files:
   * offered when they are found on ComfyUI, left out when they are not. Off only takes it out of the
   * lists to choose from: what was made with it, and drafts that use it, stay as they are.
   */
  families: z.record(z.string().max(120), z.boolean()).default({}),
  civitaiKey: z.string().default(""),
  /** Missing model files may be looked for on Civitai. Off: Afflatus never contacts Civitai. */
  civitaiLookups: z.boolean().default(false),
  /** Once a day, Civitai is asked whether it has newer versions of the models here (only with lookups on; hashes of the files are sent). */
  updateChecks: z.boolean().default(false),
  /** Missing model files may be fetched into ComfyUI, through ComfyUI-Manager. Off: Afflatus never asks ComfyUI to download anything. */
  downloadModels: z.boolean().default(false),
  /**
   * How many days the time of each render is kept one by one. Older ones are folded into figures per
   * model and day, which stay for good. 0: each one is kept for good.
   */
  renderHistoryDays: z.number().int().min(0).max(3650).default(90),
  /** How "Finish all clips" brings a timeline to its final quality: the user's defaults, each run can differ. */
  finish: finishSchema.prefault({}),
  /** A family's file chosen by hand where several fit (family id → slot id → file name); a slot not named follows its patterns. */
  slotFiles: z.record(z.string().max(120), z.record(z.string().max(80), z.string().max(400))).default({}),
  /** The presets whose files' licence was accepted (by preset id): fetched without asking again. */
  acceptedPresets: z.array(z.string().max(120)).max(500).default([]),
});
export type Settings = z.infer<typeof settingsSchema>;

/** The language model the designer writes with. */
export const llmInUse = (s: Settings): Llm | undefined => s.llms.find((l) => l.id === s.designerLlm) ?? s.llms[0];
/** The user's own instructions in use, when there are some. */
export const instructionsInUse = (s: Settings): string => s.designerInstructions.find((i) => i.id === s.designerInstruction)?.text.trim() ?? "";

/**
 * The settings as last read, per database: they are asked for on every request that touches ComfyUI
 * and on every tick of the event stream, and the table only changes through writeSettings, which
 * forgets this. (The queue writes its own notes into the same table under keys the schema ignores.)
 */
const cached = new WeakMap<Db, Promise<Settings>>();

export function readSettings(db: Db): Promise<Settings> {
  let value = cached.get(db);
  if (!value) {
    value = load(db);
    cached.set(db, value);
    // a read that failed is not kept: the next one tries again
    value.catch(() => cached.delete(db));
  }
  return value;
}

async function load(db: Db): Promise<Settings> {
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
  const parsed = settingsSchema.safeParse(rest);
  if (parsed.success) return parsed.data;
  // a stored value the schema no longer takes (an address without its scheme, say) falls back to its default rather than locking every setting
  const broken = new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "")));
  console.warn(`[settings] stored values that are no longer valid were set aside: ${[...broken].join(", ")}`);
  for (const key of broken) delete rest[key];
  return settingsSchema.parse(rest);
}

const KEYS = [...Object.keys(settingsSchema.shape), "llm"];

/** Merges a partial update, validates the whole, stores only the keys that were sent. */
export async function writeSettings(db: Db, patch: unknown): Promise<Settings> {
  // which keys were sent is read from the body itself: parsing it would fill in every default
  const sent = { ...z.record(z.string(), z.unknown()).parse(patch) };
  const unknown = Object.keys(sent).filter((k) => !KEYS.includes(k));
  if (unknown.length) throw httpError(`unknown setting: ${unknown.join(", ")}`);
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
  if (ids.size !== next.llms.length) throw httpError("two language models have the same id");
  const now = new Date().toISOString();
  try {
    for (const key of Object.keys(sent) as Array<keyof Settings>) {
      const value = JSON.stringify(next[key]);
      await db
        .insertInto("settings")
        .values({ key, value, updated_at: now })
        .onConflict((oc) => oc.column("key").doUpdateSet({ value, updated_at: now }))
        .execute();
    }
  } finally {
    // what was read before is stale now, whether or not every key got written
    cached.delete(db);
  }
  return next;
}

/** What the browser may see: secrets are replaced by whether they are set. */
export function publicSettings(s: Settings) {
  const open = ({ apiKey, ...l }: Llm) => ({ ...l, hasApiKey: Boolean(apiKey) });
  const used = llmInUse(s);
  return {
    comfyUrl: s.comfyUrl,
    comfyDir: s.comfyDir,
    unloadAfterMinutes: s.unloadAfterMinutes,
    /** The model in use, the short way: what tells whether the designer can work. */
    llm: { baseUrl: used?.baseUrl ?? "", model: used?.model ?? "", hasApiKey: Boolean(used?.apiKey), vision: used?.vision ?? false },
    llms: s.llms.map(open),
    designerLlm: used?.id ?? "",
    designerInstructions: s.designerInstructions,
    designerInstruction: s.designerInstructions.some((i) => i.id === s.designerInstruction) ? s.designerInstruction : "",
    designerGuides: s.designerGuides,
    tagCheck: s.tagCheck,
    families: s.families,
    hasCivitaiKey: Boolean(s.civitaiKey),
    finish: s.finish,
    slotFiles: s.slotFiles,
    acceptedPresets: s.acceptedPresets,
    civitaiLookups: s.civitaiLookups,
    updateChecks: s.updateChecks,
    downloadModels: s.downloadModels,
    renderHistoryDays: s.renderHistoryDays,
  };
}
