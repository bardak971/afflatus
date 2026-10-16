import type { MachineState, PodFile, QueueStatus, RentedState } from "./api";
import { usd } from "./format";

/** Several ComfyUIs (Settings › ComfyUI): how a machine is named on screen, and what the screens read of them. */

/** A machine's state in a word, as every screen says it (machineState). */
export type MachineWord = "rendering" | "getting files" | "idle" | "paused" | "offline" | "locked" | "stopped" | "starting" | "checking";

/** What a machine is getting, as gettingFiles reads it: a rented pod's files, or the downloads into a ComfyUI of one's own. */
type WithFiles = Pick<MachineState, "rented"> & { files?: readonly PodFile[] };

/**
 * The files a machine is getting, null when there are none: a rented pod's that its jobs wait for, else the ones under way
 * for later (asked ahead, a download into a ComfyUI of one's own) while one of them is coming; how many are left, the
 * bytes in and in all, and the file under way (else the next). `share` is null while a file left has no size yet (a source
 * that does not say it): the bytes in are said then, never a share that would read as done. `ahead`: none of them is waited
 * for by a job.
 */
export function gettingFiles(m: WithFiles): { left: PodFile[]; done: number; total: number; share: number | null; now: PodFile; ahead: boolean } | null {
  const all = m.rented?.files ?? m.files ?? [];
  const leftOf = (list: readonly PodFile[]) => list.filter((f) => f.state === "next" || f.state === "fetching");
  const need = all.filter((f) => f.tier === "need");
  const ahead = !leftOf(need).length;
  // files for later count only while one comes: a line of them waiting behind nothing says no more than idle
  const files = ahead ? (all.some((f) => f.tier === "ahead" && f.state === "fetching") ? all.filter((f) => f.tier === "ahead") : []) : need;
  const left = leftOf(files);
  if (!left.length) return null;
  const done = files.reduce((n, f) => n + (f.state === "ready" ? f.total : f.bytes), 0);
  const total = files.reduce((n, f) => n + f.total, 0);
  const known = left.every((f) => f.total > 0);
  return { left, done, total, share: known && total > 0 ? Math.min(1, done / total) : null, now: left.find((f) => f.state === "fetching") ?? left[0]!, ahead };
}

/**
 * A machine's state in a word: a rented pod not running is stopped or starting (it was "offline" on the Queue page),
 * a ComfyUI locked against Afflatus's token is locked (it was "offline" in Ctrl+K), then paused, away, rendering, getting
 * files, idle. The one rule the Queue's lanes, the machine menus, Ctrl+K, Generate on and the waiting list's Run on read:
 * seven places worked it out each in its own order. A machine that renders nothing while files come to it reads "getting
 * files", never idle: a pod's idle time is held while they move (the server's podFiles.ts), and minutes of downloads read
 * as idle before.
 */
export function machineState(m: Pick<MachineState, "paused" | "online" | "rented"> & { locked?: boolean; running: unknown; files?: readonly PodFile[] }): MachineWord {
  const r = m.rented;
  // a pod RunPod was not read for yet (Afflatus just started): not known, never said stopped while it may be running
  if (r?.status === "UNKNOWN") return "checking";
  if (r && (r.status !== "RUNNING" || r.booting)) return r.status === "STARTING" || r.status === "PROVISIONING" || r.booting ? "starting" : "stopped";
  if (m.paused) return "paused";
  if (m.online === false) return m.locked ? "locked" : "offline";
  return m.running ? "rendering" : gettingFiles(m) ? "getting files" : "idle";
}

/**
 * The Queue's head with several ComfyUIs: how many answer, and how many are starting ("2 of 3 ComfyUIs online · 1
 * starting"). A pod starting (a deployed one's first start too) is neither online nor offline: the word machineState says.
 */
export function onlineSaid(machines: ReadonlyArray<Parameters<typeof machineState>[0]>): string {
  const starting = machines.filter((m) => machineState(m) === "starting").length;
  const online = machines.filter((m) => m.online !== false && machineState(m) !== "starting").length;
  return `${online} of ${machines.length} ComfyUIs online${starting ? ` · ${starting} starting` : ""}`;
}

/** A machine as the screens name it: its own name, else its address's host and port ("127.0.0.1:8189"). */
export function machineLabel(m: { name: string; url: string }): string {
  if (m.name.trim()) return m.name.trim();
  try {
    return new URL(m.url).host;
  } catch {
    return m.url;
  }
}

/** The machines of the queue, when there are several; empty with one (the screens then stay as they were). */
export const severalMachines = (q: QueueStatus | undefined): MachineState[] => (q?.machines && (q.machines.length > 1 || q.machines.some((m) => m.rented)) ? q.machines : []);

/**
 * What a render takes on a machine: the server's figure for that machine (`on`, from its own renders of the model, else
 * the others' at its pace) when it gave one, else the common figure at the machine's learned pace. No machine (Auto): the
 * common figure, which the server says on the machine that renders it soonest.
 */
