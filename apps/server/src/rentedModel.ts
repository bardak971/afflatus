import type { EventEmitter } from "node:events";
import type { Comfy } from "./comfy";
import type { Db } from "./db";
import { Runpod, type Pod, type PodStatus } from "./runpod";
import { BootLogs, type BootView } from "./podBoot";
import type { PullState } from "./podPull";
import type { Say } from "./notifyWords";

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
  /**
   * The CUDA build of the Afflatus image it runs ("13.0", "12.8": podImage.buildOf), and the CUDA its host's driver offers as
   * RunPod says it ("13.2"); null for another image, or while not known.
   */
  cuda: "13.0" | "12.8" | null;
  hostCuda: string | null;
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
   * stopped on an error (the Afflatus image, deployed from here); "crash" when its ComfyUI died on it (Seen.comfyDied).
   */
  stoppedBy: "idle" | "cap" | "you" | "boot" | "gpu" | "watchdog" | "filled" | "cut" | "start" | "crash" | null;
  /** Its ComfyUI died on it: why, as the pod said it (Seen.comfyDied), while that says what the pod is now; null otherwise. */
  crash: string | null;
  /** Deployed and on its first start (its image pulled, ComfyUI starting): a normal step, said as one, not as an error. */
  booting: boolean;
  /** While it boots: where it is (podBoot.ts bootOf), from RunPod's data and its boot log. */
  boot: BootView | null;
  /** What went wrong with this pod, or asking RunPod, when something did. */
  error: string | null;
}

export interface Seen {
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
  /**
   * What was asked of RunPod to stop it (the user's Stop or Terminate, a cap's or the idle time's action): what a stop asked
   * again sends, never the idle action in its place, which could make a user's Stop a Terminate and delete its disk.
   */
  stopAction: "stop" | "terminate" | null;
  /** Locking it once it is up was tried this session (lockPod): once, not at every read. */
  lockTried: boolean;
  /** When a read last saw it running (ms): a run found ended is closed there. */
  seenRunningAt: number | null;
  /** When its open session started (ms), as kept there (session): what its card counts "so far" from. */
  sessionFrom: number | null;
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
  /**
   * Its ComfyUI died after its start: as the pod reported it (broken.py's "comfy_died": died.py's line and numbers), or as the
   * queue found it (a ComfyUI started again without the render it ran: an older image, which says nothing of why; `report`
   * null). Kept past the pod's end, for its card. `handled`: its render failed and the death kept on its run, once; `told`: the
   * pod terminated (or, added by hand, the death said), done only once that succeeded and asked again at each read until then;
   * `render`: a render of Afflatus's was failed by it.
   */
  comfyDied: { said: string; report: Record<string, unknown> | null; from: "pod" | "queue"; handled: boolean; told: boolean; render: boolean } | null;
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
  /**
   * Its image's pull this run, from RunPod's system log (podPull.ts): the log's lines as last read, when, and the pull's state
   * from them; whether its figures are kept on its session, and how much of its boot log was last kept there (while boot
   * logs are kept). Reset when a new run's session opens, not by a read of it provisioning (when it pulls).
   */
  pullLines: Array<{ ts: string; line: string }>;
  pullReadAt: number;
  pull: PullState | null;
  pullKept: boolean;
  bootLogKept: string | null;
}

const fresh = (): Seen => ({
  pod: null, rate: null, watchdog: "unknown", answers: null, busyAt: null, busyKept: null, busyRestored: false, stoppedBy: null, stopAfter: false, cappedAt: null,
  stopping: false, stopAction: null, lockTried: false, seenRunningAt: null, sessionFrom: null, epoch: 0, error: null, bootNote: null, secretDropped: false, upAt: null, answered: false, answeredAt: null,
  read: false, gpuFailed: null, startFailed: null, comfyDied: null, missing: 0, stoppingSince: null, aliveAt: null, startingSince: null,
  handed: false, fillFrom: null, fillProgress: null, fillMovedAt: null, cutWhy: null, pulledKept: false, packsKept: null, containerAt: null,
  pullLines: [], pullReadAt: 0, pull: null, pullKept: false, bootLogKept: null,
});

/**
 * A pod not running (stopped, starting, provisioning, gone), as each read of it finds it: its run is over, and what the next
 * run counts afresh is reset (its idle clock, its cap's stop, its lock tried, its answers and first answer, what its
 * session was noted with). A stop under way and the boot note are left to the caller (follow), which ends them on other
 * conditions. An action of Afflatus's (act) resets the idle clock alone: a pod it stops may still be running, and its
 * answers and lock stand until a read finds it down.
 */
export function resetRun(s: Seen): void {
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
}

/**
 * A rented machine's state as it is followed (Seen, one per machine), and what every part of rented.ts shares: the
 * database, the queue, RunPod's client and clock, the boot logs. The parts are layered: billing, then the follow loop, then
 * deploys and volumes, then what the screens read (rented.ts); each reads only the layers below it.
 */
export class RentedCore {
  protected readonly seen = new Map<string, Seen>();
  /** The pods' boot logs, as last read (the Afflatus image's, deploy/runpod/bootlog.py), and how often (shorter in tests). */
  readonly boots = new BootLogs();

  /** What went wrong asking RunPod as a whole (the key, an answer not read): said on every rented card. */
  protected error: string | null = null;

  /** A deploy under way: a second one (another tab, Deploy again pressed twice) waits for it to end. */
  protected deploying = false;

  /** RunPod said to slow down: not asked again before this (ms). */
  protected quietUntil = 0;

  /** Where RunPod is asked, for a key: a test's stand-in. */
  client: (key: string) => Runpod = (key) => new Runpod(key);
  now: () => number = Date.now;

  /** Where what the user is told of goes (notify.ts; set by services.ts): a pod stopped, a cap reached, the balance low. */
  tell: Say | null = null;

  constructor(
    protected readonly db: Db,
    protected readonly queue: { wants(machine: string): Promise<boolean>; runningOn(machine: string): boolean; busyOn(machine: string): boolean; busyOutside(machine: string): Promise<boolean>; waitingBehindOutside(machine: string): boolean; fetching(machine: string): boolean; quietFor(machine: string, now?: number): { ms: number; gpuIdle: boolean }; overrunFor(machine: string, now?: number): { ms: number; forecastMs: number }; endStuck(machine: string, why: string): Promise<boolean>; machineDied(machine: string, why: string, trace: string | null): boolean; answering(machine: string): void },
    protected readonly events: EventEmitter,
    protected readonly comfyOf: (machine: string) => Promise<Comfy | null>,
  ) {}

  protected seenOf(machine: string): Seen {
    let s = this.seen.get(machine);
    if (!s) {
      s = fresh();
      this.seen.set(machine, s);
    }
    return s;
  }

  /** Machines deployed only to fill their volume: they take no render. */
  protected filling = new Set<string>();
}
