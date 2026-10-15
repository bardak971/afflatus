import { modelStem, plural, rankGpus, shortGpu, volumePerMonth, type RankOffer } from "@afflatus/core";
import type { Selectable } from "kysely";
import type { Db, Tables } from "./db";
import { dollars } from "./notifyWords";
import { median } from "./renderDigests";
import { nameOf, windowOf } from "./rendersRead";
import type { Registry } from "./registry";
import type { Spending } from "./rented";
import type { Settings } from "./settings";

/**
 * The Queue's Costs tab: what the rented GPUs cost and where it went, what a render costs where it runs, and what this PC's
 * electricity comes to. Worked out from what Afflatus keeps: the pods' sessions (rent_sessions), when each one's ComfyUI
 * first answered, the files each got (pod_fetches; pod_measures for the sessions before them), the renders (render_stats,
 * with the energy a render of this PC's drew) and RunPod's bill where it has arrived (rented.ts spending).
 *
 * A session's time is cut into what the pod did, which always adds up to its length (and its cost to its length × its rate):
 * a render under way is Rendering (Failed renders when it did not finish), a file coming is Fetching files, before its
 * ComfyUI first answered is Booting, and the rest is Idle. A session before those were kept has its boot's end and its files
 * worked out from what there is, and says so ("estimated").
 */

export type Part = "render" | "boot" | "fetch" | "idle" | "failed";
export const PARTS: readonly Part[] = ["render", "boot", "fetch", "idle", "failed"];
export type PartMs = Record<Part, number>;
const noParts = (): PartMs => ({ render: 0, boot: 0, fetch: 0, idle: 0, failed: 0 });

const HOUR = 3_600_000;
const DAY = 86_400_000;
const GB = 1e9;
const usdOf = (ms: number, rate: number) => (ms / HOUR) * rate;

export interface Span {
  from: number;
  to: number;
  part: Part;
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
}

/**
 * A session's time cut into what its pod did, in order, adding up to its length: Rendering or Failed renders under a render,
 * else Fetching files under a file, else Booting before its ComfyUI first answered, else Idle. `estimated` says what was
 * worked out rather than kept.
 */
