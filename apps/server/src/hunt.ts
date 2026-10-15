import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { fileKey, firstFree, plural, rankGpus, type HuntMode, type Learned, type PresetFile, type RankedGpu, type RankRender } from "@afflatus/core";
import { deployOverhead, type DeployOverhead } from "./costs";
import { deployFiles, deployModels } from "./deployModels";
import { httpError } from "./errors";
import { gpuPaces, rentedLoadMs } from "./forecast";
import { filesUsed } from "./machineScans";
import { dollars, took, type Say } from "./notifyWords";
import { readJson, type JobRow } from "./queueModel";
import { needsComfy } from "./queueOffline";
import { refusalOf } from "./rented";
import { OUT_OF_MEMORY } from "./rendersRead";
import { inUseSaid } from "./rentedVolumes";
import type { GpuOffer, PodSpec } from "./runpod";
import type { Services } from "./services";
import { deploySchema, MAX_MACHINES, readSettings } from "./settings";

/**
 * Hunt a GPU: when no GPU the user wants is free on RunPod, Afflatus asks RunPod's stock every 30 s and deploys the
 * best-ranked one the moment one is free, through the same deploy as the Deploy dialog's (rented.ts deploy: the caps, one
 * pod per volume, the Model set, the files and their licences apply as they do there). One hunt at a time, kept in the
 * settings table (a key the schema ignores, as the queue's notes) so that it carries on after a restart.
 *
 * It deploys once, and only while renders wait for it. Meanwhile the home machines either rest (paused on their own, a
 * render under way there finishing first, resumed when the hunt ends) or keep rendering. It gives up at its time, at a
 * spending cap or RunPod's balance, after three deploys in a row refused for another reason than the GPU being taken;
 * once its pod is up it ends when that pod stops or goes, and the machines it paused go on.
 */

const HUNT_KEY = "hunt";
/** How often RunPod's stock is asked while hunting. */
const EVERY_MS = 30_000;
/** A read of RunPod's GPUs this recent is taken again (the dialog's live ranking as the user types, a change of the hunt). */
const FRESH_MS = 20_000;
/** Deploys refused in a row, for another reason than the GPU taken, before the hunt gives up. */
const MAX_FAILS = 3;
/** The waiting renders the ranking is worked out from: the first of the line say enough. */
const RANKED_RENDERS = 40;

const choicesSchema = deploySchema.omit({ gpu: true });
const askSchema = z.strictObject({
  mode: z.enum(["value", "fast", "cheap"]).default("value"),
  ceiling: z.number().positive().max(1000),
  leftOut: z.array(z.string().max(120)).max(200).default([]),
  /** When it gives up, in minutes from its start: 10 min to 24 h. */
  giveUpMinutes: z.number().int().min(10).max(24 * 60).default(120),
  hold: z.enum(["rest", "keep"]).default("rest"),
  /** What the Deploy dialog sends to deploy, but the GPU, which the hunt picks. */
  deploy: choicesSchema.prefault({}),
});
// its own fields without the start's defaults: a field left out is kept as it is (with .partial() a default still filled
// it in, and a change of the hold alone set the GPUs left out back to none)
const changeSchema = z.strictObject({
  mode: z.enum(["value", "fast", "cheap"]).optional(),
  ceiling: z.number().positive().max(1000).optional(),
  leftOut: z.array(z.string().max(120)).max(200).optional(),
  giveUpMinutes: z.number().int().min(10).max(24 * 60).optional(),
  hold: z.enum(["rest", "keep"]).optional(),
});
const rankSchema = z.strictObject({
  mode: z.enum(["value", "fast", "cheap"]).default("value"),
  ceiling: z.number().positive().max(1000),
  leftOut: z.array(z.string().max(120)).max(200).default([]),
  cloud: z.enum(["SECURE", "COMMUNITY"]).default("SECURE"),
  volume: z.string().max(80).default(""),
});

