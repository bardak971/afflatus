import { fileKey } from "@afflatus/core";
import type { Comfy } from "./comfy";
import { httpError } from "./errors";
import { filesUsed } from "./machineScans";
import { fileName } from "./media";
import { setsWithFiles } from "./modelSets";
import { readJson } from "./queueModel";
import { folderOf, keepListing, keptHoldings, MODELS_PREFIX, podListing, type KeptFile, type PodOn, type VolumeView } from "./rentedVolumes";
import { S3_DATA_CENTERS, S3Error, s3Endpoint, VolumeS3, type S3Object } from "./runpodS3";
import type { Services } from "./services";
import { readSettings, type Settings } from "./settings";

/**
 * The volume viewer (Settings › Rented GPUs, a volume's Files): what a network volume really holds, and its files deleted
 * to make room. Read, in this order, through the pod running on it (its node pack lists the models folder with sizes and
 * removes a file: no key to set), through RunPod's S3 API with no pod running (the account's S3 API key, its secret pasted
 * once: the access key is the account's user id, which the API key tells), else as it was last listed. Only ComfyUI's
 * models folder is read: the rest of the volume is ComfyUI itself, never listed nor touched here, and its pictures and
 * videos, which the library has.
 */

export { MODELS_PREFIX };

/** How many finished renders are read back for "last used": the most recent ones, enough for months of use. */
const USED_JOBS = 5000;

export interface VolumeFile extends KeptFile {
  /** When a finished render on a pod of this volume last needed it; null: none Afflatus knows of. */
  usedAt: string | null;
  /** The Model sets it is a file of. */
  sets: Array<{ id: string; name: string }>;
  /** A file of the same name and size is in this PC's models (Find models' hashes). */
  here: boolean;
  /** A render running on the volume's pod needs it now: not deleted. */
  inUse: boolean;
}

export interface VolumeFilesView {
  volume: { id: string; name: string; size: number; dataCenter: string; perMonth: number; usedBy: PodOn | null };
  /** "pod": read now through the pod on it; "s3": read now through the S3 API; "kept": as last listed; "none": nothing to show. */
  source: "pod" | "s3" | "kept" | "none";
  /** Whether its files can be deleted now (through its pod, or S3), and why not when they cannot. */
  canDelete: boolean;
  why: string | null;
  /** When what is shown was read, and by what (a pod's name, or S3). */
  readAt: string | null;
  readBy: string | null;
  files: VolumeFile[];
  /** The volume's bytes in use, all of it, as the pod running on it read its disk; null while no pod says it. */
  used: number | null;
}

/** A file's key as volumes and sets are compared: its folder and its own name, as rentedVolumes keeps them. */
const keyOf = (folder: string, name: string) => fileKey({ folder, file: fileName(name) });

/** The account's user id and the data centers with the S3 API, as RunPod said them (read once a day, per API key). */
let facts: { key: string; at: number; user: string | null; dataCenters: string[] | null } | null = null;
async function s3Facts(s: Services, settings: Settings): Promise<{ user: string | null; dataCenters: readonly string[] }> {
  if (!facts || facts.key !== settings.runpodKey || Date.now() - facts.at > 86_400_000 || !facts.user) {
    const got = await s.rented.client(settings.runpodKey).s3Facts().catch(() => ({ user: null, dataCenters: null }));
    facts = { key: settings.runpodKey, at: Date.now(), ...got };
  }
  // RunPod's own list when it gave one; the list its page gave otherwise
  return { user: settings.runpodS3User || facts.user, dataCenters: facts.dataCenters ?? S3_DATA_CENTERS };
}

/** The S3 client of a volume, or why there is none. */
async function s3Of(s: Services, settings: Settings, view: VolumeView): Promise<{ s3: VolumeS3 } | { why: string }> {
  if (!settings.runpodS3Secret) return { why: "No S3 API key: add its secret in Settings › Rented GPUs to read the volume with no pod running." };
  const { user, dataCenters } = await s3Facts(s, settings);
  const endpoint = dataCenters.includes(view.dataCenter) ? s3Endpoint(view.dataCenter) : null;
  if (!endpoint) return { why: `RunPod's S3 API does not serve ${view.dataCenter}.` };
  if (!user) return { why: "RunPod did not say the account's user id, which the S3 API key goes with: try again in a moment." };
  return { s3: new VolumeS3(view.id, view.dataCenter, { user, secret: settings.runpodS3Secret }, endpoint) };
}

/** The pod running on a volume, when its node pack lists the models folder (0.21.0 on): its ComfyUI, its machine's name. */
async function podOf(s: Services, settings: Settings, view: VolumeView): Promise<{ comfy: Comfy; name: string; machine: string; files: KeptFile[] } | null> {
  if (view.usedBy?.status !== "RUNNING") return null;
  const m = settings.machines.find((x) => x.rented?.pod === view.usedBy!.pod);
  if (!m) return null;
  const comfy = await s.comfyOf(m.id).catch(() => null);
  const files = comfy ? await comfy.client.modelFiles().catch(() => null) : null;
  return comfy && Array.isArray(files) ? { comfy, name: m.name || view.usedBy.name, machine: m.id, files: podListing(files) } : null;
}

