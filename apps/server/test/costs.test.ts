import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FakeComfy } from "@afflatus/comfy/testing";
import { adviceOf, BOOT_PARTS, bootPartsOf, costs, deployOverhead, fetchAdvice, idleSaving, NOT_SPLIT, PARTS, partsOf, splitSession, type BootMs, type CostsDeps, type CostsView, type Fetched, type PartMs } from "../src/costs";
import type { Spending } from "../src/rented";
import { openSqlite, migrate, type Db } from "../src/db";
import { energyOf, PowerLog } from "../src/power";
import type { Registry } from "../src/registry";
import type { RankOffer } from "@afflatus/core";
import { readSettings } from "../src/settings";
import { complete, get, job, makeApp, makeFake, post, until, type TestApp } from "./helpers";

/** The Queue's Costs tab (costs.ts): a pod's time cut into what it did, its renders by project, the advice, this PC's electricity. */

const MIN = 60_000;
const HOUR = 3_600_000;
const sum = (p: PartMs) => PARTS.reduce((n, k) => n + p[k], 0);
const bootSum = (p: BootMs) => BOOT_PARTS.reduce((n, k) => n + p[k], 0);

describe("a session's time", () => {
  const facts = { from: 0, to: 60 * MIN, upAt: 4 * MIN, renders: [] as Array<{ from: number; to: number; ok: boolean }>, fetches: [] as Array<{ from: number; to: number }>, fetchesGuessed: false, usualBootMs: null };

  it("adds up to its length: boot to its first answer, files, renders done and failed, idle the rest", () => {
    const { spans, estimated } = splitSession({
      ...facts,
      fetches: [{ from: 4 * MIN, to: 10 * MIN }],
      renders: [{ from: 10 * MIN, to: 20 * MIN, ok: true }, { from: 22 * MIN, to: 25 * MIN, ok: false }, { from: 30 * MIN, to: 50 * MIN, ok: true }],
    });
    expect(estimated).toEqual([]);
    expect(spans.map((s) => s.part)).toEqual(["boot", "fetch", "render", "idle", "failed", "idle", "render", "idle"]);
    const parts = Object.fromEntries(PARTS.map((p) => [p, spans.filter((s) => s.part === p).reduce((n, s) => n + s.to - s.from, 0) / MIN]));
    expect(parts).toEqual({ boot: 4, fetch: 6, render: 30, failed: 3, outside: 0, idle: 17 });
    expect(spans.reduce((n, s) => n + s.to - s.from, 0)).toBe(60 * MIN);
    // one after the other, from its start to its end
    spans.slice(1).forEach((s, i) => expect(s.from).toBe(spans[i]!.to));
  });

  it("work from outside Afflatus takes idle time only: a render, a file and the boot keep theirs, and it adds up to its length", () => {
    const { spans, estimated } = splitSession({
      ...facts,
      fetches: [{ from: 4 * MIN, to: 10 * MIN }],
      renders: [{ from: 20 * MIN, to: 30 * MIN, ok: true }],
      // from within the boot (a clock off) over the file to the render's middle; then one past the session's end
      outside: [{ from: 2 * MIN, to: 25 * MIN }, { from: 50 * MIN, to: 70 * MIN }],
    });
    expect(estimated).toEqual([]);
    expect(spans.map((s) => [s.part, (s.to - s.from) / MIN])).toEqual([["boot", 4], ["fetch", 6], ["outside", 10], ["render", 10], ["idle", 20], ["outside", 10]]);
    const parts = Object.fromEntries(PARTS.map((p) => [p, spans.filter((s) => s.part === p).reduce((n, s) => n + s.to - s.from, 0) / MIN]));
    expect(parts).toEqual({ boot: 4, fetch: 6, render: 10, failed: 0, outside: 20, idle: 20 });
    expect(spans.reduce((n, s) => n + s.to - s.from, 0)).toBe(60 * MIN);
    spans.slice(1).forEach((s, i) => expect(s.from).toBe(spans[i]!.to));
    // two stretches that overlap count once; none (a session before 0077) leaves it all idle as before
    expect(partsOf(splitSession({ ...facts, outside: [{ from: 10 * MIN, to: 30 * MIN }, { from: 20 * MIN, to: 40 * MIN }] }).spans)).toMatchObject({ outside: 30 * MIN, idle: 26 * MIN });
    expect(partsOf(splitSession(facts).spans)).toMatchObject({ outside: 0, idle: 56 * MIN });
  });

  it("a render under way while a file comes is rendering; nothing past its ends counts", () => {
    const { spans } = splitSession({ ...facts, fetches: [{ from: 5 * MIN, to: 40 * MIN }], renders: [{ from: 10 * MIN, to: 70 * MIN, ok: true }] });
    expect(spans.map((s) => [s.part, (s.to - s.from) / MIN])).toEqual([["boot", 4], ["idle", 1], ["fetch", 5], ["render", 50]]);
  });

  it("an older session without its first answer kept: its boot ends at its first work, or the usual boot, and says it is estimated", () => {
    const first = splitSession({ ...facts, upAt: null, renders: [{ from: 6 * MIN, to: 9 * MIN, ok: true }] });
    expect(first.spans[0]).toEqual({ from: 0, to: 6 * MIN, part: "boot" });
    expect(first.estimated).toEqual(["its boot, up to its first work"]);
    const usual = splitSession({ ...facts, upAt: null, usualBootMs: 3 * MIN });
    expect(usual.spans.map((s) => [s.part, (s.to - s.from) / MIN])).toEqual([["boot", 3], ["idle", 57]]);
    expect(usual.estimated).toEqual(["its boot, from the usual boot here"]);
    const files = splitSession({ ...facts, fetches: [{ from: 5 * MIN, to: 7 * MIN }], fetchesGuessed: true });
    expect(files.estimated).toEqual(["its files, from their speeds (files over 100 MB only)"]);
  });

  it("its boot in parts where kept: the pull, the node packs, starting ComfyUI; adding up to its boot and its length", () => {
    const boot = { pulledAt: 1.5 * MIN, packs: { from: 2 * MIN, to: 3 * MIN }, failed: false };
    const { spans, estimated } = splitSession({ ...facts, boot, renders: [{ from: 10 * MIN, to: 20 * MIN, ok: true }] });
    expect(estimated).toEqual([]);
    expect(spans.map((s) => [s.part, s.boot ?? null, (s.to - s.from) / MIN])).toEqual([["boot", "pull", 1.5], ["boot", "comfy", 0.5], ["boot", "packs", 1], ["boot", "comfy", 1], ["idle", null, 6], ["render", null, 10], ["idle", null, 40]]);
    const b = bootPartsOf(spans);
    expect(b).toEqual({ pull: 1.5 * MIN, packs: MIN, comfy: 1.5 * MIN, startFailed: 0, boot: 0 });
    expect(bootSum(b)).toBe(4 * MIN);
    expect(spans.reduce((n, s) => n + s.to - s.from, 0)).toBe(60 * MIN);
    // a pull said past its first answer (a clock off) is cut at the boot's end: nothing counted twice
    expect(bootPartsOf(splitSession({ ...facts, boot: { pulledAt: 9 * MIN, packs: null, failed: false } }).spans)).toEqual({ pull: 4 * MIN, packs: 0, comfy: 0, startFailed: 0, boot: 0 });
  });

  it("a failed start: its pull, then all of it a failed start, nothing estimated; a boot not kept in parts stays plain", () => {
    const failed = splitSession({ ...facts, to: 12 * MIN, upAt: null, boot: { pulledAt: 7 * MIN, packs: { from: 8 * MIN, to: 9 * MIN }, failed: true } });
    expect(failed.estimated).toEqual([]);
    expect(failed.spans.map((s) => [s.part, s.boot, (s.to - s.from) / MIN])).toEqual([["boot", "pull", 7], ["boot", "startFailed", 5]]);
    // its container never up (its boot limit while pulling): all of it a failed start
    expect(bootPartsOf(splitSession({ ...facts, upAt: null, boot: { pulledAt: null, packs: null, failed: true } }).spans)).toMatchObject({ startFailed: 60 * MIN, pull: 0, boot: 0 });
    // nothing kept (a session before, RunPod's image read at no uptime): plain boot
    expect(bootPartsOf(splitSession(facts).spans)).toEqual({ pull: 0, packs: 0, comfy: 0, startFailed: 0, boot: 4 * MIN });
    // its packs read but not its pull (Afflatus away at the start): before them plain, after them starting ComfyUI
    expect(bootPartsOf(splitSession({ ...facts, boot: { pulledAt: null, packs: { from: MIN, to: 2 * MIN }, failed: false } }).spans)).toEqual({ pull: 0, packs: MIN, comfy: 2 * MIN, startFailed: 0, boot: MIN });
  });
});

