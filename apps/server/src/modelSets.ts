import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { fileKey, presetFileSchema, type PresetFile } from "@afflatus/core";
import { now, OWNER } from "./db";
import { httpError, notFound } from "./errors";
import { beginDownload } from "./fetchFile";
import { fileName } from "./media";
import { localCopy, measureKind, presetSource } from "./podSources";
import { acceptLicences, presetsWithFiles, type Preset } from "./presetFiles";
import type { Services } from "./services";
import { readSettings } from "./settings";

/**
 * Model sets: a named list of model files, nothing else (no form, no values), for a rented pod (Deploy a GPU), a new
 * computer, or a friend. A set holds presets by reference, so that a preset moved to a new version moves the set, and
 * files of its own (a LoRA, an upscaler, any model file); a preset's file can be left out of the set without changing the
 * preset. Kept in Settings › Models, saved as a file and brought in as presets are.
 */

/** The model folders the search looks through on this computer's ComfyUI, and that a volume's pod lists (rentedVolumes.ts). */
export const SEARCHED_FOLDERS = ["checkpoints", "diffusion_models", "loras", "vae", "text_encoders", "clip_vision", "upscale_models", "latent_upscale_models", "controlnet", "model_patches", "audio_encoders"];

/** A file left out of a set's preset, by its folder and name (core fileKey). */
const keyOf = (folder: string, file: string) => fileKey({ folder, file });

export const setDefSchema = z.strictObject({
  /** The presets it holds, by their id ("shipped:…" for one that ships with Afflatus). */
  presets: z.array(z.string().min(1).max(120)).max(20).default([]),
  /** Its own files. */
  files: z.array(presetFileSchema).max(200).default([]),
  /** Files of its presets left out of it ("folder|name"). */
  off: z.array(z.string().max(600)).max(200).default([]),
});
export type SetDef = z.infer<typeof setDefSchema>;
const setBody = setDefSchema.extend({ name: z.string().trim().min(1).max(120) });

/** One file of a set, as listed: where it comes from and where it is already. */
export interface SetFileView extends PresetFile {
  /** The preset it comes with; absent for one of the set's own. */
  preset?: { id: string; name: string };
  /** Left out of the set (a preset's file ticked off). */
  off: boolean;
  /** Where it is had: a site, or this computer only (an upload to a pod); null: nowhere known. */
  via: "hf" | "civitai" | "url" | "upload" | null;
  /** On which machines it is now, by machine id (each machine's ComfyUI lists it). */
  on: Record<string, boolean>;
}

export interface ModelSetView {
  id: string;
  name: string;
  presets: Array<{ id: string; name: string; licence?: { name: string }; accepted: boolean; gone?: boolean }>;
  files: PresetFile[];
  off: string[];
  /** The files it brings, left-out ones not counted, and their bytes as far as known. */
  count: number;
  bytes: number;
  updatedAt: string;
}

/** A set's files: its presets' (less those left out) then its own, each once. */
export function filesOf(def: SetDef, presets: Preset[]): Array<PresetFile & { preset?: { id: string; name: string }; off: boolean }> {
  const out: Array<PresetFile & { preset?: { id: string; name: string }; off: boolean }> = [];
  // a file of the set's own is listed as its own, even when a preset of the set names it too: leaving the preset's out
  // never takes it away
  const seen = new Set<string>(def.files.map((f) => keyOf(f.folder, f.file)));
  for (const id of def.presets) {
    const p = presets.find((x) => x.id === id);
    if (!p) continue;
    for (const f of p.files) {
      const key = keyOf(f.folder, f.file);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...f, preset: { id: p.id, name: p.name }, off: def.off.includes(key) });
    }
  }
  const own = new Set<string>();
  for (const f of def.files) {
    const key = keyOf(f.folder, f.file);
    if (own.has(key)) continue;
    own.add(key);
    out.push({ ...f, off: false });
  }
  return out;
}

export const parseSetDef = (raw: string): SetDef => setDefSchema.parse(JSON.parse(raw));

