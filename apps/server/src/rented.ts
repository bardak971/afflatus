import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import type { Comfy } from "./comfy";
import type { Db } from "./db";
import { httpError } from "./errors";
import { newToken } from "./lock-api";
import { COMFY_PORT, exposesComfy, imageFor, LOCK_ENV, noCapacity, POD_IMAGES, podMachineId, podUrl, Runpod, RunpodError, RunpodShape, secretRef, RUNNING_DISK_PER_GB_MONTH, STOPPED_DISK_PER_GB_MONTH, tokenSecret, WATCHDOG_ACTION_ENV, WATCHDOG_ENV, type BillRecord, type GpuOffer, type NetworkVolume, type Pod, type PodSpec, type PodStatus } from "./runpod";
import type { PresetFile } from "@afflatus/core";
import { imagePublic } from "./podImage";
import { recordMeasure } from "./podMeasures";
import { SEARCHED_FOLDERS } from "./modelSets";
import { inUseSaid, keptHoldings, noticeVolumes, mountedOn, recordHoldings, usedBy, viewVolumes, VOLUME_MAX_GB, VOLUME_MIN_GB, VOLUME_PER_GB_MONTH, type Storage, type VolumeView } from "./rentedVolumes";
import { MAX_MACHINES, readSettings, updateSettings, type DeployAsk, type Machine, type Settings } from "./settings";

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
  /** It has a volume (its own disk, or a network volume): a stop keeps something. Without, a stop keeps nothing. */
  volume: boolean;
  /** Its public ports besides ComfyUI's ("8080/http", "22/tcp"): reached by anyone who finds them, outside the lock. */
  otherPorts: string[];
  /** The ports Afflatus closed on it: put back at a Start when they are to be kept open. */
  closedPorts: string[];
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
  /**
   * Why Afflatus stopped or terminated it last, when it did: "boot" when its ComfyUI never answered; "gpu" when the pod said its
   * GPU does not work; "watchdog" when its watchdog stopped it while Afflatus was away, and Afflatus terminated what was left.
   */
  stoppedBy: "idle" | "cap" | "you" | "boot" | "gpu" | "watchdog" | "filled" | null;
  /** Deployed and on its first start (its image pulled, ComfyUI starting): a normal step, said as one, not as an error. */
  booting: boolean;
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
  /** What the account spends an hour now on RunPod (every pod and volume), when it says it. */
  spendPerHr: number | null;
  /** How long the balance lasts at that spend (ms); null when nothing is spent, or RunPod did not say. */
  runwayMs: number | null;
  /** Today and this month are RunPod's own bill (with Afflatus's count for the hours RunPod has not billed yet); false: Afflatus's count alone. */
  billed: boolean;
  /** What storage costs (volumes, the pods' own disks); null when RunPod was not read. Never counted against the caps. */
  storage: Storage | null;
}

/** What a pod cost as Afflatus counts it (rent_sessions), today and this month, and whether a run of it is still open. */
type Counted = { today: number; month: number; open: boolean; lastEnd: number };

const LOW_BALANCE = 5;
const HOUR = 3_600_000;
/** How often RunPod's bill is read again: it is written some hours after the fact, nothing is lost reading it seldom. */
const BILL_EVERY_MS = 5 * 60_000;
/**
 * A pod whose last run ended this long ago is billed in full by RunPod: its bill is its cost. Before, the higher of RunPod's
 * bill and Afflatus's count (which counts from the deploy, and to the latest a pod could have run), so that a cap is never
 * reached late.
 */
const BILL_SETTLED_MS = 6 * HOUR;
/** A pod not seen for longer than this was run while Afflatus was away (asleep, closed): when it stopped is not known. */
const AWAY_MS = 90_000;
/** What is kept back of the balance when a job's length is weighed against it: a render is not started into the last minutes. */
const RUNWAY_MARGIN_MS = 10 * 60_000;
const TRANSITIONAL: ReadonlySet<string> = new Set(["PROVISIONING", "STARTING"]);
/**
 * Billed by RunPod: running, and on its way up (a pod provisioning or starting holds its GPU). Counted from then, so that a
 * pod slow to come up reaches a cap too; RunPod's bill stays the reference.
 */
const BILLED: ReadonlySet<string> = new Set(["RUNNING", "STARTING", "PROVISIONING"]);
/** How often the folders of a volume a pod runs on are listed, to keep what it holds (rentedVolumes.ts). */
const VOLUME_LIST_MS = 5 * 60_000;
/** After a cap, how long a render that does not end is waited for before the pod is stopped all the same. */
const CAP_GRACE_MS = 60 * 60_000;
/**
 * How long a render on a pod may go past its forecast with ComfyUI silent (no step, no node, no preview) before it is
 * failed as stuck: a render that hangs would otherwise keep its pod billed for ever (idle never comes while it runs).
 */
const STUCK_MS = 30 * 60_000;
/** How long RunPod is asked less often after it said to slow down (429). */
const BACK_OFF_MS = 60_000;
/** A pod running this long without its ComfyUI ever answering did not come up (its container failed): its idle action applies. */
const BOOT_LIMIT_MS = 10 * 60_000;
/**
 * The same for a pod deployed from Afflatus: its first start pulls its image (several GB), which RunPod says may take long
 * on a host that never had it.
 */
const DEPLOYED_BOOT_LIMIT_MS = 20 * 60_000;
/** From then a deployed pod's first start is said as slow on its card (before, as a normal step). */
const DEPLOY_SLOW_MS = 12 * 60_000;
/** The freest data center first, for a deploy. */
const FREEST = { HIGH: 0, MEDIUM: 1, LOW: 2, NONE: 3 } as const;
/** How long a pod may run without its ComfyUI answering before its idle action applies. */
const bootLimit = (m: Machine) => (m.rented?.deployed ? DEPLOYED_BOOT_LIMIT_MS : BOOT_LIMIT_MS);
/** The RunPod secret its token is kept in. */
const secretOf = (m: Machine) => m.rented!.secret || tokenSecret(m.rented!.pod);
/** After this long running without an answer, its card says so (it is billed meanwhile). */
const BOOT_SLOW_MS = 2 * 60_000;
/** How long a Start waits for a pod just stopped to be stopped on RunPod's side before preparing it. */
const SETTLE_MS = 30_000;

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
  /** Its secret on RunPod was deleted (the pod is gone): not asked again at every read. */
  secretDropped: boolean;
  /** When it was first seen running this time (ms), and whether its ComfyUI answered since. */
  upAt: number | null;
  answered: boolean;
  /** The pod said its GPU does not work on its host (the Afflatus image, broken.py), with torch's words. */
  gpuFailed: string | null;
  /** How many reads in a row found no such pod on RunPod. */
  missing: number;
  /** Read at least once: what a later read finds is a change only when it differs. */
  read: boolean;
  /** When Afflatus asked RunPod to stop it (ms), while `stopping`: asked again if it still runs a while after. */
  stoppingSince: number | null;
  /** When its ComfyUI last took a "still here" (ms): a run that ended while RunPod could not be read is closed after that. */
  aliveAt: number | null;
  /** Since when it has been starting or provisioning (ms): a pod that never comes up is stopped at its boot limit. */
  startingSince: number | null;
}

const fresh = (): Seen => ({
  pod: null, rate: null, watchdog: "unknown", answers: null, busyAt: null, stoppedBy: null, stopAfter: false, cappedAt: null,
  stopping: false, lockTried: false, seenRunningAt: null, epoch: 0, error: null, bootNote: null, secretDropped: false, upAt: null, answered: false,
  read: false, gpuFailed: null, missing: 0, stoppingSince: null, aliveAt: null, startingSince: null,
});

/** A pod still running this long after Afflatus asked RunPod to stop it is asked again (and a stop that keeps nothing, terminated). */
const STOP_AGAIN_MS = 2 * 60_000;

