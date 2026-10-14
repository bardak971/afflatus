import type { PresetFile } from "@afflatus/core";
import { filesUsed } from "./machineScans";
import { filesOf, parseSetDef } from "./modelSets";
import { measuredRange, type MeasureKind, type Range } from "./podMeasures";
import { presetsWithFiles } from "./presetFiles";
import { readJson } from "./queueModel";
import { needsComfy } from "./queueOffline";
import type { Services } from "./services";
import { httpError } from "./errors";
import { readSettings, updateSettings, type DeployAsk } from "./settings";
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
  /** Presets of the set whose licence was not accepted yet: accepted by deploying with them. */
  licences: Array<{ id: string; name: string; licence: string }>;
  /** What earlier deploys measured: bytes a second per source, ms for a boot; null where nothing was measured. */
  speeds: Record<Exclude<MeasureKind, "boot">, Range | null>;
  boot: Range | null;
}

/**
 * A deploy that brings files of a set's presets under a licence: each accepted in the dialog (kept as accepted, as for the
 * preset itself), or the deploy is refused before anything is made.
 */
export async function acceptSetLicences(s: Services, ask: Pick<DeployAsk, "set" | "files" | "accept">): Promise<void> {
  if (!ask.set || !ask.files.length) return;
  const row = await s.db.selectFrom("model_sets").select("def").where("owner_id", "=", OWNER).where("id", "=", ask.set).executeTakeFirst();
  if (!row) return;
  const presets = await presetsWithFiles(s);
  const settings = await readSettings(s.db);
  const sent = new Set(ask.files.map((f) => `${f.folder}|${f.file.toLowerCase()}`));
  const pending = parseSetDef(row.def).presets
    .map((id) => presets.find((p) => p.id === id))
    .filter((p): p is NonNullable<typeof p> => Boolean(p?.licence && !settings.acceptedPresets.includes(p.id) && p.files.some((f) => sent.has(`${f.folder}|${f.file.toLowerCase()}`))));
  const refused = pending.filter((p) => !ask.accept.includes(p.id));
  if (refused.length) throw httpError(`${refused.map((p) => `${p.name} comes under the ${p.licence!.name}`).join("; ")}: accept it first.`);
  if (pending.length) await updateSettings(s.db, ({ acceptedPresets }) => ({ acceptedPresets: [...new Set([...acceptedPresets, ...pending.map((p) => p.id)])] }));
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
    for (const f of filesUsed(recipe, readJson<Record<string, unknown>>(r.inputs, {}), scan, slots)) {
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
      for (const id of def.presets) {
        const p = presets.find((x) => x.id === id);
        if (p?.licence && !settings.acceptedPresets.includes(id)) licences.push({ id, name: p.name, licence: p.licence.name });
      }
    }
  }
  const cloud = o.cloud || null;
  const [hf, civitai, url, upload, boot] = await Promise.all((["hf", "civitai", "url", "upload", "boot"] as const).map((k) => measuredRange(s.db, k, cloud)));
  return { jobs: { count: may.length, files: [...counted.values()] }, set, licences, speeds: { hf: hf!, civitai: civitai!, url: url!, upload: upload! }, boot: boot! };
}