const stateSchema = z.object({
  mode: z.enum(["value", "fast", "cheap"]),
  ceiling: z.number().positive(),
  leftOut: z.array(z.string()),
  cloud: z.enum(["SECURE", "COMMUNITY"]),
  /** The data center a network volume pins the pod to; null: any. */
  dataCenter: z.string().nullable(),
  deploy: choicesSchema,
  hold: z.enum(["rest", "keep"]),
  startedAt: z.string(),
  giveUpAt: z.string(),
  /** hunting: asking RunPod; deploying: a deploy under way; up: its pod deployed (the machine), followed until it stops. */
  status: z.enum(["hunting", "deploying", "up"]),
  machine: z.string().nullable(),
  /** The home machines this hunt paused (hold "rest"): those, and only those, are resumed when it ends. */
  pausedByHunt: z.array(z.string()),
  /** How many times RunPod's stock was asked. */
  asks: z.number().int(),
  /** Deploys refused in a row, for another reason than the GPU taken. */
  fails: z.number().int(),
  lastError: z.string().nullable(),
  /** When the deploy under way began: after a restart, the machine it made is looked for from then. */
  deployingSince: z.string().nullable(),
  /** The rented machines there were when the deploy under way began: after a restart, the one not among them is its pod. */
  before: z.array(z.string()).default([]),
  found: z.object({ gpu: z.string(), name: z.string(), price: z.number(), dataCenter: z.string().nullable(), at: z.string() }).nullable(),
});
export type HuntState = z.infer<typeof stateSchema>;

/** What the queue's status bar says of the hunt (queue.ts status). */
export interface HuntSummary {
  status: HuntState["status"];
  startedAt: string;
  giveUpAt: string;
  hold: HuntState["hold"];
  /** The renders waiting. */
  held: number;
  /** The best-ranked usable GPU, as last ranked; null before the first ask, or with none usable. */
  firstPick: { name: string; price: number } | null;
  machine: string | null;
}

type Cloud = PodSpec["cloud"];

export class Hunt {
  private state: HuntState | null = null;
  private ranking: RankedGpu[] | null = null;
  private askedAt: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<void> | null = null;
  private stopped = false;
  private readonly offersSeen = new Map<Cloud, { at: number; offers: GpuOffer[] }>();
  private volumesSeen: { at: number; volumes: Array<{ id: string; dataCenter: string }> } | null = null;
  private pausesLooked: Promise<void> | null = null;
  private pausesAgain = false;
  private watching: Promise<void> | null = null;
  everyMs = EVERY_MS;
  /** How recent a read of RunPod's GPUs is taken again (0 in the tests, which change the stock between rounds). */
  freshMs = FRESH_MS;
  now: () => number = Date.now;
  /** Where the user is told (notify.ts; set by services.ts): a GPU found, the hunt given up. */
  tell: Say | null = null;

  constructor(private readonly s: Services) {}

  /** Read the hunt kept from before, and follow it; a machine resumed by hand is let go, a pod's end is heard at once. */
  async run(): Promise<void> {
    await this.load();
    // a pod stopped or taken out is said by a "setup" (the machines changed) or a "queue" (its row changed)
    const pod = () => {
      if (this.state?.status !== "up" || this.watching) return;
      this.watching = this.watchPod().catch((err: Error) => console.warn(`[hunt] ${err.message}`)).finally(() => {
        this.watching = null;
      });
    };
    this.s.queue.events.on("queue", () => {
      this.lookAtPauses();
      pod();
    });
    this.s.queue.events.on("setup", pod);
    if (this.state) this.kick(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private kick(ms: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick().finally(() => {
        if (this.state) this.kick(this.everyMs);
      });
    }, ms);
    this.timer.unref?.();
  }

  private async load(): Promise<void> {
    const row = await this.s.db.selectFrom("settings").select("value").where("key", "=", HUNT_KEY).executeTakeFirst();
    if (!row) return;
    const parsed = stateSchema.safeParse(readJson<unknown>(row.value, null));
    if (!parsed.success) {
      if (row.value !== "null") console.warn("[hunt] the hunt kept from before could not be read: set aside");
      return;
    }
    const st = parsed.data;
    // stopped mid-deploy: the rented machine that was not there before it is its pod. None kept: the pod may still have been
    // made on RunPod before Afflatus stopped, so the hunt ends rather than deploying a second one (a pod billed unseen)
    if (st.status === "deploying") {
      const made = (await readSettings(this.s.db)).machines.find((m) => m.rented && !m.rented.fill && !st.before.includes(m.id));
      if (!made) {
        this.state = st;
        return this.end("Afflatus stopped while deploying a GPU: look on RunPod for a pod it may have made");
      }
      Object.assign(st, { status: "up", machine: made.id, deployingSince: null });
    }
    this.state = st;
    await this.save();
  }

