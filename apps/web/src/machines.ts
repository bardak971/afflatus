import type { MachineState, PodFile, QueueStatus, RentedState } from "./api";
import { stepSaid } from "@afflatus/core";
import { gb, minutesSaid, plural, usd } from "./format";

/** Several ComfyUIs (Settings › ComfyUI): how a machine is named on screen, and what the screens read of them. */

/** A machine's state in a word, as every screen says it (machineState). */
export type MachineWord = "rendering" | "busy outside Afflatus" | "getting files" | "idle" | "paused" | "offline" | "locked" | "stopped" | "starting" | "checking";

/** The plain words for "busy outside Afflatus", for its "?" and its tips. */
export const OUTSIDE_TIP = "ComfyUI is running work queued from elsewhere (its own page, another tool); Afflatus sends nothing there until it is done.";

/** Whether a machine's ComfyUI has work queued from outside Afflatus (its own page, another tool), running or waiting. */
export const busyOutside = (m: { outside?: MachineState["outside"] }): boolean => Boolean(m.outside && m.outside.running + m.outside.pending > 0);

/** That work in a few words: "1 prompt running, 2 queued in ComfyUI"; null when it has none. */
export function outsideSaid(m: { outside?: MachineState["outside"] }): string | null {
  const o = m.outside;
  if (!o || !busyOutside(m)) return null;
  if (o.running && o.pending) return `${plural(o.running, "prompt")} running, ${o.pending} queued in ComfyUI`;
  return o.running ? `${plural(o.running, "prompt")} running in ComfyUI` : `${plural(o.pending, "prompt")} queued in ComfyUI`;
}

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
 * as idle before. Nor does one whose ComfyUI runs work queued from outside Afflatus (its own page, another tool): it reads
 * "busy outside Afflatus", and takes no job until that is done.
 */
export function machineState(m: Pick<MachineState, "paused" | "online" | "rented"> & { locked?: boolean; running: unknown; files?: readonly PodFile[]; outside?: MachineState["outside"] }): MachineWord {
  const r = m.rented;
  // a pod RunPod was not read for yet (Afflatus just started): not known, never said stopped while it may be running
  if (r?.status === "UNKNOWN") return "checking";
  if (r && (r.status !== "RUNNING" || r.booting)) return r.status === "STARTING" || r.status === "PROVISIONING" || r.booting ? "starting" : "stopped";
  if (m.paused) return "paused";
  if (m.online === false) return m.locked ? "locked" : "offline";
  return m.running ? "rendering" : busyOutside(m) ? "busy outside Afflatus" : gettingFiles(m) ? "getting files" : "idle";
}

/**
 * The Queue's head with several ComfyUIs: how many answer, and how many are starting ("2 of 3 ComfyUIs online · 1
 * starting"). A pod starting (a deployed one's first start too) is neither online nor offline: the word machineState says.
 */
