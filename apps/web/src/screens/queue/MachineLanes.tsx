import { lazy, Suspense, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, MoreHorizontal, Pause, Play } from "lucide-react";
import { previewUrl, type MachineState, type QueueStatus, type RunningJob, type SystemLoad } from "../../api";
import { useMenu } from "../../ContextMenu";
import { gb, phaseLabel, timeLeft } from "../../format";
import { machineLabel } from "../../machines";
import { useQueueOps } from "../../queueOps";
import { useSystem } from "../../store";
import { cx } from "../../ui";
import { RunningCard } from "./RunningCard";

const MachineMenuBody = lazy(() => import("../../MachineMenu").then((m) => ({ default: m.MachineMenuBody })));

/** What a waiting row carries when it is dragged (WaitingList): dropped on a lane, the job is pinned to that machine. */
export const JOB_DRAG = "application/x-afflatus-job";

/** Past this many machines the lanes are one row each, a row opening on a click: four cards are already a full width. */
const COMPACT_PAST = 4;

/** The columns of a machine's row, the same in every row and in an opened lane's head, so that they line up and nothing jumps. */
const ROW = "grid grid-cols-[16px_minmax(120px,180px)_88px_minmax(0,1fr)_minmax(0,170px)_316px_64px] items-center gap-3.5";

type State = "rendering" | "idle" | "paused" | "offline";
const stateOf = (m: MachineState): State => (m.paused ? "paused" : m.online === false ? "offline" : m.running ? "rendering" : "idle");

/** A machine's dot: filled green while it renders, a green ring when idle, grey when paused, a warning ring when away. */
function Dot({ state }: { state: State }) {
  return <span aria-hidden className={cx("size-2 shrink-0 rounded-full", state === "rendering" ? "bg-good" : state === "idle" ? "border-[1.5px] border-good" : state === "paused" ? "bg-ink-3" : "border-[1.5px] border-warn")} />;
}

/** Its state as a pill, in the colours the app gives them. */
function StatePill({ state }: { state: State }) {
  return (
    <span className={cx(
      "justify-self-start rounded-full px-2 py-px text-[11.5px] font-semibold",
      state === "rendering" ? "bg-accent-wash text-accent" : state === "idle" ? "border border-good/40 text-good" : state === "paused" ? "bg-hover text-ink-2" : "bg-warn-wash text-warn-ink",
    )}>
      {state}
    </span>
  );
}

/** The model it holds, as a chip; a dashed one when it holds none. */
function ModelChip({ model }: { model: string | null }) {
  return model
    ? <span className="max-w-full justify-self-start truncate rounded-[7px] border border-line bg-raised px-2 py-0.5 text-xs text-ink-2" data-tip={`Holds ${model}: a render with it starts at once here`}>{model}</span>
    : <span className="justify-self-start rounded-[7px] border border-dashed border-line-strong px-2 py-0.5 text-xs text-ink-3">no model</span>;
}

/** A small bar and its figure, as the status bar's meters. */
function Mini({ label, value, fill }: { label: string; value: number | undefined; fill: string }) {
  if (value === undefined) return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-ink-2">
      {label}
      <span className="relative h-1 w-[26px] overflow-hidden rounded-[2px] bg-line-strong"><span className={cx("absolute inset-y-0 left-0", fill)} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></span>
      <span className="w-8 font-mono text-ink">{Math.round(value)}%</span>
    </span>
  );
}

/** A machine's three meters in a row: GPU (in the accent colour while it renders), VRAM, RAM. Its full figures in the tip. */
function MiniMeters({ load, rendering }: { load: SystemLoad | null | undefined; rendering: boolean }) {
  const gpu = load?.gpus[0];
  if (!load || !gpu) return <span className="text-xs text-ink-3">no figures</span>;
  const tip = [gpu.name, `VRAM ${gb(gpu.vramUsed)} of ${gb(gpu.vramTotal)}`, load.cpu !== undefined && `CPU ${Math.round(load.cpu)} %`, gpu.temperature !== undefined && `${Math.round(gpu.temperature)}°`].filter(Boolean).join(" · ");
  return (
    <span className="inline-flex min-w-0 items-center gap-3 overflow-hidden" data-tip={tip}>
      <Mini label="GPU" value={gpu.load} fill={rendering ? "bg-accent" : "bg-ink-2"} />
      <Mini label="VRAM" value={gpu.vramPercent} fill="bg-ink" />
      <Mini label="RAM" value={load.ram?.percent} fill="bg-ink-3" />
    </span>
  );
}