export class Rented {
  private readonly seen = new Map<string, Seen>();
  /** What went wrong asking RunPod as a whole (the key, an answer not read): said on every rented card. */
  private error: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private polling: Promise<void> | null = null;
  /** One more read asked for while `polling` runs: it follows that one. */
  private pollAgain: Promise<void> | null = null;
  /** A read is saying "setup" itself: not a change to read again for. */
  private announcing = false;
  /** Stopped for good (Afflatus shutting down): no read starts, a follow-up read included. */
  private stopped = false;
  /** A deploy under way: a second one (another tab, Deploy again pressed twice) waits for it to end. */
  private deploying = false;
  private balanceSeen: { at: number; value: number | null; spendPerHr: number | null } | null = null;
  /** RunPod's bill since the start of the month, as last read (null: RunPod did not give it). */
  private billSeen: { at: number; from: number; records: BillRecord[] | null } | null = null;
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
  /** How long a deploy whose answer was lost waits before it looks again for the pod RunPod may have made (shorter in tests). */
  lookAgainMs = 8_000;
  /** How often a Start asks RunPod whether a pod just stopped is stopped yet. */
  settleEveryMs = 2_000;
  /** Where RunPod is asked, for a key: a test's stand-in. */
  client: (key: string) => Runpod = (key) => new Runpod(key);
  now: () => number = Date.now;
  /** How long a render on a pod may stay silent past its forecast before it is failed as stuck (shorter in tests). */
  stuckMs = STUCK_MS;

  constructor(
    private readonly db: Db,
    private readonly queue: { wants(machine: string): Promise<boolean>; runningOn(machine: string): boolean; quietFor(machine: string): number; endStuck(machine: string, why: string): Promise<boolean> },
    private readonly events: EventEmitter,
    private readonly comfyOf: (machine: string) => Promise<Comfy | null>,
  ) {}

  /** Start reading RunPod, in the background; again at once when the settings change. */
  run(): void {
    if (this.running) return;
    this.running = true;
    this.kick(0);
    // a change of the setup (a machine added, a cap changed) is read at once; never the one a read itself announces, or each
    // read would start the next
    this.events.on("setup", () => {
      if (!this.announcing) void this.poll().catch(() => {});
    });
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
    // a pod starting or stopping moves within seconds; one provisioning pulls its image, minutes: read at the usual pace
    const fast = [...this.seen.values()].some((s) => s.stopping || s.pod?.status === "STARTING");
    this.kick(fast ? this.fastMs : this.everyMs);
  }

  stop(): void {
    this.running = false;
    this.stopped = true;
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

  /** A deployed pod answered for the first time: the files its deploy asked for, and the ones it left out (services.ts hands them to podFiles). */
  onUp: ((machine: string, files: PresetFile[], leaveOut: Array<{ file: string; folder: string }>) => void) | null = null;

  /** The files a machine's pod still waits for, and all it was given (services.ts: podFiles); null when not known. */
  filesLeft: ((machine: string) => { left: number; total: number }) | null = null;

  /** Machines deployed only to fill their volume: they take no render. */
  private filling = new Set<string>();

  /** Whether a machine can take work: a rented one only while its pod runs and is not being stopped. Null: it can. */
  unavailable(machine: string): string | null {
    if (this.filling.has(machine)) return "filling its volume";
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
      volume: Boolean(pod && (pod.networkVolume || pod.diskGb > 0)),
      otherPorts: pod ? pod.ports.filter((p) => p !== `${COMFY_PORT}/http`) : [],
      closedPorts: machine.rented.closedPorts,
      watchdog: status === "RUNNING" ? s?.watchdog ?? "unknown" : "unknown",
      answers: status === "RUNNING" ? s?.answers ?? null : null,
      idleLeftMs: status === "RUNNING" && !s?.stopping && idleMs > 0 && s?.busyAt && !this.queue.runningOn(machine.id) ? Math.max(0, idleMs - (this.now() - s.busyAt)) : null,
      capped: s?.stopAfter ?? false,
      stopping: s?.stopping ?? false,
      stoppedBy: s?.stoppedBy ?? null,
      booting: Boolean(machine.rented.deployedAt) && (status === "RUNNING" || (TRANSITIONAL.has(status) && status !== "UNKNOWN")) && !s?.answered,
      error: s?.error ?? this.error ?? s?.bootNote ?? (s?.stoppedBy === "gpu" ? s.gpuFailed : null) ?? this.unanswered(machine, s ?? null, status, bootLimit(machine)),
    };
  }

  /** What its card says of a pod RunPod has running that nothing answers on: its container may not have started. */
  private unanswered(m: Machine, s: Seen | null, status: RentedView["status"], limit: number): string | null {
    if (status !== "RUNNING" || !s?.upAt || s.answered) return null;
    // a deployed pod's first start (its image pulled onto the host, then ComfyUI): a normal step for some minutes, said
    // as one on its card; only one that drags is said here
    const deployedAt = m.rented!.deployedAt ? Date.parse(m.rented!.deployedAt) : Number.NaN;
    if (Number.isFinite(deployedAt)) {
      const minutes = Math.round((this.now() - deployedAt) / 60_000);
      return this.now() - deployedAt < DEPLOY_SLOW_MS ? null : `Its first start is taking long: nothing answers on ${COMFY_PORT} after ${minutes} min (an image pull this slow, or a container that does not start: its logs on RunPod). Billed meanwhile; terminated at ${limit / 60_000} min if it is not up.`;
    }
    if (this.now() - s.upAt < BOOT_SLOW_MS) return null;
    return `RunPod says it is running, but nothing answers on ${COMFY_PORT} after ${Math.round((this.now() - s.upAt) / 60_000)} min: its image may still be pulling, or its container did not start (look at its logs on RunPod). It is billed meanwhile; with no answer by ${limit / 60_000} min, its idle action applies.`;
  }

  /** The GPUs a pod can be deployed on now, on that cloud (Deploy a GPU). */
  async gpus(cloud: PodSpec["cloud"]): Promise<GpuOffer[]> {
    const s = await readSettings(this.db);
    if (!s.runpodKey) throw httpError("No RunPod API key: set it in Settings › Rented GPUs.", 409);
    return this.client(s.runpodKey).gpus(cloud).catch((err: Error) => {
      throw httpError(err.message, 502);
    });
  }

  /** The account's network volumes (Deploy a GPU, Settings): each with the pod running on it, when one is. */
  async volumes(): Promise<VolumeView[]> {
    const s = await readSettings(this.db);
    if (!s.runpodKey) throw httpError("No RunPod API key: set it in Settings › Rented GPUs.", 409);
    const client = this.client(s.runpodKey);
    const [volumes, pods] = await Promise.all([client.volumes(), client.pods()]).catch((err: Error) => {
      throw httpError(err.message, 502);
    });
    const kept = await keptHoldings(this.db);
    await noticeVolumes(this.db, volumes, kept, this.now());
    return viewVolumes(volumes, pods, s.machines, kept, s.volumeUnusedDays, this.now());
  }

  /** When each volume's folders were last listed (ms), so that a pod on it is asked at most every VOLUME_LIST_MS. */
  private volumeListed = new Map<string, number>();

  /**
   * What the volume a pod runs on holds, listed through its ComfyUI and kept (what a volume holds once no pod is on it),
   * at most every few minutes; and that the volume was used now. Never in the way of the poll: a failure is only said.
   */
  private async noteVolume(m: Machine, volume: string): Promise<void> {
    const last = this.volumeListed.get(volume) ?? 0;
    if (this.now() - last < VOLUME_LIST_MS) return;
    this.volumeListed.set(volume, this.now());
    const comfy = await this.comfyOf(m.id);
    if (!comfy) return;
    await recordHoldings(this.db, volume, comfy, m.name || m.id, SEARCHED_FOLDERS, this.now()).catch((err: Error) => console.warn(`[rented] what the volume of ${m.name || m.id} holds was not read: ${err.message}`));
  }

  /** A network volume made, as the user asked (its monthly price said before): billed every month from now, pod or not. */
  async makeVolume(name: string, size: number, dataCenter: string): Promise<NetworkVolume> {
    const s = await readSettings(this.db);
    if (!s.runpodKey) throw httpError("No RunPod API key: set it in Settings › Rented GPUs.", 409);
    if (!Number.isInteger(size) || size < VOLUME_MIN_GB || size > VOLUME_MAX_GB) throw httpError(`A volume is ${VOLUME_MIN_GB} to ${VOLUME_MAX_GB} GB.`);
    const made = await this.client(s.runpodKey).createVolume(name, size, dataCenter).catch((err: Error) => {
      throw httpError(err.message, 502);
    });
    console.log(`[rented] volume ${made.name} made in ${made.dataCenter}, ${made.size} GB`);
    this.storageSeen = null;
    this.events.emit("setup");
    return made;
  }

