import { modelName, modelOf, type Recipe } from "@afflatus/core";
import type { Db } from "./db";
import { paceOf } from "./forecast";
import { lackOn, type Lack } from "./machineScans";
import type { PodFiles } from "./podFiles";
import { needsComfy } from "./queueOffline";
import type { Expected } from "./queueForecast";
import { CAP_REACHED, readJson, type JobRow, type Lane, type Running } from "./queueModel";
import { outsideBusy } from "./queueOutside";
import * as tools from "./queueTools";
import * as view from "./queueView";
import type { Registry } from "./registry";
import { runwayNeed } from "./rented";
import { plan, type Lane as Schedulable, type Planned, type Waiting } from "./schedule";
import { readSettings } from "./settings";
import { CUT_JOB, EXPORT_JOB } from "./timelineModel";

/**
 * The queue's plan (queue.ts): the machines as the scheduler reads them, the waiting jobs as it reads them, which machines
 * can run each, and the files a plan needs on rented pods. The worker asks it at each pass; it starts nothing itself.
 */

/** How long a running job has left, from what it was expected to take; null when that cannot be told. */
const remainingOf = (run: Running | null): number | null => (run?.expectedMs && run.startedAt ? Math.max(0, run.expectedMs - (Date.now() - run.startedAt)) : null);

/**
 * Of a waiting render, with several machines: the machines that can run it, and what keeps it off each of the others. A
 * rented pod that lacks only files it can be sent (`fetch`) is among the ones that can, with how long until they are there.
 */
export type Able = { can: Set<string>; lacks: Record<string, Lack>; fetch: Record<string, { files: Lack["files"]; packs?: string[]; ms: number }> };

/**
 * The model files a rented pod can be sent (podFiles.ts), as the queue reads them: a job that lacks only files on a pod may
 * still go there, once they came. Set by services.ts; null: no machine is ever sent a file.
 */
export interface PodFetch {
  /** Why these files (or node packs) cannot come to that machine: one of them failed there already. Null: they can. */
  failed(machine: string, files: Lack["files"], packs?: string[]): string | null;
  /** Why these files do not fit on that pod's disk, beside what it could delete when it makes room; null: they fit, or it is not known. */
  short(machine: string, files: Lack["files"]): Promise<string | null>;
  /** How long until these files (and node packs) are on that machine (ms): what is left of each, at the slow end of the speeds measured. */
  untilThere(machine: string, files: Lack["files"], packs?: string[]): Promise<number>;
  /** Have them sent: for a job that will run there ("need"), or for one that went elsewhere this time ("ahead": files only, never packs, which restart its ComfyUI). */
  want(machine: string, files: Lack["files"], tier: "need" | "ahead", job?: string, packs?: string[]): void;
  /** A job's files on that machine: all there, still coming, one failed (null: it asked for none). */
  jobState(machine: string, job: string): "ready" | "waiting" | "failed" | null;
  /** The machine's node packs wait for its ComfyUI to restart, or it restarts now: no job starts there meanwhile. */
  holding(machine: string): boolean;
  /** Files are coming to that machine now, their bytes moving: what holds a rented pod's idle time (podFiles.ts moving). */
  moving(machine: string): boolean;
}

/** A rented pod's files as the queue reads them, from podFiles.ts. */
export function podFetchOf(files: Pick<PodFiles, "failed" | "failedPacks" | "short" | "untilThere" | "want" | "wantPacks" | "jobState" | "holding" | "moving">): PodFetch {
  return {
    short: (machine, list) => files.short(machine, list),
    failed: (machine, list, packs = []) => list.map((f) => files.failed(machine, f.folder, f.file)).find((why) => why !== null) ?? files.failedPacks(machine, packs),
    untilThere: (machine, list, packs) => files.untilThere(machine, list, packs),
    want: (machine, list, tier, job, packs) => {
      files.want(machine, list, { tier, ...(job ? { job } : {}) });
      if (tier === "need" && job && packs?.length) files.wantPacks(machine, packs, job);
    },
    jobState: (machine, job) => files.jobState(machine, job)?.state ?? null,
    holding: (machine) => files.holding(machine),
    moving: (machine) => files.moving(machine),
  };
}