export function timeOn(ms: number | null, on: Readonly<Record<string, number>> | null | undefined, machine: Pick<MachineState, "id" | "pace"> | null | undefined): number | null {
  if (ms === null || !machine) return ms;
  return on?.[machine.id] ?? ms * (machine.pace ?? 1);
}

/** A machine of the queue by id, as the screens name it; the id itself when the queue does not have it (one removed since). */
export function machineName(q: QueueStatus | undefined, id: string | null | undefined): string | null {
  if (!id) return null;
  const m = q?.machines?.find((x) => x.id === id);
  return m ? machineLabel(m) : id;
}

/** A machine named as typed (the command bar's "pause studio pc"): its id or its name, case not minding, else the one whose name starts so. */
export function machineByName<M extends { id: string; name: string; url: string }>(machines: readonly M[] | undefined, typed: string): M | undefined {
  const want = typed.trim().toLowerCase();
  const all = machines ?? [];
  return all.find((m) => m.id === want || machineLabel(m).toLowerCase() === want) ?? all.find((m) => machineLabel(m).toLowerCase().startsWith(want));
}

/**
 * Whether a machine's models can be unloaded now, and the few words why not: the rule unloadBlock (queueRules.ts) has
 * for one ComfyUI, for one of several: not while it is away, nor while it runs a job.
 */
export function machineUnloadBlock(m: { online: boolean | null; running: unknown }): string | null {
  if (m.online === false) return "it is offline";
  if (m.running) return "not while it renders";
  return null;
}

/**
 * Whether a family is on for one machine: switched there by hand, else by the switch of every machine, else by its files
 * there. The server's rule (machineScans.ts familyOn): what the queue sends a machine is what this says.
 */
export function familyOnFor(own: Readonly<Record<string, boolean>>, said: Readonly<Record<string, boolean>>, family: string, found: boolean): boolean {
  return own[family] ?? said[family] ?? found;
}

/** Where a deployed pod's first start is (the server's podBoot.ts bootOf). */
export type RentedBoot = NonNullable<RentedState["boot"]>;

/** How long a deployed pod may take to answer before Afflatus terminates it (the server's DEPLOYED_BOOT_LIMIT_MS). */
export const BOOT_LIMIT_MIN = 20;

/** A pod's running time, as its boot and its run say it, to the second under an hour: "31s", "2m 14s", "1h 05m". */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const two = (n: number) => String(n).padStart(2, "0");
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${two(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${two(Math.floor((s % 3600) / 60))}m`;
}

/**
 * The boot log's steps (start.sh's, ComfyUI's own course read by the server's podBoot.ts, broken.py's GPU check) in the
 * words of someone who knows a pod: what runs, not what it is for. A step not known here is said as the pod says it.
 */
const STEP_SAID: Array<[RegExp, (m: RegExpExecArray) => string]> = [
  [/^checking the GPU$/, () => "checking GPU"],
  [/^preparing ComfyUI's folders$/, () => "creating model folders"],
  [/^putting in the node packs$/, () => "linking node packs"],
  // one pip install per node pack a volume holds, counted by start.sh (0.1.12 on): "pip: ComfyUI-KJNodes (3/14)"
  [/^installing the Python packages of (.+?)(?: \((\d+\/\d+)\))?$/, (m) => `pip: ${m[1]}${m[2] ? ` (${m[2]})` : ""}`],
  [/^setting up ComfyUI-Manager$/, () => "configuring ComfyUI-Manager"],
  [/^the GPU does not work on this host: (.+)$/, (m) => `GPU fault: ${m[1]}`],
];

/** A boot log's step in those words; a failed one keeps its exit code ("checking GPU (exit 1)"). */
export function stepSaid(step: string): string {
  const exit = / \(exit \d+\)$/.exec(step);
  const bare = exit ? step.slice(0, exit.index) : step;
  for (const [mark, said] of STEP_SAID) {
    const m = mark.exec(bare);
    if (m) return `${said(m)}${exit?.[0] ?? ""}`;
  }
  return step;
}

/**
 * Where a deployed pod's first start is, and for how long since its deploy, to the second: "pulling image · 2m 14s"
 * while RunPod says no uptime yet, "starting ComfyUI · 31s" once its container is up, then its boot log's step ("pip:
 * ComfyUI-KJNodes (3/14) · 1m 02s"); a start that stopped, where, and that the pod is terminated for it (the server does so
 * at once). The one phase line the pill's row, its tooltip, its popover and both cards say (through rentedSaid).
 */
export function bootSaid(b: RentedBoot, now = Date.now()): string {
  if (b.failed && b.step) return `start failed: ${stepSaid(b.step)} · terminated`;
  const what = b.phase === "pulling" ? "pulling image" : b.phase === "starting" || !b.step ? "starting ComfyUI" : stepSaid(b.step);
  return `${what} · ${clock(now - b.from)}`;
}

/**
 * A booting pod's second line, the same in the pill's popover and on its card: what the boot is bound by, in a few words
 * (the boot log's link after it, the screen's), and the plain explanation for its "?" only.
 */
export function bootNote(b: RentedBoot): { said: string; tip: string } {
  return {
    said: b.failed ? "boot · start failed: terminated at once" : `boot · auto-terminate at ${BOOT_LIMIT_MIN}m if ComfyUI doesn't answer`,
    tip: `A pod's first start after its deploy. RunPod first pulls its image onto the host: seconds on a host that has it, minutes on one new to it. Then its container starts and ComfyUI loads its custom nodes. It is billed from the deploy, the pull included. If ComfyUI does not answer within ${BOOT_LIMIT_MIN} min of the deploy, Afflatus terminates the pod by itself, so that a pod that never comes up does not go on billing; a start that stops on an error is terminated at once. The boot log (Queue › Log) shows each step until ComfyUI answers.`,
  };
}

