import { Fragment, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ArrowDownToLine, ArrowUpToLine, Layers, Pin, Server, Trash2, X } from "lucide-react";
import { api, type Job, type MachineLack, type MachineState, type RunningJob } from "../../api";
import { GetFile } from "../../GetFile";
import { busyOutside, machineLabel, machineState, OUTSIDE_TIP, rentedUp } from "../../machines";
import { JOB_DRAG } from "./MachineLanes";
import { ContextMenu, useMenu, type MenuItem } from "../../ContextMenu";
import { aboutMs, est, plural, when } from "../../format";
import { Button, Chip, cx, SectionTitle } from "../../ui";
import { useQueueBulk } from "./bulk";
import { useModelName } from "./modelName";
import { betterPlace, dropped, groupingSaves, loadsAt, modelSwitches, moved, waitingEnds } from "./order";
import { settingHref } from "../settings/settingsIndex";
import { DownloadTo } from "../../useGetFile";

/** How many waiting jobs show before the rest fold into "and N more". */
const SHOWN = 3;

/**
 * What the waiting jobs come to, over them: how many, about how long until they are all done (the plan's last end, the
 * machines sharing them: waitingEnds), the model switches on the way with a "Group by model" when grouping saves loads,
 * and "Cancel all waiting…".
 */
function WaitingHead({ waiting, running, endsInMs, machines }: { waiting: Job[]; running: RunningJob | null; endsInMs?: number | null; machines: MachineState[] }) {
  const bulk = useQueueBulk();
  const [busy, setBusy] = useState(false);
  // with nothing planned (paused), shared between the machines up that can take them (with one of one's own, one after another)
  const ms = waitingEnds(waiting, running, endsInMs, machines.length ? machines.filter((m) => m.online !== false && rentedUp(m)).map((m) => m.id) : undefined);
  const switches = modelSwitches(waiting, running);
  const saves = groupingSaves(waiting, running);
  const run = (work: () => Promise<unknown>) => {
    setBusy(true);
    void work().finally(() => setBusy(false));
  };
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 pt-1.5 pb-1 pl-3">
      <SectionTitle>Next · {waiting.length}</SectionTitle>
      {ms > 0 && <span className="text-xs text-ink-2">{aboutMs(ms)} in all</span>}
      {switches > 0 && <Chip tone="warn" tip="Each switch loads another model first">{plural(switches, "model switch", "model switches")}</Chip>}
      {saves > 0 && (
        <Button size="sm" className="h-7" disabled={busy} data-tip={`Same model together, the loaded one first: saves ${plural(saves, "load")}`} onClick={() => run(bulk.groupQueueByModel)}>
          Group by model
        </Button>
      )}
      <span className="grow" />
      <Button size="sm" className="h-7" disabled={busy} onClick={() => run(() => bulk.cancelAllWaiting({ ids: waiting.map((w) => w.id) }))}>Cancel all waiting…</Button>
    </div>
  );
}

/**
 * What comes next, as compact numbered rows: dragged up and down, or moved and removed from its menu. The first few show;
 * the rest unfold. With several ComfyUIs (`machines`), each row says the machine it will probably run on and when, or the
 * one it is pinned to; a row dropped on a machine's lane (MachineLanes.tsx), or "Run on" in its menu, pins it there.
 */
