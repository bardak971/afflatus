import { lazy, Suspense, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  Archive, ArchiveRestore, ArrowUpToLine, Clapperboard, Copy, Eye, FileOutput, Film, FolderInput, FolderKanban, FolderOpen, Pause, PenLine, Play,
  RotateCcw, Square, Trash2, UserPlus, X, Pencil, ListOrdered, Settings2, Sparkles, Link2, FolderPlus, MemoryStick, Layers, Split, ChevronLeft, ChevronRight,
  RefreshCw, Upload, Download, ExternalLink, FileUp, Wand2, Bookmark, Plug, Navigation, Keyboard, Plus, Pin, PinOff, Undo2,
} from "lucide-react";
import { useOpenInComfy } from "../actions";
import { api, type Asset, type CommandEntry, type Entity, type RecipeInfo } from "../api";
import { ask, askText } from "../Confirm";
import type { MenuItem } from "../ContextMenu";
import { assetKey, DRAFT_LIST, useAsset, useEntities, useModelSettings, useProjects, useRecipes, useSetup } from "../data";
import { useOpenNewDraft } from "../draft";
import { formDefaults, mainTextOf } from "../form";
import { formPlaces, useFormTarget } from "../formTarget";
import { snapEdge } from "../fields/SizeField";
import { size } from "../format";
import { projectForNew, useProject } from "../project";
import type { Moving, Row, Target } from "../projects/tree";
import { useTreeActions } from "../projects/useTreeActions";
import { useQueueBulk } from "../screens/queue/bulk";
import { useJobActions } from "../screens/queue/jobActions";
import { atTop, moved } from "../screens/queue/order";
import { lighter, memoryThatRanOut, shorterStretch } from "../screens/queue/retry";
import { kitHref } from "../screens/kit/link";
import { settingHref } from "../screens/settings/settingsIndex";
import { useQueueOf } from "../screens/studio/queueOf";
import { copyText } from "../secureContext";
import { useBanners, useHandover, useOpenDraft, useStudio } from "../store";
import { openKeys } from "../keys/search";
import { rowKeys } from "../keys/table";
import { NO_ASSET, useItemActions } from "../useItemActions";
import { placeMenu } from "../itemActions";
import { askViewer } from "../viewer/ask";
import { formWhenOpen, openProjects, useSelectedClip, useTimelineRequest, useWorkflowsRequest, workflowEditHref, type TimelineRequest } from "./bridge";
import { usePins } from "../projects/pins";
import { castPlace, withPerson } from "./castTo";
import type { Item } from "./items";
import { KIT_OF, type Command, type KitNew } from "./parse";
import { pageLabel, type SettingCtx } from "./settingsRegistry";
import { BAR_INDEX } from "./store";

const Viewer = lazy(() => import("../Viewer").then((m) => ({ default: m.Viewer })));

/** One thing a result can have done to it: Enter does the first, Ctrl + Enter the second, Tab lists them all. */
export interface Action {
  label: string;
  note?: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  /** The bar stays open after it (a switch flipped in place, a figure copied). */
  stay?: boolean;
  /** The key that does the same where the action comes from (the viewer's menu hint, the editor's key), drawn on its right. */
  keys?: string;
  run(): unknown;
}

/** The timeline a command acts on: the one open in the editor, else the one last used. */
export interface TimelineAim {
  id: string;
  name: string;
  entry?: Extract<CommandEntry, { kind: "timeline" }>;
  /** Open in the editor now (its keys and history are on screen). */
  open?: true;
}

type TimelineEntry = Extract<CommandEntry, { kind: "timeline" }>;
type FolderEntry = Extract<CommandEntry, { kind: "folder" }>;
type Preset = Extract<Entity, { kind: "preset" }>;
type Person = Extract<Entity, { kind: "person" }>;

const KIT_WORD = { person: "person", place: "place", style: "style", preset: "preset", snippet: "snippet" } as const;

/** A submenu of the app's own menus, laid flat: "Timeline › Add to Harbor walk". */
function flatten(items: MenuItem[], path = ""): Action[] {
  const out: Action[] = [];
  for (const it of items) {
    if (it === "—") continue;
    const label = path ? `${path} › ${it.label}` : it.label;
    if (it.items) out.push(...flatten(it.items, label));
    else if (it.run) out.push({ label, note: it.note, icon: it.icon, danger: it.danger, disabled: it.disabled, keys: it.key, run: it.run });
  }
  return out;
}

