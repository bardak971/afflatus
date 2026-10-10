import { useMutation } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { dayMonth, long, plural } from "../../format";
import { useQueueOf } from "../studio/queueOf";
import { useQueueBulk } from "./bulk";
import type { Flag } from "./flagRules";
import { groupingSaves, modelSwitches } from "./order";
import { pct } from "./SummaryTiles";

const head = "text-[11px] font-bold tracking-[0.08em] text-ink-3 uppercase";

function Line({ warn, lead, rest, sub, action }: { warn: boolean; lead: string; rest?: string; sub: string; action?: ReactNode }) {
  return (
    <div className="grid grid-cols-[8px_minmax(0,1fr)_auto] items-start gap-2.5 border-line py-2 [&:not(:last-child)]:border-b">
      <span className={warn ? "mt-1.5 size-2 rounded-[2px] bg-warn" : "mt-1.5 size-2 rounded-[2px] bg-ink-3"} />
      <span className="min-w-0 text-[13px]">
        <b className="font-semibold">{lead}</b>{rest && <span className="text-ink-2"> {rest}</span>}
        <span className="block truncate text-xs text-ink-3">{sub}</span>
      </span>
      {action ?? <span />}
    </div>
  );
}

const actionClass = "text-xs font-bold text-accent hover:underline disabled:text-ink-3 disabled:no-underline";

/**
 * What to act on, worked out from the period's figures (flagRules.ts): each line says what it is, and its action
 * opens the renders it is about, or sorts the queue.
 */
export function Flags({ flags, onJobs }: { flags: Flag[]; onJobs(model: string, only: "all" | "trouble"): void }) {
  // counted from the running job's model, as the queue's header, its "loads" chips and Group by model count: read only these, not at each progress event
  const now = useQueueOf((q) => ({ waiting: q.waiting.length, switches: modelSwitches(q.waiting, q.running), saves: groupingSaves(q.waiting, q.running) }));
  const bulk = useQueueBulk();
  const sort = useMutation({ mutationFn: () => bulk.groupQueueByModel() });
  const switches = now?.switches ?? 0;
  const saves = now?.saves ?? 0;
  return (
    <section className="flex min-w-0 flex-col rounded-2xl border border-line bg-panel px-4.5 pt-3.5 pb-1.5">
      <span className={head}>Flags · {flags.length}</span>
      {!flags.length && <span className="py-2 text-xs text-ink-3">None</span>}
      <div className="mt-1 flex flex-col">
        {flags.map((f) => {
          if (f.kind === "slow") {
            return (
              <Line
                key={`slow-${f.model}`} warn lead={`${f.name} · s/it +${f.pct} %`} rest={`vs its p50 since ${dayMonth(f.since)}`}
                sub="s/it is per step · resolution, LoRA stack or VRAM spill"
                action={<button type="button" className={actionClass} data-tip="Its jobs in the list below" onClick={() => onJobs(f.model, "all")}>jobs</button>}
              />
            );
          }
          if (f.kind === "swaps") {
            return (
              <Line
                key="swaps" warn lead={`Model swaps · ${f.loads} loads · ${long(f.loadMs)}`}
                sub={`${pct(f.share)} of the GPU time · queue alternates checkpoints`}
                action={
                  <button
                    type="button" className={actionClass} disabled={!saves || sort.isPending}
                    data-tip={saves ? `Group the ${plural(now?.waiting ?? 0, "waiting job")} by model, the loaded one first: saves ${plural(saves, "load")}` : switches ? "Grouping saves no load now" : "No model switch in the queue now"}
                    onClick={() => sort.mutate()}
                  >
                    {sort.isSuccess && !saves ? "sorted" : "sort queue by model"}
                  </button>
                }
              />
            );
          }
          if (f.kind === "failures") {
            return (
              <Line
                key={`fail-${f.model}`} warn lead={`${f.name} · ${f.failed} failed${f.oom ? ` · ${f.oom} OOM` : ""}`}
                sub={`${long(f.lostMs)} GPU lost`}
                action={<button type="button" className={actionClass} data-tip="Its failed and cancelled jobs in the list below" onClick={() => onJobs(f.model, "trouble")}>log</button>}
              />
            );
          }
          return (
            <Line
              key="vram" warn={f.spills > 0} lead={`VRAM peak ${f.peak} %`} rest={f.where ? `· ${f.where}` : undefined}
              sub={f.spills ? `${f.spills} spill${f.spills === 1 ? "" : "s"} · +${long(f.spillLostMs)}` : "no spill measured"}
            />
          );
        })}
      </div>
    </section>
  );
}
