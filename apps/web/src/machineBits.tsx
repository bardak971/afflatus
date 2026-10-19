import { Link } from "wouter";
import type { MachineState, PodDisk, PodFile } from "./api";
import { gb, plural, usd } from "./format";
import { bootNote, busyOutside, gettingFiles, machineState, outsideSaid, rentedSaid, rentedSpent, rentedUp, type RentedBoot } from "./machines";

// the files a machine is getting: worked out with its state's word (machines.ts), read here too
export { gettingFiles };
import { Progress } from "./progress/Progress";
import { cx, Help } from "./ui";

// the machines' small parts, shared by the status bar's pill and its popover (loaded later, on the first click) and the
// Queue's lanes: a module of their own, so that none imports the others

/** How far, in a few characters: the share, or the bytes in while a size is not known. */
export const filesSaid = (g: NonNullable<ReturnType<typeof gettingFiles>>) => (g.share === null ? `${gb(g.done)} in` : `${Math.floor(g.share * 100)} %`);

/** A pod's disk in use of all of it ("92.1/120.0 GB"), and whether it is nearly full (90 % on: said in amber). */
export const diskSaid = (d: PodDisk) => `${gb(d.total - d.free).replace(" GB", "")}/${gb(d.total)}`;
export const diskNearlyFull = (d: PodDisk) => d.total > 0 && (d.total - d.free) / d.total >= 0.9;

/** Where a pod's file comes from, as its line says it. */
export const fromSaid = (via: PodFile["via"]) => (via === "hf" ? "Hugging Face" : via === "civitai" ? "Civitai" : via === "upload" ? "this PC" : via === "url" ? "its address" : "");

/** Every file a machine is getting, a line each, for a tip: its name, how far, where from. */
export const filesTip = (label: string, g: NonNullable<ReturnType<typeof gettingFiles>>) =>
  `${label}: getting ${plural(g.left.length, "file")}${g.ahead ? "" : " for its jobs"}, ${g.share === null ? `${gb(g.done)} in` : `${gb(g.done)} of ${gb(g.total)}`}\n${g.left
    .map((f) => `${f.state === "fetching" ? "now" : "next"}: ${f.file}${f.total ? ` · ${gb(f.total)}` : ""}${f.via ? ` · from ${fromSaid(f.via)}` : ""}`)
    .join("\n")}`;

/** How far a pod's files are, as a bar with the bytes, and the file under way with where it comes from. */
export function FilesLine({ g }: { g: NonNullable<ReturnType<typeof gettingFiles>> }) {
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="flex items-center gap-2">
        <Progress value={g.share ?? 0} loading={g.share === null} className="h-1.5 grow" under="bg-line" label="Files fetched" />
        <span className="shrink-0 font-mono text-[11.5px] text-ink-2">{g.share === null ? `${gb(g.done)} in` : `${gb(g.done)} of ${gb(g.total)}`}</span>
      </span>
      <span className="truncate text-[11.5px] text-ink-2">{g.now.state === "fetching" ? "now" : "next"}: {g.now.file}{g.now.via ? ` · from ${fromSaid(g.now.via)}` : ""}</span>
    </span>
  );
}

/** A ring round a machine's dot that fills as its files come in: on its idle dot, or round its filled one while it renders. */
function FilesRing({ share, running }: { share: number | null; running: boolean }) {
  const round = 2 * Math.PI * 4;
  // a size not known: a quarter that turns, not a share
  return (
    <svg aria-hidden width="11" height="11" viewBox="0 0 11 11" className={cx("shrink-0", share === null && "motion-safe:animate-spin")}>
      <circle cx="5.5" cy="5.5" r="4" fill={running ? "currentColor" : "none"} strokeWidth="1.8" className={running ? "text-accent stroke-accent" : "stroke-line-strong"} />
      <circle cx="5.5" cy="5.5" r="4" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeDasharray={`${Math.max(0.6, (share ?? 0.25) * round)} ${round}`} transform="rotate(-90 5.5 5.5)" className={running ? "stroke-ink" : "stroke-accent"} />
    </svg>
  );
}