/** What the plan reads of the queue: its machines' lanes and the queue's own checks, read at each call (services.ts sets some after the queue is made). */
interface PlanDeps {
  db: Db;
  registry: Registry;
  machineLanes(): Lane[];
  lane(id: string): Lane | undefined;
  unavailable(machine: string): string | null;
  readonly podFetch: PodFetch | null;
  heldOn(r: JobRow): string | null;
  allPaused(): boolean;
  retryLater(): void;
  paces(): Promise<Map<string, number>>;
  expected(recipe: Recipe<any>, input: Record<string, unknown>, cold: boolean, job: Pick<JobRow, "finished_from" | "clip_id" | "clip_fit"> | null, machine: string | null): Promise<number | null>;
  expectedAll(recipe: Recipe<any>, input: Record<string, unknown>, cold: boolean, job: Pick<JobRow, "finished_from" | "clip_id" | "clip_fit"> | null): Promise<Expected>;
  fitsBalance(ms: number | null): { ok: boolean; leftMs: number | null };
  balanceNeed(machine: string, recipeId: string, renderMs: number, fetchMs: number): Promise<number>;
}

export class Planner {
  constructor(private readonly d: PlanDeps) {}

  /** The machines that may take work now, as the scheduler reads them: free in how long, what they hold, their learned pace. */
  async schedulable(open: Lane[]): Promise<Schedulable[]> {
    const paces = await this.d.paces();
    return Promise.all(open
      .filter((l) => l.reachable !== false && !this.d.unavailable(l.id))
      .map(async (l) => ({
        id: l.id, takes: l.machine!.takes,
        // busy with work from outside Afflatus: free at a time that cannot be told, so that a machine free now is planned first
        busyForMs: l.running || l.starting ? remainingOf(l.running) ?? (await this.untilEnd(l)) : outsideBusy(l) ? null : 0,
        holds: new Set(l.lastLoads ? l.lastLoads.split("|").map(modelName) : []),
        pace: paceOf(paces, l.id) ?? 1,
      })));
  }

  /**
   * How long a machine's job has left when it does not say yet: one being started or sent (its expected time comes back
   * with the prompt) is taken at its own forecast on that machine, as the waiting list has it, less what it ran; null when
   * nothing like it was rendered (then the machine is not waited for).
   */
  async untilEnd(lane: Lane): Promise<number | null> {
    const id = lane.running?.id ?? lane.starting;
    const row = id ? await this.d.db.selectFrom("jobs").selectAll().where("id", "=", id).executeTakeFirst() : undefined;
    const recipe = row && row.recipe_id !== CUT_JOB && row.recipe_id !== EXPORT_JOB ? this.d.registry.recipe(row.recipe_id) : undefined;
    if (!row || !recipe) return null;
    const input = readJson<Record<string, unknown>>(row.inputs, {});
    // a recipe that loads its model from its family's slot (SCAIL-2, the tools) names none on its form: the one its graph loads
    const model = modelOf(recipe.inputs, input) ?? (await this.d.expectedAll(recipe, input, false, row)).model;
    const held = new Set(lane.lastLoads ? lane.lastLoads.split("|").map(modelName) : []);
    const ms = await this.d.expected(recipe, input, Boolean(model && !held.has(model)), row, lane.id);
    if (ms === null) return null;
    const ran = lane.running?.startedAt ? Date.now() - lane.running.startedAt : 0;
    return Math.max(0, ms - ran);
  }

