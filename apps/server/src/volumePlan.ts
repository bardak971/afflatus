import { stat } from "node:fs/promises";
import type { PresetFile } from "@afflatus/core";
import { notFound } from "./errors";
import { setsWithFiles } from "./modelSets";
import { estimateFiles, rangeOrGuess, type FilesEstimate, type MeasureKind } from "./podMeasures";
import { localCopy } from "./podSources";
import { licencesPending } from "./presetFiles";
import { keptHoldings, lackingOn, missingOn, VOLUME_MAX_GB, VOLUME_MIN_GB } from "./rentedVolumes";
import type { Services } from "./services";
import { readSettings } from "./settings";

/**
 * What Make a volume… says before anything is billed: where a volume can go (the data centers with GPUs in stock now,
 * and the user's pods there), what size the user's Model sets want, and whether a volume pays for itself at the user's
 * pace: the deploys of the last 30 days, each of which fetched the sets' files at the speeds measured.
 */

/** A data center a volume can be made in: the GPUs in stock there now (cheapest first), and the user's pods there now. */
export interface VolumePlace {
  dataCenter: string;
  gpus: Array<{ name: string; price: number }>;
  pods: number;
}

export interface VolumePlan {
  places: VolumePlace[];
  /** The sets weighed, with their bytes as far as known. */
  sets: Array<{ id: string; name: string; bytes: number }>;
  /** The size the sets want with room to spare (a quarter more, in tens of GB). */
  sizeGb: number;
  /** The pods run in the last 30 days, and their mean rate ($/h); 0 and null without any. */
  deploys: number;
  rate: number | null;
  /** How long fetching the sets takes each deploy, and what that time costs at the mean rate; null without a pod run lately. */
  fetch: FilesEstimate | null;
}

const MONTH_MS = 30 * 24 * 3_600_000;

/**
 * A set's files with their sizes, where the set says none, as this computer knows them: its hash of the file in its
 * ComfyUI folders (model_hashes: by the file's path, else by its name when one file has it), else the file itself there.
 * An upscaler added to a set by its name was counted as of unknown size, and left out of a fill's time and cost, though
 * its bytes were known here.
 */
export async function sized(s: Services, files: PresetFile[]): Promise<PresetFile[]> {
  if (files.every((f) => f.size)) return files;
  const [rows, settings] = await Promise.all([s.db.selectFrom("model_hashes").select(["folder", "file", "size"]).execute().catch(() => []), readSettings(s.db)]);
  const nameOf = (file: string) => (file.split(/[\\/]/).pop() ?? file).toLowerCase();
  const pathOf = (file: string) => file.replace(/\\/g, "/").toLowerCase();
  const byPath = new Map(rows.map((r) => [`${r.folder}|${pathOf(r.file)}`, Number(r.size)]));
  const byName = new Map<string, number[]>();
  for (const r of rows) {
    const key = `${r.folder}|${nameOf(r.file)}`;
    byName.set(key, [...(byName.get(key) ?? []), Number(r.size)]);
  }
  const onDisk = async (f: PresetFile) => {
    const path = settings.comfyDir ? await localCopy(settings.comfyDir, f.folder, f.file).catch(() => null) : null;
    return path ? (await stat(path).catch(() => null))?.size : undefined;
  };
  return Promise.all(files.map(async (f) => {
    if (f.size) return f;
    const named = byName.get(`${f.folder}|${nameOf(f.file)}`) ?? [];
    const size = byPath.get(`${f.folder}|${pathOf(f.file)}`) ?? (named.length === 1 ? named[0] : undefined) ?? (await onDisk(f));
    return size ? { ...f, size } : f;
  }));
}

/**
 * The files of known size with the source a pod would fetch each from, found as a deploy finds it (podSources.ts podSource,
 * through podFiles.about): a preset's or a family's address, the Civitai version or Hugging Face file its hash was matched
 * to, else an upload from this computer. A set's upscaler matched by its hash to Civitai was taken for an upload, never
 * measured, and the whole fill's time went unsaid. A file nothing can give is left out: no pod fetches it.
 */
async function fetchedAs(s: Services, files: PresetFile[]): Promise<Array<{ bytes: number; kind: Exclude<MeasureKind, "boot"> }>> {
  const kinds = await Promise.all(files.filter((f) => f.size).map(async (f) => ({ bytes: f.size!, kind: (await s.podFiles.about(f).catch(() => null))?.via ?? null })));
  return kinds.filter((k): k is { bytes: number; kind: Exclude<MeasureKind, "boot"> } => k.kind !== null);
}

/** The size a volume wants for these bytes: a quarter more, up to the next ten GB, within what RunPod takes. */
export const sizeFor = (bytes: number) => Math.min(VOLUME_MAX_GB, Math.max(VOLUME_MIN_GB, Math.ceil((bytes * 1.25) / 1e9 / 10) * 10));

