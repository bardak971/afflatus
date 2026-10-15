import type { MachineState } from "./api";
import { usd } from "./format";
import { rentedSaid, rentedSpent, rentedUp } from "./machines";
import { Progress } from "./progress/Progress";
import { cx } from "./ui";

// the machines' small parts, shared by the status bar's pill and its popover (loaded later, on the first click): a module of
// their own, so that neither imports the other

/** A machine's dot, in its state: filled in the accent while it renders, a green ring idle, grey paused, amber away. */
export function Dot({ m }: { m: MachineState }) {
  // a rented pod that is not running: a grey ring while stopped, amber and pulsing while it starts (its first start too,
  // RunPod saying it runs while its image is pulled)
  if (m.rented && (m.rented.status !== "RUNNING" || m.rented.booting)) {
    const starting = m.rented.status === "STARTING" || m.rented.status === "PROVISIONING" || m.rented.booting;
    return <span aria-hidden className={cx("size-[7px] shrink-0 rounded-full", starting ? "animate-pulse bg-warn" : "border-[1.5px] border-ink-3")} />;
  }
  if (m.online === false) return <span aria-hidden className="size-[7px] shrink-0 rounded-full bg-warn" />;
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
  if (rendering) return `${rendering} rendering`;
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
  const state = m.paused ? "paused" : "idle";
  return `${m.model ? `${state} · holds ${m.model}` : state}${cost}`;
}
