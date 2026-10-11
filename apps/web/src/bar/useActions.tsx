import { lazy, Suspense, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { ArrowUpToLine, Copy, Keyboard, Navigation, RotateCcw, Settings2, Square } from "lucide-react";
import { useOpenInComfy } from "../actions";
import { api, type Asset, type CommandEntry } from "../api";
import { useAsset, useEntities, useModelSettings, useProjects, useRecipes, useSetup, useStorage } from "../data";
import { itemsWord } from "../assetCache";
import { useOpenNewDraft } from "../draft";
import { FolderPicker } from "../FolderPicker";
import { useFormTarget } from "../formTarget";
import { plural, size } from "../format";
import { useProject } from "../project";
import { useQueueOps } from "../queueOps";
import type { Target } from "../projects/tree";
import { useTreeActions } from "../projects/useTreeActions";
import { useKindActions } from "../projects/useKindActions";
import { usePins } from "../projects/pins";
import { useQueueBulk } from "../screens/queue/bulk";
import { useJobActions } from "../screens/queue/jobActions";
import { atTop } from "../screens/queue/order";
import { settingHref } from "../screens/settings/settingsIndex";
import { useQueueOf } from "../screens/studio/queueOf";
import { useSayFailed } from "../sayFailed";
import { copyText } from "../secureContext";
import { useBanners, useHandover, useOpenDraft, useStudio } from "../store";
import { openKeys } from "../keys/search";
import { NO_ASSET, useItemActions } from "../useItemActions";
import { formWhenOpen, openProjects, useSelectedClip, useTimelineRequest, type TimelineRequest } from "./bridge";
import type { Item } from "./items";
import { pageLabel, type SettingCtx } from "./settingsRegistry";
import { commandActions } from "./actions/commands";
import type { Action, BarCtx, FolderEntry, RenderTimeline, TimelineAim, TimelineEntry } from "./actions/ctx";
import { historyActions, kitActions, personActions } from "./actions/kit";
import { jobActions } from "./actions/queue";
import { renderActions } from "./actions/renders";
import { draftActions, folderActions, projectActions, timelineActions, workflowActions } from "./actions/tree";
import { queryKeys } from "../queryKeys";

const Viewer = lazy(() => import("../Viewer").then((m) => ({ default: m.Viewer })));

/**
 * What each kind of result can have done, made of what the app already does: the viewer's own actions for a render,
 * the Projects panel's actions for projects, folders, timelines and drafts, the queue's own calls, the timeline editor's
 * and the Workflows screen's buttons (through bridge.ts), the Prompt kit's calls and the open form. The bar adds no
 * behaviour of its own. The hooks are read here; each kind's actions are in actions/ (commands, renders, tree, queue, kit).
 */
export function useBarActions({ subject, aim, settingCtx, onCopied }: {
  /** The render that is selected, read in full (its generation): the viewer's actions are for it. */
  subject: Asset | null;
  aim: TimelineAim | null;
  settingCtx: SettingCtx;
  onCopied(text: string): void;
}) {
  const [, go] = useLocation();
  const client = useQueryClient();
  const say = useBanners((b) => b.push);
  const tree = useTreeActions();
  const allProjects = useProjects().data?.items ?? [];
  const pins = usePins();
  // what the queue rows need of the queue: not its progress, which changes at every step
  const queue = useQueueOf((q) => ({
    paused: q.paused, online: q.online, rendering: q.running?.kind === "render", running: Boolean(q.running),
    waiting: q.waiting.map((w) => ({ id: w.id })), failed: q.recent.filter((j) => j.status === "failed").map((j) => j.id),
  }));
  const bulk = useQueueBulk();
  const ops = useQueueOps();
  const jobs = useJobActions();
  const setup = useSetup();
  // what the bin holds, as its strip says it: "3 items · 12 MB"
  const bin = useStorage().data?.bin;
  const recipes = useRecipes().data?.recipes ?? [];
  const entities = useEntities().data?.items ?? [];
  const modelSettings = useModelSettings();
  const openNew = useOpenNewDraft();
  const selectedClip = useSelectedClip((c) => c.clip);
  const draftOpen = useOpenDraft((d) => Boolean(d.id));
  const [viewing, setViewing] = useState<Asset | null>(null);

  // the selected render's actions are the item's list (itemActions.tsx), worked out for it alone (for nothing while
  // none is selected); Trim and Details open the viewer with them, what they make opens in the viewer
  const subjectDetail = useAsset(subject?.id ?? null);
  const item = useItemActions({ asset: subject ?? NO_ASSET, detail: subjectDetail, enabled: Boolean(subject), onOpened: setViewing, sayErrors: true, timeline: { noStartKey: true } });
  const timelineMenu = item.timeline;
  const formTarget = useFormTarget((st) => st.target);
  const openWorkflow = useOpenInComfy((w: { id: string; title: string }) => api.openWorkflow(w.id), {
    onSuccess: (r, w) => good(`${w.title} is in ComfyUI`, r.direct ? undefined : `Saved as ${r.path ?? "a workflow"}: in ComfyUI, open the Workflows sidebar (W) and pick it under "afflatus".`, "/workflows", "Open Workflows"),
    onError: (err) => failed("Could not open it in ComfyUI")(err),
  });
  // "Import a folder here…": the computer's folder picker, and where what it picks goes (as the Projects panel does it)
  const picker = useRef<HTMLInputElement>(null);
  const importTo = useRef<Target | null>(null);

  const importInto = (t: Target) => {
    importTo.current = t;
    picker.current?.click();
  };
  const kinds = useKindActions({ importInto });

  const failed = useSayFailed({ id: "bar", go: "Open the Studio" });
  const good = (title: string, text?: string, href = "/", goTo = "Open the Studio") => say({ id: `bar:${Date.now()}`, tone: "good", title, text, href, go: goTo });

  const openDraft = (id: string) => {
    useOpenDraft.getState().open(id);
    useStudio.getState().set({ form: true, scope: "draft" });
    go("/");
  };
  // an item of another project is shown where it lives: working in that project (there is no "All" to look from)
  const lookingAt = (project: string | null) => {
    if (useProject.getState().id !== (project ?? "none")) useProject.getState().set(project ?? "none");
  };
  /** A request left for the timeline editor, which is opened on it: the jobs a render queued come back. */
  const askTimeline = (t: TimelineAim, request: TimelineRequest) => {
    const answer = useTimelineRequest.getState().ask(request);
    go(`/timelines/${t.id}`);
    return answer;
  };
  /** The editor's render, then its jobs moved to the top of the queue as the queue's "Run next" does, in their order. */
  const renderAtTop = async (t: TimelineAim, request: RenderTimeline) => {
    const jobs = await askTimeline(t, { ...request, top: true });
    // nothing queued: the editor said why
    if (!jobs?.length) return;
    const waiting = (await api.queue()).waiting.map((w) => w.id);
    const up = jobs.filter((j) => waiting.includes(j));
    if (up.length) client.setQueryData(queryKeys.queue(), await api.queueOrder(atTop(waiting, up)));
    const n = jobs.length;
    good(`${plural(n, "clip")} of ${t.name} queued at the top`, up.length < n ? `${n - up.length === 1 ? "One is" : `${n - up.length} are`} rendering already.` : "Ahead of everything else that waits.", "/queue", "Open queue");
  };

  const x: BarCtx = {
    go, client, say, tree, kinds, allProjects, projects: allProjects.filter((p) => !p.archivedAt), pins, queue, ops, bulk, jobs, setup,
    binEmpty: bin ? !bin.count : false, binSaid: bin ? `${itemsWord(bin.count)} · ${size(bin.bytes)}` : "",
    recipes, entities, modelSettings, openNew, selectedClip, draftOpen, aim, subject, item, formTarget, openWorkflow, settingCtx, onCopied, setViewing,
    importInto,
    failed,
    good,
    noDraft: (what = "No draft is open") => say({ id: "bar:form", tone: "bad", title: what, text: "Open a draft in the Studio first.", href: "/", go: "Open the Studio" }),
    reindex: () => void client.invalidateQueries({ queryKey: queryKeys.commandIndex.all() }),
    openDraft,
    form: () => formWhenOpen(useOpenDraft.getState().id, () => {
      useStudio.getState().set({ form: true });
      go("/");
    }),
    openFolder: (id, project) => {
      lookingAt(project);
      useStudio.getState().set({ place: { type: "folder", id } });
      go("/");
    },
    view: async (id) => setViewing(await client.fetchQuery({ queryKey: queryKeys.assets.one(id), queryFn: ({ signal }) => api.asset(id, { signal }) })),
    /** An item shown in the Studio: its folder open, the item large (as the Projects panel's "Show in the Studio"). */
    showInFolder: async (id, project) => {
      const a = await client.fetchQuery({ queryKey: queryKeys.assets.one(id), queryFn: ({ signal }) => api.asset(id, { signal }) });
      lookingAt(project);
      // an item in the bin is shown there (every project's bin), where Put back is
      useStudio.getState().set({ place: a.inBin ? { type: "bin" } : a.folderId ? { type: "folder", id: a.folderId } : { type: "unfiled" } });
      useHandover.getState().set({ show: a.id });
      go("/");
    },
    askTimeline,
    atTopAction: (t, request) => ({
      label: "Render, at the top of the queue", icon: <ArrowUpToLine size={14} />, note: "ahead of what waits",
      run: () => renderAtTop(t, request).catch(failed("Could not move them to the top")),
    }),
  };

  const actionsOf = (it: Item): Action[] => {
    const e = it.entry;
    switch (it.kind) {
      case "timeline":
        return timelineActions(x, e as TimelineEntry);
      case "draft":
        return draftActions(x, e as Extract<CommandEntry, { kind: "draft" }>);
      case "render":
        // read in full first (its generation): until then Open and Show in its folder, which need nothing more
        return renderActions(x, e as Extract<CommandEntry, { kind: "asset" }>);
      case "project":
        return projectActions(x, e, Boolean(it.inbox));
      case "folder":
        return folderActions(x, e as FolderEntry);
      case "workflow":
        return workflowActions(x, e as Extract<CommandEntry, { kind: "workflow" }>);
      case "kit":
        return kitActions(x, e as Extract<CommandEntry, { kind: "kit" }>);
      case "nav": {
        const nav = it.nav!;
        return [{
          label: it.label, icon: <Navigation size={14} />,
          run: () => {
            if ("bin" in nav) {
              // the Studio on the bin, every project's (as the Projects panel's Bin row)
              useStudio.getState().set({ place: { type: "bin" } });
              return go("/");
            }
            if ("href" in nav) return go(nav.href);
            if (nav.event === "afflatus:projects") return openProjects();
            window.dispatchEvent(new Event(nav.event));
          },
        }];
      }
      case "command":
        if (it.command) return commandActions(x, it.command, it.recipe, it.preset);
        return [];
      case "key": {
        // a row of the key table: the sheet opens on its place, the row lit
        const at = it.keyRow!;
        return [{ label: "Show in Keyboard shortcuts", icon: <Keyboard size={14} />, note: "the sheet, on this row", run: () => openKeys({ place: at.place, row: at.row }) }];
      }
      case "setting": {
        const s = it.setting!;
        const open: Action = { label: `Open Settings › ${pageLabel(s.page)}`, icon: <Settings2 size={14} />, run: () => go(settingHref(s.id, s.page)) };
        if (s.kind === "action") return [{ label: s.label, icon: <RotateCcw size={14} />, note: s.about, run: () => s.run?.() }, open];
        if (s.kind === "switch") {
          const on = Boolean(s.get?.(settingCtx));
          return [{ label: on ? "Switch off" : "Switch on", icon: <Square size={14} />, stay: true, run: () => s.set?.(settingCtx, !on) }, open];
        }
        if (s.kind === "choice") {
          const options = s.options?.(settingCtx) ?? [];
          const now = s.get?.(settingCtx);
          const next = options[(options.findIndex((o) => o.value === now) + 1) % Math.max(1, options.length)];
          return [
            ...(next ? [{ label: `Next: ${next.label}`, icon: <RotateCcw size={14} />, stay: true, run: () => s.set?.(settingCtx, next.value) }] : []),
            open,
            ...options.map((o) => ({ label: o.label, note: o.value === now ? "now" : undefined, stay: true, disabled: o.value === now, run: () => s.set?.(settingCtx, o.value) })),
          ];
        }
        return [open];
      }
      case "job":
        return jobActions(x, it);
      case "calc": {
        const c = it.card!;
        return [{ label: `Copy ${c.copy}`, icon: <Copy size={14} />, stay: true, run: () => copyText(c.copy).then(() => onCopied(c.copy), () => onCopied("")) }];
      }
      case "history":
        return historyActions(x, it.history!);
      case "person":
        return personActions(x, it.person!);
    }
  };

  const element = (
    <>
      {timelineMenu.element}
      {viewing && <Suspense fallback={null}><Viewer asset={viewing} onClose={() => setViewing(null)} /></Suspense>}
      <FolderPicker
        ref={picker}
        onFiles={(files) => {
          const t = importTo.current;
          importTo.current = null;
          if (files.length && t) void tree.importFolder(files, t, client);
        }}
      />
    </>
  );
  return { actionsOf, element };
}
