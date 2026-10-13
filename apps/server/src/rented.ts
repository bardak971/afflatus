import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import type { Comfy } from "./comfy";
import type { Db } from "./db";
import { httpError } from "./errors";
import { newToken } from "./lock-api";
import { exposesComfy, LOCK_ENV, Runpod, STOPPED_DISK_PER_GB_MONTH, type Pod, type PodStatus } from "./runpod";
import { readSettings, updateSettings, type Machine } from "./settings";

/**
 * Rented machines: pods the user made on RunPod and added to Afflatus as machines. Afflatus never starts one on its own:
 * Start is the user's. It reads each pod's state from RunPod (so a pod running while Afflatus restarts is picked up again),
 * keeps when each ran and at what rate (rent_sessions: today's and this month's cost, the caps), stops one that sat idle
 * (nothing rendering there, nothing waiting it could take) or that reached a cap once its render ends, and says "still
 * here" to the node pack's watchdog on it, which stops the pod by itself when this PC goes silent.
 */

/** What the queue's machine rows, the pill and the cards say of a rented machine. */
export interface RentedView {
  provider: "runpod";
  pod: string;
  /** As RunPod says it; GONE: no such pod any more (deleted on RunPod); UNKNOWN: not read yet, or RunPod did not answer. */
  status: PodStatus | "GONE" | "UNKNOWN";
  /** USD an hour while it runs (the last rate seen, kept while it is stopped). */
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
  /** Minutes left before it stops for being idle, while it runs idle; null otherwise. */
  idleLeftMs: number | null;
  /** A cap is reached: it stops once its render ends, and Start says so. */
  capped: boolean;
  /** Why Afflatus stopped or deleted it last, when it did. */
  stoppedBy: "idle" | "cap" | "you" | null;
  /** What went wrong asking RunPod, when something did. */
  error: string | null;
}

export interface Spending {
  today: number;
  month: number;
  caps: { day: number; month: number };
  /** The account's balance on RunPod, when it says it (asked every few minutes). */
  balance: number | null;
  /** Under this, the card says the balance is low: RunPod stops pods at zero. */
  lowBalance: boolean;
}

const LOW_BALANCE = 5;
const HOUR = 3_600_000;
const TRANSITIONAL: ReadonlySet<string> = new Set(["PROVISIONING", "STARTING"]);

interface Seen {
  pod: Pod | null;
  rate: number | null;
  watchdog: RentedView["watchdog"];
  /** When it last had work (ms); the idle clock starts at the first sight of it running. */
  busyAt: number | null;
  stoppedBy: RentedView["stoppedBy"];
  /** Afflatus stops it as soon as its render ends (a cap). */
  stopAfter: boolean;
  /** Locking it was tried this session (lockPod): once, not at every read. */
  lockTried: boolean;
}