export function WaitingList({ waiting: line, whole = line.length, endsInMs, running, machines = [], onOrder, onRemove, onPin }: {
  waiting: Job[];
  /** When the plan has the last of them end (QueueStatus.waitingEndsInMs). */
  endsInMs?: number | null;
  /** How many of `waiting` are whole rows (QueueStatus.whole): the others are asked for whole when the list shows them all. */
  whole?: number;
  running: RunningJob | null; machines?: MachineState[];
  onOrder(ids: string[]): void; onRemove(id: string): void; onPin?(job: string, machine: string | null): void;
}) {
  const [dragged, setDragged] = useState<string | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [all, setAll] = useState(false);
  // shown whole, the jobs past the queue answer's first ones are read whole too (what keeps one off a machine, the files
  // it waits for), a page of them, again when the line changes
  const later = line.slice(whole).map((w) => w.id);
  const rest = useQuery({
    queryKey: ["queue-waiting", whole, later.join()],
    queryFn: ({ signal }) => api.queueWaiting(whole, 500, { signal }),
    enabled: all && later.length > 0,
    staleTime: 5000,
  });
  const waiting = useMemo(() => {
    if (!rest.data) return line;
    const byId = new Map(rest.data.items.map((w) => [w.id, w]));
    return line.map((w, i) => (i < whole ? w : byId.get(w.id) ?? w));
  }, [line, whole, rest.data]);
  const modelOf = useModelName();
  const bulk = useQueueBulk();
  /** The right-click menu of a waiting job: run it next, move it where it saves model loads, group the line, cancel it or all. */
  const menu = useMenu<{ id: string; label: string; index: number }>();
  const ids = waiting.map((w) => w.id);
  const saves = groupingSaves(waiting, running);
  /** The model each row loads first (the running job counts as the one before the first): one chip per switch the head counts. */
  const loads = loadsAt(waiting, running);
  /** A machine free now that could start it, when the plan keeps it for another one (a faster one, one that holds its model). */
  const freeNow = (w: Job) => (w.pinned || !w.machine || !w.startsInMs ? undefined : machines.find((m) => m.id !== w.machine && !m.running && !m.paused && m.online !== false && !busyOutside(m) && (!w.runsOn || w.runsOn.includes(m.id))));
  /** The machine it goes to (or is pinned to), when that one's ComfyUI is busy outside Afflatus: why it waits. */
  const heldOutside = (w: Job) => machines.find((m) => m.id === (w.pinned ?? w.machine) && !m.running && busyOutside(m));
  const itemsOf = (j: { id: string; index: number }): MenuItem[] => {
    const place = betterPlace(waiting, j.id, running);
    const w = waiting.find((x) => x.id === j.id);
    return [
      { label: "Run next", icon: <ArrowUpToLine size={14} />, disabled: j.index === 0, run: () => onOrder(moved(ids, j.id, 0)) },
      ...(machines.length && onPin && w
        ? [{
            label: "Run on", icon: <Server size={14} />, note: w.pinned ? machineLabel(machines.find((m) => m.id === w.pinned) ?? { name: w.pinned, url: "" }) : "any machine",
            items: [
              { label: "Any machine", note: "the one that ends it soonest", checked: !w.pinned, run: () => onPin(w.id, null) },
              "—" as const,
              ...machines.map((m): MenuItem => ({ label: machineLabel(m), note: lackSaid(w.lacks?.[m.id]) ?? (["rendering", "idle"].includes(machineState(m)) ? undefined : machineState(m)), checked: w.pinned === m.id, run: () => onPin(w.id, m.id) })),
            ],
          } satisfies MenuItem]
        : []),
      ...(place ? [{ label: `Move after the ${modelOf(place.after).split(" · ")[0]} jobs`, icon: <ArrowDownToLine size={14} />, note: `saves ${plural(place.saves, "load")}`, run: () => onOrder(moved(ids, j.id, place.to)) }] : []),
      { label: "Group by model", icon: <Layers size={14} />, note: saves ? `saves ${plural(saves, "load")}` : undefined, disabled: !saves, run: () => void bulk.groupQueueByModel() },
      "—",
      { label: "Cancel this one", key: "Del", icon: <X size={14} />, danger: true, run: () => onRemove(j.id) },
      { label: "Cancel all waiting…", icon: <Trash2 size={14} />, danger: true, run: () => void bulk.cancelAllWaiting({ ids }) },
    ];
  };
  /** The head of its menu: its name, its place in the line and its model. */
  const waitingHead = (j: { id: string; label: string; index: number }) => {
    const w = waiting.find((x) => x.id === j.id);
    return { title: j.label, sub: `Waiting · ${j.index + 1} of ${ids.length}${w ? ` · ${modelOf(w)}` : ""}` };
  };
  const drop = (index: number) => {
    if (!dragged) return;
    onOrder(dropped(ids, dragged, index));
    setDragged(null);
    setOver(null);
  };
  const shown = all ? waiting : waiting.slice(0, SHOWN);
  const more = waiting.length - shown.length;

  if (!waiting.length) return null;
  return (
    // a narrow list (a phone) keeps each row's name and time: its model and machine notes go (@container/waiting)
    <div className="@container/waiting flex flex-col" onDragOver={(e) => dragged && e.preventDefault()} onDrop={() => over !== null && drop(over)}>
      <WaitingHead waiting={waiting} running={running} endsInMs={endsInMs} machines={machines} />
      {shown.map((w, i) => (
        <Fragment key={w.id}>
          <div
            tabIndex={0}
            onContextMenu={(e) => menu.open(e, { id: w.id, label: w.label, index: i })}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget || e.key !== "Delete") return;
              e.preventDefault();
              onRemove(w.id);
            }}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = "move";
              // dropped on a machine's lane, it is pinned there
              e.dataTransfer.setData(JOB_DRAG, w.id);
              setDragged(w.id);
            }}
            onDragEnd={() => {
              setDragged(null);
              setOver(null);
            }}
            onDragOver={(e) => {
              if (!dragged) return;
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              setOver(e.clientY < r.top + r.height / 2 ? i : i + 1);
            }}
            data-tip={w.kind === "export" || w.kind === "cut" ? `${w.kind} · no GPU needed` : w.kind === "load" ? "loads the model, renders nothing" : `queued ${when(w.createdAt)}`}
            className={cx(
              "group flex cursor-grab items-center gap-3.5 rounded-[10px] border-y-2 border-transparent py-px pr-1 pl-3 text-[13px] hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent",
              dragged === w.id && "opacity-50",
              dragged && over === i && "border-t-accent",
              dragged && over === i + 1 && i === shown.length - 1 && "border-b-accent",
            )}
          >
            <span className="w-[18px] shrink-0 font-mono text-ink-3">{i + 1}</span>
            {/* the name keeps some room: the notes after it give way first (cut short, whole in their tips) */}
            <span className="min-w-[8rem] grow basis-0 truncate font-semibold">{w.label}</span>
            <span className="max-w-[40%] shrink-0 truncate text-ink-2 @max-[480px]/waiting:hidden">{w.kind === "load" ? `load · ${modelOf(w)}` : modelOf(w)}</span>
            {loads[i] && !machines.length && <Chip tone="warn" tip={`ComfyUI loads ${modelOf(w)} before this one`}>loads {modelOf(w).split(" · ")[0]}</Chip>}
            {machines.length > 0 && w.pinned && (
              <Chip tip="Pinned to this machine: it runs there. Drag it onto another lane, or Run on in its menu, to move it.">
                <Pin size={11} className="shrink-0" /> {machineLabel(machines.find((m) => m.id === w.pinned) ?? { name: w.pinned, url: "" })}
              </Chip>
            )}
            {machines.length > 0 && !w.pinned && w.machine && (
              <span className="shrink-0 text-xs text-ink-2 @max-[480px]/waiting:hidden" data-tip={w.runsOn?.length === 1 ? "The only machine that can run it: the others lack its files or have its family off (Run on in its menu says what each lacks)" : "The machine that would end it soonest: the model already loaded there, its own learned speed, how soon it is free"}>
                → {machineLabel(machines.find((m) => m.id === w.machine) ?? { name: w.machine, url: "" })}{w.startsInMs ? ` · in ${est(w.startsInMs)}` : ""}{w.runsOn?.length === 1 ? " · only there" : ""}
              </span>
            )}
            {heldOutside(w) && <span className="min-w-0 truncate text-xs text-ink-2" data-tip={`${machineLabel(heldOutside(w)!)}: ${OUTSIDE_TIP}`}>· {machineLabel(heldOutside(w)!)} busy outside Afflatus</span>}
            <FetchNote w={w} machines={machines} />
            {machines.length > 0 && !w.pinned && w.runsOn?.length === 0 && (
              <Link href={settingHref("models.families")} className="shrink-0">
                <Chip tone="warn" tip="No machine has its files, or its family is off on every one. Settings › Models says what each machine has; or pin it to one (Run on) to download what it lacks there.">no machine can run it</Chip>
              </Link>
            )}
            {/* only some machines can run it and none of those takes work now (paused, away): which, and why */}
            {machines.length > 0 && !w.pinned && !w.machine && Boolean(w.runsOn?.length) && (
              <span className="min-w-0 truncate text-xs text-warn-ink" data-tip="Only these machines have its files (with its family on), and none of them takes work now. Resume one, or pin it to another machine (Run on) to download what it lacks there.">
                waits for {w.runsOn!.map((id) => {
                  const m = machines.find((x) => x.id === id);
                  return `${m ? machineLabel(m) : id}${m?.paused ? " (paused)" : m?.online === false ? " (offline)" : m && busyOutside(m) ? " (busy outside Afflatus)" : ""}`;
                }).join(", ")}
              </span>
            )}
            {/* a machine that takes work now but not this job: what keeps it off there (a pod lacking a node no pack has) */}
            {machines.length > 0 && !w.pinned && !w.machine && machines.filter((m) => !m.paused && m.online !== false && !w.runsOn?.includes(m.id) && lackSaid(w.lacks?.[m.id])).map((m) => (
              <span key={m.id} className="min-w-0 truncate text-xs text-ink-2" data-tip={`${machineLabel(m)}: ${lackSaid(w.lacks?.[m.id])}`}>
                · not on {machineLabel(m)}: {lackSaid(w.lacks?.[m.id])}
              </span>
            ))}
            {onPin && freeNow(w) && (
              <button type="button" className="shrink-0 text-xs font-semibold text-accent hover:underline" data-tip="It waits for a machine that ends it sooner; this one is free now" onClick={() => onPin(w.id, freeNow(w)!.id)}>
                Run on {machineLabel(freeNow(w)!)} now
              </button>
            )}
            <span className="w-[70px] shrink-0 text-right font-mono text-ink-2 @max-[480px]/waiting:w-[52px]">{est(w.estimateMs) || "—"}</span>
            <button type="button" aria-label={`Cancel ${w.label}`} data-tip="Cancel this one (Del)" onClick={() => onRemove(w.id)} className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-3 opacity-0 group-hover:opacity-100 hover:bg-raised hover:text-ink focus-visible:opacity-100">
              <X size={14} />
            </button>
          </div>
          {w.pinned && w.lacks?.[w.pinned] && <PinnedLacks machine={machineLabel(machines.find((m) => m.id === w.pinned) ?? { name: w.pinned, url: "" })} id={w.pinned} lack={w.lacks[w.pinned]!} />}
        </Fragment>
      ))}
      <div className="flex items-center gap-1 px-3 pt-1 text-xs text-ink-3">
        {more > 0 && <button type="button" onClick={() => setAll(true)} className="underline-offset-2 hover:text-ink hover:underline">and {more} more</button>}
        {all && waiting.length > SHOWN && <button type="button" onClick={() => setAll(false)} className="underline-offset-2 hover:text-ink hover:underline">show the first {SHOWN} only</button>}
        {waiting.length > 1 && <span data-tip="Images go before videos unless you move them.">{more > 0 || (all && waiting.length > SHOWN) ? " · " : ""}drag a row to reorder</span>}
      </div>
      {menu.menu && <ContextMenu at={menu.menu.at} label={`Actions on ${menu.menu.subject.label}`} head={waitingHead(menu.menu.subject)} items={itemsOf(menu.menu.subject)} onClose={menu.close} />}
    </div>
  );
}

