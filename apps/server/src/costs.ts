import { modelStem, plural, rankGpus, shortGpu, volumePerMonth, type RankOffer } from "@afflatus/core";
import type { Selectable } from "kysely";
import type { Db, Tables } from "./db";
import { dollars } from "./notifyWords";
import { buildOf } from "./podImage";
import { median } from "./renderDigests";
import { nameOf, windowOf } from "./rendersRead";
import type { Registry } from "./registry";
import type { Spending } from "./rentedBilling";
import type { Settings } from "./settings";

/**
 * The Queue's Costs tab: what the rented GPUs cost and where it went, what a render costs where it runs, and what this PC's
 * electricity comes to. Worked out from what Afflatus keeps: the pods' sessions (rent_sessions), when each one's ComfyUI
 * first answered, the files each got (pod_fetches; pod_measures for the sessions before them), the renders (render_stats,
 * with the energy a render of this PC's drew) and RunPod's bill where it has arrived (rented.ts spending).
 *
 * A session's time is cut into what the pod did, which always adds up to its length (and its cost to its length × its rate):
 * a render under way is Rendering (Failed renders when it did not finish), a file coming is Fetching files, before its
 * ComfyUI first answered is Booting, work queued in its ComfyUI from outside Afflatus (its own page, another tool: pod_outside)
 * is Outside Afflatus, and the rest is Idle. A session before those were kept has its boot's end and its files worked out from
 * what there is, and says so ("estimated"); one before 0077 has no outside work, all of that time idle as it was.
 *
 * Booting is cut further where its parts were kept (0076): pulling the image until its container came up, installing its node
 * packs' Python packages as its boot log says, starting ComfyUI for the rest; a start that failed is a failed start from its
 * container's start to its end. What is not known of a boot (a session before, a pod with no boot log) stays plain booting.
 */

export type Part = "render" | "boot" | "fetch" | "packs" | "outside" | "idle" | "failed";
/** The chart's series for what RunPod billed beyond Afflatus's count of the pods' time. */
export const NOT_SPLIT = "Not split";
export const PARTS: readonly Part[] = ["render", "boot", "fetch", "packs", "outside", "idle", "failed"];
export type PartMs = Record<Part, number>;
const noParts = (): PartMs => ({ render: 0, boot: 0, fetch: 0, packs: 0, outside: 0, idle: 0, failed: 0 });
/** Booting's parts: pulling the image, the node packs, starting ComfyUI, a start that failed, and a boot not known in parts. */
export type BootPart = "pull" | "packs" | "comfy" | "startFailed" | "boot";
export const BOOT_PARTS: readonly BootPart[] = ["pull", "packs", "comfy", "startFailed", "boot"];
export type BootMs = Record<BootPart, number>;
const noBoot = (): BootMs => ({ pull: 0, packs: 0, comfy: 0, startFailed: 0, boot: 0 });

const HOUR = 3_600_000;
const DAY = 86_400_000;
const GB = 1e9;
const usdOf = (ms: number, rate: number) => (ms / HOUR) * rate;

export interface Span {
  from: number;
  to: number;
  part: Part;
  /** Of a boot span, which part of the boot. */
  boot?: BootPart;
}

/** What was kept of a session's boot (0076): null where nothing said it. */
export interface BootFacts {
  /** When its container came up: its image pulled. */
  pulledAt: number | null;
  /** Its node packs' step, from its start to the step after. */
  packs: { from: number; to: number } | null;
  /** Its start failed (its boot log said a step, its GPU did not work, its ComfyUI never answered). */
  failed: boolean;
}

/** What is known of one session, as `splitSession` reads it. */
export interface SessionFacts {
  from: number;
  to: number;
  /** When its ComfyUI first answered: kept on the session (0071), or the boot measure taken then (pod_measures); null when neither. */
  upAt: number | null;
  /** Its renders, from when each started on the GPU to its end; `ok` false for a failed or cancelled one. */
  renders: Array<{ from: number; to: number; ok: boolean }>;
  /** Its files, from when their bytes started to when they were whole. */
  fetches: Array<{ from: number; to: number }>;
  /** Its files are from pod_measures (only those over 100 MB, worked out from their speed), not kept one by one. */
  fetchesGuessed: boolean;
  /** The usual boot of the pods here (ms), for a session with nothing else to tell its boot's end by. */
  usualBootMs: number | null;
  /**
   * Its ComfyUI never answered: a session Afflatus followed to its end (it ended it: end_why, 0079) ended without a first
   * answer and without any work (a pod stuck pulling its image, terminated before it came up). All of it was its boot, not
   * the usual boot and then idle. One ended otherwise may have answered while Afflatus was away: the usual boot then.
   */
  neverUp?: boolean;
  /** Its boot's parts, where kept. */
  boot?: BootFacts;
  /** When its ComfyUI ran work from outside Afflatus (pod_outside, 0077); none before. */
  outside?: Array<{ from: number; to: number }>;
  /** When it installed node packs for its jobs after its boot, up to its ComfyUI's restart (pod_packs, 0089); none before. */
  packs?: Array<{ from: number; to: number }>;
}

/**
 * Which part of its boot a moment of it was: before its container came up, pulling the image; of a start that failed, the
 * failed start after that; within its node packs' step, the packs; else starting ComfyUI once its container is known up (or
 * its packs over). Plain booting where none of that was kept.
 */
function bootPartAt(b: BootFacts | undefined, t: number): BootPart {
  if (!b) return "boot";
  if (b.pulledAt !== null && t < b.pulledAt) return "pull";
  if (b.failed) return "startFailed";
  if (b.packs && b.packs.from <= t && t < b.packs.to) return "packs";
  if (b.pulledAt !== null || (b.packs && t >= b.packs.to)) return "comfy";
  return "boot";
}

/**
 * A session's time cut into what its pod did, in order, adding up to its length: Rendering or Failed renders under a render,
 * else Fetching files under a file, else Booting before its ComfyUI first answered, else Outside Afflatus under work from
 * outside it, else Idle. Outside work only ever takes idle time: where it overlaps a render, a file or the boot, those keep
 * their time, so that nothing is counted twice. `estimated` says what was worked out rather than kept.
 */
export function splitSession(f: SessionFacts): { spans: Span[]; estimated: string[] } {
  const estimated: string[] = [];
  if (!(f.to > f.from)) return { spans: [], estimated };
  const firstWork = Math.min(...f.renders.map((r) => r.from), ...f.fetches.map((x) => x.from));
  let bootEnd: number;
  if (f.upAt !== null) bootEnd = f.upAt;
  // a start that failed never answered: all of it was its boot, nothing estimated
  else if (f.boot?.failed) bootEnd = f.to;
  else if (Number.isFinite(firstWork)) {
    // its ComfyUI answered by its first render or file at the latest
    bootEnd = firstWork;
    estimated.push("its boot, up to its first work");
  } else if (f.neverUp) {
    bootEnd = f.to;
  } else if (f.usualBootMs !== null) {
    bootEnd = f.from + f.usualBootMs;
    estimated.push("its boot, from the usual boot here");
  } else {
    bootEnd = f.to;
    estimated.push("its boot: its ComfyUI never said it was up");
  }
  if (f.fetchesGuessed && f.fetches.length) estimated.push("its files, from their speeds (files over 100 MB only)");
  bootEnd = Math.max(f.from, Math.min(f.to, bootEnd));
  const clip = (t: number) => Math.max(f.from, Math.min(f.to, t));
  const marks = new Set<number>([f.from, f.to, bootEnd]);
  // where a boot's parts change, within its boot
  for (const t of [f.boot?.pulledAt, f.boot?.packs?.from, f.boot?.packs?.to]) if (t !== undefined && t !== null && t < bootEnd) marks.add(clip(t));
  const outside = f.outside ?? [];
  const packs = f.packs ?? [];
  for (const r of [...f.renders, ...f.fetches, ...packs, ...outside]) {
    marks.add(clip(r.from));
    marks.add(clip(r.to));
  }
  const at = [...marks].sort((a, b) => a - b);
  const spans: Span[] = [];
  for (let i = 0; i + 1 < at.length; i++) {
    const [a, b] = [at[i]!, at[i + 1]!];
    if (b <= a) continue;
    const mid = (a + b) / 2;
    const render = f.renders.find((r) => r.from <= mid && mid < r.to);
    const within = (spans: ReadonlyArray<{ from: number; to: number }>) => spans.some((x) => x.from <= mid && mid < x.to);
    // node packs installed for its jobs held every job off the pod: not idle, though nothing rendered
    const part: Part = render ? (render.ok ? "render" : "failed") : within(f.fetches) ? "fetch" : mid < bootEnd ? "boot" : within(packs) ? "packs" : within(outside) ? "outside" : "idle";
    // a boot span says its part, but for a plain one (as before 0076)
    const sub = part === "boot" ? bootPartAt(f.boot, mid) : "boot";
    const boot = sub === "boot" ? undefined : sub;
    const last = spans.at(-1);
    if (last && last.part === part && last.boot === boot && last.to === a) last.to = b;
    else spans.push(boot ? { from: a, to: b, part, boot } : { from: a, to: b, part });
  }
  return { spans, estimated };
}

