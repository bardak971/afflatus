import { lazy, Suspense, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { Link, Redirect, Route, Switch, useLocation } from "wouter";
import { Banners } from "./Banners";
import { useSearchKey } from "./Keys";
import { TabProgress } from "./TabProgress";
import { DropTray } from "./DropTray";
import { useLiveEvents } from "./live";
import { Studio } from "./screens/Studio";
import { ConfirmHost } from "./Confirm";
import { DeployHost } from "./deploy";
import { FindModelsHost } from "./findModels/Host";
import { UpdateNews } from "./UpdateNews";
import { ErrorBoundary, screenKey } from "./ErrorBoundary";
import { FolderImportNote } from "./folderImport";
import { useBanners } from "./store";
import { BarHost } from "./bar/BarHost";
import { StatusBar } from "./StatusBar";
import { Tips } from "./Tip";
import { loadPeople, loadQueue, loadSetup, loadTimelineEditor, loadWorkflows, lazyPart, prefetchWhenIdle } from "./lazyParts";

// every screen but the Studio is a chunk of its own, fetched as a link to it is pointed at, once the first screen is in
// (lazyParts.ts), or the first time its address is opened before that
const People = lazyPart(loadPeople, (m) => m.People);
const Queue = lazyPart(loadQueue, (m) => m.Queue);
const Setup = lazyPart(loadSetup, (m) => m.Setup);
const TimelineEditor = lazyPart(loadTimelineEditor, (m) => m.TimelineEditor);
const Workflows = lazyPart(loadWorkflows, (m) => m.Workflows);
const WorkflowEdit = lazyPart(loadWorkflows, (m) => m.WorkflowEdit);
const WorkflowImport = lazyPart(loadWorkflows, (m) => m.WorkflowImport);
// the list of keys too: it is fetched with the page, but not in its first chunk
const KeysHelp = lazy(() => import("./KeysHelp").then((m) => ({ default: m.KeysHelp })));
const FirstLaunch = lazy(() => import("./screens/FirstLaunch").then((m) => ({ default: m.FirstLaunch })));
import { NavRail } from "./NavRail";
import { EditorSkeleton } from "./timeline/EditorSkeleton";
import { WorkflowEditorSkeleton } from "./screens/workflowEditor/EditorSkeleton";
import { useTheme } from "./theme/store";
import { useKeepForSync } from "./keepFor";
import { queryKeys } from "./queryKeys";
import { useSettings } from "./data";
import { failedBanner } from "./sayFailed";
import { ELSEWHERE } from "./GetFfmpeg";

/** Where the banners of the start-up checks lead. */
const ABOUT = { id: "ffmpeg-get", href: "/settings/about", go: "Open About in Settings" };

/**
 * A tool Afflatus needs is missing on the computer it runs on: said once per browser session, with the way to Settings → About
 * (and Get ffmpeg's button when it can download one). Another ffmpeg than the PATH's used in its place is said too, once.
 */
export function useMissingTools() {
  const health = useQuery({ queryKey: queryKeys.health(), queryFn: () => api.health(), staleTime: Infinity });
  const push = useBanners((s) => s.push);
  const client = useQueryClient();
  useEffect(() => {
    for (const c of health.data?.checks ?? []) {
      if (c.ok && !c.note) continue;
      const key = `afflatus.check.${c.id}${c.ok ? ".note" : ""}`;
      try {
        if (sessionStorage.getItem(key)) continue;
        sessionStorage.setItem(key, "1");
      } catch {
        // no session storage: said every time
      }
      if (c.ok) {
        push({ id: `check-${c.id}`, tone: "good", title: `${c.label}: ${c.detail}`, text: c.note, href: "/settings/about", go: "Open About in Settings" });
        continue;
      }
      // started here, followed in About, where the banner leads; from another computer, where it is refused, only said
      const elsewhere = c.get === "download" && health.data?.here === false;
      const get = c.get === "download" && !elsewhere ? { label: "Get ffmpeg", run: () => void api.getFfmpeg().then((v) => client.setQueryData(queryKeys.ffmpegGet(), v), (err) => push(failedBanner(ABOUT, "Get ffmpeg did not start", err))) } : undefined;
      push({ id: `check-${c.id}`, tone: "bad", title: `${c.label}: ${c.detail}`, text: `${c.without} ${c.fix}${elsewhere ? ` ${ELSEWHERE}` : ""}`, href: "/settings/about", go: "Open About in Settings", ...(get ? { action: get } : {}) });
    }
  }, [health.data, push, client]);
}

/** The Studio's own addresses: where the first launch's page stands in for it. */
const studioPath = (path: string) => path === "/" || path === "/create";

/**
 * A new install's first launch (FirstLaunch.tsx): its page in the Studio's place until it is done or skipped, the rail kept.
 * Leaving it by the rail counts as Skip: it is never shown again unasked (Settings › ComfyUI brings it back).
 */
function useFirstLaunch(path: string): { shows: boolean } {
  const settings = useSettings();
  const client = useQueryClient();
  const pending = settings.data?.firstLaunch === "pending";
  const shows = pending && studioPath(path);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (shows) setSeen(true);
  }, [shows]);
  const end = () => void api.saveSettings({ firstLaunch: "done" }).then((saved) => client.setQueryData(queryKeys.settings(), saved), () => {});
  useEffect(() => {
    if (seen && pending && !studioPath(path)) end();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, as the page is left
  }, [seen, pending, path]);
  return { shows };
}