/**
 * A waiting render and a rented pod's files: planned onto a pod still getting them, which comes first and how far it is;
 * planned elsewhere though a pod could take it once sent its files, that it is sooner where it goes (the files sent ahead).
 */
function FetchNote({ w, machines }: { w: Job; machines: MachineState[] }) {
  if (!w.fetch || !w.machine) return null;
  const pod = machines.find((m) => m.id === w.machine)?.rented;
  if (w.fetch[w.machine] && pod) {
    const coming = pod.files.filter((f) => f.jobs.includes(w.id) && f.state !== "ready");
    const now = coming.find((f) => f.state === "fetching") ?? coming[0];
    if (!now) return null;
    const share = now.total ? Math.round((now.bytes / now.total) * 100) : 0;
    return (
      <span className="shrink-0 text-xs text-ink-2" data-tip={`Its ${plural(coming.length, "file")} come to the pod first; it starts there once they are all there (${coming.map((f) => f.file).join(", ")})`}>
        · getting {now.file}{now.state === "fetching" ? ` · ${share} %` : ""}{coming.length > 1 ? ` · +${coming.length - 1}` : ""}
      </span>
    );
  }
  const elsewhere = Object.entries(w.fetch).filter(([id]) => id !== w.machine);
  if (!elsewhere.length) return null;
  const [id, f] = elsewhere[0]!;
  const m = machines.find((x) => x.id === id);
  return (
    <span className="shrink-0 text-xs text-ink-3" data-tip={`${m ? machineLabel(m) : id} could take it once sent its ${plural(f.files.length, "file")} (${est(f.ms) || "a while"}): it ends sooner here. The files are sent to the pod ahead, for the next one.`}>
      · sooner than on {m ? machineLabel(m) : id}
    </span>
  );
}

