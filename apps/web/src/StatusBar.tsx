import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { Clock, Download } from "lucide-react";
import { useMenu } from "./ContextMenu";
import { Link, useLocation } from "wouter";
import { Progress } from "./progress/Progress";
import { api, type Job, type MachineState, type QueueStatus, type RunningJob } from "./api";
import { useAsset, useProjects, useQueue, useSettings } from "./data";
import { Keys } from "./Keys";
import { BAR_DEFAULT } from "./keys/barDefault";
import { useDownloads } from "./useGetFile";
import { elapsed, gb, phaseLabel, timeLeft, when } from "./format";
import { StripModel, StripPlace, stripGhost } from "./ModelLoad";
import { LoadPanelHost } from "./loadPanelHost";
import { MachinesPill, OPEN_MACHINES } from "./MachinesPill";
import { busyOutside, machineLabel, machineName, noGpuYet, OUTSIDE_TIP, outsideSaid, severalMachines } from "./machines";
import { openDeploy } from "./deploy";
import { lazyPart, loadExpiringPanel, loadHuntStrip } from "./lazyParts";
import { useProject } from "./project";
import { useQueueOps } from "./queueOps";
import { expiringSaid, useExpiring, useExpiringOnly, useKeepAllExpiring } from "./screens/studio/expiring";
import { unkeptMs, useKeepFor } from "./keepFor";
import { useLive, useStudio, useSystem } from "./store";
import { Chip, cx } from "./ui";

// the viewer is fetched the first time the last result is opened from here
// the expiring chip's panel and menu: opened now and then, the strip itself is in the first load
const ExpiringPanel = lazyPart(loadExpiringPanel, (m) => m.ExpiringPanel);
// the GPU hunt's strip: only while a hunt is under way, so not in the first load
const HuntStrip = lazyPart(loadHuntStrip, (m) => m.HuntStrip);
const Viewer = lazy(() => import("./Viewer").then((m) => ({ default: m.Viewer })));

/** A number of the strip in the room of three digits. */
const pad = (n: number) => String(Math.round(n)).padStart(3, " ");

const pill = "relative inline-flex h-7 items-center gap-2 overflow-hidden rounded-[9px] bg-raised px-2.5 whitespace-nowrap";
const dot = "size-[7px] shrink-0 rounded-full";
const Sep = () => <span className="h-[18px] w-px shrink-0 bg-line" />;

/** The last job that made something: a model loaded ahead (a "load") is not a render that finished. */
const lastMade = (q: QueueStatus | undefined) => q?.recent.find((j) => j.status === "done" && j.kind !== "load") ?? null;