/**
 * What each kind of result can have done, made of what the app already does: the viewer's own actions for a render,
 * the Projects panel's actions for projects, folders, timelines and drafts, the queue's own calls, the timeline editor's
 * and the Workflows screen's buttons (through bridge.ts), the Prompt kit's calls and the open form. The bar adds no
 * behaviour of its own.
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
  const projects = allProjects.filter((p) => !p.archivedAt);
  // what the queue rows need of the queue: not its progress, which changes at every step
  const queue = {
    data: useQueueOf((q) => ({
      paused: q.paused, online: q.online, rendering: q.running?.kind === "render",
      waiting: q.waiting.map((w) => ({ id: w.id })), failed: q.recent.filter((j) => j.status === "failed").map((j) => j.id),
    })),
  };
  const bulk = useQueueBulk();
  const jobs = useJobActions();
  const setup = useSetup();
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

  const failed = (title: string) => (err: unknown) => say({ id: `bar:${Date.now()}`, tone: "bad", title, text: err instanceof Error ? err.message : String(err), href: "/", go: "Open the Studio" });
  const good = (title: string, text?: string, href = "/", goTo = "Open the Studio") => say({ id: `bar:${Date.now()}`, tone: "good", title, text, href, go: goTo });
  const noDraft = (what = "No draft is open") => say({ id: "bar:form", tone: "bad", title: what, text: "Open a draft in the Studio first.", href: "/", go: "Open the Studio" });
  const reindex = () => void client.invalidateQueries({ queryKey: BAR_INDEX });

  const openDraft = (id: string) => {
    useOpenDraft.getState().open(id);
    useStudio.getState().set({ form: true, scope: "draft" });
    go("/");
  };
  /** The open draft's form, opened when it is not on screen. */
  const form = () => formWhenOpen(useOpenDraft.getState().id, () => {
    useStudio.getState().set({ form: true });
    go("/");
  });
  // an item of another project is shown where it lives: working in that project (there is no "All" to look from)
  const lookingAt = (project: string | null) => {
    if (useProject.getState().id !== (project ?? "none")) useProject.getState().set(project ?? "none");
  };
  const openFolder = (id: string, project: string | null) => {
    lookingAt(project);
    useStudio.getState().set({ place: { type: "folder", id } });
    go("/");
  };
  const view = async (id: string) => setViewing(await client.fetchQuery({ queryKey: assetKey(id), queryFn: ({ signal }) => api.asset(id, { signal }) }));
  /** An item shown in the Studio: its folder open, the item large (as the Projects panel's "Show in the Studio"). */
  const showInFolder = async (id: string, project: string | null) => {
    const a = await client.fetchQuery({ queryKey: assetKey(id), queryFn: ({ signal }) => api.asset(id, { signal }) });
    lookingAt(project);
    // an item in the bin is shown there (every project's bin), where Put back is
    useStudio.getState().set({ place: a.inBin ? { type: "bin" } : a.folderId ? { type: "folder", id: a.folderId } : { type: "unfiled" } });
    useHandover.getState().set({ show: a.id });
    go("/");
  };
  /** A request left for the timeline editor, which is opened on it: the jobs a render queued come back. */
  const askTimeline = (t: TimelineAim, request: TimelineRequest) => {
    const answer = useTimelineRequest.getState().ask(request);
    go(`/timelines/${t.id}`);
    return answer;
  };
  /** The editor's render, then its jobs moved to the top of the queue as the queue's "Run next" does, in their order. */
  const renderAtTop = async (t: TimelineAim, request: Extract<TimelineRequest, { do: "render" | "render-missing" }>) => {
    const jobs = await askTimeline(t, { ...request, top: true });
    // nothing queued: the editor said why
    if (!jobs?.length) return;
    const waiting = (await api.queue()).waiting.map((w) => w.id);
    const up = jobs.filter((j) => waiting.includes(j));
    if (up.length) client.setQueryData(["queue"], await api.queueOrder(atTop(waiting, up)));
    const n = jobs.length;
    good(`${n} clip${n > 1 ? "s" : ""} of ${t.name} queued at the top`, up.length < n ? `${n - up.length === 1 ? "One is" : `${n - up.length} are`} rendering already.` : "Ahead of everything else that waits.", "/queue", "Open queue");
  };
  const atTopAction = (t: TimelineAim, request: Extract<TimelineRequest, { do: "render" | "render-missing" }>): Action => ({
    label: "Render, at the top of the queue", icon: <ArrowUpToLine size={14} />, note: "ahead of what waits",
    run: () => renderAtTop(t, request).catch(failed("Could not move them to the top")),
  });

  // the Projects panel's rows, as its actions take them
  const row = (e: CommandEntry, over: Partial<Row> = {}): Row => ({
    key: `${e.kind}:${e.id}`, kind: e.kind === "asset" ? "item" : (e.kind as Row["kind"]), id: e.id, label: e.label, meta: "", bytes: null, depth: 0, prefix: "", foldable: false, open: false, parent: null,
    group: e.kind === "project" ? e.id : "project" in e ? e.project : null, ...over,
  });
  const targets = (): Target[] => [
    ...projects.map((p): Target => ({ kind: "group", group: p.id, root: p.folderId, name: p.name })),
    { kind: "group", group: null, root: null, name: "the Inbox" },
  ];
  const moveTo = (moving: Moving, from: string | null): Action[] =>
    targets().filter((t) => t.kind === "group" && t.group !== from).map((t) => ({
      label: `Move to ${t.name}`, icon: <FolderInput size={14} />, note: t.kind === "group" && t.group === null ? "out of every project" : undefined,
      run: () => tree.move([moving], t),
    }));
  const rename = (e: CommandEntry) => async () => {
    const name = await askText({ title: `Rename ${e.label}`, value: e.label, placeholder: "A name", yes: "Rename" });
    if (name) await tree.rename(row(e), name);
  };

  /** A preset of the Prompt kit on the open draft, as the form's preset menu applies it (refused the same way). */
  const applyPreset = async (p: { id: string; name: string }) => {
    const t = await form();
    if (!t?.applyPreset) return noDraft();
    const refused = t.applyPreset(p.id);
    if (refused) return say({ id: "bar:preset", tone: "bad", title: `${p.name} could not be applied`, text: refused, href: "/", go: "Open the Studio" });
    good(`${p.name} applied`, `To the open draft (${t.recipe.title}).`);
  };
  /** Where `@name` and a person of the kit go: the clip selected in the open timeline editor first, else the open draft. */
  const castActions = (p: Person): Action[] => {
    const toDraft: Action = {
      label: "Add to the open draft", icon: <UserPlus size={14} />, note: "its cast",
      run: async () => {
        const t = await form();
        if (!t?.setLook) return noDraft();
        const look = withPerson(t.look ?? null, p.id);
        if (!look) return good(`${p.name} is already in the draft`);
        t.setLook(look);
        good(`${p.name} added to the draft`, `In the cast of ${t.recipe.title}.`);
      },
    };
    // the clip selected in the open timeline editor first, when its model takes a person
    const clip = selectedClip && castPlace(selectedClip).to === "clip" ? selectedClip : null;
    const toClip: Action[] = clip ? [{
      label: `Add to clip ${clip.number} of ${clip.timelineName}`, icon: <UserPlus size={14} />, note: clip.own ? "its cast" : "its own cast, from the timeline's",
      run: async () => {
        const look = withPerson(clip.look, p.id);
        if (!look) return good(`${p.name} is already in clip ${clip.number}`, clip.own ? undefined : "In the timeline's cast, which the clip follows.", `/timelines/${clip.timeline}`, "Open the timeline");
        await clip.setLook(look).then(() => good(`${p.name} added to clip ${clip.number}`, `In its cast, for ${clip.recipe?.title ?? "its model"}.`, `/timelines/${clip.timeline}`, "Open the timeline"), failed(`${p.name} could not be added to clip ${clip.number}`));
      },
    }] : [];
    return [...toClip, ...(!clip || draftOpen ? [toDraft] : [])];
  };

  /** A command with its figures: what it does, then (Ctrl + Enter) where it does it. */
  const commandActions = (c: Command, recipe?: RecipeInfo, preset?: Preset): Action[] => {
    const noTimeline: Action = { label: "No timeline to do it on", disabled: true, run: () => {} };
    switch (c.cmd) {
      case "render-clips":
        return aim ? [
          { label: `Render clip${c.clips.length > 1 ? "s" : ""} ${c.clips.join(", ")} of ${aim.name}`, icon: <Play size={14} />, note: "at the end of the queue", run: () => askTimeline(aim, { timeline: aim.id, do: "render", clips: c.clips }) },
          atTopAction(aim, { timeline: aim.id, do: "render", clips: c.clips }),
          { label: `Open ${aim.name}`, icon: <Film size={14} />, run: () => go(`/timelines/${aim.id}`) },
        ] : [noTimeline];
      case "render-missing":
        return aim ? [
          { label: `Render missing clips of ${aim.name}`, icon: <Play size={14} />, note: "at the end of the queue", run: () => askTimeline(aim, { timeline: aim.id, do: "render-missing" }) },
          atTopAction(aim, { timeline: aim.id, do: "render-missing" }),
          { label: `Open ${aim.name}`, icon: <Film size={14} />, run: () => go(`/timelines/${aim.id}`) },
        ] : [noTimeline];
      case "export":
        return aim ? [
          { label: `Export ${aim.name}…`, icon: <FileOutput size={14} />, note: "the export dialog opens", run: () => askTimeline(aim, { timeline: aim.id, do: "export" }) },
          { label: `Open ${aim.name}`, icon: <Film size={14} />, run: () => go(`/timelines/${aim.id}`) },
        ] : [noTimeline];
      case "finish":
        return aim ? [
          { label: `Finish ${aim.name}…`, icon: <Sparkles size={14} />, note: "the Finish dialog opens", run: () => askTimeline(aim, { timeline: aim.id, do: "finish" }) },
          { label: `Open ${aim.name}`, icon: <Film size={14} />, run: () => go(`/timelines/${aim.id}`) },
        ] : [noTimeline];
      case "fix-all":
        return aim ? [
          { label: `Fix all in ${aim.name}`, icon: <Wand2 size={14} />, note: "as Needs attention's Fix all", run: () => askTimeline(aim, { timeline: aim.id, do: "fix-all" }) },
          { label: `Open ${aim.name}`, icon: <Film size={14} />, run: () => go(`/timelines/${aim.id}`) },
        ] : [noTimeline];
      case "bin-unused": {
        const e = aim?.entry;
        return e ? [{ label: `Bin unused takes of ${e.label}…`, icon: <Trash2 size={14} />, danger: true, disabled: !e.unusedTakes, note: e.unusedTakes ? `${e.unusedTakes} · ${size(e.unusedBytes)}` : "none", run: () => tree.binUnused(row(e, { unused: { takes: e.unusedTakes, bytes: e.unusedBytes } })) }] : [noTimeline];
      }
      case "seed":
      case "steps":
      case "cfg":
      case "size":
      case "length": {
        const set = async () => {
          const t = await form();
          if (!t) return say({ id: "bar:form", tone: "bad", title: "No draft is open", text: "Open a draft in the Studio first: the command sets a value of its form.", href: "/", go: "Open the Studio" });
          const inputs = t.recipe.inputs;
          const spec =
            c.cmd === "seed" ? inputs.find((i) => i.type === "seed")
            : c.cmd === "size" ? inputs.find((i) => i.type === "size" && !i.ratioOnly)
            : c.cmd === "length" ? inputs.find((i) => i.type === "number" && (i.id === "seconds" || /^(length|seconds|duration)$/i.test(i.label)))
            : c.cmd === "steps" ? inputs.find((i) => i.type === "number" && (/^steps$/i.test(i.id) || /^steps$/i.test(i.label)))
            : inputs.find((i) => i.type === "number" && (/^(cfg|guidance)$/i.test(i.id) || /^(cfg|guidance)$/i.test(i.label)));
          if (!spec) return say({ id: "bar:form", tone: "bad", title: `${t.recipe.title} has no ${c.cmd === "cfg" ? "CFG" : c.cmd} to set`, text: c.cmd === "size" ? "Its frame is set by proportions and a resolution: choose them in the form." : undefined, href: "/", go: "Open the Studio" });
          // a size goes in as the size field keeps a typed one: each edge on the recipe's grid, within its least and most
          const where = `In the open draft (${t.recipe.title}).`;
          if (c.cmd === "size") {
            if (spec.type !== "size") return;
            const fit = { width: snapEdge(spec, c.width), height: snapEdge(spec, c.height) };
            t.set(spec.id, fit);
            const moved = fit.width !== c.width || fit.height !== c.height;
            return good(`${spec.label || "Size"} set to ${fit.width}×${fit.height}`, moved ? `${c.width}×${c.height} put on its grid of ${spec.grid}, ${spec.min} to ${spec.max} px a side. ${where}` : where);
          }
          const value = c.cmd === "length" ? c.seconds : c.value;
          if (spec.type === "number" && (value < spec.min || value > spec.max)) return say({ id: "bar:form", tone: "bad", title: `${spec.label} goes from ${spec.min} to ${spec.max}`, href: "/", go: "Open the Studio" });
          t.set(spec.id, value);
          good(`${spec.label || c.cmd} set to ${value}`, where);
        };
        const said = c.cmd === "size" ? `${c.width}×${c.height}` : c.cmd === "length" ? `${c.seconds} s` : String(c.value);
        return [{ label: `Set ${c.cmd === "cfg" ? "CFG" : c.cmd} to ${said}`, icon: <PenLine size={14} />, note: "in the open draft", run: set }];
      }
      case "generate":
        return [{
          label: "Generate", icon: <Play size={14} />, note: "the open draft, as its Generate button",
          run: () => form().then((t) => (t?.generate ? t.generate() : noDraft())),
        }];
      case "preset":
        if (!preset) return [{ label: `No preset called “${c.name}”`, disabled: true, run: () => {} }];
        return [
          { label: `Apply ${preset.name}`, icon: <Bookmark size={14} />, note: "on the open draft", run: () => applyPreset(preset) },
          { label: `Open ${preset.name} in the Prompt kit`, icon: <Clapperboard size={14} />, run: () => go(kitHref("preset", preset.id)) },
        ];
      case "save-preset":
        return [{
          label: `Save as preset “${c.name}”`, icon: <Bookmark size={14} />, note: "the open draft's model, form and cast",
          run: async () => {
            const t = await form();
            if (!t?.savePreset) return noDraft();
            await t.savePreset(c.name).then(() => good(`${c.name} saved as a preset`, `From the open draft (${t.recipe.title}).`, kitHref("preset"), "Open the Prompt kit"), failed(`${c.name} could not be saved`));
          },
        }];
      case "load": {
        if (!recipe) return [{ label: `No model called “${c.model}”`, disabled: true, run: () => {} }];
        const run = async () => {
          const open = useFormTarget.getState().target;
          const status = setup.data?.recipes.find((x) => x.id === recipe.id);
          const stored = open?.recipe.id === recipe.id ? open.values : {};
          const input = { ...formDefaults(recipe, status?.options, modelSettings.data?.items ?? [], stored).defaults, ...stored };
          await api.warm(recipe.id, input, open?.recipe.id === recipe.id ? open.look ?? null : null);
          void client.invalidateQueries({ queryKey: ["queue"] });
          good(`${recipe.title}: loading its models`, "A job in the queue that renders nothing.", "/queue", "Open queue");
        };
        return [{ label: `Load ${recipe.title}`, icon: <MemoryStick size={14} />, note: "into ComfyUI, ahead of a render", run: () => run().catch(failed(`${recipe.title} could not be loaded`)) }];
      }
      case "unload": {
        // the Queue page's button, on the same conditions
        const q = queue.data;
        return [{
          label: "Unload models", icon: <MemoryStick size={14} />, disabled: !q?.online || q.rendering, note: !q?.online ? "ComfyUI is offline" : q.rendering ? "not while a render runs" : "the next render loads what it needs",
          run: () => api.freeMemory().then(() => good("Models unloaded", "The next render loads what it needs again.", "/queue", "Open queue"), failed("Could not unload the models")),
        }];
      }
      case "new-draft":
        if (!recipe) return [{ label: `No model called “${c.recipe}”`, disabled: true, run: () => {} }];
        return [{ label: `New draft on ${recipe.title}`, icon: <Sparkles size={14} />, run: () => api.createDraft({ recipe: recipe.id }).then(openNew, failed("Could not make the draft")) }];
      case "new-timeline":
        return [{
          label: c.name ? `New timeline “${c.name}”` : "New timeline", icon: <Film size={14} />, note: "in the project you work in; opens in the editor",
          run: () => api.createTimeline(c.name || undefined, projectForNew()).then((t) => { void client.invalidateQueries({ queryKey: ["timelines"] }); reindex(); go(`/timelines/${t.id}`); }, failed("Could not make the timeline")),
        }];
      case "new-folder": {
        // at the top of the project worked in (in its root folder), as the Projects panel's "New folder inside…" on it
        const project = useProject.getState().id;
        const group = project && project !== "none" ? project : null;
        const p = group ? allProjects.find((x) => x.id === group) : undefined;
        const root = p?.folderId ?? null;
        return [{
          label: `New folder “${c.name}” in ${p?.name ?? "the Inbox"}`, icon: <FolderPlus size={14} />,
          run: () => api.createFolder(c.name, root, root ? undefined : group).then((f) => {
            for (const queryKey of [["folders"], ["projects"]]) void client.invalidateQueries({ queryKey });
            reindex();
            good(`${f.name} made`, `In ${p?.name ?? "the Inbox"}.`);
          }, failed(`${c.name} could not be made`)),
        }];
      }
      case "new-person":
      case "new-place":
      case "new-style":
      case "new-preset":
      case "new-snippet": {
        const kind = KIT_OF[c.cmd as KitNew];
        return [{
          label: `New ${KIT_WORD[kind]} “${c.name}”`, icon: <Clapperboard size={14} />, note: "opens in the Prompt kit",
          run: () => api.createEntity(kind, c.name, kind === "snippet" ? { text: "", category: "", style: null } : undefined)
            .then((e) => { void client.invalidateQueries({ queryKey: ["entities"] }); go(kitHref(kind, e.id)); }, failed(`${c.name} could not be made`)),
        }];
      }
      case "import-workflow":
        return [{
          label: "Import workflow…", icon: <FileUp size={14} />, note: "the file picker of the Workflows screen",
          run: () => {
            useWorkflowsRequest.getState().ask({ do: "import" });
            go("/workflows");
          },
        }];
      case "view-last":
        return [{
          label: "View last render", icon: <Eye size={14} />, note: "what the last finished job made",
          run: async () => {
            // what it made is not in the queue's figures: asked for now, as the status bar's "last:" does
            const done = (await api.jobs({ status: "done", limit: 10 })).items;
            const id = done.flatMap((j) => j.made.filter((m) => !m.inBin)).at(0)?.id;
            if (id) await view(id);
            else say({ id: "bar:last", tone: "bad", title: "Nothing finished lately is in the library", href: "/queue", go: "Open queue" });
          },
        }];
      case "reconnect":
        return [{
          label: "Reconnect to ComfyUI", icon: <Plug size={14} />, note: "as Settings' Test again",
          run: () => api.rescanSetup().then((scan) => {
            client.setQueryData(["setup"], scan);
            for (const queryKey of [["settings"], ["queue"]]) void client.invalidateQueries({ queryKey });
            if (scan.comfy.online) good("ComfyUI answers", scan.comfy.url, "/queue", "Open queue");
            else say({ id: "bar:comfy", tone: "bad", title: "ComfyUI does not answer", text: scan.comfy.error, href: "/settings", go: "Open settings" });
          }, failed("Could not reach ComfyUI")),
        }];
      case "pause":
        return [{ label: "Pause queue", icon: <Pause size={14} />, disabled: queue.data?.paused, note: queue.data?.paused ? "already paused" : undefined, run: () => api.pause().then((q) => client.setQueryData(["queue"], q), failed("Could not pause the queue")) }];
      case "resume":
        return [{ label: "Resume queue", icon: <Play size={14} />, disabled: queue.data ? !queue.data.paused : false, note: queue.data && !queue.data.paused ? "it is running" : undefined, run: () => api.resume().then((q) => client.setQueryData(["queue"], q), failed("Could not resume the queue")) }];
      case "empty-bin":
        return [{
          label: "Empty the bin…", icon: <Trash2 size={14} />, danger: true, note: "asked first; cannot be undone",
          run: async () => {
            if (!(await ask({ title: "Empty the bin?", text: "Everything in the bin is erased now, files and all, instead of after its 7 days. This cannot be undone.", yes: "Erase" }))) return;
            await api.emptyBin().then((r) => { void client.invalidateQueries({ queryKey: ["timelines"] }); good(`${r.erased} item${r.erased === 1 ? "" : "s"} erased`, r.inUse ? `${r.inUse} still in use stayed.` : undefined); }, failed("Could not empty the bin"));
          },
        }];
      case "link-folder": {
        const project = useProject.getState().id;
        const group = project && project !== "none" ? project : null;
        const name = group ? projects.find((p) => p.id === group)?.name ?? "the project" : "the Inbox";
        const t: Target = { kind: "group", group, root: null, name };
        return [{
          label: c.path ? `Link ${c.path} to ${name}` : `Link a folder of your disk to ${name}…`, icon: <Link2 size={14} />, note: "used in place, nothing copied",
          run: () => (c.path
            ? api.linkFolder(c.path, undefined, group).then((m) => { void client.invalidateQueries({ queryKey: ["projects"] }); good(`${m.name} linked: ${m.files ?? 0} ${(m.files ?? 0) === 1 ? "file" : "files"}`, "Its files are used where they are; nothing was copied."); }, failed(`${c.path} could not be linked`))
            : tree.link(t)),
        }];
      }
      case "split":
      case "previous-take":
      case "next-take": {
        const clip = selectedClip;
        if (!clip) return [{ label: "No clip selected in an open timeline", disabled: true, run: () => {} }];
        // the editor is on screen (a clip is selected in it): it does it as its keys do, and says in its note when it cannot
        const request: TimelineRequest = c.cmd === "split" ? { timeline: clip.timeline, do: "split" } : { timeline: clip.timeline, do: "take", by: c.cmd === "next-take" ? 1 : -1 };
        const run = () => useTimelineRequest.getState().ask(request);
        // the editor's key for it, read from the key table, drawn on the action's right
        if (c.cmd === "split") return [{ label: `Split clip ${clip.number} at playhead`, icon: <Split size={14} />, keys: rowKeys("split"), run }];
        const next = c.cmd === "next-take";
        return [{ label: `Clip ${clip.number}: ${next ? "next" : "previous"} take`, icon: next ? <ChevronRight size={14} /> : <ChevronLeft size={14} />, keys: rowKeys("take", next ? 1 : 0), run }];
      }
      case "cancel-waiting": {
        const ids = queue.data?.waiting.map((w) => w.id) ?? [];
        return [{
          label: "Cancel all waiting…", icon: <Trash2 size={14} />, danger: true, disabled: !ids.length, note: ids.length ? `${ids.length} · asked first · the running one goes on` : "nothing waits",
          run: () => bulk.cancelAllWaiting({ ids }).then((n) => n && good(`${n} waiting job${n === 1 ? "" : "s"} cancelled`, "In the history as cancelled: Requeue brings one back.", "/queue", "Open queue")),
        }];
      }
      case "retry-failed": {
        // the failures the queue lists (newest first, as `!` shows them): queued again oldest first
        const ids = queue.data?.failed ?? [];
        return [{
          label: "Retry all failed", icon: <RotateCcw size={14} />, disabled: !ids.length, note: ids.length ? `${ids.length} · the same jobs, oldest first` : "none failed",
          run: () => bulk.retryAllFailed(ids).then((r) => r?.ids.length && good(`${r.ids.length} failed job${r.ids.length === 1 ? "" : "s"} queued again`, undefined, "/queue", "Open queue")),
        }];
      }
      case "dismiss-failed": {
        const ids = queue.data?.failed ?? [];
        return [{
          label: "Dismiss all failed…", icon: <X size={14} />, danger: true, disabled: !ids.length, note: ids.length ? `${ids.length} · off the history, asked first` : "none failed",
          run: () => bulk.dismissAllFailed({ ids, ask: true }).then((n) => n && good(`${n} failed job${n === 1 ? "" : "s"} dismissed`, "Nothing left the library.", "/queue", "Open queue")),
        }];
      }
      case "group-queue":
        return [{
          label: "Group by model", icon: <Layers size={14} />, note: "same model together, the loaded one first",
          run: () => bulk.groupQueueByModel().then((done) => (done ? good("Queue grouped by model", "Same model together, the loaded one first.", "/queue", "Open queue") : done === false && good("Grouping saves no load", "The queue stays as it is.", "/queue", "Open queue"))),
        }];
      case "undo": {
        // the open editor's history first, as Ctrl+Z there; elsewhere the newest banner's Undo (a move, a bin), as Ctrl+Z off the editor
        if (aim?.open) {
          const what = client.getQueryData<{ undo?: string | null }>(["timelines", aim.id])?.undo ?? null;
          return [{ label: what ? `Undo: ${what}` : `Nothing to undo in ${aim.name}`, icon: <Undo2 size={14} />, disabled: !what, note: what ? `in ${aim.name}, as its Ctrl+Z` : undefined, keys: what ? "Ctrl+Z" : undefined, run: () => useTimelineRequest.getState().ask({ timeline: aim.id, do: "undo" }) }];
        }
        const banner = [...useBanners.getState().items].reverse().find((x) => x.action?.undo);
        return [{
          label: banner ? `Undo: ${banner.title}` : "Nothing to undo", icon: <Undo2 size={14} />, disabled: !banner, note: banner ? "as the banner's Undo" : undefined, keys: banner ? "Ctrl+Z" : undefined,
          run: () => {
            if (!banner) return;
            useBanners.getState().dismiss(banner.id);
            banner.action!.run();
          },
        }];
      }
      case "clip": {
        if (!aim) return [noTimeline];
        const n = c.number;
        const over = aim.entry && n > aim.entry.clips;
        return [{
          label: over ? `${aim.name} has ${aim.entry!.clips} clip${aim.entry!.clips === 1 ? "" : "s"}` : `Go to clip ${n} of ${aim.name}`, icon: <Film size={14} />, disabled: Boolean(over),
          note: over ? undefined : "selected, the playhead on its start",
          run: () => askTimeline(aim, { timeline: aim.id, do: "select", clip: n }),
        }];
      }
      case "new-project":
        return [{
          label: `New project “${c.name}”`, icon: <FolderPlus size={14} />, note: "and work in it",
          run: () => api.createProject(c.name).then((p) => { void client.invalidateQueries({ queryKey: ["projects"] }); useProject.getState().set(p.id); good(`${p.name} made`, "You work in it now: what you make lands in its root folder."); }, failed("Could not make the project")),
        }];
    }
  };

  /**
   * The selected render's actions: the item's list (itemActions.tsx), as every place shows it, with the viewer's keys
   * named. Open first (Enter opens it, as Open's key says), then the bar's own section (Show in its folder, on Ctrl +
   * Enter as before; Use in this draft), then the rest of the list. Trim and Details open the viewer with them.
   */
  const renderActions = (a: Asset, project: string | null): Action[] => {
    const openWith = (what: "trim" | "details") => () => {
      askViewer(a.id, what);
      setViewing(a);
    };
    const list = item.list({}, {
      open: () => setViewing(a),
      trim: openWith("trim"),
      details: openWith("details"),
      "copy-seed": () => item.seed !== null && copyText(String(item.seed)).then(() => onCopied(`the seed ${item.seed}`), () => onCopied("")),
    }, { "save-frame": "the first frame" });
    const places = formPlaces(formTarget, a);
    const own: MenuItem[] = [
      { label: a.inBin ? "Show in the bin" : "Show in its folder", icon: <FolderOpen size={14} />, note: "in the Studio", run: () => void showInFolder(a.id, project).catch(failed("Could not show it")) },
      ...(places.length ? [{ label: "Use in this draft", icon: <Plus size={14} />, note: formTarget?.recipe.title, items: places }] : []),
    ];
    // Open first by name, not by place (the bin's own list leads with Put back); an item in the bin then has Put back on
    // Ctrl + Enter, any other its folder
    const rest = placeMenu([], list, "command");
    const take = (label: string): MenuItem[] => {
      const i = rest.findIndex((m) => m !== "—" && m.label === label);
      return i < 0 ? [] : rest.splice(i, 1);
    };
    const open = take("Open");
    const back = a.inBin ? take("Put back") : [];
    const out = flatten([...open, ...back, ...own, ...rest]);
    // the seed copied, the bar stays (as a figure of the calculator)
    return out.map((x) => (x.label === "Copy the seed" ? { ...x, stay: true } : x));
  };

  /** A job of the queue: what its row and menu on the Queue page do. */
  const jobActions = (it: Item): Action[] => {
    const { job, state } = it.job!;
    const toQueue: Action = { label: "Open queue", icon: <ListOrdered size={14} />, run: () => go("/queue") };
    const toDraft: Action[] = job.draftId ? [{ label: "Open its draft", icon: <PenLine size={14} />, run: () => openDraft(job.draftId!) }] : [];
    if (state === "running") {
      const seed = (job as { seed?: number | null }).seed ?? null;
      return [
        toQueue,
        { label: "Stop this render", icon: <X size={14} />, danger: true, note: "nothing is added", run: () => api.cancel(job.id).then(() => client.invalidateQueries({ queryKey: ["queue"] }), failed("Could not stop it")) },
        ...(seed !== null ? [{ label: "Copy the seed", icon: <Copy size={14} />, note: String(seed), stay: true, run: () => copyText(String(seed)).then(() => onCopied(`the seed ${seed}`), () => onCopied("")) }] : []),
        ...toDraft,
      ];
    }
    if (state === "waiting") {
      const ids = queue.data?.waiting.map((w) => w.id) ?? [];
      return [
        toQueue,
        { label: "Run next", icon: <ArrowUpToLine size={14} />, disabled: ids[0] === job.id, run: () => api.queueOrder(moved(ids, job.id, 0)).then((q) => client.setQueryData(["queue"], q), failed("Could not move it")) },
        { label: "Cancel this one", icon: <X size={14} />, danger: true, run: () => api.cancel(job.id).then(() => client.invalidateQueries({ queryKey: ["queue"] }), failed("Could not cancel it")) },
        ...toDraft,
      ];
    }
    // a failure: run again (changed, or not) and taken out of the list once queued, as its row on the Queue page does
    const recipe = recipes.find((r) => r.id === job.recipe);
    const memory = memoryThatRanOut(job.error);
    const fix = memory ? lighter(recipe, job.input) : null;
    const stretch = memory ? shorterStretch(recipe, job.input) : null;
    const retry = (input?: Record<string, unknown>) => jobs.again.mutate({ id: job.id, input }, { onSuccess: () => { jobs.dismiss.mutate(job.id); good(`${job.label} queued again`, undefined, "/queue", "Open queue"); } });
    return [
      toQueue,
      { label: "Retry unchanged", icon: <RotateCcw size={14} />, note: "the same job again", run: () => retry() },
      ...(stretch ? [{ label: stretch.label, icon: <RotateCcw size={14} />, note: "less memory", run: () => retry(stretch.change) }] : []),
      ...(fix ? [{ label: fix.label, icon: <RotateCcw size={14} />, note: "less memory", run: () => retry(fix.change) }] : []),
      ...toDraft,
      { label: "Dismiss", icon: <Trash2 size={14} />, danger: true, note: "out of the history", run: () => jobs.dismiss.mutate(job.id) },
    ];
  };

  const actionsOf = (it: Item): Action[] => {
    const e = it.entry;
    switch (it.kind) {
      case "timeline": {
        const t = e as TimelineEntry;
        const aimed: TimelineAim = { id: t.id, name: t.label, entry: t };
        return [
          { label: "Open in the editor", icon: <Film size={14} />, run: () => go(`/timelines/${t.id}`) },
          { label: "Show in Projects", icon: <FolderKanban size={14} />, run: () => openProjects(t.label) },
          { label: "Render missing clips", icon: <Play size={14} />, run: () => askTimeline(aimed, { timeline: t.id, do: "render-missing" }) },
          { label: "Export…", icon: <FileOutput size={14} />, note: t.exported ? "exported before" : undefined, run: () => askTimeline(aimed, { timeline: t.id, do: "export" }) },
          { label: "Finish…", icon: <Sparkles size={14} />, run: () => askTimeline(aimed, { timeline: t.id, do: "finish" }) },
          { label: "Fix all", icon: <Wand2 size={14} />, note: "what Needs attention lists", run: () => askTimeline(aimed, { timeline: t.id, do: "fix-all" }) },
          { label: "Bin unused takes…", icon: <Trash2 size={14} />, disabled: !t.unusedTakes, note: t.unusedTakes ? `${t.unusedTakes} · ${size(t.unusedBytes)}` : "none", run: () => tree.binUnused(row(t, { unused: { takes: t.unusedTakes, bytes: t.unusedBytes } })) },
          { label: "Rename…", icon: <Pencil size={14} />, run: rename(t) },
          ...moveTo({ kind: "timeline", id: t.id, group: t.project, folder: t.folder, name: t.label }, t.project),
          { label: "Delete…", icon: <Trash2 size={14} />, danger: true, note: "its videos stay in the library", run: () => tree.remove([row(t)]) },
        ];
      }
      case "draft": {
        const d = e as Extract<CommandEntry, { kind: "draft" }>;
        return [
          { label: "Open in the Studio", icon: <PenLine size={14} />, run: () => openDraft(d.id) },
          { label: "Show in Projects", icon: <FolderKanban size={14} />, run: () => openProjects(d.label) },
          { label: "Generate again", icon: <Play size={14} />, note: "as its Generate button", run: () => formWhenOpen(d.id, () => openDraft(d.id)).then((t) => (t?.generate ? t.generate() : say({ id: "bar:gen", tone: "bad", title: "The draft could not be opened", href: "/", go: "Open the Studio" }))) },
          {
            label: "Duplicate", icon: <Layers size={14} />, note: "a new draft with its form",
            run: () => api.draft(d.id).then((x) => api.createDraft({ recipe: x.recipe, forms: x.forms, count: x.count, look: x.look, project: d.project })).then((made) => { void client.invalidateQueries({ queryKey: DRAFT_LIST }); openNew(made); }, failed("Could not duplicate the draft")),
          },
          {
            // as the draft header's pencil: the name it is listed by, instead of the start of its prompt
            label: "Rename…", icon: <Pencil size={14} />,
            run: async () => {
              const name = await askText({ title: `Rename ${d.label}`, value: d.label, placeholder: "A name", yes: "Rename" });
              if (!name || name === d.label) return;
              await api.saveDraft(d.id, { name }).then(() => { for (const queryKey of [DRAFT_LIST, ["drafts", d.id]]) void client.invalidateQueries({ queryKey }); }, failed(`${d.label} could not be renamed`));
            },
          },
          ...moveTo({ kind: "draft", id: d.id, group: d.project, name: d.label }, d.project),
          { label: "Delete…", icon: <Trash2 size={14} />, danger: true, note: "what was made from it stays", run: () => tree.remove([row(d)]) },
        ];
      }
      case "render": {
        const a = e as Extract<CommandEntry, { kind: "asset" }>;
        // read in full first (its generation): until then Open and Show in its folder, which need nothing more
        if (subject && subject.id === a.id) return renderActions(subject, a.project);
        return [
          { label: "Open", icon: <Eye size={14} />, keys: "Enter", run: () => view(a.id).catch(failed("Could not open it")) },
          { label: a.inBin ? "Show in the bin" : "Show in its folder", icon: <FolderOpen size={14} />, note: "in the Studio", run: () => showInFolder(a.id, a.project).catch(failed("Could not show it")) },
          { label: "Reading what was made with it…", disabled: true, run: () => {} },
        ];
      }
      case "project": {
        // the Inbox: worked in like a project, as the Projects panel's row of it
        if (it.inbox) return [
          { label: "Work in it", icon: <FolderKanban size={14} />, note: "the library, drafts and timelines out of every project", run: () => useProject.getState().set("none") },
          { label: "Show in Projects", icon: <FolderKanban size={14} />, run: () => openProjects("Inbox") },
        ];
        const p = e as Extract<CommandEntry, { kind: "project" }>;
        const r = row(p, { archived: p.archived });
        const root = allProjects.find((x) => x.id === p.id)?.folderId ?? null;
        // an archived project: Enter unarchives it (to work in it, it has to come back first)
        const unarchive: Action = { label: "Unarchive", icon: <ArchiveRestore size={14} />, note: "back among the projects, to work in", run: () => tree.archive(r, false) };
        return [
          p.archived ? unarchive : { label: "Work in it", icon: <FolderKanban size={14} />, note: "the library, drafts and timelines show its own", run: () => useProject.getState().set(p.id) },
          { label: "Show in Projects", icon: <FolderKanban size={14} />, run: () => openProjects(p.label) },
          pins.has(p.id)
            ? { label: "Unpin from the rail", icon: <PinOff size={14} />, run: () => pins.unpin(p.id) }
            : { label: "Pin to the rail", icon: <Pin size={14} />, disabled: p.archived || pins.full, note: p.archived ? "archived" : pins.full ? "the rail holds four" : undefined, run: () => pins.pin(p.id) },
          // as the Projects panel's menu on a project
          { label: "New folder inside…", icon: <FolderPlus size={14} />, run: () => tree.newFolder({ name: p.label, parent: root, project: p.id }) },
          { label: "Import a folder here…", icon: <Upload size={14} />, note: root ? "copies it in" : "makes its root folder first", run: () => importInto({ kind: "group", group: p.id, root, name: p.label }) },
          { label: "Rename…", icon: <Pencil size={14} />, run: rename(p) },
          ...(p.archived ? [] : [{ label: "Archive", icon: <Archive size={14} />, note: "hides it, keeps everything", run: () => tree.archive(r, true) }]),
          { label: "Delete…", icon: <Trash2 size={14} />, danger: true, note: "its things go to the Inbox", run: () => tree.removeProject(r) },
        ];
      }
      case "folder": {
        const f = e as FolderEntry;
        const linkedRoot = f.linked && f.parent === null;
        return [
          { label: "Open in the library", icon: <FolderOpen size={14} />, run: () => openFolder(f.id, f.project) },
          { label: "Show in Projects", icon: <FolderKanban size={14} />, run: () => openProjects(f.label) },
          ...(f.linked ? [{ label: "Rescan", icon: <RefreshCw size={14} />, note: "what changed on your disk", run: () => tree.rescan(row(f, { linked: true })) }] : []),
          { label: "New folder inside…", icon: <FolderPlus size={14} />, note: f.linked ? "a new directory on your disk" : undefined, run: () => tree.newFolder({ name: f.label, parent: f.id, project: f.project }) },
          ...(!f.linked ? [{ label: "Import a folder here…", icon: <Upload size={14} />, note: "copies it in", run: () => importInto({ kind: "folder", id: f.id, group: f.project, linked: false, ancestors: [], name: f.label }) }] : []),
          ...(!f.linked || linkedRoot ? [{ label: "Rename…", icon: <Pencil size={14} />, run: rename(f) }] : []),
          ...(!f.linked || linkedRoot ? moveTo({ kind: "folder", id: f.id, group: f.project, parent: f.parent, name: f.label, linkedRoot }, f.project) : []),
          ...(!f.linked || linkedRoot ? [{ label: f.linked ? "Unlink…" : "Delete…", icon: <Trash2 size={14} />, danger: true, note: f.linked ? "nothing on your disk is touched" : "its items move to the folder above", run: () => (f.linked ? tree.unlink(row(f, { linked: true, linkedRoot: true })) : tree.remove([row(f)])) }] : []),
        ];
      }
      case "workflow": {
        // the Workflows screen's row: Try it, then its menu
        const w = e as Extract<CommandEntry, { kind: "workflow" }>;
        const ready = !w.problem && recipes.some((r) => r.id === w.id);
        const online = setup.data?.comfy.online ?? false;
        return [
          { label: "Try it", icon: <Play size={14} />, disabled: !ready, note: ready ? "the form, on a new draft" : "it cannot be built as mapped", run: () => api.createDraft({ recipe: w.id }).then(openNew, failed("Could not make the draft")) },
          { label: "Edit", icon: <Pencil size={14} />, note: "its mapping and form", run: () => go(workflowEditHref(w.id)) },
          { label: "Export", icon: <Download size={14} />, note: "a file another Afflatus imports", run: () => import("../screens/Workflows").then((m) => m.share({ id: w.id, title: w.label })).catch(failed("Could not export it")) },
          { label: "Open in ComfyUI", icon: <ExternalLink size={14} />, disabled: !online, note: online ? undefined : "ComfyUI is not running", run: () => openWorkflow.mutate({ id: w.id, title: w.label }) },
          {
            label: "Remove…", icon: <Trash2 size={14} />, danger: true, note: "what it made stays in the library",
            run: async () => {
              if (!(await ask({ title: `Remove ${w.label}?`, text: "What you generated with it stays in your library.", yes: "Remove" }))) return;
              await api.deleteWorkflow(w.id).then(() => { for (const key of ["recipes", "setup", "workflows"]) void client.invalidateQueries({ queryKey: [key] }); reindex(); }, failed(`${w.label} could not be removed`));
            },
          },
        ];
      }
      case "kit": {
        const k = e as Extract<CommandEntry, { kind: "kit" }>;
        const entity = entities.find((x) => x.id === k.id);
        const open: Action = { label: "Open in the Prompt kit", icon: <Clapperboard size={14} />, run: () => go(kitHref(k.entity, k.id)) };
        if (k.entity === "preset") return [open, { label: "Apply in Studio", icon: <Bookmark size={14} />, note: "on the open draft", run: () => applyPreset({ id: k.id, name: k.label }) }];
        if (k.entity === "snippet") {
          const text = entity?.kind === "snippet" ? entity.def.text : "";
          return [open, { label: "Copy its text", icon: <Copy size={14} />, stay: true, disabled: !text, note: text ? text.slice(0, 60) : "empty", run: () => copyText(text).then(() => onCopied(`${k.label}`), () => onCopied("")) }];
        }
        if (k.entity === "person" && entity?.kind === "person") return [open, ...castActions(entity)];
        return [open];
      }
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
        if (it.command) return commandActions(it.command, it.recipe, it.preset);
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
        return jobActions(it);
      case "calc": {
        const c = it.card!;
        return [{ label: `Copy ${c.copy}`, icon: <Copy size={14} />, stay: true, run: () => copyText(c.copy).then(() => onCopied(c.copy), () => onCopied("")) }];
      }
      case "history": {
        const h = it.history!;
        return [
          {
            label: "Use in the open draft", icon: <PenLine size={14} />, note: "its main prompt",
            run: async () => {
              const t = await form();
              const main = t ? mainTextOf(t.recipe) : undefined;
              if (!t || !main) return say({ id: "bar:form", tone: "bad", title: "No draft with a prompt is open", href: "/", go: "Open the Studio" });
              t.set(main.id, h.prompt);
              good("Prompt put in the open draft", h.prompt.slice(0, 120));
            },
          },
          ...(h.assetId ? [{ label: "View its render", icon: <Eye size={14} />, run: () => view(h.assetId!).catch(failed("Could not open it")) }] : []),
          ...(h.draftId ? [{ label: "Open its draft", icon: <PenLine size={14} />, run: () => openDraft(h.draftId!) }] : []),
          { label: "Copy the prompt", icon: <Copy size={14} />, stay: true, run: () => copyText(h.prompt).then(() => onCopied("the prompt"), () => onCopied("")) },
        ];
      }
      case "person": {
        const p = it.person!;
        return [...castActions(p), { label: `Open ${p.name} in the Prompt kit`, icon: <Clapperboard size={14} />, run: () => go(kitHref("person", p.id)) }];
      }
    }
  };

  const element = (
    <>
      {timelineMenu.element}
      {viewing && <Suspense fallback={null}><Viewer asset={viewing} onClose={() => setViewing(null)} /></Suspense>}
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        aria-hidden="true"
        tabIndex={-1}
        // a whole directory, sub-directories included
        {...{ webkitdirectory: "", directory: "" }}
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          const t = importTo.current;
          importTo.current = null;
          if (files.length && t) void tree.importFolder(files, t, client);
        }}
      />
    </>
  );
  return { actionsOf, element };
}
