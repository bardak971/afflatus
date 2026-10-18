import { fileKey, type PresetFile } from "@afflatus/core";
import { filesUsed } from "./machineScans";
import { filesOf, parseSetDef } from "./modelSets";
import { measuredRange, type MeasureKind, type Range } from "./podMeasures";
import { acceptLicences, presetsWithFiles } from "./presetFiles";
import { readJson } from "./queueModel";
import { needsComfy } from "./queueOffline";
import type { Services } from "./services";
import { readSettings, type DeployAsk } from "./settings";
import { OWNER } from "./db";

/**
 * What the Deploy dialog's Models part shows before anything is deployed: the files the waiting jobs would need on a pod
 * that has none of them (a deployed pod starts with ComfyUI and the built-in packs only), the picked Model set's files,
 * where each comes from and how large it is, and the speeds and boot times measured on earlier deploys, from which the
 * page says the time and the price, or that they are not known yet.
 */

type Via = "hf" | "civitai" | "url" | "upload" | null;
export interface DeployFile extends Pick<PresetFile, "file" | "folder" | "url" | "civitai"> {
  via: Via;
  /** Bytes, when known. */
  size: number | null;
}
export interface DeployModelsView {
  /** The waiting jobs that may go to the pod (none pinned to another machine), and the files they use. */
  jobs: { count: number; files: Array<DeployFile & { jobs: number; first: boolean }> };
  /** The picked set's files (its presets' and its own), each once; null with no set picked. */
  set: Array<DeployFile & { preset?: { id: string; name: string }; off: boolean }> | null;
  /**
   * Presets under a licence not accepted yet, with their files (fileKey): a deploy that brings one of those files asks for
   * that licence, whichever way the file was picked (the jobs', the set's, one added).
   */
  licences: Array<{ id: string; name: string; licence: string; keys: string[] }>;
  /** What earlier deploys measured: bytes a second per source, ms for a boot; null where nothing was measured. */
  speeds: Record<Exclude<MeasureKind, "boot">, Range | null>;
  boot: Range | null;
}

/**
 * The files a deploy brings: the ones ticked in the dialog, or, for Deploy again (`again`, nothing ticked), the remembered
 * set's files; each preset's file under its licence, accepted in the dialog or before (presetFiles.ts acceptLicences), or
 * the deploy is refused before anything is made.
 */
export async function deployFiles(s: Services, ask: Pick<DeployAsk, "set" | "files" | "accept" | "again">): Promise<PresetFile[]> {
  let files = ask.files;
  if (ask.again && !files.length && ask.set) {
    const row = await s.db.selectFrom("model_sets").select("def").where("owner_id", "=", OWNER).where("id", "=", ask.set).executeTakeFirst();
    if (row) files = filesOf(parseSetDef(row.def), await presetsWithFiles(s)).filter((f) => !f.off).map(({ preset: _p, off: _o, ...f }) => f);
  }
  await acceptLicences(s, files, ask.accept);
  return files;
}

export async function deployModels(s: Services, o: { cloud: string; set: string }): Promise<DeployModelsView> {
  const rows = (await s.db.selectFrom("jobs").selectAll().where("status", "=", "queued").orderBy("priority").orderBy("created_at").execute()).filter(needsComfy);
  const settings = await readSettings(s.db);
  const machines = new Set(settings.machines.map((m) => m.id));
  // a job pinned to a machine of its own stays there: not one the pod would take
  const may = rows.filter((r) => !r.pin_machine || !machines.has(r.pin_machine));
  const scan = await (await s.comfy()).scan().catch(() => null);
  const counted = new Map<string, DeployFile & { jobs: number; first: boolean }>();
  for (const [i, r] of may.entries()) {
    const recipe = s.registry.recipe(r.recipe_id);
    if (!recipe) continue;
    const slots = s.registry.family(recipe.family)?.slots ?? [];
    // what its graph loads, built as a pod with none of its files would build it; the family's slots when it cannot be built
    for (const f of filesUsed(recipe, readJson<Record<string, unknown>>(r.inputs, {}), scan, slots, await s.queue.loadedOnNew(r))) {
      const key = `${f.folder}|${f.file.toLowerCase()}`;
      const had = counted.get(key);
      if (had) {
        had.jobs++;
        continue;
      }
      const about = await s.podFiles.about(f);
      counted.set(key, { file: f.file, folder: f.folder, ...(f.url ? { url: f.url } : {}), via: about.via, size: about.size, jobs: 1, first: i === 0 });
    }
  }
  let set: DeployModelsView["set"] = null;
  const licences: DeployModelsView["licences"] = [];
  if (o.set) {
    const row = await s.db.selectFrom("model_sets").select("def").where("owner_id", "=", OWNER).where("id", "=", o.set).executeTakeFirst();
    if (row) {
      const presets = await presetsWithFiles(s);
      const def = parseSetDef(row.def);
      set = [];
      for (const f of filesOf(def, presets)) {
        const about = await s.podFiles.about(f);
        set.push({ file: f.file, folder: f.folder, ...(f.url ? { url: f.url } : {}), ...(f.civitai ? { civitai: f.civitai } : {}), via: about.via, size: about.size, ...(f.preset ? { preset: f.preset } : {}), off: f.off });
      }
    }
  }
  for (const p of await presetsWithFiles(s)) {
    if (p.licence && !settings.acceptedPresets.includes(p.id)) licences.push({ id: p.id, name: p.name, licence: p.licence.name, keys: p.files.map(fileKey) });
  }
  const cloud = o.cloud || null;
  const [hf, civitai, url, upload, boot] = await Promise.all((["hf", "civitai", "url", "upload", "boot"] as const).map((k) => measuredRange(s.db, k, cloud)));
  return { jobs: { count: may.length, files: [...counted.values()] }, set, licences, speeds: { hf: hf!, civitai: civitai!, url: url!, upload: upload! }, boot: boot! };
}
