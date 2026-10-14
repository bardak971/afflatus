import type { PresetFile } from "@afflatus/core";
import { setsWithFiles } from "./modelSets";
import { estimateFiles, type FilesEstimate } from "./podMeasures";
import { measureKind, presetSource } from "./podSources";
import { VOLUME_MAX_GB, VOLUME_MIN_GB, VOLUME_PER_GB_MONTH } from "./rentedVolumes";
import type { Services } from "./services";

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
  perGbMonth: number;
  /** The pods run in the last 30 days, and their mean rate ($/h); 0 and null without any. */
  deploys: number;
  rate: number | null;
  /** How long fetching the sets takes each deploy, and what that time costs at the mean rate; null when never measured. */
  fetch: FilesEstimate | null;
}

const MONTH_MS = 30 * 24 * 3_600_000;

/** The size a volume wants for these bytes: a quarter more, up to the next ten GB, within what RunPod takes. */
export const sizeFor = (bytes: number) => Math.min(VOLUME_MAX_GB, Math.max(VOLUME_MIN_GB, Math.ceil((bytes * 1.25) / 1e9 / 10) * 10));

export async function volumePlan(s: Services, setIds: string[] | null): Promise<VolumePlan> {
  const now = Date.now();
  const [gpus, pods, allSets, sessions] = await Promise.all([
    // network volumes are Secure Cloud's only
    s.rented.gpus("SECURE"),
    s.rented.pods().catch(() => []),
    setsWithFiles(s),
    s.db.selectFrom("rent_sessions").select(["pod", "rate"]).where("started_at", ">", new Date(now - MONTH_MS).toISOString()).execute(),
  ]);
  const byPlace = new Map<string, VolumePlace>();
  for (const g of gpus) {
    for (const d of g.dataCenters) {
      if (d.availability === "NONE") continue;
      const place = byPlace.get(d.id) ?? { dataCenter: d.id, gpus: [], pods: 0 };
      place.gpus.push({ name: g.name, price: g.price });
      byPlace.set(d.id, place);
    }
  }
  for (const p of pods) if (p.dataCenter && p.status !== "TERMINATED" && byPlace.has(p.dataCenter)) byPlace.get(p.dataCenter)!.pods++;
  const places = [...byPlace.values()].map((p) => ({ ...p, gpus: p.gpus.sort((a, b) => a.price - b.price) })).sort((a, b) => b.pods - a.pods || b.gpus.length - a.gpus.length);
  const chosen = setIds ? allSets.filter((x) => setIds.includes(x.id)) : allSets;
  // each file once, over the sets weighed
  const files = new Map<string, PresetFile>();
  for (const set of chosen) for (const f of set.files) files.set(`${f.folder}|${f.file}`, f);
  const bytes = [...files.values()].reduce((n, f) => n + (f.size ?? 0), 0);
  const runs = new Map<string, number>();
  for (const r of sessions) runs.set(r.pod, r.rate);
  const rate = runs.size ? [...runs.values()].reduce((n, r) => n + r, 0) / runs.size : null;
  const kinds = [...files.values()].filter((f) => f.size).map((f) => {
    const src = presetSource(f);
    return { bytes: f.size!, kind: src ? measureKind(src) : ("upload" as const) };
  });
  const fetch = kinds.length && rate !== null ? await estimateFiles(s.db, kinds, "SECURE", rate) : null;
  return {
    places, sets: chosen.map((x) => ({ id: x.id, name: x.name, bytes: x.files.reduce((n, f) => n + (f.size ?? 0), 0) })),
    sizeGb: sizeFor(bytes), perGbMonth: VOLUME_PER_GB_MONTH, deploys: runs.size, rate, fetch,
  };
}