/** The spans within a window, cut at its ends. */
export const clipSpans = (spans: readonly Span[], from: number, to: number): Span[] =>
  spans.flatMap((s) => {
    const a = Math.max(from, s.from);
    const b = Math.min(to, s.to);
    return b > a ? [{ ...s, from: a, to: b }] : [];
  });

export function partsOf(spans: readonly Span[]): PartMs {
  const out = noParts();
  for (const s of spans) out[s.part] += s.to - s.from;
  return out;
}

/** Its boot's time by part (ms): adds up to its Booting. */
export function bootPartsOf(spans: readonly Span[]): BootMs {
  const out = noBoot();
  for (const s of spans) if (s.part === "boot") out[s.boot ?? "boot"] += s.to - s.from;
  return out;
}

/** What ended a session idle: its last stretch, when it is Idle (ms); 0 when it ended rendering, or is still running. */
export const idleTail = (spans: readonly Span[], open: boolean): number => {
  const last = spans.at(-1);
  return !open && last?.part === "idle" ? last.to - last.from : 0;
};

/**
 * What a shorter idle would have saved over these sessions: each one that ended idle would have stopped `shorter` minutes
 * after its last work, rather than when it did. The stretches idle between renders are left alone (a stop there would have
 * cost a boot again).
 */
export function idleSaving(sessions: ReadonlyArray<{ tailMs: number; rate: number }>, shorter: number): number {
  return sessions.reduce((n, s) => n + usdOf(Math.max(0, s.tailMs - shorter * 60_000), s.rate), 0);
}

/** The idle a shorter one is weighed at: half the one set (5 min for 10), never under 2; for "never", 10. */
export const shorterIdle = (minutes: number): number => (minutes <= 0 ? 10 : Math.max(2, Math.round(minutes / 2)));

/** A file fetched onto a pod, by session: what a network volume would have kept. */
export interface Fetched {
  session: string;
  /** Its name, or for a file measured before names were kept, its size ("6.9 GB file"): the same bytes, the same file. */
  key: string;
  name: string;
  bytes: number;
  ms: number;
  rate: number;
}

export interface FetchAdvice {
  /** The files that came on more than one deploy: their bytes, how many deploys, and what fetching them once costs. */
  bytes: number;
  times: number;
  onceUsd: number;
  /** The volume that would keep them (GB, rounded up to 10) and its price a month. */
  volumeGb: number;
  perMonth: number;
  /** How many deploys a month it takes for the volume to pay for itself. */
  deploys: number;
  biggest: { name: string; bytes: number; times: number };
}

/** The files fetched on several deploys and the volume that would have kept them; null when no file came twice. */
export function fetchAdvice(fetched: readonly Fetched[]): FetchAdvice | null {
  const byKey = new Map<string, Fetched[]>();
  for (const f of fetched) {
    const had = byKey.get(f.key);
    if (had) had.push(f);
    else byKey.set(f.key, [f]);
  }
  const again = [...byKey.values()].filter((list) => new Set(list.map((f) => f.session)).size >= 2);
  if (!again.length) return null;
  const bytes = again.reduce((n, list) => n + list[0]!.bytes, 0);
  // fetching them once: each file's usual time at the rate it came at
  const onceUsd = again.reduce((n, list) => n + list.reduce((m, f) => m + usdOf(f.ms, f.rate), 0) / list.length, 0);
  const volumeGb = Math.max(10, Math.ceil((bytes * 1.1) / GB / 10) * 10);
  const perMonth = volumePerMonth(volumeGb);
  const biggest = again.sort((a, b) => b[0]!.bytes - a[0]!.bytes)[0]!;
  return {
    bytes, times: Math.max(...again.map((list) => new Set(list.map((f) => f.session)).size)), onceUsd, volumeGb, perMonth,
    deploys: onceUsd > 0 ? Math.ceil(perMonth / onceUsd) : Infinity,
    biggest: { name: biggest[0]!.name, bytes: biggest[0]!.bytes, times: new Set(biggest.map((f) => f.session)).size },
  };
}

// ---------------------------------------------------------------- what the tab is sent

export type ItemRef = { kind: "timeline" | "draft"; id: string; name: string };

export interface RenderCostRow {
  /** The model: its recipe's name, and its file. */
  key: string;
  model: string;
  file: string;
  /** Where it ran: a pod's GPU, a GPU not tried yet (a guess), or one of this PC's machines. */
  where: "pod" | "guess" | "home";
  on: string;
  /** Its p50 (ms) and from how many renders; 0 for a guess. */
  ms: number | null;
  renders: number;
  /** A pod's or a guess's: USD a render (p50 × its rate). */
  usd: number | null;
  /** This PC's: its electricity a render (p50 energy × the price), in the user's money; null without a price or a reading. */
  local: number | null;
  /** This PC's: the p50 energy a render (Wh); null when it was never read. */
  wh: number | null;
  /** The cheapest of the GPUs this model rendered on. */
  best: boolean;
}

export interface CostAdvice {
  kind: Part | BootPart | "gpu";
  title: string;
  why: string;
  /** What it would have saved over the window, USD; null when it says no figure. */
  save: number | null;
}

/** The line a pod's ComfyUI death was kept with on its run (rentedFollow.crashed: JSON { said, report }); null when none. */
function crashSaid(kept: string | null | undefined): string | null {
  if (!kept) return null;
  try {
    const said = (JSON.parse(kept) as { said?: unknown }).said;
    return typeof said === "string" && said ? said : "ComfyUI died";
  } catch {
    return "ComfyUI died";
  }
}

export interface SessionView {
  id: string;
  machine: string;
  gpu: string | null;
  /** The CUDA build of the image it ran (podImage.buildOf), its host driver's CUDA and its data center, as kept (0080); null before. */
  cuda: "13.0" | "12.8" | null;
  hostCuda: string | null;
  dataCenter: string | null;
  /** Its image's pull as RunPod's log told it (podPull.ts): pulled or found on the host, bytes, MB/s; null when not read. */
  pull: { fresh: boolean | null; bytes: number; mbps: number | null } | null;
  /** Its boot log is kept (Settings › Rented GPUs › boot logs): GET /api/rented/sessions/:id/boot-log gives it. */
  bootLog: boolean;
  rate: number;
  from: number;
  to: number;
  open: boolean;
  usd: number;
  /** Its time by part (ms), in its own order and adding up to its length. */
  parts: PartMs;
  /** Its Booting by part (ms), adding up to it; and what its boot log said: the step its start failed at, its packs' installs. */
  boot: BootMs;
  startFailed: string | null;
  /** Its ComfyUI died on it: why, as the pod said it (rent_sessions.crash), e.g. out of system memory with its peak. */
  crash: string | null;
  packs: Array<{ pack: string; ms: number }>;
  estimated: string[];
  why: string;
  idleMinutes: number;
  fetched: { files: number; bytes: number };
  renders: Array<{ id: string; at: number; ms: number; status: string; model: string; usd: number; item: ItemRef | null }>;
}

export interface ProjectCost {
  /** null: the Inbox. */
  id: string | null;
  name: string;
  usd: number;
  renders: number;
  timelines: number;
  drafts: number;
  items: Array<ItemRef & { usd: number; renders: number; models: string[] }>;
}

export interface HomeView {
  machine: string;
  name: string;
  gpu: string | null;
  renders: number;
  /** Of them, those whose power was read. */
  read: number;
  wh: number;
  avgW: number | null;
  /** wh × the price, in the user's money; null without a price. */
  cost: number | null;
}

export interface CostsView {
  from: number;
  to: number;
  step: number;
  times: number[];
  /** The totals are RunPod's bill (with Afflatus's count for the hours not billed yet), read then; false: Afflatus's count alone. */
  billed: boolean;
  billReadAt: number | null;
  runpod: boolean;
  /** This month's whole bill (the pods, stopped pods' disks, the network volumes): what the month cap is weighed against. */
  month: number;
  /** Today's compute (the pods while they run): what the day cap is weighed against. */
  today: { usd: number; sessions: number; ms: number };
  caps: { day: number; month: number };
  /**
   * USD a day at this pace: the pods over the last 7 days (Afflatus's count) and storage as the account stands (volumes,
   * stopped pods' disks); the month's end at that pace (its volumes' bill so far in it).
   */
  pace7: number;
  storageDay: number;
  monthEnd: number;
  /** Of this month's total, what RunPod billed the pods beyond Afflatus's count of their time (pods not in Afflatus, disks, rounding); below 0 when it billed less than counted. */
  notSplit: number;
  balance: number | null;
  /** How long the balance lasts at `pace7` + `storageDay` (rented.ts spending: the one Settings says too). */
  runwayDays: number | null;
  /** What the account spends an hour now as RunPod says it, and how long the balance lasts at that (ms): while a pod runs, the nearer end. */
  spendPerHr: number | null;
  runwayNowMs: number | null;
  storage: { perMonth: number; volumes: number; stoppedDisks: number } | null;
  /** The window's pod time by part: ms and USD; and its Booting by part, adding up to it. */
  where: { ms: PartMs; usd: Record<Part, number>; boot: { ms: BootMs; usd: BootMs }; estimated: boolean };
  /**
   * USD per stretch of `times`, by GPU (Afflatus's count), and NOT_SPLIT: what RunPod billed in a stretch beyond that
   * count, so that a stretch billed in full stands at its bill (what the day cap is weighed against).
   */
  spend: { gpus: string[]; values: number[][] };
  projects: ProjectCost[];
  sessions: SessionView[];
  renderCosts: RenderCostRow[];
  advice: CostAdvice[];
  home: HomeView[];
  kwh: { price: number | null; currency: string };
}