/** The strip at the bottom of every screen: on the left the one thing that matters now, on the right where outputs go, the model and the GPU. */
export function StatusBar() {
  const queue = useQueue();
  const q = queue.data;
  // with several ComfyUIs the machines' pill has their figures (MachinesPill.tsx): the meters below are one ComfyUI's
  const several = severalMachines(q);
  const first = useSystem((s) => s.load);
  const load = several.length ? null : first;
  const gpu = load?.gpus[0];
  const cpu = load?.cpu;
  const ram = load?.ram;
  const run = q?.running ?? null;
  // a clock that ticks: every second while something runs (its elapsed time), every half minute otherwise ("finished 2 min ago")
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), run ? 1000 : 30_000);
    return () => clearInterval(t);
  }, [run?.id]); // eslint-disable-line react-hooks/exhaustive-deps -- a new clock per job, not per read of the queue
  // a model being fetched into ComfyUI goes on whatever screen is open: it is said here, with the way to it
  const fetching = (useDownloads().data?.items ?? []).filter((d) => d.status === "starting" || d.status === "downloading" || d.status === "saving");
  const waiting = q?.waiting.length ?? 0;
  const liveDown = useLive((s) => s.down);
  const settings = useSettings().data;
  const barKey = settings?.bar?.shortcut ?? BAR_DEFAULT;
  // no ComfyUI of the user's own and no pod up: nothing is offline, the jobs wait for a GPU
  const noGpu = noGpuYet(settings?.machines, q);
  // a GPU hunt that holds the renders takes the left slot while nothing renders; otherwise it is a chip after it
  const hunt = q?.hunt && q.hunt.status !== "up" ? q.hunt : null;
  const huntSlot = Boolean(hunt && hunt.hold === "rest" && !run);
  return (
    <>
      <LoadPanelHost />
      <footer className="flex h-10 shrink-0 items-center gap-2.5 overflow-hidden border-t border-line bg-panel px-3 text-xs">
        {huntSlot && hunt ? <Suspense fallback={null}><HuntStrip hunt={hunt} slot /></Suspense> : run ? <Running run={run} /> : q?.online === false ? <Offline q={q} /> : q?.paused ? <Paused waiting={waiting} /> : noGpu ? <NoGpu waiting={waiting} hasKey={Boolean(settings?.hasRunpodKey)} /> : <Idle last={lastMade(q)} machines={q?.machines ?? []} />}
        {several.filter((m) => m.running).length > 1 && (
          <button type="button" className="inline-flex h-6 shrink-0 items-center rounded-full border border-line px-2 text-xs hover:bg-hover" data-tip="Renders running on the other ComfyUIs: click for each machine" onClick={() => window.dispatchEvent(new Event(OPEN_MACHINES))}>
            +{several.filter((m) => m.running).length - 1}
          </button>
        )}
        {/* paused by the hunt that holds the renders: its own chip says so, and a Resume asks first (queueOps.ts) */}
        {run && q?.paused ? !(hunt?.hold === "rest") && <Paused waiting={waiting} /> : waiting > 0 && (run || q?.online !== false) && !q?.paused && !noGpu && (
          <Link href="/queue" className={cx(stripGhost, "shrink-0")} data-tip="Jobs waiting their turn: open the Queue to reorder or cancel them">+{waiting} queued</Link>
        )}
        {hunt && !huntSlot && <Suspense fallback={null}><HuntStrip hunt={hunt} slot={false} /></Suspense>}
        <Expiring />
        {fetching.length > 0 && (
          <Link href="/settings/models" className={cx(stripGhost, "min-w-0")} data-tip="A model file is being downloaded into ComfyUI. It goes on if this page is closed. Open Settings to see it or cancel it.">
            <Download size={13} className="shrink-0" />
            <span className="truncate">{fetching.length === 1 ? fetching[0]!.file.split(/[\\/]/).pop() : `${fetching.length} files`}</span>
            {/* with several ComfyUIs, which one it goes to */}
            {fetching.length === 1 && several.length > 0 && fetching[0]!.machine && <span className="shrink-0 text-ink-2">→ {machineName(q, fetching[0]!.machine)}</span>}
            {fetching.length === 1 && fetching[0]!.total > 0 && <span className="font-mono whitespace-pre">{pad(Math.floor((fetching[0]!.bytes / fetching[0]!.total) * 100))} %</span>}
          </Link>
        )}
        {/* the server's events stopped coming (a restart, a proxy between): what is shown may be old until they are back */}
        {liveDown && <Chip tone="warn" tip="The connection that brings live updates from the server dropped. It is being opened again; what is shown here may be out of date until then, and is read again once it is back.">live updates lost · reconnecting</Chip>}
        <span className="grow" />
        {/* the place and the model come with the first answers: they fade in rather than pop (the model waits for the queue's).
            Clipped when short of room, and left out on a narrow window: they spilled over the meters there */}
        {!queue.isPending && (
          <span className="m-fade inline-flex min-w-0 items-center gap-2.5 overflow-hidden max-md:hidden">
            <StripPlace />
            <StripModel />
          </span>
        )}
        {several.length > 0 && (
          <span className="m-fade inline-flex shrink-0 items-center gap-2.5 max-sm:hidden">
            <Sep />
            <MachinesPill />
          </span>
        )}
        {/* the meters before the machine's first figures: their room kept, unseen, so the chips beside them do not move when they come */}
        {!load && !several.length && (
          <span aria-hidden className="invisible inline-flex shrink-0 items-center gap-2.5 max-sm:hidden">
            <Sep />
            <Meter label="GPU" value={0} />
            <Meter label="VRAM" value={0} />
            <Meter label="RAM" value={0} />
          </span>
        )}
        {gpu && (
          // every number keeps the room of three digits: what is beside it does not move when they change; they fade in
          // when the machine's figures first come. On a narrow window they leave the room to what runs (the Queue shows them)
          <span className="m-fade inline-flex shrink-0 items-center gap-2.5 max-sm:hidden">
            <Sep />
            {/* the CPU only while it is busy: otherwise its figure is in the GPU meter's tip */}
            {cpu !== undefined && cpu >= 70 && <Meter label="CPU" value={cpu} warn={cpu >= 90} className="max-[1440px]:hidden" />}
            {gpu.load !== undefined && <Meter label="GPU" value={gpu.load} fill={run ? "bg-accent" : undefined} tip={gpuTip(gpu, cpu)} />}
            {/* 90 %: little room left before a render spills out of VRAM */}
            <Meter label="VRAM" value={gpu.vramPercent} warn={gpu.vramPercent >= 90} />
            {ram && <Meter label="RAM" value={ram.percent} warn={ram.percent >= 90} tip={`System RAM: ${gb(ram.used)} of ${gb(ram.total)}. When VRAM is full, ComfyUI moves models here; when this fills too, everything slows down.`} />}
            {/* 80 °C: a temperature, the same for every card, not a figure of one card */}
            {gpu.temperature !== undefined && <span className={cx("shrink-0 font-mono whitespace-pre text-ink-2", gpu.temperature >= 80 && "text-warn-ink")}>{pad(gpu.temperature)}°</span>}
          </span>
        )}
        <Sep />
        {/* the command bar opened with the mouse: its own key, the one set in Settings › Command bar, drawn as the chip */}
        <button type="button" data-tip={`Command bar (${barKey})`} aria-label="Command bar" onClick={() => window.dispatchEvent(new CustomEvent("afflatus:bar", { detail: {} }))} className={cx(stripGhost, "shrink-0 px-1.5")}>
          <Keys keys={barKey} size="sm" />
        </button>
        <button type="button" data-tip="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts" onClick={() => window.dispatchEvent(new Event("afflatus:keys"))} className={cx(stripGhost, "shrink-0 px-1.5")}>
          <Keys keys="?" size="sm" />
        </button>
      </footer>
    </>
  );
}