describe("the advice", () => {
  it("a shorter idle saves the idle past it at the end of each session that ended idle, at its rate", () => {
    // 10 min idle at the end of a $0.60/h pod, 3 at the end of another: at 5 min, 5 min of the first are saved
    expect(idleSaving([{ tailMs: 10 * MIN, rate: 0.6 }, { tailMs: 3 * MIN, rate: 0.6 }], 5)).toBeCloseTo(0.05, 6);
    const advice = adviceOf({
      where: { ms: { render: 30 * MIN, boot: 4 * MIN, fetch: 0, outside: 0, idle: 13 * MIN, failed: 0 }, usd: { render: 0.3, boot: 0.04, fetch: 0, outside: 0, idle: 0.13, failed: 0 } },
      tails: [{ tailMs: 10 * MIN, rate: 0.6, idle: 10 }, { tailMs: 3 * MIN, rate: 0.6, idle: 10 }], fetched: [], bootsSeen: [4 * MIN], rows: [], sessions: 2,
    });
    expect(advice).toEqual([{ kind: "idle", title: "Idle: 13 min, $0.13", why: "Your pods wait 10 min before they stop. At 5 min the same sessions would have cost $0.05 less.", save: expect.closeTo(0.05, 6) }]);
  });

  it("the same file on several deploys is weighed against the volume that keeps it", () => {
    const f = (session: string, ms: number): Fetched => ({ session, key: "wan.safetensors", name: "wan", bytes: 26e9, ms, rate: 0.6 });
    expect(fetchAdvice([f("a", 6 * MIN), { ...f("a", 1), key: "other", name: "other", bytes: 1e9 }])).toBeNull();
    const again = fetchAdvice([f("a", 6 * MIN), f("b", 4 * MIN)])!;
    // 26 GB with room: a 30 GB volume at $0.07 a GB, $2.10 a month; fetching it once is 5 min at $0.60/h, $0.05
    expect(again).toMatchObject({ bytes: 26e9, times: 2, volumeGb: 30, perMonth: expect.closeTo(2.1, 6), onceUsd: expect.closeTo(0.05, 6), deploys: 42 });
    const advice = adviceOf({ where: { ms: { render: 0, boot: 0, fetch: 10 * MIN, outside: 0, idle: 0, failed: 0 }, usd: { render: 0, boot: 0, fetch: 0.1, outside: 0, idle: 0, failed: 0 } }, tails: [], fetched: [f("a", 6 * MIN), f("b", 4 * MIN)], bootsSeen: [], rows: [], sessions: 2 });
    expect(advice).toEqual([{ kind: "fetch", title: "Files fetched: 52 GB, 10 min", why: "wan's 26.0 GB came twice. A 30 GB volume ($2.10/month) keeps them: it pays for itself at about 42 deploys a month.", save: null }]);
  });

  it("the boots when they are a good part of it, and the cheapest GPU per model; nothing when there is nothing to say", () => {
    const quiet = adviceOf({ where: { ms: { render: 60 * MIN, boot: 4 * MIN, fetch: 0, outside: 0, idle: 0, failed: 0 }, usd: { render: 0.6, boot: 0.04, fetch: 0, outside: 0, idle: 0, failed: 0 } }, tails: [], fetched: [], bootsSeen: [4 * MIN], rows: [], sessions: 1 });
    expect(quiet).toEqual([]);
    const row = { key: "m", model: "Wan · Motion", file: "wan", local: null, wh: null };
    const advice = adviceOf({
      where: { ms: { render: 10 * MIN, boot: 8 * MIN, fetch: 0, outside: 0, idle: 0, failed: 0 }, usd: { render: 0.1, boot: 0.08, fetch: 0, outside: 0, idle: 0, failed: 0 } }, tails: [], fetched: [], bootsSeen: [3 * MIN, 5 * MIN], sessions: 2,
      rows: [
        { ...row, where: "pod", on: "A40", ms: 200_000, renders: 12, usd: 0.033, best: true },
        { ...row, where: "pod", on: "RTX 4090", ms: 150_000, renders: 3, usd: 0.042, best: false },
      ],
    });
    expect(advice.map((a) => [a.kind, a.title])).toEqual([["boot", "Booting: 8 min, $0.08"], ["gpu", "Wan · Motion on the A40 is your cheapest so far"]]);
    expect(advice[0]!.why).toBe("Each deploy boots 3–5 min. Deploying fewer, longer sessions (queue the batch first) boots less.");
  });
});

