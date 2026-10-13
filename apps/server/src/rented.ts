import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import type { Comfy } from "./comfy";
import type { Db } from "./db";
import { httpError } from "./errors";
import { newToken } from "./lock-api";
import { exposesComfy, LOCK_ENV, Runpod, RunpodError, STOPPED_DISK_PER_GB_MONTH, WATCHDOG_ENV, type Pod, type PodStatus } from "./runpod";
import { readSettings, updateSettings, type Machine } from "./settings";

/**
 * Rented machines: pods the user made on RunPod and added to Afflatus as machines. Afflatus never starts one on its own:
 * Start is the user's. It reads each pod's state from RunPod (so a pod running while Afflatus restarts is picked up again),
 * keeps when each ran and at what rate (rent_sessions: today's and this month's cost, the caps), stops one that sat idle
 * (nothing rendering there, nothing waiting it could take) or that reached a cap once its render ends, and says "still
 * here" to the node pack's watchdog on it, which stops the pod by itself when this PC goes silent.
 *
 * Each pod is handled on its own: one that RunPod refuses something for says so on its card, and the others go on being
 * watched. A pod being stopped takes no new work from the moment Afflatus decides to stop it. A read of RunPod older than
 * an action of the user's (Start, Stop) is not taken over it.
 */

/** What the queue's machine rows, the pill and the cards say of a rented machine. */
export interface RentedView {
  provider: "runpod";
  pod: string;
  /** As RunPod says it; GONE: no such pod on this key's account any more; UNKNOWN: not read yet, or RunPod did not answer. */
  status: PodStatus | "GONE" | "UNKNOWN";
  /** USD an hour while it runs: the last rate seen (kept from its last run while it is stopped); null before it ever ran here. */
  rate: number | null;
  gpu: string | null;
  dataCenter: string | null;
  /** When the running session began (ms), and what it has cost so far. */
  since: number | null;
  spent: number;
  /** What its own disk costs a day while it is stopped (USD); 0 without one. */
  diskPerDay: number;
  /** The node pack's watchdog on it: on, none (no pack, or one too old), or unknown (not running). */
  watchdog: "on" | "none" | "unknown";
  /** Its ComfyUI answers (while it runs): false while it boots, or when it went down on the pod. */
  answers: boolean | null;
  /** Time left before it stops for being idle, while it runs idle; null otherwise. */
  idleLeftMs: number | null;
  /** A cap is reached: it stops once its render ends, and Start says so. */
  capped: boolean;
  /** Afflatus is stopping it now (idle, a cap, or the user): it takes no new work. */
  stopping: boolean;
  /** Why Afflatus stopped or deleted it last, when it did. */
  stoppedBy: "idle" | "cap" | "you" | null;
  /** What went wrong with this pod, or asking RunPod, when something did. */
  error: string | null;
}

export interface Spending {
  today: number;
  month: number;
  caps: { day: number; month: number };
  /** The account's balance on RunPod, when it says it (asked at most once a minute). */
  balance: number | null;
  /** Under this, the card says the balance is low: RunPod stops pods at zero. */
  lowBalance: boolean;
}

const LOW_BALANCE = 5;
const HOUR = 3_600_000;
const TRANSITIONAL: ReadonlySet<string> = new Set(["PROVISIONING", "STARTING"]);
/** After a cap, how long a render that does not end is waited for before the pod is stopped all the same. */
const CAP_GRACE_MS = 60 * 60_000;
/** How long RunPod is asked less often after it said to slow down (429). */
const BACK_OFF_MS = 60_000;

interface Seen {
  pod: Pod | null;
  rate: number | null;
  watchdog: RentedView["watchdog"];
  answers: boolean | null;
  /** When it last had work (ms); the idle clock starts at the first sight of it running and answering. */
  busyAt: number | null;
  stoppedBy: RentedView["stoppedBy"];
  /** A cap is reached: Afflatus stops it as soon as its render ends; and when the cap was first seen reached. */
  stopAfter: boolean;
  cappedAt: number | null;
  /** Afflatus is stopping it now: it takes no new work, and a second stop is not sent. */
  stopping: boolean;
  /** Locking it once it is up was tried this session (lockPod): once, not at every read. */
  lockTried: boolean;
  /** When a read last saw it running (ms): a run found ended is closed there. */
  seenRunningAt: number | null;
  /** Bumped by every action of the user's or Afflatus's: a read begun before it is not taken over it. */
  epoch: number;
  error: string | null;
  /** Its lock and watchdog could not be set for this start: said on its card for the run (it may have run open until locked). */
  bootNote: string | null;
}