/** A GPU's name as a row says it: "NVIDIA GeForce RTX 4090" → "RTX 4090". */
export const gpuShort = (name: string | null): string => (name ? shortGpu(name) : "GPU");

export interface CostsDeps {
  db: Db;
  registry: Registry;
  settings: Settings;
  /** RunPod's bill, balance and storage as rented.ts reads them; null with no key and no pod. */
  spending: Spending | null;
  billReadAt: number | null;
  /** What the rented GPUs cost between two moments as Afflatus counts it (rented.ts costBetween). */
  costBetween(from: number, to: number): Promise<number>;
  /** RunPod's bill over each stretch of the chart (rented.ts billedIn); null where it is not read. */
  billedIn?(times: readonly number[], step: number): Promise<Array<number | null>>;
  /** RunPod's GPUs and their prices, for the guesses on GPUs not tried; null when not read. */
  offers(): Promise<RankOffer[] | null>;
}

/** Everything the tab shows for a window (ms; none: all of it). */
export async function costs(d: CostsDeps, asked: { from?: number; to?: number }, now = Date.now()): Promise<CostsView> {
  const db = d.db;
  const first = await db.selectFrom("rent_sessions").select((eb) => eb.fn.min("started_at").as("at")).executeTakeFirst();
  const firstRender = await db.selectFrom("render_stats").select((eb) => eb.fn.min("created_at").as("at")).executeTakeFirst();
  const since = [first?.at, firstRender?.at].filter((x): x is string => Boolean(x)).sort()[0] ?? null;
  const win = asked.from !== undefined && asked.to !== undefined && asked.to > asked.from ? { from: asked.from, to: asked.to } : "all";
  const { start, end, step, times } = windowOf(win, since, now);
  // "all" is the whole record: its totals (and the Grafana gauges read from them) from its first moment, while the chart
  // shows at most its last 730 stretches (windowOf). Taken from the chart's start, a record past two years lost its oldest
  // day from the totals each day, and the gauges' daily rise went below zero on a quiet day.
  const [wFrom, wTo] = [win === "all" ? Math.min(start, since ? Date.parse(since) : start) : Math.max(start, asked.from!), Math.min(end, now)];

  // ---- the sessions in the window, and what each did
  const iso = (ms: number) => new Date(ms).toISOString();
  const rows = await db.selectFrom("rent_sessions").selectAll().where("started_at", "<", iso(wTo)).where((eb) => eb.or([eb("ended_at", "is", null), eb("ended_at", ">", iso(wFrom))])).orderBy("started_at", "desc").execute();
  const rented = new Set((await db.selectFrom("rent_sessions").select("machine_id").distinct().execute()).map((r) => r.machine_id));
  for (const m of d.settings.machines) if (m.rented) rented.add(m.id);
  const sFrom = Math.min(wFrom, ...rows.map((r) => Date.parse(r.started_at)));
  const sTo = Math.max(wTo, ...rows.map((r) => (r.ended_at ? Date.parse(r.ended_at) : now)));
  const renders = await db
    .selectFrom("render_stats")
    .select(["id", "recipe_id", "model", "model_file", "status", "total_ms", "created_at", "machine_id", "gpu", "energy_wh", "whole", "started_at"])
    .where("created_at", ">=", iso(sFrom))
    .where("created_at", "<=", iso(sTo + DAY))
    .execute();
  const fetches = await db.selectFrom("pod_fetches").selectAll().where("ended_at", ">=", iso(sFrom)).where("started_at", "<=", iso(sTo)).execute();
  const measures = await db.selectFrom("pod_measures").selectAll().where("at", ">=", iso(sFrom)).where("at", "<=", iso(sTo + 60_000)).execute();
  const outside = await outsideOf(db, sFrom, sTo);
  const boots = (await db.selectFrom("pod_measures").select("ms").where("kind", "=", "boot").orderBy("at", "desc").limit(12).execute()).map((r) => Number(r.ms));
  const usualBootMs = median(boots);
  const lastDeployIdle = d.settings.lastDeploy?.idleMinutes ?? 10;
  const machineOf = new Map(d.settings.machines.map((m) => [m.id, m]));
  const homeFirst = d.settings.machines.find((m) => !m.rented)?.id ?? d.settings.machines[0]?.id ?? "m1";

  // a render is a pod's only within a run of its machine (rent_sessions): an id that was a home machine's before it was a
  // pod's (the first machines were m1, m2 whatever they were) keeps its home renders at home
  // each machine's runs read once, by machine, sorted by start with the latest end so far: /metrics works this out every
  // minute over the whole record, and a machine id is kept across its deploys, so comparing each render with every run of
  // its machine was renders × sessions
  const runsOf = new Map<string, Array<{ from: number; to: number }>>();
  if (rented.size) {
    for (const x of await db.selectFrom("rent_sessions").select(["machine_id", "started_at", "ended_at"]).where("machine_id", "in", [...rented]).execute()) {
      const run = { from: Date.parse(x.started_at), to: x.ended_at === null ? Infinity : Date.parse(x.ended_at) };
      if (!Number.isFinite(run.from)) continue;
      const list = runsOf.get(x.machine_id);
      if (list) list.push(run);
      else runsOf.set(x.machine_id, [run]);
    }
  }
  const latestEnds = new Map<string, { runs: Array<{ from: number; to: number }>; ends: number[] }>();
  for (const [machine, runs] of runsOf) {
    runs.sort((a, b) => a.from - b.from);
    let latest = -Infinity;
    latestEnds.set(machine, { runs, ends: runs.map((x) => (latest = Math.max(latest, x.to))) });
  }
  const onPod = (r: { machine_id: string | null; created_at: string; total_ms: number }) => {
    const of = r.machine_id ? latestEnds.get(r.machine_id) : undefined;
    if (!of) return false;
    const end = Date.parse(r.created_at);
    const start = end - r.total_ms;
    // a run started before the render's end that ends after its start: among those started before its end, the latest end
    const n = firstOver(of.runs, (x) => x.from, end, true);
    return n > 0 && of.ends[n - 1]! > start;
  };
  // the jobs of the renders on pods: where each belongs (its timeline or draft, their project)
  const podRenders = renders.filter(onPod);
  const around = aroundOf(podRenders, fetches, measures, usualBootMs, outside);
  const refs = await itemsOf(db, podRenders.map((r) => r.id));

  const sessions: SessionView[] = [];
  const whereMs = noParts();
  const whereUsd: Record<Part, number> = noParts();
  const bootMs = noBoot();
  const bootUsd = noBoot();
  const bootsOf: BootSeen[] = [];
  let estimatedAny = false;
  const tails: Array<{ tailMs: number; rate: number; idle: number }> = [];
  const fetched: Fetched[] = [];
  const bootsSeen: number[] = [];
  const renderRate = new Map<string, number>();
  const gpuOfSession = new Map<string, string>();
  for (const r of rows) {
    const from = Date.parse(r.started_at);
    const to = r.ended_at ? Date.parse(r.ended_at) : now;
    const { mine, kept, guessed, facts } = sessionOf(r, around, now);
    const split = splitOf(r, facts);
    if (split.estimated.length) estimatedAny = true;
    const parts = partsOf(split.spans);
    const boot = bootPartsOf(split.spans);
    const clipped = clipSpans(split.spans, wFrom, wTo);
    const inWindow = partsOf(clipped);
    for (const p of PARTS) {
      whereMs[p] += inWindow[p];
      whereUsd[p] += usdOf(inWindow[p], r.rate);
    }
    const bootInWindow = bootPartsOf(clipped);
    for (const p of BOOT_PARTS) {
      bootMs[p] += bootInWindow[p];
      bootUsd[p] += usdOf(bootInWindow[p], r.rate);
    }
    const packs = packsOf(r.boot_packs);
    if (inWindow.boot) bootsOf.push({ pullMs: r.pulled_at ? boot.pull : null, packs: packs.map((x) => x.pack), packsKnown: r.packs_from !== null });
    if (parts.boot) bootsSeen.push(parts.boot);
    const idle = r.idle_minutes ?? machineOf.get(r.machine_id)?.rented?.idleMinutes ?? lastDeployIdle;
    tails.push({ tailMs: idleTail(split.spans, !r.ended_at), rate: r.rate, idle });
    for (const f of kept) fetched.push({ session: r.id, key: f.file.toLowerCase(), name: modelStem(f.file), bytes: Number(f.bytes), ms: Date.parse(f.ended_at) - Date.parse(f.started_at), rate: r.rate });
    for (const m of guessed) fetched.push({ session: r.id, key: `bytes:${m.bytes}`, name: `a ${(Number(m.bytes) / GB).toFixed(1)} GB file`, bytes: Number(m.bytes), ms: Number(m.ms), rate: r.rate });
    const gpu = gpuShort(r.gpu ?? mine.find((x) => x.row.gpu)?.row.gpu ?? machineOf.get(r.machine_id)?.name ?? null);
    gpuOfSession.set(r.id, gpu);
    for (const x of mine) renderRate.set(x.row.id, r.rate);
    const its = mine.map((x) => ({ id: x.row.id, at: x.to, ms: x.row.total_ms, status: x.row.status, model: nameOf(d.registry, x.row.recipe_id), usd: usdOf(x.row.total_ms, r.rate), item: refs.get(x.row.id)?.item ?? null }));
    sessions.push({
      id: r.id, machine: r.machine_id, gpu, cuda: buildOf(r.image), hostCuda: r.host_cuda ?? null, dataCenter: r.data_center ?? null, pull: pullFigures(r.pull), bootLog: Boolean(r.boot_log), rate: r.rate, from, to, open: !r.ended_at, usd: usdOf(to - from, r.rate), parts, boot, startFailed: r.start_failed, crash: crashSaid(r.crash), packs, estimated: split.estimated, why: whyOf(its, parts.outside), idleMinutes: idle,
      fetched: { files: kept.length + guessed.length, bytes: [...kept.map((f) => Number(f.bytes)), ...guessed.map((m) => Number(m.bytes))].reduce((n, b) => n + b, 0) },
      renders: its.sort((a, b) => a.at - b.at),
    });
  }

  // ---- spend per stretch, by GPU (the three that cost most, the rest together)
  const perGpu = new Map<string, number[]>();
  for (const r of rows) {
    const from = Date.parse(r.started_at);
    const to = r.ended_at ? Date.parse(r.ended_at) : now;
    const g = gpuOfSession.get(r.id) ?? "GPU";
    const values = perGpu.get(g) ?? times.map(() => 0);
    times.forEach((t, i) => {
      const a = Math.max(from, t, wFrom);
      const b = Math.min(to, t + step, wTo);
      if (b > a) values[i]! += usdOf(b - a, r.rate);
    });
    perGpu.set(g, values);
  }
  const ranked = [...perGpu].sort((a, b) => b[1].reduce((n, v) => n + v, 0) - a[1].reduce((n, v) => n + v, 0));
  const spend = ranked.length > 4
    ? { gpus: [...ranked.slice(0, 3).map(([g]) => g), "Other"], values: [...ranked.slice(0, 3).map(([, v]) => v), times.map((_t, i) => ranked.slice(3).reduce((n, [, v]) => n + v[i]!, 0))] }
    : { gpus: ranked.map(([g]) => g), values: ranked.map(([, v]) => v) };
  // what RunPod billed in a stretch beyond the count (pods not in Afflatus, stopped pods' disks, rounding): a stretch
  // billed in full stands at its bill, what the day cap is weighed against. Nothing where the bill is below the count
  // (its last hours not written yet: the count stands for them, as the cap takes the higher)
  const billed = d.spending?.billed && d.billedIn ? await d.billedIn(times, step).catch(() => null) : null;
  const unsplit = times.map((t, i) => {
    const bill = billed?.[i];
    if (bill === null || bill === undefined || t + step <= wFrom || t >= wTo) return 0;
    return Math.max(0, bill - ranked.reduce((n, [, v]) => n + v[i]!, 0));
  });
  if (unsplit.some((v) => v >= 0.005)) {
    spend.gpus.push(NOT_SPLIT);
    spend.values.push(unsplit);
  }

  // ---- by project: the renders on pods in the window, at their session's rate
  const projects = await byProject(db, podRenders.filter((r) => inside(r.created_at, wFrom, wTo)), refs, renderRate, d.registry);

  // ---- a render's cost, model by where it ran
  const inWin = renders.filter((r) => inside(r.created_at, wFrom, wTo));
  const kwh = d.settings.costs;
  const renderCosts = await costRows(inWin, onPod, renderRate, gpuOfSession, sessions, d, homeFirst, kwh.kwhPrice);

  // ---- this PC: the energy its renders drew
  const home: HomeView[] = [];
  for (const [machine, list] of groupBy(inWin.filter((r) => !onPod(r)), (r) => r.machine_id ?? homeFirst)) {
    const readOnes = list.filter((r) => r.energy_wh !== null);
    const wh = readOnes.reduce((n, r) => n + r.energy_wh!, 0);
    const ms = readOnes.reduce((n, r) => n + r.total_ms, 0);
    home.push({
      machine, name: machineOf.get(machine)?.name || (machine === homeFirst ? "This PC" : machine), gpu: gpuShort(list.find((r) => r.gpu)?.gpu ?? null), renders: list.length, read: readOnes.length,
      wh, avgW: ms > 0 ? (wh * HOUR) / ms : null, cost: readOnes.length && kwh.kwhPrice !== null ? (wh / 1000) * kwh.kwhPrice : null,
    });
  }

  // ---- the top figures
  const spending = d.spending;
  const nowDate = new Date(now);
  const todayFrom = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).getTime();
  const monthEndAt = new Date(nowDate.getFullYear(), nowDate.getMonth() + 1, 1).getTime();
  // the pace and the runway as rented.ts says them (Settings too); Afflatus's count alone without RunPod
  const pace7 = spending?.perDay.pods ?? (await d.costBetween(now - 7 * DAY, now)) / 7;
  const storageDay = spending?.perDay.storage ?? 0;
  const todaySessions = (await db.selectFrom("rent_sessions").select(["started_at", "ended_at", "rate"]).where((eb) => eb.or([eb("ended_at", "is", null), eb("ended_at", ">", iso(todayFrom))])).execute());
  const todayMs = todaySessions.reduce((n, r) => n + Math.max(0, (r.ended_at ? Date.parse(r.ended_at) : now) - Math.max(todayFrom, Date.parse(r.started_at))), 0);
  const monthCount = await d.costBetween(new Date(nowDate.getFullYear(), nowDate.getMonth(), 1).getTime(), now);
  // the whole month's bill, the volumes' in it: the figure the month cap is weighed against (rented.ts spent)
  const month = spending?.month ?? monthCount;
  // the month's bill of the pods beyond the count: said under it, so that it and "Where it went" over the month add up
  // (the volumes are not pod time, and are not split)
  const notSplit = spending?.billed ? month - (spending.monthVolumes ?? 0) - monthCount : 0;
  const today = spending?.today ?? (await d.costBetween(todayFrom, now));

  const advice = adviceOf({ where: { ms: whereMs, usd: whereUsd, boot: { ms: bootMs, usd: bootUsd } }, tails, fetched, bootsSeen, boots: bootsOf, rows: renderCosts, sessions: sessions.length });

  return {
    from: wFrom, to: wTo, step, times, billed: spending?.billed ?? false, billReadAt: d.billReadAt, runpod: Boolean(spending), month,
    today: { usd: today, sessions: todaySessions.length, ms: todayMs }, caps: d.settings.rentCaps, pace7, storageDay, notSplit,
    monthEnd: month + (pace7 + storageDay) * ((monthEndAt - now) / DAY),
    balance: spending?.balance ?? null, runwayDays: spending?.runwayDays ?? null, spendPerHr: spending?.spendPerHr ?? null, runwayNowMs: spending?.runwayMs ?? null,
    storage: spending?.storage ? { perMonth: spending.storage.perMonth, volumes: spending.storage.volumes, stoppedDisks: spending.storage.stoppedDisks } : null,
    where: { ms: whereMs, usd: whereUsd, boot: { ms: bootMs, usd: bootUsd }, estimated: estimatedAny }, spend, projects, sessions, renderCosts, advice, home, kwh: { price: kwh.kwhPrice, currency: kwh.currency },
  };
}