/**
 * A rented pod's state in a few words, for its row, the pill and the menus: "starting", "stopped · disk $0.33/day",
 * "running · $0.83". What it costs is Afflatus's figure (its time × its rate), said as it is: RunPod's bill is the reference.
 * A deployed pod's first start says where it is (bootSaid).
 */
export function rentedSaid(r: RentedState, now = Date.now()): string {
  if (r.boot && !r.stopping && (r.status === "RUNNING" || r.status === "STARTING" || r.status === "PROVISIONING")) {
    // its time and its cost from the one `now`, so that the two never disagree in one line (each screen passes the shared clock, useSecond)
    return `${bootSaid(r.boot, now)}${r.status === "RUNNING" && r.since ? ` · ${usd(rentedSpent(r, now), true)}` : ""}`;
  }
  switch (r.status) {
    case "RUNNING": {
      // billed from its start, whether its ComfyUI answers yet or not; a deployed pod's first start is a step of its own
      const what = r.stopping ? "stopping" : r.booting ? "deploying" : r.answers === false ? "running, ComfyUI not up yet" : "running";
      // its time as its boot said it (clock), so that the line goes on from "linking node packs · 1m 02s" in one style
      return r.since ? `${what} ${clock(now - r.since)} · ${usd(rentedSpent(r, now), true)}` : what;
    }
    case "STARTING": return "starting";
    // a pod just deployed: RunPod pulls its image onto the host first, minutes on one that never had it
    case "PROVISIONING": return "deploying · pulling image";
    case "EXITED": return r.diskPerDay > 0.005 ? `stopped · disk ${usd(r.diskPerDay)}/day` : "stopped";
    case "GONE": case "TERMINATED": return "not on RunPod";
    case "ERROR": return "in error on RunPod";
    default: return r.error ? "RunPod not answering" : "…";
  }
}

/** What a running pod has cost so far, worked out here from its start and its rate: it counts on screen between two reads. */
export function rentedSpent(r: RentedState, now = Date.now()): number {
  return r.status === "RUNNING" && r.since && r.rate ? (Math.max(0, now - r.since) / 3_600_000) * r.rate : r.spent;
}

/** RunPod's price of a pod's own disk while it runs, USD per GB and month, billed by the hour over 730 hours (the server's runpod.ts). */
const DISK_RUNNING_PER_GB_MONTH = 0.1;
const HOURS_A_MONTH = 730;

/** What a pod's own disk adds to its GPU's price an hour while it runs (USD): RunPod bills it with the GPU. */
export const diskPerHour = (gb: number) => (Math.max(0, gb) * DISK_RUNNING_PER_GB_MONTH) / HOURS_A_MONTH;

/**
 * A pod's rate, its GPU and its disk, as its "?" says it: "GPU $0.59 + disk $0.02 an hour, as RunPod bills it". Null
 * without the GPU's part, and when the rate is the GPU's alone (no disk, or one too small to show): "+ its disk $0.00" said nothing.
 */
export function rateParts(r: Pick<RentedState, "rate" | "gpuRate">): string | null {
  if (!r.rate || !r.gpuRate || r.rate - r.gpuRate < 0.0005) return null;
  return `GPU ${usd(r.gpuRate)} + its disk ${usd(Math.max(0, r.rate - r.gpuRate), true)} an hour while it runs, as RunPod bills it`;
}

/** A rented pod's rate as Start says it: RunPod says it only once the pod has run (it says 0 while it is stopped). */
export const rateSaid = (r: RentedState) => (r.rate ? `${usd(r.rate)} / h from now` : "rate known once it has run · billed from now");

/** Whether a rented pod takes work now: only while it runs. A machine of one's own always may. */
export const rentedUp = (m: { rented?: RentedState | null }) => !m.rented || m.rented.status === "RUNNING";
