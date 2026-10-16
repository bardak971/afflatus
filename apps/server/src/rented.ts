import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import type { Comfy } from "./comfy";
import type { Db } from "./db";
import { httpError } from "./errors";
import { newToken } from "./lock-api";
import { BOOT_PORT, COMFY_PORT, exposesComfy, imageFor, LOCK_ENV, noCapacity, POD_IMAGES, podMachineId, podUrl, Runpod, RunpodError, RunpodShape, secretRef, HOURS_A_MONTH, STOPPED_DISK_PER_GB_MONTH, tokenSecret, WATCHDOG_ACTION_ENV, WATCHDOG_ENV, type BillRecord, type GpuOffer, type NetworkVolume, type Pod, type PodSpec, type PodStatus } from "./runpod";
import { gpuKey, LEARNED_RENDERS, stepSaid, volumePerMonth, type PresetFile } from "@afflatus/core";
import { gpuPaces } from "./forecast";
import { imagePublic } from "./podImage";
import { recordMeasure } from "./podMeasures";
import { bootOf, BootLogs, bootPacks, type BootLog, type BootView } from "./podBoot";
import { SEARCHED_FOLDERS } from "./modelSets";
import { inUseSaid, keptHoldings, noteFill, noticeVolumes, mountedOn, recordHoldings, usedBy, viewVolumes, VOLUME_MAX_GB, VOLUME_MIN_GB, type Storage, type VolumeView } from "./rentedVolumes";
import { dollars, machineSaid, type Say } from "./notifyWords";
import { MAX_MACHINES, readSettings, updateSettings, type DeployAsk, type Machine, type Settings } from "./settings";
import { CAP_REACHED } from "./queueModel";

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
  /**
   * USD an hour while it runs, its GPU and its own disks as RunPod bills them (runpod.ts runningRate): the last rate seen
   * (kept from its last run while it is stopped); null before it ever ran here.
   */
  rate: number | null;
  /** Of it, the GPU's price alone, while RunPod says it (it runs); null otherwise. */
  gpuRate: number | null;
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
   * GPU does not work; "watchdog" when its watchdog stopped it while Afflatus was away, and Afflatus terminated what was left;
   * "cut" when a fill of its volume was cut short (its files stuck, or past its time); "start" when its boot log said its start
   * stopped on an error (the Afflatus image, deployed from here).
   */
  stoppedBy: "idle" | "cap" | "you" | "boot" | "gpu" | "watchdog" | "filled" | "cut" | "start" | null;
  /** Deployed and on its first start (its image pulled, ComfyUI starting): a normal step, said as one, not as an error. */
  booting: boolean;
  /** While it boots: where it is (podBoot.ts bootOf), from RunPod's data and its boot log. */
  boot: BootView | null;
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
  /**
   * What a day costs at this pace (USD): the pods, as Afflatus counted them over the last 7 days, and storage (the volumes
   * and the pods' own disks, as the account stands), which bills every day whether anything runs or not.
   */
  perDay: { pods: number; storage: number };
  /** How long the balance lasts at that pace (days); null without a balance, or with nothing spent. */
  runwayDays: number | null;
  /** Today and this month are RunPod's own bill (with Afflatus's count for the hours RunPod has not billed yet); false: Afflatus's count alone. */
  billed: boolean;
  /** What storage costs (volumes, the pods' own disks); null when RunPod was not read. Never counted against the caps. */
  storage: Storage | null;
}

/** What a pod cost as Afflatus counts it (rent_sessions), today and this month, and whether a run of it is still open. */
type Counted = { today: number; month: number; open: boolean; lastEnd: number };

const LOW_BALANCE = 5;
/** The balance is told of as low under this at least (notify.ts), and under a day of the last week's spend when that is more. */
const LOW_LINE = 2;
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
/**
 * A job's forecast on a pod that rests on too little of its own is weighed against the balance at this many times: a new
 * pod's forecast read from another machine's renders came out at half its truth (a 2000 Ada told 9.8 min took 21.5), and
 * a render the balance runs out under is lost, and paid.
 */
const UNSURE_FORECAST = 1.5;
/** The renders of a recipe a pod needs of its own before its forecast there is weighed as it is. */
const SURE_RENDERS = 3;
/** How long what the record says of the pods' forecasts (their own renders, the GPUs' paces) is kept before it is read again. */
const SURE_FRESH_MS = 60_000;

/**
 * What a job with no forecast at all is taken to render for, against the balance: a render nothing like it was made yet
 * (LTX 2.5's first) went to a pod whatever the balance, and one the balance runs out under is lost, and paid.
 */
const UNKNOWN_RENDER_MS = 30 * 60_000;

/**
 * What a job needs of the balance on a pod, beside the margin (ms): its files still to come, then its render, half again
 * when its forecast there is not `sure`, UNKNOWN_RENDER_MS when it has none (null). A fetch that cannot be told (a file
 * with no source) counts nothing: that job never starts there for its files, whatever the balance.
 */
export function runwayNeed(o: { renderMs: number | null; fetchMs: number; sure: boolean }): number {
  const render = o.renderMs === null ? UNKNOWN_RENDER_MS : o.renderMs * (o.sure ? 1 : UNSURE_FORECAST);
  return (Number.isFinite(o.fetchMs) ? Math.max(0, o.fetchMs) : 0) + render;
}
/**
 * The share of a record of RunPod's bill (an hour of a pod) that falls between two moments (ms), by its time: a record
 * across midnight or the 1st (an hour of the bill is UTC's, a day here is the user's) is cut there, not given whole to the
 * day or the month it starts in. A record of no length counts whole where it starts.
 */
export function shareIn(r: { start: number; end: number }, from: number, to: number): number {
  if (!(r.end > r.start)) return r.start >= from && r.start < to ? 1 : 0;
  return Math.max(0, Math.min(to, r.end) - Math.max(from, r.start)) / (r.end - r.start);
}

/** Whether a cap is reached by what was spent: today's at the day's, this month's at the month's (0: no cap). */
export const capReached = (caps: { day: number; month: number }, spent: { today: number; month: number }): boolean =>
  (caps.day > 0 && spent.today >= caps.day) || (caps.month > 0 && spent.month >= caps.month);

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
 * How long a render on a pod may stay silent (no step, no node, no preview from ComfyUI) before it is failed as stuck: a
 * render that hangs would otherwise keep its pod billed for ever (idle never comes while it runs). Its silence counts from
 * the start when its GPU is read idle, else only past its forecast, capped (queue.ts quietFor).
 */
const STUCK_MS = 10 * 60_000;
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
/**
 * The ports of a pod that are Afflatus's own, behind its token: ComfyUI's, and on a pod deployed from Afflatus its boot log's
 * (deploy/runpod/bootlog.py). Any other is outside the lock: said on its card, closed at a Start unless kept open.
 */
const ownPorts = (m: Machine) => [`${COMFY_PORT}/http`, ...(m.rented?.deployed ? [`${BOOT_PORT}/http`] : [])];
/** The RunPod secret its token is kept in. */
const secretOf = (m: Machine) => m.rented!.secret || tokenSecret(m.rented!.pod);
/** After this long running without an answer, its card says so (it is billed meanwhile). */
const BOOT_SLOW_MS = 2 * 60_000;
/** How long a Start waits for a pod just stopped to be stopped on RunPod's side before preparing it. */
const SETTLE_MS = 30_000;
/**
 * A fill whose files moved by nothing this long (not a byte, not a file done) is cut short: a fill pod takes no render, so
 * a download stuck on it would keep it billed for ever while its ComfyUI answers.
 */
const FILL_STALL_MS = 30 * 60_000;
/**
 * However it moves, a fill is cut short this long after its deploy: two hours (its boot, the files already there checked),
 * plus its known bytes at 10 MB/s, the slow end of what a pod fetches at (RunPod's data centers mostly do many times that),
 * and 10 GB for a file of a size not known. Room for a fill that goes slowly, a bound on one that crawls.
 */
const fillLimitMs = (files: readonly PresetFile[]) => 2 * HOUR + (files.reduce((n, f) => n + (f.size || 10e9), 0) / 10e6) * 1000;
/** What a fill's note says when its pod was terminated before its files were in, by why. */
const FILL_CUT: Partial<Record<NonNullable<RentedView["stoppedBy"]>, string>> = {
  idle: "its ComfyUI stopped answering",
  cap: "a spending cap was reached",
  boot: "its ComfyUI did not come up",
  gpu: "its GPU did not work on that host",
  start: "its start stopped on an error",
  watchdog: "its pod was found stopped",
  you: "its pod was terminated by you",
};

interface Seen {
  pod: Pod | null;
  rate: number | null;
  watchdog: RentedView["watchdog"];
  answers: boolean | null;
  /**
   * When it last had work (ms); the idle clock starts at the first sight of it running and answering. Kept on its open
   * session (`busyKept`: as last written there), so that a restart of Afflatus does not give an idle pod a new idle time.
   */
  busyAt: number | null;
  busyKept: number | null;
  /**
   * Its last work was read back after a restart of Afflatus from a run whose ComfyUI had answered (its boot over): its
   * ComfyUI not answering at the first read then does not give it a new idle time, as it does a pod still booting.
   */
  busyRestored: boolean;
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
  /** When its ComfyUI first answered this run (ms): its boot log is read a while longer, for the lines of its last steps. */
  answeredAt: number | null;
  /** The pod said its GPU does not work on its host (the Afflatus image, broken.py), with torch's words. */
  gpuFailed: string | null;
  /** Its boot log said its start stopped on an error, at that step: what its card says once it is terminated for it. */
  startFailed: string | null;
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
  /** A fill pod: its files handed to podFiles in this run of Afflatus (which keeps them in memory only). */
  handed: boolean;
  /** A fill pod: when its fill began (its first run's start, kept across a restart), what its files last came to, and when that moved. */
  fillFrom: number | null;
  fillProgress: string | null;
  fillMovedAt: number | null;
  /** Why a fill is being cut short, for its note. */
  cutWhy: string | null;
  /** Its container's start (its image pulled) kept on its session this run: once, not at every read. */
  pulledKept: boolean;
  /** When its container started (ms), once known (RunPod's uptime, its boot log): its uptime from then while RunPod says none. */
  containerAt: number | null;
  /** What its boot log said of its node packs, as last kept on its session (JSON): written again only when it changes. */
  packsKept: string | null;
}

