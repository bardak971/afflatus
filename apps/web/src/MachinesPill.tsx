import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, MoreHorizontal, Pause, Play } from "lucide-react";
import { Link } from "wouter";
import type { MachineState } from "./api";
import { useMenu } from "./ContextMenu";
import { useQueue, useSettings } from "./data";
import { lastSaid, openDeploy, useDeployAgain } from "./deploy";
import { gb, plural, usd } from "./format";
import { useNow } from "./hooks";
import { machineLabel, rentedSaid, rentedSpent, rentedUp, severalMachines } from "./machines";
import { Popover } from "./Popover";
import { queryKeys } from "./queryKeys";
import { useQueueOps } from "./queueOps";
import { useMeteredMachine, useSystem } from "./store";
import { cx } from "./ui";

// the menu is opened now and then: fetched the first time, the strip itself is in the first load
const MachineMenuBody = lazy(() => import("./MachineMenu").then((m) => ({ default: m.MachineMenuBody })));

/** Asked by the strip's "+1" (other renders): the pill opens its popover. */
export const OPEN_MACHINES = "afflatus:machines";

/** A machine's dot, in its state: filled in the accent while it renders, a green ring idle, grey paused, amber away. */
function Dot({ m }: { m: MachineState }) {
  // a rented pod that is not running: a grey ring while stopped, amber and pulsing while it starts
  if (m.rented && m.rented.status !== "RUNNING") {
    const starting = m.rented.status === "STARTING" || m.rented.status === "PROVISIONING";
    return <span aria-hidden className={cx("size-[7px] shrink-0 rounded-full", starting ? "animate-pulse bg-warn" : "border-[1.5px] border-ink-3")} />;
  }
  if (m.online === false) return <span aria-hidden className="size-[7px] shrink-0 rounded-full bg-warn" />;
  if (m.paused) return <span aria-hidden className="size-[7px] shrink-0 rounded-full bg-ink-3" />;
  return <span aria-hidden className={cx("size-[7px] shrink-0 rounded-full", m.running ? "bg-accent" : "border-[1.5px] border-good")} />;
}

/** A small bar, its figure in the tip: the pill has the room for two of them, not for their numbers. */
function Bar({ label, value, warn, hot, tip }: { label: string; value: number; warn?: boolean; hot?: boolean; tip?: string }) {
  return (
    <span className={cx("inline-flex shrink-0 items-center gap-1.5 text-ink-2", warn && "text-warn-ink")} data-tip={tip ?? `${label} ${Math.round(value)} %`}>
      {label}
      <span className="relative h-1 w-[26px] overflow-hidden rounded-[3px] bg-line-strong">
        <span className={cx("absolute inset-y-0 left-0 rounded-[3px]", warn ? "bg-warn" : hot ? "bg-accent" : "bg-ink-2")} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      </span>
    </span>
  );
}