/**
 * A machine's dot, in its state: filled in the accent while it renders, an accent ring on its wash while its ComfyUI is busy
 * outside Afflatus, a green ring idle, grey paused, amber away; a ring that fills while it gets files.
 */
/**
 * A machine on its way up, as its dot says it in the pill, its popover and its Queue lane: the idle ring it will be,
 * pulsing. Neither the warning of one away nor the accent of one getting files.
 */
export const STARTING_DOT = "animate-pulse border-[1.5px] border-good";

export function Dot({ m }: { m: MachineState }) {
  // a pod RunPod was not read for yet (Afflatus just started): grey and filled, as its lane says "checking", never the
  // stopped ring while it may be running
  if (m.rented?.status === "UNKNOWN") return <span aria-hidden data-state="checking" className="size-[7px] shrink-0 rounded-full bg-ink-3" />;
  // a rented pod that is not running: a grey ring while stopped, the starting look while it starts (its first start too,
  // RunPod saying it runs while its image is pulled). It was a pulsing warning dot, which read as an error in a theme
  // whose warning is red: the warning is for a start that failed, as for a machine away
  if (m.rented && (m.rented.status !== "RUNNING" || m.rented.booting)) {
    // a start that failed, or a ComfyUI that died on it (terminated as a crash): the warning, not the stopped ring
    if (m.rented.boot?.failed || m.rented.stoppedBy === "crash") return <span aria-hidden data-state="failed" className="size-[7px] shrink-0 rounded-full bg-warn" />;
    const starting = m.rented.status === "STARTING" || m.rented.status === "PROVISIONING" || m.rented.booting;
    return starting
      ? <span aria-hidden data-state="starting" className={cx("size-[7px] shrink-0 rounded-full", STARTING_DOT)} />
      : <span aria-hidden data-state="stopped" className="size-[7px] shrink-0 rounded-full border-[1.5px] border-ink-3" />;
  }
  if (m.online === false) return <span aria-hidden className="size-[7px] shrink-0 rounded-full bg-warn" />;
  // its ComfyUI at work for someone else (its own page): an accent ring filled with its wash, as its Queue lane has it,
  // never the idle ring
  if (!m.running && !m.paused && busyOutside(m)) return <span aria-hidden data-state="outside" className="size-[7px] shrink-0 rounded-full border-[1.5px] border-accent bg-accent-wash" />;
  // minutes of downloads read as idle before (the owner: "the pills could show when something is downloading")
  const getting = gettingFiles(m);
  if (getting) return <FilesRing share={getting.share} running={Boolean(m.running)} />;
  if (m.paused) return <span aria-hidden className="size-[7px] shrink-0 rounded-full bg-ink-3" />;
  return <span aria-hidden className={cx("size-[7px] shrink-0 rounded-full", m.running ? "bg-accent" : "border-[1.5px] border-good")} />;
}

/** A small bar, its figure in the tip: the pill has the room for two of them, not for their numbers. */
export function Bar({ label, value, warn, hot, tip }: { label: string; value: number; warn?: boolean; hot?: boolean; tip?: string }) {
  return (
    <span className={cx("inline-flex shrink-0 items-center gap-1.5 text-ink-2", warn && "text-warn-ink")} data-tip={tip ?? `${label} ${Math.round(value)} %`}>
      {label}
      <Progress meter value={value / 100} className="h-1 w-[26px]" radius="rounded-[3px]" tone={warn ? "bg-warn" : hot ? "bg-accent" : "bg-ink-2"} />
    </span>
  );
}

