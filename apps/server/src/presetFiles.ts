import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { httpError } from "./errors";
import { fileName } from "./media";
import type { PresetFile, ShippedPreset } from "@afflatus/core";
import { OWNER } from "./db";
import type { DownloadView } from "./downloads";
import { beginDownload } from "./fetchFile";
import type { Services } from "./services";
import { readSettings, writeSettings } from "./settings";

/**
 * The model files a preset is made for (see `PresetFile` in core), and the presets that ship with Afflatus.
 * A shipped preset is a JSON file in the repository's `presets/` folder (contributed by pull request); it
 * is listed among the Prompt kit's presets, read-only, to apply or to copy. For every preset that names
 * files, `GET /api/presets/files` says which ComfyUI has, and `POST /api/presets/:id/get` fetches the
 * missing ones through the download path — only under a licence the user accepted.
 */

/** An address shown as a link or fetched: http or https only (a javascript: or file: address is refused). */
const webUrl = z.string().url().max(2000).refine((u) => /^https?:\/\//i.test(u), "only http and https addresses");
export const presetFileSchema = z.strictObject({
  file: z.string().min(1).max(400),
  folder: z.string().min(1).max(120),
  url: webUrl.optional(),
  civitai: z.strictObject({ version: z.number().int().positive(), pick: z.string().max(400).optional(), page: webUrl.optional() }).optional(),
  page: webUrl.optional(),
  size: z.number().int().nonnegative().optional(),
  note: z.string().max(400).optional(),
  optional: z.boolean().optional(),
});
export const provenanceSchema = {
  author: z.string().max(80).optional(),
  note: z.string().max(1000).optional(),
  homepage: webUrl.optional(),
  licence: z.strictObject({ name: z.string().min(1).max(120), url: webUrl.optional(), note: z.string().max(600).optional() }).optional(),
};
const shippedSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,60}$/, "an id is lower-case letters, digits and dashes"),
  name: z.string().trim().min(1).max(120),
  ...provenanceSchema,
  recipe: z.string().min(1).max(120),
  inputs: z.record(z.string(), z.unknown()),
  files: z.array(presetFileSchema).max(40),
});

/** The id a shipped preset is listed under among the entities. */
export const SHIPPED = "shipped:";

/** Where the presets that ship with Afflatus are: the repository's `presets/` folder, or PRESETS_DIR. */
export function shippedPresetsDir(): string {
  return process.env.PRESETS_DIR?.trim() || fileURLToPath(new URL("../../../presets", import.meta.url));
}

/**
 * The shipped presets on disk. Read once and kept while their files stay as they are: the command bar's index, the Prompt
 * kit and the presets' files ask for them on every read, and reading and checking every file each time cost milliseconds
 * of a held server. A file added, removed or changed (its size or its time) is read again.
 */
export class ShippedPresets {
  private kept: { stamp: string; list: ShippedPreset[] } | null = null;
  constructor(readonly dir: string | null) {}
  list(): ShippedPreset[] {
    if (!this.dir || !existsSync(this.dir)) return [];
    const names = readdirSync(this.dir).filter((n) => n.endsWith(".json")).sort();
    const stamp = names.map((n) => {
      const st = statSync(join(this.dir!, n), { throwIfNoEntry: false });
      return `${n}:${st?.size}:${st?.mtimeMs}`;
    }).join("|");
    if (this.kept?.stamp === stamp) return this.kept.list;
    const list = this.read(names);
    this.kept = { stamp, list };
    return list;
  }
  private read(names: string[]): ShippedPreset[] {
    const out: ShippedPreset[] = [];
    for (const name of names) {
      try {
        const parsed = shippedSchema.safeParse(JSON.parse(readFileSync(join(this.dir!, name), "utf8")));
        if (parsed.success) out.push(parsed.data);
        else console.warn(`[presets] ${name} could not be read and is skipped: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`);
      } catch (err) {
        console.warn(`[presets] ${name} could not be read and is skipped: ${(err as Error).message}`);
      }
    }
    return out;
  }
  /** As the Prompt kit lists it: an entity that cannot be changed, with where it comes from in its def. */
  entity(p: ShippedPreset) {
    const { id, name, recipe, inputs, files, ...provenance } = p;
    return { id: SHIPPED + id, kind: "preset" as const, name, def: { recipe, inputs, files, ...provenance }, updatedAt: "", source: "shipped" as const };
  }
}

export interface PresetFileView extends PresetFile {
  /** ComfyUI has a file of this name in that folder. */
  have: boolean;
}
export interface PresetFilesView {
  id: string;
  files: PresetFileView[];
  /** The licence was accepted once (nothing is asked again); true when there is none. */
  accepted: boolean;
  /** The family of its recipe, and which of the family's own files (text encoder, VAE…) are missing: those are Settings' to fetch. */
  needs?: { family: string; name: string; missing: string[] };
}

type Preset = { id: string; name: string; recipe?: string; files: PresetFile[]; licence?: { name: string } };