/** What a set file holds when saved (Save as a file): its presets written out as files, so that it reads anywhere. */
export interface SetFileExport {
  afflatusModelSet: 1;
  name: string;
  files: Array<PresetFile & { from?: string }>;
}

/** Every set with the files it brings (left-out ones not), for what a volume holds of each (Settings › Rented GPUs). */
export async function setsWithFiles(s: Services): Promise<Array<{ id: string; name: string; files: PresetFile[] }>> {
  const [all, list] = await Promise.all([presetsWithFiles(s), s.db.selectFrom("model_sets").selectAll().where("owner_id", "=", OWNER).orderBy("name").execute()]);
  return list.map((r) => ({ id: r.id, name: r.name, files: filesOf(parseSetDef(r.def), all).filter((f) => !f.off) }));
}

export function registerModelSets(app: FastifyInstance, s: Services): void {
  const rows = () => s.db.selectFrom("model_sets").selectAll().where("owner_id", "=", OWNER).orderBy("name").execute();
  const find = async (id: string) => {
    const row = await s.db.selectFrom("model_sets").selectAll().where("owner_id", "=", OWNER).where("id", "=", id).executeTakeFirst();
    if (!row) throw notFound("that model set");
    return row;
  };
  const presets = () => presetsWithFiles(s);

  const view = (row: { id: string; name: string; def: string; updated_at: string }, all: Preset[], accepted: string[]): ModelSetView => {
    const def = parseSetDef(row.def);
    const files = filesOf(def, all).filter((f) => !f.off);
    return {
      id: row.id, name: row.name, files: def.files, off: def.off, updatedAt: row.updated_at,
      presets: def.presets.map((id) => {
        const p = all.find((x) => x.id === id);
        if (!p) return { id, name: id.replace(/^shipped:/, ""), accepted: true, gone: true };
        return { id, name: p.name, ...(p.licence ? { licence: { name: p.licence.name } } : {}), accepted: !p.licence || accepted.includes(id) };
      }),
      count: files.length,
      bytes: files.reduce((n, f) => n + (f.size ?? 0), 0),
    };
  };

  app.get("/api/model-sets", async () => {
    const [all, settings, list] = await Promise.all([presets(), readSettings(s.db), rows()]);
    return { items: list.map((r) => view(r, all, settings.acceptedPresets)) };
  });

  const save = async (id: string | null, body: unknown) => {
    const b = setBody.parse(body);
    const def: SetDef = { presets: [...new Set(b.presets)], files: b.files, off: [...new Set(b.off)] };
    if (id) {
      await find(id);
      await s.db.updateTable("model_sets").set({ name: b.name, def: JSON.stringify(def), updated_at: now() }).where("id", "=", id).execute();
    } else {
      id = randomUUID();
      await s.db.insertInto("model_sets").values({ id, owner_id: OWNER, name: b.name, def: JSON.stringify(def), created_at: now(), updated_at: now() }).execute();
    }
    const [all, settings] = await Promise.all([presets(), readSettings(s.db)]);
    return view(await find(id), all, settings.acceptedPresets);
  };
  app.post("/api/model-sets", async (req) => save(null, req.body));
  app.put<{ Params: { id: string } }>("/api/model-sets/:id", async (req) => save(req.params.id, req.body));
  app.delete<{ Params: { id: string } }>("/api/model-sets/:id", async (req) => {
    await find(req.params.id);
    await s.db.deleteFrom("model_sets").where("id", "=", req.params.id).execute();
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>("/api/model-sets/:id/duplicate", async (req) => {
    const row = await find(req.params.id);
    return save(null, { ...parseSetDef(row.def), name: `${row.name} copy`.slice(0, 120) });
  });

  /** A set's files with where each comes from and which machines have it already (each machine's ComfyUI is asked). */
  app.get<{ Params: { id: string } }>("/api/model-sets/:id/files", async (req) => {
    const row = await find(req.params.id);
    const [all, settings, machines] = await Promise.all([presets(), readSettings(s.db), s.machines()]);
    // each machine's folders listed once; a machine that does not answer has none of them, said as not known
    const listed = new Map<string, Promise<string[] | null>>();
    const list = (machine: string, folder: string) => {
      const key = `${machine}|${folder}`;
      if (!listed.has(key)) {
        const m = machines.find((x) => x.machine.id === machine)!;
        listed.set(key, m.comfy.client.models(folder).then((files) => files.map(fileName), () => null));
      }
      return listed.get(key)!;
    };
    const items: SetFileView[] = [];
    const listed0 = filesOf(parseSetDef(row.def), all);
    // every machine's folders asked at once, not one after another
    await Promise.all(listed0.flatMap((f) => machines.map((m) => list(m.machine.id, f.folder))));
    for (const f of listed0) {
      const on: Record<string, boolean> = {};
      for (const m of machines) {
        const files = await list(m.machine.id, f.folder);
        if (files) on[m.machine.id] = files.includes(fileName(f.file));
      }
      // where a pod would get it, as the pod does (a file a site knows by its name is never uploaded from here)
      const src = presetSource(f);
      const about = src ? null : await s.podFiles.about(f).catch(() => null);
      const here = src || about?.via ? null : await localCopy(settings.comfyDir, f.folder, f.file);
      const size = f.size ?? about?.size ?? (here ? (await stat(here).catch(() => null))?.size : undefined);
      items.push({ ...f, ...(size ? { size } : {}), via: src ? measureKind(src) : about?.via ?? (here ? "upload" : null), on });
    }
    return { items };
  });

  /**
   * The set's files a machine lacks, fetched there: onto this computer's ComfyUI (or another of its own) through the usual
   * downloads; onto a rented pod through what it gets (podFiles.ts), after what its jobs wait for. A preset's licence must
   * have been accepted first, as for the preset itself.
   */
  app.post<{ Params: { id: string } }>("/api/model-sets/:id/get", async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const row = await find(req.params.id);
    const b = z.strictObject({ machine: z.string().max(40).optional(), accept: z.boolean().optional() }).parse(req.body ?? {});
    const all = await presets();
    const def = parseSetDef(row.def);
    const machines = await s.machines();
    const target = b.machine ? machines.find((m) => m.machine.id === b.machine) : machines[0];
    if (!target) throw notFound("that ComfyUI");
    const files = filesOf(def, all).filter((f) => !f.off);
    const have = new Map<string, string[]>();
    const missing: typeof files = [];
    for (const f of files) {
      if (!have.has(f.folder)) have.set(f.folder, (await target.comfy.client.models(f.folder).catch(() => [] as string[])).map(fileName));
      if (!have.get(f.folder)!.includes(fileName(f.file))) missing.push(f);
    }
    // the files fetched come under their presets' licences, whichever way they are in the set (a preset, a file of its own)
    await acceptLicences(s, missing, Boolean(b.accept));
    if (target.machine.rented) {
      s.podFiles.want(target.machine.id, missing.map(({ file, folder, url, civitai, size }) => ({ file, folder, ...(url ? { url } : {}), ...(civitai ? { civitai } : {}), ...(size ? { size } : {}) })), { tier: "ahead" });
      return { sent: missing.length, failed: [], skipped: 0 };
    }
    const failed: Array<{ file: string; error: string }> = [];
    let sent = 0;
    let skipped = 0;
    for (const f of missing) {
      if (!f.url && !f.civitai) {
        skipped++;
        continue;
      }
      try {
        await beginDownload(s, req, { file: f.file, folder: f.folder, machine: target.machine.id, ...(f.url ? { url: f.url } : { civitai: f.civitai!.version, pick: f.civitai!.pick }) });
        sent++;
      } catch (err) {
        failed.push({ file: f.file, error: (err as Error).message });
        // the switch is off, or ComfyUI cannot be reached: the same answer would come for every file
        if ((err as { statusCode?: number }).statusCode === 400) break;
      }
    }
    return { sent, failed, skipped };
  });

  /** The set as a file: its presets written out as files (with the preset each came from), so that it reads anywhere. */
  app.get<{ Params: { id: string } }>("/api/model-sets/:id/export", async (req, reply) => {
    const row = await find(req.params.id);
    const files = filesOf(parseSetDef(row.def), await presets())
      .filter((f) => !f.off)
      .map(({ preset, off: _off, ...f }) => ({ ...f, ...(preset ? { from: preset.name } : {}) }));
    const body: SetFileExport = { afflatusModelSet: 1, name: row.name, files };
    void reply.header("Content-Disposition", `attachment; filename="${row.name.replace(/[^\w .-]+/g, "_").slice(0, 80) || "model set"}.json"`);
    return body;
  });

  /**
   * What can be added to a set (or to a deploy's files), found by words: presets (their files), families (their usual
   * files, each with its address), and the model files this computer's ComfyUI has, folder by folder.
   */
  app.get("/api/model-sets/search", async (req) => {
    const { q } = z.object({ q: z.string().max(200).default("") }).parse(req.query);
    const words = q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    const hit = (text: string) => words.every((w) => text.toLowerCase().includes(w));
    // each file with where it comes from, as the server judges it (a preset's own address or version)
    const withVia = <F extends PresetFile>(f: F) => {
      const src = presetSource(f);
      return { ...f, via: src ? measureKind(src) : null };
    };
    const all = await presets();
    const presetHits = all.filter((p) => hit(`${p.name} ${p.files.map((f) => f.file).join(" ")}`)).slice(0, 12)
      .map((p) => ({ id: p.id, name: p.name, files: p.files.map(withVia), bytes: p.files.reduce((n, f) => n + (f.size ?? 0), 0) }));
    // a family's usual files name their address only: their size asked of the site (kept, as the pod's files' are)
    const familyHits = (await Promise.all(s.registry.families().filter((f) => !f.imported && hit(`${f.name} ${f.id}`)).slice(0, 8)
      .map(async (f) => ({ id: f.id, name: f.name, files: await Promise.all(f.slots.filter((x) => x.get && !x.optional).map(async (x) => {
        const file = withVia({ file: x.get!.file, folder: x.folder, url: x.get!.url });
        const size = (await s.podFiles.about(file).catch(() => null))?.size;
        return size ? { ...file, size } : file;
      })) }))))
      .filter((f) => f.files.length);
    const files: Array<{ file: string; folder: string; size?: number; via: SetFileView["via"] }> = [];
    if (words.length) {
      const comfy = await s.comfy();
      const dir = (await readSettings(s.db)).comfyDir;
      // every folder asked at once; at most 30 files found, each looked for on this computer at once
      const lists = await Promise.all(SEARCHED_FOLDERS.map(async (folder) => ({ folder, names: await comfy.client.models(folder).catch(() => [] as string[]) })));
      const found = lists.flatMap(({ folder, names }) => names.filter(hit).map((file) => ({ file, folder }))).slice(0, 30);
      // where a pod would get each, as the pod does: a site that knows it (a preset's, a family's, the Civitai version it was
      // matched to) before an upload from this computer, which is only for a file no site has
      files.push(...(await Promise.all(found.map(async (f) => {
        const [here, about] = await Promise.all([localCopy(dir, f.folder, f.file), s.podFiles.about(f).catch(() => null)]);
        const size = about?.size ?? (here ? (await stat(here).catch(() => null))?.size : undefined);
        return { ...f, ...(size ? { size } : {}), via: about?.via ?? (here ? ("upload" as const) : null) };
      }))));
    }
    return { presets: presetHits, families: familyHits, files };
  });

  /** A set file brought in: a new set of its files (none is fetched until asked). */
  app.post("/api/model-sets/import", async (req) => {
    const parsed = z.strictObject({
      afflatusModelSet: z.literal(1),
      name: z.string().trim().min(1).max(120),
      files: z.array(presetFileSchema.extend({ from: z.string().max(120).optional() })).max(200),
    }).safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw httpError(issue?.path.length ? `That is not a model set file (${issue.path.join(".")}: ${issue.message}).` : "That is not a model set file.");
    }
    return save(null, { name: parsed.data.name, presets: [], off: [], files: parsed.data.files.map(({ from: _from, ...f }) => f) });
  });
}