/**
 * The GPU meter's tip: the card and its own figure first, then the CPU's, kept here while the CPU has no meter of its
 * own (it shows one only while busy). The CPU's figure alone read as the GPU's.
 */
export function gpuTip(gpu: { name: string; load?: number }, cpu: number | undefined): string {
  const figures = [gpu.load !== undefined && `GPU ${Math.round(gpu.load)} %`, cpu !== undefined && `CPU ${Math.round(cpu)} %`].filter(Boolean).join(" · ");
  return gpu.name ? `${gpu.name}: ${figures}` : figures;
}

/** A GPU figure: its name, a small bar and the number in %. The number is padded in a monospaced face, so the strip never moves as it changes. */
function Meter({ label, value, fill, warn, tip, className }: { label: string; value: number; fill?: string; warn?: boolean; tip?: string; className?: string }) {
  return (
    <span className={cx("inline-flex shrink-0 items-center gap-1.5 text-ink-2", warn && "text-warn-ink", className)} data-tip={tip}>
      {label}
      <Progress meter value={value / 100} className="h-1 w-[26px]" radius="rounded-[3px]" tone={warn ? "bg-warn" : (fill ?? "bg-ink-2")} />
      <span className="font-mono whitespace-pre">{pad(value)}<span className="opacity-70">%</span></span>
    </span>
  );
}

