import { useEffect, useState } from "react";
import { useSearch } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type MachineState, type QueueStatus } from "../api";
import { useQueue } from "../data";
import { NOTIFY_HELP, NOTIFY_REFUSED, NotifyToggle } from "../NotifyToggle";
import { useQueueOps } from "../queueOps";
import { unloadBlock } from "../queueRules";
import { useSayFailed } from "../sayFailed";
import { Button, cx, ErrorNote, Help, SectionTitle, Segmented } from "../ui";
import { History } from "./queue/History";
import { RenderTimes } from "./queue/Times";
import { Costs } from "./queue/Costs";
import { ComfyLog } from "./queue/Log";
import { MachineMeters } from "./queue/MachineMeters";
import { MachineLanes } from "./queue/MachineLanes";
import { machineLabel, machineUnloadBlock, onlineSaid, outsideSaid, severalMachines } from "../machines";
import { RunningCard } from "./queue/RunningCard";
import { WaitingList } from "./queue/WaitingList";
import { queryKeys } from "../queryKeys";

/** The views of the Queue screen, as the address asks for one (the command bar's "Queue › Costs"). */
type Tab = "queue" | "times" | "costs" | "log";
const isTab = (v: string | null): v is Tab => v === "queue" || v === "times" || v === "costs" || v === "log";

/** The header's buttons: unload the models, pause or resume. With several ComfyUIs: unload every idle one, pause or resume all of them. */
function QueueControls({ q, free, pause, resume }: { q: QueueStatus | undefined; free: { mutate(machine?: undefined): void; isPending: boolean; isSuccess: boolean }; pause: { mutate(machine?: undefined): void }; resume: { mutate(machine?: undefined): void } }) {
  const several = severalMachines(q);
  // a machine busy outside Afflatus is skipped too: its models are in use by someone else's work (the server skips it)
  const idle = several.filter((m) => !machineUnloadBlock(m));
  const why = several.length ? (idle.length ? null : "every machine is at work or away") : unloadBlock(q);
  return (
    <>
      {q?.online && (
        <Button
          className="h-10 px-4"
          disabled={free.isPending || Boolean(why)}
          data-tip={several.length ? `Unloads the models of every machine that is not rendering nor busy outside Afflatus (${idle.map(machineLabel).join(", ") || "none now"}). Each lane's menu unloads one.` : "Unloads ComfyUI's models from VRAM and RAM, for a game or another program. The next render loads what it needs again. Not while a job is running."}
          onClick={() => free.mutate(undefined)}
        >
          {free.isPending ? "Unloading…" : free.isSuccess ? "Models unloaded" : several.length ? "Unload idle" : "Unload models"}
        </Button>
      )}
      {q && (
        <Button tone={q.paused ? "primary" : "plain"} className="h-10 px-4" data-tip={q.paused ? "Send what waits to ComfyUI again" : "Finish the running render, then send nothing new: the GPU is yours"} onClick={() => (q.paused ? resume : pause).mutate(undefined)}>
          {several.length ? (q.paused ? "Resume all" : "Pause all") : q.paused ? "Resume queue" : "Pause queue"}
        </Button>
      )}
    </>
  );
}

/**
 * The queue: what runs now and the next few, in one block at the top; under it what was done and what
 * failed, as a list (History). The notify switch and the machine's meters sit in a side column, small:
 * the footer has the meters that matter at every moment.
 */
/** A rented pod running or on its way up: its log tab reads its boot log while its ComfyUI does not answer. */
const podUp = (m: MachineState | undefined) => Boolean(m?.rented && (m.rented.status === "RUNNING" || m.rented.status === "STARTING" || m.rented.status === "PROVISIONING"));