/** The live preview small, while there is one; a quiet square before. */
function Thumb({ run, size }: { run: RunningJob; size: "sm" | "md" }) {
  const box = size === "sm" ? "h-[26px] w-10" : "h-9 w-14";
  const still = run.previewSeq > 0 && (!run.previewMime || run.previewMime.startsWith("image/"));
  return still
    ? <img src={previewUrl(run.id, run.previewSeq)} alt="" className={cx("shrink-0 rounded-[5px] object-cover", box)} />
    : <span className={cx("shrink-0 rounded-[5px] bg-raised", box)} />;
}

/** What it runs, in a line: the preview small, the job's name, its phase and what is left. */
function JobLine({ run, size = "sm" }: { run: RunningJob; size?: "sm" | "md" }) {
  const steps = run.steps ? ` ${run.step}/${run.steps}` : "";
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <Thumb run={run} size={size} />
      <span className="min-w-0 truncate font-semibold">{run.label}</span>
      <span className="shrink-0 font-mono text-xs text-ink-2">{phaseLabel(run.phase).toLowerCase()}{steps}{run.eta ? ` · ${timeLeft(run.eta)}` : ""}</span>
    </span>
  );
}

/** Pause or Resume (Resume in the accent colour, since that is what a paused machine is waiting for), and the menu. */
function Actions({ m, onMenu }: { m: MachineState; onMenu(e: React.MouseEvent): void }) {
  const ops = useQueueOps();
  const name = machineLabel(m);
  const icon = "grid size-7 place-items-center rounded-[7px]";
  return (
    <span className="flex justify-end gap-1">
      {m.paused ? (
        <button type="button" aria-label={`Resume ${name}`} data-tip={`Resume ${name}`} className={cx(icon, "bg-accent-wash text-accent hover:brightness-125")} onClick={(e) => { e.stopPropagation(); ops.resume.mutate(m.id); }}>
          <Play size={12} fill="currentColor" />
        </button>
      ) : (
        <button type="button" aria-label={`Pause ${name}`} data-tip={`Pause ${name}: it finishes what it runs, then takes nothing new`} className={cx(icon, "text-ink-2 hover:bg-hover hover:text-ink")} onClick={(e) => { e.stopPropagation(); ops.pause.mutate(m.id); }}>
          <Pause size={12} fill="currentColor" />
        </button>
      )}
      <button type="button" aria-label={`${name}: menu`} className={cx(icon, "text-ink-2 hover:bg-hover hover:text-ink")} onClick={(e) => { e.stopPropagation(); onMenu(e); }}>
        <MoreHorizontal size={14} />
      </button>
    </span>
  );
}

/** The thin accent line along the bottom edge: a render's progress, as the status bar's running pill draws it (pulsing before a step count). */
function ProgressEdge({ run }: { run: RunningJob | null }) {
  if (!run) return null;
  return <span className={cx("absolute bottom-0 left-0 h-0.5 bg-accent transition-[width] motion-reduce:transition-none", !run.progress && "animate-pulse opacity-40")} style={{ width: `${run.progress > 0 ? Math.min(100, run.progress * 100) : 100}%` }} />;
}