export function splitSession(f: SessionFacts): { spans: Span[]; estimated: string[] } {
  const estimated: string[] = [];
  if (!(f.to > f.from)) return { spans: [], estimated };
  const firstWork = Math.min(...f.renders.map((r) => r.from), ...f.fetches.map((x) => x.from));
  let bootEnd: number;
  if (f.upAt !== null) bootEnd = f.upAt;
  else if (Number.isFinite(firstWork)) {
    // its ComfyUI answered by its first render or file at the latest
    bootEnd = firstWork;
    estimated.push("its boot, up to its first work");
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
  for (const r of [...f.renders, ...f.fetches]) {
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
    const part: Part = render ? (render.ok ? "render" : "failed") : f.fetches.some((x) => x.from <= mid && mid < x.to) ? "fetch" : mid < bootEnd ? "boot" : "idle";
    const last = spans.at(-1);
    if (last && last.part === part && last.to === a) last.to = b;
    else spans.push({ from: a, to: b, part });
  }
  return { spans, estimated };
}

/** The spans within a window, cut at its ends. */
export const clipSpans = (spans: readonly Span[], from: number, to: number): Span[] =>
  spans.flatMap((s) => {
    const a = Math.max(from, s.from);
    const b = Math.min(to, s.to);
    return b > a ? [{ from: a, to: b, part: s.part }] : [];
  });

export function partsOf(spans: readonly Span[]): PartMs {
  const out = noParts();
  for (const s of spans) out[s.part] += s.to - s.from;
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
  for (const f of fetched) byKey.set(f.key, [...(byKey.get(f.key) ?? []), f]);
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
  kind: Part | "gpu";
  title: string;
  why: string;
  /** What it would have saved over the window, USD; null when it says no figure. */
  save: number | null;
}

export interface SessionView {
  id: string;
  machine: string;
  gpu: string | null;
  rate: number;
  from: number;
  to: number;
  open: boolean;
  usd: number;
  /** Its time by part (ms), in its own order and adding up to its length. */
  parts: PartMs;
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
  month: number;
  today: { usd: number; sessions: number; ms: number };
  caps: { day: number; month: number };
  /** USD a day over the last 7 days (Afflatus's count), and the month's end at that pace. */
  pace7: number;
  monthEnd: number;
  balance: number | null;
  runwayDays: number | null;
  storage: { perMonth: number; volumes: number; stoppedDisks: number } | null;
  /** The window's pod time by part: ms and USD. */
  where: { ms: PartMs; usd: Record<Part, number>; estimated: boolean };
  /** USD per stretch of `times`, by GPU. */
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
  const [wFrom, wTo] = [win === "all" ? start : Math.max(start, asked.from!), Math.min(end, now)];

  // ---- the sessions in the window, and what each did
  const iso = (ms: number) => new Date(ms).toISOString();
  const rows = await db.selectFrom("rent_sessions").selectAll().where("started_at", "<", iso(wTo)).where((eb) => eb.or([eb("ended_at", "is", null), eb("ended_at", ">", iso(wFrom))])).orderBy("started_at", "desc").execute();
  const rented = new Set((await db.selectFrom("rent_sessions").select("machine_id").distinct().execute()).map((r) => r.machine_id));
  for (const m of d.settings.machines) if (m.rented) rented.add(m.id);
  const sFrom = Math.min(wFrom, ...rows.map((r) => Date.parse(r.started_at)));
  const sTo = Math.max(wTo, ...rows.map((r) => (r.ended_at ? Date.parse(r.ended_at) : now)));
  const renders = await db
    .selectFrom("render_stats")
    .select(["id", "recipe_id", "model", "model_file", "status", "total_ms", "created_at", "machine_id", "gpu", "energy_wh", "whole"])
    .where("created_at", ">=", iso(sFrom))
    .where("created_at", "<=", iso(sTo + DAY))
    .execute();
  const fetches = await db.selectFrom("pod_fetches").selectAll().where("ended_at", ">=", iso(sFrom)).where("started_at", "<=", iso(sTo)).execute();
  const measures = await db.selectFrom("pod_measures").selectAll().where("at", ">=", iso(sFrom)).where("at", "<=", iso(sTo + 60_000)).execute();
  const boots = (await db.selectFrom("pod_measures").select("ms").where("kind", "=", "boot").orderBy("at", "desc").limit(12).execute()).map((r) => Number(r.ms));
  const usualBootMs = median(boots);
  const lastDeployIdle = d.settings.lastDeploy?.idleMinutes ?? 10;
  const machineOf = new Map(d.settings.machines.map((m) => [m.id, m]));
  const homeFirst = d.settings.machines.find((m) => !m.rented)?.id ?? d.settings.machines[0]?.id ?? "m1";

  // the jobs of the renders on pods: where each belongs (its timeline or draft, their project)
  const podRenders = renders.filter((r) => r.machine_id && rented.has(r.machine_id));
  const refs = await itemsOf(db, podRenders.map((r) => r.id));

  const sessions: SessionView[] = [];
  const whereMs = noParts();
  const whereUsd: Record<Part, number> = { render: 0, boot: 0, fetch: 0, idle: 0, failed: 0 };
  let estimatedAny = false;
  const tails: Array<{ tailMs: number; rate: number; idle: number }> = [];
  const fetched: Fetched[] = [];
  const bootsSeen: number[] = [];
  const renderRate = new Map<string, number>();
  const gpuOfSession = new Map<string, string>();
  for (const r of rows) {
    const from = Date.parse(r.started_at);
    const to = r.ended_at ? Date.parse(r.ended_at) : now;
    const { mine, kept, guessed, split } = sessionOf(r, { renders: podRenders, fetches, measures, usualBootMs }, now);
    if (split.estimated.length) estimatedAny = true;
    const parts = partsOf(split.spans);
    const inWindow = partsOf(clipSpans(split.spans, wFrom, wTo));
    for (const p of PARTS) {
      whereMs[p] += inWindow[p];
      whereUsd[p] += usdOf(inWindow[p], r.rate);
    }
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
      id: r.id, machine: r.machine_id, gpu, rate: r.rate, from, to, open: !r.ended_at, usd: usdOf(to - from, r.rate), parts, estimated: split.estimated, why: whyOf(its), idleMinutes: idle,
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

  // ---- by project: the renders on pods in the window, at their session's rate
  const projects = await byProject(db, podRenders.filter((r) => inside(r.created_at, wFrom, wTo)), refs, renderRate, d.registry);

  // ---- a render's cost, model by where it ran
  const inWin = renders.filter((r) => inside(r.created_at, wFrom, wTo));
  const kwh = d.settings.costs;
  const renderCosts = await costRows(inWin, rented, renderRate, gpuOfSession, sessions, d, homeFirst, kwh.kwhPrice);

  // ---- this PC: the energy its renders drew
  const home: HomeView[] = [];
  for (const [machine, list] of groupBy(inWin.filter((r) => !r.machine_id || !rented.has(r.machine_id)), (r) => r.machine_id ?? homeFirst)) {
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
  const counted = await d.costBetween(now - 7 * DAY, now);
  const pace7 = counted / 7;
  const todaySessions = (await db.selectFrom("rent_sessions").select(["started_at", "ended_at", "rate"]).where((eb) => eb.or([eb("ended_at", "is", null), eb("ended_at", ">", iso(todayFrom))])).execute());
  const todayMs = todaySessions.reduce((n, r) => n + Math.max(0, (r.ended_at ? Date.parse(r.ended_at) : now) - Math.max(todayFrom, Date.parse(r.started_at))), 0);
  const monthCount = await d.costBetween(new Date(nowDate.getFullYear(), nowDate.getMonth(), 1).getTime(), now);
  const month = spending?.month ?? monthCount;
  const today = spending?.today ?? (await d.costBetween(todayFrom, now));

  const advice = adviceOf({ where: { ms: whereMs, usd: whereUsd }, tails, fetched, bootsSeen, rows: renderCosts, sessions: sessions.length });

  return {
    from: wFrom, to: wTo, step, times, billed: spending?.billed ?? false, billReadAt: d.billReadAt, runpod: Boolean(spending), month,
    today: { usd: today, sessions: todaySessions.length, ms: todayMs }, caps: d.settings.rentCaps, pace7, monthEnd: month + pace7 * ((monthEndAt - now) / DAY),
    balance: spending?.balance ?? null, runwayDays: spending?.balance != null && pace7 > 0 ? spending.balance / pace7 : null,
    storage: spending?.storage ? { perMonth: spending.storage.perMonth, volumes: spending.storage.volumes, stoppedDisks: spending.storage.stoppedDisks } : null,
    where: { ms: whereMs, usd: whereUsd, estimated: estimatedAny }, spend, projects, sessions, renderCosts, advice, home, kwh: { price: kwh.kwhPrice, currency: kwh.currency },
  };
}

type SessionRow = Selectable<Tables["rent_sessions"]>;

/**
 * One session as its pod spent it (`splitSession`), from what was kept around it: its renders (by its machine, within its
 * time), its files (pod_fetches; the sessions before 0071 have theirs from pod_measures, the bigger ones worked out from their
 * speed) and when its ComfyUI first answered.
 */
function sessionOf<R extends { machine_id: string | null; created_at: string; total_ms: number; status: string }>(
  r: SessionRow,
  around: { renders: readonly R[]; fetches: ReadonlyArray<Selectable<Tables["pod_fetches"]>>; measures: ReadonlyArray<Selectable<Tables["pod_measures"]>>; usualBootMs: number | null },
  now: number,
) {
  const from = Date.parse(r.started_at);
  const to = r.ended_at ? Date.parse(r.ended_at) : now;
  const mine = around.renders.filter((x) => x.machine_id === r.machine_id).map((x) => ({ row: x, to: Date.parse(x.created_at), from: Date.parse(x.created_at) - x.total_ms })).filter((x) => x.to > from && x.from < to);
  const kept = around.fetches.filter((x) => x.machine_id === r.machine_id && Date.parse(x.ended_at) > from && Date.parse(x.started_at) < to);
  const old = r.up_at === null && !kept.length;
  const guessed = old ? around.measures.filter((m) => m.kind !== "boot" && Date.parse(m.at) > from && Date.parse(m.at) <= to + 60_000) : [];
  const boot = around.measures.find((m) => m.kind === "boot" && Date.parse(m.at) >= from && Date.parse(m.at) <= to + 60_000);
  const upAt = r.up_at ? Date.parse(r.up_at) : boot ? Date.parse(boot.at) : null;
  const split = splitSession({
    from, to, upAt, usualBootMs: around.usualBootMs,
    renders: mine.map((x) => ({ from: x.from, to: x.to, ok: x.row.status === "done" })),
    fetches: [...kept.map((x) => ({ from: Date.parse(x.started_at), to: Date.parse(x.ended_at) })), ...guessed.map((m) => ({ from: Date.parse(m.at) - Number(m.ms), to: Date.parse(m.at) }))],
    fetchesGuessed: old,
  });
  return { mine, kept, guessed, split };
}

/** How many of the latest sessions a deploy's usual boot and idle are read from. */
const OVERHEAD_SESSIONS = 12;

/** What a deploy bills besides its renders, as the Hunt says it beside a render's cost (ms of the pod's time). */
export interface DeployOverhead {
  /** The usual boot: from the deploy to its ComfyUI's first answer. */
  bootMs: number;
  /** The usual idle at the end: from its last work to its stop. */
  idleMs: number;
  /** How many sessions it was read from. */
  sessions: number;
}

/**
 * The usual boot and the usual idle at the end of this user's latest sessions that ended: what each deploy costs on top of
 * its renders, whatever it renders. Null with no session ended yet. The files fetched are left out: they are the renders'
 * own (another set, another time).
 */
export async function deployOverhead(db: Db, now = Date.now()): Promise<DeployOverhead | null> {
  const rows = await db.selectFrom("rent_sessions").selectAll().where("ended_at", "is not", null).orderBy("started_at", "desc").limit(OVERHEAD_SESSIONS).execute();
  if (!rows.length) return null;
  const iso = (ms: number) => new Date(ms).toISOString();
  const sFrom = Math.min(...rows.map((r) => Date.parse(r.started_at)));
  const sTo = Math.max(...rows.map((r) => Date.parse(r.ended_at!)));
  const machines = [...new Set(rows.map((r) => r.machine_id))];
  const renders = await db.selectFrom("render_stats").select(["machine_id", "created_at", "total_ms", "status"]).where("machine_id", "in", machines).where("created_at", ">=", iso(sFrom)).where("created_at", "<=", iso(sTo + DAY)).execute();
  const fetches = await db.selectFrom("pod_fetches").selectAll().where("ended_at", ">=", iso(sFrom)).where("started_at", "<=", iso(sTo)).execute();
  const measures = await db.selectFrom("pod_measures").selectAll().where("at", ">=", iso(sFrom)).where("at", "<=", iso(sTo + 60_000)).execute();
  const usualBootMs = median((await db.selectFrom("pod_measures").select("ms").where("kind", "=", "boot").orderBy("at", "desc").limit(12).execute()).map((r) => Number(r.ms)));
  const boots: number[] = [];
  const idles: number[] = [];
  for (const r of rows) {
    const { split } = sessionOf(r, { renders, fetches, measures, usualBootMs }, now);
    boots.push(partsOf(split.spans).boot);
    idles.push(idleTail(split.spans, false));
  }
  return { bootMs: median(boots)!, idleMs: median(idles)!, sessions: rows.length };
}

const inside = (at: string, from: number, to: number) => {
  const t = Date.parse(at);
  return t >= from && t <= to;
};

function groupBy<T>(list: readonly T[], key: (x: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const x of list) out.set(key(x), [...(out.get(key(x)) ?? []), x]);
  return out;
}

/** What a session was for, as its row says it: what it rendered most of, or that it rendered nothing. */
function whyOf(renders: ReadonlyArray<{ status: string; item: ItemRef | null; usd: number }>): string {
  if (!renders.length) return "no render";
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
  const timelineOf = (j: (typeof jobs)[number]) => j.timeline_id ?? clips.find((c) => c.id === j.clip_id)?.timeline_id ?? null;
  const tIds = [...new Set(jobs.map(timelineOf).filter((x): x is string => Boolean(x)))];
  const dIds = [...new Set(jobs.map((j) => j.draft_id).filter((x): x is string => Boolean(x)))];
  const fIds = [...new Set(jobs.map((j) => j.folder_id).filter((x): x is string => Boolean(x)))];
  const timelines = tIds.length ? await db.selectFrom("timelines").select(["id", "name", "project_id"]).where("id", "in", tIds).execute() : [];
  const drafts = dIds.length ? await db.selectFrom("drafts").select(["id", "name", "title", "project_id"]).where("id", "in", dIds).execute() : [];
  const folders = fIds.length ? await db.selectFrom("folders").select(["id", "project_id"]).where("id", "in", fIds).execute() : [];
  for (const j of jobs) {
    const t = timelines.find((x) => x.id === timelineOf(j));
    const dr = !t ? drafts.find((x) => x.id === j.draft_id) : undefined;
    const item: ItemRef | null = t ? { kind: "timeline", id: t.id, name: t.name } : dr ? { kind: "draft", id: dr.id, name: dr.name || dr.title || "Untitled draft" } : null;
    // a render of neither: the project of the folder it went to
    const project = t?.project_id ?? dr?.project_id ?? folders.find((f) => f.id === j.folder_id)?.project_id ?? null;
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
async function costRows(rows: readonly RenderLine[], rented: Set<string>, rate: Map<string, number>, gpuOfSession: Map<string, string>, sessions: SessionView[], d: CostsDeps, homeFirst: string, price: number | null): Promise<RenderCostRow[]> {
  const done = rows.filter((r) => r.status === "done");
  const gpuOfRender = new Map<string, string>();
  for (const s of sessions) for (const r of s.renders) gpuOfRender.set(r.id, gpuOfSession.get(s.id) ?? "GPU");
  const models = [...groupBy(done, (r) => `${r.recipe_id}\n${r.model_file}`)]
    .map(([key, list]) => ({ key, list, pod: list.filter((r) => r.machine_id && rented.has(r.machine_id)) }))
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
    for (const [machine, list] of groupBy(m.list.filter((r) => !r.machine_id || !rented.has(r.machine_id)), (r) => r.machine_id ?? homeFirst)) {
      const ms = median(list.map((r) => r.total_ms));
      const wh = median(list.filter((r) => r.energy_wh !== null).map((r) => r.energy_wh!));
      const name = d.settings.machines.find((x) => x.id === machine)?.name;
      out.push({ key: m.key, model, file, where: "home", on: name || "This PC", ms, renders: list.length, usd: null, local: wh !== null && price !== null ? (wh / 1000) * price : null, wh, best: false });
    }
  }
  return out;
}

/**
 * What would cost less, by fixed rules on the window's figures (no language model): the idle at the end of sessions against a
 * shorter idle, the boots, the same files fetched on several deploys against a volume, and the cheapest GPU per model. Only
 * what has something to say: none of them when the window has nothing worth saying.
 */
export function adviceOf(f: {
  where: { ms: PartMs; usd: Record<Part, number> };
  tails: ReadonlyArray<{ tailMs: number; rate: number; idle: number }>;
  fetched: readonly Fetched[];
  bootsSeen: readonly number[];
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