describe("the advice on boots", () => {
  const where = (pull: number, packs: number) => ({
    ms: { render: 60 * MIN, boot: 20 * MIN, fetch: 0, outside: 0, idle: 0, failed: 0 }, usd: { render: 0.6, boot: 0.2, fetch: 0, outside: 0, idle: 0, failed: 0 },
    boot: { ms: { pull: pull * MIN, packs: packs * MIN, comfy: (20 - pull - packs) * MIN, startFailed: 0, boot: 0 }, usd: { pull: pull / 100, packs: packs / 100, comfy: (20 - pull - packs) / 100, startFailed: 0, boot: 0 } },
  });
  const ask = (w: ReturnType<typeof where>, boots: Array<{ pullMs: number | null; packs: string[]; packsKnown: boolean }>) => adviceOf({ where: w, tails: [], fetched: [], bootsSeen: [], boots, rows: [], sessions: 1 });

  it("the image pulls, when a boot spent over 5 min pulling", () => {
    const boots = [{ pullMs: 9 * MIN, packs: [], packsKnown: false }, { pullMs: 30_000, packs: [], packsKnown: false }, { pullMs: null, packs: [], packsKnown: false }];
    expect(ask(where(10, 0), boots)).toEqual([{ kind: "pull", title: "Image pulls: 10 min, $0.10", why: "1 of 2 boots spent over 5 min pulling the image: a host new to it pulls it first, billed while it comes. A host that has it starts in seconds.", save: null }]);
    // short pulls only: nothing to say
    expect(ask(where(1, 0), [boots[1]!])).toEqual([]);
  });

  it("the node packs' installs above a few cents, naming the packs installed on most deploys", () => {
    const boots = [
      { pullMs: 0, packs: ["ComfyUI-KJNodes", "was-node-suite"], packsKnown: true },
      { pullMs: 0, packs: ["ComfyUI-KJNodes"], packsKnown: true },
      { pullMs: 0, packs: ["ComfyUI-KJNodes", "was-node-suite", "rgthree"], packsKnown: true },
      { pullMs: 0, packs: [], packsKnown: false },
    ];
    const [packs] = ask(where(0, 6), boots);
    expect(packs).toEqual({ kind: "packs", title: "Node pack installs: 6 min, $0.06", why: "ComfyUI-KJNodes and was-node-suite are installed on most of your 3 deploys: the packs on the volume get their Python packages at every start. A pack you no longer use, taken off the volume, stops costing it.", save: null });
    expect(ask(where(0, 6), boots.slice(1, 2))[0]!.why).toMatch(/^ComfyUI-KJNodes is installed on your deploy:/);
    expect(ask(where(0, 6), boots.slice(0, 2))[0]!.why).toMatch(/^ComfyUI-KJNodes is installed on both of your deploys:/);
    // a few seconds of them: no advice
    expect(ask(where(0, 4), boots)).toEqual([]);
  });
});

describe("power", () => {
  it("each reading held until the next, over the render's own stretch", () => {
    // 200 W for 10 s, then 300 W for 10 s: 2500 J over 20 s
    const r = energyOf([{ at: 0, watts: 200 }, { at: 10_000, watts: 300 }], 0, 20_000)!;
    expect(r.avgW).toBe(250);
    expect(r.wh).toBeCloseTo(5000 / 3600, 9);
    // a first reading two seconds in: its mean taken over the whole of it
    expect(energyOf([{ at: 2_000, watts: 100 }], 0, 10_000)).toEqual({ wh: 1000 / 3600, avgW: 100 });
    expect(energyOf([], 0, 10_000)).toBeNull();
    const log = new PowerLog();
    log.add(150, 1_000);
    log.add(150, 2_000);
    expect(log.energy(5_000, 8_000)).toEqual({ wh: (150 * 3) / 3600, avgW: 150 });
    expect(log.energy(500_000, 600_000)).toBeNull();
  });
});

