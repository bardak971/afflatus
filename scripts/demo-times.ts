import type { Db, Tables } from "../apps/server/src/db";

/**
 * Pretend renders for the demo's "Render times" tab: a few months of them, from a fixed seed, written
 * once when the demo's database is empty of them. Only the demo: the real app records real renders.
 */

interface Kind {
  recipe: string;
  family: string;
  files: string[];
  key: string;
  kind: "image" | "video";
  sizes: Array<[number, number]>;
  seconds: number[];
  steps: number;
  stepMs: number;
  loadMs: number;
  refineMs: number;
  finishMs: number;
  weight: number;
  vram: number;
}

const KINDS: Kind[] = [
  { recipe: "sdxl.text-to-picture", family: "sdxl", files: ["demo-illustrious", "noob-vpred-1.0"], key: "steps=28;cfg=5", kind: "image", sizes: [[832, 1216], [1024, 1024], [1216, 832]], seconds: [], steps: 28, stepMs: 420, loadMs: 7_000, refineMs: 0, finishMs: 2_500, weight: 30, vram: 62 },
  { recipe: "sdxl.sharper", family: "sdxl", files: ["demo-illustrious"], key: "factor=2", kind: "image", sizes: [[1664, 2432]], seconds: [], steps: 12, stepMs: 1_900, loadMs: 7_000, refineMs: 0, finishMs: 6_000, weight: 8, vram: 81 },
  { recipe: "krea2.text-to-picture", family: "krea2", files: ["krea2-q8"], key: "steps=8", kind: "image", sizes: [[896, 1152], [1024, 1024]], seconds: [], steps: 8, stepMs: 2_600, loadMs: 21_000, refineMs: 12_000, finishMs: 3_000, weight: 16, vram: 90 },
  { recipe: "klein.edit", family: "klein", files: ["klein-4b-distilled"], key: "steps=4", kind: "image", sizes: [[1024, 1024], [768, 1344]], seconds: [], steps: 4, stepMs: 1_300, loadMs: 12_000, refineMs: 0, finishMs: 2_000, weight: 12, vram: 71 },
  { recipe: "h3.video", family: "h3", files: ["h3-fl2va-int8", "h3-hybrid-turbo-v3"], key: "seconds=5;fast=true", kind: "video", sizes: [[576, 1024], [768, 768]], seconds: [5, 5, 7, 10], steps: 8, stepMs: 9_400, loadMs: 38_000, refineMs: 0, finishMs: 24_000, weight: 22, vram: 96 },
  // the other H3 forms, so that each shows what it will take before its source is picked (card #170)
  { recipe: "h3.lipsync", family: "h3", files: ["h3-fl2va-int8"], key: "fast=true", kind: "video", sizes: [[576, 1024]], seconds: [6, 8, 12], steps: 8, stepMs: 9_600, loadMs: 38_000, refineMs: 0, finishMs: 24_000, weight: 6, vram: 96 },
  { recipe: "h3.swap", family: "h3", files: ["h3-ref2va-int8"], key: "fast=true", kind: "video", sizes: [[576, 1024]], seconds: [5.2], steps: 4, stepMs: 15_000, loadMs: 40_000, refineMs: 0, finishMs: 22_000, weight: 5, vram: 97 },
  { recipe: "h3.motion", family: "h3", files: ["h3-fl2va-int8"], key: "fast=true", kind: "video", sizes: [[576, 1024]], seconds: [5.2], steps: 8, stepMs: 11_000, loadMs: 42_000, refineMs: 0, finishMs: 24_000, weight: 4, vram: 97 },
  { recipe: "wan.video", family: "wan", files: ["wan22-i2v-fine-tune"], key: "seconds=5;fast=true", kind: "video", sizes: [[480, 832], [832, 480]], seconds: [5, 5, 3], steps: 4, stepMs: 19_500, loadMs: 41_000, refineMs: 0, finishMs: 21_000, weight: 9, vram: 94 },
  { recipe: "ltx.video", family: "ltx", files: ["ltx23-fine-tune"], key: "seconds=5;twoPass=true", kind: "video", sizes: [[704, 1216]], seconds: [5, 5, 8], steps: 11, stepMs: 1_800, loadMs: 24_000, refineMs: 19_000, finishMs: 23_000, weight: 7, vram: 92 },
];