export async function volumePlan(s: Services, setIds: string[] | null): Promise<VolumePlan> {
  const now = Date.now();
  const [gpus, pods, allSets, sessions, takeVolumes] = await Promise.all([
    // network volumes are Secure Cloud's only
    s.rented.gpus("SECURE"),
    s.rented.pods().catch(() => []),
    setsWithFiles(s),
    s.db.selectFrom("rent_sessions").select(["pod", "rate"]).where("started_at", ">", new Date(now - MONTH_MS).toISOString()).execute(),
    s.rented.volumeDataCenters(),
  ]);
  const byPlace = new Map<string, VolumePlace>();
  for (const g of gpus) {
    for (const d of g.dataCenters) {
      // in stock, and a place that takes a volume (not every data center does)
      if (d.availability === "NONE" || (takeVolumes && !takeVolumes.includes(d.id))) continue;
      const place = byPlace.get(d.id) ?? { dataCenter: d.id, gpus: [], pods: 0 };
      place.gpus.push({ name: g.name, price: g.price });
      byPlace.set(d.id, place);
    }
  }
  for (const p of pods) if (p.dataCenter && p.status !== "TERMINATED" && byPlace.has(p.dataCenter)) byPlace.get(p.dataCenter)!.pods++;
  const places = [...byPlace.values()].map((p) => ({ ...p, gpus: p.gpus.sort((a, b) => a.price - b.price) })).sort((a, b) => b.pods - a.pods || b.gpus.length - a.gpus.length);
  const chosen = await Promise.all((setIds ? allSets.filter((x) => setIds.includes(x.id)) : allSets).map(async (x) => ({ ...x, files: await sized(s, x.files) })));
  // each file once, over the sets weighed
  const files = new Map<string, PresetFile>();
  for (const set of chosen) for (const f of set.files) files.set(`${f.folder}|${f.file}`, f);
  const bytes = [...files.values()].reduce((n, f) => n + (f.size ?? 0), 0);
  const runs = new Map<string, number>();
  for (const r of sessions) runs.set(r.pod, r.rate);
  const rate = runs.size ? [...runs.values()].reduce((n, r) => n + r, 0) / runs.size : null;
  const kinds = await fetchedAs(s, [...files.values()]);
  const fetch = kinds.length && rate !== null ? await estimateFiles(s.db, kinds, "SECURE", rate) : null;
  return {
    places, sets: chosen.map((x) => ({ id: x.id, name: x.name, bytes: x.files.reduce((n, f) => n + (f.size ?? 0), 0) })),
    sizeGb: sizeFor(bytes), deploys: runs.size, rate, fetch,
  };
}

/** What Fill from a set… says before it deploys: the GPU it takes and its price, what the volume lacks of the set, how long and what it costs. */
export interface FillPlan {
  gpu: { name: string; price: number } | null;
  /** The set's files the volume lacks as last seen (all of them when it was never seen), and their bytes as far as known. */
  missing: { count: number; bytes: number; unknown: number };
  /**
   * The files' fetch at the measured speeds and the GPU's price, plus the pod's boot as measured; `guessed` when a source
   * or the boot was never measured and its guess is in it. Null without a GPU in stock.
   */
  estimate: { fastMs: number; slowMs: number; lowUsd: number; highUsd: number; guessed: boolean } | null;
  /** The presets of the set's files under a licence not accepted yet: Fill asks for each, as Deploy does. */
  licences: Array<{ id: string; name: string; licence: string }>;
}

export async function fillPlan(s: Services, volume: string, setId: string): Promise<FillPlan> {
  const [found, sets, kept] = await Promise.all([s.rented.fillGpu(volume), setsWithFiles(s), keptHoldings(s.db)]);
  const set = sets.find((x) => x.id === setId);
  if (!set) throw notFound("that model set");
  const licences = (await licencesPending(s, set.files)).map((p) => ({ id: p.id, name: p.name, licence: p.licence!.name }));
  const keys = kept.get(volume)?.keys ?? new Set<string>();
  const files = await sized(s, set.files);
  const lacking = lackingOn(files, keys);
  const missing = missingOn(files, keys);
  if (!found) return { gpu: null, missing, estimate: null, licences };
  const kinds = await fetchedAs(s, lacking);
  const [fetch, boot] = await Promise.all([estimateFiles(s.db, kinds, "SECURE", found.gpu.price), rangeOrGuess(s.db, "boot", "SECURE")]);
  const usd = (ms: number) => (ms / 3_600_000) * found.gpu.price;
  const estimate = { fastMs: fetch.fastMs + boot.low, slowMs: fetch.slowMs + boot.high, lowUsd: usd(fetch.fastMs + boot.low), highUsd: usd(fetch.slowMs + boot.high), guessed: fetch.guessed || boot.guessed };
  return { gpu: { name: found.gpu.name, price: found.gpu.price }, missing, estimate, licences };
}
