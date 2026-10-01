import { z } from "zod";
import type { Db } from "./db";

/** Everything the setup page edits. Stored as one JSON value per key. */
export const settingsSchema = z.object({
  comfyUrl: z.string().url().default("http://127.0.0.1:8188"),
  /** Any OpenAI-compatible endpoint, for the prompt designer. Empty = the designer is off. */
  llm: z
    .object({
      baseUrl: z.string().default(""), model: z.string().default(""), apiKey: z.string().default(""),
      /** The model can read pictures: the designer is shown the picture a form opens on. */
      vision: z.boolean().default(false),
    })
    .default({ baseUrl: "", model: "", apiKey: "", vision: false }),
  civitaiKey: z.string().default(""),
  /** Missing model files may be looked for on Civitai. Off: studai never contacts Civitai. */
  civitaiLookups: z.boolean().default(false),
  /** Missing model files may be fetched into ComfyUI, through ComfyUI-Manager. Off: studai never asks ComfyUI to download anything. */
  downloadModels: z.boolean().default(false),
});
export type Settings = z.infer<typeof settingsSchema>;

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
  return settingsSchema.parse(raw);
}

const KEYS = Object.keys(settingsSchema.shape) as Array<keyof Settings>;

/** Merges a partial update, validates the whole, stores only the keys that were sent. */
export async function writeSettings(db: Db, patch: unknown): Promise<Settings> {
  // which keys were sent is read from the body itself: parsing it would fill in every default
  const sent = z.record(z.string(), z.unknown()).parse(patch);
  const unknown = Object.keys(sent).filter((k) => !KEYS.includes(k as keyof Settings));
  if (unknown.length) throw Object.assign(new Error(`unknown setting: ${unknown.join(", ")}`), { statusCode: 400 });
  const current = await readSettings(db);
  // a key that is not sent again stays: the browser is never given it back to send
  const llm = sent.llm && typeof sent.llm === "object" ? { ...current.llm, ...(sent.llm as object) } : undefined;
  const next = settingsSchema.parse({ ...current, ...sent, ...(llm ? { llm } : {}) });
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
  return {
    comfyUrl: s.comfyUrl,
    llm: { baseUrl: s.llm.baseUrl, model: s.llm.model, hasApiKey: Boolean(s.llm.apiKey), vision: s.llm.vision },
    hasCivitaiKey: Boolean(s.civitaiKey),
    civitaiLookups: s.civitaiLookups,
    downloadModels: s.downloadModels,
  };
}