export class Rented {
  private readonly seen = new Map<string, Seen>();
  private error: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private polling: Promise<void> | null = null;
  private balanceSeen: { at: number; value: number | null } | null = null;
  /** How often RunPod is read: every `everyMs`, every `fastMs` while a pod is starting or stopping. */
  everyMs = 20_000;
  fastMs = 3_000;
  /**
   * Lock a pod's ComfyUI (lock-api.ts lockMachine): a rented machine is reached at a public address, so it is locked as soon
   * as it is up, when its node pack can. Set by the services; nothing in a test that does not.
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
    this.timer = setTimeout(() => void this.tick(), ms);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    await this.poll().catch((err: Error) => console.warn(`[rented] ${err.message}`));
    const fast = [...this.seen.values()].some((s) => s.pod && TRANSITIONAL.has(s.pod.status));
    this.kick(fast ? this.fastMs : this.everyMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Whether a machine can take work: a rented one only while its pod runs. Null: it can; else the word for why not. */
  unavailable(machine: string): string | null {
    const s = this.seen.get(machine);
    if (!s) return null;
    const status = s.pod?.status ?? "GONE";
    return status === "RUNNING" ? null : status === "GONE" ? "deleted on RunPod" : status === "EXITED" ? "stopped" : status.toLowerCase();
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
      idleLeftMs: status === "RUNNING" && idleMs > 0 && s?.busyAt && !this.queue.runningOn(machine.id) ? Math.max(0, idleMs - (this.now() - s.busyAt)) : null,
      capped: s?.stopAfter ?? false,
      stoppedBy: s?.stoppedBy ?? null,
      error: this.error,
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
    // another pod) is closed now: nothing would ever close it, and today's cost would go on counting it
    const open = await this.db.selectFrom("rent_sessions").select(["id", "machine_id", "pod"]).where("ended_at", "is", null).execute();
    const stray = open.filter((r) => !rented.some((m) => m.id === r.machine_id && m.rented!.pod === r.pod)).map((r) => r.id);
    if (stray.length) await this.db.updateTable("rent_sessions").set({ ended_at: new Date(this.now()).toISOString() }).where("id", "in", stray).execute();
    if (!rented.length) return;
    if (!settings.runpodKey) {
      this.error = "No RunPod API key: set it in Settings › ComfyUI.";
      this.events.emit("queue");
      return;
    }
    let pods: Pod[];
    try {
      pods = await this.client(settings.runpodKey).pods();
      this.error = null;
    } catch (err) {
      this.error = (err as Error).message;
      this.events.emit("queue");
      return;
    }
    let changed = false;
    for (const m of rented) {
      const pod = pods.find((p) => p.id === m.rented!.pod && p.status !== "TERMINATED") ?? null;
      const before = this.seen.get(m.id);
      const s: Seen = before ?? { pod: null, rate: null, watchdog: "unknown", busyAt: null, stoppedBy: null, stopAfter: false, lockTried: false };
      if (!before || before.pod?.status !== pod?.status || (pod?.cost && pod.cost !== before.rate)) changed = true;
      s.pod = pod;
      if (pod?.cost) s.rate = pod.cost;
      this.seen.set(m.id, s);
      await this.session(m, pod, s);
      if (pod?.status === "RUNNING") {
        if (s.stoppedBy && !before?.pod) s.stoppedBy = null;
        await this.alive(m, s);
        // up and not locked: locked now, once a session (a pack too old, or none, says why on its card's Access line)
        if (!m.token && !s.lockTried && this.lockPod) {
          s.lockTried = true;
          await this.lockPod(m.id).catch((err: Error) => console.warn(`[rented] ${m.name || m.id} not locked: ${err.message}`));
        }
        await this.keepOrStop(m, s, settings.rentCaps);
      } else {
        s.busyAt = null;
        s.stopAfter = false;
        s.lockTried = false;
      }
    }
    if (changed) {
      this.events.emit("queue");
      // a pod that came up, or went: what waited for it may go, what it held is read again
      this.events.emit("setup");
    }
  }

  /** The running session kept as a row: opened when it is seen running, closed when it is not. */
  private async session(m: Machine, pod: Pod | null, s: Seen): Promise<void> {
    const open = await this.db.selectFrom("rent_sessions").selectAll().where("machine_id", "=", m.id).where("ended_at", "is", null).executeTakeFirst();
    const now = new Date(this.now()).toISOString();
    if (pod?.status === "RUNNING" && !open) {
      // from when the pod says it started, but never over a session already counted
      const last = await this.db.selectFrom("rent_sessions").select("ended_at").where("machine_id", "=", m.id).orderBy("ended_at", "desc").executeTakeFirst();
      const from = [pod.startedAt ?? now, last?.ended_at ?? ""].sort().at(-1)!;
      await this.db.insertInto("rent_sessions").values({ id: randomUUID(), machine_id: m.id, pod: pod.id, rate: pod.cost || s.rate || 0, started_at: from, ended_at: null }).execute();
    } else if (pod?.status !== "RUNNING" && open) {
      await this.db.updateTable("rent_sessions").set({ ended_at: now }).where("id", "=", open.id).execute();
    }
  }

