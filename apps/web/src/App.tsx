import type { ReactNode } from "react";
import { Link, Redirect, Route, Switch, useLocation } from "wouter";
import { Film, LayoutGrid, ListOrdered, Plus, Settings2, Users, Workflow } from "lucide-react";
import { useQueue } from "./data";
import { Banners } from "./Banners";
import { KeysHelp } from "./Keys";
import { TabProgress } from "./TabProgress";
import { DropTray } from "./DropTray";
import { useDownloads } from "./GetFile";
import { about, phaseLabel } from "./format";
import { useLiveEvents } from "./live";
import { Studio } from "./screens/Studio";
import { ConfirmHost } from "./Confirm";
import { FolderImportNote } from "./folderImport";
import { People } from "./screens/People";
import { Queue } from "./screens/Queue";
import { Setup } from "./screens/Setup";
import { TimelineEditor } from "./screens/TimelineEditor";
import { Timelines } from "./screens/Timelines";
import { Workflows } from "./screens/Workflows";
import { useSystem } from "./store";
import { StripModel, StripPlace } from "./ModelLoad";
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
  // a model being fetched into ComfyUI goes on whatever screen is open: it is said here, with the way to it
  const fetching = (useDownloads().data?.items ?? []).filter((d) => d.status === "starting" || d.status === "downloading" || d.status === "saving");
  return (
    <footer className="flex h-10 shrink-0 items-center gap-3.5 border-t border-line bg-panel px-4 text-xs">
      <span className={cx("h-2 w-2 rounded-full", run ? "bg-accent" : queue.data?.online === false ? "bg-warn" : "bg-ink-3")} />
      {run ? (
        <>
          <span className="font-semibold">{run.label}</span>
          <span className="text-ink-2">{phaseLabel(run.phase)}{run.steps ? ` · step ${run.step} of ${run.steps}` : ""}{run.eta ? ` · ${about(run.eta)}` : ""}</span>
          <span className="w-44"><Bar value={run.progress * 100} /></span>
        </>
      ) : (
        <span className="text-ink-2">
          {queue.data?.online === false ? "ComfyUI offline" : queue.data?.paused ? "Queue paused" : "Idle"}
        </span>
      )}
      {queue.data && queue.data.waiting.length > 0 && <span className="shrink-0 text-ink-2">{queue.data.waiting.length} queued</span>}
      <span className="grow" />
      {fetching.length > 0 && (
        <Link href="/settings" className="flex items-center gap-2 text-ink-2 hover:text-ink" title="A model file is being downloaded into ComfyUI. It goes on if this page is closed. Open Settings to see it or cancel it.">
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
          {gpu.temperature !== undefined && <> · <span className={cx(gpu.temperature >= 80 && "text-warn-ink")}>{Math.round(gpu.temperature)}°</span></>}
        </span>
      )}
      <button type="button" title="Keyboard shortcuts" onClick={() => window.dispatchEvent(new Event("studai:keys"))} className="inline-flex h-7 items-center rounded-md px-2 text-ink-2 hover:text-ink">Shortcuts <span className="ml-1.5 rounded border border-line-strong px-1 font-mono text-[10px]">?</span></button>
      <Link href="/queue" className="inline-flex h-7 items-center rounded-md border border-line-strong px-2.5 font-semibold">Open queue</Link>
    </footer>
  );
}

export function App() {
  useLiveEvents();
  useTheme();
  const [path] = useLocation();
  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 grow">
        <nav aria-label="Main" className="flex w-[76px] shrink-0 flex-col items-center gap-1 border-r border-line bg-panel py-3">
          <div className="flex h-9 items-center text-[15px] font-bold tracking-tight">studai</div>
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
        <Switch>
          <Route path="/"><Studio /></Route>
          {/* links from elsewhere that mean "the form": the same screen, with the form open */}
          <Route path="/create"><Studio open /></Route>
          <Route path="/kit" component={People} />
          {/* the screen's old address still leads to it */}
          <Route path="/people"><Redirect to="/kit" /></Route>
          <Route path="/timelines" component={Timelines} />
          <Route path="/timelines/:id" component={TimelineEditor} />
          <Route path="/workflows" component={Workflows} />
          <Route path="/queue" component={Queue} />
          <Route path="/settings" component={Setup} />
          {/* the screen's old address still leads to it */}
          <Route path="/setup"><Redirect to="/settings" /></Route>
          <Route>
            <div className="p-8 text-ink-2">Page not found. <Link href="/" className="underline">Back to Studio</Link></div>
          </Route>
        </Switch>
      </div>
      <Strip />
      <DropTray />
      <Banners />
      <FolderImportNote />
      <ConfirmHost />
      <KeysHelp />
      <TabProgress />
    </div>
  );
}