export function registerPresetFiles(app: FastifyInstance, s: Services): void {
  /** Every preset that names files: the user's own from the database, and the shipped ones. */
  const all = async (): Promise<Preset[]> => {
    const rows = await s.db.selectFrom("entities").select(["id", "name", "def"]).where("owner_id", "=", OWNER).where("kind", "=", "preset").execute();
    const mine = rows.flatMap((r) => {
      const def = JSON.parse(r.def) as { recipe?: string; files?: PresetFile[]; licence?: { name: string } };
      return def.files?.length ? [{ id: r.id, name: r.name, recipe: def.recipe, files: def.files, licence: def.licence }] : [];
    });
    const shipped = s.shippedPresets.list().map((p) => ({ id: SHIPPED + p.id, name: p.name, recipe: p.recipe, files: p.files, licence: p.licence }));
    return [...mine, ...shipped];
  };
  const find = async (id: string) => {
    const found = (await all()).find((p) => p.id === id);
    if (!found) throw httpError("that preset was not found, or names no files", 404);
    return found;
  };

  /** What ComfyUI has, folder by folder, each listed once per request. */
  const listings = async () => {
    const comfy = await s.comfy();
    const lists = new Map<string, Promise<string[]>>();
    const files = (folder: string) => {
      let p = lists.get(folder);
      if (!p) {
        p = comfy.client.models(folder).catch(() => [] as string[]);
        lists.set(folder, p);
      }
      return p;
    };
    const scan = await comfy.scan().catch(() => null);
    return { files, scan, online: Boolean(scan?.comfy.online) };
  };
  const has = async (ctx: Awaited<ReturnType<typeof listings>>, f: PresetFile) => (await ctx.files(f.folder)).some((x) => fileName(x) === fileName(f.file));

  const view = async (p: Preset, ctx: Awaited<ReturnType<typeof listings>>, accepted: string[]): Promise<PresetFilesView> => {
    const files: PresetFileView[] = [];
    for (const f of p.files) files.push({ ...f, have: await has(ctx, f) });
    const recipe = p.recipe ? s.registry.recipe(p.recipe) : undefined;
    const family = recipe ? s.registry.family(recipe.family) : undefined;
    const status = family ? ctx.scan?.families.find((x) => x.id === family.id) : undefined;
    const fileOf = (slot: string) => status?.slots.find((x) => x.id === slot)?.file;
    // the family's required slots with nothing in them (a slot not needed beside a filled one, LTX's one checkpoint beside its split model, does not count)
    const needs = family && status
      ? { family: family.id, name: family.name, missing: family.slots.filter((x) => !x.optional && !fileOf(x.id) && !(x.unless && fileOf(x.unless))).map((x) => x.label) }
      : undefined;
    return { id: p.id, files, accepted: !p.licence || accepted.includes(p.id), ...(needs ? { needs } : {}) };
  };

  /** The preset's files must be under an accepted licence before any is fetched. */
  const licensed = async (p: Preset, accept: boolean | undefined) => {
    if (!p.licence) return;
    const settings = await readSettings(s.db);
    if (settings.acceptedPresets.includes(p.id)) return;
    if (!accept) throw httpError(`${p.name} comes under the ${p.licence.name}: accept it first.`);
    await writeSettings(s.db, { acceptedPresets: [...settings.acceptedPresets, p.id] });
  };

  app.get("/api/presets/files", async () => {
    const [ctx, settings, presets] = await Promise.all([listings(), readSettings(s.db), all()]);
    const items: PresetFilesView[] = [];
    for (const p of presets) items.push(await view(p, ctx, settings.acceptedPresets));
    return { online: ctx.online, items };
  });

  /** Every file of the preset that ComfyUI does not have is fetched, one download each: the required ones, and the optional when asked. */
  app.post<{ Params: { id: string } }>("/api/presets/:id/get", async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const p = await find(req.params.id);
    const b = z.strictObject({ accept: z.boolean().optional(), optional: z.boolean().optional() }).parse(req.body ?? {});
    await licensed(p, b.accept);
    const ctx = await listings();
    const started: DownloadView[] = [];
    const failed: Array<{ file: string; error: string }> = [];
    let skipped = 0;
    for (const f of p.files) {
      if (f.optional && !b.optional) continue;
      if (await has(ctx, f)) continue;
      if (!f.url && !f.civitai) {
        skipped++;
        continue;
      }
      try {
        started.push(await beginDownload(s, req, {
          file: f.file, folder: f.folder,
          ...(f.url ? { url: f.url } : { civitai: f.civitai!.version, pick: f.civitai!.pick }),
          ...(f.civitai?.page ? { page: { url: f.civitai.page, title: p.name } } : {}),
        }));
      } catch (err) {
        failed.push({ file: f.file, error: (err as Error).message });
        // the switch is off, or ComfyUI cannot be reached: the same answer would come for every file
        if ((err as { statusCode?: number }).statusCode === 400) break;
      }
    }
    return { started, failed, skipped };
  });
}