/** What keeps a waiting job off a machine, in a few words for its "Run on" menu; null when nothing does. */
function lackSaid(lack: MachineLack | undefined): string | null {
  if (!lack) return null;
  if (lack.balance) return `its RunPod balance lasts ${est(lack.balance.leftMs)}, this needs ${est(lack.balance.needMs)}`;
  if (lack.failed) return `its file cannot get there: ${lack.failed}`;
  if (lack.off) return "its family is off there";
  if (lack.why) return lack.why;
  return lack.files.length ? `lacks ${plural(lack.files.length, "file")}` : "cannot run it";
}

/**
 * A job pinned to a machine that lacks what it needs waits there: what it lacks, under its row, each file with its download
 * to that machine. It starts once they are there (the queue looks again when a download ends).
 */
function PinnedLacks({ machine, id, lack }: { machine: string; id: string; lack: MachineLack }) {
  return (
    <DownloadTo.Provider value={id}>
      <div className="mb-1 ml-[44px] flex flex-col gap-1.5 rounded-[10px] border border-line bg-raised px-3 py-2 text-xs text-ink-2">
        {lack.balance ? (
          <span>
            Waits: the RunPod balance lasts {est(lack.balance.leftMs)} at what the account spends now, and this needs {est(lack.balance.needMs)} on {machine} (its files still to come, and room over its forecast while the pod has few renders of it), with 10 min to spare. At zero RunPod stops every pod and the render is lost: add credit on RunPod, or run it on another machine.
          </span>
        ) : lack.failed ? (
          <span>
            Cannot run on {machine}: {lack.failed}. Run it on another machine from its menu. It does not keep {machine} on: with nothing else to render, the pod goes idle and ends on time.
          </span>
        ) : lack.off ? (
          <span>
            Waits: its family is off on {machine}.{" "}
            <Link href={settingHref("models.families")} className="font-semibold text-accent hover:underline">Settings › Models</Link>
          </span>
        ) : lack.files.length ? (
          <>
            <span>Waits for {plural(lack.files.length, "file")} on {machine}, then runs there:</span>
            {lack.files.map((f) => (
              <div key={`${f.folder}/${f.file}`}>
                <span className="font-semibold text-ink">{f.file}</span> <span className="text-ink-3">· {f.folder}</span>
                <GetFile file={f.file} folder={f.folder} url={f.url} />
              </div>
            ))}
          </>
        ) : lack.why ? (
          <span>Waits for {machine}: {lack.why}. Run on another machine from its menu.</span>
        ) : (
          <span>Waits: {machine} cannot run it (a custom node it needs is missing there). Run on another machine from its menu.</span>
        )}
      </div>
    </DownloadTo.Provider>
  );
}