/** The word for the machines together: the busiest thing they do. */
export function busiest(machines: MachineState[]): string {
  const rendering = machines.filter((m) => m.running).length;
  // a deployed pod's first start is starting, not offline: RunPod says it runs while its image is pulled and ComfyUI starts
  const starting = machines.filter((m) => machineState(m) === "starting").length;
  const away = machines.filter((m) => m.online === false && rentedUp(m) && machineState(m) !== "starting").length;
  const paused = machines.filter((m) => m.paused).length;
  const getting = machines.filter((m) => !m.running && gettingFiles(m)).length;
  const outside = machines.filter((m) => machineState(m) === "busy outside Afflatus").length;
  if (rendering) return `${rendering} rendering`;
  if (outside) return `${outside} busy outside Afflatus`;
  if (getting) return `${getting} getting files`;
  if (starting) return `${starting} starting`;
  if (away) return `${away} offline`;
  if (paused) return paused === machines.length ? "all paused" : `${paused} paused`;
  return "all idle";
}

/** What a machine does, in a few words, for its row. */
export function doing(m: MachineState, now: number): string {
  // a rented pod: its own state first (stopped, starting, its first start, its ComfyUI not up yet), its cost while it runs
  if (m.rented && (m.rented.status !== "RUNNING" || m.rented.stopping || m.rented.booting || m.rented.answers === false)) return rentedSaid(m.rented, now);
  const cost = m.rented?.since ? ` · ${usd(rentedSpent(m.rented, now), true)}` : "";
  if (m.online === false) return m.locked ? "locked: its token is wrong" : "offline";
  if (m.running) return `${m.running.label}${m.running.steps ? ` · ${m.running.step}/${m.running.steps}` : ` · ${Math.round(m.running.progress * 100)} %`}${cost}`;
  if (!m.paused && busyOutside(m)) return `busy outside Afflatus · ${outsideSaid(m)}${cost}`;
  const getting = gettingFiles(m);
  if (getting) return `${m.paused ? "paused · " : ""}getting ${plural(getting.left.length, "file")}${getting.ahead ? "" : " for its jobs"}${cost}`;
  const state = machineState(m);
  return `${m.model ? `${state} · holds ${m.model}` : state}${cost}`;
}

/**
 * A pod's CUDA build ("CUDA 13.0" / "CUDA 12.8"), beside its GPU on its card, the pill's popover and the Queue's row; its host
 * driver's CUDA and the plain words in its tip. Nothing for a pod whose image is not Afflatus's (its build not known).
 */
export function CudaChip({ m, className }: { m: Pick<MachineState, "rented">; className?: string }) {
  const build = m.rented?.cuda;
  if (!build) return null;
  const host = m.rented?.hostCuda;
  const tip = `The pod image's CUDA build: ${build}. Afflatus deploys the 13.0 build where a host of that GPU with a driver for CUDA 13 is free, else the 12.8 build (the same PyTorch for an older driver).${host ? ` This host's driver: CUDA ${host}.` : ""} How fast each build renders on a GPU is learned from your renders (Queue › Render times).`;
  return <span className={cx("shrink-0 rounded bg-raised px-1.5 py-px font-mono text-[10.5px] text-ink-2", className)} data-tip={tip}>CUDA {build}</span>;
}

/**
 * A booting pod's second line, the one the pill's popover and its card say (bootNote): what bounds its boot, its boot log's
 * link (Queue › Log), the plain words in its "?". `inside`: within a row that is a button of its own (the popover's).
 */
export function BootNote({ machine, boot, inside, className }: { machine: string; boot: RentedBoot; inside?: boolean; className?: string }) {
  const { said, tip } = bootNote(boot);
  return (
    <span className={cx("inline-flex min-w-0 items-center gap-1.5 text-ink-3", className)}>
      <span className="min-w-0 truncate">
        {said} ·{" "}
        {/* a click on the link is not one on the popover's row (which picks the machine for the pill's meters) */}
        <Link href={`/queue?view=log&machine=${encodeURIComponent(machine)}`} onClick={(e) => e.stopPropagation()} className="font-semibold text-accent hover:underline">boot log</Link>
      </span>
      <Help text={tip} inside={inside} />
    </span>
  );
}
