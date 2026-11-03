import { z } from "zod";

/**
 * The preset files' shapes as the server checks them, and a preset file brought in read with them (presets.ts says what a
 * preset holds). A module of its own, outside the core's index: built when they are first imported, its zod schemas made
 * the browser load zod with its first page (87 kB) although only bringing a preset file in reads them (card #246).
 */

/** An address shown as a link or fetched: http or https only (a javascript: or file: address is refused). */
const webUrl = z.string().url().max(2000).refine((u) => /^https?:\/\//i.test(u), "only http and https addresses");

/** One model file a preset needs, as the server checks it (`PresetFile`). */
export const presetFileSchema = z.strictObject({
  // a name, with sub-folders when it has some: never a step up out of its folder
  file: z.string().min(1).max(400).refine((f) => !f.split(/[\\/]/).some((p) => p === ".." || p === "."), "a file name never goes up a folder"),
  // a ComfyUI model folder's name ("loras", "diffusion_models"): letters, digits, dashes and underscores only
  folder: z.string().min(1).max(120).regex(/^[\w-]+$/, "a model folder's name"),
  url: webUrl.optional(),
  civitai: z.strictObject({
    version: z.number().int().positive(), pick: z.string().max(400).optional(), page: webUrl.optional(),
    sha256: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(), fileId: z.number().int().positive().optional(),
  }).optional(),
  page: webUrl.optional(),
  size: z.number().int().nonnegative().optional(),
  note: z.string().max(400).optional(),
  optional: z.boolean().optional(),
});

/** Where a preset comes from and under what terms, as the server checks it. */
export const provenanceSchema = {
  author: z.string().max(80).optional(),
  /** What it is picked by, in a few words ("Hybrid v3 · smaller file"): the list's dim line, after the author. */
  line: z.string().max(80).optional(),
  note: z.string().max(1000).optional(),
  homepage: webUrl.optional(),
  links: z.array(z.strictObject({ label: z.string().trim().min(1).max(40), url: webUrl })).max(6).optional(),
  licence: z.strictObject({ name: z.string().min(1).max(120), url: webUrl.optional(), note: z.string().max(600).optional() }).optional(),
};

/** A preset that ships with Afflatus, as its file in `presets/` must be. */
export const shippedSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,60}$/, "an id is lower-case letters, digits and dashes"),
  name: z.string().trim().min(1).max(120),
  ...provenanceSchema,
  recipe: z.string().min(1).max(120),
  inputs: z.record(z.string(), z.unknown()),
  files: z.array(presetFileSchema).max(40),
});

/**
 * What a preset file brought in may hold: the shipped shape, its id and model left optional and a look allowed, as a
 * preset saved from Afflatus has them; keys it does not know are left out. The look is checked by the server.
 */
const importedShape = z.object({
  ...shippedSchema.shape,
  id: z.string().optional(),
  // a file without a name of its own is named after the file
  name: z.string().max(120).optional(),
  recipe: z.string().min(1).max(120).optional(),
  inputs: z.record(z.string(), z.unknown()).default({}),
  look: z.unknown().optional(),
  files: z.array(presetFileSchema).max(40).optional(),
});
/** Or a saved entity: its name and its def. */
const importedEntity = z.object({ name: z.string().optional(), def: importedShape.omit({ id: true, name: true }) });

/**
 * A preset file brought in, read: its name when it has one, and what it sets; or, for anything else (not an object, a
 * field of the wrong kind), where and why in a few words. Checked with the shipped presets' own shapes.
 */
export function readPresetFile(raw: unknown): { name?: string; def: Omit<z.infer<typeof importedShape>, "id" | "name"> } | { error: string } {
  const entity = Boolean(raw && typeof raw === "object" && "def" in raw);
  const parsed = entity ? importedEntity.safeParse(raw) : importedShape.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (!issue?.path.length) return { error: "it holds no preset" };
    return { error: `${issue.path.join(".")}: ${issue.message}` };
  }
  if ("def" in parsed.data) return { name: parsed.data.name, def: parsed.data.def };
  const { id: _id, name, ...def } = parsed.data;
  return { name, def };
}