/** The word for the machines together: the busiest thing they do. */
function busiest(machines: MachineState[]): string {
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
function doing(m: MachineState, now: number): string {
  // a rented pod: its own state first (stopped, starting, its ComfyUI not up yet), its cost while it runs
  if (m.rented && (m.rented.status !== "RUNNING" || m.rented.stopping || m.rented.answers === false)) return rentedSaid(m.rented, now);
  const cost = m.rented?.since ? ` · ${usd(rentedSpent(m.rented, now), true)}` : "";
  if (m.online === false) return m.locked ? "locked: its token is wrong" : "offline";
  if (m.running) return `${m.running.label}${m.running.steps ? ` · ${m.running.step}/${m.running.steps}` : ` · ${Math.round(m.running.progress * 100)} %`}${cost}`;
  const state = m.paused ? "paused" : "idle";
  return `${m.model ? `${state} · holds ${m.model}` : state}${cost}`;
}

/**
 * The status bar's machines, when there are several ComfyUIs: one pill in place of a chip each and the meters strip. A
 * dot per machine in its state, how many and the busiest thing they do, then the GPU and VRAM of one machine: the one
 * picked (a row of the popover, a chip's menu), else the one of the render shown, else the first. A click opens every
 * machine with all its figures, its pause and its menu; a right-click on a dot, that machine's menu. With one ComfyUI,
 * nothing: the strip stays as it was.
 */
export function MachinesPill() {
  const queue = useQueue();
  const q = queue.data;
  const machines = severalMachines(q);
  const picked = useMeteredMachine((s) => s.id);
  const pick = useMeteredMachine((s) => s.set);
  const loads = useSystem((s) => s.loads);
  const ops = useQueueOps();
  // with a RunPod key: one more GPU, from what is free now, or the last one again
  const canDeploy = Boolean(useSettings().data?.hasRunpodKey);
  const again = useDeployAgain();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const menu = useMenu<string | null>();
  const client = useQueryClient();
  // a rented pod that runs (or starts) costs by the second: its row counts while the popover is open, and the queue is read
  // again every so often beside the live events, so that a stop by idle or by a cap is never missed
  const rentedOn = machines.some((m) => m.rented && m.rented.status !== "EXITED" && m.rented.status !== "GONE" && m.rented.status !== "TERMINATED");
  const now = useNow(1000, open && rentedOn);
  useEffect(() => {
    if (!rentedOn) return;
    const t = setInterval(() => void client.invalidateQueries({ queryKey: queryKeys.queue(), exact: true }), 15_000);
    return () => clearInterval(t);
  }, [rentedOn, client]);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(OPEN_MACHINES, show);
    return () => window.removeEventListener(OPEN_MACHINES, show);
  }, []);
  if (!machines.length) return null;
  const metered = machines.find((m) => m.id === picked) ?? machines.find((m) => m.id === q?.running?.machine) ?? machines[0]!;
  const gpu = loads[metered.id]?.gpus[0];
  const allPaused = machines.every((m) => m.paused);

  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onContextMenu={(e) => { setOpen(false); menu.open(e, null); }}
        data-tip={`${machines.map((m) => `${machineLabel(m)}: ${doing(m, Date.now())}`).join("\n")}\nClick for each machine's figures and actions.`}
        className={cx("inline-flex h-7 min-w-0 shrink-0 items-center gap-2 rounded-full border border-line px-2.5 text-xs whitespace-nowrap hover:bg-hover", open && "ring-1 ring-accent")}
      >
        <span className="inline-flex shrink-0 items-center gap-1">
          {machines.map((m) => (
            <span key={m.id} className="inline-flex p-px" onContextMenu={(e) => { e.stopPropagation(); setOpen(false); menu.open(e, m.id); }}>
              <Dot m={m} />
            </span>
          ))}
        </span>
        <span className="shrink-0 font-semibold text-ink">{machines.length}<span className="max-[1280px]:hidden"> {machines.length === 1 ? "ComfyUI" : "ComfyUIs"}</span></span>
        <span className="shrink-0 text-ink-2 max-[1440px]:hidden">{busiest(machines)}</span>
        {gpu && (
          <>
            <span className="h-3.5 w-px shrink-0 bg-line" />
            <span className="max-w-28 shrink-0 truncate text-ink-2 max-[1600px]:hidden">{machineLabel(metered)}</span>
            {gpu.load !== undefined && <Bar label="GPU" value={gpu.load} hot={Boolean(metered.running)} tip={`${machineLabel(metered)}: GPU ${Math.round(gpu.load)} %`} />}
            <span className="max-[1280px]:hidden"><Bar label="VRAM" value={gpu.vramPercent} warn={gpu.vramPercent >= 90} tip={`${machineLabel(metered)}: VRAM ${gb(gpu.vramUsed)} of ${gb(gpu.vramTotal)}`} /></span>
          </>
        )}
        <ChevronDown size={12} className={cx("shrink-0 text-ink-3 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <Popover anchor={anchor} onClose={() => setOpen(false)} label="ComfyUIs" width={520} height={120 + machines.length * 64 + (canDeploy ? 44 : 0)}>
          <div className="flex flex-col text-[12.5px]">
            <div className="flex items-center gap-2.5 px-3.5 py-3">
              <span className="font-bold">{plural(machines.length, "ComfyUI")}</span>
              <span className="text-ink-2">{busiest(machines)}</span>
              <span className="grow" />
              <button type="button" className="rounded-md border border-line px-2.5 py-1 text-xs font-semibold hover:bg-hover" onClick={() => (allPaused ? ops.resume : ops.pause).mutate(undefined)}>
                {allPaused ? "Resume all" : "Pause all"}
              </button>
            </div>
            {machines.map((m) => {
              const load = loads[m.id];
              const g = load?.gpus[0];
              return (
                <div
                  key={m.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => pick(m.id)}
                  onKeyDown={(e) => e.key === "Enter" && pick(m.id)}
                  onContextMenu={(e) => menu.open(e, m.id)}
                  data-tip="Its GPU and VRAM go in the pill"
                  className={cx("grid cursor-pointer grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-2.5 border-t border-line px-3.5 py-2.5 hover:bg-hover", m.id === metered.id && "bg-raised")}
                >
                  <Dot m={m} />
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="truncate"><span className="font-semibold">{machineLabel(m)}</span> <span className="text-ink-2">· {doing(m, now)}</span></span>
                    {g ? (
                      <span className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11.5px] text-ink-2">
                        {g.load !== undefined && <span className="inline-flex items-center gap-1.5"><Bar label="GPU" value={g.load} hot={Boolean(m.running)} />{Math.round(g.load)} %</span>}
                        <span className={cx(g.vramPercent >= 90 && "text-warn-ink")}>VRAM {gb(g.vramUsed)}/{gb(g.vramTotal)}</span>
                        {load?.ram && <span className={cx(load.ram.percent >= 90 && "text-warn-ink")}>RAM {Math.round(load.ram.percent)} %</span>}
                        {g.temperature !== undefined && <span className={cx(g.temperature >= 80 && "text-warn-ink")}>{Math.round(g.temperature)}°</span>}
                      </span>
                    ) : (
                      <span className="text-[11.5px] text-ink-3">{m.online === false ? (m.locked ? "locked against Afflatus's token" : "not answering") : "no figures yet"}</span>
                    )}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <button
                      type="button"
                      aria-label={m.paused ? `Resume ${machineLabel(m)}` : `Pause ${machineLabel(m)}`}
                      data-tip={m.paused ? "Resume it" : "Pause it: it finishes what it runs"}
                      onClick={(e) => { e.stopPropagation(); (m.paused ? ops.resume : ops.pause).mutate(m.id); }}
                      className={cx("flex size-7 items-center justify-center rounded-md border border-line hover:bg-hover", m.paused && "bg-accent-wash text-accent")}
                    >
                      {m.paused ? <Play size={13} /> : <Pause size={13} />}
                    </button>
                    <button
                      type="button"
                      aria-label={`${machineLabel(m)}: menu`}
                      onClick={(e) => { e.stopPropagation(); menu.open(e, m.id); }}
                      className="flex size-7 items-center justify-center rounded-md border border-line hover:bg-hover"
                    >
                      <MoreHorizontal size={14} />
                    </button>
                  </span>
                </div>
              );
            })}
            {canDeploy && (
              <div className="flex items-center gap-2 border-t border-line px-3.5 py-2">
                <button type="button" className="rounded-md border border-line px-2.5 py-1 text-xs font-semibold hover:bg-hover" onClick={() => { setOpen(false); openDeploy(); }}>Deploy a GPU…</button>
                {again.last && (
                  <button type="button" disabled={again.run.isPending} data-tip="Its rate is asked first" className="min-w-0 truncate rounded-md px-2 py-1 text-left text-xs text-ink-2 hover:bg-hover hover:text-ink" onClick={() => { setOpen(false); again.run.mutate(); }}>
                    Deploy again: {lastSaid(again.last)}
                  </button>
                )}
              </div>
            )}
            <div className="flex items-center gap-3 border-t border-line px-3.5 py-2.5 text-xs text-ink-2">
              <span>Click a row: its GPU and VRAM go in the pill</span>
              <span className="grow" />
              <Link href="/queue" onClick={() => setOpen(false)} className="font-semibold text-accent hover:underline">Open the Queue</Link>
            </div>
          </div>
        </Popover>
      )}
      {menu.menu && (
        <Suspense fallback={null}>
          <MachineMenuBody at={menu.menu.at} machine={menu.menu.subject ?? undefined} onClose={menu.close} />
        </Suspense>
      )}
    </>
  );
}