const fresh = (): Seen => ({
  pod: null, rate: null, watchdog: "unknown", answers: null, busyAt: null, stoppedBy: null, stopAfter: false, cappedAt: null,
  stopping: false, lockTried: false, seenRunningAt: null, epoch: 0, error: null, bootNote: null,
});

export class Rented {
  private readonly seen = new Map<string, Seen>();
  /** What went wrong asking RunPod as a whole (the key, an answer not read): said on every rented card. */
  private error: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private polling: Promise<void> | null = null;
  private balanceSeen: { at: number; value: number | null } | null = null;
  /** RunPod said to slow down: not asked again before this (ms). */
  private quietUntil = 0;
  /** How often RunPod is read: every `everyMs`, every `fastMs` while a pod is starting or stopping. */
  everyMs = 20_000;
  fastMs = 3_000;
  /**
   * Lock a pod's ComfyUI (lock-api.ts lockMachine): a rented machine is reached at a public address, so one that came up
   * unlocked (RunPod did not take the token for its start) is locked as soon as it is up, when its node pack can.
   */
  lockPod: ((machine: string) => Promise<unknown>) | null = null;
  /** Where RunPod is asked, for a key: a test's stand-in. */
  client: (key: string) => Runpod = (key) => new Runpod(key);
  now: () => number = Date.now;

  constructor(
    private readonly db: Db,
    private readonly queue: { wants(machine: string): Promise<boolean>; runningOn(machine: string): boolean },
    private readonly events: EventEmitter,
    private readonly comfyOf: (machine: string) => Promise<Comfy | null>,
  ) {}

  /** Start reading RunPod, in the background; again at once when the settings change. */
  run(): void {
    if (this.running) return;
    this.running = true;
    this.kick(0);
    this.events.on("setup", () => void this.poll().catch(() => {}));
  }

  private running = false;