/** A lane's drop: a waiting job dropped on it is pinned to its machine. */
function useDrop(m: MachineState, onPin: (job: string, machine: string) => void) {
  const [over, setOver] = useState(false);
  return {
    over,
    props: {
      onDragOver: (e: React.DragEvent) => {
        if (!e.dataTransfer.types.includes(JOB_DRAG)) return;
        e.preventDefault();
        setOver(true);
      },
      onDragLeave: () => setOver(false),
      onDrop: (e: React.DragEvent) => {
        const job = e.dataTransfer.getData(JOB_DRAG);
        setOver(false);
        if (!job) return;
        e.preventDefault();
        e.stopPropagation();
        onPin(job, m.id);
      },
    },
  };
}

/** What a lane's parts share: its state, its figures, its menu and its drop. */
function useLane(m: MachineState, onPin: (job: string, machine: string) => void) {
  const menu = useMenu<true>();
  const load = useSystem((s) => s.loads[m.id]);
  const drop = useDrop(m, onPin);
  const state = stateOf(m);
  const menuNode = menu.menu && <Suspense fallback={null}><MachineMenuBody at={menu.menu.at} machine={m.id} onClose={menu.close} /></Suspense>;
  return { menu, load, drop, state, menuNode };
}

/** What its row says in the middle when it renders nothing. */
const quiet = (m: MachineState, state: State) => (state === "paused" ? "takes nothing new until it resumes" : state === "offline" ? "not answering · the others take the line" : "");

/** A machine in one row: its state, what it renders, what it holds, its meters, its actions, and its progress along the bottom. A click opens it. */
function MachineRow({ m, onPin, onOpen, open }: { m: MachineState; onPin(job: string, machine: string): void; onOpen(): void; open?: boolean }) {
  const { menu, load, drop, state, menuNode } = useLane(m, onPin);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={Boolean(open)}
      aria-label={`${machineLabel(m)}: ${open ? "fold" : "open"} its lane`}
      {...drop.props}
      onClick={onOpen}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && e.target === e.currentTarget && (e.preventDefault(), onOpen())}
      onContextMenu={(e) => menu.open(e, true)}
      className={cx(
        ROW, "relative h-11 cursor-pointer overflow-hidden px-3 text-[13px] transition-colors hover:bg-hover",
        open ? "border-b border-line/60" : "rounded-[10px] border",
        !open && (drop.over ? "border-accent ring-1 ring-accent" : state === "offline" ? "border-warn/30 bg-panel" : "border-line bg-panel"),
        state === "paused" && !open && "opacity-70",
      )}
    >
      {open ? <ChevronDown size={13} className="text-ink-2" /> : <ChevronRight size={13} className="text-ink-3" />}
      <span className="flex min-w-0 items-center gap-2"><Dot state={state} /><span className="truncate text-[14px] font-semibold">{machineLabel(m)}</span></span>
      <StatePill state={state} />
      {m.running && !open ? <JobLine run={m.running} /> : <span className={cx("truncate text-xs", state === "offline" ? "text-warn-ink" : "text-ink-3")}>{open ? load?.gpus[0]?.name ?? "" : quiet(m, state)}</span>}
      <ModelChip model={m.model} />
      {open ? <span /> : <MiniMeters load={load} rendering={state === "rendering"} />}
      <Actions m={m} onMenu={(e) => menu.open(e, true)} />
      {!open && <ProgressEdge run={m.running} />}
      {menuNode}
    </div>
  );
}

/** One meter as a tile: its name, its figure, its bar. */
function Tile({ label, value, bar, fill, note }: { label: string; value: string; bar?: number; fill?: string; note?: string }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-raised px-2.5 py-2">
      <span className="flex items-baseline justify-between gap-2 text-[11px] whitespace-nowrap text-ink-2">{label}<span className="font-mono text-[11.5px] text-ink">{value}</span></span>
      {bar !== undefined ? <span className="h-1 overflow-hidden rounded-[2px] bg-line-strong"><span className={cx("block h-full", fill)} style={{ width: `${Math.max(0, Math.min(100, bar))}%` }} /></span> : <span className="text-[11px] text-ink-3">{note}</span>}
    </div>
  );
}

