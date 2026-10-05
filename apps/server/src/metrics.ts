import type { FastifyInstance } from "fastify";
import type { Cell } from "./renders";
import { BUCKETS } from "./renders";
import type { Services } from "./services";

/**
 * The figures as Prometheus reads them, at /metrics (no key: a metrics scraper is on the inside of the
 * network). What the record of render times holds, as counters, plus what is going on now, as gauges.
 * The counters come from the record itself, folded days included, so that they only ever grow (until
 * the record is forgotten in Settings). A Grafana dashboard for them is in deploy/grafana/.
 */

const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
const labels = (l: Record<string, string>) => {
  const parts = Object.entries(l).filter(([, v]) => v !== "").map(([k, v]) => `${k}="${esc(v)}"`);
  return parts.length ? `{${parts.join(",")}}` : "";
};

interface Sum { done: number; failed: number; cancelled: number; cold: number; total: number; doneTotal: number; load: number; sample: number; refine: number; finish: number; waited: number; video: number; hist: number[] }

export function registerMetrics(app: FastifyInstance, s: Services): void {
  /**
   * The record summed up by recipe, kept between scrapes: the whole table is only read again when it
   * changed (a render landed, the hourly fold moved rows into days, the record was forgotten). A scraper
   * asks every few seconds; the sums are the same nearly every time.
   */
  let summed: { mark: string; by: Map<string, Sum> } | null = null;
  const tally = async (): Promise<Map<string, Sum>> => {
    const stats = await s.db.selectFrom("render_stats").select((eb) => [eb.fn.countAll<number>().as("n"), eb.fn.max("created_at").as("at"), eb.fn.sum<number>("total_ms").as("ms")]).executeTakeFirstOrThrow();
    const folded = await s.db.selectFrom("render_days").select((eb) => eb.fn.countAll<number>().as("n")).executeTakeFirstOrThrow();
    const mark = `${stats.n}|${stats.at ?? ""}|${stats.ms ?? 0}|${folded.n}`;
    if (summed?.mark === mark) return summed.by;
    const rows = await s.db.selectFrom("render_stats").select(["recipe_id", "status", "kind", "total_ms", "load_ms", "sample_ms", "refine_ms", "finish_ms", "waited_ms", "duration_ms", "cold"]).execute();
    const days = await s.db.selectFrom("render_days").select(["recipe_id", "figures"]).where("recipe_id", "!=", "*").execute();
    const by = new Map<string, Sum>();
    const of = (recipe: string) => {
      let v = by.get(recipe);
      if (!v) by.set(recipe, (v = { done: 0, failed: 0, cancelled: 0, cold: 0, total: 0, doneTotal: 0, load: 0, sample: 0, refine: 0, finish: 0, waited: 0, video: 0, hist: BUCKETS.map(() => 0) }));
      return v;
    };
    for (const r of rows) {
      const v = of(r.recipe_id);
      v[r.status]++;
      v.cold += r.cold;
      v.total += r.total_ms; v.load += r.load_ms; v.sample += r.sample_ms; v.refine += r.refine_ms; v.finish += r.finish_ms; v.waited += r.waited_ms;
      if (r.status === "done") v.doneTotal += r.total_ms;
      if (r.status === "done" && r.kind === "video") v.video += r.duration_ms ?? 0;
      if (r.status === "done") BUCKETS.forEach((le, i) => { if (r.total_ms / 1000 <= le) v.hist[i]!++; });
    }
    for (const d of days) {
      const c = JSON.parse(d.figures) as Cell;
      const v = of(d.recipe_id);
      v.done += c.done; v.failed += c.failed; v.cancelled += c.cancelled; v.cold += c.cold;
      v.total += c.totalMs; v.doneTotal += c.totalMs - c.lostMs; v.load += c.loadMs; v.sample += c.sampleMs; v.refine += c.refineMs; v.finish += c.finishMs; v.video += c.videoMs;
      v.waited += (c.waitedUsualMs ?? 0) * c.renders;
      (c.hist ?? []).forEach((n, i) => { if (v.hist[i] !== undefined) v.hist[i] += n; });
    }
    summed = { mark, by };
    return by;
  };

  app.get("/metrics", async (_req, reply) => {
    const lines: string[] = [];
    const head = (name: string, type: "counter" | "gauge" | "histogram", help: string) => lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    const put = (name: string, l: Record<string, string>, value: number) => lines.push(`${name}${labels(l)} ${Number.isFinite(value) ? value : 0}`);

    // ---- now
    const q = await s.queue.status();
    head("afflatus_queue_jobs", "gauge", "Jobs in Afflatus's queue, by state");
    put("afflatus_queue_jobs", { state: "queued" }, q.waiting.length);
    put("afflatus_queue_jobs", { state: "running" }, q.running ? 1 : 0);
    // asked now: the queue only knows ComfyUI is away once a job found it so
    const load = await (await s.comfy()).load().catch(() => null);
    head("afflatus_comfy_online", "gauge", "1 when ComfyUI answers");
    put("afflatus_comfy_online", {}, load ? 1 : 0);
    head("afflatus_gpu_busy", "gauge", "1 while a Afflatus render holds the GPU");
    put("afflatus_gpu_busy", {}, q.running && q.running.kind !== "export" ? 1 : 0);
    const gpu = load?.gpus[0];
    if (gpu) {
      head("afflatus_gpu_memory_percent", "gauge", "Share of the GPU's memory in use, as ComfyUI's machine reports it");
      put("afflatus_gpu_memory_percent", {}, gpu.vramPercent);
      if (gpu.temperature !== undefined) {
        head("afflatus_gpu_temperature_celsius", "gauge", "The GPU's temperature");
        put("afflatus_gpu_temperature_celsius", {}, gpu.temperature);
      }
      if (gpu.load !== undefined) {
        head("afflatus_gpu_load_percent", "gauge", "The GPU's load");
        put("afflatus_gpu_load_percent", {}, gpu.load);
      }
    }

    // ---- the record, folded days included: by recipe
    const by = await tally();
    const names = Object.fromEntries([...by.keys()].map((id) => {
      const recipe = s.registry.recipe(id);
      const family = recipe ? s.registry.family(recipe.family)?.name ?? recipe.family : "";
      return [id, { family, title: recipe?.title ?? id }];
    }));
    const tag = (id: string) => ({ recipe: id, family: names[id]!.family, title: names[id]!.title });
    head("afflatus_renders_total", "counter", "Renders that ran on ComfyUI, by recipe and how they ended");
    for (const [id, v] of by) for (const status of ["done", "failed", "cancelled"] as const) put("afflatus_renders_total", { ...tag(id), status }, v[status]);
    head("afflatus_render_model_loads_total", "counter", "Renders that had to load their model first");
    for (const [id, v] of by) put("afflatus_render_model_loads_total", tag(id), v.cold);
    head("afflatus_render_seconds_total", "counter", "GPU time of renders, by recipe and phase");
    for (const [id, v] of by) for (const phase of ["load", "sample", "refine", "finish"] as const) put("afflatus_render_seconds_total", { ...tag(id), phase: { load: "loading", sample: "sampling", refine: "refining", finish: "finishing" }[phase] }, v[phase] / 1000);
    head("afflatus_render_wait_seconds_total", "counter", "Time renders waited in the queue before starting");
    for (const [id, v] of by) put("afflatus_render_wait_seconds_total", tag(id), v.waited / 1000);
    head("afflatus_video_seconds_total", "counter", "Length of the videos made");
    for (const [id, v] of by) put("afflatus_video_seconds_total", tag(id), v.video / 1000);
    head("afflatus_render_duration_seconds", "histogram", "How long finished renders took, by recipe");
    for (const [id, v] of by) {
      BUCKETS.forEach((le, i) => put("afflatus_render_duration_seconds_bucket", { ...tag(id), le: String(le) }, v.hist[i]!));
      put("afflatus_render_duration_seconds_bucket", { ...tag(id), le: "+Inf" }, v.done);
      put("afflatus_render_duration_seconds_count", tag(id), v.done);
      put("afflatus_render_duration_seconds_sum", tag(id), v.doneTotal / 1000);
    }
    reply.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    return `${lines.join("\n")}\n`;
  });
}
