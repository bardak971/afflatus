import { lazy, Suspense, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { Link, Redirect, Route, Switch, useLocation } from "wouter";
import { Banners } from "./Banners";
import { useSearchKey } from "./Keys";
import { TabProgress } from "./TabProgress";
import { DropTray } from "./DropTray";
import { useLiveEvents } from "./live";
import { Studio } from "./screens/Studio";
import { ConfirmHost } from "./Confirm";
import { ErrorBoundary } from "./ErrorBoundary";
import { FolderImportNote } from "./folderImport";
import { useBanners } from "./store";
import { BarHost } from "./bar/BarHost";
import { StatusBar } from "./StatusBar";
import { Tips } from "./Tip";
import { loadPeople, loadQueue, loadSetup, loadTimelineEditor, loadWorkflows, lazyPart, prefetchWhenIdle } from "./lazyParts";

// every screen but the Studio is a chunk of its own, fetched once the page is idle (lazyParts.ts), or the first time
// its address is opened before that
const People = lazyPart(loadPeople, (m) => m.People);
const Queue = lazyPart(loadQueue, (m) => m.Queue);
const Setup = lazyPart(loadSetup, (m) => m.Setup);
const TimelineEditor = lazyPart(loadTimelineEditor, (m) => m.TimelineEditor);
const Workflows = lazyPart(loadWorkflows, (m) => m.Workflows);
const WorkflowEdit = lazyPart(loadWorkflows, (m) => m.WorkflowEdit);
const WorkflowImport = lazyPart(loadWorkflows, (m) => m.WorkflowImport);
// the list of keys too: it is fetched with the page, but not in its first chunk
const KeysHelp = lazy(() => import("./KeysHelp").then((m) => ({ default: m.KeysHelp })));
import { NavRail } from "./NavRail";
import { EditorSkeleton } from "./timeline/EditorSkeleton";
import { WorkflowEditorSkeleton } from "./screens/workflowEditor/EditorSkeleton";
import { useTheme } from "./theme/store";

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
  useEffect(prefetchWhenIdle, []);
  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 grow">
        <NavRail />
        {/* while a screen's code loads: an editor's own shape for the timeline and workflow editors (they then land in place), else a line */}
        <Suspense fallback={/^\/timelines\/[^/]+/.test(path) ? <EditorSkeleton id={path.split("/")[2]} /> : /^\/workflows\/[^/]+/.test(path) ? <WorkflowEditorSkeleton /> : <div className="grow p-8 text-ink-2">Loading…</div>}>
        {/* a screen that fails takes only itself down; going to another screen starts afresh ("/create" and "/timelines" are
            the Studio's own addresses, with its form open or its timelines shown: the same screen; a timeline's editor is not) */}
        <ErrorBoundary key={path === "/create" || path === "/timelines" ? "" : path.split("/")[1]}>
        <Switch>
          <Route path="/"><Studio key="studio" /></Route>
          {/* the Studio with its form open: the same screen (the same key, so opening the form keeps what is on it), the address following the form */}
          <Route path="/create"><Studio key="studio" open /></Route>
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
        </Suspense>
      </div>
      <StatusBar />
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