/** A listing's files split into their models directory and name; directories' own entries and hidden ones (RunPod's upload parts) left out. */
export function s3Listing(objects: readonly S3Object[]): KeptFile[] {
  return objects.flatMap((o) => {
    if (!o.key.startsWith(MODELS_PREFIX) || o.key.endsWith("/")) return [];
    const rest = o.key.slice(MODELS_PREFIX.length);
    const cut = rest.indexOf("/");
    if (cut <= 0 || rest.split("/").some((part) => part.startsWith(".") || !part)) return [];
    return [{ key: o.key, folder: rest.slice(0, cut), name: rest.slice(cut + 1), bytes: o.size, modified: o.modified, comfy: null }];
  });
}

/** The machines that ran on a volume, now or before: its pods' sessions, and the machines set on it now. */
async function machinesOn(s: Services, volume: string, settings: Settings): Promise<string[]> {
  const rows = await s.db.selectFrom("rent_sessions").select("machine_id").distinct().where("volume", "=", volume).execute();
  return [...new Set([...rows.map((r) => r.machine_id), ...settings.machines.filter((m) => m.rented?.volume === volume).map((m) => m.id)])];
}

/** The files a set of jobs needed, by key: the latest `finished_at` of each (or simply present, for running ones). */
async function filesOfJobs(s: Services, machines: readonly string[], status: "done" | "running"): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!machines.length) return out;
  let q = s.db.selectFrom("jobs").select(["recipe_id", "inputs", "finished_at"]).where("status", "=", status).where("machine_id", "in", [...machines]);
  if (status === "done") q = q.orderBy("finished_at", "desc").limit(USED_JOBS);
  for (const r of await q.execute()) {
    const recipe = s.registry.recipe(r.recipe_id);
    if (!recipe) continue;
    const slots = s.registry.family(recipe.family)?.slots ?? [];
    for (const f of filesUsed(recipe, readJson<Record<string, unknown>>(r.inputs, {}), null, slots)) {
      const key = keyOf(f.folder, f.file);
      const at = r.finished_at ?? "";
      if (!out.has(key) || at > out.get(key)!) out.set(key, at);
    }
  }
  return out;
}

async function volumeOf(s: Services, volume: string): Promise<VolumeView> {
  const view = (await s.rented.volumes()).find((v) => v.id === volume);
  if (!view) throw httpError("RunPod has no such volume on this account.", 404);
  return view;
}

const s3Said = (err: Error) =>
  err instanceof S3Error && (err.status === 401 || err.status === 403) ? `RunPod's S3 API refused the S3 key (${err.message}): check its secret in Settings › Rented GPUs.` : `The volume could not be read: ${err.message}`;

/** What a volume holds, for the viewer: through its pod, else S3, else as last listed. */
export async function volumeFiles(s: Services, volume: string): Promise<VolumeFilesView> {
  const settings = await readSettings(s.db);
  const view = await volumeOf(s, volume);
  const machines = await machinesOn(s, volume, settings);
  const [sets, used, running, hashes] = await Promise.all([
    setsWithFiles(s),
    filesOfJobs(s, machines, "done"),
    filesOfJobs(s, machines, "running"),
    s.db.selectFrom("model_hashes").select(["file", "size"]).execute(),
  ]);
  const here = new Set(hashes.map((h) => `${fileName(h.file).toLowerCase()}|${Number(h.size)}`));
  const setsOf = new Map<string, Array<{ id: string; name: string }>>();
  for (const set of sets) for (const f of set.files) {
    const key = keyOf(f.folder, f.file);
    setsOf.set(key, [...(setsOf.get(key) ?? []), { id: set.id, name: set.name }].filter((x, i, all) => all.findIndex((y) => y.id === x.id) === i));
  }
  const pod = await podOf(s, settings, view);
  const disk = pod ? s.podFiles.diskOf(pod.machine) : null;
  const base = {
    volume: { id: view.id, name: view.name, size: view.size, dataCenter: view.dataCenter, perMonth: view.perMonth, usedBy: view.usedBy },
    used: disk ? Math.max(0, disk.total - disk.free) : null,
  };
  const withFacts = (files: readonly KeptFile[]): VolumeFile[] => files.map((f) => {
    const k = keyOf(folderOf(f), f.name);
    return { ...f, usedAt: used.get(k) || null, sets: setsOf.get(k) ?? [], here: f.bytes !== null && here.has(`${fileName(f.name).toLowerCase()}|${f.bytes}`), inUse: running.has(k) };
  });

  if (pod) {
    await keepListing(s.db, volume, pod.files, pod.name, true);
    return { ...base, source: "pod", canDelete: true, why: null, readAt: new Date().toISOString(), readBy: pod.name, files: withFacts(pod.files) };
  }
  const s3 = await s3Of(s, settings, view);
  if ("s3" in s3) {
    const files = s3Listing(await s3.s3.list(MODELS_PREFIX).catch((err: Error) => {
      throw httpError(s3Said(err), 502);
    }));
    await keepListing(s.db, volume, files, "S3", false);
    return { ...base, source: "s3", canDelete: true, why: null, readAt: new Date().toISOString(), readBy: "S3", files: withFacts(files) };
  }
  // nothing can read it now: as it was last listed, with sizes when that listing had them, else by names
  const why = view.usedBy ? `${s3.why} ${view.usedBy.name} on it has a node pack older than 0.21.0, which cannot list it.` : `${s3.why} Or deploy a pod on it: its node pack lists it.`;
  const kept = (await keptHoldings(s.db)).get(volume);
  const files: KeptFile[] = kept?.listing ?? [...(kept?.keys ?? [])].map((k) => {
    const [folder, name] = [k.slice(0, k.indexOf("|")), k.slice(k.indexOf("|") + 1)];
    return { key: `${MODELS_PREFIX}${folder}/${name}`, folder, name, bytes: null, modified: null, comfy: folder };
  });
  if (!kept?.seenAt || (!kept.listing && !kept.keys)) return { ...base, source: "none", canDelete: false, why, readAt: null, readBy: null, files: [] };
  return { ...base, source: "kept", canDelete: false, why, readAt: kept.seenAt, readBy: kept.seenBy, files: withFacts(files) };
}