// ---------------------------------------------------------------- the whole of it, on rows as the server writes them

let db: Db;
const registry = { recipe: () => undefined, family: () => undefined } as unknown as Registry;
const NOW = Date.parse("2026-10-14T23:00:00.000Z");
const T0 = NOW - 3 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();
let n = 0;

const render = (machine: string, end: number, ms: number, over: Record<string, unknown> = {}) => ({
  id: `r${n++}`, owner_id: "local", recipe_id: "scail.motion", family: "scail", model: "scail", model_file: "scail.safetensors", time_key: "", kind: "video" as const, width: 832, height: 480, duration_ms: 5000,
  steps: 6, status: "done" as const, whole: 1, cold: 0, waited_ms: 0, total_ms: ms, load_ms: 0, sample_ms: ms, refine_ms: 0, finish_ms: 0, step_ms: null, expected_ms: null, vram_peak: null, heat_peak: null,
  asset_id: null, created_at: iso(end), work: null, machine_id: machine, gpu: null, node_ms: null, energy_wh: null, power_avg_w: null, ...over,
});
const jobRow = (id: string, over: Record<string, unknown>) => ({ id, owner_id: "local", recipe_id: "scail.motion", label: "x", inputs: "{}", status: "done", priority: 0, created_at: iso(T0), updated_at: iso(T0), ...over });

async function seed(): Promise<void> {
  await db.insertInto("projects").values({ id: "p1", owner_id: "local", name: "Dev", folder_id: null, archived_at: null, created_at: iso(T0), updated_at: iso(T0) }).execute();
  await db.insertInto("projects").values({ id: "p2", owner_id: "local", name: "Shorts", folder_id: null, archived_at: null, created_at: iso(T0), updated_at: iso(T0) }).execute();
  await db.insertInto("timelines").values({ id: "t1", owner_id: "local", name: "Timeline 1", width: 832, height: 480, created_at: iso(T0), updated_at: iso(T0), project_id: "p1" } as never).execute();
  await db.insertInto("clips").values({ id: "c1", timeline_id: "t1", position: 0, joined: "cut", inputs: "{}", created_at: iso(T0), updated_at: iso(T0) } as never).execute();
  await db.insertInto("drafts").values({ id: "d1", owner_id: "local", target: "image", recipe_id: "qwen.picture", title: "Picture for Timeline 1", forms: "{}", count: 1, created_at: iso(T0), updated_at: iso(T0), project_id: "p1" } as never).execute();
  await db.insertInto("drafts").values({ id: "d2", owner_id: "local", target: "image", recipe_id: "sdxl.text-to-picture", title: "zz-test hunt", forms: "{}", count: 1, created_at: iso(T0), updated_at: iso(T0), project_id: null } as never).execute();
  // a session kept whole (0071): its GPU, its first answer, its idle; a file, three renders (one failed)
  await db.insertInto("rent_sessions").values({ id: "s1", machine_id: "rp-a", pod: "a", rate: 0.6, started_at: iso(T0), ended_at: iso(T0 + 60 * MIN), seen_at: iso(T0 + 60 * MIN), gpu: "NVIDIA A40", up_at: iso(T0 + 4 * MIN), idle_minutes: 10 }).execute();
  await db.insertInto("pod_fetches").values({ id: "f1", machine_id: "rp-a", file: "diffusion_models/wan.safetensors", folder: "diffusion_models", via: "hf", bytes: 26e9, started_at: iso(T0 + 4 * MIN), ended_at: iso(T0 + 10 * MIN) }).execute();
  const a = render("rp-a", T0 + 20 * MIN, 10 * MIN);
  const b = render("rp-a", T0 + 25 * MIN, 3 * MIN, { status: "failed" });
  const c = render("rp-a", T0 + 50 * MIN, 20 * MIN, { recipe_id: "sdxl.text-to-picture", model_file: "sdxl.safetensors" });
  // a second session on another pod, the same file fetched again
  await db.insertInto("rent_sessions").values({ id: "s2", machine_id: "rp-b", pod: "b", rate: 0.6, started_at: iso(T0 + 90 * MIN), ended_at: iso(T0 + 120 * MIN), seen_at: null, gpu: "NVIDIA A40", up_at: iso(T0 + 93 * MIN), idle_minutes: 10 }).execute();
  await db.insertInto("pod_fetches").values({ id: "f2", machine_id: "rp-b", file: "diffusion_models/wan.safetensors", folder: "diffusion_models", via: "hf", bytes: 26e9, started_at: iso(T0 + 93 * MIN), ended_at: iso(T0 + 97 * MIN) }).execute();
  const d = render("rp-b", T0 + 107 * MIN, 10 * MIN);
  // this PC: two renders with their energy read, one without
  const h1 = render("m1", T0 + 30 * MIN, 5 * MIN, { energy_wh: 25, power_avg_w: 300 });
  const h2 = render("m1", T0 + 40 * MIN, 5 * MIN, { energy_wh: 15, power_avg_w: 180 });
  const h3 = render("m1", T0 + 45 * MIN, 5 * MIN);
  await db.insertInto("render_stats").values([a, b, c, d, h1, h2, h3]).execute();
  await db.insertInto("jobs").values([jobRow(a.id, { clip_id: "c1", machine_id: "rp-a" }), jobRow(b.id, { draft_id: "d1", machine_id: "rp-a", status: "failed" }), jobRow(c.id, { draft_id: "d2", machine_id: "rp-a" }), jobRow(d.id, { timeline_id: "t1", machine_id: "rp-b" })] as never).execute();
}

