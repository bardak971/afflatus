import { lazy, Suspense, useRef, useState } from "react";
import { Link } from "wouter";
import { MoreHorizontal, Pause, Play, Square } from "lucide-react";
import type { MachineState, PodDisk, QueueStatus, RunningJob, SystemLoad } from "../../api";
import { useMenu } from "../../ContextMenu";
import { gb, phaseLabel, plural, timeLeft } from "../../format";
import { LivePreview, StageStrip } from "../../LivePreview";
import { machineLabel, machineState, OUTSIDE_TIP, outsideSaid, rentedSaid, type MachineWord } from "../../machines";
import { useQueueOps } from "../../queueOps";
import { useSystem } from "../../store";
import { Bar, Button, cx } from "../../ui";
import { CudaChip, diskSaid, FilesLine, filesSaid, filesTip, gettingFiles, STARTING_DOT } from "../../machineBits";
import { Popover } from "../../Popover";
import { settingHref } from "../settings/settingsIndex";
import { useModelName } from "./modelName";
import { RunningCard } from "./RunningCard";

const MachineMenuBody = lazy(() => import("../../MachineMenu").then((m) => ({ default: m.MachineMenuBody })));

/** What a waiting row carries when it is dragged (WaitingList): dropped on a machine's row, the job is pinned to that machine. */
export const JOB_DRAG = "application/x-afflatus-job";

/**
 * How a row looks in its state (machineState): a stopped pod as a paused machine, a starting one as on its way up (the
 * pill's dot). One away (offline) is amber: it often comes back by itself, ComfyUI restarting or a pod booting (the owner,
 * 2026-10-22). One locked against Afflatus's token, or a pod whose start failed (or that crashed), is broken: red.
 */
type State = "rendering" | "outside" | "getting" | "idle" | "paused" | "offline" | "broken" | "starting";
const lookOf = (word: MachineWord, failed = false): State => (word === "stopped" || word === "checking" ? "paused" : word === "locked" || (word === "starting" && failed) ? "broken" : word === "getting files" ? "getting" : word === "busy outside Afflatus" ? "outside" : word);

/**
 * A machine's dot: filled green while it renders, a ring in the accent while it gets files, that ring filled with the
 * accent's wash while its ComfyUI is busy outside Afflatus, a green ring when idle, grey when paused, an amber ring when away,
 * a warning ring when broken.
 */
function Dot({ state }: { state: State }) {
  return <span aria-hidden data-state={state} className={cx("size-2 shrink-0 rounded-full", state === "rendering" ? "bg-good" : state === "outside" ? "border-[1.5px] border-accent bg-accent-wash" : state === "getting" ? "border-[1.5px] border-accent" : state === "idle" ? "border-[1.5px] border-good" : state === "starting" ? STARTING_DOT : state === "paused" ? "bg-ink-3" : state === "offline" ? "border-[1.5px] border-attention" : "border-[1.5px] border-warn")} />;
}

/** Its state as a pill (its word: machineState), in the colours the app gives them. */
function StatePill({ state, word }: { state: State; word: MachineWord | "crashed" }) {
  return (
    <span data-tip={state === "outside" ? OUTSIDE_TIP : undefined} className={cx(
      "self-start rounded-full px-2 py-px text-meta font-semibold whitespace-nowrap",
      state === "rendering" ? "bg-accent-wash text-accent" : state === "outside" ? "border border-accent/40 bg-accent-wash text-accent" : state === "getting" ? "border border-accent/40 text-accent" : state === "idle" ? "border border-good/40 text-good" : state === "starting" ? "border border-good/40 text-ink-2" : state === "paused" ? "bg-hover text-ink-2" : state === "offline" ? "bg-attention-wash text-attention-ink" : "bg-warn-wash text-warn-ink",
    )}>
      {word}
    </span>
  );
}

/**
 * Its GPU and VRAM as words, the rest of its figures in the tip: the Queue no longer draws a machine's meters as tiles, the
 * machines pill's popover has them for each machine, and the status bar the one ComfyUI's.
 */
