import { useEffect, useState } from "react";
import { useSearch } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type MachineState, type QueueStatus } from "../api";
import { useQueue, useSettings } from "../data";
import { NOTIFY_HELP, NOTIFY_REFUSED, NotifyToggle } from "../NotifyToggle";
import { useQueueOps } from "../queueOps";
import { unloadBlock } from "../queueRules";
import { useSayFailed } from "../sayFailed";
import { Button, cx, ErrorNote, Help, LiveDot, PageHeader, SectionTitle, SegmentCount, Segmented } from "../ui";
import { History } from "./queue/History";
import { RenderTimes } from "./queue/Times";
import { Costs } from "./queue/Costs";
import { ComfyLog } from "./queue/Log";
import { MachineLanes } from "./queue/MachineLanes";
import { machineLabel, machineUnloadBlock, noGpuYet, onlineSaid, severalMachines } from "../machines";
import { NoMachine } from "./queue/NoMachine";
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
      {/* no machine at all (rented only, none up): nothing to unload */}
      {q?.online && (q.machines?.length ?? 0) > 0 && (
        <Button
          size="sm"
          disabled={free.isPending || Boolean(why)}
          data-tip={several.length ? `Unloads the models of every machine that is not rendering nor busy outside Afflatus (${idle.map(machineLabel).join(", ") || "none now"}). Each lane's menu unloads one.` : "Unloads ComfyUI's models from VRAM and RAM, for a game or another program. The next render loads what it needs again. Not while a job is running."}
          onClick={() => free.mutate(undefined)}
        >
          {free.isPending ? "Unloading…" : free.isSuccess ? "Models unloaded" : several.length ? "Unload idle" : "Unload models"}
        </Button>
      )}
      {q && (
        <Button size="sm" tone={q.paused ? "primary" : "plain"} data-tip={q.paused ? "Send what waits to ComfyUI again" : "Finish the running render, then send nothing new: the GPU is yours"} onClick={() => (q.paused ? resume : pause).mutate(undefined)}>
          {several.length ? (q.paused ? "Resume all" : "Pause all") : q.paused ? "Resume queue" : "Pause queue"}
        </Button>
      )}
    </>
  );
}

/**
 * The queue: the machines, a row each, and the next few at the top; under them what was done and what failed, as a list
 * (History). The notify switch sits in the header; a machine's meters are in the machines pill's popover and the footer.
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
  const packs = useMutation({ mutationFn: ({ job, what, names }: { job: string; what: "install" | "without"; names: string[] }) => api.jobPacks(job, what, names), onSuccess: (q) => client.setQueryData(queryKeys.queue(), q), onError: failed("Could not change it") });
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
  // no ComfyUI of the user's own and no pod up: nothing is offline, the jobs wait for a GPU (NoMachine)
  const noGpu = noGpuYet(useSettings().data?.machines, q);
  // "Models unloaded" holds until a model is loaded again
  const loaded = q?.model;
  const resetFree = free.reset;
  useEffect(() => {
    if (loaded) resetFree();
  }, [loaded, resetFree]);

  // what the Queue's own segment says: how many jobs it holds (at work and waiting), and a live dot while one is at work
  const atWork = q ? (several.length ? several.filter((m) => m.running).length : q.running ? 1 : 0) + (q.tool ? 1 : 0) : 0;
  const holds = q ? atWork + q.waiting.length : undefined;

  return (
    <div className="flex min-h-0 grow flex-col">
      <PageHeader
        title="Queue"
        after={
          // in a narrow window the views scroll sideways rather than push the buttons out of the header
          <div className="min-w-0 shrink overflow-x-auto [scrollbar-width:none]">
            <Segmented<Tab>
              oneLine
              className="w-max"
              label="View"
              value={tab}
              options={[
                { value: "queue", label: <span className="inline-flex items-center gap-1.5">{atWork > 0 && <LiveDot label="a job at work" />}Queue{holds ? <SegmentCount>{holds}</SegmentCount> : null}</span> },
                { value: "times", label: "Render times" },
                { value: "costs", label: "Costs" },
                { value: "log", label: "ComfyUI log" },
              ]}
              onChange={setTab}
            />
          </div>
        }
        actions={
          <>
            {/* by the actions, as the mock has it; in a narrow window the views scroll before any of this goes */}
            <div className="flex items-center gap-3 text-meta text-ink-2">
              <span className="flex shrink-0 items-center gap-1.5">
                {/* not read yet, or could not be: nothing is said about ComfyUI */}
                <span className={cx("h-2 w-2 rounded-full", !q || noGpu ? "bg-ink-3" : q.online ? "bg-good" : "bg-warn")} />
                {!q ? "…" : noGpu ? "No machine yet" : several.length ? onlineSaid(several) : q.online ? "ComfyUI online" : "ComfyUI offline · queued jobs wait"}
              </span>
              {q?.model && !several.length && !noGpu && <span className="max-w-48 truncate font-mono" data-tip={`${q.model} loaded`}>{q.model} loaded</span>}
            </div>
            {/* the notify switch is the queue view's: the other views have nothing that empties */}
            {tab === "queue" && (
              <span className="flex shrink-0 items-center gap-2 text-body">
                <NotifyToggle kind="queueEmpty" onRefused={setRefused} />
                <Help text={NOTIFY_HELP} />
                {refused && <span className="flex items-center gap-1.5 text-meta text-warn-ink">{NOTIFY_REFUSED.said} <Help text={NOTIFY_REFUSED.help} /></span>}
              </span>
            )}
            <QueueControls q={q} free={free} pause={pause} resume={resume} />
          </>
        }
      />
      {/* the queue scrolls as one page under its header, each part at its own height: wide, its parts once scrolled each in a
          box of a fixed share, and the waiting list was drawn over the history, a rendering machine's card cut off, a gap
          left under one waiting job (2026-10-17). The other views keep a box of their own. */}
      <div className={cx("flex min-h-0 grow flex-col overflow-y-auto px-4 pt-4 pb-6 sm:px-8", tab !== "queue" && "lg:overflow-hidden")}>
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
          <div className="flex shrink-0 flex-col gap-5">
            {q.paused && (
              <div className="flex items-center gap-2 rounded-[10px] bg-accent-wash px-3.5 py-2.5 text-sm font-semibold text-accent">
                Paused · nothing new goes to ComfyUI
                <Help text="The running render finishes, then nothing new goes to ComfyUI until you resume. Exports go on: they need no GPU." />
              </div>
            )}
            <section aria-label="Machines" className="flex flex-col gap-1.5">
              <SectionTitle>{(q.machines?.length ?? 0) > 1 ? `Machines · ${q.machines!.length}` : "Machine"}</SectionTitle>
              {noGpu && <NoMachine waiting={q.waiting.length} />}
              {q.machines?.length
                ? <MachineLanes q={q} onStop={(id) => cancel.mutate(id)} onPin={(job, machine) => pin.mutate({ job, machine })} />
                : !noGpu && <RunningCard running={q.running} onStop={(id) => cancel.mutate(id)} />}
            </section>
            {/* its head says what they come to: how many, how long, the model switches, and the bulk actions */}
            {q.waiting.length > 0 && <WaitingList waiting={q.waiting} whole={q.whole} endsInMs={q.waitingEndsInMs} running={q.running} machines={several} onOrder={(ids) => order.mutate(ids)} onRemove={(id) => cancel.mutate(id)} onPin={(job, machine) => pin.mutate({ job, machine })} onPacks={(job, what, names) => packs.mutate({ job, what, names })} />}
            <History />
          </div>
        )}
      </div>
    </div>
  );
}