/** A machine's meters as tiles: GPU, VRAM (in use of all of it), RAM, CPU, the GPU's temperature, and its learned pace against the fastest. */
function MeterTiles({ load, rendering, pace, fastest }: { load: SystemLoad | null | undefined; rendering: boolean; pace: number | null; fastest: number | null }) {
  const gpu = load?.gpus[0];
  const tiles: ReactNode[] = [];
  if (gpu?.load !== undefined) tiles.push(<Tile key="gpu" label="GPU" value={`${Math.round(gpu.load)}%`} bar={gpu.load} fill={rendering ? "bg-accent" : "bg-ink-2"} />);
  if (gpu) tiles.push(<Tile key="vram" label="VRAM" value={`${gb(gpu.vramUsed).replace(" GB", "")} / ${gb(gpu.vramTotal)}`} bar={gpu.vramPercent} fill="bg-ink" />);
  if (load?.ram) tiles.push(<Tile key="ram" label="RAM" value={`${Math.round(load.ram.percent)}%`} bar={load.ram.percent} fill="bg-ink-3" />);
  if (load?.cpu !== undefined) tiles.push(<Tile key="cpu" label="CPU" value={`${Math.round(load.cpu)}%`} bar={load.cpu} fill="bg-ink-3" />);
  if (gpu?.temperature !== undefined) tiles.push(<Tile key="temp" label="GPU temp" value={`${Math.round(gpu.temperature)}°`} bar={gpu.temperature} fill={gpu.temperature >= 80 ? "bg-warn" : "bg-ink-3"} />);
  const relative = pace !== null && fastest ? pace / fastest : null;
  tiles.push(<Tile key="pace" label="Pace" value={relative === null ? "—" : `×${relative.toFixed(1)}`} note={relative === null ? "nothing to compare yet" : relative < 1.05 ? "the fastest here" : "vs the fastest"} />);
  return <div className="grid content-start grid-cols-3 gap-1.5">{tiles}</div>;
}

/** A machine opened: the same head as its row (nothing jumps), then its running card or a calm idle state, and its meters as tiles. */
function OpenLane({ m, fastest, onStop, onPin, onFold }: { m: MachineState; fastest: number | null; onStop(id: string): void; onPin(job: string, machine: string): void; onFold(): void }) {
  const { menu, load, drop, state, menuNode } = useLane(m, onPin);
  const name = machineLabel(m);
  return (
    <section
      aria-label={name}
      {...drop.props}
      className={cx("relative overflow-hidden rounded-xl border bg-panel", drop.over ? "border-accent ring-1 ring-accent" : state === "rendering" ? "border-accent/30" : state === "offline" ? "border-warn/30" : "border-line", state === "paused" && "opacity-80")}
    >
      <MachineRow m={m} onPin={onPin} onOpen={onFold} open />
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(300px,420px)] gap-4 p-3.5">
        {m.running ? <RunningCard running={m.running} onStop={onStop} /> : (
          <div className="flex items-center gap-3.5 rounded-[10px] border border-dashed border-line-strong px-4 py-3 text-ink-2">
            <span className="grid size-[34px] shrink-0 place-items-center rounded-full border-[1.5px] border-line-strong"><Dot state={state} /></span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="font-semibold text-ink">{state === "paused" ? "Paused · takes nothing new until it resumes" : state === "offline" ? "Not answering · the others take the line" : "Idle · ready for the next job"}</span>
              <span className="text-xs">{m.model ? `Holds ${m.model}: a render with it starts at once here. ` : ""}Drop a waiting job on this machine to run it here.</span>
            </span>
            <span className="grow" />
            {state === "idle" && (
              <button type="button" className="shrink-0 rounded-[7px] border border-line-strong bg-raised px-3 py-1.5 text-xs font-semibold whitespace-nowrap text-ink hover:bg-hover" onClick={(e) => menu.open(e, true)}>
                Load on {name} ▸
              </button>
            )}
          </div>
        )}
        <MeterTiles load={load} rendering={state === "rendering"} pace={m.pace} fastest={fastest} />
      </div>
      {menuNode}
    </section>
  );
}