  /**
   * With several machines, the machines that can run each waiting render: its recipe ready there, its family on there, the
   * files it asks for listed there (machineScans.ts lackOn), and what keeps it off each of the others. A machine known to be
   * away, or whose scan cannot be read, is not held against a job. Nothing with one machine: it takes everything, as it always did.
   */
  async ableOf(rows: JobRow[]): Promise<Map<string, Able>> {
    const out = new Map<string, Able>();
    const lanes = this.d.machineLanes().filter((l) => l.machine && l.comfy);
    // one machine takes everything, unless it is a rented pod whose balance a job would outlast
    if ((lanes.length < 2 && !lanes.some((l) => l.machine!.rented)) || !rows.length) return out;
    const settings = await readSettings(this.d.db).catch(() => null);
    if (!settings) return out;
    const machines = new Map(settings.machines.map((m) => [m.id, m]));
    // a machine known to be away, or a rented pod not running, is not asked (a dead pod's address would hold the pass)
    const scans = await Promise.all(lanes.map(async (l) => ({ lane: l, scan: l.reachable === false || this.d.unavailable(l.id) ? null : await l.comfy!.scan().catch(() => null) })));
    const familyOf = (id: string) => this.d.registry.recipe(id)?.family;
    for (const r of rows) {
      const recipe = r.recipe_id === CUT_JOB || r.recipe_id === EXPORT_JOB ? undefined : this.d.registry.recipe(r.recipe_id);
      if (!recipe) continue;
      const input = readJson<Record<string, unknown>>(r.inputs, {});
      const can = new Set<string>();
      const lacks: Record<string, Lack> = {};
      const fetch: Able["fetch"] = {};
      // a job pinned to a machine (or held for the one it was lost on) runs nowhere else: no other pod is sent its files
      // (a job pinned to this PC had its 13 GB model fetched onto the pod, ahead of a render that could never come there)
      const pin = r.pin_machine ?? this.d.heldOn(r);
      // every machine of a job worked out at once (its balance, its files' time on a pod)
      await Promise.all(scans.map(async ({ lane, scan }) => {
        // a rented pod whose ComfyUI cannot be read now (booting, restarting for node packs, away) starts with nothing: what
        // it has is not known, so it is not given the job (a ComfyUI of the user's own is not held against a job for that)
        // A pod at a spending cap says so beside the job: it takes nothing new, and stops once its render ends
        if (lane.machine!.rented && !scan?.comfy.online) {
          // one that answers but whose scan did not (its node list too slow to come on a fresh pod) is read again soon:
          // nothing else would plan again while it answers, and it would idle toward its stop with its jobs waiting
          if (lane.reachable === true && !this.d.unavailable(lane.id)) this.d.retryLater();
          lacks[lane.id] = { off: false, files: [], sendable: false, why: this.d.unavailable(lane.id) === CAP_REACHED ? CAP_REACHED : "its ComfyUI is not answering yet" };
          return;
        }
        // a lone rented pod is asked too: what it lacks may be sent to it
        const lack = (lanes.length > 1 || lane.machine!.rented) && scan?.comfy.online ? lackOn(recipe, input, scan, settings, machines.get(lane.id) ?? lane.machine!, familyOf) : null;
        // a pod that lacks only files it can be sent: it can run the job once they came, their time to come part of what the
        // balance must last
        const fits = Boolean(lack?.sendable && lane.machine!.rented && this.d.podFetch && !this.d.podFetch.failed(lane.id, lack.files, lack.packs));
        // files that do not fit on its disk (beside what it could delete): the job goes elsewhere, and its row says why
        const short = fits ? await this.d.podFetch!.short(lane.id, lack!.files) : null;
        const sendable = fits && !short;
        const fetchMs = sendable ? await this.d.podFetch!.untilThere(lane.id, lack!.files, lack!.packs) : 0;
        const balance = await this.balanceLack(r, lane, fetchMs);
        if (lack && !balance && sendable) {
          can.add(lane.id);
          if (!pin || pin === lane.id) fetch[lane.id] = { files: lack.files, ...(lack.packs ? { packs: lack.packs } : {}), ms: fetchMs };
          return;
        }
        const failed = short ?? (lack?.sendable && lane.machine!.rented && this.d.podFetch ? this.d.podFetch.failed(lane.id, lack.files, lack.packs) : null);
        if (lack || balance) lacks[lane.id] = { ...(lack ?? { off: false, files: [], sendable: false }), ...(balance ? { balance } : {}), ...(failed ? { failed } : {}) };
        else can.add(lane.id);
      }));
      // a timeline clip of a model that joins in a kept latent (H3): on a machine that has the join's nodes (the Afflatus node
      // pack), while any has them. Sent elsewhere, the clip saves no latent and the clip after it joins on frames with no word
      const latentNodes = r.clip_id ? recipe.traits?.latentNodes : undefined;
      if (latentNodes?.length && can.size > 1) {
        const packed = new Set<string>();
        for (const id of can) {
          const lane = scans.find((s) => s.lane.id === id)?.lane;
          const catalog = lane ? await lane.comfy!.catalog().catch(() => null) : null;
          if (catalog && latentNodes.every((n) => n in catalog)) packed.add(id);
        }
        if (packed.size && packed.size < can.size) {
          for (const id of [...can]) {
            if (packed.has(id)) continue;
            can.delete(id);
            delete fetch[id];
            lacks[id] = { off: false, files: [], sendable: false, why: "its ComfyUI has no Afflatus node pack, which a timeline clip's joins in the latent take" };
          }
        }
      }
      out.set(r.id, { can, lacks, fetch });
    }
    return out;
  }

