import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { api } from "../../api";
import { useQueue } from "../../data";
import { long } from "../../format";
import type { Flag } from "./flagRules";
import { byModel, modelSwitches } from "./order";
import { pct } from "./SummaryTiles";

const head = "text-[11px] font-bold tracking-[0.08em] text-ink-3 uppercase";
const day = (ms: number) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

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
 * What to act on, worked out from the period's figures (flags.ts): each line says what it is, and its action
 * opens the renders it is about, or sorts the queue.
 */
export function Flags({ flags, onJobs }: { flags: Flag[]; onJobs(model: string, only: "all" | "trouble"): void }) {
  const queue = useQueue();
  const client = useQueryClient();
  const waiting = queue.data?.waiting ?? [];
  const switches = modelSwitches(waiting);
  const sort = useMutation({ mutationFn: () => api.queueOrder(byModel(waiting)), onSuccess: (q) => client.setQueryData(["queue"], q) });
  return (
    <section className="flex min-w-0 flex-col rounded-2xl border border-line bg-panel px-4.5 pt-3.5 pb-1.5">
      <span className={head}>Flags · {flags.length}</span>
      {!flags.length && <span className="py-2 text-xs text-ink-3">None</span>}
      <div className="mt-1 flex flex-col">
        {flags.map((f) => {
          if (f.kind === "slow") {
            return (
              <Line
                key={`slow-${f.model}`} warn lead={`${f.name} · s/it +${f.pct} %`} rest={`vs its p50 since ${day(f.since)}`}
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
                    type="button" className={actionClass} disabled={!switches || sort.isPending}
                    data-tip={switches ? `Group the ${waiting.length} waiting jobs by model: ${switches} switch${switches === 1 ? "" : "es"} → fewer` : "No model switch in the queue now"}
                    onClick={() => sort.mutate()}
                  >
                    {sort.isSuccess && !switches ? "sorted" : "sort queue by model"}
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
      {sort.isError && <span className="pb-2 text-xs text-warn-ink">{sort.error.message}</span>}
    </section>
  );
}