const fresh = (): Seen => ({
  pod: null, rate: null, watchdog: "unknown", answers: null, busyAt: null, busyKept: null, busyRestored: false, stoppedBy: null, stopAfter: false, cappedAt: null,
  stopping: false, lockTried: false, seenRunningAt: null, epoch: 0, error: null, bootNote: null, secretDropped: false, upAt: null, answered: false, answeredAt: null,
  read: false, gpuFailed: null, startFailed: null, missing: 0, stoppingSince: null, aliveAt: null, startingSince: null,
  handed: false, fillFrom: null, fillProgress: null, fillMovedAt: null, cutWhy: null, pulledKept: false, packsKept: null, containerAt: null,
});

/** A pod still running this long after Afflatus asked RunPod to stop it is asked again (and a stop that keeps nothing, terminated). */
const STOP_AGAIN_MS = 2 * 60_000;
/** How often a booting pod's boot log is read (podBoot.ts), and how long after its ComfyUI first answered it still is. */
const BOOT_READ_MS = 10_000;
const BOOT_TAIL_MS = 2 * 60_000;
/** The log tab reads it every two seconds while it is open: read again at most this often then. */
const BOOT_ASKED_MS = 2_000;

/**
 * Why a deploy was refused, for the GPU hunt (hunt.ts), which goes on hunting or gives up by it: no GPU free any more where
 * asked, another deploy under way, the volume used by another pod, a spending cap, RunPod's balance too low.
 */
export type DeployRefusal = "noGpu" | "busy" | "volumeBusy" | "cap" | "balance";
const refused = (message: string, why: DeployRefusal): Error => Object.assign(httpError(message, 409), { refusal: why });
/** The refusal a deploy's error carries; null for any other error. */
export const refusalOf = (err: unknown): DeployRefusal | null => (err as { refusal?: DeployRefusal } | null)?.refusal ?? null;

export class Rented {
  private readonly seen = new Map<string, Seen>();
  /** The pods' boot logs, as last read (the Afflatus image's, deploy/runpod/bootlog.py), and how often (shorter in tests). */
  readonly boots = new BootLogs();
  bootEveryMs = BOOT_READ_MS;
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
  /** RunPod's reads under way, by what they read: a second ask while one is out waits for it rather than asking again. */
  private asking = new Map<string, Promise<unknown>>();
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
  /** How long a render on a pod may stay silent before it is failed as stuck (STUCK_MS; shorter in tests). */
  stuckMs = STUCK_MS;
  /** Where what the user is told of goes (notify.ts; set by services.ts): a pod stopped, a cap reached, the balance low. */
  tell: Say | null = null;
  /** The caps already told of as reached, by cap and period ("day:2026-10-14"): once a day, once a month. */
  private capsTold = new Set<string>();
  /** The balance was told of as low: not again until it is back over the line. */
  private lowTold = false;