function Figures({ load, disk }: { load: SystemLoad | null | undefined; disk: PodDisk | null }) {
  const gpu = load?.gpus[0];
  if (!load || !gpu) return <span className="text-xs text-ink-3">no figures</span>;
  const tip = [
    gpu.name,
    `VRAM ${gb(gpu.vramUsed)} of ${gb(gpu.vramTotal)}`,
    load.ram && `RAM ${Math.round(load.ram.percent)} %`,
    load.cpu !== undefined && `CPU ${Math.round(load.cpu)} %`,
    gpu.temperature !== undefined && `${Math.round(gpu.temperature)}°`,
    disk && `disk ${diskSaid(disk)}`,
  ].filter(Boolean).join(" · ");
  return (
    <span className="font-mono text-meta whitespace-nowrap text-ink-2" data-tip={tip}>
      {gpu.load !== undefined && `GPU ${Math.round(gpu.load)} · `}VRAM {gb(gpu.vramUsed).replace(" GB", "")}/{gb(gpu.vramTotal).replace(" GB", "")}
    </span>
  );
}

/**
 * The live preview small, a button: a click shows it large over the page (with its sound, and the workflow's own Preview
 * nodes under it), to judge a render by. Before a first preview, and on a machine that renders nothing, its dot in its place.
 */
function Thumb({ run, state, onLarge, anchor }: { run: RunningJob | null; state: State; onLarge(): void; anchor: React.RefObject<HTMLButtonElement | null> }) {
  const seen = Boolean(run && run.previewSeq > 0);
  if (!run || !seen) return <span className="grid h-[52px] w-10 shrink-0 place-items-center rounded-md bg-raised"><Dot state={state} /></span>;
  return (
    <button ref={anchor} type="button" data-stage aria-label="Show the live preview large" data-tip="Show it large, with its sound" onClick={(e) => { e.stopPropagation(); onLarge(); }} className="h-[52px] w-10 shrink-0 overflow-hidden rounded-md bg-raised hover:ring-2 hover:ring-accent/50">
      <LivePreview job={run} className="h-full w-full object-cover" />
    </button>
  );
}

/** A render's phase, its step and what is left, in a few characters. */
const stepSaid = (run: RunningJob) => `${phaseLabel(run.phase).toLowerCase()}${run.steps ? ` ${run.step}/${run.steps}` : ""}${run.eta > 0 ? ` · ${timeLeft(run.eta)}` : ""}`;

/** What a running render says in its row: its name and model, its progress, its phase and step and what is left, and (`figures`) its machine's GPU and VRAM at the end of that line. */
function JobCell({ run, figures }: { run: RunningJob; figures: React.ReactNode }) {
  const modelOf = useModelName();
  const model = run.kind === "load" ? `loading ${modelOf(run)}` : modelOf(run);
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 shrink truncate font-semibold" data-tip={run.label}>{run.label}</span>
        <span className="min-w-0 shrink-[2] truncate text-xs text-ink-3">{model}</span>
      </span>
      <Bar value={run.progress * 100} steps={run.steps} loading={!run.progress} />
      <span className="flex min-w-0 items-center gap-2 font-mono text-meta text-ink-2">
        {/* what is left before its figures, which give way first (whole in their tip) */}
        <span className="shrink-0">{stepSaid(run)}</span>
        {run.spilling && <span className="shrink-0 font-sans font-semibold text-warn-ink" data-tip="Out of video memory, it seems: much slower than usual. Stop it and run it again once nothing else holds the GPU's memory.">spilling out of VRAM</span>}
        <span className="grow" />
        {figures}
      </span>
    </span>
  );
}

/** What its row says in the middle when it renders nothing. */
const quiet = (m: MachineState, word: MachineWord) =>
  word === "busy outside Afflatus" ? `${outsideSaid(m)} · the others take the line`
  // paused, its files still come (sent ahead for Resume): said, not hidden behind the pause
  : word === "paused" ? (gettingFiles(m) ? `takes nothing new · getting ${plural(gettingFiles(m)!.left.length, "file")} · ${filesSaid(gettingFiles(m)!)}` : "takes nothing new until it resumes")
  : word === "stopped" && m.rented ? `${rentedSaid(m.rented)} · the others take the line`
  : word === "checking" ? "reading its state from RunPod · the others take the line"
  // a deployed pod's first start: its phase line, as the pill and its card say it
  : word === "starting" && m.rented?.boot ? `${rentedSaid(m.rented)} · the others take the line`
  : word === "starting" ? "starting: its image is pulled, then ComfyUI comes up · the others take the line"
  : word === "locked" ? "locked: its token is wrong · the others take the line"
  : word === "offline" ? "not answering · the others take the line"
  : m.model ? `ready · holds ${m.model} · drop a job here to pin it` : "ready for the next job · drop one here to pin it";

