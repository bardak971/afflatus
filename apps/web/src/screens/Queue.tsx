import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type Job, type QueueStatus } from "../api";
import { useQueue } from "../data";
import { NotifyToggle, notifyNote } from "../NotifyToggle";
import { aboutMs } from "../format";
import { Button, cx, ErrorNote, SectionTitle, Segmented } from "../ui";
import { History } from "./queue/History";
import { RenderTimes } from "./queue/Times";
import { ComfyLog } from "./queue/Log";
import { MachineMeters } from "./queue/MachineMeters";
import { modelSwitches } from "./queue/order";
import { RunningCard } from "./queue/RunningCard";
import { WaitingList } from "./queue/WaitingList";

/** The header's buttons: unload the models, pause or resume. */
function QueueControls({ q, free, pause }: { q: QueueStatus | undefined; free: { mutate(): void; isPending: boolean; isSuccess: boolean }; pause: { mutate(paused: boolean): void } }) {
  return (
    <>
      {q?.online && (
        <Button
          className="h-10 px-4"
          disabled={free.isPending || Boolean(q.running && q.running.kind === "render")}
          data-tip="Unloads ComfyUI's models from VRAM and RAM, for a game or another program. The next render loads what it needs again. Not while a render is running."
          onClick={() => free.mutate()}
        >
          {free.isPending ? "Unloading…" : free.isSuccess ? "Models unloaded" : "Unload models (free VRAM)"}
        </Button>
      )}
      {q && (
        <Button tone={q.paused ? "primary" : "plain"} className="h-10 px-4" data-tip={q.paused ? "Send what waits to ComfyUI again" : "Finish the running render, then send nothing new: the GPU is yours"} onClick={() => pause.mutate(!q.paused)}>
          {q.paused ? "Resume queue" : "Pause queue"}
        </Button>
      )}
    </>
  );
}

/** What the waiting jobs come to: about how long in all, and how many times the model changes on the way. */
function waitingSaid(waiting: Job[]): string {
  const ms = waiting.reduce((sum, w) => sum + (w.estimateMs ?? 0), 0);
  const switches = modelSwitches(waiting);
  return [ms ? `${aboutMs(ms)} in all` : "", switches ? `${switches} model switch${switches > 1 ? "es" : ""}` : ""].filter(Boolean).join(" · ");
}

/**
 * The queue: what runs now and the next few, in one block at the top; under it what was done and what
 * failed, as a list (History). The notify switch and the machine's meters sit in a side column, small:
 * the footer has the meters that matter at every moment.
 */
export function Queue() {
  const queue = useQueue();
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: ["queue"] });
  const pause = useMutation({ mutationFn: (paused: boolean) => (paused ? api.pause() : api.resume()), onSuccess: refresh });
  const free = useMutation({ mutationFn: api.freeMemory });
  const cancel = useMutation({ mutationFn: api.cancel, onSuccess: refresh });
  const order = useMutation({ mutationFn: api.queueOrder, onSuccess: (q) => client.setQueryData(["queue"], q) });
  const [refused, setRefused] = useState(false);
  const [tab, setTab] = useState<"queue" | "times" | "log">("queue");
  const q = queue.data;
  const error = queue.error ?? free.error ?? pause.error ?? cancel.error ?? order.error;

  return (
    <div className="flex min-h-0 grow flex-col overflow-hidden px-8 pb-6">
      <header className="flex h-20 shrink-0 items-center gap-5">
        <h1 className="text-xl font-semibold">Queue</h1>
        <div className="w-[380px]">
          <Segmented<"queue" | "times" | "log"> label="View" value={tab} options={[{ value: "queue", label: "Queue" }, { value: "times", label: "Render times" }, { value: "log", label: "ComfyUI log" }]} onChange={setTab} />
        </div>
        <div className="flex min-w-0 grow items-center gap-3 text-xs text-ink-2">
          <span className="flex shrink-0 items-center gap-1.5">
            <span className={cx("h-2 w-2 rounded-full", q?.online ? "bg-good" : "bg-warn")} />
            {q?.online ? "ComfyUI online" : "ComfyUI offline · queued jobs wait"}
          </span>
          {q?.model && <span className="truncate font-mono">{q.model} loaded</span>}
        </div>
        <QueueControls q={q} free={free} pause={pause} />
      </header>

      {error && <ErrorNote>{error.message}</ErrorNote>}

      {tab === "times" && <div className="min-h-0 grow overflow-y-auto"><RenderTimes /></div>}
      {tab === "log" && <ComfyLog online={Boolean(q?.online)} />}

      {tab === "queue" && q && (
        <div className="grid min-h-0 grow grid-cols-[minmax(0,1fr)_280px] gap-8">
          <div className="flex min-h-0 flex-col gap-5">
            {q.paused && (
              <div className="shrink-0 rounded-[10px] bg-accent-wash px-3.5 py-2.5 text-sm font-semibold text-accent">
                Paused. The running render finishes, then nothing new goes to ComfyUI until you resume. Exports go on: no GPU.
              </div>
            )}
            <section aria-label="Now" className="flex max-h-[55%] shrink-0 flex-col gap-1.5 overflow-y-auto">
              <div className="flex items-baseline justify-between gap-2">
                <SectionTitle>{[q.running?.kind === "export" ? "Exporting" : q.running?.kind === "load" ? "Loading model" : "Running", q.waiting.length ? `next ${q.waiting.length}` : ""].filter(Boolean).join(" · ")}</SectionTitle>
                {q.waiting.length > 0 && <span className="truncate text-xs text-ink-2">{waitingSaid(q.waiting)}</span>}
              </div>
              <RunningCard running={q.running} onStop={(id) => cancel.mutate(id)} />
              <WaitingList waiting={q.waiting} onOrder={(ids) => order.mutate(ids)} onRemove={(id) => cancel.mutate(id)} />
            </section>
            <History />
          </div>

          <div className="flex min-h-0 flex-col gap-5 overflow-y-auto pb-4">
            <div className="flex flex-col gap-1 rounded-[10px] border border-line px-3 py-2">
              <NotifyToggle what="whenEmpty" onRefused={setRefused} />
              <span className="text-xs text-ink-2">{notifyNote(refused)}</span>
            </div>
            <MachineMeters />
          </div>
        </div>
      )}
    </div>
  );
}