async function view(over: { price?: number | null; offers?: RankOffer[]; spending?: Spending; billedIn?: CostsDeps["billedIn"] } = {}): Promise<CostsView> {
  const settings = await readSettings(db);
  const costBetween = async (from: number, to: number) => {
    const rows = await db.selectFrom("rent_sessions").selectAll().execute();
    return rows.reduce((s, r) => s + Math.max(0, Math.min(to, Date.parse(r.ended_at ?? iso(NOW))) - Math.max(from, Date.parse(r.started_at))) / HOUR * r.rate, 0);
  };
  return costs({ db, registry, settings: { ...settings, costs: { kwhPrice: over.price ?? null, currency: "€" } }, spending: over.spending ?? null, billReadAt: null, costBetween, billedIn: over.billedIn, offers: async () => over.offers ?? null }, { from: T0 - HOUR, to: NOW }, NOW);
}

describe("the costs of a window", () => {
  beforeEach(async () => {
    db = openSqlite(":memory:");
    await migrate(db);
    await seed();
  });
  afterEach(async () => {
    await db.destroy();
  });

  it("each session adds up to its length and its cost; the window's parts to the sessions'", async () => {
    const v = await view();
    const [s2, s1] = v.sessions;
    expect(s1!.parts).toEqual({ boot: 4 * MIN, fetch: 6 * MIN, render: 30 * MIN, failed: 3 * MIN, outside: 0, idle: 17 * MIN });
    expect(sum(s1!.parts)).toBe(60 * MIN);
    expect(s1!.usd).toBeCloseTo(0.6, 9);
    expect(PARTS.reduce((n, p) => n + (s1!.parts[p] / HOUR) * s1!.rate, 0)).toBeCloseTo(s1!.usd, 9);
    expect(s2!.parts).toEqual({ boot: 3 * MIN, fetch: 4 * MIN, render: 10 * MIN, failed: 0, outside: 0, idle: 13 * MIN });
    expect(s1).toMatchObject({ gpu: "A40", estimated: [], fetched: { files: 1, bytes: 26e9 }, why: "zz-test hunt · 3 renders, 1 failed" });
    expect(sum(v.where.ms)).toBe(90 * MIN);
    expect(PARTS.reduce((n, p) => n + v.where.usd[p], 0)).toBeCloseTo(0.9, 9);
    // spent per stretch, by GPU, as much as the sessions
    expect(v.spend.gpus).toEqual(["A40"]);
    expect(v.spend.values[0]!.reduce((n, x) => n + x, 0)).toBeCloseTo(0.9, 9);
  });

  it("work from outside Afflatus kept on a session: taken out of its idle, never its render's; still adding up, and not idle in the advice", async () => {
    // s2: up at 93, its file 93–97, its render 97–107, idle to its end at 120. Outside work 100–112 (its render keeps 100–107),
    // and 116 on, left open (Afflatus stopped) and last seen past the session's end: cut at 120. Another session's is not its
    await db.insertInto("pod_outside").values([
      { id: "o1", session_id: "s2", machine_id: "rp-b", started_at: iso(T0 + 100 * MIN), seen_at: iso(T0 + 112 * MIN), ended_at: iso(T0 + 112 * MIN) },
      { id: "o2", session_id: "s2", machine_id: "rp-b", started_at: iso(T0 + 116 * MIN), seen_at: iso(T0 + 125 * MIN), ended_at: null },
      { id: "o3", session_id: "gone", machine_id: "rp-b", started_at: iso(T0 + 100 * MIN), seen_at: iso(T0 + 120 * MIN), ended_at: iso(T0 + 120 * MIN) },
    ]).execute();
    const v = await view();
    const [s2, s1] = v.sessions;
    expect(s2!.parts).toEqual({ boot: 3 * MIN, fetch: 4 * MIN, render: 10 * MIN, failed: 0, outside: 9 * MIN, idle: 4 * MIN });
    expect(sum(s2!.parts)).toBe(30 * MIN);
    expect(PARTS.reduce((n, p) => n + (s2!.parts[p] / HOUR) * s2!.rate, 0)).toBeCloseTo(s2!.usd, 12);
    // the session kept none: as it was
    expect(s1!.parts).toMatchObject({ outside: 0, idle: 17 * MIN });
    expect(v.where.ms).toMatchObject({ outside: 9 * MIN, idle: 21 * MIN });
    expect(sum(v.where.ms)).toBe(90 * MIN);
    expect(v.where.usd.outside).toBeCloseTo((9 / 60) * 0.6, 12);
    expect(PARTS.reduce((n, p) => n + v.where.usd[p], 0)).toBeCloseTo(0.9, 9);
    // the idle said is the idle left; s2 ended at work from outside, not idle: only s1's 10 min at its end weigh a shorter idle
    const idle = v.advice.find((a) => a.kind === "idle")!;
    expect(idle.title).toBe("Idle: 21 min, $0.21");
    expect(idle.save).toBeCloseTo((5 / 60) * 0.6, 9);
    // a deploy's usual idle at its end: s2 had none
    expect(await deployOverhead(db, NOW)).toMatchObject({ idleMs: 5 * MIN });
  });

  it("a deploy's own cost, as the Hunt says it beside a render's: the usual boot and idle at the end of the sessions that ended", async () => {
    // s1 booted 4 min, fetched 6 and idled 10 at its end, s2 3, 4 and 13: the middle of each, the mean of the two middle
    // ones of an even count; a session still open says nothing of its end yet
    await db.insertInto("rent_sessions").values({ id: "s3", machine_id: "rp-c", pod: "c", rate: 0.6, started_at: iso(NOW - 30 * MIN), ended_at: null, seen_at: null, gpu: "NVIDIA A40", up_at: iso(NOW - 2 * MIN), idle_minutes: 10 }).execute();
    expect(await deployOverhead(db, NOW)).toEqual({ bootMs: 3.5 * MIN, idleMs: 11.5 * MIN, fetchMs: 5 * MIN, sessions: 2 });
    // a deploy with a network volume keeps its files: no fetch
    expect(await deployOverhead(db, NOW, { volume: true })).toMatchObject({ fetchMs: 0 });
    await db.deleteFrom("rent_sessions").execute();
    expect(await deployOverhead(db, NOW)).toBeNull();
  });

  it("the renders on pods by project: a timeline's clip and a draft in it, a draft in none in the Inbox", async () => {
    const v = await view();
    const dev = v.projects.find((p) => p.id === "p1")!;
    // the clip's render (10 min) and the timeline's (10 min), and the failed draft's (3 min), at $0.60/h
    expect(dev).toMatchObject({ name: "Dev", renders: 3, timelines: 1, drafts: 1 });
    expect(dev.usd).toBeCloseTo((23 / 60) * 0.6, 9);
    expect(dev.items.map((i) => [i.kind, i.name, i.renders])).toEqual([["timeline", "Timeline 1", 2], ["draft", "Picture for Timeline 1", 1]]);
    const inbox = v.projects.find((p) => p.id === null)!;
    expect(inbox).toMatchObject({ name: "Inbox", renders: 1, items: [{ kind: "draft", id: "d2", name: "zz-test hunt" }] });
    expect(inbox.usd).toBeCloseTo((20 / 60) * 0.6, 9);
    // a project with nothing on a pod is listed after, at nothing
    expect(v.projects.at(-1)).toMatchObject({ id: "p2", usd: 0, renders: 0 });
  });

  it("a render's cost where it ran, this PC's electricity, and the advice from the sessions", async () => {
    const v = await view({ price: 0.25 });
    const scail = v.renderCosts.filter((r) => r.key === "scail.motion\nscail.safetensors");
    expect(scail.map((r) => [r.where, r.on, r.renders, r.best])).toEqual([["pod", "A40", 2, true], ["home", "This PC", 3, false]]);
    expect(scail[0]!.usd).toBeCloseTo((10 / 60) * 0.6, 9);
    // the p50 energy of the renders read (25 and 15 Wh: 20, the mean of the two middle ones), at €0.25 a kWh
    expect(scail[1]).toMatchObject({ wh: 20, local: 0.005 });
    expect(v.home).toEqual([{ machine: "m1", name: "This PC", gpu: "GPU", renders: 3, read: 2, wh: 40, avgW: 240, cost: 0.01 }]);
    expect(v.kwh).toEqual({ price: 0.25, currency: "€" });
    expect(v.advice.map((a) => a.kind)).toEqual(["idle", "fetch"]);
    // the two sessions ended idle 10 and 13 min: at 5 min, 5 and 8 min less at $0.60/h
    expect(v.advice[0]!.save).toBeCloseTo((13 / 60) * 0.6, 9);
    expect(v.advice[1]!.why).toMatch(/^wan's 26\.0 GB came twice\. A 30 GB volume \(\$2\.10\/month\)/);
  });

  // RunPod's spending as rented.ts says it: this month's bill $1.30 against the sessions' $0.90 counted
  const spending: Spending = {
    today: 0.9, month: 1.3, caps: { day: 2, month: 0 }, balance: 20, lowBalance: false, spendPerHr: 0.62, runwayMs: 20 / 0.62 * HOUR, billed: true,
    perDay: { pods: 0.9 / 7, storage: 0.5 }, runwayDays: 20 / (0.9 / 7 + 0.5),
    storage: { volumesMonth: 0.2, disksMonth: 0.1, perMonth: 15, nowMonth: 15, volumes: 1, stoppedDisks: 1, unused: [] },
  };

  it("says the month's bill beyond the count as not split, and the runway and month end with storage, as Settings does", async () => {
    const v = await view({ spending });
    expect(v.month).toBe(1.3);
    // the two sessions, $0.90 counted: $0.40 billed beyond them (disks, pods not in Afflatus, rounding)
    expect(v.notSplit).toBeCloseTo(0.4, 9);
    // the same pace and runway as rented.ts gives Settings: the pods' 7 days and storage a day
    expect(v.pace7).toBe(0.9 / 7);
    expect(v.storageDay).toBe(0.5);
    expect(v.runwayDays).toBe(spending.runwayDays);
    expect(v).toMatchObject({ spendPerHr: 0.62, runwayNowMs: spending.runwayMs });
    const d = new Date(NOW);
    const left = (new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime() - NOW) / 86_400_000;
    expect(v.monthEnd).toBeCloseTo(1.3 + 0.2 + (0.9 / 7 + 0.5) * left, 9);
  });

  it("stands a stretch of the chart at RunPod's bill: what it billed beyond the count is drawn as not split", async () => {
    const plain = await view({ spending: { ...spending, billed: true } });
    const counted = plain.times.map((_t, i) => plain.spend.values.reduce((n, v) => n + v[i]!, 0));
    const k = counted.findIndex((x) => x > 0);
    // the bill of that stretch $0.25 over the count; another under it (its last hours not written yet); the rest not read
    const v = await view({ spending, billedIn: async (times) => times.map((_t, i) => (i === k ? counted[i]! + 0.25 : i === k + 1 ? 0 : null)) });
    expect(v.spend.gpus).toEqual(["A40", NOT_SPLIT]);
    expect(v.spend.values[1]![k]).toBeCloseTo(0.25, 9);
    expect(v.spend.values[1]!.reduce((n, x) => n + x, 0)).toBeCloseTo(0.25, 9);
    // nothing beyond the count: no such series
    expect((await view({ spending, billedIn: async (times) => times.map((_t, i) => counted[i]!) })).spend.gpus).toEqual(["A40"]);
  });

  it("counts a render as a pod's only within a run of its machine", async () => {
    // rp-a rendered before its first session: a home machine of that id then, not the pod
    await db.insertInto("render_stats").values(render("rp-a", T0 - 10 * MIN, 5 * MIN, { energy_wh: 10 })).execute();
    const v = await view({ price: 0.25 });
    expect(v.home.map((h) => [h.machine, h.renders]).sort()).toEqual([["m1", 3], ["rp-a", 1]]);
    expect(v.renderCosts.filter((r) => r.where === "pod" && r.key === "scail.motion\nscail.safetensors").map((r) => r.renders)).toEqual([2]);
  });

  it("a GPU not tried yet, guessed from the model's own p50 by the hunt's table of speeds, marked a guess", async () => {
    const offer = (name: string, price: number): RankOffer => ({ id: `NVIDIA ${name}`, name, memory: 48, price, availability: "HIGH", dataCenters: [] });
    const v = await view({ offers: [offer("A40", 0.6), offer("RTX 4090", 0.69)] });
    const rows = v.renderCosts.filter((r) => r.key === "scail.motion\nscail.safetensors" && r.where !== "home");
    // the 4090 at about 0.45 of the A40's time (the table's 0.45 against 1): 4.5 min at $0.69/h
    expect(rows.map((r) => [r.where, r.on])).toEqual([["pod", "A40"], ["guess", "RTX 4090"]]);
    expect(rows[1]!.ms).toBe(270_000);
    expect(rows[1]!.usd).toBeCloseTo((270 / 3600) * 0.69, 6);
    expect(v.advice.find((a) => a.kind === "gpu")?.title).toBe("scail.motion may cost less on an RTX 4090");
  });

  it("without a price this PC's energy alone; without a reading, nothing", async () => {
    const v = await view();
    expect(v.home[0]).toMatchObject({ wh: 40, cost: null });
    await db.updateTable("render_stats").set({ energy_wh: null, power_avg_w: null }).execute();
    expect((await view({ price: 0.25 })).home[0]).toMatchObject({ read: 0, wh: 0, avgW: null, cost: null });
  });

  it("a boot kept in parts and a failed start: each session's parts and its boot's add up to its length and its cost", async () => {
    // s3: pulled 6 min, its node packs 2 min (one pack 90 s), ComfyUI up 1 min after; s4: its start failed after 3 min of pull
    await db.insertInto("rent_sessions").values([
      { id: "s3", machine_id: "rp-c", pod: "c", rate: 0.74, started_at: iso(T0 + 130 * MIN), ended_at: iso(T0 + 150 * MIN), seen_at: null, gpu: "NVIDIA L40S", up_at: iso(T0 + 139 * MIN), idle_minutes: 10, pulled_at: iso(T0 + 136 * MIN), packs_from: iso(T0 + 136.5 * MIN), packs_to: iso(T0 + 138.5 * MIN), boot_packs: JSON.stringify([{ pack: "ComfyUI-KJNodes", ms: 90_000 }]) },
      { id: "s4", machine_id: "rp-d", pod: "d", rate: 0.31, started_at: iso(T0 + 155 * MIN), ended_at: iso(T0 + 162.25 * MIN), seen_at: null, gpu: "NVIDIA A40", up_at: null, idle_minutes: 10, pulled_at: iso(T0 + 158 * MIN), start_failed: "putting in the node packs (exit 1)" },
    ]).execute();
    const v = await view({});
    const s3 = v.sessions.find((s) => s.id === "s3")!;
    expect(s3.boot).toEqual({ pull: 6 * MIN, packs: 2 * MIN, comfy: 1 * MIN, startFailed: 0, boot: 0 });
    expect(bootSum(s3.boot)).toBe(s3.parts.boot);
    expect(sum(s3.parts)).toBe(20 * MIN);
    expect(s3.packs).toEqual([{ pack: "ComfyUI-KJNodes", ms: 90_000 }]);
    const s4 = v.sessions.find((s) => s.id === "s4")!;
    expect(s4).toMatchObject({ startFailed: "putting in the node packs (exit 1)", estimated: [], parts: { boot: 7.25 * MIN, render: 0, fetch: 0, idle: 0, failed: 0 } });
    expect(s4.boot).toEqual({ pull: 3 * MIN, packs: 0, comfy: 0, startFailed: 4.25 * MIN, boot: 0 });
    // the sessions before 0076: their boot plain
    const s1 = v.sessions.find((s) => s.id === "s1")!;
    expect(s1.boot).toEqual({ pull: 0, packs: 0, comfy: 0, startFailed: 0, boot: 4 * MIN });
    // each one's cost, part by part, is its length at its rate
    for (const s of v.sessions) {
      expect(sum(s.parts)).toBe(s.to - s.from);
      expect(bootSum(s.boot)).toBe(s.parts.boot);
      const parts = PARTS.filter((p) => p !== "boot").reduce((n, p) => n + (s.parts[p] / HOUR) * s.rate, 0) + BOOT_PARTS.reduce((n, p) => n + (s.boot[p] / HOUR) * s.rate, 0);
      expect(parts).toBeCloseTo(s.usd, 12);
    }
    // the window's Booting by part: its parts' ms and money add up to it
    expect(bootSum(v.where.boot.ms)).toBe(v.where.ms.boot);
    expect(v.where.boot.ms).toEqual({ pull: 9 * MIN, packs: 2 * MIN, comfy: 1 * MIN, startFailed: 4.25 * MIN, boot: 7 * MIN });
    expect(BOOT_PARTS.reduce((n, p) => n + v.where.boot.usd[p], 0)).toBeCloseTo(v.where.usd.boot, 12);
    expect(v.where.boot.usd.pull).toBeCloseTo((6 / 60) * 0.74 + (3 / 60) * 0.31, 12);
    expect(PARTS.reduce((n, p) => n + v.where.usd[p], 0)).toBeCloseTo(0.9 + (20 / 60) * 0.74 + (7.25 / 60) * 0.31, 12);
    // the pull over 5 min said in the advice
    expect(v.advice.find((a) => a.kind === "pull")?.why).toMatch(/^1 of 2 boots spent over 5 min pulling the image/);
  });

  it("an older session (no first answer kept) is split from its boot measure and its files' speeds, said estimated", async () => {
    await db.insertInto("rent_sessions").values({ id: "s0", machine_id: "rp-c", pod: "c", rate: 0.24, started_at: iso(T0 - 30 * MIN), ended_at: iso(T0 - 10 * MIN), seen_at: null, gpu: null, up_at: null, idle_minutes: null }).execute();
    await db.insertInto("pod_measures").values([
      { id: "m1", kind: "boot", cloud: "SECURE", bytes: 0, ms: 4 * MIN, at: iso(T0 - 26 * MIN) },
      { id: "m2", kind: "civitai", cloud: "SECURE", bytes: 6.9e9, ms: 2 * MIN, at: iso(T0 - 23 * MIN) },
    ]).execute();
    const s0 = (await view()).sessions.find((s) => s.id === "s0")!;
    expect(s0.parts).toEqual({ boot: 4 * MIN, fetch: 2 * MIN, render: 0, failed: 0, outside: 0, idle: 14 * MIN });
    expect(s0.estimated).toEqual(["its files, from their speeds (files over 100 MB only)"]);
    expect(s0.why).toBe("no render");
  });

  it("a newer session without its first answer kept never takes another pod's boot measure as its boot's end", async () => {
    // s5 ran after 0071 (its idle minutes kept) but its first answer was not (Afflatus restarted mid-run); the boot measure in
    // its time is another pod's deploy, as pod_measures keeps no machine
    await db.insertInto("rent_sessions").values({ id: "s5", machine_id: "rp-e", pod: "e", rate: 0.24, started_at: iso(T0 - 30 * MIN), ended_at: iso(T0 - 10 * MIN), seen_at: null, gpu: "NVIDIA A40", up_at: null, idle_minutes: 10 }).execute();
    await db.insertInto("pod_measures").values({ id: "m1", kind: "boot", cloud: "SECURE", bytes: 0, ms: 4 * MIN, at: iso(T0 - 22 * MIN) }).execute();
    const s5 = (await view()).sessions.find((s) => s.id === "s5")!;
    // its boot from the usual boot here (that measure's 4 min), not ended at the measure's time (8 min in)
    expect(s5.estimated).toContain("its boot, from the usual boot here");
    expect(s5.parts.boot).toBe(4 * MIN);
  });
});

// ---------------------------------------------------------------- the power a render of this PC drew, through the queue

describe("a render's energy", () => {
  let fake: FakeComfy;
  let t: TestApp;
  beforeEach(async () => {
    fake = await makeFake();
    t = await makeApp({ comfyUrl: fake.url });
    await t.services.queue.start();
  });
  afterEach(async () => {
    await t.close();
    await fake.close().catch(() => {});
  });

  const rendered = async () => {
    const before = fake.prompts.size;
    const id = (await post(t.app, "/api/jobs", job())).json().ids[0] as string;
    await until(() => fake.prompts.size === before + 1);
    // the reading the open pages' 2 s load (or its progress) takes on the way
    const comfy = (await t.services.machines())[0]!.comfy;
    await comfy.readPower();
    await new Promise((r) => setTimeout(r, 150));
    complete(fake, [...fake.prompts.keys()].at(-1)!);
    await until(async () => (await t.db.selectFrom("jobs").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status === "done");
    await t.services.queue.idle();
    return t.db.selectFrom("render_stats").select(["energy_wh", "power_avg_w", "total_ms"]).where("id", "=", id).executeTakeFirstOrThrow();
  };

  it("is read from the node pack while it renders, and kept with its record", async () => {
    fake.watts = 250;
    const r = await rendered();
    expect(fake.calls.filter((c) => c === "GET /afflatus/power").length).toBeGreaterThan(0);
    expect(r.power_avg_w).toBe(250);
    expect(r.energy_wh).toBeCloseTo((250 * r.total_ms) / HOUR, 2);
  });

  it("is null without the power route (an older pack), which is then not asked again for a while", async () => {
    const r = await rendered();
    expect(r).toMatchObject({ energy_wh: null, power_avg_w: null });
    const asked = fake.calls.filter((c) => c === "GET /afflatus/power").length;
    expect(asked).toBe(1);
    await (await t.services.machines())[0]!.comfy.readPower();
    expect(fake.calls.filter((c) => c === "GET /afflatus/power").length).toBe(asked);
  });

  it("is null when the pack cannot read it (no NVML nor nvidia-smi)", async () => {
    fake.watts = null;
    expect(await rendered()).toMatchObject({ energy_wh: null, power_avg_w: null });
    expect(fake.calls).toContain("GET /afflatus/power");
  });

  it("the endpoint answers for the tab, with the price set in the settings", async () => {
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { costs: { kwhPrice: 0.25, currency: "€" } } });
    expect((await get(t.app, "/api/settings")).json().costs).toEqual({ kwhPrice: 0.25, currency: "€" });
    const res = await get(t.app, `/api/costs?from=${Date.now() - HOUR}&to=${Date.now()}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ runpod: false, sessions: [], projects: [], kwh: { price: 0.25, currency: "€" }, where: { ms: { render: 0, boot: 0, fetch: 0, idle: 0, failed: 0 } } });
    expect((await get(t.app, "/api/costs")).statusCode).toBe(200);
  });
});