  /** The next read in `ms`, the one waiting put off: a pod just started or stopped is followed at the fast pace at once. */
  private kick(ms: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), Math.max(ms, this.quietUntil - this.now()));
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    await this.poll().catch((err: Error) => console.warn(`[rented] ${err.message}`));
    const fast = [...this.seen.values()].some((s) => s.stopping || (s.pod && TRANSITIONAL.has(s.pod.status)));
    this.kick(fast ? this.fastMs : this.everyMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private seenOf(machine: string): Seen {
    let s = this.seen.get(machine);
    if (!s) {
      s = fresh();
      this.seen.set(machine, s);
    }
    return s;
  }

  /** Whether a machine can take work: a rented one only while its pod runs and is not being stopped. Null: it can. */
  unavailable(machine: string): string | null {
    const s = this.seen.get(machine);
    if (!s) return null;
    if (s.stopping) return "being stopped";
    const status = s.pod?.status ?? "GONE";
    return status === "RUNNING" ? null : status === "GONE" ? "not on RunPod" : status === "EXITED" ? "stopped" : status.toLowerCase();
  }

  /** What is said of a rented machine; null for a ComfyUI of its own. */
  view(machine: Machine): RentedView | null {
    if (!machine.rented) return null;
    const s = this.seen.get(machine.id);
    const pod = s?.pod ?? null;
    const status: RentedView["status"] = s ? (pod ? pod.status : "GONE") : "UNKNOWN";
    const since = pod?.status === "RUNNING" && pod.startedAt ? Date.parse(pod.startedAt) : null;
    const rate = s?.rate ?? (pod?.cost || null);
    const idleMs = machine.rented.idleMinutes * 60_000;
    return {
      provider: "runpod", pod: machine.rented.pod, status, rate, gpu: pod?.gpu ?? null, dataCenter: pod?.dataCenter ?? null,
      since, spent: since && rate ? ((this.now() - since) / HOUR) * rate : 0,
      diskPerDay: pod ? (pod.diskGb * STOPPED_DISK_PER_GB_MONTH) / 30 : 0,
      watchdog: status === "RUNNING" ? s?.watchdog ?? "unknown" : "unknown",
      answers: status === "RUNNING" ? s?.answers ?? null : null,
      idleLeftMs: status === "RUNNING" && !s?.stopping && idleMs > 0 && s?.busyAt && !this.queue.runningOn(machine.id) ? Math.max(0, idleMs - (this.now() - s.busyAt)) : null,
      capped: s?.stopAfter ?? false,
      stopping: s?.stopping ?? false,
      stoppedBy: s?.stoppedBy ?? null,
      error: s?.error ?? this.error ?? s?.bootNote ?? null,
    };
  }

  /** The user's pods on RunPod, for adding one (Settings › ComfyUI): which expose ComfyUI, which are added already. */
  async pods(): Promise<Array<Pod & { comfy: boolean; added: string | null }>> {
    const s = await readSettings(this.db);
    if (!s.runpodKey) throw httpError("No RunPod API key: set it first.", 409);
    const pods = await this.client(s.runpodKey).pods().catch((err: Error) => {
      throw httpError(err.message, 502);
    });
    return pods.filter((p) => p.status !== "TERMINATED").map((p) => ({ ...p, comfy: exposesComfy(p), added: s.machines.find((m) => m.rented?.pod === p.id)?.id ?? null }));
  }

  /** Read RunPod now: every rented machine's pod, their sessions, the watchdog's "still here", idle and caps. */
  poll(): Promise<void> {
    this.polling ??= this.pollOnce().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  private async pollOnce(): Promise<void> {
    const settings = await readSettings(this.db);
    const rented = settings.machines.filter((m) => m.rented);
    for (const id of this.seen.keys()) if (!rented.some((m) => m.id === id)) this.seen.delete(id);
    // a run still open for a machine that is no longer this pod (removed from Afflatus while it ran, or added again as
    // another pod) is closed now, where it was last seen running: nothing would ever close it otherwise
    const open = await this.db.selectFrom("rent_sessions").select(["id", "machine_id", "pod", "seen_at"]).where("ended_at", "is", null).execute();
    for (const r of open.filter((x) => !rented.some((m) => m.id === x.machine_id && m.rented!.pod === x.pod))) {
      await this.db.updateTable("rent_sessions").set({ ended_at: r.seen_at ?? new Date(this.now()).toISOString() }).where("id", "=", r.id).execute();
    }
    if (!rented.length) return;
    if (!settings.runpodKey) {
      this.error = "No RunPod API key: set it in Settings › ComfyUI.";
      this.events.emit("queue");
      return;
    }
    if (this.now() < this.quietUntil) {
      await this.pingAll(rented);
      return;
    }
    // what each machine's state was before this read: an action taken while it was under way wins over what it read
    const epochs = new Map(rented.map((m) => [m.id, this.seenOf(m.id).epoch]));
    let pods: Pod[];
    try {
      pods = await this.client(settings.runpodKey).pods();
      this.error = null;
    } catch (err) {
      this.error = (err as Error).message;
      if (err instanceof RunpodError && err.status === 429) this.quietUntil = this.now() + BACK_OFF_MS;
      // RunPod not answering is not this PC going silent: the pods still hear "still here", and render on
      await this.pingAll(rented);
      this.events.emit("queue");
      return;
    }
    let changed = false;
    for (const m of rented) {
      const s = this.seenOf(m.id);
      if (s.epoch !== epochs.get(m.id)) continue;
      try {
        changed = (await this.follow(m, s, pods.find((p) => p.id === m.rented!.pod && p.status !== "TERMINATED") ?? null, settings.rentCaps)) || changed;
        s.error = null;
      } catch (err) {
        // one pod RunPod refuses something for says so on its card; the others go on being watched
        s.error = (err as Error).message;
        changed = true;
      }
    }
    if (changed) {
      this.events.emit("queue");
      // a pod that came up, or went: what waited for it may go, what it held is read again
      this.events.emit("setup");
    }
  }

  /** One machine's pod as just read: its session, "still here", its lock, idle and caps. Says whether anything changed. */
  private async follow(m: Machine, s: Seen, pod: Pod | null, caps: { day: number; month: number }): Promise<boolean> {
    const before = s.pod;
    const changed = !before || before.status !== pod?.status || Boolean(pod?.cost && pod.cost !== s.rate);
    s.pod = pod;
    if (pod?.cost) s.rate = pod.cost;
    // the rate of its last run here, until RunPod says one (it says 0 while the pod is stopped)
    s.rate ??= (await this.db.selectFrom("rent_sessions").select("rate").where("pod", "=", m.rented!.pod).orderBy("started_at", "desc").executeTakeFirst())?.rate || null;
    await this.session(m, pod, s);
    if (pod?.status !== "RUNNING") {
      s.busyAt = null;
      s.stopAfter = false;
      s.cappedAt = null;
      s.lockTried = false;
      s.answers = null;
      if (s.stopping && pod?.status !== "STARTING") s.stopping = false;
      if (!pod || !TRANSITIONAL.has(pod.status)) s.bootNote = null;
      return changed;
    }
    if (s.stoppedBy && !before) s.stoppedBy = null;
    const answers = await this.alive(m, s);
    // up and open (RunPod did not take its token for the start, or it was added running): locked now, once a session
    if (answers && !s.lockTried && this.lockPod && (await this.isOpen(m))) {
      s.lockTried = true;
      await this.lockPod(m.id).catch((err: Error) => console.warn(`[rented] ${m.name || m.id} not locked: ${err.message}`));
    }
    await this.keepOrStop(m, s, caps, answers);
    return changed;
  }

  /** Whether its ComfyUI answers without a lock (the pack's GET /afflatus/lock says locked false). */
  private async isOpen(m: Machine): Promise<boolean> {
    const comfy = await this.comfyOf(m.id);
    const res = await comfy?.client.raw("/afflatus/lock", { signal: AbortSignal.timeout(8000) }).catch(() => null);
    if (!res?.ok) {
      await res?.body?.cancel().catch(() => {});
      return false;
    }
    const said = (await res.json().catch(() => null)) as { locked?: boolean } | null;
    return said?.locked === false;
  }

  /** The running session kept as a row: opened when it is seen running, kept seen while it runs, closed when it is not. */
  private async session(m: Machine, pod: Pod | null, s: Seen): Promise<void> {
    const open = await this.db.selectFrom("rent_sessions").selectAll().where("machine_id", "=", m.id).where("ended_at", "is", null).executeTakeFirst();
    const now = this.now();
    const iso = new Date(now).toISOString();
    if (pod?.status === "RUNNING") {
      s.seenRunningAt = now;
      if (open) {
        await this.db.updateTable("rent_sessions").set({ seen_at: iso }).where("id", "=", open.id).execute();
        return;
      }
      // from when the pod says it started, but never over a session already counted
      const last = await this.db.selectFrom("rent_sessions").select("ended_at").where("machine_id", "=", m.id).orderBy("ended_at", "desc").executeTakeFirst();
      const from = Math.max(pod.startedAt ? Date.parse(pod.startedAt) : now, last?.ended_at ? Date.parse(last.ended_at) : 0);
      await this.db.insertInto("rent_sessions").values({ id: randomUUID(), machine_id: m.id, pod: pod.id, rate: pod.cost || s.rate || 0, started_at: new Date(Math.min(from, now)).toISOString(), ended_at: null, seen_at: iso }).execute();
    } else if (open) {
      // closed where it was last seen running: a run that ended while Afflatus was away (off, asleep) does not count the hours
      // until it came back
      const end = s.seenRunningAt ?? (open.seen_at ? Date.parse(open.seen_at) : now);
      await this.db.updateTable("rent_sessions").set({ ended_at: new Date(Math.min(end, now)).toISOString() }).where("id", "=", open.id).execute();
      s.seenRunningAt = null;
    }
  }

  /** "Still here" to every pod last seen running, when RunPod itself cannot be read: Afflatus is not silent for that. */
  private async pingAll(rented: Machine[]): Promise<void> {
    for (const m of rented) {
      const s = this.seen.get(m.id);
      if (s?.pod?.status === "RUNNING") await this.alive(m, s).catch(() => false);
    }
  }

  /**
   * "Still here", to the node pack's watchdog on the pod: it stops the pod by itself when this PC goes silent that long. Says
   * whether its ComfyUI answered as Afflatus's (not while it boots, nor when it went down or is locked against Afflatus's token).
   */
  private async alive(m: Machine, s: Seen): Promise<boolean> {
    const minutes = m.rented!.watchdogMinutes;
    const comfy = await this.comfyOf(m.id);
    if (!comfy) return false;
    const res = await comfy.client.raw("/afflatus/alive", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ minutes }), signal: AbortSignal.timeout(8000) }).catch(() => null);
    // no answer: ComfyUI still starting on it, or down; a 404: no pack, or one without the watchdog (ComfyUI answers all the
    // same); a 401: locked against Afflatus's token; `can` false: the pack has no way to stop this pod
    let answers = false;
    if (res?.ok) {
      const said = (await res.json().catch(() => null)) as { can?: boolean } | null;
      s.watchdog = minutes > 0 && said?.can ? "on" : "none";
      answers = true;
    } else if (res) {
      // refused by ComfyUI itself (a 404, or a 405 from an older ComfyUI whose page answers every address): it answers, with
      // no watchdog; locked against Afflatus's token (401), or the provider's proxy with no ComfyUI behind it (5xx), it does not
      if (res.status >= 400 && res.status < 500 && res.status !== 401) {
        s.watchdog = "none";
        answers = true;
      }
      await res.body?.cancel().catch(() => {});
    }
    s.answers = answers;
    return answers;
  }

  /** Idle long enough, or a cap reached once its render ends: stopped (or deleted, as its idle choice says). */
  private async keepOrStop(m: Machine, s: Seen, caps: { day: number; month: number }, answers: boolean): Promise<void> {
    const now = this.now();
    const running = this.queue.runningOn(m.id);
    // work counts only for a pod whose ComfyUI answers: one that went down would otherwise keep a waiting job "for it" forever
    if (running || (answers && (await this.queue.wants(m.id)))) s.busyAt = now;
    s.busyAt ??= now;
    const spent = await this.spent();
    s.stopAfter = (caps.day > 0 && spent.today >= caps.day) || (caps.month > 0 && spent.month >= caps.month);
    s.cappedAt = s.stopAfter ? s.cappedAt ?? now : null;
    // at a cap: once its render ends, or an hour after the cap when the render does not end
    if (s.stopAfter && (!running || now - s.cappedAt! > CAP_GRACE_MS)) {
      await this.act(m, "stop", "cap");
      return;
    }
    const idle = m.rented!.idleMinutes * 60_000;
    if (idle > 0 && now - s.busyAt >= idle) await this.act(m, m.rented!.idleDo, "idle");
  }

  /** What the rented GPUs cost from `from` until now: each session's time in it, at its rate. */
  private async costSince(from: number): Promise<number> {
    const since = new Date(from).toISOString();
    const rows = await this.db.selectFrom("rent_sessions").selectAll().where((eb) => eb.or([eb("ended_at", "is", null), eb("ended_at", ">", since)])).execute();
    const now = this.now();
    return rows.reduce((sum, r) => {
      const a = Math.max(from, Date.parse(r.started_at));
      const b = r.ended_at ? Date.parse(r.ended_at) : now;
      return sum + (Number.isFinite(a) && Number.isFinite(b) && b > a ? ((b - a) / HOUR) * r.rate : 0);
    }, 0);
  }

  private async spent(): Promise<{ today: number; month: number }> {
    const d = new Date(this.now());
    const today = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const month = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    return { today: await this.costSince(today), month: await this.costSince(month) };
  }

  /** Today's and this month's cost, the caps, and RunPod's balance. */
  async spending(): Promise<Spending> {
    const s = await readSettings(this.db);
    const spent = await this.spent();
    let balance = this.balanceSeen?.value ?? null;
    // RunPod is asked at most once a minute: the card reads this every 10 s while a pod runs
    if (s.runpodKey && this.now() >= this.quietUntil && (!this.balanceSeen || this.now() - this.balanceSeen.at > 60_000)) {
      balance = await this.client(s.runpodKey).balance().catch(() => null);
      this.balanceSeen = { at: this.now(), value: balance };
    }
    return { ...spent, caps: s.rentCaps, balance, lowBalance: balance !== null && balance < LOW_BALANCE };
  }

  /** The user's Start: refused at a cap. */
  async start(machine: string): Promise<RentedView> {
    const s = await readSettings(this.db);
    const m = s.machines.find((x) => x.id === machine);
    if (!m?.rented) throw httpError("That machine is not a rented pod.", 404);
    const spent = await this.spent();
    if ((s.rentCaps.day > 0 && spent.today >= s.rentCaps.day) || (s.rentCaps.month > 0 && spent.month >= s.rentCaps.month)) {
      throw httpError("A spending cap is reached: raise it in Settings › ComfyUI › Rented GPUs to start it.", 409);
    }
    const unprepared = await this.prepareBoot(m, s.runpodKey);
    await this.act(m, "start", null);
    // said on its card for the run: it may run open until it is up and locked
    this.seenOf(m.id).bootNote = unprepared;
    return this.view(m)!;
  }

  /**
   * What the pod reads as it starts, set before Start: the machine's token (made now if it has none), which the node pack
   * locks its ComfyUI with from its first second (lock.py AFFLATUS_TOKEN), and the watchdog's minutes, which arm it from its
   * first second too (watchdog.py), so that a PC gone silent right after Start still has the pod stop. Only on a stopped pod,
   * read again just before (an edit made on RunPod's site since the last read is kept), and only when RunPod said its
   * environment: writing it replaces the whole of it. RunPod refusing it is said in the log and on the card; the pod starts
   * all the same, and is locked once it is up.
   */
  private async prepareBoot(m: Machine, key: string): Promise<string | null> {
    if (!m.token) {
      const made = newToken();
      await updateSettings(this.db, (current) => ({ machines: current.machines.map((x) => (x.id === m.id ? { ...x, token: x.token || made } : x)) }));
      m.token = (await readSettings(this.db)).machines.find((x) => x.id === m.id)?.token || made;
    }
    try {
      const client = this.client(key);
      const pod = (await client.pods()).find((p) => p.id === m.rented!.pod) ?? null;
      if (!pod || (pod.status !== "EXITED" && pod.status !== "ERROR")) return null;
      if (!pod.env) throw new Error("RunPod did not say the pod's environment, which Afflatus does not overwrite blind");
      const minutes = String(m.rented!.watchdogMinutes);
      if (pod.env[LOCK_ENV] === m.token && pod.env[WATCHDOG_ENV] === minutes) return null;
      await client.setEnv(pod.id, { ...pod.env, [LOCK_ENV]: m.token, [WATCHDOG_ENV]: minutes });
      return null;
    } catch (err) {
      const said = `Its lock and watchdog could not be set for its start (${(err as Error).message}): it is locked once it is up.`;
      console.warn(`[rented] ${m.name || m.id}: ${said}`);
      return said;
    }
  }

  /** The user's Stop or Delete. */
  async stopBy(machine: string, how: "stop" | "terminate"): Promise<RentedView> {
    const s = await readSettings(this.db);
    const m = s.machines.find((x) => x.id === machine);
    if (!m?.rented) throw httpError("That machine is not a rented pod.", 404);
    await this.act(m, how, "you");
    return this.view(m)!;
  }

  private async act(m: Machine, action: "start" | "stop" | "terminate", why: RentedView["stoppedBy"]): Promise<void> {
    const s = this.seenOf(m.id);
    // a read under way is not taken over this, and a stopping pod takes no new work from now (asked again: no second stop)
    s.epoch++;
    if (action !== "start") {
      if (s.stopping && why !== "you") return;
      s.stopping = true;
      // a job the queue started on it a moment ago: idle and cap stops wait for it (the user's own Stop does not)
      if (why !== "you" && why !== "cap" && this.queue.runningOn(m.id)) {
        s.stopping = false;
        return;
      }
    }
    this.events.emit("queue");
    const settings = await readSettings(this.db);
    if (!settings.runpodKey) {
      s.stopping = false;
      throw httpError("No RunPod API key: set it in Settings › ComfyUI.", 409);
    }
    let after: Pod | null;
    try {
      after = await this.client(settings.runpodKey).act(m.rented!.pod, action);
    } catch (err) {
      s.stopping = false;
      s.epoch++;
      const status = (err as RunpodError).status;
      if (status === 429) this.quietUntil = this.now() + BACK_OFF_MS;
      throw httpError((err as Error).message, status === 409 ? 409 : 502);
    }
    s.pod = action === "terminate" ? null : after ?? s.pod;
    s.stoppedBy = action === "start" ? null : why;
    s.error = null;
    if (action !== "start") {
      s.busyAt = null;
      s.stopping = s.pod?.status === "RUNNING";
      await this.session(m, s.pod, s);
    }
    if (why === "idle" || why === "cap") console.log(`[rented] ${m.name || m.id}: ${action === "terminate" ? "deleted" : "stopped"} (${why === "idle" ? `idle ${m.rented!.idleMinutes} min` : "a spending cap"})`);
    this.events.emit("queue");
    // read again soon, then at the fast pace while it moves
    this.kick(1500);
  }
}