/**
 * Where a machine's files are listed one by one, each with its bar: a pod's card in Settings › Rented GPUs, a ComfyUI of
 * one's own's downloads in Settings › Models. Its row says only how many and how far.
 */
const filesHref = (m: MachineState) => settingHref(m.rented ? "rented.pods" : "models.families");

/** Stop (while it renders), Pause or Resume (Resume in the accent colour, since that is what a paused machine is waiting for), and the menu. */
function Actions({ m, onStop, onMenu }: { m: MachineState; onStop(id: string): void; onMenu(e: React.MouseEvent): void }) {
  const ops = useQueueOps();
  const name = machineLabel(m);
  const icon = "grid size-7 place-items-center rounded-chip";
  return (
    <span className="flex shrink-0 justify-end gap-1">
      {m.running && (
        <button type="button" aria-label={`Stop ${m.running.label}`} data-tip="Stop this render" className={cx(icon, "border border-line-strong bg-raised text-ink-2 hover:bg-hover hover:text-ink")} onClick={(e) => { e.stopPropagation(); onStop(m.running!.id); }}>
          <Square size={11} fill="currentColor" />
        </button>
      )}
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

/** A row's drop: a waiting job dropped on it is pinned to its machine. */
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

/** A running render shown large, over the page, from its row's preview: the preview with its sound, its stages, its step, Stop. */
function LargePreview({ run, machine, anchor, onStop, onClose }: { run: RunningJob; machine: string; anchor: React.RefObject<HTMLButtonElement | null>; onStop(id: string): void; onClose(): void }) {
  return (
    <Popover anchor={anchor} onClose={onClose} label={`${machine}'s live preview`} width={380} height={600} className="gap-2.5 p-3">
      <span className="truncate font-semibold" data-tip={run.label}>{machine} · {run.label}</span>
      <div data-stage className="flex h-[440px] items-center justify-center overflow-hidden rounded-lg bg-stage">
        <LivePreview job={run} sound className="h-full w-auto max-w-full object-contain" />
      </div>
      <StageStrip job={run} />
      <Bar value={run.progress * 100} steps={run.steps} loading={!run.progress} />
      <span className="flex items-center gap-2">
        <span className="min-w-0 grow truncate font-mono text-xs text-ink-2">{stepSaid(run)}</span>
        <Button size="sm" onClick={() => { onStop(run.id); onClose(); }}>Stop this render</Button>
      </span>
    </Popover>
  );
}

/**
 * A machine in one row, whatever it does, always the same height: its preview or its dot, its name and state, what it
 * renders (or the files it gets, or why it takes nothing), its GPU and VRAM, its actions. Nothing opens: what a machine's
 * card held is elsewhere already (its meters in the machines pill's popover, a pod's files on its card in Settings ›
 * Rented GPUs), and its cut-off cards were what broke the page (2026-10-17). A waiting job dropped on it is pinned there.
 */
function MachineRow({ m, onStop, onPin }: { m: MachineState; onStop(id: string): void; onPin(job: string, machine: string): void }) {
  const menu = useMenu<true>();
  const load = useSystem((s) => s.loads[m.id]);
  const drop = useDrop(m, onPin);
  const word = machineState(m);
  // a pod whose ComfyUI died, terminated for it: said as a crash, in the colours of a machine gone wrong, not as stopped
  const crashed = word === "stopped" && m.rented?.stoppedBy === "crash";
  const state = crashed ? "broken" : lookOf(word, Boolean(m.rented?.boot?.failed));
  const name = machineLabel(m);
  const files = gettingFiles(m);
  const thumb = useRef<HTMLButtonElement>(null);
  const [large, setLarge] = useState(false);
  // on a narrow row (a phone) they go: its name and what it does keep the room
  const figures = <span className="hidden min-w-0 truncate @min-[520px]/row:inline"><Figures load={load} disk={m.rented?.disk ?? null} /></span>;
  return (
    <section
      aria-label={name}
      // a waiting job's "waits for 3 files on …" scrolls here (WaitingList)
      data-machine={m.id}
      {...drop.props}
      // no menu on a right-click: its ⋯ has it (the owner, 2026-10-17)
      // the container its grid asks for its width (a narrow row, on a phone, leaves its figures out): an element is not its own
      className={cx(
        "@container/row min-w-0 rounded-control border bg-panel text-body",
        drop.over ? "border-accent ring-1 ring-accent" : state === "rendering" || state === "getting" ? "border-accent/30" : state === "offline" ? "border-attention/35" : state === "broken" ? "border-warn/30" : "border-line",
        state === "paused" && "opacity-75",
      )}
    >
      {/* its name column as wide as its state needs ("busy outside Afflatus" was cut at 1440, two to a line), the name capped */}
      <div className="grid h-[66px] grid-cols-[40px_auto_minmax(0,1fr)_auto] items-center gap-3 px-2.5">
      <Thumb run={m.running} state={state} anchor={thumb} onLarge={() => setLarge(!large)} />
      <span className="flex min-w-0 flex-col gap-1">
        <span className="max-w-[11rem] truncate text-title font-semibold" data-tip={m.rented ? `${name} · rented on RunPod` : name}>{name}</span>
        <span className="flex items-center gap-1.5"><StatePill state={state} word={crashed ? "crashed" : word} /><CudaChip m={m} /></span>
      </span>
      {m.running ? <JobCell run={m.running} figures={figures} /> : files && state === "getting" ? (
        <span className="flex min-w-0 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate font-semibold" data-tip={filesTip(name, files)}>{plural(files.left.length, "file")}{files.ahead ? " for later jobs" : " for its jobs"}</span>
            <span className="grow" />
            <Link href={filesHref(m)} className="shrink-0 text-xs font-semibold text-accent hover:underline" data-tip={filesTip(name, files)}>Files ›</Link>
          </span>
          <FilesLine g={files} />
        </span>
      ) : (
        <span className="flex min-w-0 items-center gap-3">
          {/* two lines at most, the whole in its tip: a pod's boot line ran out at 1440 with three machines, two to a line */}
          <span className={cx("line-clamp-2 min-w-0 text-xs", state === "offline" ? "text-attention-ink" : state === "broken" ? "text-warn-ink" : "text-ink-3")} data-tip={state === "outside" ? OUTSIDE_TIP : quiet(m, word)}>{quiet(m, word)}</span>
          <span className="grow" />
          {figures}
        </span>
      )}
      <Actions m={m} onStop={onStop} onMenu={(e) => menu.open(e, true)} />
      </div>
      {large && m.running && <LargePreview run={m.running} machine={name} anchor={thumb} onStop={onStop} onClose={() => setLarge(false)} />}
      {menu.menu && <Suspense fallback={null}><MachineMenuBody at={menu.menu.at} machine={m.id} onClose={menu.close} /></Suspense>}
    </section>
  );
}

/**
 * The machines at the top of the queue, one row each, two to a line from two machines on a wide window (one machine: the
 * whole width). Every row is as tall as the others and nothing opens, so the page never grows, clips or overlaps with what a
 * machine does. A job that needs no ComfyUI (an export, a cut by ffmpeg) runs beside them: its card shows under them.
 */
export function MachineLanes({ q, onStop, onPin }: { q: QueueStatus; onStop(id: string): void; onPin(job: string, machine: string): void }) {
  const machines = q.machines ?? [];
  return (
    <div className="flex flex-col gap-2">
      {machines.length > 0 && (
        <div className={cx("grid gap-2", machines.length > 1 && "min-[1200px]:grid-cols-2")}>
          {machines.map((m) => <MachineRow key={m.id} m={m} onStop={onStop} onPin={onPin} />)}
        </div>
      )}
      {q.tool && <RunningCard running={q.tool} onStop={onStop} />}
    </div>
  );
}