export function Queue() {
  const queue = useQueue();
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: queryKeys.queue() });
  // what fails is said in a banner, as the history's actions do: it goes away, and does not stay on the screen
  const failed = useSayFailed({ id: "queue", href: "/queue", go: "Open queue" });
  const { pause, resume, unload: free } = useQueueOps();
  const cancel = useMutation({ mutationFn: api.cancel, onSuccess: refresh, onError: failed("Could not cancel it") });
  const order = useMutation({ mutationFn: api.queueOrder, onSuccess: (q) => client.setQueryData(queryKeys.queue(), q), onError: failed("Could not reorder the queue") });
  // a waiting job dropped on a machine's lane, or "Run on" in its menu: pinned there (null: back to whichever the queue picks)
  const pin = useMutation({ mutationFn: ({ job, machine }: { job: string; machine: string | null }) => api.pinJob(job, machine), onSuccess: (q) => client.setQueryData(queryKeys.queue(), q), onError: failed("Could not move it to that machine") });
  const [logOf, setLogOf] = useState<string>("");
  const [refused, setRefused] = useState(false);
  // a view asked for in the address (the command bar's "Queue › Render times"): opened on it, and again when it changes
  const params = new URLSearchParams(useSearch());
  const asked = params.get("view");
  // a machine asked for too (the command bar's "log second gpu"): its log shown
  const askedMachine = params.get("machine");
  useEffect(() => {
    if (askedMachine) setLogOf(askedMachine);
  }, [askedMachine]);
  const [tab, setTab] = useState<Tab>(isTab(asked) ? asked : "queue");
  useEffect(() => {
    if (isTab(asked)) setTab(asked);
  }, [asked]);
  const q = queue.data;
  const several = severalMachines(q);
  // "Models unloaded" holds until a model is loaded again
  const loaded = q?.model;
  const resetFree = free.reset;
  useEffect(() => {
    if (loaded) resetFree();
  }, [loaded, resetFree]);

  return (
    // on a narrow window (a phone) the page scrolls as one, its parts at their own height; wide, each part scrolls in its place
    <div className="flex min-h-0 grow flex-col overflow-y-auto px-4 pb-6 sm:px-8 lg:overflow-hidden">
      <header className="flex min-h-20 shrink-0 flex-wrap items-center gap-x-5 gap-y-2 py-3 lg:h-20 lg:py-0">
        <h1 className="text-xl font-semibold">Queue</h1>
        <div className="w-[460px] max-w-full">
          <Segmented<Tab> label="View" value={tab} options={[{ value: "queue", label: "Queue" }, { value: "times", label: "Render times" }, { value: "costs", label: "Costs" }, { value: "log", label: "ComfyUI log" }]} onChange={setTab} />
        </div>
        <div className="flex min-w-0 grow items-center gap-3 text-xs text-ink-2">
          <span className="flex shrink-0 items-center gap-1.5">
            {/* not read yet, or could not be: nothing is said about ComfyUI */}
            <span className={cx("h-2 w-2 rounded-full", !q ? "bg-ink-3" : q.online ? "bg-good" : "bg-warn")} />
            {!q ? "…" : several.length ? onlineSaid(several) : q.online ? "ComfyUI online" : "ComfyUI offline · queued jobs wait"}
          </span>
          {q?.model && !several.length && <span className="truncate font-mono">{q.model} loaded</span>}
        </div>
        <QueueControls q={q} free={free} pause={pause} resume={resume} />
      </header>

      {queue.error && <ErrorNote>Could not read the queue: {queue.error.message}</ErrorNote>}

      {tab === "times" && <div className="min-h-0 grow overflow-y-auto"><RenderTimes /></div>}
      {tab === "costs" && <div className="min-h-0 grow overflow-y-auto"><Costs /></div>}
      {tab === "log" && several.length > 0 && (
        <div className="mb-2 shrink-0">
          <Segmented oneLine size="sm" label="Whose log" value={logOf || several[0]!.id} options={several.map((m) => ({ value: m.id, label: machineLabel(m) }))} onChange={setLogOf} />
        </div>
      )}
      {tab === "log" && <ComfyLog key={logOf || "first"} online={several.length ? several.find((m) => m.id === (logOf || several[0]!.id))?.online !== false : Boolean(q?.online)} pod={podUp(several.find((m) => m.id === (logOf || several[0]?.id)))} machine={several.length ? logOf || several[0]!.id : undefined} />}

      {tab === "queue" && !q && !queue.error && <p className="text-sm text-ink-3">…</p>}
      {tab === "queue" && q && (
        // below 1024 px the Notify column goes over the queue, which then has the whole width (at 960 px its 280 px left
        // the history no room for the jobs' names)
        <div className="grid grow grid-cols-1 gap-5 lg:min-h-0 lg:grid-cols-[minmax(0,1fr)_280px] lg:gap-8">
          <div className="flex flex-col gap-5 lg:min-h-0">
            {q.paused && (
              <div className="flex shrink-0 items-center gap-2 rounded-[10px] bg-accent-wash px-3.5 py-2.5 text-sm font-semibold text-accent">
                Paused · nothing new goes to ComfyUI
                <Help text="The running render finishes, then nothing new goes to ComfyUI until you resume. Exports go on: they need no GPU." />
              </div>
            )}
            {/* the machines and the waiting list each scroll in their own part, each kept at least a few rows high: four
                machine cards left the waiting list a row and a half at 1440 × 900 */}
            <section aria-label="Now" className="flex shrink-0 flex-col gap-1.5 lg:max-h-[60%]">
              <SectionTitle>{several.length ? "Machines" : q.running?.kind === "export" ? "Exporting" : q.running?.kind === "load" ? "Loading model" : "Running"}</SectionTitle>
              <div className="shrink lg:min-h-[5.5rem] lg:overflow-y-auto">
                {several.length
                  ? <MachineLanes q={q} onStop={(id) => cancel.mutate(id)} onPin={(job, machine) => pin.mutate({ job, machine })} />
                  : <RunningCard running={q.running} onStop={(id) => cancel.mutate(id)} outside={q.machines?.[0] ? outsideSaid(q.machines[0]) : null} />}
              </div>
              {/* its head says what they come to: how many, how long, the model switches, and the bulk actions */}
              {q.waiting.length > 0 && (
                <div className="shrink-[0.25] lg:min-h-[9.5rem] lg:overflow-y-auto">
                  <WaitingList waiting={q.waiting} whole={q.whole} endsInMs={q.waitingEndsInMs} running={q.running} machines={several} onOrder={(ids) => order.mutate(ids)} onRemove={(id) => cancel.mutate(id)} onPin={(job, machine) => pin.mutate({ job, machine })} />
                </div>
              )}
            </section>
            <History />
          </div>

          <div className="-order-1 flex flex-col gap-1.5 lg:order-none lg:min-h-0 lg:overflow-y-auto lg:pb-4">
            {/* a title as the left column has, so that the two start level */}
            <SectionTitle>Notify</SectionTitle>
            <div className="mb-3.5 flex flex-col gap-1 rounded-[10px] border border-line px-3 py-2">
              <div className="flex items-center gap-2">
                <NotifyToggle kind="queueEmpty" onRefused={setRefused} />
                <Help text={NOTIFY_HELP} />
              </div>
              {refused && (
                <span className="flex items-center gap-1.5 text-xs text-warn-ink">
                  {NOTIFY_REFUSED.said} <Help text={NOTIFY_REFUSED.help} />
                </span>
              )}
            </div>
            {/* with several, each lane has its machine's figures */}
            {!several.length && <MachineMeters />}
          </div>
        </div>
      )}
    </div>
  );
}