  /** A network volume made larger: RunPod never makes one smaller. */
  async growVolume(id: string, size: number): Promise<void> {
    const s = await readSettings(this.db);
    if (!s.runpodKey) throw httpError("No RunPod API key: set it in Settings › Rented GPUs.", 409);
    const client = this.client(s.runpodKey);
    const volume = (await client.volumes().catch((err: Error) => {
      throw httpError(err.message, 502);
    })).find((v) => v.id === id);
    if (!volume) throw httpError("That network volume is not on this account any more.", 404);
    if (!Number.isInteger(size) || size <= volume.size || size > VOLUME_MAX_GB) throw httpError(`A volume only grows: more than ${volume.size} GB, ${VOLUME_MAX_GB} at most.`);
    await client.growVolume(id, size).catch((err: Error) => {
      throw httpError(err.message, 502);
    });
    this.events.emit("setup");
  }

  /** A network volume deleted with all it holds (its billing ends): never while a pod is mounted on it, stopped ones too. */
  async deleteVolume(id: string): Promise<void> {
    const s = await readSettings(this.db);
    if (!s.runpodKey) throw httpError("No RunPod API key: set it in Settings › Rented GPUs.", 409);
    const client = this.client(s.runpodKey);
    const [volumes, pods] = await Promise.all([client.volumes(), client.pods()]).catch((err: Error) => {
      throw httpError(err.message, 502);
    });
    const volume = volumes.find((v) => v.id === id);
    if (!volume) throw httpError("That network volume is not on this account any more.", 404);
    const on = mountedOn(id, pods, s.machines);
    if (on.length) throw httpError(`The volume "${volume.name}" is mounted on ${on.map((p) => `${p.name} (${p.status === "EXITED" ? "stopped" : p.status.toLowerCase()})`).join(", ")}: terminate ${on.length === 1 ? "that pod" : "those pods"} first.`, 409);
    await client.deleteVolume(id).catch((err: Error) => {
      throw httpError(err.message, 502);
    });
    console.log(`[rented] volume ${volume.name} deleted`);
    this.storageSeen = null;
    this.events.emit("setup");
  }

  /**
   * A GPU deployed, as the user asked in the Deploy dialog: a new pod of that GPU, in its freest data center first (in the
   * volume's, with one), its ComfyUI locked from its first second by a token kept as a RunPod secret, its watchdog armed,
   * only ComfyUI's port open; added as a machine at once, and the choices kept for the next deploy. Refused at a spending
   * cap. Billed from now: Afflatus never deploys on its own.
   */
  async deploy(ask: DeployAsk, o: { fill?: boolean } = {}): Promise<{ id: string }> {
    if (this.deploying) throw httpError("A deploy is under way: wait for it to end.", 409);
    this.deploying = true;
    try {
      return await this.deployNow(ask, o.fill ?? false);
    } finally {
      this.deploying = false;
    }
  }

  /**
   * The cheapest GPU in stock where a volume is, to fill it: what Fill from a set… deploys (said with its price first).
   * Null when none is free there now.
   */
  async fillGpu(volume: string): Promise<{ gpu: GpuOffer; volume: NetworkVolume } | null> {
    const found = (await this.volumes()).find((v) => v.id === volume);
    if (!found) throw httpError("That network volume is not on this account any more.", 404);
    if (found.usedBy) throw httpError(inUseSaid(found.name, found.usedBy), 409);
    const offers = await this.gpus("SECURE");
    const gpu = offers.filter((g) => g.dataCenters.some((d) => d.id === found.dataCenter && d.availability !== "NONE")).sort((a, b) => a.price - b.price)[0];
    return gpu ? { gpu, volume: found } : null;
  }

  /**
   * A pod deployed only to fill a volume with these files (Fill from a set…): the cheapest GPU in stock there, Afflatus's
   * image, no render given to it, terminated once its files are in. Billed from now, as any deploy, on the user's click.
   */
  async fill(volume: string, set: string, files: PresetFile[]): Promise<{ id: string }> {
    const found = await this.fillGpu(volume);
    if (!found) throw httpError("No GPU is free where that volume is now: try again later.", 409);
    return this.deploy({ gpu: found.gpu.id, cloud: "SECURE", template: "afflatus", volume, disk: 20, idleMinutes: 5, idleDo: "terminate", watchdogMinutes: 15, set, files, leaveOut: [], accept: [], again: false }, { fill: true });
  }