  constructor(
    private readonly db: Db,
    private readonly queue: { wants(machine: string): Promise<boolean>; runningOn(machine: string): boolean; busyOn(machine: string): boolean; busyOutside(machine: string): Promise<boolean>; waitingBehindOutside(machine: string): boolean; fetching(machine: string): boolean; quietFor(machine: string, now?: number): { ms: number; gpuIdle: boolean }; endStuck(machine: string, why: string): Promise<boolean>; answering(machine: string): void },
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

  /** Whether work from outside Afflatus is being timed on a pod (podOutside.ts; set by services.ts): its queue is read at each pass then. */
  outsideTimed: (machine: string) => boolean = () => false;

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
    // one running whose ComfyUI has not answered yet (a boot): its card follows its boot log's steps at that log's pace
    const booting = [...this.seen.values()].some((s) => s.pod?.status === "RUNNING" && !s.answered);
    this.kick(fast ? this.fastMs : booting ? Math.min(this.everyMs, BOOT_READ_MS) : this.everyMs);
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

  /** What a pod was getting forgotten (podFiles.ts forget), its machine taken out; set by services.ts. */
  forgetFiles: ((machine: string) => void) | null = null;
  /**
   * The files a machine's pod still waits for (how many, their names), all it was given, the bytes in so far, and those that
   * failed (services.ts: podFiles).
   */
  filesLeft: ((machine: string) => { left: number; total: number; bytes: number; waiting: string[]; failed: Array<{ file: string; error: string }> }) | null = null;

  /** Machines deployed only to fill their volume: they take no render. */
  private filling = new Set<string>();

  /**
   * Whether a machine can take work: a rented one only while its pod runs and is not being stopped, never one filling its
   * volume, and none at a spending cap: the render it runs ends, then it stops, and a job started meanwhile (the queue
   * starts the next one as soon as a render ends, before the next read) would be billed past the cap. Null: it can.
   */
  unavailable(machine: string): string | null {
    if (this.filling.has(machine)) return "filling its volume";
    return this.podDown(machine) ?? (this.seen.get(machine)?.stopAfter ? CAP_REACHED : null);
  }

  /**
   * Whether a machine's pod is down for good as far as its container goes: stopped, failed or terminated, or not on RunPod
   * at two reads in a row (one answer of RunPod's can come back without it). Not while it is being stopped: that may fail.
   */
  podGone(machine: string): boolean {
    const s = this.seen.get(machine);
    if (!s) return false;
    if (s.pod) return s.pod.status === "EXITED" || s.pod.status === "ERROR" || s.pod.status === "TERMINATED";
    return s.missing >= 2;
  }

  /** Whether a machine's pod is down: not running, or being stopped. Null: up (or not a rented machine). Its files follow this. */
  podDown(machine: string): string | null {
    const s = this.seen.get(machine);
    if (!s) return null;
    if (s.stopping) return "being stopped";
    // not read from RunPod yet (Afflatus just started): down until a read says it runs, never said gone
    if (!s.read) return "not read from RunPod yet";
    const status = s.pod?.status ?? "GONE";
    return status === "RUNNING" ? null : status === "GONE" ? "not on RunPod" : status === "EXITED" ? "stopped" : status.toLowerCase();
  }

  /** What is said of a rented machine; null for a ComfyUI of its own. */
  view(machine: Machine): RentedView | null {
    if (!machine.rented) return null;
    const s = this.seen.get(machine.id);
    const pod = s?.pod ?? null;
    // GONE only once RunPod was read without it: before the first read (Afflatus just restarted, a pod running all along)
    // its state is not known, and a running pod said gone for a few seconds read as one lost
    const status: RentedView["status"] = s?.read ? (pod ? pod.status : "GONE") : "UNKNOWN";
    const since = pod?.status === "RUNNING" && pod.startedAt ? Date.parse(pod.startedAt) : null;
    const rate = s?.rate ?? (pod?.cost || null);
    const idleMs = machine.rented.idleMinutes * 60_000;
    const booting = Boolean(machine.rented.deployedAt) && (status === "RUNNING" || (TRANSITIONAL.has(status) && status !== "UNKNOWN")) && !s?.answered;
    const deployedAt = Date.parse(machine.rented.deployedAt);
    const boot = booting ? bootOf(pod, this.boots.get(machine.id), Number.isFinite(deployedAt) ? deployedAt : this.now()) : null;
    return {
      provider: "runpod", pod: machine.rented.pod, status, rate, gpuRate: pod?.gpuCost || null, gpu: pod?.gpu ?? null, dataCenter: pod?.dataCenter ?? null,
      since, spent: since && rate ? ((this.now() - since) / HOUR) * rate : 0,
      diskPerDay: pod ? (pod.diskGb * STOPPED_DISK_PER_GB_MONTH * 24) / HOURS_A_MONTH : 0,
      volume: Boolean(pod && (pod.networkVolume || pod.diskGb > 0)),
      otherPorts: pod ? pod.ports.filter((p) => !ownPorts(machine).includes(p)) : [],
      closedPorts: machine.rented.closedPorts,
      watchdog: status === "RUNNING" ? s?.watchdog ?? "unknown" : "unknown",
      answers: status === "RUNNING" ? s?.answers ?? null : null,
      // none while files come to it: its idle time is held then, and a countdown would read as a stop to come
      // none before its first answer either (a boot): its idle time counts only from then (keepOrStop), its boot is said instead
      // none while its ComfyUI runs work from outside Afflatus: that holds its idle time too
      idleLeftMs: status === "RUNNING" && !s?.stopping && (s?.answered || s?.busyRestored) && idleMs > 0 && s?.busyAt && !this.queue.busyOn(machine.id) && !this.queue.fetching(machine.id) ? Math.max(0, idleMs - (this.now() - s.busyAt)) : null,
      capped: s?.stopAfter ?? false,
      stopping: s?.stopping ?? false,
      stoppedBy: s?.stoppedBy ?? null,
      booting,
      boot,
      // a start that stopped on an error says so as its pod says it, before the boot limit's words
      error: s?.error ?? this.error ?? s?.bootNote ?? (s?.stoppedBy === "gpu" ? s.gpuFailed : null) ?? (s?.stoppedBy === "start" ? s.startFailed : null) ?? (boot?.failed && boot.step ? `Start failed: ${stepSaid(boot.step)}. Terminated now, nothing billed after; its last lines are in its log (Queue › Log).` : null) ?? this.unanswered(machine, s ?? null, status, bootLimit(machine)),
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

  /** When each pod last listed its volume's folders (ms), by machine and volume: at most every VOLUME_LIST_MS, a new pod at its first answer. */
  private volumeListed = new Map<string, number>();

  /**
   * What the volume a pod runs on holds, listed through its ComfyUI and kept (what a volume holds once no pod is on it),
   * at most every few minutes; and that the volume was used now. Never in the way of the poll: a failure is only said.
   */
  private async noteVolume(m: Machine, volume: string): Promise<void> {
    const key = `${m.id}|${volume}`;
    const last = this.volumeListed.get(key) ?? 0;
    if (this.now() - last < VOLUME_LIST_MS) return;
    this.volumeListed.set(key, this.now());
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

  /** The data centers that take a network volume; null when RunPod does not say (Make a volume then offers every place). */
  async volumeDataCenters(): Promise<string[] | null> {
    const s = await readSettings(this.db);
    if (!s.runpodKey) return null;
    return this.client(s.runpodKey).volumeDataCenters().catch(() => null);
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
    // what storage costs a month moved with it: said at once, not at the next read
    this.storageSeen = null;
    this.events.emit("setup");
  }

  /** A network volume deleted with all it holds (its billing ends): never while a pod is mounted on it, stopped ones too. */
  async deleteVolume(id: string): Promise<void> {
    // a deploy under way may be putting a pod on it that RunPod does not list yet
    if (this.deploying) throw httpError("A deploy is under way: wait for it to end.", 409);
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
   * cap. Billed from now: on the user's click, or by the GPU hunt the user started (hunt.ts), never otherwise.
   */
  async deploy(ask: DeployAsk, o: { fill?: boolean } = {}): Promise<{ id: string; dataCenter: string | null }> {
    if (this.deploying) throw refused("A deploy is under way: wait for it to end.", "busy");
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
  async fill(volume: string, set: string, files: PresetFile[]): Promise<{ id: string; dataCenter: string | null }> {
    const found = await this.fillGpu(volume);
    if (!found) throw httpError("No GPU is free where that volume is now: try again later.", 409);
    return this.deploy({ gpu: found.gpu.id, cloud: "SECURE", template: "afflatus", volume, disk: 20, idleMinutes: 5, idleDo: "terminate", watchdogMinutes: 15, set, files, leaveOut: [], accept: [], again: false, makeRoom: false }, { fill: true });
  }

  private async deployNow(ask: DeployAsk, fill = false): Promise<{ id: string; dataCenter: string | null }> {
    const s = await readSettings(this.db);
    if (!s.runpodKey) throw httpError("No RunPod API key: set it in Settings › Rented GPUs.", 409);
    // a pod made that cannot be kept as a machine would have to be terminated at once, its first seconds billed
    if (s.machines.length >= MAX_MACHINES) throw httpError(`Afflatus keeps ${MAX_MACHINES} ComfyUIs at most: remove one to deploy.`, 409);
    if (await this.capped()) throw refused("A spending cap is reached: raise it in Settings › Rented GPUs to deploy.", "cap");
    // an image RunPod could not pull would leave a pod provisioning, billed, until its boot limit: asked of its registry first
    const client = this.client(s.runpodKey);
    const [offers, volumes, pods] = await Promise.all([client.gpus(ask.cloud), ask.volume ? client.volumes() : Promise.resolve([]), ask.volume ? client.pods() : Promise.resolve([])]).catch((err: Error) => {
      throw httpError(err.message, 502);
    });
    const offer = offers.find((g) => g.id === ask.gpu);
    if (!offer) throw refused(`RunPod does not offer that GPU on ${ask.cloud === "COMMUNITY" ? "Community" : "Secure"} Cloud now: pick another.`, "noGpu");
    const volume = ask.volume ? volumes.find((v) => v.id === ask.volume) ?? null : null;
    if (ask.volume && !volume) throw httpError("That network volume is not on this account any more: pick another, or deploy without one.", 409);
    // one running pod per volume: a second would write over what the first keeps there
    const taken = volume ? usedBy(volume.id, pods, s.machines) : null;
    if (volume && taken) throw refused(inUseSaid(volume.name, taken), "volumeBusy");
    const listed = offer.dataCenters.filter((d) => d.availability !== "NONE" && (!volume || d.id === volume.dataCenter)).sort((a, b) => FREEST[a.availability] - FREEST[b.availability]).map((d) => d.id);
    // RunPod said it is free without saying where: wherever it puts it (never with a volume, which has its own)
    const places: Array<string | null> = listed.length || volume || offer.dataCenters.length || offer.availability === "NONE" ? listed : [null];
    const none = volume ? `No ${offer.name} free in ${volume.dataCenter}, where the volume "${volume.name}" is: pick another GPU, or deploy without the volume.` : `No ${offer.name} free any more: it was taken since the list was read. Pick another GPU.`;
    if (!places.length) throw refused(none, "noGpu");
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
      // the Afflatus image's boot log too, to the pod's token only: an image without it (RunPod's, 0.1.11) has nothing there
      volume: volume?.id ?? null, ports: [`${COMFY_PORT}/http`, ...(ask.template === "afflatus" ? [`${BOOT_PORT}/http`] : [])], env: { [LOCK_ENV]: kept ? secretRef(secret) : token, [WATCHDOG_ENV]: String(ask.watchdogMinutes), [WATCHDOG_ACTION_ENV]: end },
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
      throw (err as RunpodError).status === 402 ? refused((err as Error).message, "balance") : httpError((err as Error).message, 502);
    }
    if (!pod) {
      if (kept) await client.deleteSecret(secret).catch(() => {});
      throw refused(none, "noGpu");
    }
    const made = pod;
    const id = podMachineId(made.id);
    try {
      await updateSettings(this.db, (current) => {
        const names = new Set(current.machines.map((m) => m.name));
        let name = offer.name.slice(0, 36);
        for (let n = 2; names.has(name); n++) name = `${offer.name.slice(0, 36)} ${n}`;
        // without a volume a stop keeps nothing and its GPU may be taken meanwhile: terminated, as for a pod added
        const rented = { provider: "runpod" as const, pod: made.id, idleMinutes: ask.idleMinutes, idleDo: volume ? ask.idleDo : ("terminate" as const), watchdogMinutes: ask.watchdogMinutes, openPorts: false, closedPorts: [], secret: kept ? secret : "", deployed: true, deployedAt: new Date(this.now()).toISOString(), cloud: ask.cloud, volume: volume?.id ?? "", fill, files: ask.files, leaveOut: ask.leaveOut, makeRoom: ask.makeRoom };
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
    return { id, dataCenter: made.dataCenter };
  }

  /** The user's pods on RunPod, for adding one (Settings › Rented GPUs): which expose ComfyUI, which are added already. */
  async pods(): Promise<Array<Pod & { comfy: boolean; added: string | null }>> {
    const s = await readSettings(this.db);
    if (!s.runpodKey) throw httpError("No RunPod API key: set it first.", 409);
    const pods = await this.client(s.runpodKey).pods().catch((err: Error) => {
      throw httpError(err.message, 502);
    });
    // which are machines, read once RunPod answered: a deploy that ended meanwhile saved its machine after the settings above
    // were read, and its pod was listed as one to add ("Afflatus A40 … provisioning") until the next read
    const { machines } = await readSettings(this.db);
    // never a pod's environment: it may hold a token in the clear (a pod whose key could not make a secret), or the user's own
    return pods.filter((p) => p.status !== "TERMINATED").map(({ env: _env, ...p }) => ({ ...p, env: {}, comfy: exposesComfy(p as Pod), added: machines.find((m) => m.rented?.pod === p.id)?.id ?? null }));
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
    for (const id of this.seen.keys()) {
      if (rented.some((m) => m.id === id)) continue;
      this.seen.delete(id);
      this.boots.forget(id);
    }
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

  private sureKept: { at: number; own: Map<string, number>; paced: Set<string> } | null = null;

  /**
   * Whether a job's forecast on this pod is weighed against the balance as it is: the pod rendered its recipe SURE_RENDERS
   * times, or its GPU's pace is learned (the forecast then reads that GPU's renders, or others' at its pace).
   */
  private async forecastSure(machine: string, recipeId: string): Promise<boolean> {
    if (!this.sureKept || this.now() - this.sureKept.at > SURE_FRESH_MS) {
      const own = await this.db
        .selectFrom("render_stats")
        .select(["machine_id", "recipe_id", (eb) => eb.fn.countAll<number>().as("n")])
        .where("status", "=", "done")
        .where("whole", "=", 1)
        .where("machine_id", "is not", null)
        .groupBy(["machine_id", "recipe_id"])
        .execute();
      const paced = (await gpuPaces(this.db)).filter((g) => g.renders >= LEARNED_RENDERS && g.pace > 0).map((g) => gpuKey(g.gpu));
      this.sureKept = { at: this.now(), own: new Map(own.map((r) => [`${r.machine_id}\n${r.recipe_id}`, Number(r.n)])), paced: new Set(paced) };
    }
    if ((this.sureKept.own.get(`${machine}\n${recipeId}`) ?? 0) >= SURE_RENDERS) return true;
    const gpu = this.seen.get(machine)?.pod?.gpu;
    return Boolean(gpu && this.sureKept.paced.has(gpuKey(gpu)));
  }

  /** What a job of this recipe needs of the balance on this pod (`runwayNeed`), its render forecast there and its files' time to come given (ms). */
  async balanceNeed(machine: string, recipeId: string, renderMs: number, fetchMs: number): Promise<number> {
    return runwayNeed({ renderMs, fetchMs, sure: await this.forecastSure(machine, recipeId) });
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
    return this.once("balance", async () => {
      const got = await this.client(key).balance().catch(() => ({ balance: null, spendPerHr: null }));
      this.balanceSeen = { at: this.now(), value: got.balance, spendPerHr: got.spendPerHr };
      if (got.balance !== null) await this.sayBalance(got.balance, key).catch((err: Error) => console.warn(`[rented] the balance's line not worked out: ${err.message}`));
    });
  }

  /**
   * The balance told of as low once it is under the higher of $2 and a day at this pace (`perDay`: the last week's pods and
   * the storage there is now): what one more such day would leave at zero, when RunPod stops every pod. Once, until it is
   * back over the line.
   */
  private async sayBalance(balance: number, key: string): Promise<void> {
    if (!this.tell) return;
    const pace = await this.perDay(key);
    const line = Math.max(LOW_LINE, pace.pods + pace.storage);
    if (balance >= line) {
      this.lowTold = false;
      return;
    }
    if (this.lowTold) return;
    this.lowTold = true;
    const said = line > LOW_LINE ? `, a day at this pace (the last week's pods ${dollars(pace.pods)}, storage ${dollars(pace.storage)})` : "";
    this.tell("balanceLow", { title: `RunPod balance low: ${dollars(balance)}`, body: `Under ${dollars(line)}${said}. At $0 RunPod stops every pod, a render under way too.`, key: "balance" });
  }

  /**
   * What a day costs at this pace: the pods as Afflatus counted them over the last 7 days, a seventh of it, and storage as
   * the account stands (its price a month, billed by the hour over HOURS_A_MONTH). Storage is 0 when RunPod's volumes and
   * pods were not read.
   */
  private async perDay(key: string): Promise<{ pods: number; storage: number }> {
    const now = this.now();
    const pods = (await this.costBetween(now - 7 * 24 * HOUR, now)) / 7;
    const storage = key ? await this.storage(key) : null;
    return { pods, storage: storage ? (storage.nowMonth * 24) / HOURS_A_MONTH : 0 };
  }

  /** A day's or a month's cap reached: told once for that day, once for that month. */
  private sayCap(caps: { day: number; month: number }, spent: { today: number; month: number }): void {
    if (!this.tell) return;
    const d = new Date(this.now());
    const reached = [
      { key: `day:${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`, cap: caps.day, spent: spent.today, said: "Today's" },
      { key: `month:${d.getFullYear()}-${d.getMonth() + 1}`, cap: caps.month, spent: spent.month, said: "This month's" },
    ];
    for (const r of reached) {
      if (r.cap <= 0 || r.spent < r.cap || this.capsTold.has(r.key)) continue;
      this.capsTold.add(r.key);
      this.tell("capReached", { title: `${r.said} cap reached: ${dollars(r.spent)} of ${dollars(r.cap)}`, body: "The rented GPUs stop once their render ends, and Start is refused until the cap is raised or the period ends.", key: r.key });
    }
  }

  /** What the pod's last run cost as Afflatus counts it (its time × its rate), to now while it is still open; null before any. */
  private async lastRunCost(m: Machine): Promise<number | null> {
    const r = await this.db.selectFrom("rent_sessions").select(["started_at", "ended_at", "rate"]).where("machine_id", "=", m.id).orderBy("started_at", "desc").executeTakeFirst();
    if (!r) return null;
    const end = r.ended_at ? Date.parse(r.ended_at) : this.now();
    return Math.max(0, ((end - Date.parse(r.started_at)) / HOUR) * r.rate);
  }

  /** What the rented GPUs cost between two moments (ms), as Afflatus counts it (rent_sessions): a batch of renders' notice says it. */
  async costBetween(from: number, to: number): Promise<number> {
    const rows = await this.db.selectFrom("rent_sessions").select(["started_at", "ended_at", "rate"]).where((eb) => eb.or([eb("ended_at", "is", null), eb("ended_at", ">", new Date(from).toISOString())])).where("started_at", "<", new Date(to).toISOString()).execute();
    return rows.reduce((sum, r) => {
      const start = Math.max(from, Date.parse(r.started_at));
      const end = Math.min(to, r.ended_at ? Date.parse(r.ended_at) : to);
      return Number.isFinite(start) && Number.isFinite(end) && end > start ? sum + ((end - start) / HOUR) * r.rate : sum;
    }, 0);
  }

  /**
   * What the rented GPUs cost for a batch of renders that ran from `from` to `to` (ms), as Afflatus counts it: every run that
   * overlaps it, from its own start (its boot and its files, which the batch's first render on it waited for, are the
   * batch's) but never from before `notBefore` (the end of the batch before, which counted that), to `to`.
   */
  async batchCost(from: number, to: number, notBefore: number): Promise<number> {
    const rows = await this.db.selectFrom("rent_sessions").select(["started_at", "ended_at", "rate"]).where((eb) => eb.or([eb("ended_at", "is", null), eb("ended_at", ">", new Date(from).toISOString())])).where("started_at", "<", new Date(to).toISOString()).execute();
    return rows.reduce((sum, r) => {
      const start = Math.max(notBefore, Date.parse(r.started_at));
      const end = Math.min(to, r.ended_at ? Date.parse(r.ended_at) : to);
      return Number.isFinite(start) && Number.isFinite(end) && end > start ? sum + ((end - start) / HOUR) * r.rate : sum;
    }, 0);
  }

  /**
   * RunPod's bill over each stretch of a chart (`times`, each `step` long), every pod of the account, a record across two
   * stretches shared between them by its time. Null for a stretch before this month (the bill read starts there), and for
   * all of them when RunPod did not give it. The Costs tab sets it against Afflatus's count, stretch by stretch.
   */
  async billedIn(times: readonly number[], step: number): Promise<Array<number | null>> {
    const key = (await readSettings(this.db)).runpodKey;
    const d = new Date(this.now());
    const month = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    const records = key ? await this.bill(key, month) : null;
    if (!records) return times.map(() => null);
    return times.map((t) => (t < month ? null : records.reduce((n, r) => n + r.amount * shareIn(r, t, t + step), 0)));
  }

  /** When RunPod's bill was last read (ms), and whether it answered: the Costs tab says how old its totals are. */
  get billRead(): { at: number; ok: boolean } | null {
    return this.billSeen ? { at: this.billSeen.at, ok: this.billSeen.records !== null } : null;
  }

  /** RunPod's bill since `from` (ms), read again every few minutes; null when RunPod does not give it. */
  private async bill(key: string, from: number): Promise<BillRecord[] | null> {
    if (this.billSeen && this.billSeen.from === from && (this.now() - this.billSeen.at < BILL_EVERY_MS || this.now() < this.quietUntil)) return this.billSeen.records;
    return this.once(`bill:${from}`, async () => {
      const records = await this.client(key).billing(from, this.now()).catch((err: Error) => {
        console.warn(`[rented] RunPod's bill not read: ${err.message}`);
        return null;
      });
      this.billSeen = { at: this.now(), from, records };
      return records;
    });
  }

  /** One read of RunPod at a time for each thing read: the spending reads its bill, balance and storage together, and storage reads the bill too. */
  private once<T>(what: string, read: () => Promise<T>): Promise<T> {
    const out = this.asking.get(what);
    if (out) return out as Promise<T>;
    const value = read().finally(() => this.asking.delete(what));
    this.asking.set(what, value);
    return value;
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
    if (pod?.status === "RUNNING") await this.containerUp(m, s, pod, key);
    else s.containerAt = null;
    // a deployed pod's container up (RunPod says its uptime from then): its card goes from pulling the image to ComfyUI
    // starting at once, not at the next change
    if (m.rented!.deployedAt && (before?.uptime ?? null) === null && pod?.uptime !== null && pod?.uptime !== undefined) this.events.emit("queue");
    s.read = true;
    s.pod = pod;
    if (pod?.cost) s.rate = pod.cost;
    // the rate of its last run here, until RunPod says one (it says 0 while the pod is stopped)
    s.rate ??= (await this.db.selectFrom("rent_sessions").select("rate").where("pod", "=", m.rented!.pod).orderBy("started_at", "desc").executeTakeFirst())?.rate || null;
    await this.session(m, pod, s);
    // its container up (RunPod says its uptime from then): its image pulled, kept on its session for the Costs tab's split of
    // its boot. From its uptime, not from now: right after a restart of Afflatus mid-boot too
    if (pod?.status === "RUNNING" && pod.uptime !== null && !s.pulledKept) {
      s.pulledKept = true;
      await this.notePulled(m, this.now() - pod.uptime * 1000);
    }
    // deployed and never up yet, for too long: its image does not pull, or its container does not start; billed for nothing
    const deployedAt = m.rented!.deployedAt ? Date.parse(m.rented!.deployedAt) : Number.NaN;
    if (pod && TRANSITIONAL.has(pod.status) && Number.isFinite(deployedAt) && this.now() - deployedAt >= DEPLOYED_BOOT_LIMIT_MS) {
      await this.noteFailed(m, "its start, never under way");
      await this.act(m, "terminate", "boot");
      return true;
    }
    // deployed, never up, and still not listed past its boot limit (terminated on RunPod's side, or never made there): it is
    // not starting on its volume any more, which would otherwise stay "in use" for ever
    if (!pod && Number.isFinite(deployedAt) && this.now() - deployedAt >= DEPLOYED_BOOT_LIMIT_MS) await this.undeploy(m);
    // any pod starting or provisioning that long (one added and started, its host unable to bring it up) is billed for
    // nothing: stopped as its idle choice says, as a boot that never answers is
    s.startingSince = pod && TRANSITIONAL.has(pod.status) ? s.startingSince ?? this.now() : null;
    if (s.startingSince !== null && !Number.isFinite(deployedAt) && this.now() - s.startingSince >= bootLimit(m) && !s.stopping) {
      await this.noteFailed(m, "its start, never under way");
      await this.act(m, m.rented!.idleDo, "boot");
      return true;
    }
    // a deployed pod without a volume found stopped (its watchdog stopped it while Afflatus was away, or RunPod did): it keeps
    // nothing and its GPU may be taken, so nothing is left of it on the account. A stop of the user's own is left as it is
    // A fill pod found stopped (a stop of an older Afflatus's at a cap, or RunPod's) goes too: stopped, it keeps its volume
    // mounted (never deleted then) and fills nothing
    if (pod?.status === "EXITED" && m.rented!.deployed && (m.rented!.fill || (!pod.networkVolume && pod.diskGb === 0)) && s.stoppedBy !== "you" && !m.rented!.userStopped && !s.stopping) {
      await this.act(m, "terminate", "watchdog");
      return true;
    }
    // a cap reached while it starts or provisions (by another pod's spending, or the bill read since its Start): it would
    // come up billed and only then stop. Stopped now, or terminated as capAction says; asked again if it is still at it a
    // while after
    if (pod && TRANSITIONAL.has(pod.status) && (caps.day > 0 || caps.month > 0)) {
      const spent = await (this.spentThisPoll ??= this.spent());
      this.sayCap(caps, spent);
      if (capReached(caps, spent)) {
        if (s.stopping && s.stoppingSince !== null && this.now() - s.stoppingSince < STOP_AGAIN_MS) return changed;
        const again = s.stopping;
        s.stopping = false;
        await this.act(m, this.capAction(m, pod), "cap", again);
        return true;
      }
    }
    if (pod?.status !== "RUNNING") {
      s.busyAt = null;
      s.busyKept = null;
      s.busyRestored = false;
      s.stopAfter = false;
      s.cappedAt = null;
      s.lockTried = false;
      s.answers = null;
      s.upAt = null;
      s.answered = false;
      s.answeredAt = null;
      s.pulledKept = false;
      s.packsKept = null;
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
        await this.act(m, pod.networkVolume || pod.diskGb > 0 ? m.rented!.idleDo : "terminate", why, true);
      }
      return changed;
    }
    s.upAt ??= this.now();
    // after a restart of Afflatus, idle since its last work as kept, not since now; set before its ComfyUI is asked (seconds
    // through a pod's proxy), so that its card says its idle time left from the first read on, never nothing meanwhile
    if (s.busyAt === null) ({ at: s.busyAt, restored: s.busyRestored } = await this.busySince(m, this.now()));
    // a start its boot log says stopped on an error (a step of start.sh, the GPU check) never comes up: terminated at once, not
    // billed to its boot limit. Only a pod deployed from here with Afflatus's image (none other has the log), before its
    // first answer; its last lines stay in its log tab, the boot limit stays the backstop
    const failed = m.rented!.deployed && !s.answered ? this.boots.get(m.id)?.failed : null;
    if (failed && !this.queue.runningOn(m.id)) {
      // in the words its phase line said it (stepSaid, shared with the screens), never the pod's own
      s.startFailed = `Terminated: start failed at ${stepSaid(failed)}, as its boot log says (its last lines are in its log, Queue › Log). Nothing billed after; deploy again.`;
      await this.noteFailed(m, failed);
      await this.act(m, "terminate", "start");
      return true;
    }
    const answers = await this.alive(m, s);
    // a GPU that does not work on its host never will: terminated at once, not at its boot limit
    if (s.gpuFailed && !this.queue.runningOn(m.id)) {
      await this.noteFailed(m, "checking the GPU");
      await this.act(m, "terminate", "gpu");
      return true;
    }
    if (answers && !s.answered) {
      await this.noteUp(m);
      s.answeredAt = this.now();
    }
    if (answers) s.answered = true;
    // its boot log while it boots, and a while after its first answer (ComfyUI's last lines of its start)
    if (!s.answered || (s.answeredAt !== null && this.now() - s.answeredAt < BOOT_TAIL_MS)) void this.readBoot(m, pod, this.bootEveryMs);
    // its first answer since it was deployed: later starts count from when it runs. How long it took is kept (the Deploy
    // dialog's "up in"), and what its deploy asked for is handed to it now. A fill keeps its files until it ends: podFiles
    // keeps what a pod gets in memory only, so after a restart of Afflatus they are handed again (followFill)
    if (answers && m.rented!.deployedAt) {
      if (Number.isFinite(deployedAt)) await recordMeasure(this.db, { kind: "boot", cloud: m.rented!.cloud ?? null, bytes: 0, ms: this.now() - deployedAt }).catch(() => {});
      const { files, leaveOut, fill } = m.rented!;
      await updateSettings(this.db, (current) => ({ machines: current.machines.map((x) => (x.id === m.id && x.rented ? { ...x, rented: { ...x.rented, deployedAt: "", ...(fill ? {} : { files: [], leaveOut: [] }) } } : x)) }));
      if (!fill && (files.length || leaveOut.length)) this.onUp?.(m.id, files, leaveOut);
    }
    // up this long and its ComfyUI never answered: its container failed to start, or ComfyUI on it did; billed for nothing.
    // A deployed pod's first boot counts from its deploy (its image pulled first); one that never came up is terminated
    const bootFrom = Number.isFinite(deployedAt) ? Math.min(deployedAt, s.upAt) : s.upAt;
    if (!s.answered && this.now() - bootFrom >= bootLimit(m) && !this.queue.runningOn(m.id)) {
      await this.noteFailed(m, this.boots.get(m.id)?.step ?? "ComfyUI never answered");
      await this.act(m, Number.isFinite(deployedAt) ? "terminate" : m.rented!.idleDo, "boot");
      return true;
    }
    // up and open (RunPod did not take its token for the start, or it was added running): locked now, once a session
    if (answers && !s.lockTried && this.lockPod && (await this.isOpen(m))) {
      s.lockTried = true;
      await this.lockPod(m.id).catch((err: Error) => console.warn(`[rented] ${m.name || m.id} not locked: ${err.message}`));
    }
    if (answers && pod?.volumeId) void this.noteVolume(m, pod.volumeId);
    if (m.rented!.fill && (await this.followFill(m, s, pod, answers))) return true;
    await this.keepOrStop(m, s, caps, answers);
    return changed;
  }

  /**
   * A pod filling its volume, up: its files handed (again after a restart of Afflatus), terminated once they are in (what the
   * volume holds listed first), or cut short when they stop moving or take too long. Kept from going idle only while its
   * ComfyUI answers: one that went silent ends at its idle time. Says whether it was terminated.
   */
  private async followFill(m: Machine, s: Seen, pod: Pod, answers: boolean): Promise<boolean> {
    const { files, leaveOut } = m.rented!;
    const now = this.now();
    // from its first run (its deploy), kept across a restart of Afflatus as its sessions are
    s.fillFrom ??= (await this.db.selectFrom("rent_sessions").select("started_at").where("machine_id", "=", m.id).orderBy("started_at", "asc").executeTakeFirst().then((r) => (r ? Date.parse(r.started_at) : null))) ?? now;
    if (now - s.fillFrom >= fillLimitMs(files)) return this.cutFill(m, s, `it was still not done after ${Math.round((now - s.fillFrom) / 60_000)} min`);
    if (!answers) return false;
    s.busyAt = now;
    // a fill always brings files (Fill refuses a set without): none kept means what it was to fetch is not known any more
    if (!files.length) return this.cutFill(m, s, "what it was to fetch was not known any more");
    let got = this.filesLeft?.(m.id) ?? null;
    // handed once in this run of Afflatus, and again when podFiles has nothing of it (a pod seen down a moment is forgotten
    // there): an empty view is never read as all in
    if (!s.handed || got?.total === 0) {
      s.handed = true;
      s.fillProgress = null;
      this.onUp?.(m.id, files, leaveOut);
      got = this.filesLeft?.(m.id) ?? null;
    }
    if (!got || got.total === 0) return false;
    const progress = `${got.left}|${got.bytes}|${got.failed.length}`;
    if (progress !== s.fillProgress) {
      s.fillProgress = progress;
      s.fillMovedAt = now;
    }
    if (got.left > 0) return now - (s.fillMovedAt ?? now) >= FILL_STALL_MS ? this.cutFill(m, s, `nothing came for ${FILL_STALL_MS / 60_000} min`) : false;
    if (pod.volumeId) {
      this.volumeListed.delete(`${m.id}|${pod.volumeId}`);
      await this.noteVolume(m, pod.volumeId);
      // how it ended, kept with the volume: its row says it once the pod is gone (a file that failed, and why)
      await noteFill(this.db, pod.volumeId, got.failed, now).catch(() => {});
      if (got.failed.length) console.log(`[rented] ${m.name || m.id}: ${got.failed.length} of its files failed: ${got.failed.map((f) => f.file).join(", ")}`);
    }
    await this.act(m, "terminate", "filled");
    return true;
  }

  /** A fill cut short: its pod terminated, its note saying why (act writes it). */
  private async cutFill(m: Machine, s: Seen, why: string): Promise<true> {
    s.cutWhy = why;
    await this.act(m, "terminate", "cut");
    return true;
  }

  /**
   * How a fill ended when its pod was terminated before its files were in, kept with its volume: interrupted, with why, the
   * files that failed and those that never came. Never "all in".
   */
  private async noteCut(m: Machine, s: Seen, why: RentedView["stoppedBy"], got: ReturnType<NonNullable<Rented["filesLeft"]>> | null): Promise<void> {
    const volume = m.rented!.volume;
    if (!volume) return;
    const said = (why === "cut" ? s.cutWhy : why ? FILL_CUT[why] : null) ?? "its pod was terminated";
    const failed = [...(got?.failed ?? []), ...(got?.waiting ?? []).map((file) => ({ file, error: "not fetched: the fill was cut short" }))];
    await noteFill(this.db, volume, failed, this.now(), said).catch(() => {});
    console.log(`[rented] ${m.name || m.id}: its fill was cut short (${said})`);
  }

  /** A deployed pod that never came up taken as not deployed any more: it no longer holds its volume as starting on it. */
  private async undeploy(m: Machine): Promise<void> {
    if (!m.rented!.deployedAt) return;
    await updateSettings(this.db, (current) => ({ machines: current.machines.map((x) => (x.id === m.id && x.rented ? { ...x, rented: { ...x.rented, deployedAt: "" } } : x)) }));
  }

  /**
   * A pod's boot log read again (podBoot.ts), at most every `everyMs`, on a pod that exposes its port: the queue told when its
   * step or its lines moved. Never an error: a pod without it (RunPod's image, an older Afflatus image) has nothing there.
   */
  private async readBoot(m: Machine, pod: Pod | null, everyMs: number): Promise<BootLog | null> {
    if (!pod || !pod.ports.includes(`${BOOT_PORT}/http`) || !m.token) return this.boots.get(m.id);
    const before = this.boots.get(m.id);
    const after = await this.boots.read(m.id, m.rented!.pod, m.token, everyMs);
    if (after) await this.notePacks(m, after);
    if (after && (after.step !== before?.step || after.failed !== before?.failed || after.lines.at(-1)?.t !== before?.lines.at(-1)?.t)) this.events.emit("queue");
    return after;
  }

  /**
   * The boot log of a rented machine's pod for its log tab, while its ComfyUI has none to give (it does not answer yet):
   * read now (at most every BOOT_ASKED_MS), else as last read. Null for a machine that is not a rented pod.
   */
  async bootLines(machine: string): Promise<{ lines: BootLog["lines"] } | null> {
    const m = (await readSettings(this.db)).machines.find((x) => x.id === machine);
    if (!m?.rented) return null;
    const log = await this.readBoot(m, this.seen.get(m.id)?.pod ?? null, BOOT_ASKED_MS);
    return { lines: log?.lines ?? [] };
  }

  /** Whether a rented machine's ComfyUI is not up: its log tab reads its boot log then. False for a ComfyUI of its own. */
  comfyDown(machine: string): boolean {
    const s = this.seen.get(machine);
    return Boolean(s && s.answers !== true);
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

  /**
   * Its ComfyUI's first answer of the open session, kept on it: where its boot ended (costs.ts). Not for a session older than
   * the longest boot: Afflatus started again while it ran, and its first answer here is not its boot's end.
   */
  private async noteUp(m: Machine): Promise<void> {
    const iso = new Date(this.now()).toISOString();
    const since = new Date(this.now() - DEPLOYED_BOOT_LIMIT_MS).toISOString();
    await this.db.updateTable("rent_sessions").set({ up_at: iso }).where("machine_id", "=", m.id).where("ended_at", "is", null).where("up_at", "is", null).where("started_at", ">=", since).execute().catch(() => {});
  }

  /**
   * Its container's start, said as its uptime: RunPod's REST list gives a booting pod none (a real one read none; only its
   * GraphQL says it). The first of its REST uptime, its boot log answering (the Afflatus image serves it from its container's
   * start: its first line), and RunPod's GraphQL, asked only while it boots and until known, its failures taken as nothing.
   * Known once, its uptime counts from then: what its card says (pulling the image, then starting) and its session keeps.
   */
  private async containerUp(m: Machine, s: Seen, pod: Pod, key: string): Promise<void> {
    if (pod.uptime !== null) s.containerAt ??= this.now() - pod.uptime * 1000;
    else if (s.containerAt === null && !s.answered) {
      const first = this.boots.get(m.id)?.lines[0]?.t;
      const logged = first ? Date.parse(first) : Number.NaN;
      // a log of this run only: one kept from a run before (a stop, a start again) is not its container's start
      const run = pod.startedAt ? Date.parse(pod.startedAt) - 60_000 : Number.NEGATIVE_INFINITY;
      if (Number.isFinite(logged) && logged >= run) s.containerAt = Math.min(logged, this.now());
      else {
        const up = await this.client(key).uptime(pod.id).catch(() => null);
        if (up !== null) s.containerAt = this.now() - up * 1000;
      }
    }
    if (pod.uptime === null && s.containerAt !== null) pod.uptime = Math.max(0, Math.round((this.now() - s.containerAt) / 1000));
  }

  /**
   * Its container's start (its image pulled, ms) kept on its open session, before its ComfyUI first answered: the Costs tab's
   * "pulling the image". Never over one kept (a container started again later is not its pull).
   */
  private async notePulled(m: Machine, at: number): Promise<void> {
    await this.db.updateTable("rent_sessions").set({ pulled_at: new Date(Math.min(at, this.now())).toISOString() }).where("machine_id", "=", m.id).where("ended_at", "is", null).where("pulled_at", "is", null).where("up_at", "is", null).execute().catch(() => {});
  }

  /**
   * What its boot log says of its node packs (podBoot.ts bootPacks), kept on its open session as it comes: a restart of
   * Afflatus mid-boot keeps it, and a log read later that has lost its first lines (it keeps its last 300) changes nothing kept.
   */
  private async notePacks(m: Machine, log: BootLog): Promise<void> {
    const packs = bootPacks(log.lines);
    const s = this.seen.get(m.id);
    if (!packs || !s) return;
    const said = JSON.stringify(packs);
    if (s.packsKept === said) return;
    s.packsKept = said;
    const open = await this.db.selectFrom("rent_sessions").select(["id", "packs_from", "packs_to", "boot_packs"]).where("machine_id", "=", m.id).where("ended_at", "is", null).executeTakeFirst().catch(() => undefined);
    // its first course kept: a container started again afterwards (RunPod restarts one that stopped) is not its boot's
    if (!open || open.packs_to || (open.packs_from && open.packs_from !== packs.from)) return;
    const kept = JSON.parse(open.boot_packs ?? "[]") as Array<{ pack: string; ms: number }>;
    await this.db
      .updateTable("rent_sessions")
      .set({ packs_from: open.packs_from ?? packs.from, packs_to: packs.to, boot_packs: packs.installs.length >= kept.length ? JSON.stringify(packs.installs) : open.boot_packs })
      .where("id", "=", open.id)
      .execute()
      .catch(() => {});
  }

  /** The step its start failed at, kept on its open session: the Costs tab's "failed starts". The first said stays. */
  private async noteFailed(m: Machine, step: string): Promise<void> {
    await this.db.updateTable("rent_sessions").set({ start_failed: step.slice(0, 200) }).where("machine_id", "=", m.id).where("ended_at", "is", null).where("start_failed", "is", null).execute().catch(() => {});
  }

  /** The running session kept as a row: opened when it is seen running, kept seen while it runs, closed when it is not. */
  private async session(m: Machine, pod: Pod | null, s: Seen): Promise<void> {
    const open = await this.db.selectFrom("rent_sessions").selectAll().where("machine_id", "=", m.id).where("ended_at", "is", null).executeTakeFirst();
    const now = this.now();
    const iso = new Date(now).toISOString();
    if (pod && BILLED.has(pod.status)) {
      s.seenRunningAt = now;
      if (open) {
        // a run first seen before RunPod said its rate (0) takes the rate as soon as it says one: it was counted as free. One
        // opened at a lower rate takes the higher too: a run opened before its disk was counted in its rate (0.5.0), its
        // whole time billed with that disk
        await this.db.updateTable("rent_sessions").set({ seen_at: iso, ...(pod.cost > open.rate ? { rate: pod.cost } : {}) }).where("id", "=", open.id).execute();
        return;
      }
      // from when the pod says it started; a deployed pod's first run from its deploy, when the money starts. A start time
      // not after the end of the run before is that run's (RunPod may list it until the new one is under way): this run is
      // counted from its first sight, never from back then (the hours it was stopped, all at once, a cap reached by them)
      const last = await this.db.selectFrom("rent_sessions").select("ended_at").where("machine_id", "=", m.id).where("ended_at", "is not", null).orderBy("ended_at", "desc").executeTakeFirst();
      const lastEnd = last?.ended_at ? Date.parse(last.ended_at) : 0;
      const deployedAt = m.rented!.deployedAt ? Date.parse(m.rented!.deployedAt) : Number.NaN;
      const said = pod.startedAt ? Date.parse(pod.startedAt) : Number.NaN;
      const started = Number.isFinite(said) && said > lastEnd ? said : now;
      const from = !last && Number.isFinite(deployedAt) ? Math.min(started, deployedAt) : started;
      // its GPU and its idle minutes kept with it: the Costs tab says the one and weighs a shorter idle against the other
      await this.db.insertInto("rent_sessions").values({ id: randomUUID(), machine_id: m.id, pod: pod.id, rate: pod.cost || s.rate || 0, started_at: new Date(Math.min(from, now)).toISOString(), ended_at: null, seen_at: iso, gpu: pod.gpu, up_at: null, idle_minutes: m.rented!.idleMinutes, busy_at: null }).execute();
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
      // at work for Afflatus or, as last read, for someone else in its ComfyUI (keepOrStop holds its idle time for that too)
      const keep = this.queue.busyOn(m.id) || idle === 0 || (s.busyAt !== null && now - s.busyAt < idle);
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
    // its ComfyUI answering now and not at the last read (a boot ended, a restart done): the queue plans again at once, the
    // files its jobs wait for asked for. Nothing else tells it when no page is open, and the pod would idle toward its stop
    if (up && s.answers !== true) this.queue.answering(m.id);
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
    // a render ComfyUI has said nothing of for long, with its GPU idle or past its forecast: failed, so that the pod is free
    // for the next job or its idle time, instead of billed for a render that never ends
    const quiet = this.queue.quietFor(m.id, now);
    const why = quiet.gpuIdle ? "its GPU idle" : "past its forecast";
    if (quiet.ms >= this.stuckMs && (await this.queue.endStuck(m.id, `Stuck: no progress from ComfyUI for ${Math.round(quiet.ms / 60_000)} min, ${why}, on the rented GPU ${m.name || m.id}; failed so that the pod is not billed for a render that never ends`))) {
      console.log(`[rented] ${m.name || m.id}: a render stuck for ${Math.round(quiet.ms / 60_000)} min (${why}) failed`);
    }
    const running = this.queue.runningOn(m.id);
    // work counts only for a pod whose ComfyUI answers: one that went down would otherwise keep a waiting job "for it" forever
    // not idle before its ComfyUI first answered (a first boot pulling node packs and models): the boot limit covers that.
    // Files coming to it hold it too, while their bytes move (podFiles.ts moving): a pod is never stopped mid-download by its
    // idle stop, and a download stuck for long holds it no more
    // A pod whose last work was read back after a restart keeps it while its ComfyUI does not answer: a fresh idle time
    // given at each restart that found its ComfyUI down was a run billed for nothing
    // the caps first, before anything is asked of its ComfyUI: a slow answer there never holds a cap back
    const spent = await (this.spentThisPoll ??= this.spent());
    this.sayCap(caps, spent);
    s.stopAfter = capReached(caps, spent);
    s.cappedAt = s.stopAfter ? s.cappedAt ?? now : null;
    // at a cap: once its render ends, or an hour after the cap when the render does not end
    // Whether it renders is read again here, the cap now set: a render that ended while the bill was read is not waited for.
    // A render still waiting in its ComfyUI behind work from outside Afflatus has not started: it is not waited for, the pod
    // would bill on for that other work
    if (s.stopAfter && (!this.queue.runningOn(m.id) || this.queue.waitingBehindOutside(m.id) || now - s.cappedAt! > CAP_GRACE_MS)) {
      await this.act(m, this.capAction(m, s.pod), "cap");
      return;
    }
    // Work queued in its ComfyUI from outside Afflatus (its own page, another tool) is work too: the pod is not stopped under
    // it by its idle time. The caps above act all the same
    let outsideRead = false;
    const outside = () => {
      outsideRead = true;
      return this.queue.busyOutside(m.id);
    };
    if (running || (!s.answered && !s.busyRestored) || this.queue.fetching(m.id) || (answers && ((await this.queue.wants(m.id)) || (await outside())))) s.busyAt = now;
    // While its ComfyUI's work from outside Afflatus is being timed (podOutside.ts), its queue is read at every pass all the
    // same, Afflatus's own work there or not: the stretch is kept to this pass's sight of it, not closed early at an older one
    if (answers && !outsideRead && this.outsideTimed(m.id)) await this.queue.busyOutside(m.id);
    // set when it was first seen running (follow), from what was kept across a restart of Afflatus
    s.busyAt ??= now;
    await this.keepBusy(m, s);
    const idle = m.rented!.idleMinutes * 60_000;
    if (idle > 0 && now - s.busyAt >= idle) await this.act(m, m.rented!.idleDo, "idle");
  }

  /**
   * What a cap does to a pod: it stops it, or terminates one that a stop would leave with nothing worth keeping: a fill pod
   * (stopped, it would keep its volume mounted, never deleted then, and fill nothing), and a pod Afflatus deployed that keeps
   * nothing when stopped (no volume of any kind: a stop would only have it found stopped and terminated after, told of as
   * its watchdog's), that is still on its first boot (its deploy is what it was for), or whose deploy said to terminate it
   * when idle. That last one was only stopped on a network volume before: stopped, its container disk went on billing until
   * removed by hand, and the network volume outlives a terminate anyway. A pod the user added is only stopped.
   */
  private capAction(m: Machine, pod: Pod | null): "stop" | "terminate" {
    const keeps = Boolean(pod && (pod.networkVolume || pod.diskGb > 0));
    return m.rented!.fill || (m.rented!.deployed && (!keeps || Boolean(m.rented!.deployedAt) || m.rented!.idleDo === "terminate")) ? "terminate" : "stop";
  }

  /**
   * When a pod last had work, as kept when Afflatus was not following it (a restart): the latest of what its open session
   * kept, its boot's end (or the session's start before that), and the end of the last job it ran. Now when nothing says.
   */
  private async busySince(m: Machine, now: number): Promise<{ at: number; restored: boolean }> {
    const open = await this.db.selectFrom("rent_sessions").select(["started_at", "up_at", "busy_at"]).where("machine_id", "=", m.id).where("ended_at", "is", null).executeTakeFirst();
    if (!open) return { at: now, restored: false };
    const job = await this.db.selectFrom("jobs").select((eb) => eb.fn.max("finished_at").as("at")).where("machine_id", "=", m.id).executeTakeFirst();
    const times = [open.busy_at, open.up_at ?? open.started_at, job?.at ?? null].map((t) => (t ? Date.parse(t) : Number.NaN)).filter(Number.isFinite);
    // its boot was over: its session kept where its ComfyUI first answered, or a deployed pod's first answer cleared its
    // deploy's mark. A pod still booting (a deploy never answered) keeps its boot limit and its not-answered rule
    const answeredOnce = Boolean(open.up_at) || (Boolean(m.rented!.deployed) && !m.rented!.deployedAt);
    return { at: times.length ? Math.min(now, Math.max(...times)) : now, restored: Boolean(open.busy_at) && answeredOnce };
  }


  /** When it last had work, written on its open session as it moves: what a restart of Afflatus reads back (busySince). */
  private async keepBusy(m: Machine, s: Seen): Promise<void> {
    if (s.busyAt === null || s.busyAt === s.busyKept) return;
    await this.db.updateTable("rent_sessions").set({ busy_at: new Date(s.busyAt).toISOString() }).where("machine_id", "=", m.id).where("ended_at", "is", null).execute();
    s.busyKept = s.busyAt;
  }

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
    // a record across midnight or the 1st counts for its part after it (shareIn)
    for (const r of records ?? []) {
      if (r.end <= month) continue;
      const b = billed.get(r.pod) ?? { today: 0, month: 0 };
      b.month += r.amount * shareIn(r, month, Infinity);
      b.today += r.amount * shareIn(r, today, Infinity);
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

  /** Whether a spending cap is reached now: a deploy and a Start are refused, and the GPU hunt ends (hunt.ts). */
  async capped(): Promise<boolean> {
    const caps = (await readSettings(this.db)).rentCaps;
    if (caps.day <= 0 && caps.month <= 0) return false;
    return capReached(caps, await this.spent());
  }

  /** A deploy under way (the user's, a fill's or the GPU hunt's): another is refused until it ends. */
  get busy(): boolean {
    return this.deploying;
  }

  /** Today's and this month's cost, the caps, RunPod's balance, and what storage costs. */
  async spending(): Promise<Spending> {
    const s = await readSettings(this.db);
    // RunPod is asked at most once a minute: the card reads this every 10 s while a pod runs. Its bill, balance and storage
    // are read together: one after the other they kept Queue › Costs waiting for three answers of RunPod's in a row
    const [spent, , storage] = await Promise.all([this.spent(), s.runpodKey ? this.readBalance(s.runpodKey) : undefined, s.runpodKey ? this.storage(s.runpodKey) : null]);
    const balance = this.balanceSeen?.value ?? null;
    // the one runway said everywhere (Settings, Queue › Costs): the balance over a day at this pace, storage in it
    const perDay = await this.perDay(s.runpodKey);
    const day = perDay.pods + perDay.storage;
    return {
      ...spent, caps: s.rentCaps, balance, lowBalance: balance !== null && balance < Math.max(LOW_BALANCE, day), spendPerHr: this.balanceSeen?.spendPerHr ?? null, runwayMs: this.runwayMs(),
      perDay, runwayDays: balance !== null && day > 0 ? Math.max(0, balance) / day : null, storage,
    };
  }

  private storageSeen: { at: number; value: Storage | null } | null = null;

  /**
   * What storage costs on the account: the volumes' bill this month, the pods' own disks within this month's bill, and
   * what it all costs a month as it stands. Read again every few minutes (it moves by the day); null when RunPod does not
   * answer.
   */
  private async storage(key: string): Promise<Storage | null> {
    if (this.storageSeen && (this.now() - this.storageSeen.at < BILL_EVERY_MS || this.now() < this.quietUntil)) return this.storageSeen.value;
    return this.once("storage", () => this.readStorage(key));
  }

  /** Storage as RunPod says it now: its volumes, its pods' disks and their bills this month. */
  private async readStorage(key: string): Promise<Storage | null> {
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
        disksMonth: (podBills ?? []).reduce((n, r) => n + r.disk * shareIn(r, month, Infinity), 0),
        // what bills with nothing running: a running pod's own disk is in its rate (runningRate) while it runs, and bills
        // at the stopped price once it stops; its container disk goes at the stop
        perMonth: volumes.reduce((n, v) => n + volumePerMonth(v.size), 0) + disks.reduce((n, p) => n + p.diskGb * STOPPED_DISK_PER_GB_MONTH, 0),
        // the runway's storage: a running pod's disk is billed in its rate, already in the pods' pace, and is not counted twice
        nowMonth: volumes.reduce((n, v) => n + volumePerMonth(v.size), 0) + disks.filter((p) => p.status === "EXITED").reduce((n, p) => n + p.diskGb * STOPPED_DISK_PER_GB_MONTH, 0),
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
    if (capReached(s.rentCaps, await this.spent())) {
      throw httpError("A spending cap is reached: raise it in Settings › Rented GPUs to start it.", 409);
    }
    // one running pod per volume, as for a deploy: a stopped pod's volume may have gone to another pod meanwhile
    if (s.runpodKey) await this.volumeFree(m, s);
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

  /** Refused when the volume a pod is on has another pod running (or starting) on it: two would spoil what it keeps. */
  private async volumeFree(m: Machine, s: Settings): Promise<void> {
    const client = this.client(s.runpodKey);
    const pods = await client.pods().catch((err: Error) => {
      throw httpError(err.message, 502);
    });
    const volume = pods.find((p) => p.id === m.rented!.pod)?.volumeId || m.rented!.volume;
    if (!volume) return;
    const taken = usedBy(volume, pods.filter((p) => p.id !== m.rented!.pod), s.machines.filter((x) => x.id !== m.id));
    if (!taken) return;
    const name = (await client.volumes().catch(() => [])).find((v) => v.id === volume)?.name ?? volume;
    throw httpError(inUseSaid(name, taken), 409);
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
      const own = ownPorts(m);
      const closed = m.rented!.closedPorts;
      const ports = m.rented!.openPorts ? [...new Set([...pod.ports, ...closed])] : pod.ports.filter((p) => own.includes(p));
      const portsChange = ports.length !== pod.ports.length || ports.some((p) => !pod.ports.includes(p));
      // what its watchdog does, as its idle does: terminate a pod that keeps nothing when stopped
      const end = pod.networkVolume || pod.diskGb > 0 ? m.rented!.idleDo : "terminate";
      if (pod.env[LOCK_ENV] === token && pod.env[WATCHDOG_ENV] === minutes && pod.env[WATCHDOG_ACTION_ENV] === end && !portsChange) return null;
      await client.update(pod.id, { env: { ...pod.env, [LOCK_ENV]: token, [WATCHDOG_ENV]: minutes, [WATCHDOG_ACTION_ENV]: end }, ...(portsChange ? { ports } : {}) });
      if (portsChange) {
        const nowClosed = m.rented!.openPorts ? [] : [...new Set([...closed, ...pod.ports.filter((p) => !own.includes(p))])];
        await updateSettings(this.db, (current) => ({ machines: current.machines.map((x) => (x.id === m.id && x.rented ? { ...x, rented: { ...x.rented, closedPorts: nowClosed } } : x)) }));
      }
      return null;
    } catch (err) {
      const said = `Its lock and watchdog could not be set for its start (${(err as Error).message}): it is locked once it is up.`;
      console.warn(`[rented] ${m.name || m.id}: ${said}`);
      return said;
    }
  }

  /** A pod Afflatus stopped or terminated on its own: why, and what its run cost. */
  private async sayStopped(m: Machine, s: Seen, action: "stop" | "terminate", why: Exclude<NonNullable<RentedView["stoppedBy"]>, "you">): Promise<void> {
    if (!this.tell) return;
    const because: Record<typeof why, string> = {
      idle: `idle ${m.rented!.idleMinutes} min`,
      cap: "a spending cap was reached",
      boot: `its ComfyUI never answered in ${bootLimit(m) / 60_000} min`,
      gpu: "its GPU did not work on that host",
      start: `its start failed: ${stepSaid(this.boots.get(m.id)?.failed ?? "see its log")}`,
      watchdog: "its watchdog had stopped it while Afflatus was away, and it kept nothing",
      filled: "its volume is filled",
      cut: `its fill was cut short: ${s.cutWhy ?? "it stopped moving"}`,
    };
    const cost = await this.lastRunCost(m);
    this.tell("podStopped", { title: `${machineSaid(m)} ${action === "terminate" ? "terminated" : "stopped"}`, body: `Why: ${because[why]}.${cost !== null ? ` This run: ${dollars(cost)}.` : ""}`, key: `${m.id}:${why}` });
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
   * What going back to a version without rented GPUs (0.4.0) leaves on RunPod, read from RunPod now: this Afflatus's pods
   * that run (or start), which it would bill with no screen, no idle stop and no cap; and what keeps billing stopped, each
   * with what it costs a month (its pods' disks, the account's network volumes). RunPod not answering: the pods as last
   * read, the storage not known (`unknown`), and why the pods could not be read (`unreadable`: Go back is refused then, as
   * whether one runs is not known).
   */
  async goingBack(): Promise<{ running: string[]; billing: string[]; unknown: boolean; unreadable: string | null }> {
    const s = await readSettings(this.db);
    const mine = s.machines.filter((m) => m.rented);
    if (!s.runpodKey || !mine.length) return { running: [], billing: [], unknown: false, unreadable: null };
    const client = this.client(s.runpodKey);
    let unreadable: string | null = null;
    const [pods, volumes] = await Promise.all([client.pods().catch((err: Error) => ((unreadable = err.message), null)), client.volumes().catch(() => null)]);
    const podOf = (m: Machine) => (pods ? pods.find((p) => p.id === m.rented!.pod && p.status !== "TERMINATED") ?? null : this.seen.get(m.id)?.pod ?? null);
    const running = mine.flatMap((m) => {
      const pod = podOf(m);
      return pod && pod.status !== "EXITED" ? [`${m.name || pod.name}${pod.gpu ? ` (${pod.gpu})` : ""}`] : [];
    });
    const disks = mine.flatMap((m) => {
      const pod = podOf(m);
      return pod?.status === "EXITED" && pod.diskGb > 0 ? [`${m.name || pod.name}, stopped: its ${pod.diskGb} GB disk, ${dollars(pod.diskGb * STOPPED_DISK_PER_GB_MONTH)}/month`] : [];
    });
    const kept = (volumes ?? []).map((v) => `volume ${v.name} (${v.size} GB, ${dollars(volumePerMonth(v.size))}/month)`);
    return { running, billing: [...disks, ...kept], unknown: !pods || !volumes, unreadable };
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
    this.boots.forget(m.id);
    // what it was getting goes with it now: once its machine is out, nothing reads it as down any more
    this.forgetFiles?.(m.id);
    this.events.emit("setup");
  }

  /** `again`: a stop asked again of a pod still running after the first (told of once, at the first). */
  private async act(m: Machine, action: "start" | "stop" | "terminate", why: RentedView["stoppedBy"], again = false): Promise<void> {
    const s = this.seenOf(m.id);
    // what a fill cut short still waited for, read before its pod goes (podFiles forgets a pod being stopped)
    const fillLeft = action === "terminate" && m.rented!.fill && why !== "filled" ? this.filesLeft?.(m.id) ?? null : undefined;
    // a read under way is not taken over this, and a stopping pod takes no new work from now (asked again: no second stop)
    s.epoch++;
    // a start is not a stop under way any more
    if (action === "start") {
      s.stopping = false;
      s.stoppingSince = null;
      // its boot log is this start's from now: the last one's lines are not where this one is
      this.boots.forget(m.id);
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
    // a fill ended before its files were in says so with its volume, never "all in"
    if (fillLeft !== undefined) await this.noteCut(m, s, why, fillLeft);
    // one that never came up keeps its card (which says why), but no longer holds its volume as starting on it
    if (action === "terminate" && (why === "boot" || why === "gpu" || why === "start")) await this.undeploy(m);
    s.stoppedBy = action === "start" ? null : why;
    s.error = null;
    // the user's own stop, kept with the machine (read again after a restart of Afflatus); any start ends it
    const userStopped = action === "stop" && why === "you";
    if (action !== "terminate" && Boolean(m.rented!.userStopped) !== userStopped) {
      await updateSettings(this.db, (current) => ({ machines: current.machines.map((x) => (x.id === m.id && x.rented ? { ...x, rented: { ...x.rented, userStopped } } : x)) }));
    }
    if (action !== "start") {
      s.busyAt = null;
      s.busyKept = null;
      // a pod a cap stops while it starts is followed as being stopped too (asked again if it does not)
      s.stopping = s.pod?.status === "RUNNING" || (why === "cap" && TRANSITIONAL.has(s.pod?.status ?? ""));
      s.stoppingSince = s.stopping ? this.now() : null;
      await this.session(m, s.pod, s);
    }
    // a deployed pod terminated by its idle time, a cap or a boot that never came: nothing is left of it, its machine goes too
    // (the user's own Terminate removes it in stopBy)
    if (action === "terminate" && m.rented!.deployed && (why === "idle" || why === "cap" || why === "watchdog" || why === "filled" || why === "cut")) await this.forget(m, s);
    // told when Afflatus stopped it on its own, never for the user's own Stop
    if (action !== "start" && why && why !== "you" && !again) await this.sayStopped(m, s, action, why).catch((err: Error) => console.warn(`[rented] its stop not told: ${err.message}`));
    if (why === "filled") console.log(`[rented] ${m.name || m.id}: its volume filled, terminated`);
    if (why === "watchdog") console.log(`[rented] ${m.name || m.id}: found stopped by its watchdog, terminated (it kept nothing)`);
    if (why === "start") console.log(`[rented] ${m.name || m.id}: terminated (its start stopped: ${this.boots.get(m.id)?.failed ?? "an error"})`);
    if (why === "idle" || why === "cap" || why === "boot" || why === "gpu") console.log(`[rented] ${m.name || m.id}: ${action === "terminate" ? "terminated" : "stopped"} (${why === "idle" ? `idle ${m.rented!.idleMinutes} min` : why === "boot" ? `its ComfyUI never answered in ${bootLimit(m) / 60_000} min` : why === "gpu" ? "its GPU did not work on that host" : "a spending cap"})`);
    this.events.emit("queue");
    // read again soon, then at the fast pace while it moves
    this.kick(1500);
  }
}