  /**
   * The waiting jobs as the scheduler reads them: what each makes, its pin, the machines that can run it, the job it waits
   * for, its model and its forecast with and without loading it. A finish on the GPU is priced from its route's own finishes
   * on each machine (queueView finishesOf), and frees the model before the render after it.
   */
  async planned(rows: JobRow[], able: ReadonlyMap<string, Able> = new Map()): Promise<Planned[]> {
    const paces = await this.d.paces();
    const finishes = await view.finishesOf(this.d.db, rows, this.d.machineLanes().map((l) => ({ id: l.id, pace: paces.get(l.id) ?? 1 })));
    return Promise.all(rows.map(async (r): Promise<Planned> => {
      const fetch = able.get(r.id)?.fetch ?? {};
      const fetchMs = Object.keys(fetch).length ? new Map(Object.entries(fetch).map(([lane, f]) => [lane, f.ms])) : undefined;
      const base = { id: r.id, makes: this.makes(r), pin: r.pin_machine ?? this.d.heldOn(r), can: able.get(r.id)?.can, ...(fetchMs ? { fetchMs } : {}), ...(r.depends_on ? { after: r.depends_on } : {}) };
      const recipe = r.recipe_id === CUT_JOB ? undefined : this.d.registry.recipe(r.recipe_id);
      const finish = finishes.get(r.id);
      if (!recipe) return { ...base, model: null, renderMs: finish?.ms ?? null, loadMs: null, ...(finish?.on.size ? { renderOn: finish.on } : {}), frees: r.recipe_id === CUT_JOB && tools.usesGpu(r) };
      const input = readJson<Record<string, unknown>>(r.inputs, {});
      const [warm, cold] = await Promise.all([this.d.expectedAll(recipe, input, false, r), this.d.expectedAll(recipe, input, true, r)]);
      // each machine's own figures when its renders (or its pace) say them: the scheduler reads those before the common one at its pace
      const loadOn = new Map([...warm.on].flatMap(([m, ms]) => (cold.on.has(m) ? [[m, Math.max(0, cold.on.get(m)! - ms)] as const] : [])));
      // loading ahead renders nothing: its cost is the load alone
      return {
        // the model its graph loads when its form names none (a recipe loading it from its family's slot): where it is held
        // is where it goes, as for any other model, and a machine holding another is not taken for warm
        ...base, model: modelOf(recipe.inputs, input) ?? warm.model, renderMs: r.warm ? 0 : warm.ms, loadMs: warm.ms !== null && cold.ms !== null ? Math.max(0, cold.ms - warm.ms) : null,
        ...(r.warm ? {} : { renderOn: warm.on }), loadOn,
      };
    }));
  }

