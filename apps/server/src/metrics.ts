import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { allowedHosts, hostAllowed } from "./hostCheck";
import { costMetrics } from "./costMetrics";
import { BUCKETS } from "./renderDigests";
import { machinePaces } from "./forecast";
import { tallyByRecipe, type RecipeSum } from "./rendersRead";
import { serverRegistry } from "./serverMetrics";
import type { Services } from "./services";

/**
 * The figures as Prometheus reads them, at /metrics (no key: a metrics scraper is on the inside of the
 * network). What the record of render times holds, as counters, plus what is going on now, as gauges.
 * The counters come from the record itself, folded days included, so that they only ever grow (until
 * the record is forgotten in Settings). A Grafana dashboard for them is in deploy/grafana/.
 *
 * A scraper asks by the pod's address, so any Host is answered (hostCheck.ts ANY_HOST); so is a page that
 * pointed a name of its own at this machine (DNS rebinding). Asked by a name that is not the server's own,
 * an imported workflow is named by a hash of its id: its id and title are the user's words. Built-in
 * recipes keep their names, which are Afflatus's own.
 */

const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
const labels = (l: Record<string, string>) => {
  const parts = Object.entries(l).filter(([, v]) => v !== "").map(([k, v]) => `${k}="${esc(v)}"`);
  return parts.length ? `{${parts.join(",")}}` : "";
};

export function registerMetrics(app: FastifyInstance, s: Services): void {
  const hosts = allowedHosts();
  /**
   * The record summed up by recipe, kept between scrapes: the whole table is only read again when it
   * changed (a render landed, the hourly fold moved rows into days, the record was forgotten). A scraper
   * asks every few seconds; the sums are the same nearly every time.
   */
  let summed: { mark: string; by: Map<string, RecipeSum> } | null = null;
  const tally = async (): Promise<Map<string, RecipeSum>> => {
    const stats = await s.db.selectFrom("render_stats").select((eb) => [eb.fn.countAll<number>().as("n"), eb.fn.max("created_at").as("at"), eb.fn.sum<number>("total_ms").as("ms")]).executeTakeFirstOrThrow();
    const folded = await s.db.selectFrom("render_days").select((eb) => eb.fn.countAll<number>().as("n")).executeTakeFirstOrThrow();
    const mark = `${stats.n}|${stats.at ?? ""}|${stats.ms ?? 0}|${folded.n}`;
    if (summed?.mark === mark) return summed.by;
    const by = await tallyByRecipe(s.db);
    summed = { mark, by };
    return by;
  };

  const money = costMetrics(s);

  app.get("/metrics", async (req, reply) => {
    const own = hostAllowed(req.headers.host, hosts);
    const lines: string[] = [];
    const head = (name: string, type: "counter" | "gauge" | "histogram", help: string) => lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    const put = (name: string, l: Record<string, string>, value: number) => lines.push(`${name}${labels(l)} ${Number.isFinite(value) ? value : 0}`);

    // ---- now
    const q = await s.queue.counts();
    head("afflatus_queue_jobs", "gauge", "Jobs in Afflatus's queue, by state");
    put("afflatus_queue_jobs", { state: "queued" }, q.waiting);
    put("afflatus_queue_jobs", { state: "running" }, q.running ? 1 : 0);
    // each ComfyUI asked now (the queue only knows one is away once a job found it so), labelled by its machine: its id,
    // and its name only when asked by the server's own name (a name is the user's words). With one ComfyUI the series
    // are those of before, with machine="m1"
    head("afflatus_comfy_online", "gauge", "1 when a ComfyUI answers");
    head("afflatus_gpu_busy", "gauge", "1 while a render holds a machine's GPU: Afflatus's, or work queued in its ComfyUI from elsewhere");
    const gauges: Array<[string, string, (l: NonNullable<Awaited<ReturnType<Awaited<ReturnType<typeof s.comfy>>["load"]>>>) => number | undefined]> = [
      ["afflatus_gpu_memory_percent", "Share of the GPU's memory in use, as the machine reports it", (l) => l.gpus[0]?.vramPercent],
      ["afflatus_gpu_temperature_celsius", "The GPU's temperature", (l) => l.gpus[0]?.temperature],
      ["afflatus_gpu_load_percent", "The GPU's load", (l) => l.gpus[0]?.load],
    ];
    const paces = await machinePaces(s.db);
    const rows: string[][] = gauges.map(() => []);
    const paced: string[] = [];
    for (const { machine, comfy } of await s.machines()) {
      const l = { machine: machine.id, name: own ? machine.name : "" };
      const load = await comfy.load().catch(() => null);
      put("afflatus_comfy_online", l, load ? 1 : 0);
      put("afflatus_gpu_busy", l, q.busy.has(machine.id) ? 1 : 0);
      gauges.forEach(([name, , read], i) => {
        const v = load ? read(load) : undefined;
        if (v !== undefined) rows[i]!.push(`${name}${labels(l)} ${v}`);
      });
      const pace = paces.get(machine.id);
      if (pace !== undefined) paced.push(`afflatus_machine_pace${labels(l)} ${pace}`);
    }
    gauges.forEach(([name, help], i) => {
      if (!rows[i]!.length) return;
      head(name, "gauge", help);
      lines.push(...rows[i]!);
    });
    if (paced.length) {
      head("afflatus_machine_pace", "gauge", "A machine's learned pace against the others on the same model and settings: 1 the common pace, 2 half as fast");
      lines.push(...paced);
    }

    // ---- the record, folded days included: by recipe
    const by = await tally();
    const names = Object.fromEntries([...by.keys()].map((id) => {
      const recipe = s.registry.recipe(id);
      // a workflow removed since still has its renders on record, and its id is still the user's words
      if (!own && (!recipe || s.registry.workflow(id))) {
        const hidden = `workflow-${createHash("sha256").update(id).digest("hex").slice(0, 10)}`;
        return [id, { recipe: hidden, family: "", title: hidden }];
      }
      const family = recipe ? s.registry.family(recipe.family)?.name ?? recipe.family : "";
      return [id, { recipe: id, family, title: recipe?.title ?? id }];
    }));
    const tag = (id: string) => ({ recipe: names[id]!.recipe, family: names[id]!.family, title: names[id]!.title });
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

    // ---- the rented GPUs' money (costMetrics.ts): spend by part and GPU, the day, the month, the caps, the balance
    await money(head, put);

    // ---- the server itself (serverMetrics.ts): Node's figures, and what Afflatus adds to each render per machine
    lines.push((await serverRegistry.metrics()).trimEnd());
    reply.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    return `${lines.join("\n")}\n`;
  });
}