const JOIN_TIP = {
  seamless: "This clip continues the clip before's exact latent and is decoded as one piece with it: the join plays as a plain cut, the same as the whole chain decoded at once.",
  latent: "This clip continues the clip before's exact latent (decoded on its own: the join is faded).",
  hybrid: "This clip continues the clip before in the latent: its sound and run-up from its own latent, its picture guide from its re-encoded last frames (so a chain stays anchored to real pixels).",
  pixels: "This clip starts beside pinned frames of the clip before (that model has no latent to continue from, or Frames was asked for).",
} as const;
const JOIN_WORD = { seamless: "seamless", latent: "latent", hybrid: "frames + latent", pixels: "pixel" } as const;

/** A clip render's label ("Big Air · clip 2 · finish"): what it is ("Clip 2 · finish") and the timeline it is of. Any other job: its label whole. */
export function splitLabel(job: Pick<Job, "label" | "clipId">): { what: string; of: string | null } {
  const m = job.clipId ? /^(.*?) · (clip \d+.*)$/.exec(job.label) : null;
  return m ? { what: m[2]!.charAt(0).toUpperCase() + m[2]!.slice(1), of: m[1]! } : { what: job.label, of: null };
}

/** What renders: one pill, its progress the line along its bottom edge. A click opens the Queue. */
function Running({ run }: { run: RunningJob }) {
  const { what, of } = splitLabel(run);
  const pct = Math.round(run.progress * 100);
  const ran = elapsed(run.startedAt ? Math.max(0, Date.now() - Date.parse(run.startedAt)) : 0);
  const steps = run.steps ? `${String(run.step).padStart(String(run.steps).length, " ")}/${run.steps}` : null;
  const left = run.eta ? timeLeft(run.eta) : run.progress > 0 ? `${pad(pct)} %` : "working…";
  return (
    <>
      <Link
        href="/queue"
        className={cx(pill, "min-w-0 hover:bg-hover")}
        data-tip={`${run.progress > 0 ? `${pct} % of this render` : "No step count from this phase yet"}${run.eta ? ` · ${timeLeft(run.eta)}` : ""} · running for ${ran}`}
      >
        <span className="size-3 shrink-0 animate-spin rounded-full border-2 border-accent/30 border-t-accent motion-reduce:animate-none" />
        <span className="min-w-16 truncate font-semibold">{what}</span>
        {/* the first thing to go when the strip is short of room */}
        {of && <span className="max-w-48 min-w-0 truncate text-ink-2 max-[1440px]:hidden">{of}</span>}
        {run.join && <span className="shrink-0 rounded-[5px] bg-accent-wash px-1.5 py-px text-[10.5px] font-bold text-accent" data-tip={JOIN_TIP[run.join]}>{JOIN_WORD[run.join]}</span>}
        {/* the phase and the steps go on a narrow window, so that what renders keeps room for its name */}
        <span className="contents max-sm:hidden">
          <Sep />
          <span className="shrink-0 text-ink-2">{phaseLabel(run.phase)}</span>
          {steps && <span className="shrink-0 font-mono whitespace-pre">{steps}</span>}
        </span>
        <span className="shrink-0 font-mono whitespace-pre text-ink-2">· {left}</span>
        <Progress shape="edge" value={run.progress} steps={run.steps} loading={!run.progress} />
      </Link>
      {run.spilling && <span className="shrink-0 rounded-[5px] bg-warn-wash px-1.5 py-px font-semibold whitespace-nowrap text-warn-ink" data-tip="Out of video memory, it seems: much slower than usual. Stop it and run it again once nothing else holds the GPU's memory (a finish frees ComfyUI's models first), or give SeedVR2 a smaller batch size (Finish).">spilling out of VRAM</span>}
    </>
  );
}