  private async deployNow(ask: DeployAsk, fill = false): Promise<{ id: string }> {
    const s = await readSettings(this.db);
    if (!s.runpodKey) throw httpError("No RunPod API key: set it in Settings › Rented GPUs.", 409);
    // a pod made that cannot be kept as a machine would have to be terminated at once, its first seconds billed
    if (s.machines.length >= MAX_MACHINES) throw httpError(`Afflatus keeps ${MAX_MACHINES} ComfyUIs at most: remove one to deploy.`, 409);
    const spent = await this.spent();
    if ((s.rentCaps.day > 0 && spent.today >= s.rentCaps.day) || (s.rentCaps.month > 0 && spent.month >= s.rentCaps.month)) {
      throw httpError("A spending cap is reached: raise it in Settings › Rented GPUs to deploy.", 409);
    }
    // an image RunPod could not pull would leave a pod provisioning, billed, until its boot limit: asked of its registry first
    const client = this.client(s.runpodKey);
    const [offers, volumes, pods] = await Promise.all([client.gpus(ask.cloud), ask.volume ? client.volumes() : Promise.resolve([]), ask.volume ? client.pods() : Promise.resolve([])]).catch((err: Error) => {
      throw httpError(err.message, 502);
    });
    const offer = offers.find((g) => g.id === ask.gpu);
    if (!offer) throw httpError(`RunPod does not offer that GPU on ${ask.cloud === "COMMUNITY" ? "Community" : "Secure"} Cloud now: pick another.`, 409);
    const volume = ask.volume ? volumes.find((v) => v.id === ask.volume) ?? null : null;
    if (ask.volume && !volume) throw httpError("That network volume is not on this account any more: pick another, or deploy without one.", 409);
    // one running pod per volume: a second would write over what the first keeps there
    const taken = volume ? usedBy(volume.id, pods, s.machines) : null;
    if (volume && taken) throw httpError(inUseSaid(volume.name, taken), 409);
    const listed = offer.dataCenters.filter((d) => d.availability !== "NONE" && (!volume || d.id === volume.dataCenter)).sort((a, b) => FREEST[a.availability] - FREEST[b.availability]).map((d) => d.id);
    // RunPod said it is free without saying where: wherever it puts it (never with a volume, which has its own)
    const places: Array<string | null> = listed.length || volume || offer.dataCenters.length || offer.availability === "NONE" ? listed : [null];
    const none = volume ? `No ${offer.name} free in ${volume.dataCenter}, where the volume "${volume.name}" is: pick another GPU, or deploy without the volume.` : `No ${offer.name} free any more: it was taken since the list was read. Pick another GPU.`;
    if (!places.length) throw httpError(none, 409);
    // the image's build for this GPU: CUDA 13 where its hosts offer it, else 12.8 (and 12.8 again where no host of 13 is free);
    // each asked of its registry first: one RunPod could not pull would leave a pod billed until its boot limit
    const builds = [];
    for (const build of ask.template === "afflatus" && offer.cuda13 ? [imageFor("afflatus", true), imageFor("afflatus", false)] : [imageFor(ask.template, false)]) {
      if ((await this.imageReady(build.image)) !== false) builds.push(build);
    }
    if (!builds.length) {
      throw httpError(ask.template === "afflatus" ? "The Afflatus image is not published yet, or not public: nothing was deployed. Deploy with RunPod's ComfyUI meanwhile." : "RunPod's ComfyUI image cannot be pulled from Docker Hub now: nothing was deployed.", 409);
    }
    // its token kept as a secret of the account, named now (the pod has no id yet); in its environment when the key cannot
    // make secrets, as for a pod added
    const token = newToken();
    const tag = randomUUID().slice(0, 8);
    const secret = `afflatus-${tag}`;
    const kept = await client.putSecret(secret, token, `Afflatus: the lock of a deployed ${offer.name}'s ComfyUI`).then(() => true, (err: Error) => {
      console.warn(`[rented] deploy: its token kept in its environment, RunPod made no secret of it (${err.message})`);
      return false;
    });
    // without a volume a stop keeps nothing: the watchdog terminates it, as its idle does
    const end = volume ? ask.idleDo : "terminate";
    const spec: PodSpec = {
      name: `Afflatus ${offer.name} ${tag}`, image: builds[0]!.image, minCuda: builds[0]!.minCuda, gpu: offer.id, cloud: ask.cloud, dataCenter: null, disk: volume ? Math.min(ask.disk, 40) : ask.disk,
      volume: volume?.id ?? null, ports: [`${COMFY_PORT}/http`], env: { [LOCK_ENV]: kept ? secretRef(secret) : token, [WATCHDOG_ENV]: String(ask.watchdogMinutes), [WATCHDOG_ACTION_ENV]: end },
    };
    let pod: Pod | null = null;
    try {
      // one data center after the other, the freest first: RunPod takes one GPU type and one place at a time, and says only
      // in words that none was free there
      for (const build of builds) {
        for (const place of places) {
          pod = await client.create({ ...spec, ...build, dataCenter: place }).catch(async (err: unknown) => {
            if (noCapacity(err)) return null;
            // no answer, a 5xx or an answer not read: RunPod may have made it all the same. Looked for by its name, it is
            // kept (a machine, watched like any) rather than left billing with nothing to stop it
            const status = (err as RunpodError).status;
            if (!(err instanceof RunpodShape) && status !== 0 && !(status >= 500)) throw err;
            for (let tries = 0; tries < 4; tries++) {
              if (tries) await new Promise((r) => setTimeout(r, this.lookAgainMs));
              const made = await client.pods().then((all) => all.find((p) => p.name === spec.name && p.status !== "TERMINATED") ?? null, () => null);
              if (made) return made;
            }
            throw err;
          });
          if (pod) break;
        }
        if (pod) break;
      }
    } catch (err) {
      if (kept) await client.deleteSecret(secret).catch(() => {});
      throw httpError((err as Error).message, (err as RunpodError).status === 402 ? 409 : 502);
    }
    if (!pod) {
      if (kept) await client.deleteSecret(secret).catch(() => {});
      throw httpError(none, 409);
    }
    const made = pod;
    const id = podMachineId(made.id);
    try {
      await updateSettings(this.db, (current) => {
        const names = new Set(current.machines.map((m) => m.name));
        let name = offer.name.slice(0, 36);
        for (let n = 2; names.has(name); n++) name = `${offer.name.slice(0, 36)} ${n}`;
        // without a volume a stop keeps nothing and its GPU may be taken meanwhile: terminated, as for a pod added
        const rented = { provider: "runpod" as const, pod: made.id, idleMinutes: ask.idleMinutes, idleDo: volume ? ask.idleDo : ("terminate" as const), watchdogMinutes: ask.watchdogMinutes, openPorts: false, closedPorts: [], secret: kept ? secret : "", deployed: true, deployedAt: new Date(this.now()).toISOString(), cloud: ask.cloud, volume: volume?.id ?? "", fill, files: ask.files, leaveOut: ask.leaveOut };
        const machines = [...current.machines, { id, name, url: podUrl(made.id), dir: "", takes: "all" as const, families: {}, token, rented }];
        // the next deploy starts from the same choices; the files are this one's. A fill is not a deploy of the user's choices
        return fill ? { machines } : { machines, lastDeploy: { ...ask, files: [], leaveOut: [], accept: [] } };
      });
    } catch (err) {
      // not kept as a machine: nothing here would ever stop it, so it goes at once
      await client.act(made.id, "terminate").catch(() => {});
      if (kept) await client.deleteSecret(secret).catch(() => {});
      throw err;
    }
    // a fill takes no render from its first second, not from the next read
    if (fill) this.filling.add(id);
    console.log(`[rented] deployed ${offer.name} in ${made.dataCenter ?? "a data center"} (${ask.template}, ${volume ? `volume ${volume.name}` : "no volume"})`);
    this.events.emit("setup");
    void this.poll();
    return { id };
  }

  /** The user's pods on RunPod, for adding one (Settings › Rented GPUs): which expose ComfyUI, which are added already. */
  async pods(): Promise<Array<Pod & { comfy: boolean; added: string | null }>> {
    const s = await readSettings(this.db);
    if (!s.runpodKey) throw httpError("No RunPod API key: set it first.", 409);
    const pods = await this.client(s.runpodKey).pods().catch((err: Error) => {
      throw httpError(err.message, 502);
    });
    // never a pod's environment: it may hold a token in the clear (a pod whose key could not make a secret), or the user's own
    return pods.filter((p) => p.status !== "TERMINATED").map(({ env: _env, ...p }) => ({ ...p, env: {}, comfy: exposesComfy(p as Pod), added: s.machines.find((m) => m.rented?.pod === p.id)?.id ?? null }));
  }