  /** Where each waiting job will probably run and when it starts, as the screens show it: the plan of now, no machine asked again. */
  async forecastPlan(lanes: Lane[], rows: JobRow[], able: ReadonlyMap<string, Able>): Promise<Map<string, { lane: string; startsInMs: number; endsInMs: number }>> {
    return plan(await this.schedulable(lanes.filter((l) => !l.paused && l.machine)), await this.planned(rows.filter(needsComfy), able));
  }

  /** What a job makes, as a machine's "takes" reads it: a picture, or a video (a clip, a sound, a finish, a slow motion). */
  makes(r: JobRow): Waiting["makes"] {
    if (r.recipe_id === CUT_JOB || r.recipe_id === EXPORT_JOB) return "video";
    return this.d.registry.recipe(r.recipe_id)?.output === "image" ? "image" : "video";
  }

  /** How long a job would take on this machine, loading its model included, from its renders there or at its learned pace (ms); null: not known. */
  async lengthOn(r: JobRow, machine: string): Promise<number | null> {
    const recipe = r.recipe_id === CUT_JOB || r.recipe_id === EXPORT_JOB ? undefined : this.d.registry.recipe(r.recipe_id);
    if (!recipe) return null;
    return this.d.expected(recipe, readJson<Record<string, unknown>>(r.inputs, {}), true, r, machine);
  }

  /**
   * The files the plan needs on rented pods, asked for: a job planned onto a pod lacking only files has them sent there
   * first ("need"); one planned elsewhere has its files sent to the pods that lack them, for later ("ahead"). Nothing is
   * fetched that no waiting job asks for. A job pinned to a machine has none ahead elsewhere (ableOf), and a pod paused on
   * its own while others go (Use only this PC) gets files ahead only for a job pinned to it: what waits goes to the
   * others. With every machine paused (Pause all) each pod gets them, as the whole line waits for Resume.
   */
  sendFiles(rows: JobRow[], able: ReadonlyMap<string, Able>, where: ReadonlyMap<string, { lane: string }>): void {
    if (!this.d.podFetch) return;
    const all = this.d.allPaused();
    for (const r of rows) {
      const fetch = able.get(r.id)?.fetch ?? {};
      const on = where.get(r.id)?.lane;
      for (const [lane, f] of Object.entries(fetch)) {
        if (lane !== on && !all && this.d.lane(lane)?.paused && r.pin_machine !== lane) continue;
        this.d.podFetch.want(lane, f.files, lane === on ? "need" : "ahead", lane === on ? r.id : undefined, f.packs);
      }
    }
  }

  /** Whether a job planned onto this machine has its files there: always, unless it is a pod still getting them. */
  filesThere(r: JobRow, lane: Lane, able: ReadonlyMap<string, Able>): boolean {
    if (!able.get(r.id)?.fetch[lane.id]) return true;
    return this.d.podFetch?.jobState(lane.id, r.id) === "ready";
  }

  /**
   * What keeps a job off a rented pod for its balance: null when it ends there, its files fetched first, before the balance
   * does. A render with no forecast is weighed at a floor (rented.ts runwayNeed): left out, it went whatever the balance.
   */
  async balanceLack(r: JobRow, lane: Lane, fetchMs = 0): Promise<Lack["balance"] | null> {
    if (!lane.machine?.rented) return null;
    const render = await this.lengthOn(r, lane.id);
    const need = render === null ? runwayNeed({ renderMs: null, fetchMs, sure: false }) : await this.d.balanceNeed(lane.id, r.recipe_id, render, fetchMs);
    const fit = this.d.fitsBalance(need);
    return fit.ok || need === null || fit.leftMs === null ? null : { leftMs: fit.leftMs, needMs: need };
  }
}