/** ComfyUI does not answer: what waits, and a way to ask it again now. */
function Offline({ q }: { q: QueueStatus }) {
  const retry = useQueueOps().reconnect;
  return (
    <span className={cx(pill, "shrink-0 bg-warn-wash text-warn-ink")} data-tip={`ComfyUI has not answered for ${elapsed(q.offlineForMs)}: queued jobs wait for it. Its address is in Settings › ComfyUI.`}>
      <span className={cx(dot, "bg-warn")} />
      <span className="font-semibold">ComfyUI offline</span>
      {q.waiting.length > 0 && <span className="opacity-80">· {q.waiting.length} waiting</span>}
      <button type="button" className="font-bold underline disabled:opacity-60" disabled={retry.isPending} onClick={() => retry.mutate()} data-tip="Ask ComfyUI again now">
        {retry.isPending ? "Retrying…" : "Retry"}
      </button>
    </span>
  );
}

/** The queue is paused: what waits, and the Queue screen's Resume. */
function Paused({ waiting }: { waiting: number }) {
  const resume = useQueueOps().resume;
  return (
    <span className={cx(pill, "shrink-0")} data-tip="Paused. The running render finishes, then nothing new goes to ComfyUI until you resume.">
      <span className={cx(dot, "bg-warn")} />
      <span className="font-semibold">Queue paused</span>
      {waiting > 0 && <span className="text-ink-2">· {waiting} waiting</span>}
      <button type="button" className="font-bold text-accent hover:underline disabled:opacity-60" disabled={resume.isPending} onClick={() => resume.mutate()} data-tip="Send what waits to ComfyUI again">Resume</button>
    </span>
  );
}

/**
 * Nothing renders: said so, with the last thing that finished (opened in the viewer when it made something still in the
 * library). A ComfyUI running work queued from outside Afflatus (its own page) is not idle: that is said instead, with the
 * work (one ComfyUI) or the machines (several).
 */
/**
 * No machine can take work (noGpuYet): what waits, and Deploy a GPU at hand. Without a RunPod key, the Queue, where the key
 * is asked beside the waiting job; a ComfyUI of the user's own is added in Settings › ComfyUI.
 */
function NoGpu({ waiting, hasKey }: { waiting: number; hasKey: boolean }) {
  return (
    <span className="inline-flex h-7 min-w-0 items-center gap-1.5 pl-0.5 text-ink-2" data-tip="No ComfyUI of your own is added and no rented GPU is up: jobs wait here until one is. Your ComfyUI goes in Settings › ComfyUI.">
      <span className={cx(dot, "bg-ink-3")} />
      <span className="shrink-0">{waiting ? `${waiting} waiting for a GPU` : "Idle"}</span>
      {!waiting && <span className="truncate text-ink-3">· no GPU yet · jobs wait for one</span>}
      {hasKey ? (
        <button type="button" className="ml-1 shrink-0 font-semibold text-accent hover:underline" onClick={() => openDeploy()}>Deploy a GPU…</button>
      ) : (
        <Link href="/queue" className="ml-1 shrink-0 font-semibold text-accent hover:underline">Deploy a GPU…</Link>
      )}
    </span>
  );
}