  /**
   * Read RunPod now: every rented machine's pod, their sessions, the watchdog's "still here", idle and caps. Asked while a
   * read runs, one more follows it (shared by everyone who asks meanwhile): the running one read the settings before the
   * ask, and a cap or an idle time just changed would otherwise wait for the next round.
   */
  poll(): Promise<void> {
    // Afflatus shutting down: nothing more is read (the database may be closed already)
    if (this.stopped) return Promise.resolve();
    if (this.polling) {
      // after the read under way, whether it went well or not (a failed one must not swallow the read asked for)
      this.pollAgain ??= this.polling.catch(() => {}).then(() => {
        this.pollAgain = null;
        return this.poll();
      });
      return this.pollAgain;
    }
    this.polling = this.pollOnce().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  /** What was spent, read once per poll and shared by every pod's cap check in it. */
  private spentThisPoll: Promise<{ today: number; month: number }> | null = null;

  private async pollOnce(): Promise<void> {
    this.spentThisPoll = null;
    const settings = await readSettings(this.db);
    const rented = settings.machines.filter((m) => m.rented);
    this.filling = new Set(rented.filter((m) => m.rented!.fill).map((m) => m.id));
    for (const id of this.seen.keys()) if (!rented.some((m) => m.id === id)) this.seen.delete(id);
    // a run still open for a machine that is no longer this pod (removed from Afflatus while it ran, or added again as
    // another pod) is closed now, where it was last seen running: nothing would ever close it otherwise
    const open = await this.db.selectFrom("rent_sessions").select(["id", "machine_id", "pod", "seen_at"]).where("ended_at", "is", null).execute();
    for (const r of open.filter((x) => !rented.some((m) => m.id === x.machine_id && m.rented!.pod === x.pod))) {
      await this.db.updateTable("rent_sessions").set({ ended_at: r.seen_at ?? new Date(this.now()).toISOString() }).where("id", "=", r.id).execute();
    }
    if (!rented.length && !settings.leftSecrets.length) return;
    if (!settings.runpodKey) {
      if (!rented.length) return;
      this.error = "No RunPod API key: set it in Settings › Rented GPUs.";
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
    await this.sweepSecrets(settings, pods);
    await this.readBalance(settings.runpodKey);
    let changed = false;
    for (const m of rented) {
      const s = this.seenOf(m.id);
      if (s.epoch !== epochs.get(m.id)) continue;
      try {
        changed = (await this.follow(m, s, pods.find((p) => p.id === m.rented!.pod && p.status !== "TERMINATED") ?? null, settings.rentCaps, settings.runpodKey)) || changed;
        s.error = null;
      } catch (err) {
        // one pod RunPod refuses something for says so on its card; the others go on being watched
        changed = changed || s.error !== (err as Error).message;
        s.error = (err as Error).message;
      }
    }
    if (changed) {
      this.events.emit("queue");
      // a pod that came up, or went: what waited for it may go, what it held is read again
      this.announcing = true;
      try {
        this.events.emit("setup");
      } finally {
        this.announcing = false;
      }
    }
  }

  /**
   * How long RunPod's balance lasts at what the account spends now (ms), as last read; null when it is not known (a job is
   * not held back then). At zero RunPod stops every pod: a render longer than this is not sent to a rented one.
   */
  runwayMs(): number | null {
    const b = this.balanceSeen;
    if (!b || b.value === null || !b.spendPerHr || b.spendPerHr <= 0) return null;
    return Math.max(0, (b.value / b.spendPerHr) * HOUR - (this.now() - b.at));
  }

  /** Whether a job of this length may be sent to a rented pod now: it ends before the balance does, with a margin. */
  fitsBalance(ms: number | null): { ok: boolean; leftMs: number | null } {
    const left = this.runwayMs();
    if (left === null || ms === null) return { ok: true, leftMs: left };
    return { ok: ms + RUNWAY_MARGIN_MS <= left, leftMs: left };
  }

  /** The balance and what is spent an hour, read again at most once a minute. */
  private async readBalance(key: string): Promise<void> {
    if (this.now() < this.quietUntil || (this.balanceSeen && this.now() - this.balanceSeen.at <= 60_000)) return;
    const got = await this.client(key).balance().catch(() => ({ balance: null, spendPerHr: null }));
    this.balanceSeen = { at: this.now(), value: got.balance, spendPerHr: got.spendPerHr };
  }

  /** RunPod's bill since `from` (ms), read again every few minutes; null when RunPod does not give it. */
  private async bill(key: string, from: number): Promise<BillRecord[] | null> {
    if (this.billSeen && this.billSeen.from === from && (this.now() - this.billSeen.at < BILL_EVERY_MS || this.now() < this.quietUntil)) return this.billSeen.records;
    const records = await this.client(key).billing(from, this.now()).catch((err: Error) => {
      console.warn(`[rented] RunPod's bill not read: ${err.message}`);
      return null;
    });
    this.billSeen = { at: this.now(), from, records };
    return records;
  }

  /** The secrets of pods removed from Afflatus (leftSecrets) whose pod is gone from RunPod now: deleted, and forgotten. */
  private async sweepSecrets(settings: Settings, pods: Pod[]): Promise<void> {
    const gone = settings.leftSecrets.filter((l) => !pods.some((p) => p.id === l.pod && p.status !== "TERMINATED"));
    if (!gone.length) return;
    const client = this.client(settings.runpodKey);
    const done: string[] = [];
    for (const l of gone) {
      await client.deleteSecret(l.secret).then(() => done.push(l.secret), (err: Error) => console.warn(`[rented] the secret of a removed pod not deleted (${err.message})`));
    }
    if (done.length) await updateSettings(this.db, (current) => ({ leftSecrets: current.leftSecrets.filter((l) => !done.includes(l.secret)) }));
  }

  /**
   * A machine removed from Afflatus by the user (its card's Remove). A rented pod is left as it is on RunPod, running or not:
   * its secret stays while the pod does (it reads it at its start), and goes once the pod is gone (sweepSecrets).
   */
  async remove(machine: string): Promise<void> {
    // a pod still running (or starting) is billed with nothing here to stop it once it is out of Afflatus: stopped first
    const status = this.seen.get(machine)?.pod?.status;
    if (status && BILLED.has(status)) throw httpError("It is running on RunPod, billed: stop or terminate it first, then remove it.", 409);
    let found = false;
    await updateSettings(this.db, (current) => {
      const m = current.machines.find((x) => x.id === machine);
      if (!m) return null;
      found = true;
      if (current.machines.length < 2) throw httpError("at least one ComfyUI is needed", 409);
      return {
        machines: current.machines.filter((x) => x.id !== machine),
        ...(m.rented ? { leftSecrets: [...current.leftSecrets.filter((l) => l.pod !== m.rented!.pod), { secret: secretOf(m), pod: m.rented.pod }] } : {}),
      };
    });
    if (!found) throw httpError("there is no ComfyUI with that id", 404);
    this.seen.delete(machine);
    this.events.emit("setup");
  }

  /**
   * Whether each image a deploy may run can be pulled now (podImage.ts), as Deploy a GPU shows it; null where the registry
   * did not answer. Asked again after a minute (one not there yet may be published meanwhile), ten when it is there.
   */
  async images(): Promise<Record<keyof typeof POD_IMAGES, boolean | null>> {
    const [afflatus, runpod] = await Promise.all([this.imageReady(imageFor("afflatus", true).image), this.imageReady(POD_IMAGES.runpod())]);
    return { afflatus, runpod };
  }

  private imagesSeen = new Map<string, { at: number; ready: boolean | null }>();
  /** The registry's answer for an image (a test's stand-in in place of imagePublic). */
  imageCheck: (image: string) => Promise<boolean | null> = (image) => imagePublic(image);

  private async imageReady(image: string): Promise<boolean | null> {
    const seen = this.imagesSeen.get(image);
    if (seen && this.now() - seen.at < (seen.ready ? 10 * 60_000 : 60_000)) return seen.ready;
    const ready = await this.imageCheck(image);
    this.imagesSeen.set(image, { at: this.now(), ready });
    return ready;
  }

  /** The pod's secret (its token) deleted on RunPod, once: the pod is gone. */
  private async dropSecret(m: Machine, s: Seen, key: string): Promise<void> {
    if (s.secretDropped) return;
    s.secretDropped = true;
    await this.client(key).deleteSecret(secretOf(m)).catch((err: Error) => {
      s.secretDropped = false;
      console.warn(`[rented] ${m.name || m.id}: its secret on RunPod not deleted (${err.message})`);
    });
  }

  /** One machine's pod as just read: its session, "still here", its lock, idle and caps. Says whether anything changed. */
  private async follow(m: Machine, s: Seen, pod: Pod | null, caps: { day: number; month: number }, key: string): Promise<boolean> {
    const before = s.pod;
    s.missing = pod ? 0 : s.missing + 1;
    // gone from RunPod (terminated there, or by its watchdog): only once RunPod says so of that pod itself, at a second read
    // without it. Its list may lag a pod just made (whose secret it still has to read at its boot), an answer of RunPod's may
    // come back empty, and a key of another account lists none of these: none of that is a pod gone
    const gone = !pod && s.missing >= 2 && !m.rented!.deployedAt && (await this.client(key).exists(m.rented!.pod)) === false;
    if (gone) await this.dropSecret(m, s, key);
    // a deployed pod that came up once (its ComfyUI answered) and is gone: nothing is left of it, its machine goes too. Never
    // for one that did not come up (its card says why)
    if (gone && m.rented!.deployed && s.stoppedBy !== "gpu" && s.stoppedBy !== "boot") {
      await this.forget(m, s);
      console.log(`[rented] ${m.name || m.id}: gone from RunPod, taken out of Afflatus`);
      return true;
    }
    // a pod gone stays gone: said once, not at every read
    const changed = !s.read || (before?.status ?? null) !== (pod?.status ?? null) || Boolean(pod?.cost && pod.cost !== s.rate);
    s.read = true;
    s.pod = pod;
    if (pod?.cost) s.rate = pod.cost;
    // the rate of its last run here, until RunPod says one (it says 0 while the pod is stopped)
    s.rate ??= (await this.db.selectFrom("rent_sessions").select("rate").where("pod", "=", m.rented!.pod).orderBy("started_at", "desc").executeTakeFirst())?.rate || null;
    await this.session(m, pod, s);
    // deployed and never up yet, for too long: its image does not pull, or its container does not start; billed for nothing
    const deployedAt = m.rented!.deployedAt ? Date.parse(m.rented!.deployedAt) : Number.NaN;
    if (pod && TRANSITIONAL.has(pod.status) && Number.isFinite(deployedAt) && this.now() - deployedAt >= DEPLOYED_BOOT_LIMIT_MS) {
      await this.act(m, "terminate", "boot");
      return true;
    }
    // any pod starting or provisioning that long (one added and started, its host unable to bring it up) is billed for
    // nothing: stopped as its idle choice says, as a boot that never answers is
    s.startingSince = pod && TRANSITIONAL.has(pod.status) ? s.startingSince ?? this.now() : null;
    if (s.startingSince !== null && !Number.isFinite(deployedAt) && this.now() - s.startingSince >= bootLimit(m) && !s.stopping) {
      await this.act(m, m.rented!.idleDo, "boot");
      return true;
    }
    // a deployed pod without a volume found stopped (its watchdog stopped it while Afflatus was away, or RunPod did): it keeps
    // nothing and its GPU may be taken, so nothing is left of it on the account. A stop of the user's own is left as it is
    if (pod?.status === "EXITED" && m.rented!.deployed && !pod.networkVolume && pod.diskGb === 0 && s.stoppedBy !== "you" && !m.rented!.userStopped && !s.stopping) {
      await this.act(m, "terminate", "watchdog");
      return true;
    }
    if (pod?.status !== "RUNNING") {
      s.busyAt = null;
      s.stopAfter = false;
      s.cappedAt = null;
      s.lockTried = false;
      s.answers = null;
      s.upAt = null;
      s.answered = false;
      if (s.stopping && pod?.status !== "STARTING") {
        s.stopping = false;
        s.stoppingSince = null;
      }
      if (!pod || !TRANSITIONAL.has(pod.status)) s.bootNote = null;
      return changed;
    }
    if (s.stoppedBy && !before) s.stoppedBy = null;
    // being stopped and still running: no "still here" (its own watchdog may stop it if RunPod does not), and after a while the
    // stop is asked again (a pod that keeps nothing terminated)
    if (s.stopping) {
      if (s.stoppingSince !== null && this.now() - s.stoppingSince >= STOP_AGAIN_MS) {
        const why = s.stoppedBy ?? "idle";
        s.stopping = false;
        s.stoppingSince = null;
        console.warn(`[rented] ${m.name || m.id}: still running ${STOP_AGAIN_MS / 60_000} min after its stop: asked again`);
        await this.act(m, pod.networkVolume || pod.diskGb > 0 ? m.rented!.idleDo : "terminate", why);
      }
      return changed;
    }
    s.upAt ??= this.now();
    const answers = await this.alive(m, s);
    // a GPU that does not work on its host never will: terminated at once, not at its boot limit
    if (s.gpuFailed && !this.queue.runningOn(m.id)) {
      await this.act(m, "terminate", "gpu");
      return true;
    }
    if (answers) s.answered = true;
    // its first answer since it was deployed: later starts count from when it runs. How long it took is kept (the Deploy
    // dialog's "up in"), and what its deploy asked for is handed to it now
    if (answers && m.rented!.deployedAt) {
      if (Number.isFinite(deployedAt)) await recordMeasure(this.db, { kind: "boot", cloud: m.rented!.cloud ?? null, bytes: 0, ms: this.now() - deployedAt }).catch(() => {});
      const { files, leaveOut } = m.rented!;
      await updateSettings(this.db, (current) => ({ machines: current.machines.map((x) => (x.id === m.id && x.rented ? { ...x, rented: { ...x.rented, deployedAt: "", files: [], leaveOut: [] } } : x)) }));
      if (files.length || leaveOut.length) this.onUp?.(m.id, files, leaveOut);
    }
    // up this long and its ComfyUI never answered: its container failed to start, or ComfyUI on it did; billed for nothing.
    // A deployed pod's first boot counts from its deploy (its image pulled first); one that never came up is terminated
    const bootFrom = Number.isFinite(deployedAt) ? Math.min(deployedAt, s.upAt) : s.upAt;
    if (!s.answered && this.now() - bootFrom >= bootLimit(m) && !this.queue.runningOn(m.id)) {
      await this.act(m, Number.isFinite(deployedAt) ? "terminate" : m.rented!.idleDo, "boot");
      return true;
    }
    // up and open (RunPod did not take its token for the start, or it was added running): locked now, once a session
    if (answers && !s.lockTried && this.lockPod && (await this.isOpen(m))) {
      s.lockTried = true;
      await this.lockPod(m.id).catch((err: Error) => console.warn(`[rented] ${m.name || m.id} not locked: ${err.message}`));
    }
    if (answers && pod?.volumeId) void this.noteVolume(m, pod.volumeId);
    // a pod filling its volume: terminated once its files are in (what the volume holds listed first), kept until then
    if (m.rented!.fill) {
      const files = this.filesLeft?.(m.id);
      if (answers && !m.rented!.deployedAt && files && files.left === 0) {
        if (pod?.volumeId) {
          this.volumeListed.delete(pod.volumeId);
          await this.noteVolume(m, pod.volumeId);
        }
        await this.act(m, "terminate", "filled");
        return true;
      }
      s.busyAt = this.now();
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
    if (pod && BILLED.has(pod.status)) {
      s.seenRunningAt = now;
      if (open) {
        // a run first seen before RunPod said its rate (0) takes the rate as soon as it says one: it was counted as free
        await this.db.updateTable("rent_sessions").set({ seen_at: iso, ...(open.rate === 0 && pod.cost > 0 ? { rate: pod.cost } : {}) }).where("id", "=", open.id).execute();
        return;
      }
      // from when the pod says it started, but never over a session already counted; a deployed pod's first run from its
      // deploy, when the money starts
      const last = await this.db.selectFrom("rent_sessions").select("ended_at").where("machine_id", "=", m.id).orderBy("ended_at", "desc").executeTakeFirst();
      const deployedAt = m.rented!.deployedAt ? Date.parse(m.rented!.deployedAt) : Number.NaN;
      const started = pod.startedAt ? Date.parse(pod.startedAt) : now;
      const from = Math.max(!last && Number.isFinite(deployedAt) ? Math.min(started, deployedAt) : started, last?.ended_at ? Date.parse(last.ended_at) : 0);
      await this.db.insertInto("rent_sessions").values({ id: randomUUID(), machine_id: m.id, pod: pod.id, rate: pod.cost || s.rate || 0, started_at: new Date(Math.min(from, now)).toISOString(), ended_at: null, seen_at: iso }).execute();
    } else if (open) {
      // closed now when it was seen running a moment ago. One that ended while Afflatus was away (off, asleep) is closed at
      // the latest it could have run: its watchdog stops it that long after the last "still here" (RunPod's bill, once
      // written, is the reference: spent() takes it)
      // the last sight of it running: a read of RunPod's, or its ComfyUI taking a "still here" while RunPod could not be read
      const seen = Math.max(s.seenRunningAt ?? (open.seen_at ? Date.parse(open.seen_at) : now), s.aliveAt ?? 0);
      const watch = m.rented!.watchdogMinutes;
      const end = now - seen <= AWAY_MS ? now : watch > 0 ? Math.min(now, seen + (watch + 2) * 60_000) : now;
      await this.db.updateTable("rent_sessions").set({ ended_at: new Date(Math.min(end, now)).toISOString() }).where("id", "=", open.id).execute();
      s.seenRunningAt = null;
    }
  }

  /**
   * "Still here" to the pods last seen running, when RunPod itself cannot be read: Afflatus is not silent for that. Only to a
   * pod with work (a job running there), or still within its idle time and short of a cap: one that would be stopped now
   * hears nothing, so that its own watchdog stops it while Afflatus cannot ask RunPod to.
   */
  private async pingAll(rented: Machine[]): Promise<void> {
    const now = this.now();
    for (const m of rented) {
      const s = this.seen.get(m.id);
      if (s?.pod?.status !== "RUNNING" || s.stopping || s.stopAfter) continue;
      const idle = m.rented!.idleMinutes * 60_000;
      const keep = this.queue.runningOn(m.id) || idle === 0 || (s.busyAt !== null && now - s.busyAt < idle);
      if (keep) await this.alive(m, s).catch(() => false);
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
    // whether ComfyUI answers is its own status: the provider's proxy answers too (a 404 when no container is behind it), and
    // what the watchdog's route answers says only whether the pack is there
    const up = await comfy.client.status().then(() => true, () => false);
    s.answers = up;
    // its ComfyUI not answering: the pack's watchdog in it is not known to be there either. The Afflatus image on a host whose
    // GPU does not work answers on ComfyUI's port in its place, and says so (deploy/runpod/broken.py)
    if (!up) {
      s.watchdog = "unknown";
      if (m.rented!.deployed) {
        const said = await comfy.client.raw("/afflatus/pod", { signal: AbortSignal.timeout(5_000) })
          .then(async (r) => (r.ok ? ((await r.json()) as { afflatus_pod?: string; error?: string }) : null), () => null);
        if (said?.afflatus_pod === "gpu_failed") s.gpuFailed = `Terminated: its GPU did not work on that host (${String(said.error ?? "CUDA error").slice(0, 200)}). Nothing billed after; deploy again, RunPod picks another host.`;
      }
      return false;
    }
    const res = await comfy.client.raw("/afflatus/alive", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ minutes }), signal: AbortSignal.timeout(8000) }).catch(() => null);
    if (res?.ok) s.aliveAt = this.now();
    // `can` false: the pack has no way to stop this pod; refused (a 404, or a 405 from an older ComfyUI whose page answers every
    // address): no pack, or one without the watchdog
    if (res?.ok) {
      const said = (await res.json().catch(() => null)) as { can?: boolean } | null;
      s.watchdog = minutes > 0 && said?.can ? "on" : "none";
    } else if (res) {
      if (res.status !== 401) s.watchdog = "none";
      await res.body?.cancel().catch(() => {});
    }
    return true;
  }

  /** Idle long enough, or a cap reached once its render ends: stopped (or deleted, as its idle choice says). */
  private async keepOrStop(m: Machine, s: Seen, caps: { day: number; month: number }, answers: boolean): Promise<void> {
    const now = this.now();
    // a render ComfyUI has said nothing of for long, past its forecast: failed, so that the pod is free for the next job or
    // its idle time, instead of billed for a render that never ends
    const quiet = this.queue.quietFor(m.id);
    if (quiet >= this.stuckMs && (await this.queue.endStuck(m.id, `Stuck: no progress from ComfyUI for ${Math.round(quiet / 60_000)} min past its forecast on the rented GPU ${m.name || m.id}; failed so that the pod is not billed for a render that never ends`))) {
      console.log(`[rented] ${m.name || m.id}: a render stuck for ${Math.round(quiet / 60_000)} min failed`);
    }
    const running = this.queue.runningOn(m.id);
    // work counts only for a pod whose ComfyUI answers: one that went down would otherwise keep a waiting job "for it" forever
    // not idle before its ComfyUI first answered (a first boot pulling node packs and models): the boot limit covers that
    if (running || !s.answered || (answers && (await this.queue.wants(m.id)))) s.busyAt = now;
    s.busyAt ??= now;
    const spent = await (this.spentThisPoll ??= this.spent());
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
  /** What each pod cost since `month` as Afflatus counts it, and since `today` (rent_sessions). */
  private async counted(month: number, today: number): Promise<Map<string, Counted>> {
    const rows = await this.db.selectFrom("rent_sessions").selectAll().where((eb) => eb.or([eb("ended_at", "is", null), eb("ended_at", ">", new Date(month).toISOString())])).execute();
    const now = this.now();
    const out = new Map<string, Counted>();
    for (const r of rows) {
      const start = Date.parse(r.started_at);
      const end = r.ended_at ? Date.parse(r.ended_at) : now;
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      const part = (from: number) => (end > Math.max(from, start) ? ((end - Math.max(from, start)) / HOUR) * r.rate : 0);
      const c = out.get(r.pod) ?? { today: 0, month: 0, open: false, lastEnd: 0 };
      c.month += part(month);
      c.today += part(today);
      c.open ||= !r.ended_at;
      c.lastEnd = Math.max(c.lastEnd, end);
      out.set(r.pod, c);
    }
    return out;
  }

  /**
   * Today's and this month's cost of the rented GPUs: RunPod's own bill (its GPU and its disk, every pod of the account) for a
   * pod it has billed in full; for one that runs, or ran a short while ago, the higher of RunPod's bill so far and Afflatus's
   * count. A cap is never reached late, and the figures end as RunPod's. Afflatus's count alone when RunPod's bill is not read.
   */
  private async spent(): Promise<{ today: number; month: number; billed: boolean }> {
    const d = new Date(this.now());
    const today = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const month = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    const counted = await this.counted(month, today);
    const key = (await readSettings(this.db)).runpodKey;
    const records = key ? await this.bill(key, month) : null;
    const billed = new Map<string, { today: number; month: number }>();
    for (const r of records ?? []) {
      if (r.end <= month) continue;
      const b = billed.get(r.pod) ?? { today: 0, month: 0 };
      b.month += r.amount;
      if (r.start >= today) b.today += r.amount;
      billed.set(r.pod, b);
    }
    let sumToday = 0;
    let sumMonth = 0;
    for (const pod of new Set([...counted.keys(), ...billed.keys()])) {
      const c = counted.get(pod);
      const b = billed.get(pod);
      const settled = b && (!c || (!c.open && this.now() - c.lastEnd > BILL_SETTLED_MS));
      sumToday += settled ? b.today : Math.max(b?.today ?? 0, c?.today ?? 0);
      sumMonth += settled ? b.month : Math.max(b?.month ?? 0, c?.month ?? 0);
    }
    return { today: sumToday, month: sumMonth, billed: records !== null };
  }

  /** Today's and this month's cost, the caps, RunPod's balance, and what storage costs. */
  async spending(): Promise<Spending> {
    const s = await readSettings(this.db);
    const spent = await this.spent();
    // RunPod is asked at most once a minute: the card reads this every 10 s while a pod runs
    if (s.runpodKey) await this.readBalance(s.runpodKey);
    const balance = this.balanceSeen?.value ?? null;
    const storage = s.runpodKey ? await this.storage(s.runpodKey) : null;
    return { ...spent, caps: s.rentCaps, balance, lowBalance: balance !== null && balance < LOW_BALANCE, spendPerHr: this.balanceSeen?.spendPerHr ?? null, runwayMs: this.runwayMs(), storage };
  }

  private storageSeen: { at: number; value: Storage | null } | null = null;

  /**
   * What storage costs on the account: the volumes' bill this month, the pods' own disks within this month's bill, and
   * what it all costs a month as it stands. Read again every few minutes (it moves by the day); null when RunPod does not
   * answer.
   */
  private async storage(key: string): Promise<Storage | null> {
    if (this.storageSeen && (this.now() - this.storageSeen.at < BILL_EVERY_MS || this.now() < this.quietUntil)) return this.storageSeen.value;
    const d = new Date(this.now());
    const month = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    const client = this.client(key);
    const [volumes, pods, volumeBills, podBills] = await Promise.all([
      client.volumes().catch(() => null),
      client.pods().catch(() => null),
      client.volumeBilling(month, this.now()).catch(() => null),
      this.bill(key, month),
    ]);
    let value: Storage | null = null;
    if (volumes && pods) {
      const disks = pods.filter((p) => p.status !== "TERMINATED" && p.diskGb > 0);
      const kept = await keptHoldings(this.db);
      await noticeVolumes(this.db, volumes, kept, this.now());
      const settings = await readSettings(this.db);
      const unused = viewVolumes(volumes, pods, settings.machines, await keptHoldings(this.db), settings.volumeUnusedDays, this.now()).filter((v) => v.unused);
      value = {
        volumesMonth: volumeBills ? volumeBills.filter((b) => b.end > month).reduce((n, b) => n + b.amount, 0) : null,
        disksMonth: (podBills ?? []).filter((r) => r.end > month).reduce((n, r) => n + r.disk, 0),
        perMonth: volumes.reduce((n, v) => n + v.size * VOLUME_PER_GB_MONTH, 0) + disks.reduce((n, p) => n + p.diskGb * (p.status === "EXITED" ? STOPPED_DISK_PER_GB_MONTH : RUNNING_DISK_PER_GB_MONTH), 0),
        volumes: volumes.length,
        stoppedDisks: disks.filter((p) => p.status === "EXITED").length,
        unused: unused.map((v) => ({ id: v.id, name: v.name, perMonth: v.perMonth, usedAt: v.usedAt })),
      };
    }
    this.storageSeen = { at: this.now(), value };
    return value;
  }

  /** The user's Start: refused at a cap. */
  async start(machine: string): Promise<RentedView> {
    const s = await readSettings(this.db);
    const m = s.machines.find((x) => x.id === machine);
    if (!m?.rented) throw httpError("That machine is not a rented pod.", 404);
    const spent = await this.spent();
    if ((s.rentCaps.day > 0 && spent.today >= s.rentCaps.day) || (s.rentCaps.month > 0 && spent.month >= s.rentCaps.month)) {
      throw httpError("A spending cap is reached: raise it in Settings › Rented GPUs to start it.", 409);
    }
    const unprepared = await this.prepareBoot(m, s.runpodKey);
    await this.act(m, "start", null).catch((err: Error & { statusCode?: number }) => {
      // its GPU was taken while it was stopped: a stopped pod is bound to its host, and RunPod has none free there
      if (/not enough free gpus|no longer available|no gpus? (are )?available|insufficient (gpu )?capacity/i.test(err.message)) {
        throw httpError("Start refused: its GPU was taken while it was stopped (no free GPU on its host). Terminate it and deploy a new pod, or Start again later.", 409);
      }
      throw err;
    });
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
      // a pod just stopped is still stopping on RunPod's side for some seconds: waited for, or it would start unprepared
      let pod: Pod | null = null;
      for (const ends = this.now() + SETTLE_MS; ; ) {
        pod = await client.pod(m.rented!.pod);
        if (!pod || pod.status === "EXITED" || pod.status === "ERROR" || this.now() >= ends) break;
        await new Promise((r) => setTimeout(r, this.settleEveryMs));
      }
      if (!pod) return null;
      if (pod.status !== "EXITED" && pod.status !== "ERROR") throw new Error(`RunPod still said it was ${pod.status.toLowerCase()} ${SETTLE_MS / 1000} s after it was stopped`);
      if (!pod.env) throw new Error("RunPod did not say the pod's environment, which Afflatus does not overwrite blind");
      const minutes = String(m.rented!.watchdogMinutes);
      // the token kept as a secret of the account (encrypted at RunPod, given to the pod at boot): its environment, which
      // anyone with access to the account reads in the clear, holds only the reference. Plain when the key cannot make one
      const secret = secretOf(m);
      const token = await client.putSecret(secret, m.token, `Afflatus: the lock of ${m.name || pod.id}'s ComfyUI`).then(() => secretRef(secret), (err: Error) => {
        console.warn(`[rented] ${m.name || m.id}: its token kept in its environment, RunPod made no secret of it (${err.message})`);
        return m.token;
      });
      // its other public ports closed (a template's FileBrowser, JupyterLab, SSH: logins of their own, outside the lock), and
      // remembered: kept open, those Afflatus closed are put back
      const comfy = `${COMFY_PORT}/http`;
      const closed = m.rented!.closedPorts;
      const ports = m.rented!.openPorts ? [...new Set([...pod.ports, ...closed])] : pod.ports.filter((p) => p === comfy);
      const portsChange = ports.length !== pod.ports.length || ports.some((p) => !pod.ports.includes(p));
      // what its watchdog does, as its idle does: terminate a pod that keeps nothing when stopped
      const end = pod.networkVolume || pod.diskGb > 0 ? m.rented!.idleDo : "terminate";
      if (pod.env[LOCK_ENV] === token && pod.env[WATCHDOG_ENV] === minutes && pod.env[WATCHDOG_ACTION_ENV] === end && !portsChange) return null;
      await client.update(pod.id, { env: { ...pod.env, [LOCK_ENV]: token, [WATCHDOG_ENV]: minutes, [WATCHDOG_ACTION_ENV]: end }, ...(portsChange ? { ports } : {}) });
      if (portsChange) {
        const nowClosed = m.rented!.openPorts ? [] : [...new Set([...closed, ...pod.ports.filter((p) => p !== comfy)])];
        await updateSettings(this.db, (current) => ({ machines: current.machines.map((x) => (x.id === m.id && x.rented ? { ...x, rented: { ...x.rented, closedPorts: nowClosed } } : x)) }));
      }
      return null;
    } catch (err) {
      const said = `Its lock and watchdog could not be set for its start (${(err as Error).message}): it is locked once it is up.`;
      console.warn(`[rented] ${m.name || m.id}: ${said}`);
      return said;
    }
  }

  /** The user's Stop, or Terminate: then the machine goes from Afflatus too (nothing is left to do with it), and its secret. */
  async stopBy(machine: string, how: "stop" | "terminate"): Promise<RentedView | null> {
    const s = await readSettings(this.db);
    const m = s.machines.find((x) => x.id === machine);
    if (!m?.rented) throw httpError("That machine is not a rented pod.", 404);
    await this.act(m, how, "you");
    if (how !== "terminate") return this.view(m)!;
    await this.forget(m, this.seenOf(m.id));
    return null;
  }

  /**
   * A machine whose pod is gone (terminated) taken out of Afflatus: its secret, when it could not be deleted on RunPod, kept
   * on the list of secrets to delete (sweepSecrets), never left on the account.
   */
  private async forget(m: Machine, s: Seen): Promise<void> {
    await updateSettings(this.db, (current) => ({
      machines: current.machines.filter((x) => x.id !== m.id),
      ...(s.secretDropped ? {} : { leftSecrets: [...current.leftSecrets.filter((l) => l.pod !== m.rented!.pod), { secret: secretOf(m), pod: m.rented!.pod }] }),
    }));
    this.seen.delete(m.id);
    this.events.emit("setup");
  }

  private async act(m: Machine, action: "start" | "stop" | "terminate", why: RentedView["stoppedBy"]): Promise<void> {
    const s = this.seenOf(m.id);
    // a read under way is not taken over this, and a stopping pod takes no new work from now (asked again: no second stop)
    s.epoch++;
    // a start is not a stop under way any more
    if (action === "start") {
      s.stopping = false;
      s.stoppingSince = null;
    }
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
      throw httpError("No RunPod API key: set it in Settings › Rented GPUs.", 409);
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
    // terminated, whoever asked: its secret goes too (nothing left on RunPod that was the pod's)
    if (action === "terminate") await this.dropSecret(m, s, settings.runpodKey);
    s.stoppedBy = action === "start" ? null : why;
    s.error = null;
    // the user's own stop, kept with the machine (read again after a restart of Afflatus); any start ends it
    const userStopped = action === "stop" && why === "you";
    if (action !== "terminate" && Boolean(m.rented!.userStopped) !== userStopped) {
      await updateSettings(this.db, (current) => ({ machines: current.machines.map((x) => (x.id === m.id && x.rented ? { ...x, rented: { ...x.rented, userStopped } } : x)) }));
    }
    if (action !== "start") {
      s.busyAt = null;
      s.stopping = s.pod?.status === "RUNNING";
      s.stoppingSince = s.stopping ? this.now() : null;
      await this.session(m, s.pod, s);
    }
    // a deployed pod terminated by its idle time, a cap or a boot that never came: nothing is left of it, its machine goes too
    // (the user's own Terminate removes it in stopBy)
    if (action === "terminate" && m.rented!.deployed && (why === "idle" || why === "cap" || why === "watchdog" || why === "filled")) await this.forget(m, s);
    if (why === "filled") console.log(`[rented] ${m.name || m.id}: its volume filled, terminated`);
    if (why === "watchdog") console.log(`[rented] ${m.name || m.id}: found stopped by its watchdog, terminated (it kept nothing)`);
    if (why === "idle" || why === "cap" || why === "boot" || why === "gpu") console.log(`[rented] ${m.name || m.id}: ${action === "terminate" ? "terminated" : "stopped"} (${why === "idle" ? `idle ${m.rented!.idleMinutes} min` : why === "boot" ? `its ComfyUI never answered in ${bootLimit(m) / 60_000} min` : why === "gpu" ? "its GPU did not work on that host" : "a spending cap"})`);
    this.events.emit("queue");
    // read again soon, then at the fast pace while it moves
    this.kick(1500);
  }
}