  private async save(): Promise<void> {
    const value = JSON.stringify(this.state);
    const at = new Date(this.now()).toISOString();
    await this.s.db.insertInto("settings").values({ key: HUNT_KEY, value, updated_at: at }).onConflict((oc) => oc.column("key").doUpdateSet({ value, updated_at: at })).execute();
    this.s.queue.events.emit("queue");
  }

  // ---------------------------------------------------------------- what the routes and the status bar read

  view() {
    return { hunt: this.state, ranking: this.ranking, askedAt: this.askedAt === null ? null : new Date(this.askedAt).toISOString() };
  }

  summary(held: number): HuntSummary | null {
    const st = this.state;
    if (!st) return null;
    const pick = this.ranking?.find((g) => g.fit === "yes") ?? null;
    return { status: st.status, startedAt: st.startedAt, giveUpAt: st.giveUpAt, hold: st.hold, held, firstPick: pick ? { name: pick.name, price: pick.price } : null, machine: st.machine };
  }

  /** The renders a hunted pod would take: waiting, needing a ComfyUI, not pinned to a machine of their own. */
  private async held(): Promise<JobRow[]> {
    const rows = (await this.s.db.selectFrom("jobs").selectAll().where("status", "=", "queued").orderBy("priority").orderBy("created_at").execute()).filter(needsComfy);
    const machines = new Set((await readSettings(this.s.db)).machines.map((m) => m.id));
    return rows.filter((r) => !r.pin_machine || !machines.has(r.pin_machine));
  }

  /** RunPod's GPUs on that cloud, read again unless a read is this recent. */
  private async offers(cloud: Cloud): Promise<GpuOffer[]> {
    const seen = this.offersSeen.get(cloud);
    if (seen && this.now() - seen.at < this.freshMs) return seen.offers;
    const offers = await this.s.rented.gpus(cloud);
    this.offersSeen.set(cloud, { at: this.now(), offers });
    return offers;
  }

  /** RunPod's GPUs and prices on the secure cloud, as the hunt last read them (read again past FRESH_MS): the Costs tab's guesses. */
  async offersNow(): Promise<GpuOffer[]> {
    return this.offers("SECURE");
  }

  /** A volume's data center (the dialog's live ranking), from a read of the account's volumes this recent. */
  private async dataCenterOf(volume: string): Promise<string | null> {
    if (!volume) return null;
    if (!this.volumesSeen || this.now() - this.volumesSeen.at >= this.freshMs) this.volumesSeen = { at: this.now(), volumes: await this.s.rented.volumes() };
    const found = this.volumesSeen.volumes.find((v) => v.id === volume);
    if (!found) throw httpError("That network volume is not on this account any more: pick another, or hunt without one.", 409);
    return found.dataCenter;
  }

  /**
   * The waiting renders as the ranking reads them: their files with their sizes, and their forecast at the common pace with
   * its model's load apart, as the pods loaded the family's models (rentedLoadMs), else as the forecast has it.
   */
  private async renders(rows: JobRow[]): Promise<RankRender[]> {
    const scan = await (await this.s.comfy()).scan().catch(() => null);
    const loads = new Map<string, Promise<number | null>>();
    const loadOf = (family: string) => {
      if (!loads.has(family)) loads.set(family, rentedLoadMs(this.s.db, family).catch(() => null));
      return loads.get(family)!;
    };
    return Promise.all(rows.slice(0, RANKED_RENDERS).map(async (r) => {
      const recipe = this.s.registry.recipe(r.recipe_id);
      if (!recipe) return { files: [], ms: null };
      const slots = this.s.registry.family(recipe.family)?.slots ?? [];
      const used = filesUsed(recipe, readJson<Record<string, unknown>>(r.inputs, {}), scan, slots);
      const files = await Promise.all(used.map(async (f) => ({ file: f.file, size: (await this.s.podFiles.about(f).catch(() => null))?.size ?? null })));
      const f = await this.s.queue.forecastMs(r).catch(() => null);
      if (!f) return { files, ms: null };
      return { files, ms: f.ms - f.loadMs, loadMs: (await loadOf(recipe.family)) ?? f.loadMs };
    }));
  }