type SessionRow = Selectable<Tables["rent_sessions"]>;

/** A session's packs installed as its boot log said them (0076's JSON); none when not kept or not read. */
function packsOf(json: string | null): Array<{ pack: string; ms: number }> {
  try {
    const said = JSON.parse(json ?? "[]") as unknown;
    return Array.isArray(said) ? said.filter((x): x is { pack: string; ms: number } => typeof x?.pack === "string" && typeof x?.ms === "number") : [];
  } catch {
    return [];
  }
}

/** A session's pull as kept (0080's JSON, podPull.ts): pulled or found on its host, its bytes and speed; null when not kept. */
function pullFigures(json: string | null | undefined): SessionView["pull"] {
  try {
    const said = JSON.parse(json ?? "null") as { fresh?: unknown; bytes?: unknown; mbps?: unknown } | null;
    if (!said || typeof said !== "object") return null;
    return { fresh: typeof said.fresh === "boolean" ? said.fresh : null, bytes: typeof said.bytes === "number" ? said.bytes : 0, mbps: typeof said.mbps === "number" ? said.mbps : null };
  } catch {
    return null;
  }
}

/** Its boot's parts as kept on the session (0076); undefined for a session that kept none, its boot plain. */
export function bootFactsOf(r: Pick<SessionRow, "pulled_at" | "packs_from" | "packs_to" | "start_failed">): BootFacts | undefined {
  const at = (iso: string | null) => (iso ? Date.parse(iso) : Number.NaN);
  const pulledAt = at(r.pulled_at);
  const [from, to] = [at(r.packs_from), at(r.packs_to)];
  const packs = Number.isFinite(from) && Number.isFinite(to) && to > from ? { from, to } : null;
  if (!Number.isFinite(pulledAt) && !packs && !r.start_failed) return undefined;
  return { pulledAt: Number.isFinite(pulledAt) ? pulledAt : null, packs, failed: r.start_failed !== null };
}

/** Rows over a stretch of time, sorted by their end, with the longest stretch among them. */
interface Timed<T> {
  list: Array<{ row: T; from: number; to: number }>;
  longest: number;
}