function seeded(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function seedRenderTimes(db: Db, count = 900, now = Date.now()): Promise<void> {
  const have = await db.selectFrom("render_stats").select((eb) => eb.fn.countAll<number>().as("n")).executeTakeFirst();
  const days = await db.selectFrom("render_days").select((eb) => eb.fn.countAll<number>().as("n")).executeTakeFirst();
  if (Number(have?.n ?? 0) || Number(days?.n ?? 0)) return;
  const rnd = seeded(20261002);
  const pick = <T,>(list: T[]) => list[Math.floor(rnd() * list.length)]!;
  const total = KINDS.reduce((n, k) => n + k.weight, 0);
  let t = now - 4 * 60_000;
  let last: Kind | null = null;
  let session = 0;
  const rows: Array<Tables["render_stats"]> = [];
  for (let n = 0; n < count; n++) {
    if (session <= 0) {
      session = 4 + Math.floor(rnd() * 22);
      t -= (3 + rnd() * 30) * 3_600_000;
      last = null;
    }
    session--;
    let roll = rnd() * total;
    const k: Kind = last && rnd() < 0.72 ? last : KINDS.find((x) => (roll -= x.weight) < 0)!;
    const file: string = pick(k.files);
    const [width, height]: [number, number] = pick(k.sizes);
    const seconds: number | null = k.kind === "video" ? pick(k.seconds) : null;
    const work = ((width * height) / (k.sizes[0]![0] * k.sizes[0]![1])) * (seconds ? seconds / 5 : 1);
    const jitter = 0.9 + rnd() * 0.25;
    const stepMs = k.stepMs * work * jitter;
    const cold = last !== k || rnd() < 0.06;
    const status: "done" | "failed" | "cancelled" = rnd() < 0.035 ? "failed" : rnd() < 0.05 ? "cancelled" : "done";
    const cut = status === "done" ? 1 : 0.15 + rnd() * 0.6;
    const load = Math.round((cold ? k.loadMs * (0.85 + rnd() * 0.4) : 800 + rnd() * 1500));
    const sample = Math.round(stepMs * k.steps * cut);
    const refine = status === "done" ? Math.round(k.refineMs * work * jitter) : 0;
    const finish = status === "done" ? Math.round(k.finishMs * (seconds ? seconds / 5 : 1) * (0.9 + rnd() * 0.3)) : 0;
    const totalMs = load + sample + refine + finish;
    const warm = 1500 + k.stepMs * work * k.steps + k.refineMs * work + k.finishMs * (seconds ? seconds / 5 : 1);
    rows.push({
      id: `demo-${n}`, owner_id: "local", recipe_id: k.recipe, family: k.family, model: file, model_file: file, time_key: `${k.key};size=${width}x${height}${seconds ? `;seconds=${seconds}` : ""}`,
      kind: status === "done" ? k.kind : null, width: status === "done" ? width : null, height: status === "done" ? height : null, duration_ms: status === "done" && seconds ? seconds * 1000 : null,
      steps: k.steps, status, whole: 1, cold: cold ? 1 : 0, waited_ms: Math.round(rnd() < 0.55 ? 0 : rnd() * rnd() * 420_000),
      total_ms: totalMs, load_ms: load, sample_ms: sample, refine_ms: refine, finish_ms: finish, step_ms: stepMs,
      expected_ms: n < count - 40 ? Math.round(warm * (0.93 + rnd() * 0.14) + (cold ? k.loadMs : 0)) : null,
      vram_peak: Math.min(99, k.vram * (0.95 + rnd() * 0.08)), heat_peak: Math.round(58 + k.vram * 0.16 + rnd() * 6), asset_id: null, machine_id: "m1", gpu: null, node_ms: null,
      // the GPU's power as the node pack would have read it: about its memory's share of a 320 W card, for the Costs tab's "This PC"
      energy_wh: Math.round(totalMs * (120 + k.vram * 2) / 3_600_000 * 1000) / 1000, power_avg_w: 120 + k.vram * 2, ram_peak: null, ram_total: null, work: status === "done" ? Math.round(width * height * (seconds ? seconds * 24 : 1)) : null, created_at: new Date(t).toISOString(),
    });
    last = k;
    t -= totalMs + rnd() * 240_000;
  }
  for (let i = 0; i < rows.length; i += 100) await db.insertInto("render_stats").values(rows.slice(i, i + 100)).execute();
}