  /**
   * What the record of renders says of each GPU: its pace, the GPUs rendered on at all (one alone is the common pace), and
   * the files that ran out of memory on it; and what a deploy bills besides its renders, from the user's sessions.
   */
  private async learned(overhead: DeployOverhead | null): Promise<Learned> {
    const failed = await this.s.db
      .selectFrom("render_stats")
      .innerJoin("jobs", "jobs.id", "render_stats.id")
      .select(["render_stats.gpu", "render_stats.model_file", "jobs.error"])
      .where("render_stats.status", "=", "failed")
      .where("render_stats.gpu", "is not", null)
      .where("render_stats.model_file", "!=", "")
      .orderBy("render_stats.created_at", "desc")
      .limit(500)
      .execute();
    const oom = failed.filter((r) => OUT_OF_MEMORY.test(r.error ?? "")).map((r) => ({ gpu: r.gpu!, file: r.model_file }));
    const rendered = await this.s.db
      .selectFrom("render_stats")
      .select(["gpu", (eb) => eb.fn.countAll<number>().as("renders")])
      .where("status", "=", "done")
      .where("whole", "=", 1)
      .where("step_ms", "is not", null)
      .where("gpu", "is not", null)
      .groupBy("gpu")
      .execute();
    const rented = await this.s.db.selectFrom("rent_sessions").select("gpu").distinct().where("gpu", "is not", null).execute();
    return { gpus: await gpuPaces(this.s.db), rented: rented.map((r) => r.gpu!), oom, rendered: rendered.map((r) => ({ gpu: r.gpu!, renders: Number(r.renders) })), overheadMs: overhead ? overhead.bootMs + overhead.fetchMs + overhead.idleMs : null };
  }

  private async rank(offers: GpuOffer[], rows: JobRow[], o: { mode: HuntMode; ceiling: number; leftOut: string[]; dataCenter: string | null }): Promise<{ ranking: RankedGpu[]; overhead: DeployOverhead | null }> {
    // a pod pinned to a data center has a network volume there (dataCenterOf): its files are kept, not fetched at each deploy
    const overhead = await deployOverhead(this.s.db, this.now(), { volume: o.dataCenter !== null });
    const [renders, learned] = await Promise.all([this.renders(rows), this.learned(overhead)]);
    return { ranking: rankGpus(offers, renders, learned, o), overhead };
  }

  /**
   * The dialog's live ranking for its choices: no hunt needed; RunPod read again only past FRESH_MS. With it, what a
   * deploy bills besides its renders (the usual boot and idle of the user's sessions), said beside a render's cost.
   */
  async preview(asked: z.infer<typeof rankSchema>): Promise<{ ranking: RankedGpu[]; held: number; overhead: DeployOverhead | null }> {
    const [offers, dataCenter, rows] = await Promise.all([this.offers(asked.cloud), this.dataCenterOf(asked.volume), this.held()]);
    return { ...(await this.rank(offers, rows, { ...asked, dataCenter })), held: rows.length };
  }

  // ---------------------------------------------------------------- start, change, cancel