/** The index of the first of `list` (sorted by `key`) whose key is over `t`, or at it too with `orAt`. */
function firstOver<T>(list: readonly T[], key: (x: T) => number, t: number, orAt = false): number {
  let [lo, hi] = [0, list.length];
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const k = key(list[mid]!);
    if (k > t || (orAt && k === t)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Rows with their stretch of time read once, sorted by its end; those whose dates cannot be read are left out, as a filter on them left them out. */
function timed<T>(rows: readonly T[], span: (r: T) => { from: number; to: number }): Timed<T> {
  const list = rows.map((row) => ({ row, ...span(row) })).filter((x) => Number.isFinite(x.from) && Number.isFinite(x.to)).sort((a, b) => a.to - b.to);
  return { list, longest: list.reduce((n, x) => Math.max(n, x.to - x.from), 0) };
}

/** Those that overlap `from`–`to` (ending after `from`, starting before `to`), by binary search on their end. */
function overlapping<T>(t: Timed<T> | undefined, from: number, to: number): Timed<T>["list"] {
  if (!t) return [];
  const out: Timed<T>["list"] = [];
  // past `to` + the longest stretch, each one starts at `to` or later
  for (let i = firstOver(t.list, (x) => x.to, from); i < t.list.length && t.list[i]!.to < to + t.longest; i++) if (t.list[i]!.from < to) out.push(t.list[i]!);
  return out;
}

type RenderOf = { machine_id: string | null; created_at: string; total_ms: number; status: string; started_at?: string | null };
type Measure = Selectable<Tables["pod_measures"]>;

/**
 * What the sessions are split from, read once: the renders and the files by machine and sorted by time, the measures by
 * time, their dates parsed once. costs() splits every session of the whole record (/metrics every minute), a machine id is
 * kept across its deploys, and each session filtering every render and file of its machine was sessions × rows.
 */
function aroundOf<R extends RenderOf>(renders: readonly R[], fetches: ReadonlyArray<Selectable<Tables["pod_fetches"]>>, measures: readonly Measure[], usualBootMs: number | null, outside: OutsideBySession) {
  const byMachine = <T extends { machine_id: string | null }, U>(rows: readonly T[], make: (list: T[]) => U) => {
    const groups = new Map<string | null, T[]>();
    for (const x of rows) {
      const list = groups.get(x.machine_id);
      if (list) list.push(x);
      else groups.set(x.machine_id, [x]);
    }
    return new Map([...groups].map(([m, list]) => [m, make(list)]));
  };
  return {
    // from when its job took the machine (0088) to when its result was filed: Afflatus's uploads before the prompt and its
    // filing after are the render's, not Idle. A row from before has only its length, placed back from its row's moment
    renders: byMachine(renders, (list) => timed(list, (x) => ({ from: x.started_at ? Date.parse(x.started_at) : Date.parse(x.created_at) - x.total_ms, to: Date.parse(x.created_at) }))),
    fetches: byMachine(fetches, (list) => timed(list, (x) => ({ from: Date.parse(x.started_at), to: Date.parse(x.ended_at) }))),
    measures: measures.map((m) => ({ m, at: Date.parse(m.at) })).filter((x) => Number.isFinite(x.at)).sort((a, b) => a.at - b.at),
    usualBootMs,
    outside,
  };
}

/**
 * One session as its pod spent it (`splitSession`'s facts), from what was kept around it: its renders (by its machine, within
 * its time), its files (pod_fetches; the sessions before 0071 have theirs from pod_measures, the bigger ones worked out from
 * their speed) and when its ComfyUI first answered.
 */
function sessionOf<R extends RenderOf>(r: SessionRow, around: ReturnType<typeof aroundOf<R>>, now: number) {
  const from = Date.parse(r.started_at);
  const to = r.ended_at ? Date.parse(r.ended_at) : now;
  const mine = overlapping(around.renders.get(r.machine_id), from, to);
  const keptSpans = overlapping(around.fetches.get(r.machine_id), from, to);
  const kept = keptSpans.map((x) => x.row);
  const old = r.up_at === null && !kept.length;
  // the measures from just after its start to a minute after its end
  const near = (orAtStart: boolean) => around.measures.slice(firstOver(around.measures, (x) => x.at, from, orAtStart), firstOver(around.measures, (x) => x.at, to + 60_000));
  const guessed = old ? near(false).filter((x) => x.m.kind !== "boot").map((x) => x.m) : [];
  // a boot measure keeps no machine: in a session's time it is taken as that session's boot only for sessions from before 0071
  // (no idle minutes kept), which had nothing else. A later one whose first answer was not kept (Afflatus restarted mid-boot)
  // would take another pod's deploy for its own boot
  const boot = r.idle_minutes === null ? near(true).find((x) => x.m.kind === "boot") : undefined;
  const upAt = r.up_at ? Date.parse(r.up_at) : boot ? boot.at : null;
  const facts: SessionFacts = {
    from, to, upAt, usualBootMs: around.usualBootMs,
    // ended by Afflatus, which followed it to its end, and never answered: it never came up
    neverUp: Boolean(r.ended_at && r.end_why) && upAt === null && !mine.length && !kept.length,
    renders: mine.map((x) => ({ from: x.from, to: x.to, ok: x.row.status === "done" })),
    fetches: [...keptSpans.map((x) => ({ from: x.from, to: x.to })), ...guessed.map((m) => ({ from: Date.parse(m.at) - Number(m.ms), to: Date.parse(m.at) }))],
    fetchesGuessed: old,
    boot: bootFactsOf(r),
    outside: (around.outside.get(r.id) ?? []).filter((x) => !x.packs),
    packs: (around.outside.get(r.id) ?? []).filter((x) => x.packs),
  };
  return { mine, kept, guessed, facts };
}

type Split = ReturnType<typeof splitSession>;

/** A session's split as it was kept (freezeSplits, keepSplitsUntil); null when none was, or what was kept cannot be read. */
function keptSplit(r: SessionRow): Split | null {
  if (!r.split) return null;
  try {
    const kept = JSON.parse(r.split) as Split;
    return Array.isArray(kept?.spans) && Array.isArray(kept.estimated) ? kept : null;
  } catch {
    return null;
  }
}

/**
 * A session's split: the one kept when it is whole (not worked out again: costs() reads the whole record); one kept up to a
 * moment (split_until), with the one worked out from the rows there are after it; else that one.
 */
function splitOf(r: SessionRow, facts: SessionFacts): Split {
  const kept = keptSplit(r);
  if (!kept) return splitSession(facts);
  if (!r.split_until) return kept;
  const until = Date.parse(r.split_until);
  return joinSplits(kept, splitSession(afterKept(facts, kept, until)), until);
}

/**
 * A session's facts for its split after `until`, its boot as the kept split ended it. With no first answer kept (Afflatus
 * restarted mid-boot), the renders forgotten or folded at `until` left its boot to end at its first work after them, or,
 * with none and Afflatus ending it, to read all of it as boot (neverUp): its idle after `until` read as boot. Its boot ended
 * where the kept one did, when that was before `until`; one still booting then is left to its own rules.
 */
function afterKept(f: SessionFacts, kept: Split, until: number): SessionFacts {
  if (f.upAt !== null) return f;
  const bootEnd = kept.spans.filter((s) => s.part === "boot").at(-1)?.to ?? f.from;
  return bootEnd < until ? { ...f, upAt: bootEnd, neverUp: false } : f;
}

/**
 * A split kept up to `until`, finished with the one worked out from what is left after it. Before `until`, a render the kept
 * one read as idle takes its time from `live`: one under way at that moment (every render time forgotten mid-render) had
 * no row yet, and its row, written at its end, is not deleted.
 */
export function joinSplits(kept: Split, live: Split, until: number): Split {
  const before = clipSpans(kept.spans, -Infinity, until);
  const late = clipSpans(live.spans, -Infinity, until).filter((x) => x.part === "render" || x.part === "failed");
  const marks = [...new Set([...before, ...late].flatMap((x) => [x.from, x.to]))].sort((a, b) => a - b);
  const spans: Span[] = [];
  const push = (x: Span) => {
    const last = spans.at(-1);
    if (last && last.part === x.part && last.boot === x.boot && last.to === x.from) last.to = x.to;
    else spans.push({ ...x });
  };
  for (let i = 0; i + 1 < marks.length; i++) {
    const [a, b] = [marks[i]!, marks[i + 1]!];
    const mid = (a + b) / 2;
    const was = before.find((x) => x.from <= mid && mid < x.to);
    if (!was) continue;
    const render = was.part === "idle" ? late.find((x) => x.from <= mid && mid < x.to) : undefined;
    push({ ...(render ?? was), from: a, to: b });
  }
  for (const x of clipSpans(live.spans, until, Infinity)) push(x);
  return { spans, estimated: [...new Set([...kept.estimated, ...live.estimated])] };
}

/** How long after its end a session's split is kept: its last render's row, a file's or outside work's end, may come late. */
const FREEZE_AFTER_MS = DAY;

/** The usual boot of the pods here, as costs() reads it. */
const usualBoot = async (db: Db) => median((await db.selectFrom("pod_measures").select("ms").where("kind", "=", "boot").orderBy("at", "desc").limit(12).execute()).map((r) => Number(r.ms)));

/** A session's split as costs() would show it at `now`, from what is kept around it, for this one alone. */
async function splitNow(db: Db, r: SessionRow, now: number, usualBootMs: number | null): Promise<Split> {
  const iso = (ms: number) => new Date(ms).toISOString();
  const [from, to] = [Date.parse(r.started_at), r.ended_at ? Date.parse(r.ended_at) : now];
  const renders = await db.selectFrom("render_stats").select(["machine_id", "created_at", "total_ms", "status", "started_at"]).where("machine_id", "=", r.machine_id).where("created_at", ">=", iso(from)).where("created_at", "<=", iso(to + DAY)).execute();
  const fetches = await db.selectFrom("pod_fetches").selectAll().where("ended_at", ">=", iso(from)).where("started_at", "<=", iso(to)).execute();
  const measures = await db.selectFrom("pod_measures").selectAll().where("at", ">=", iso(from)).where("at", "<=", iso(to + 60_000)).execute();
  return splitOf(r, sessionOf(r, aroundOf(renders, fetches, measures, usualBootMs, await outsideOf(db, from, to)), now).facts);
}

/**
 * Each session that ended before `endedBefore` has its split by part kept on its row, once: the renders it is worked out
 * from are folded into days after the history days (renders.ts fold) or forgotten at once (clear), and a split worked out
 * again from what is left then read the session's renders as idle, moving amounts already spent from one part to another
 * (the Costs tab, the daily Grafana panel, the hunt's overhead). Called before either deletes a row: worked out then, the
 * split kept is the one shown until then. One kept up to a moment while it ran (keepSplitsUntil) is finished now. Returns
 * how many were kept. `only`: of these sessions alone.
 */
export async function freezeSplits(db: Db, endedBefore: number, only?: readonly string[]): Promise<number> {
  let q = toFreeze(db, endedBefore).selectAll();
  if (only) q = q.where("id", "in", only.length ? [...only] : [""]);
  const rows = await q.execute();
  if (!rows.length) return 0;
  const usualBootMs = await usualBoot(db);
  for (const r of rows) {
    const split = await splitNow(db, r, Date.parse(r.ended_at!), usualBootMs);
    await db.updateTable("rent_sessions").set({ split: JSON.stringify(split), split_until: null }).where("id", "=", r.id).where((eb) => eb.or([eb("split", "is", null), eb("split_until", "is not", null)])).execute();
  }
  return rows.length;
}

/**
 * Each session that started before `until` and is not kept whole yet (still running, or ended under FREEZE_AFTER_MS ago)
 * has its split up to `until` kept, before its render rows from before then are deleted: the fold's cutoff passed its start,
 * or every render time is forgotten while its pod runs. Kept only for ended sessions, it was split at its end without
 * those renders, and read them as idle for good. freezeSplits finishes it from what is left after `until`. Returns how many
 * were kept.
 */
export async function keepSplitsUntil(db: Db, until: number, now: number): Promise<number> {
  const iso = (ms: number) => new Date(ms).toISOString();
  const rows = await db.selectFrom("rent_sessions").selectAll().where("started_at", "<", iso(until))
    .where((eb) => eb.or([eb("split", "is", null), eb("split_until", "<", iso(until))])).execute();
  if (!rows.length) return 0;
  const usualBootMs = await usualBoot(db);
  for (const r of rows) {
    const split = await splitNow(db, r, now, usualBootMs);
    await db.updateTable("rent_sessions").set({ split: JSON.stringify(split), split_until: iso(until) }).where("id", "=", r.id).execute();
  }
  return rows.length;
}

/** The sessions freezeSplits keeps the split of: ended before `endedBefore`, and not kept whole yet. */
const toFreeze = (db: Db, endedBefore: number) =>
  db.selectFrom("rent_sessions").where("ended_at", "is not", null).where("ended_at", "<", new Date(endedBefore).toISOString()).where((eb) => eb.or([eb("split", "is", null), eb("split_until", "is not", null)]));

/** The sessions whose split is kept by the hourly fold: those ended at least FREEZE_AFTER_MS before `now`. */
export const freezeOld = (db: Db, now: number) => freezeSplits(db, now - FREEZE_AFTER_MS);

/** How many sessions freezeOldInTurns splits in one transaction. */
const FREEZE_TURN = 100;

/**
 * freezeOld a hundred sessions at a time, each hundred in its own transaction, the server let in between: the first fold
 * after an update to 0.6.0 found every past session to split (1,500 at a heavy user's scale), one block of about 1 s.
 * The fold's own freezeOld, in its transaction, still keeps those ended meanwhile before their rows go. Returns how many
 * were kept.
 */
export async function freezeOldInTurns(db: Db, now: number): Promise<number> {
  let kept = 0;
  for (let after = ""; ;) {
    const ids = (await toFreeze(db, now - FREEZE_AFTER_MS).select("id").where("id", ">", after).orderBy("id").limit(FREEZE_TURN).execute()).map((r) => r.id);
    if (ids.length) kept += await db.transaction().execute((tx) => freezeSplits(tx, now - FREEZE_AFTER_MS, ids));
    if (ids.length < FREEZE_TURN) return kept;
    after = ids.at(-1)!;
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Each session's stretches of work from outside Afflatus (pod_outside), and of its node packs' installs (`packs`, pod_packs), by its id. */
type OutsideBySession = Map<string, Array<{ from: number; to: number; packs?: true }>>;

/**
 * The stretches of work from outside Afflatus seen between two moments, by session (and the node packs' installs beside them): each to its end, or, one still open (its
 * session running, or Afflatus stopped before its end was read), to its last sight, never further than what was seen.
 * `splitSession` clips them to their session.
 */
async function outsideOf(db: Db, from: number, to: number): Promise<OutsideBySession> {
  const iso = (ms: number) => new Date(ms).toISOString();
  const rows = await db.selectFrom("pod_outside").select(["session_id", "started_at", "seen_at", "ended_at"]).where("seen_at", ">=", iso(from)).where("started_at", "<=", iso(to)).execute();
  const packs = await db.selectFrom("pod_packs").select(["session_id", "started_at", "ended_at"]).where("ended_at", ">=", iso(from)).where("started_at", "<=", iso(to)).execute();
  const out: OutsideBySession = new Map();
  const put = (session: string, span: { from: number; to: number; packs?: true }) => {
    if (!(span.to > span.from)) return;
    const had = out.get(session);
    if (had) had.push(span);
    else out.set(session, [span]);
  };
  for (const r of rows) put(r.session_id, { from: Date.parse(r.started_at), to: Date.parse(r.ended_at ?? r.seen_at) });
  for (const r of packs) put(r.session_id, { from: Date.parse(r.started_at), to: Date.parse(r.ended_at), packs: true });
  return out;
}

/** How many of the latest sessions a deploy's usual boot and idle are read from. */
const OVERHEAD_SESSIONS = 12;

/** What a deploy bills besides its renders, as the Hunt says it beside a render's cost (ms of the pod's time). */
export interface DeployOverhead {
  /** The usual boot: from the deploy to its ComfyUI's first answer. */
  bootMs: number;
  /** The usual idle at the end: from its last work to its stop. */
  idleMs: number;
  /**
   * The usual time fetching files of the sessions that fetched any, for a deploy without a network volume (its models come
   * at every deploy, ~45 % more than boot and idle on the owner's deploys); 0 for one with a volume, which keeps them.
   */
  fetchMs: number;
  /** How many sessions it was read from. */
  sessions: number;
}

/**
 * The usual boot, the usual idle at the end and, for a deploy without a volume, the usual fetch of this user's latest
 * sessions that ended: what each deploy costs on top of its renders, whatever it renders. Null with no session ended yet.
 */
export async function deployOverhead(db: Db, now = Date.now(), o: { volume?: boolean } = {}): Promise<DeployOverhead | null> {
  const rows = await db.selectFrom("rent_sessions").selectAll().where("ended_at", "is not", null).orderBy("started_at", "desc").limit(OVERHEAD_SESSIONS).execute();
  if (!rows.length) return null;
  const iso = (ms: number) => new Date(ms).toISOString();
  const sFrom = Math.min(...rows.map((r) => Date.parse(r.started_at)));
  const sTo = Math.max(...rows.map((r) => Date.parse(r.ended_at!)));
  const machines = [...new Set(rows.map((r) => r.machine_id))];
  const renders = await db.selectFrom("render_stats").select(["machine_id", "created_at", "total_ms", "status", "started_at"]).where("machine_id", "in", machines).where("created_at", ">=", iso(sFrom)).where("created_at", "<=", iso(sTo + DAY)).execute();
  const fetches = await db.selectFrom("pod_fetches").selectAll().where("ended_at", ">=", iso(sFrom)).where("started_at", "<=", iso(sTo)).execute();
  const measures = await db.selectFrom("pod_measures").selectAll().where("at", ">=", iso(sFrom)).where("at", "<=", iso(sTo + 60_000)).execute();
  const usualBootMs = median((await db.selectFrom("pod_measures").select("ms").where("kind", "=", "boot").orderBy("at", "desc").limit(12).execute()).map((r) => Number(r.ms)));
  const outside = await outsideOf(db, sFrom, sTo);
  const boots: number[] = [];
  const idles: number[] = [];
  const fetched: number[] = [];
  const around = aroundOf(renders, fetches, measures, usualBootMs, outside);
  for (const r of rows) {
    const split = splitOf(r, sessionOf(r, around, now).facts);
    const parts = partsOf(split.spans);
    boots.push(parts.boot);
    idles.push(idleTail(split.spans, false));
    // a session that fetched nothing had its files there (a volume): not a deploy's usual fetch
    if (parts.fetch > 0) fetched.push(parts.fetch);
  }
  return { bootMs: median(boots)!, idleMs: median(idles)!, fetchMs: o.volume ? 0 : median(fetched) ?? 0, sessions: rows.length };
}

const inside = (at: string, from: number, to: number) => {
  const t = Date.parse(at);
  return t >= from && t <= to;
};

function groupBy<T>(list: readonly T[], key: (x: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const x of list) {
    const k = key(x);
    const had = out.get(k);
    if (had) had.push(x);
    else out.set(k, [x]);
  }
  return out;
}

/** What a session was for, as its row says it: what it rendered most of, or that it rendered nothing (but work from outside Afflatus). */
function whyOf(renders: ReadonlyArray<{ status: string; item: ItemRef | null; usd: number }>, outsideMs = 0): string {
  if (!renders.length) return outsideMs > 0 ? "no render, work outside Afflatus" : "no render";
  const failed = renders.filter((r) => r.status !== "done").length;
  const byItem = groupBy(renders.filter((r) => r.item), (r) => r.item!.id);
  const top = [...byItem.values()].sort((a, b) => b.reduce((n, r) => n + r.usd, 0) - a.reduce((n, r) => n + r.usd, 0))[0];
  const what = top ? `${top[0]!.item!.name} · ${plural(renders.length, "render")}` : plural(renders.length, "render");
  return failed ? `${what}, ${failed} failed` : what;
}

/** Each render's timeline or draft (by job id), and that one's project. */
async function itemsOf(db: Db, ids: string[]): Promise<Map<string, { item: ItemRef | null; project: string | null }>> {
  const out = new Map<string, { item: ItemRef | null; project: string | null }>();
  if (!ids.length) return out;
  const jobs: Array<{ id: string; draft_id: string | null; timeline_id: string | null; clip_id: string | null; folder_id: string | null }> = [];
  for (let i = 0; i < ids.length; i += 500) jobs.push(...(await db.selectFrom("jobs").select(["id", "draft_id", "timeline_id", "clip_id", "folder_id"]).where("id", "in", ids.slice(i, i + 500)).execute()));
  const clipIds = [...new Set(jobs.filter((j) => !j.timeline_id && j.clip_id).map((j) => j.clip_id!))];
  const clips = clipIds.length ? await db.selectFrom("clips").select(["id", "timeline_id"]).where("id", "in", clipIds).execute() : [];
  // looked up by id: the whole record's renders against every timeline, draft and folder was renders × items
  const clipTimeline = new Map(clips.map((c) => [c.id, c.timeline_id]));
  const timelineOf = (j: (typeof jobs)[number]) => j.timeline_id ?? (j.clip_id ? clipTimeline.get(j.clip_id) : undefined) ?? null;
  const tIds = [...new Set(jobs.map(timelineOf).filter((x): x is string => Boolean(x)))];
  const dIds = [...new Set(jobs.map((j) => j.draft_id).filter((x): x is string => Boolean(x)))];
  const fIds = [...new Set(jobs.map((j) => j.folder_id).filter((x): x is string => Boolean(x)))];
  const timelines = tIds.length ? await db.selectFrom("timelines").select(["id", "name", "project_id"]).where("id", "in", tIds).execute() : [];
  const drafts = dIds.length ? await db.selectFrom("drafts").select(["id", "name", "title", "project_id"]).where("id", "in", dIds).execute() : [];
  const folders = fIds.length ? await db.selectFrom("folders").select(["id", "project_id"]).where("id", "in", fIds).execute() : [];
  const [timelineById, draftById, folderById] = [new Map(timelines.map((x) => [x.id, x])), new Map(drafts.map((x) => [x.id, x])), new Map(folders.map((x) => [x.id, x]))];
  for (const j of jobs) {
    const tId = timelineOf(j);
    const t = tId ? timelineById.get(tId) : undefined;
    const dr = !t && j.draft_id ? draftById.get(j.draft_id) : undefined;
    const item: ItemRef | null = t ? { kind: "timeline", id: t.id, name: t.name } : dr ? { kind: "draft", id: dr.id, name: dr.name || dr.title || "Untitled draft" } : null;
    // a render of neither: the project of the folder it went to
    const project = t?.project_id ?? dr?.project_id ?? (j.folder_id ? folderById.get(j.folder_id)?.project_id : undefined) ?? null;
    out.set(j.id, { item, project });
  }
  return out;
}

type RenderLine = { id: string; recipe_id: string; model: string; model_file: string; status: string; total_ms: number; created_at: string; machine_id: string | null; gpu: string | null; energy_wh: number | null; whole: number };

/** Each project's renders on pods (the Inbox for those in none), and its timelines and drafts, the costliest first. */
async function byProject(db: Db, rows: readonly RenderLine[], refs: Map<string, { item: ItemRef | null; project: string | null }>, rate: Map<string, number>, registry: Registry): Promise<ProjectCost[]> {
  const projects = await db.selectFrom("projects").select(["id", "name", "archived_at"]).execute();
  const out = new Map<string | null, ProjectCost>();
  const named = (id: string | null) => (id === null ? "Inbox" : projects.find((p) => p.id === id)?.name ?? "A deleted project");
  for (const p of projects) if (!p.archived_at) out.set(p.id, { id: p.id, name: p.name, usd: 0, renders: 0, timelines: 0, drafts: 0, items: [] });
  for (const r of rows) {
    const ref = refs.get(r.id);
    const pid = ref?.project && projects.some((p) => p.id === ref.project) ? ref.project : null;
    const p = out.get(pid) ?? { id: pid, name: named(pid), usd: 0, renders: 0, timelines: 0, drafts: 0, items: [] };
    out.set(pid, p);
    const usd = usdOf(r.total_ms, rate.get(r.id) ?? 0);
    p.usd += usd;
    p.renders++;
    if (!ref?.item) continue;
    let item = p.items.find((i) => i.id === ref.item!.id);
    if (!item) p.items.push((item = { ...ref.item, usd: 0, renders: 0, models: [] }));
    item.usd += usd;
    item.renders++;
    const model = nameOf(registry, r.recipe_id);
    if (!item.models.includes(model)) item.models.push(model);
  }
  for (const p of out.values()) {
    p.items.sort((a, b) => b.usd - a.usd);
    p.timelines = p.items.filter((i) => i.kind === "timeline").length;
    p.drafts = p.items.filter((i) => i.kind === "draft").length;
  }
  // the costliest first; the Inbox among them by its cost, projects with nothing on a pod after
  return [...out.values()].filter((p) => p.id !== null || p.renders > 0).sort((a, b) => b.usd - a.usd || a.name.localeCompare(b.name));
}

/** The models of the window, each on the GPUs it rendered on (p50 × rate), this PC (its electricity), and a GPU not tried yet. */
async function costRows(rows: readonly RenderLine[], onPod: (r: RenderLine) => boolean, rate: Map<string, number>, gpuOfSession: Map<string, string>, sessions: SessionView[], d: CostsDeps, homeFirst: string, price: number | null): Promise<RenderCostRow[]> {
  const done = rows.filter((r) => r.status === "done");
  const gpuOfRender = new Map<string, string>();
  for (const s of sessions) for (const r of s.renders) gpuOfRender.set(r.id, gpuOfSession.get(s.id) ?? "GPU");
  const models = [...groupBy(done, (r) => `${r.recipe_id}\n${r.model_file}`)]
    .map(([key, list]) => ({ key, list, pod: list.filter(onPod) }))
    .sort((a, b) => b.pod.length - a.pod.length || b.list.length - a.list.length)
    .slice(0, 10);
  const out: RenderCostRow[] = [];
  const offers = models.some((m) => m.pod.length) ? await d.offers().catch(() => null) : null;
  for (const m of models) {
    const head = m.list[0]!;
    const model = nameOf(d.registry, head.recipe_id);
    const file = head.model_file ? modelStem(head.model_file) : "";
    const mine: RenderCostRow[] = [];
    for (const [gpu, list] of groupBy(m.pod.filter((r) => rate.has(r.id)), (r) => gpuOfRender.get(r.id) ?? "GPU")) {
      const ms = median(list.map((r) => r.total_ms))!;
      const r = median(list.map((x) => rate.get(x.id)!))!;
      mine.push({ key: m.key, model, file, where: "pod", on: gpu, ms, renders: list.length, usd: usdOf(ms, r), local: null, wh: null, best: false });
    }
    mine.sort((a, b) => a.usd! - b.usd!);
    if (mine[0]) mine[0].best = true;
    // a GPU not tried yet, from the GPU hunt's ranking: the cheapest a render of the guesses, anchored on this model's p50
    if (mine.length && offers?.length) {
      // the hunt's ranking anchored on this model's own p50 on the cheapest GPU it ran on: that GPU at the common pace, the
      // others guessed from it by the hunt's rough table of speeds
      const learned = { gpus: mine.map((x) => ({ gpu: x.on, pace: (x.ms ?? 0) / mine[0]!.ms!, renders: x.renders })), oom: [], minRenders: 1 };
      const ranked = rankGpus(offers, [{ files: head.model_file ? [{ file: head.model_file, size: null }] : [], ms: mine[0]!.ms! }], learned, { mode: "value", ceiling: Infinity, leftOut: [], dataCenter: null });
      const tried = new Set(mine.map((x) => x.on.toLowerCase()));
      const guess = ranked.find((g) => g.learned === 0 && g.cost !== null && g.seconds !== null && g.fit === "yes" && !tried.has(gpuShort(g.name).toLowerCase()));
      if (guess) mine.push({ key: m.key, model, file, where: "guess", on: gpuShort(guess.name), ms: guess.seconds! * 1000, renders: 0, usd: guess.cost, local: null, wh: null, best: false });
    }
    out.push(...mine);
    for (const [machine, list] of groupBy(m.list.filter((r) => !onPod(r)), (r) => r.machine_id ?? homeFirst)) {
      const ms = median(list.map((r) => r.total_ms));
      const wh = median(list.filter((r) => r.energy_wh !== null).map((r) => r.energy_wh!));
      const name = d.settings.machines.find((x) => x.id === machine)?.name;
      out.push({ key: m.key, model, file, where: "home", on: name || "This PC", ms, renders: list.length, usd: null, local: wh !== null && price !== null ? (wh / 1000) * price : null, wh, best: false });
    }
  }
  return out;
}

/** A session's boot in the window, as the advice weighs it: its pull (null: not kept), the packs it installed, whether they were read. */
export interface BootSeen {
  pullMs: number | null;
  packs: string[];
  packsKnown: boolean;
}

/** A pull longer than this is a host new to the image: the pulls said are those. */
export const LONG_PULL_MS = 5 * 60_000;
/** Node pack installs are said from this much of the window's money on: a few seconds of them are no advice. */
export const PACKS_SAID_USD = 0.05;

/** Names said in a line: "A", "A and B", "A, B and C", "A, B, C and 2 more". */
const namesSaid = (names: readonly string[]): string => {
  const shown = names.length > 4 ? [...names.slice(0, 3), `${names.length - 3} more`] : [...names];
  return shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}` : shown[0] ?? "";
};

/**
 * What would cost less, by fixed rules on the window's figures (no language model): the idle at the end of sessions against a
 * shorter idle, the boots, the image pulls and the node packs' installs in them, the same files fetched on several deploys
 * against a volume, and the cheapest GPU per model. Only what has something to say: none of them when the window has
 * nothing worth saying.
 */
export function adviceOf(f: {
  where: { ms: PartMs; usd: Record<Part, number>; boot?: { ms: BootMs; usd: BootMs } };
  tails: ReadonlyArray<{ tailMs: number; rate: number; idle: number }>;
  fetched: readonly Fetched[];
  bootsSeen: readonly number[];
  boots?: readonly BootSeen[];
  rows: readonly RenderCostRow[];
  sessions: number;
}): CostAdvice[] {
  const out: CostAdvice[] = [];
  const total = PARTS.reduce((n, p) => n + f.where.usd[p], 0);
  const min = (ms: number) => `${Math.round(ms / 60_000)} min`;
  // idle: what a shorter idle would have saved on the sessions that ended idle
  const ended = f.tails.filter((t) => t.tailMs > 0);
  if (ended.length && f.where.usd.idle >= 0.01) {
    const idles = [...new Set(ended.map((t) => t.idle))];
    const setting = Math.max(...idles);
    const shorter = shorterIdle(setting);
    const save = shorter < setting || setting <= 0 ? idleSaving(ended, shorter) : 0;
    const waited = setting <= 0 ? "Your pods never stop on their own when idle." : `Your pods wait ${idles.length > 1 ? `up to ${setting}` : setting} min before they stop.`;
    out.push({
      kind: "idle", title: `Idle: ${min(f.where.ms.idle)}, ${dollars(f.where.usd.idle)}`,
      why: save >= 0.01 ? `${waited} At ${shorter} min the same sessions would have cost ${dollars(save)} less.` : `${waited} It is mostly the wait between renders: a shorter idle would boot more often.`,
      save: save >= 0.01 ? save : null,
    });
  }
  // the boots: fewer, longer sessions
  if (f.sessions >= 2 && total > 0 && f.where.usd.boot / total >= 0.15) {
    const lo = Math.min(...f.bootsSeen);
    const hi = Math.max(...f.bootsSeen);
    const range = Math.round(lo / 60_000) === Math.round(hi / 60_000) ? min(lo) : `${Math.round(lo / 60_000)}–${min(hi)}`;
    out.push({ kind: "boot", title: `Booting: ${min(f.where.ms.boot)}, ${dollars(f.where.usd.boot)}`, why: `Each deploy boots ${range}. Deploying fewer, longer sessions (queue the batch first) boots less.`, save: null });
  }
  // in the boots: the image pulled onto hosts new to it, and the node packs' Python packages installed at every start
  const boot = f.where.boot;
  const boots = f.boots ?? [];
  const pulled = boots.filter((b) => b.pullMs !== null);
  const longPulls = pulled.filter((b) => b.pullMs! > LONG_PULL_MS).length;
  if (boot && longPulls && boot.usd.pull >= 0.01) {
    out.push({
      kind: "pull", title: `Image pulls: ${min(boot.ms.pull)}, ${dollars(boot.usd.pull)}`,
      why: `${longPulls === pulled.length ? (longPulls === 1 ? "Its boot" : `All ${longPulls} boots`) : `${longPulls} of ${pulled.length} boots`} spent over ${min(LONG_PULL_MS)} pulling the image: a host new to it pulls it first, billed while it comes. A host that has it starts in seconds.`,
      save: null,
    });
  }
  if (boot && boot.usd.packs >= PACKS_SAID_USD) {
    const read = boots.filter((b) => b.packsKnown);
    const times = new Map<string, number>();
    for (const b of read) for (const p of new Set(b.packs)) times.set(p, (times.get(p) ?? 0) + 1);
    // the packs installed on most of the deploys whose boot log was read, the most often first
    const most = [...times].filter(([, n]) => n * 2 > read.length).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([p]) => p);
    const on = read.length === 1 ? "your deploy" : times.get(most.at(-1)!) === read.length ? (read.length === 2 ? "both of your deploys" : `all ${read.length} of your deploys`) : `most of your ${read.length} deploys`;
    const what = most.length ? `${namesSaid(most)} ${most.length > 1 ? "are" : "is"} installed on ${on}` : "Node packs' Python packages are installed on your deploys";
    out.push({
      kind: "packs", title: `Node pack installs: ${min(boot.ms.packs)}, ${dollars(boot.usd.packs)}`,
      why: `${what}: the packs on the volume get their Python packages at every start. A pack you no longer use, taken off the volume, stops costing it.`,
      save: null,
    });
  }
  // the same files on several deploys: a volume keeps them
  const again = fetchAdvice(f.fetched);
  if (again) {
    const allBytes = f.fetched.reduce((n, x) => n + x.bytes, 0);
    const times = again.biggest.times === 2 ? "twice" : `${again.biggest.times} times`;
    const pays = Number.isFinite(again.deploys) ? `: it pays for itself at about ${plural(again.deploys, "deploy")} a month` : "";
    out.push({
      kind: "fetch", title: `Files fetched: ${(allBytes / GB).toFixed(allBytes >= 10 * GB ? 0 : 1)} GB, ${min(f.where.ms.fetch)}`,
      why: `${again.biggest.name}'s ${(again.biggest.bytes / GB).toFixed(1)} GB came ${times}. A ${again.volumeGb} GB volume (${dollars(again.perMonth)}/month) keeps them${pays}.`,
      save: null,
    });
  }
  // the cheapest GPU per model: the two models rendered most on pods
  const byModel = groupBy(f.rows.filter((r) => r.where !== "home"), (r) => r.key);
  for (const list of [...byModel.values()].filter((l) => l.some((r) => r.where === "pod")).sort((a, b) => b.reduce((n, r) => n + r.renders, 0) - a.reduce((n, r) => n + r.renders, 0)).slice(0, 2)) {
    const best = list.find((r) => r.best)!;
    const guess = list.find((r) => r.where === "guess");
    const others = list.filter((r) => r.where === "pod" && !r.best);
    const name = best.model;
    if (guess && guess.usd! < best.usd!) {
      out.push({ kind: "gpu", title: `${name} may cost less on an ${guess.on}`, why: `Guessed ${pct(guess.ms!, best.ms!)} the ${best.on}'s time at ${dollars(guess.usd!)} a render against ${dollars(best.usd!)}. Untried: a guess until it renders.`, save: null });
    } else if (others.length || guess) {
      const vs = others[0] ? `The ${others[0].on} took ${dollars(others[0].usd!)} a render against ${dollars(best.usd!)} here.` : `An ${guess!.on} is guessed at ${pct(guess!.ms!, best.ms!)} its time but ${dollars(guess!.usd!)} a render: dearer. Untried: a guess until it renders.`;
      out.push({ kind: "gpu", title: `${name} on the ${best.on} is your cheapest so far`, why: vs, save: null });
    }
  }
  return out;
}

/** One time against another, as said: "15 % under", "20 % over". */
const pct = (ms: number, against: number) => {
  const d = Math.round((ms / against - 1) * 100);
  return d === 0 ? "about" : `${Math.abs(d)} % ${d < 0 ? "under" : "over"}`;
};
