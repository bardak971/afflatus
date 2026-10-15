import type { MouseEvent, RefObject } from "react";
import { Link } from "wouter";
import { MoreHorizontal, Pause, Play } from "lucide-react";
import type { MachineState } from "./api";
import { lastSaid, openDeploy, useDeployAgain } from "./deploy";
import { gb, plural } from "./format";
import { machineLabel } from "./machines";
import { Bar, busiest, doing, Dot } from "./machineBits";
import { Popover } from "./Popover";
import { useQueueOps } from "./queueOps";
import { useSystem } from "./store";
import { cx } from "./ui";

/**
 * The machines' pill opened (MachinesPill.tsx): every machine with all its figures, its pause and its menu, Deploy a GPU
 * with a RunPod key. A chunk of its own, fetched the first time it opens.
 */
export function MachinesPopover({ anchor, machines, metered, now, canDeploy, onPick, onMenu, onClose }: {
  anchor: RefObject<HTMLButtonElement | null>;
  machines: MachineState[];
  /** The machine whose GPU and VRAM the pill shows. */
  metered: string;
  now: number;
  canDeploy: boolean;
  onPick(id: string): void;
  onMenu(e: MouseEvent, id: string): void;
  onClose(): void;
}) {
  const loads = useSystem((s) => s.loads);
  const ops = useQueueOps();
  const again = useDeployAgain();
  const allPaused = machines.every((m) => m.paused);
  return (
    <Popover anchor={anchor} onClose={onClose} label="ComfyUIs" width={520} height={120 + machines.length * 64 + (canDeploy ? 44 : 0)}>
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
              onClick={() => onPick(m.id)}
              onKeyDown={(e) => e.key === "Enter" && onPick(m.id)}
              onContextMenu={(e) => onMenu(e, m.id)}
              data-tip="Its GPU and VRAM go in the pill"
              className={cx("grid cursor-pointer grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-2.5 border-t border-line px-3.5 py-2.5 hover:bg-hover", m.id === metered && "bg-raised")}
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
                  <span className="text-[11.5px] text-ink-3">
                    {/* a pod being deployed does not answer for minutes, as it should: said as what it is doing, not as a fault */}
                    {m.rented && (m.rented.booting || m.rented.status === "PROVISIONING" || m.rented.status === "STARTING")
                      ? "its image is pulled onto the host, then ComfyUI starts: a few minutes"
                      : m.online === false ? (m.locked ? "locked against Afflatus's token" : "not answering") : "no figures yet"}
                  </span>
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
                  onClick={(e) => { e.stopPropagation(); onMenu(e, m.id); }}
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
            <button type="button" className="rounded-md border border-line px-2.5 py-1 text-xs font-semibold hover:bg-hover" onClick={() => { onClose(); openDeploy(); }}>Deploy a GPU…</button>
            {again.last && (
              <button type="button" disabled={again.run.isPending} data-tip="Its rate is asked first" className="min-w-0 truncate rounded-md px-2 py-1 text-left text-xs text-ink-2 hover:bg-hover hover:text-ink" onClick={() => { onClose(); again.run.mutate(); }}>
                Deploy again: {lastSaid(again.last)}
              </button>
            )}
          </div>
        )}
        <div className="flex items-center gap-3 border-t border-line px-3.5 py-2.5 text-xs text-ink-2">
          <span>Click a row: its GPU and VRAM go in the pill</span>
          <span className="grow" />
          <Link href="/queue" onClick={() => onClose()} className="font-semibold text-accent hover:underline">Open the Queue</Link>
        </div>
      </div>
    </Popover>
  );
}