  async start(asked: z.infer<typeof askSchema>) {
    if (this.state) throw httpError("A GPU hunt is under way already: change it, or cancel it first.", 409);
    if (this.s.rented.busy) throw httpError("A deploy is under way: wait for it to end.", 409);
    const settings = await readSettings(this.s.db);
    if (!settings.runpodKey) throw httpError("No RunPod API key: set it in Settings › Rented GPUs.", 409);
    if (settings.machines.length >= MAX_MACHINES) throw httpError(`Afflatus keeps ${MAX_MACHINES} ComfyUIs at most: remove one to hunt a GPU.`, 409);
    if (await this.s.rented.capped()) throw httpError("A spending cap is reached: raise it in Settings › Rented GPUs to hunt a GPU.", 409);
    if (!(await this.held()).length) throw httpError("Nothing waits for a GPU: queue the renders first.", 409);
    let dataCenter: string | null = null;
    if (asked.deploy.volume) {
      // one pod at a time on a volume: a hunt that could never deploy there is refused now, not after its time
      const volume = (await this.s.rented.volumes()).find((v) => v.id === asked.deploy.volume);
      if (!volume) throw httpError("That network volume is not on this account any more: pick another, or hunt without one.", 409);
      if (volume.usedBy) throw httpError(inUseSaid(volume.name, volume.usedBy), 409);
      dataCenter = volume.dataCenter;
    }
    // the files and their licences settled now, as Deploy does: a licence not accepted refuses the hunt, not its deploy later
    const files = await deployFiles(this.s, asked.deploy);
    if (this.state) throw httpError("A GPU hunt is under way already: change it, or cancel it first.", 409);
    const at = this.now();
    const st: HuntState = {
      mode: asked.mode, ceiling: asked.ceiling, leftOut: asked.leftOut, cloud: asked.deploy.cloud, dataCenter,
      deploy: { ...asked.deploy, files, again: false }, hold: asked.hold,
      startedAt: new Date(at).toISOString(), giveUpAt: new Date(at + asked.giveUpMinutes * 60_000).toISOString(),
      status: "hunting", machine: null, pausedByHunt: [], asks: 0, fails: 0, lastError: null, deployingSince: null, before: [], found: null,
    };
    this.state = st;
    this.ranking = null;
    this.askedAt = null;
    if (st.hold === "rest") st.pausedByHunt = await this.pauseHome();
    await this.save();
    console.log(`[hunt] started (${st.mode}, at most ${dollars(st.ceiling)}/h, ${st.hold === "rest" ? `${plural(st.pausedByHunt.length, "home machine")} paused` : "the home machines go on"})`);
    this.kick(0);
    return this.view();
  }

  async change(asked: z.infer<typeof changeSchema>) {
    const st = this.state;
    if (!st) throw httpError("No GPU hunt is under way.", 404);
    if (asked.giveUpMinutes !== undefined) {
      const giveUpAt = Date.parse(st.startedAt) + asked.giveUpMinutes * 60_000;
      if (giveUpAt <= this.now()) throw httpError("That time is past already: give it longer, or cancel the hunt.");
      st.giveUpAt = new Date(giveUpAt).toISOString();
    }
    if (asked.mode !== undefined) st.mode = asked.mode;
    if (asked.ceiling !== undefined) st.ceiling = asked.ceiling;
    if (asked.leftOut !== undefined) st.leftOut = asked.leftOut;
    if (asked.hold !== undefined && asked.hold !== st.hold) {
      st.hold = asked.hold;
      if (asked.hold === "keep") {
        const paused = st.pausedByHunt;
        st.pausedByHunt = [];
        await this.resume(paused);
      } else st.pausedByHunt = await this.pauseHome();
    }
    await this.save();
    // what is usable may have changed: ranked again at once, RunPod's read reused when it is recent
    if (st.status === "hunting") this.kick(0);
    return this.view();
  }

  async cancel() {
    const st = this.state;
    if (!st) return { ok: true };
    // the pod being made is billed from its first second: it is let come up (a machine like any, with its idle and the caps)
    if (st.status === "deploying") throw httpError("A GPU is being deployed for this hunt: cancel once it is up, or stop its pod then.", 409);
    await this.end(null, "cancelled");
    return { ok: true };
  }

  /** Every home machine not paused already paused now (a render under way there finishes first); the ones paused, by id. */
  private async pauseHome(): Promise<string[]> {
    const paused: string[] = [];
    for (const m of (await readSettings(this.s.db)).machines) {
      if (m.rented || (await this.s.queue.pausedOn(m.id))) continue;
      await this.s.queue.setPaused(true, m.id);
      paused.push(m.id);
    }
    return paused;
  }

  private async resume(ids: string[]): Promise<number> {
    let n = 0;
    for (const id of ids) {
      if (!(await this.s.queue.pausedOn(id))) continue;
      await this.s.queue.setPaused(false, id).then(() => n++, (err: Error) => console.warn(`[hunt] ${id} not resumed: ${err.message}`));
    }
    return n;
  }