function Idle({ last, machines }: { last: Job | null; machines: MachineState[] }) {
  const outside = machines.filter((m) => !m.running && !m.paused && m.online !== false && busyOutside(m));
  const [, go] = useLocation();
  const [open, setOpen] = useState<string | null>(null);
  const asset = useAsset(open);
  // what it made is not in the queue's figures: asked for on the click alone
  const show = useMutation({
    mutationFn: async (job: Job) => (await api.jobs({ status: "done", limit: 10 })).items.find((j) => j.id === job.id)?.made.find((m) => !m.inBin)?.id ?? null,
    onSuccess: (id) => (id ? setOpen(id) : go("/queue")),
    onError: () => go("/queue"),
  });
  let said: ReactNode = null;
  if (last) {
    const { what, of } = splitLabel(last);
    said = (
      <button type="button" className={cx(stripGhost, "min-w-0")} disabled={show.isPending} onClick={() => show.mutate(last)} data-tip="Open the last finished render">
        <span className="shrink-0">last:</span>
        <span className="min-w-0 truncate font-semibold text-ink">{of ? `${of} · ${what}` : what}</span>
        {last.finishedAt && <span className="shrink-0">· finished {when(last.finishedAt)}</span>}
      </button>
    );
  }
  return (
    <>
      {outside.length ? (
        <span className="inline-flex h-7 min-w-0 items-center gap-1.5 pl-0.5 text-ink-2" data-tip={OUTSIDE_TIP}>
          <span className={cx(dot, "border-[1.5px] border-accent bg-accent-wash")} />
          <span className="shrink-0">Busy outside Afflatus</span>
          <span className="truncate">· {machines.length > 1 ? outside.map(machineLabel).join(", ") : outsideSaid(outside[0]!)}</span>
        </span>
      ) : (
        <span className="inline-flex h-7 shrink-0 items-center gap-1.5 pl-0.5 text-ink-2">
          <span className={cx(dot, "bg-ink-3")} />
          Idle
        </span>
      )}
      {said}
      {asset.data && <Suspense fallback={null}><Viewer asset={asset.data} onClose={() => setOpen(null)} /></Suspense>}
    </>
  );
}

/**
 * The renders of the project that nobody kept, which go to the bin by themselves: how many and when the next goes
 * ("23 expiring · 3 h"), in the warning colour when it goes within the hour; nothing when there are none. Its panel
 * says when the last goes, shows only them in the library, or keeps them all.
 */
function Expiring() {
  const sum = useExpiring().data;
  // (read here so that a change in Settings › Storage shows at once: "never" leaves nothing expiring)
  const keepFor = useKeepFor();
  const project = useProject((s) => s.id);
  const projects = useProjects();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const { keep, keepAll } = useKeepAllExpiring(() => setOpen(false));
  // its right-click menu: the panel's two actions without the panel
  const menu = useMenu<true>();
  const [, go] = useLocation();
  const count = sum?.count ?? 0;
  const said = sum ? expiringSaid(sum, Date.now(), unkeptMs(keepFor.unkeptDays)) : null;
  if (!count || !said) return null;
  const where = project === null ? "the library" : project === "none" ? "the Inbox" : (projects.data?.items.find((p) => p.id === project)?.name ?? "this project");
  const show = () => {
    // the whole project's media, as the count is: not one folder's, nor the timelines
    useExpiringOnly.getState().set(true);
    useStudio.getState().set({ place: { type: "all" } });
    setOpen(false);
    go("/");
  };
  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-tip={`${count} renders nobody kept go to the bin by themselves, the next in ${said.next}`}
        onClick={() => setOpen(!open)}
        onContextMenu={(e) => { setOpen(false); menu.open(e, true); }}
        // it comes after the rest of the strip (its count is a query of its own): it fades in rather than pops
        className={cx(
          "m-fade inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs whitespace-nowrap transition-colors hover:brightness-125",
          said.soon ? "bg-warn-wash text-warn-ink" : "bg-hover text-ink-2",
          open && "ring-1 ring-accent",
        )}
      >
        <Clock size={12} aria-hidden className="shrink-0" />
        <span className={cx("font-semibold", !said.soon && "text-ink")}>{count} expiring</span>
        <span>· {said.next}</span>
      </button>
      {(open || menu.menu) && (
        <Suspense fallback={null}>
          <ExpiringPanel
            anchor={anchor} open={open} menuAt={menu.menu?.at ?? null} count={count} said={said} where={where} keepFor={keepFor} keep={keep}
            onShow={show} onKeepAll={() => void keepAll(count)} onClose={() => setOpen(false)} onMenuClose={menu.close}
          />
        </Suspense>
      )}
    </>
  );
}