export interface DeleteResult {
  deleted: string[];
  /** Files not deleted, with why: in use by a render, outside the models folder, or the pod's or S3's refusal. */
  kept: Array<{ key: string; why: string }>;
}

/**
 * Files of a volume deleted for good (neither the pod nor S3 keeps a bin): through the pod running on it when its node pack
 * can (the file's model folder as the pod lists it), else through S3. Only files of its models folder, never one a render
 * on its pod needs now. Then its holdings are those less these, its pod (when one runs on it) reads its folders again, and a
 * file the pod could not fetch for want of room is fetched again.
 */
export async function deleteVolumeFiles(s: Services, volume: string, keys: readonly string[]): Promise<DeleteResult> {
  const settings = await readSettings(s.db);
  const view = await volumeOf(s, volume);
  const pod = await podOf(s, settings, view);
  const s3 = pod ? null : await s3Of(s, settings, view);
  if (s3 && !("s3" in s3)) throw httpError(`${s3.why} Its files can be deleted while a pod with the node pack 0.21.0 or later runs on it.`, 409);
  const running = await filesOfJobs(s, await machinesOn(s, volume, settings), "running");
  const out: DeleteResult = { deleted: [], kept: [] };
  const gone: KeptFile[] = [];
  for (const key of new Set(keys)) {
    const listed = pod ? pod.files.find((f) => f.key === key) : s3Listing([{ key, size: 0, modified: null }])[0];
    if (!listed || key.includes("..") || key.includes("\\")) {
      out.kept.push({ key, why: pod ? "not a file of the volume's models folder, as its pod lists it" : "not a file of the volume's models folder" });
      continue;
    }
    if (running.has(keyOf(folderOf(listed), listed.name))) {
      out.kept.push({ key, why: "a render running on the volume needs it now" });
      continue;
    }
    try {
      if (pod) await pod.comfy.client.removeModel(listed.comfy!, listed.name);
      else await (s3 as { s3: VolumeS3 }).s3.remove(key);
      out.deleted.push(key);
      gone.push(listed);
    } catch (err) {
      out.kept.push({ key, why: (err as Error).message });
    }
  }
  if (gone.length) {
    const kept = (await keptHoldings(s.db)).get(volume);
    if (kept?.listing) await keepListing(s.db, volume, kept.listing.filter((f) => !gone.some((g) => g.key === f.key)), kept.seenBy ?? "S3", false);
    else if (kept?.keys) {
      for (const g of gone) kept.keys.delete(keyOf(folderOf(g), g.name));
      await s.db.updateTable("volume_files").set({ files: JSON.stringify([...kept.keys].sort()) }).where("volume_id", "=", volume).execute();
    }
    if (pod) s.podFiles.freed(pod.machine, gone.map((g) => ({ folder: folderOf(g), file: g.name })));
    else {
      const m = view.usedBy ? settings.machines.find((x) => x.rented?.pod === view.usedBy!.pod) : null;
      if (m) s.podFiles.freed(m.id, gone.map((g) => ({ folder: folderOf(g), file: g.name })));
    }
  }
  return out;
}