  /** A machine the hunt paused that is going again (resumed by hand, or gone): no longer the hunt's to resume. */
  private lookAtPauses(): void {
    if (!this.state?.pausedByHunt.length) return;
    if (this.pausesLooked) {
      this.pausesAgain = true;
      return;
    }
    this.pausesLooked = (async () => {
      do {
        this.pausesAgain = false;
        const st = this.state;
        if (!st?.pausedByHunt.length) break;
        const still: string[] = [];
        for (const id of st.pausedByHunt) if (await this.s.queue.pausedOn(id)) still.push(id);
        if (this.state !== st || still.length === st.pausedByHunt.length) continue;
        st.pausedByHunt = st.pausedByHunt.filter((id) => still.includes(id));
        await this.save();
      } while (this.pausesAgain);
    })().catch((err: Error) => console.warn(`[hunt] ${err.message}`)).finally(() => {
      this.pausesLooked = null;
    });
  }

  /**
   * The hunt over: the machines it paused resumed, and the user told why when it gave up (`gaveUp`); `ended` says why
   * otherwise, for the log (cancelled, its pod gone).
   */
  private async end(gaveUp: string | null, ended?: string): Promise<void> {
    const st = this.state;
    if (!st) return;
    this.state = null;
    this.ranking = null;
    this.askedAt = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const resumed = await this.resume(st.pausedByHunt);
    await this.save();
    const went = resumed ? ` ${plural(resumed, "home machine")} resumed.` : "";
    console.log(`[hunt] ended: ${gaveUp ?? ended}${went ? `;${went.slice(0, -1).toLowerCase()}` : ""}`);
    if (gaveUp) this.tell?.("huntGaveUp", { title: "The GPU hunt gave up", body: `${gaveUp}.${went}`, key: st.startedAt });
  }

  // ---------------------------------------------------------------- the hunt itself

