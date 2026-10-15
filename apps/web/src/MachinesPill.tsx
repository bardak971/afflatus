import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { useMenu } from "./ContextMenu";
import { useQueue, useSettings } from "./data";
import { gb } from "./format";
import { useNow } from "./hooks";
import { machineLabel, severalMachines } from "./machines";
import { queryKeys } from "./queryKeys";
import { useMeteredMachine, useSystem } from "./store";
import { cx } from "./ui";
import { Bar, busiest, doing, Dot } from "./machineBits";

// the menu is opened now and then: fetched the first time, the strip itself is in the first load
const MachineMenuBody = lazy(() => import("./MachineMenu").then((m) => ({ default: m.MachineMenuBody })));
const MachinesPopover = lazy(() => import("./MachinesPopover").then((m) => ({ default: m.MachinesPopover })));

/** Asked by the strip's "+1" (other renders): the pill opens its popover. */
export const OPEN_MACHINES = "afflatus:machines";

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
  // with a RunPod key: one more GPU, from what is free now, or the last one again
  const canDeploy = Boolean(useSettings().data?.hasRunpodKey);
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const menu = useMenu<string | null>();
  const client = useQueryClient();
  // a rented pod that runs (or starts) costs by the second: its row counts while the popover is open. A stop, a cap or a
  // change of the pod comes as a "queue" event (rented.ts); the idle stop is counted down on the page from when it comes
  // (idleAt), and the queue read once then, to see it stopped. Every tab read it every 15 s before, which kept the server's
  // machine checks going on an idle server.
  const rentedOn = machines.some((m) => m.rented && m.rented.status !== "EXITED" && m.rented.status !== "GONE" && m.rented.status !== "TERMINATED");
  const now = useNow(1000, open && rentedOn);
  const idleAt = machines.reduce<number | null>((soonest, m) => (m.rented?.idleAt != null && (soonest === null || m.rented.idleAt < soonest) ? m.rented.idleAt : soonest), null);
  useEffect(() => {
    if (idleAt === null) return;
    const t = setTimeout(() => void client.invalidateQueries({ queryKey: queryKeys.queue(), exact: true }), Math.max(0, idleAt - Date.now()) + 3000);
    return () => clearTimeout(t);
  }, [idleAt, client]);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(OPEN_MACHINES, show);
    return () => window.removeEventListener(OPEN_MACHINES, show);
  }, []);
  if (!machines.length) return null;
  const metered = machines.find((m) => m.id === picked) ?? machines.find((m) => m.id === q?.running?.machine) ?? machines[0]!;
  const gpu = loads[metered.id]?.gpus[0];
  // the GPU a hunt looks for, before it is a machine: a dashed dot of its own (a real one once its pod is made)
  const hunted = q?.hunt && q.hunt.status !== "up" ? q.hunt : null;

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
          {hunted && <span aria-hidden className="m-px size-[7px] shrink-0 rounded-full border-[1.5px] border-dashed border-accent" />}
        </span>
        <span className="shrink-0 font-semibold text-ink">{machines.length}<span className="max-[1280px]:hidden"> {machines.length === 1 ? "ComfyUI" : "ComfyUIs"}</span></span>
        <span className="shrink-0 text-ink-2 max-[1440px]:hidden">{hunted ? "+ 1 hunted" : busiest(machines)}</span>
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
        // its own chunk: opened now and then, not on the first paint
        <Suspense fallback={null}>
          <MachinesPopover anchor={anchor} machines={machines} metered={metered.id} now={now} canDeploy={canDeploy} onPick={pick} onMenu={(e, id) => menu.open(e, id)} onClose={() => setOpen(false)} />
        </Suspense>
      )}
      {menu.menu && (
        <Suspense fallback={null}>
          <MachineMenuBody at={menu.menu.at} machine={menu.menu.subject ?? undefined} onClose={menu.close} />
        </Suspense>
      )}
    </>
  );
}
