import type { Db } from "./db";
import type { CostsView } from "./costs";
import { csvOf, dollars4, seconds, utc, type CsvCell } from "./csv";
import { machineSaid } from "./notifyWords";
import type { Registry } from "./registry";
import type { Spending } from "./rentedBilling";
import { nameOf, outOfMemory } from "./rendersRead";
import type { Settings } from "./settings";
import { buildOf } from "./podImage";

/**
 * What the Queue's Costs and Render times tabs export as CSV (csv.ts writes it): every row of the window and filters the
 * tab shows, not only those drawn. Only figures Afflatus keeps or works out already: a column it has no figure for is left
 * out rather than guessed. Never a prompt, nor a path of the user's library (a model file goes by its name alone).
 */

const HOUR = 3_600_000;

/** A machine as the files name it: its own name, else "ComfyUI m2" (a removed pod's id, as the queue says it). */
const machineName = (settings: Settings, id: string | null): string | null => {
  if (!id) return null;
  return machineSaid(settings.machines.find((m) => m.id === id) ?? { id, name: "" });
};

export const COSTS_HEADERS = [
  "kind", "started_utc", "ended_utc", "machine", "gpu", "cuda", "host_cuda", "data_center", "rate_usd_per_hour",
  "boot_s", "image_pull_s", "image_pull_mb_per_s", "node_packs_s", "comfyui_start_s", "failed_start_s", "failed_start_step",
  "fetch_s", "render_s", "failed_render_s", "outside_s", "idle_s", "renders", "files_fetched", "fetched_bytes", "idle_stop_minutes", "estimated",
  "volumes", "counted_usd", "billed_usd",
] as const;

/**
 * The Costs tab's file: a row per pod session that ran in the window, whole (its time from its deploy or Start to its end,
 * as the tab's Sessions list shows it, so a session across an end of the window is not cut), the oldest first; then, when the
 * window reaches into this month and RunPod gave it, the volumes' bill this month so far as a row of its own. A boot from
 * before its parts were kept (the tab's "Earlier boots") has its parts empty and its whole in `boot_s`. The pods' own disks
 * are billed within the pods' bill (RunPod bills a disk with its GPU): not a row of their own, which would count them twice.
 */
export function costsCsv(view: CostsView, spending: Spending | null, settings: Settings, now = Date.now()): string {
  const rows: CsvCell[][] = [];
  for (const s of [...view.sessions].sort((a, b) => a.from - b.from)) {
    // its boot in parts only where they were kept: an earlier boot is one whole
    const split = s.boot.boot === 0;
    const part = (ms: number) => (split ? seconds(ms) : null);
    rows.push([
      "session", utc(s.from), s.open ? null : utc(s.to), machineName(settings, s.machine), s.gpu === "GPU" ? null : s.gpu, s.cuda, s.hostCuda, s.dataCenter, dollars4(s.rate),
      seconds(s.parts.boot), part(s.boot.pull), s.pull?.fresh && s.pull.mbps !== null ? Math.round(s.pull.mbps * 10) / 10 : null, part(s.boot.packs), part(s.boot.comfy), part(s.boot.startFailed), s.startFailed,
      seconds(s.parts.fetch), seconds(s.parts.render), seconds(s.parts.failed), seconds(s.parts.outside), seconds(s.parts.idle), s.renders.length, s.fetched.files, s.fetched.bytes, s.idleMinutes, s.estimated.join("; ") || null,
      null, dollars4(s.usd), null,
    ]);
  }
  const d = new Date(now);
  const monthFrom = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const volumesBill = spending?.storage?.volumesMonth;
  if (volumesBill !== null && volumesBill !== undefined && view.to > monthFrom) {
    rows.push([
      "volumes", utc(monthFrom), utc(now), null, null, null, null, null, null,
      null, null, null, null, null, null, null,
      null, null, null, null, null, null, null, null, null, null,
      spending!.storage!.volumes, null, dollars4(volumesBill),
    ]);
  }
  return csvOf(COSTS_HEADERS, rows);
}

export const RENDERS_HEADERS = [
  "finished_utc", "status", "out_of_memory", "machine", "gpu", "cuda", "recipe", "recipe_id", "model_family", "model", "model_file", "kind",
  "width", "height", "video_length_s", "steps", "cold_load", "total_s", "queue_wait_s", "load_s", "sampling_s", "refining_s", "finishing_s",
  "s_per_step", "expected_s", "vram_peak_pct", "gpu_temp_peak_c", "energy_wh", "power_avg_w", "rented_usd", "electricity_cost", "electricity_currency",
] as const;