  /** One round: RunPod asked, the GPUs ranked, the first free usable one deployed. One at a time; one asked meanwhile joins it. */
  tick(): Promise<void> {
    this.ticking ??= this.round().catch((err: Error) => console.warn(`[hunt] ${err.message}`)).finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  private async round(): Promise<void> {
    const st = this.state;
    if (!st || st.status === "deploying") return;
    if (st.status === "up") return this.watchPod();
    const started = Date.parse(st.startedAt);
    if (this.now() >= Date.parse(st.giveUpAt)) return this.end(`No GPU you would take came free in ${took(this.now() - started)}`);
    const rows = await this.held();
    if (this.state !== st) return;
    if (!rows.length) return this.end("Nothing waits for a GPU any more");
    let offers: GpuOffer[];
    try {
      const before = this.offersSeen.get(st.cloud)?.at;
      offers = await this.offers(st.cloud);
      if (this.offersSeen.get(st.cloud)?.at !== before) st.asks++;
    } catch (err) {
      // RunPod not read this round: asked again at the next, the hunt's time running all the same
      if (this.state !== st) return;
      st.lastError = (err as Error).message;
      return this.save();
    }
    const { ranking } = await this.rank(offers, rows, st);
    if (this.state !== st) return;
    this.ranking = ranking;
    this.askedAt = this.offersSeen.get(st.cloud)?.at ?? this.now();
    const pick = firstFree(ranking);
    if (!pick) return this.save();
    st.status = "deploying";
    st.deployingSince = new Date(this.now()).toISOString();
    st.before = (await readSettings(this.s.db)).machines.filter((m) => m.rented).map((m) => m.id);
    await this.save();
    let made: { id: string; dataCenter: string | null };
    try {
      const late = await this.lateFiles(st).catch(() => []);
      made = await this.s.rented.deploy({ ...st.deploy, files: [...st.deploy.files, ...late], gpu: pick.id, again: false });
    } catch (err) {
      st.deployingSince = null;
      return this.refused(st, err as Error);
    }
    Object.assign(st, { status: "up", deployingSince: null, machine: made.id, fails: 0, lastError: null, found: { gpu: pick.id, name: pick.name, price: pick.price, dataCenter: made.dataCenter, at: new Date(this.now()).toISOString() } });
    await this.save();
    console.log(`[hunt] ${pick.name} found and deployed after ${took(this.now() - started)}`);
    this.tell?.("gpuFound", {
      title: `${pick.name} found`,
      body: `Deployed in ${made.dataCenter ?? "a data center RunPod picked"} at ${dollars(pick.price)}/h, after ${took(this.now() - started)} of hunting; ${plural(rows.length, "render")} waiting for it.`,
      key: st.startedAt,
    });
  }

  /**
   * The files of the renders queued since the hunt began, not among its own: the pod fetches them while it starts, not
   * once it takes their jobs. Not those its jobs were left out for, nor those under a licence not accepted yet (they come
   * when their job is taken, once it is).
   */
  private async lateFiles(st: HuntState): Promise<PresetFile[]> {
    const view = await deployModels(this.s, { cloud: st.cloud, set: "" });
    const skip = new Set([...st.deploy.files, ...st.deploy.leaveOut].map(fileKey));
    for (const l of view.licences) for (const key of l.keys) skip.add(key);
    return view.jobs.files.filter((f) => !skip.has(fileKey(f))).map((f) => ({ file: f.file, folder: f.folder, ...(f.url ? { url: f.url } : {}), ...(f.size ? { size: f.size } : {}) }));
  }

  /**
   * A deploy refused:the GPU taken since RunPod listed it (or another deploy, the volume in use) and the hunt goes on; a
   * spending cap or RunPod's balance ends it (each deploy would be refused the same way); any other refusal is counted,
   * and the third in a row ends it.
   */
  private async refused(st: HuntState, err: Error): Promise<void> {
    st.status = "hunting";
    const why = refusalOf(err);
    st.lastError = err.message;
    if (why === "cap" || why === "balance") return this.end(err.message.replace(/\.$/, ""));
    if (why !== "noGpu" && why !== "busy" && why !== "volumeBusy") {
      st.fails++;
      if (st.fails >= MAX_FAILS) return this.end(`RunPod refused ${MAX_FAILS} deploys in a row: ${err.message.replace(/\.$/, "")}`);
    }
    await this.save();
  }

  /**
   * The hunted pod, once deployed: when it stops or is terminated, the hunt ends and the machines it paused go on. One not
   * on RunPod is left to rented.ts, which reads a pod just made as missing until RunPod lists it, and takes the machine out
   * once RunPod says that pod is gone: the hunt ends then.
   */
  private async watchPod(): Promise<void> {
    const st = this.state;
    if (!st || st.status !== "up" || !st.machine) return;
    const machine = (await readSettings(this.s.db)).machines.find((m) => m.id === st.machine);
    if (this.state !== st) return;
    if (!machine) return this.end(null, "its pod is gone");
    const down = this.s.rented.podDown(st.machine);
    if (down === "stopped" || down === "being stopped" || down === "error" || down === "terminated") return this.end(null, `its pod is ${down}`);
    // stopped or terminated by Afflatus or the user (its idle, a cap, a boot that never came): a pod terminated for a boot
    // that never came stays a machine, not on RunPod, and the renders would wait for it for ever
    const by = this.s.rented.view(machine)?.stoppedBy ?? null;
    if (by) return this.end(null, `its pod was stopped (${by})`);
  }
}

export function registerHunt(app: FastifyInstance, s: Services): void {
  /** The hunt under way (null: none), the ranking it last worked out and when it last asked RunPod. */
  app.get("/api/hunt", async () => s.hunt.view());
  /** A hunt started: the home machines paused when it holds the renders for the GPU. */
  app.post("/api/hunt", async (req) => s.hunt.start(askSchema.parse(req.body)));
  /** Its mode, ceiling, GPUs left out, time or hold changed. */
  app.patch("/api/hunt", async (req) => s.hunt.change(changeSchema.parse(req.body)));
  /** Cancelled: the machines it paused go on. */
  app.delete("/api/hunt", async () => s.hunt.cancel());
  /** The Hunt a GPU dialog's live ranking for its choices; read-only, RunPod asked at most every 20 s. */
  app.post("/api/hunt/rank", async (req) => s.hunt.preview(rankSchema.parse(req.body)));
}