export function onlineSaid(machines: ReadonlyArray<Parameters<typeof machineState>[0]>): string {
  const starting = machines.filter((m) => machineState(m) === "starting").length;
  const online = machines.filter((m) => m.online !== false && machineState(m) !== "starting").length;
  return `${online} of ${machines.length} machines online${starting ? ` · ${starting} starting` : ""}`;
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

/**
 * No machine can take work: none of the user's own is listed, and no pod answers (a rented-only start before its first pod,
 * every pod stopped). Nothing is offline then: the jobs wait for a GPU, and Deploy is at hand.
 */
export const noGpuYet = (listed: ReadonlyArray<{ rented?: unknown }> | undefined, q: Pick<QueueStatus, "machines"> | undefined): boolean =>
  Boolean(listed) && !listed!.some((m) => !m.rented) && !(q?.machines ?? []).some((m) => m.online === true);

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
 * Every machine a typed name may mean, for a command that costs money (a pod's Start or Stop): the one named exactly, else
 * each whose name starts so, one row each, so that the bar never picks one of two pods for the user.
 */
export function machinesByName<M extends { id: string; name: string; url: string }>(machines: readonly M[] | undefined, typed: string): M[] {
  const want = typed.trim().toLowerCase();
  const all = machines ?? [];
  const exact = all.find((m) => m.id === want || machineLabel(m).toLowerCase() === want);
  return exact ? [exact] : all.filter((m) => machineLabel(m).toLowerCase().startsWith(want));
}

/**
 * Whether a machine's models can be unloaded now, and the few words why not: the rule unloadBlock (queueRules.ts) has
 * for one ComfyUI, for one of several: not while it is away, nor while it runs a job, nor while its ComfyUI runs work from
 * outside Afflatus (its models are someone else's then).
 */
export function machineUnloadBlock(m: { online: boolean | null; running: unknown; outside?: MachineState["outside"] }): string | null {
  if (m.online === false) return "it is offline";
  if (m.running) return "not while it renders";
  if (busyOutside(m)) return "it is busy outside Afflatus";
  return null;
}

/**
 * Whether a family is on for one machine: switched there by hand, else by the switch of every machine, else on with
 * `all` (a new install's rule: the switch says "I want it"), else by its files there. The server's rule (machineScans.ts
 * familyOn): what the queue sends a machine is what this says.
 */
export function familyOnFor(own: Readonly<Record<string, boolean>>, said: Readonly<Record<string, boolean>>, family: string, found: boolean, all = false): boolean {
  return own[family] ?? said[family] ?? (all || found);
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
 * Where a deployed pod's first start is, and for how long since its deploy, to the second: "pulling image · 2m 14s"
 * while RunPod says no uptime yet, "starting ComfyUI · 31s" once its container is up, then its boot log's step ("pip:
 * ComfyUI-KJNodes (3/14) · 1m 02s"); a start that stopped, where, and that the pod is terminated for it (the server does so
 * at once). The one phase line the pill's row, its tooltip, its popover and both cards say (through rentedSaid).
 */
export function bootSaid(b: RentedBoot, now = Date.now()): string {
  if (b.failed && b.step) return `start failed: ${stepSaid(b.step)} · terminated`;
  const what = b.phase === "pulling" ? (b.pull ? pullSaid(b.pull) : "pulling image") : b.phase === "starting" || !b.step ? "starting ComfyUI" : stepSaid(b.step);
  return `${what} · ${clock(now - b.from)}`;
}

/**
 * How far a pod's image pull is, from RunPod's system log: "pulling image 1.9/4.4 GB · 35 MB/s · ~2 min left"; before the
 * host begins it, that it waits for one; once all is downloaded, its extraction. Figures only when they are known.
 */
export function pullSaid(p: NonNullable<RentedBoot["pull"]>): string {
  const left = p.leftMs !== null ? ` · ~${Math.max(1, Math.round(p.leftMs / 60_000))} min left` : "";
  if (p.stage === "waiting") return "waiting for its host to pull the image";
  if (p.stage === "extracting") return `extracting image${left}`;
  const bytes = p.bytes ? ` ${(p.done / 2 ** 30).toFixed(1)}/${gb(p.bytes)}` : "";
  const speed = p.mbps !== null ? ` · ${p.mbps < 10 ? p.mbps.toFixed(1) : Math.round(p.mbps)} MB/s` : "";
  return `pulling image${bytes}${speed}${left}`;
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
  // terminated because its ComfyUI died: why, as its card says it (the pod's own words), not "not on RunPod"
  if (r.stoppedBy === "crash" && r.status !== "RUNNING") return r.crash ?? "ComfyUI died";
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

/** What a pod set never to stop when idle is said as (idleEndSaid), in its warning tone wherever it shows. */
export const NEVER_IDLE = "never stops when idle";

/**
 * How a pod ends by itself when idle, in a few words: "terminates after 10 min idle". At 0 it never does, and bills until it
 * is stopped by hand or at a cap: said so, never as "after never idle", which reads as if it stopped.
 */
export const idleEndSaid = (r: { idleMinutes: number; idleDo: "stop" | "terminate" }) => (r.idleMinutes ? `${r.idleDo === "stop" ? "stops" : "terminates"} after ${minutesSaid(r.idleMinutes)} idle` : NEVER_IDLE);

/** Whether a rented pod takes work now: only while it runs. A machine of one's own always may. */
export const rentedUp = (m: { rented?: RentedState | null }) => !m.rented || m.rented.status === "RUNNING";

/**
 * The account's pods (Settings › Rented GPUs), each a machine as soon as the settings say so: RunPod's list, read every
 * 15 s, may have been read just before a deploy saved its machine, and its pod showed as one to add until the next read.
 */
export function podsAdded<P extends { id: string; added: string | null }>(pods: readonly P[], machines: ReadonlyArray<{ id: string; rented?: { pod: string } | null }>): P[] {
  return pods.map((p) => ({ ...p, added: p.added ?? machines.find((m) => m.rented?.pod === p.id)?.id ?? null }));
}

/** A failure that says the room ran out: on a pod's own disk, or on the network volume its models are on (podFiles.ts, the node pack). */
export const NO_ROOM = /disk is full|disk is short|volume is (full|short)|no space left|\(507[:)]/i;

/** The network volume a machine's pod runs on, by id, from the settings' machines; null: none, or not a pod. */
export function volumeOf(machines: ReadonlyArray<{ id: string; rented?: { volume?: string } | null }> | undefined, id: string | null | undefined): string | null {
  return machines?.find((m) => m.id === id)?.rented?.volume || null;
}

/**
 * Where "Open the volume" leads: the volume's Files in Settings › Rented GPUs, on the folder of the file that did not fit,
 * with the files no render used lately picked (`full`).
 */
export const volumeHref = (volume: string, folder?: string) => `/settings/rented?volume=${encodeURIComponent(volume)}&full=1${folder ? `&folder=${encodeURIComponent(folder)}` : ""}`;