  /** "Still here", to the node pack's watchdog on the pod: it stops the pod by itself when this PC goes silent that long. */
  private async alive(m: Machine, s: Seen): Promise<void> {
    const minutes = m.rented!.watchdogMinutes;
    const comfy = await this.comfyOf(m.id);
    if (!comfy) return;
    const res = await comfy.client.raw("/afflatus/alive", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ minutes }), signal: AbortSignal.timeout(8000) }).catch(() => null);
    // no answer: ComfyUI may still be starting on it; a 404: no pack, or one without the watchdog; `can` false: the pack
    // has no way to stop this pod (not on RunPod, or no runpodctl nor key in it)
    if (!res) return;
    if (res.ok) {
      const said = (await res.json().catch(() => null)) as { can?: boolean } | null;
      s.watchdog = minutes > 0 && said?.can ? "on" : "none";
    } else {
      if (res.status === 404) s.watchdog = "none";
      await res.body?.cancel().catch(() => {});
    }
  }

  /** Idle long enough, or a cap reached once its render ends: stopped (or deleted, as its idle choice says). */
  private async keepOrStop(m: Machine, s: Seen, caps: { day: number; month: number }): Promise<void> {
    const now = this.now();
    if (await this.queue.wants(m.id)) s.busyAt = now;
    s.busyAt ??= now;
    const spent = await this.spent();
    s.stopAfter = (caps.day > 0 && spent.today >= caps.day) || (caps.month > 0 && spent.month >= caps.month);
    if (s.stopAfter && !this.queue.runningOn(m.id)) {
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
      return sum + (b > a ? ((b - a) / HOUR) * r.rate : 0);
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
    if (s.runpodKey && (!this.balanceSeen || this.now() - this.balanceSeen.at > 60_000)) {
      balance = await this.client(s.runpodKey).balance().catch(() => null);
      this.balanceSeen = { at: this.now(), value: balance };
    }
    return { ...spent, caps: s.rentCaps, balance, lowBalance: balance !== null && balance < LOW_BALANCE };
  }

  /** The user's Start: refused at a cap, and when the pod is gone or not stopped. */
  async start(machine: string): Promise<RentedView> {
    const s = await readSettings(this.db);
    const m = s.machines.find((x) => x.id === machine);
    if (!m?.rented) throw httpError("That machine is not a rented pod.", 404);
    const spent = await this.spent();
    if ((s.rentCaps.day > 0 && spent.today >= s.rentCaps.day) || (s.rentCaps.month > 0 && spent.month >= s.rentCaps.month)) {
      throw httpError("A spending cap is reached: raise it in Settings › ComfyUI › Rented GPUs to start it.", 409);
    }
    await this.lockFromBoot(m, s.runpodKey);
    await this.act(m, "start", null);
    return this.view(m)!;
  }

  /**
   * Locked from its first second: the machine's token (made now if it has none) in the pod's environment, which the node pack
   * reads as it starts (lock.py AFFLATUS_TOKEN). Then nobody reaches it open while it boots, and nobody can lock it first with
   * a token of their own. Without the pack the variable does nothing, and the pod runs open (its card's Access line says so).
   * RunPod refusing the change is said in the log, and the pod is started all the same: it is then locked once it is up.
   */
  private async lockFromBoot(m: Machine, key: string): Promise<void> {
    let token = m.token;
    if (!token) {
      token = newToken();
      const made = token;
      await updateSettings(this.db, (current) => ({ machines: current.machines.map((x) => (x.id === m.id ? { ...x, token: made } : x)) }));
      m.token = token;
    }
    try {
      const client = this.client(key);
      const pod = this.seen.get(m.id)?.pod ?? (await client.pods()).find((p) => p.id === m.rented!.pod) ?? null;
      if (!pod || pod.env[LOCK_ENV] === token) return;
      await client.setEnv(pod.id, { ...pod.env, [LOCK_ENV]: token });
      pod.env = { ...pod.env, [LOCK_ENV]: token };
    } catch (err) {
      console.warn(`[rented] ${m.name || m.id}: its lock could not be set for its start (${(err as Error).message}); it is locked once it is up`);
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
    const s = await readSettings(this.db);
    if (!s.runpodKey) throw httpError("No RunPod API key: set it in Settings › ComfyUI.", 409);
    const after = await this.client(s.runpodKey).act(m.rented!.pod, action).catch((err: Error & { status?: number }) => {
      throw httpError(err.message, err.status === 409 ? 409 : 502);
    });
    const seen = this.seen.get(m.id) ?? { pod: null, rate: null, watchdog: "unknown" as const, busyAt: null, stoppedBy: null, stopAfter: false, lockTried: false };
    seen.pod = action === "terminate" ? null : after ?? seen.pod;
    seen.stoppedBy = action === "start" ? null : why;
    if (action !== "start") seen.busyAt = null;
    this.seen.set(m.id, seen);
    if (action !== "start") await this.session(m, seen.pod, seen);
    if (why === "idle" || why === "cap") console.log(`[rented] ${m.name || m.id}: ${action === "terminate" ? "deleted" : "stopped"} (${why === "idle" ? `idle ${m.rented!.idleMinutes} min` : "a spending cap"})`);
    this.events.emit("queue");
    // read again soon, then at the fast pace while it moves
    this.kick(1500);
  }
}
