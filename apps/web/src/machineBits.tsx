import type { MachineState, PodFile } from "./api";
import { gb, plural, usd } from "./format";
import { machineState, rentedSaid, rentedSpent, rentedUp } from "./machines";
import { Progress } from "./progress/Progress";
import { cx } from "./ui";

// the machines' small parts, shared by the status bar's pill and its popover (loaded later, on the first click) and the
// Queue's lanes: a module of their own, so that none imports the others

/**
 * The files a rented pod is getting for the jobs that wait for it (those asked ahead are not waited for), null when there
 * are none: how many are left, the bytes in and in all, and the file under way (else the next).
 */
export function gettingFiles(m: MachineState): { left: PodFile[]; done: number; total: number; share: number; now: PodFile } | null {
  const files = (m.rented?.files ?? []).filter((f) => f.tier === "need");
  const left = files.filter((f) => f.state === "next" || f.state === "fetching");
  if (!left.length) return null;
  const done = files.reduce((n, f) => n + (f.state === "ready" ? f.total : f.bytes), 0);
  const total = files.reduce((n, f) => n + f.total, 0);
  return { left, done, total, share: total > 0 ? Math.min(1, done / total) : 0, now: left.find((f) => f.state === "fetching") ?? left[0]! };
}

/** Where a pod's file comes from, as its line says it. */
export const fromSaid = (via: PodFile["via"]) => (via === "hf" ? "Hugging Face" : via === "civitai" ? "Civitai" : via === "upload" ? "this PC" : via === "url" ? "its address" : "");

/** Every file a pod is getting, a line each, for a tip: its name, how far, where from. */
export const filesTip = (label: string, g: NonNullable<ReturnType<typeof gettingFiles>>) =>
  `${label}: getting ${plural(g.left.length, "file")} for its jobs${g.total ? `, ${gb(g.done)} of ${gb(g.total)}` : ""}\n${g.left
    .map((f) => `${f.state === "fetching" ? "now" : "next"}: ${f.file}${f.total ? ` · ${gb(f.total)}` : ""}${f.via ? ` · from ${fromSaid(f.via)}` : ""}`)
    .join("\n")}`;

/** How far a pod's files are, as a bar with the bytes, and the file under way with where it comes from. */
export function FilesLine({ g }: { g: NonNullable<ReturnType<typeof gettingFiles>> }) {
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="flex items-center gap-2">
        <Progress value={g.share} className="h-1.5 grow" under="bg-line" label="Files fetched" />
        {g.total > 0 && <span className="shrink-0 font-mono text-[11.5px] text-ink-2">{gb(g.done)} of {gb(g.total)}</span>}
      </span>
      <span className="truncate text-[11.5px] text-ink-2">{g.now.state === "fetching" ? "now" : "next"}: {g.now.file}{g.now.via ? ` · from ${fromSaid(g.now.via)}` : ""}</span>
    </span>
  );
}

/** A ring round a machine's dot that fills as its files come in: on its idle dot, or round its filled one while it renders. */
function FilesRing({ share, running }: { share: number; running: boolean }) {
  const round = 2 * Math.PI * 4;
  return (
    <svg aria-hidden width="11" height="11" viewBox="0 0 11 11" className="shrink-0">
      <circle cx="5.5" cy="5.5" r="4" fill={running ? "currentColor" : "none"} strokeWidth="1.8" className={running ? "text-accent stroke-accent" : "stroke-line-strong"} />
      <circle cx="5.5" cy="5.5" r="4" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeDasharray={`${Math.max(0.6, share * round)} ${round}`} transform="rotate(-90 5.5 5.5)" className={running ? "stroke-ink" : "stroke-accent"} />
    </svg>
  );
}

/** A machine's dot, in its state: filled in the accent while it renders, a green ring idle, grey paused, amber away; a ring that fills while it gets files. */
export function Dot({ m }: { m: MachineState }) {
  // a rented pod that is not running: a grey ring while stopped, amber and pulsing while it starts (its first start too,
  // RunPod saying it runs while its image is pulled)
  if (m.rented && (m.rented.status !== "RUNNING" || m.rented.booting)) {
    const starting = m.rented.status === "STARTING" || m.rented.status === "PROVISIONING" || m.rented.booting;
    return <span aria-hidden className={cx("size-[7px] shrink-0 rounded-full", starting ? "animate-pulse bg-warn" : "border-[1.5px] border-ink-3")} />;
  }
  if (m.online === false) return <span aria-hidden className="size-[7px] shrink-0 rounded-full bg-warn" />;
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
  const away = machines.filter((m) => m.online === false && rentedUp(m)).length;
  const starting = machines.filter((m) => m.rented?.status === "STARTING" || m.rented?.status === "PROVISIONING").length;
  const paused = machines.filter((m) => m.paused).length;
  const getting = machines.filter((m) => !m.running && gettingFiles(m)).length;
  if (rendering) return `${rendering} rendering`;
  if (getting) return `${getting} getting files`;
  if (starting) return `${starting} starting`;
  if (away) return `${away} offline`;
  if (paused) return paused === machines.length ? "all paused" : `${paused} paused`;
  return "all idle";
}

/** What a machine does, in a few words, for its row. */
export function doing(m: MachineState, now: number): string {
  // a rented pod: its own state first (stopped, starting, its ComfyUI not up yet), its cost while it runs
  if (m.rented && (m.rented.status !== "RUNNING" || m.rented.stopping || m.rented.answers === false)) return rentedSaid(m.rented, now);
  const cost = m.rented?.since ? ` · ${usd(rentedSpent(m.rented, now), true)}` : "";
  if (m.online === false) return m.locked ? "locked: its token is wrong" : "offline";
  if (m.running) return `${m.running.label}${m.running.steps ? ` · ${m.running.step}/${m.running.steps}` : ` · ${Math.round(m.running.progress * 100)} %`}${cost}`;
  const getting = gettingFiles(m);
  if (getting) return `${m.paused ? "paused · " : ""}getting ${plural(getting.left.length, "file")} for its jobs${cost}`;
  const state = machineState(m);
  return `${m.model ? `${state} · holds ${m.model}` : state}${cost}`;
}