/**
 * The screens, by address, in one error boundary: a screen that fails takes only itself down, and the boundary is keyed by
 * the screen (screenKey), so going to another screen, or to another timeline or workflow in the same editor, starts afresh.
 * @internal exported for the test, which draws these routes and this key rather than a copy of them
 */
export function Screens({ path, firstLaunch }: { path: string; firstLaunch: boolean }) {
  return (
    <ErrorBoundary key={screenKey(path)}>
      <Switch>
        <Route path="/">{firstLaunch ? <FirstLaunch /> : <Studio key="studio" />}</Route>
        {/* the Studio with its form open: the same screen (the same key, so opening the form keeps what is on it), the address following the form */}
        <Route path="/create">{firstLaunch ? <FirstLaunch /> : <Studio key="studio" open />}</Route>
        <Route path="/kit" component={People} />
        {/* the screen's old address still leads to it */}
        <Route path="/people"><Redirect to="/kit" /></Route>
        {/* the rail's Timelines entry: the Studio, on the timelines of the place it looks at */}
        {/* the same Studio as / and /create (one key): Media / Timelines is a switch inside it, so its highlight travels and nothing is drawn afresh */}
        <Route path="/timelines"><Studio key="studio" timelines /></Route>
        <Route path="/timelines/:id" component={TimelineEditor} />
        <Route path="/workflows" component={Workflows} />
        {/* the workflow editor: a saved workflow by its id, a fresh import (no id until it is saved) held in memory */}
        <Route path="/workflows/:id/edit" component={WorkflowEdit} />
        <Route path="/workflows/new" component={WorkflowImport} />
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
  );
}

export function App() {
  useLiveEvents();
  useSearchKey();
  useTheme();
  useKeepForSync();
  const [path] = useLocation();
  useMissingTools();
  useEffect(prefetchWhenIdle, []);
  const first = useFirstLaunch(path);
  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 grow">
        <NavRail />
        {/* while a screen's code loads: an editor's own shape for the timeline and workflow editors (they then land in place), else a line */}
        <Suspense fallback={/^\/timelines\/[^/]+/.test(path) ? <EditorSkeleton id={path.split("/")[2]} /> : /^\/workflows\/[^/]+/.test(path) ? <WorkflowEditorSkeleton /> : <div className="grow p-8 text-ink-2">Loading…</div>}>
        <Screens path={path} firstLaunch={first.shows} />
        </Suspense>
      </div>
      <StatusBar />
      <DropTray />
      <Banners />
      <FolderImportNote />
      <BarHost />
      <UpdateNews />
      <ConfirmHost />
      <DeployHost />
      <FindModelsHost />
      <Suspense fallback={null}><KeysHelp /></Suspense>
      <TabProgress />
      <Tips />
    </div>
  );
}