/** The Render times tab's filters: its window (ms), and its machine, model (a recipe) and "failed or cancelled" as the list takes them. */
export interface RendersAsked { from?: number; to?: number; machine?: string; recipe?: string; trouble?: boolean }

/**
 * The Render times tab's file: a row per render on record in the window and filters, the oldest first, every one of them
 * (the list pages by 500 at most; this reads them all). A render on a pod costs its time at its session's rate (as the
 * Costs tab counts it); one of this PC's, its energy at the price set in Settings › Costs, in the currency set there.
 */
export async function rendersCsv(db: Db, registry: Registry, settings: Settings, asked: RendersAsked): Promise<string> {
  let q = db.selectFrom("render_stats").select([
    "id", "created_at", "status", "machine_id", "gpu", "recipe_id", "family", "model", "model_file", "kind", "width", "height", "duration_ms", "steps", "cold",
    "total_ms", "waited_ms", "load_ms", "sample_ms", "refine_ms", "finish_ms", "step_ms", "expected_ms", "vram_peak", "heat_peak", "energy_wh", "power_avg_w",
  ]);
  if (asked.from !== undefined) q = q.where("created_at", ">=", new Date(asked.from).toISOString());
  if (asked.to !== undefined) q = q.where("created_at", "<", new Date(asked.to).toISOString());
  if (asked.machine) q = q.where("machine_id", "=", asked.machine);
  if (asked.recipe) q = q.where("recipe_id", "=", asked.recipe);
  if (asked.trouble) q = q.where("status", "!=", "done");
  const rows = await q.orderBy("created_at", "asc").orderBy("id", "asc").execute();
  const oom = await outOfMemory(db, rows);
  // the pods' runs, for a render's rate: a render is a pod's only within a run of its machine (as costs.ts onPod has it)
  const runs = rows.length ? await db.selectFrom("rent_sessions").select(["machine_id", "started_at", "ended_at", "rate", "image"]).execute() : [];
  const runOf = (r: (typeof rows)[number]) => {
    if (!r.machine_id) return null;
    const end = Date.parse(r.created_at);
    const start = end - r.total_ms;
    return runs.find((x) => x.machine_id === r.machine_id && Date.parse(x.started_at) < end && (x.ended_at === null || Date.parse(x.ended_at) > start)) ?? null;
  };
  const price = settings.costs.kwhPrice;
  const names = new Map<string, string>();
  const name = (recipe: string) => names.get(recipe) ?? names.set(recipe, nameOf(registry, recipe)).get(recipe)!;
  const out: CsvCell[][] = rows.map((r) => {
    const run = runOf(r);
    const rate = run?.rate ?? null;
    const local = rate === null && r.energy_wh !== null && price !== null;
    return [
      utc(Date.parse(r.created_at)), r.status, oom.has(r.id), machineName(settings, r.machine_id), r.gpu, buildOf(run?.image), name(r.recipe_id), r.recipe_id, r.family || null, r.model || null,
      // its file's name alone: the folders it sits in are the user's library
      r.model_file ? r.model_file.split(/[\\/]/).pop() : null, r.kind,
      r.width, r.height, seconds(r.duration_ms), r.steps, Boolean(r.cold), seconds(r.total_ms), seconds(r.waited_ms), seconds(r.load_ms), seconds(r.sample_ms), seconds(r.refine_ms), seconds(r.finish_ms),
      r.step_ms === null ? null : Math.round(r.step_ms) / 1000, seconds(r.expected_ms), r.vram_peak === null ? null : Math.round(r.vram_peak * 10) / 10, r.heat_peak,
      r.energy_wh === null ? null : Math.round(r.energy_wh * 1000) / 1000, r.power_avg_w === null ? null : Math.round(r.power_avg_w * 10) / 10,
      rate === null ? null : dollars4((r.total_ms / HOUR) * rate),
      local ? dollars4((r.energy_wh! / 1000) * price!) : null, local ? settings.costs.currency : null,
    ];
  });
  return csvOf(RENDERS_HEADERS, out);
}