/** Four machines or fewer: a card each, side by side, the same parts as a row. A click opens it across the width. */
function MachineCard({ m, onPin, onOpen }: { m: MachineState; onPin(job: string, machine: string): void; onOpen(): void }) {
  const { menu, load, drop, state, menuNode } = useLane(m, onPin);
  const gpu = load?.gpus[0];
  return (
    <section
      aria-label={machineLabel(m)}
      {...drop.props}
      onClick={onOpen}
      onContextMenu={(e) => menu.open(e, true)}
      className={cx(
        "relative flex min-w-0 cursor-pointer flex-col gap-2.5 overflow-hidden rounded-xl border bg-panel p-3 transition-colors hover:bg-hover",
        drop.over ? "border-accent ring-1 ring-accent" : state === "rendering" ? "border-accent/30" : state === "offline" ? "border-warn/30" : "border-line",
        state === "paused" && "opacity-70",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Dot state={state} />
        <span className="truncate text-[14px] font-semibold">{machineLabel(m)}</span>
        <StatePill state={state} />
        <span className="grow" />
        <Actions m={m} onMenu={(e) => menu.open(e, true)} />
      </div>
      <div className="flex h-9 min-w-0 items-center">
        {m.running ? <JobLine run={m.running} size="md" /> : <span className={cx("truncate text-xs", state === "offline" ? "text-warn-ink" : "text-ink-3")}>{quiet(m, state) || "Ready for the next job · drop one here to pin it"}</span>}
      </div>
      <div className="flex min-w-0 items-center gap-3 text-xs text-ink-2">
        {gpu ? (
          <span className="flex min-w-0 gap-3 truncate" data-tip={gpu.name}>
            {gpu.load !== undefined && <span>GPU {Math.round(gpu.load)}%</span>}
            <span>VRAM {gb(gpu.vramUsed).replace(" GB", "")}/{gb(gpu.vramTotal)}</span>
            {load?.ram && <span>RAM {Math.round(load.ram.percent)}%</span>}
          </span>
        ) : <span className="text-ink-3">no figures</span>}
        <span className="grow" />
        <ModelChip model={m.model} />
      </div>
      <ProgressEdge run={m.running} />
      {menuNode}
    </section>
  );
}

/**
 * With several ComfyUIs, the machines at the top of the queue, in place of the one running card: up to four as cards side
 * by side, more as one row each. A click opens a machine across the width: its running card (or what it is ready for) and
 * its meters as tiles. A waiting job dropped on a machine is pinned to it.
 */
export function MachineLanes({ q, onStop, onPin }: { q: QueueStatus; onStop(id: string): void; onPin(job: string, machine: string): void }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) => setOpen((was) => {
    const next = new Set(was);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  const paces = q.machines.map((m) => m.pace).filter((p): p is number => p !== null);
  const fastest = paces.length ? Math.min(...paces) : null;
  const opened = (m: MachineState) => <OpenLane key={m.id} m={m} fastest={fastest} onStop={onStop} onPin={onPin} onFold={() => toggle(m.id)} />;
  // a job that needs no ComfyUI (an export, a cut by ffmpeg) runs beside the machines: its card shows apart
  const tool = q.tool;
  const compact = q.machines.length > COMPACT_PAST;
  return (
    <div className="flex flex-col gap-2">
      {compact ? (
        <div className="flex flex-col gap-1">
          {q.machines.map((m) => (open.has(m.id) ? opened(m) : <MachineRow key={m.id} m={m} onPin={onPin} onOpen={() => toggle(m.id)} />))}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-2.5">
            {q.machines.filter((m) => !open.has(m.id)).map((m) => <MachineCard key={m.id} m={m} onPin={onPin} onOpen={() => toggle(m.id)} />)}
          </div>
          {q.machines.filter((m) => open.has(m.id)).map(opened)}
        </>
      )}
      {tool && <RunningCard running={tool} onStop={onStop} />}
    </div>
  );
}
