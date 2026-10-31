import type { Db, Tables } from "../apps/server/src/db";

/**
 * Pretend pod sessions for the demo's Queue › Costs tab (with DEMO_RUNPOD=1): a week of them, each with its first answer,
 * its files and its renders, written once when the demo's database has none. Only the demo: the real app keeps real ones.
 */

const MIN = 60_000;

interface Plan {
  hoursAgo: number;
  gpu: string;
  rate: number;
  bootMin: number;
  /** Files fetched: name, GB, minutes. */
  files: Array<[string, number, number]>;
  /** Renders: recipe, minutes each, how many, and how many of them failed. */
  renders: Array<[string, number, number, number]>;
  idleMin: number;
  /** Its boot in parts (0076): minutes pulling the image, the packs whose Python packages it installed (minutes each), the step its start failed at. None: a session before them, its boot plain. */
  pullMin?: number;
  packs?: Array<[string, number]>;
  failed?: string;
}

const PLANS: Plan[] = [
  { hoursAgo: 2, gpu: "NVIDIA RTX 2000 Ada Generation", rate: 0.24, bootMin: 4, files: [["demo-illustrious.safetensors", 6.9, 3]], renders: [["sdxl.text-to-picture", 1, 1, 0]], idleMin: 5, pullMin: 1.5, packs: [["ComfyUI-KJNodes", 1]] },
  { hoursAgo: 26, gpu: "NVIDIA RTX 2000 Ada Generation", rate: 0.24, bootMin: 3, files: [], renders: [["sdxl.text-to-picture", 1, 1, 1]], idleMin: 5, pullMin: 0.5, packs: [["ComfyUI-KJNodes", 1]] },
  { hoursAgo: 27, gpu: "NVIDIA A40", rate: 0.59, bootMin: 9, files: [], renders: [], idleMin: 0, pullMin: 6, failed: "installing the Python packages of was-node-suite (exit 1)" },
  { hoursAgo: 28, gpu: "NVIDIA A40", rate: 0.59, bootMin: 16, files: [["wan22-i2v-fine-tune.safetensors", 26, 6]], renders: [["wan.video", 3, 15, 0]], idleMin: 4, pullMin: 7, packs: [["ComfyUI-KJNodes", 4], ["was-node-suite", 2.5]] },
  { hoursAgo: 31, gpu: "NVIDIA A40", rate: 0.59, bootMin: 4, files: [["wan22-i2v-fine-tune.safetensors", 26, 7]], renders: [], idleMin: 10 },
  { hoursAgo: 52, gpu: "NVIDIA RTX PRO 4000 Blackwell", rate: 0.57, bootMin: 3, files: [["klein-4b-distilled.safetensors", 7.7, 2]], renders: [["klein.edit", 1, 4, 1]], idleMin: 10 },
  { hoursAgo: 150, gpu: "NVIDIA A40", rate: 0.59, bootMin: 5, files: [["h3-fl2va-int8.safetensors", 18, 5]], renders: [["h3.video", 4, 6, 0]], idleMin: 10 },
];

export async function seedCosts(db: Db, now = Date.now()): Promise<void> {
  const have = await db.selectFrom("rent_sessions").select((eb) => eb.fn.countAll<number>().as("n")).executeTakeFirst();
  if (Number(have?.n ?? 0)) return;
  let n = 0;
  for (const [i, p] of PLANS.entries()) {
    const machine = `rp-demo-${i}`;
    const from = now - p.hoursAgo * 3_600_000;
    let t = from + p.bootMin * MIN;
    const up = t;
    for (const [name, gb, min] of p.files) {
      await db.insertInto("pod_fetches").values({ id: `demo-f${n++}`, machine_id: machine, file: name, folder: "checkpoints", via: "hf", bytes: Math.round(gb * 1e9), started_at: new Date(t).toISOString(), ended_at: new Date(t + min * MIN).toISOString() }).execute();
      t += min * MIN;
    }
    const rows: Array<Tables["render_stats"]> = [];
    // the model the session fetched, else the recipe's own name: what the render loaded
    const file = p.files[0]?.[0].replace(/\.safetensors$/, "");
    for (const [recipe, min, count, failed] of p.renders) {
      // a size and a length, and the step and work they give, as demo-times.ts writes them: the pace of each GPU (Deploy's
      // and the hunt's $ / render) is read from the step for the work, and a render without them is never compared
      const video = recipe.endsWith("video");
      const [width, height, seconds] = video ? [1024, 576, 5] : [1024, 1024, 0];
      for (let k = 0; k < count; k++) {
        const bad = k >= count - failed;
        const ms = Math.round(min * MIN * (bad ? 0.4 : 0.9 + ((k * 7) % 5) / 20));
        t += ms;
        rows.push({
          id: `demo-pod-${n++}`, owner_id: "local", recipe_id: recipe, family: recipe.split(".")[0]!, model: file ?? recipe, model_file: file ?? recipe,
          time_key: `size=${width}x${height}${seconds ? `;seconds=${seconds}` : ""}`, kind: bad ? null : video ? "video" : "image",
          width, height, duration_ms: seconds ? seconds * 1000 : null, steps: 8, status: bad ? "failed" : "done", whole: 1, cold: k === 0 ? 1 : 0, waited_ms: 0, total_ms: ms, load_ms: 0, sample_ms: ms, refine_ms: 0, finish_ms: 0,
          step_ms: bad ? null : Math.round(ms / 8), expected_ms: null, vram_peak: null, heat_peak: null, asset_id: null, machine_id: machine, gpu: p.gpu, node_ms: null, energy_wh: null, power_avg_w: null, ram_peak: null, ram_total: null,
          work: bad ? null : width * height * (seconds ? seconds * 24 : 1), created_at: new Date(t).toISOString(),
        });
        t += 20_000;
      }
    }
    if (rows.length) await db.insertInto("render_stats").values(rows).execute();
    const end = t + p.idleMin * MIN;
    const at = (ms: number) => new Date(ms).toISOString();
    // its node packs right after its container came up, each pack's install one after the other
    const packsFrom = from + (p.pullMin ?? 0) * MIN + 20_000;
    const packsTo = packsFrom + (p.packs ?? []).reduce((n, [, min]) => n + min * MIN, 0) + 5_000;
    const boot = p.pullMin === undefined ? {} : { pulled_at: at(from + p.pullMin * MIN), ...(p.packs ? { packs_from: at(packsFrom), packs_to: at(packsTo), boot_packs: JSON.stringify(p.packs.map(([pack, min]) => ({ pack, ms: min * MIN }))) } : {}), start_failed: p.failed ?? null };
    await db.insertInto("rent_sessions").values({ id: `demo-s${i}`, machine_id: machine, pod: `demo${i}`, rate: p.rate, started_at: at(from), ended_at: at(end), seen_at: at(end), gpu: p.gpu, up_at: p.failed ? null : at(up), idle_minutes: 10, ...boot }).execute();
  }
}
