import { lazy, Suspense, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import type { ReactNode } from "react";
import { Link, Redirect, Route, Switch, useLocation } from "wouter";
import { Film, LayoutGrid, ListOrdered, Settings2, Users, Workflow } from "lucide-react";
import { useQueue } from "./data";
import { Banners } from "./Banners";
import { useSearchKey } from "./Keys";
import { TabProgress } from "./TabProgress";
import { DropTray } from "./DropTray";
import { useDownloads } from "./GetFile";
import { about, elapsed, phaseLabel } from "./format";
import { useLiveEvents } from "./live";
import { Studio } from "./screens/Studio";
import { ConfirmHost } from "./Confirm";
import { ErrorBoundary } from "./ErrorBoundary";
import { FolderImportNote } from "./folderImport";
import { useSystem, useBanners } from "./store";
import { BarHost } from "./bar/BarHost";
import { Tips } from "./Tip";

// every screen but the Studio is a chunk of its own, fetched the first time its address is opened
const People = lazy(() => import("./screens/People").then((m) => ({ default: m.People })));
const Queue = lazy(() => import("./screens/Queue").then((m) => ({ default: m.Queue })));
const Setup = lazy(() => import("./screens/Setup").then((m) => ({ default: m.Setup })));
const TimelineEditor = lazy(() => import("./screens/TimelineEditor").then((m) => ({ default: m.TimelineEditor })));
const Workflows = lazy(() => import("./screens/Workflows").then((m) => ({ default: m.Workflows })));
// the list of keys too: it is fetched with the page, but not in its first chunk
const KeysHelp = lazy(() => import("./KeysHelp").then((m) => ({ default: m.KeysHelp })));
import { StripModel, StripPlace } from "./ModelLoad";
import { ProjectSwitch } from "./Projects";
import { ThemeFlip } from "./theme/Appearance";
import { useTheme } from "./theme/store";
import { Bar, cx } from "./ui";

const NAV: Array<{ href: string; label: string; icon: ReactNode }> = [
  { href: "/", label: "Studio", icon: <LayoutGrid size={18} /> },
  { href: "/timelines", label: "Timelines", icon: <Film size={18} /> },
  { href: "/kit", label: "Prompt kit", icon: <Users size={18} /> },
  { href: "/workflows", label: "Workflows", icon: <Workflow size={18} /> },
  { href: "/queue", label: "Queue", icon: <ListOrdered size={18} /> },
  { href: "/settings", label: "Settings", icon: <Settings2 size={18} /> },
];

/** A number of the strip in the room of three digits. */
const pad = (n: number) => String(Math.round(n)).padStart(3, " ");

/** The strip at the bottom of every screen: what is rendering, and how the GPU is doing. */
function Strip() {
  const queue = useQueue();
  const load = useSystem((s) => s.load);
  const gpu = load?.gpus[0];
  const run = queue.data?.running;
  // how long the render has been going: a clock that ticks while something runs
  const [, tick] = useState(0);
  useEffect(() => {
    if (!run) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [run?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const elapsedMs = run?.startedAt ? Math.max(0, Date.now() - Date.parse(run.startedAt)) : 0;
  // a model being fetched into ComfyUI goes on whatever screen is open: it is said here, with the way to it
  const fetching = (useDownloads().data?.items ?? []).filter((d) => d.status === "starting" || d.status === "downloading" || d.status === "saving");
  return (
    <footer className="flex h-10 shrink-0 items-center gap-3.5 border-t border-line bg-panel px-4 text-xs">
      <span className={cx("h-2 w-2 rounded-full", run ? "bg-accent" : queue.data?.online === false ? "bg-warn" : "bg-ink-3")} />
      {run ? (
        <>
          <span className="font-semibold">{run.label}</span>
          {run.join && <span className="rounded bg-accent-wash px-1.5 py-px text-[10px] font-semibold text-accent" data-tip={run.join === "seamless" ? "This clip continues the clip before's exact latent and is decoded as one piece with it: the join plays as a plain cut, the same as the whole chain decoded at once." : run.join === "latent" ? "This clip continues the clip before's exact latent (decoded on its own: the join is faded)." : run.join === "hybrid" ? "This clip continues the clip before in the latent: its sound and run-up from its own latent, its picture guide from its re-encoded last frames (so a chain stays anchored to real pixels)." : "This clip starts beside pinned frames of the clip before (that model has no latent to continue from, or Frames was asked for)."}>{run.join === "seamless" ? "seamless join" : run.join === "latent" ? "latent join" : run.join === "hybrid" ? "frames + latent join" : "pixel join"}</span>}
          <span className="text-ink-2">{phaseLabel(run.phase)}{run.steps ? ` · step ${run.step} of ${run.steps}` : ""}</span>
          {run.spilling && <span className="font-semibold text-warn-ink" data-tip="Out of video memory, it seems: much slower than usual. Stop it and run it again once nothing else holds the GPU's memory (a finish frees ComfyUI's models first), or ask SeedVR2 for fewer frames together.">spilling out of VRAM · much slower</span>}
          <span className="font-mono text-ink-2" data-tip="How long this render has been running">{elapsed(elapsedMs)}</span>
          <span className="text-ink-2">{run.eta ? about(run.eta) : run.progress > 0 ? `${Math.round(run.progress * 100)} %` : "working…"}</span>
          <span className={cx("w-44", !run.progress && "animate-pulse")} data-tip={run.progress > 0 ? `${Math.round(run.progress * 100)} % of this render` : "No step count from this phase yet"}><Bar value={run.progress * 100} /></span>
        </>
      ) : (
        <span className="text-ink-2">
          {queue.data?.online === false ? "ComfyUI offline" : queue.data?.paused ? "Queue paused" : "Idle"}
        </span>
      )}
      {queue.data && queue.data.waiting.length > 0 && <span className="shrink-0 text-ink-2">{queue.data.waiting.length} queued</span>}
      <span className="grow" />
      {fetching.length > 0 && (
        <Link href="/settings/models" className="flex items-center gap-2 text-ink-2 hover:text-ink" data-tip="A model file is being downloaded into ComfyUI. It goes on if this page is closed. Open Settings to see it or cancel it.">
          {fetching.length === 1 ? `Downloading ${fetching[0]!.file.split(/[\\/]/).pop()}` : `Downloading ${fetching.length} files`}
          {fetching.length === 1 && fetching[0]!.total > 0 && ` · ${Math.floor((fetching[0]!.bytes / fetching[0]!.total) * 100)}%`}
        </Link>
      )}
      <StripPlace />
      <StripModel />
      {gpu && (
        // every number keeps the room of three digits: what is beside it does not move when they change
        <span className="shrink-0 font-mono whitespace-pre text-ink-2">
          {gpu.load !== undefined && `GPU ${pad(gpu.load)}% · `}VRAM {pad(gpu.vramPercent)}%
          {/* 80 °C: a temperature, the same for every card, not a figure of one card */}
          {gpu.temperature !== undefined && <> · <span className={cx(gpu.temperature >= 80 && "text-warn-ink")}>{Math.round(gpu.temperature)}°</span></>}
        </span>
      )}
      <button type="button" data-tip="Keyboard shortcuts" onClick={() => window.dispatchEvent(new Event("afflatus:keys"))} className="inline-flex h-7 items-center rounded-md px-2 text-ink-2 hover:text-ink">Shortcuts <span className="ml-1.5 rounded border border-line-strong px-1 font-mono text-[10px]">?</span></button>
    </footer>
  );
}


/** A tool Afflatus needs is missing on the computer it runs on: said once per browser session, with the way to Settings → About. */
function useMissingTools() {
  const health = useQuery({ queryKey: ["health"], queryFn: () => api.health(), staleTime: Infinity });
  const push = useBanners((s) => s.push);
  useEffect(() => {
    for (const c of health.data?.checks ?? []) {
      if (c.ok) continue;
      const key = `afflatus.check.${c.id}`;
      try {
        if (sessionStorage.getItem(key)) continue;
        sessionStorage.setItem(key, "1");
      } catch {
        // no session storage: said every time
      }
      push({ id: `check-${c.id}`, tone: "bad", title: `${c.label}: ${c.detail}`, text: `${c.without} ${c.fix}`, href: "/settings/about", go: "Open About in Settings" });
    }
  }, [health.data, push]);
}

export function App() {
  useLiveEvents();
  useSearchKey();
  useTheme();
  const [path] = useLocation();
  useMissingTools();
  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 grow">
        <nav aria-label="Main" className="flex w-[76px] shrink-0 flex-col items-center gap-1 border-r border-line bg-panel py-3">
          <div className="flex h-9 items-center text-[15px] font-bold tracking-tight">Afflatus</div>
          <ProjectSwitch />
          {NAV.map((n) => {
            const on = n.href === "/" ? path === "/" : path.startsWith(n.href);
            return (
              <Link
                key={n.href}
                href={n.href}
                aria-current={on ? "page" : undefined}
                className={cx("flex h-14 w-16 flex-col items-center justify-center gap-1 rounded-[10px] text-[11px] font-semibold", on ? "bg-hover text-ink-strong" : "text-ink-2 hover:text-ink")}
              >
                {n.icon}
                {n.label}
              </Link>
            );
          })}
          <span className="grow" />
          <ThemeFlip />
        </nav>
        <Suspense fallback={<div className="grow p-8 text-ink-2">Loading…</div>}>
        {/* a screen that fails takes only itself down; going to another screen starts afresh */}
        <ErrorBoundary key={path.split("/")[1]}>
        <Switch>
          <Route path="/"><Studio key="studio" /></Route>
          {/* links from elsewhere that mean "the form": the same screen, with the form open */}
          <Route path="/create"><Studio open /></Route>
          <Route path="/kit" component={People} />
          {/* the screen's old address still leads to it */}
          <Route path="/people"><Redirect to="/kit" /></Route>
          {/* the rail's Timelines entry: the Studio, on the timelines of the place it looks at */}
          <Route path="/timelines"><Studio key="timelines" timelines /></Route>
          <Route path="/timelines/:id" component={TimelineEditor} />
          <Route path="/workflows" component={Workflows} />
          <Route path="/queue" component={Queue} />
          <Route path="/settings" component={Setup} />
          <Route path="/settings/:tab" component={Setup} />
          {/* the screen's old address still leads to it */}
          <Route path="/setup"><Redirect to="/settings" /></Route>
          <Route>
            <div className="p-8 text-ink-2">Page not found. <Link href="/" className="underline">Open the Studio</Link></div>
          </Route>
        </Switch>
        </ErrorBoundary>
        </Suspense>
      </div>
      <Strip />
      <DropTray />
      <Banners />
      <FolderImportNote />
      <BarHost />
      <ConfirmHost />
      <Suspense fallback={null}><KeysHelp /></Suspense>
      <TabProgress />
      <Tips />
    </div>
  );
}
