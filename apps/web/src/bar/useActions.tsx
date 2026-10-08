import { lazy, Suspense, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  Archive, ArchiveRestore, ArrowUpToLine, Clapperboard, Copy, Eye, FileOutput, Film, FolderInput, FolderKanban, FolderOpen, Pause, PenLine, Play,
  RotateCcw, Square, Trash2, UserPlus, X, Pencil, ListOrdered, Settings2, Sparkles, Link2, FolderPlus, MemoryStick, Layers,
} from "lucide-react";
import { api, type Asset, type CommandEntry, type RecipeInfo } from "../api";
import { ask, askText } from "../Confirm";
import type { MenuItem } from "../ContextMenu";
import { assetKey, DRAFT_LIST, useModelSettings, useProjects, useQueue, useSetup } from "../data";
import { useOpenNewDraft } from "../draft";
import { formDefaults, mainTextOf } from "../form";
import { useFormTarget } from "../formTarget";
import { size } from "../format";
import { useProject } from "../project";
import type { Moving, Row, Target } from "../projects/tree";
import { useTreeActions } from "../projects/useTreeActions";
import { atTop, moved } from "../screens/queue/order";
import { useBanners, useHandover, useOpenDraft, useStudio } from "../store";
import { useTileMenu } from "../TileMenu";
import { formWhenOpen, openProjects, useSelectedClip, useTimelineRequest, type TimelineRequest } from "./bridge";
import { castPlace, withPerson } from "./castTo";
import type { Item } from "./items";
import type { Command } from "./parse";
import { pageHref, pageLabel, type SettingCtx } from "./settingsRegistry";

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
  run(): unknown;
}

/** The timeline a command acts on: the one open in the editor, else the one last used. */
export interface TimelineAim {
  id: string;
  name: string;
  entry?: Extract<CommandEntry, { kind: "timeline" }>;
}

type TimelineEntry = Extract<CommandEntry, { kind: "timeline" }>;
type FolderEntry = Extract<CommandEntry, { kind: "folder" }>;

/** A submenu of the app's own menus, laid flat: "Timeline › Add to Harbor walk". */
function flatten(items: MenuItem[], path = ""): Action[] {
  const out: Action[] = [];
  for (const it of items) {
    if (it === "—") continue;
    const label = path ? `${path} › ${it.label}` : it.label;
    if (it.items) out.push(...flatten(it.items, label));
    else if (it.run) out.push({ label, note: it.note, icon: it.icon, danger: it.danger, disabled: it.disabled, run: it.run });
  }
  return out;
}

/**
 * What each kind of result can have done, made of what the app already does: the library tile's menu for a
 * render, the Projects panel's actions for projects, folders, timelines and drafts, the queue's own calls, the
 * timeline editor's buttons (through bridge.ts) and the open form. The bar adds no behaviour of its own.
 */
export function useBarActions({ subject, aim, settingCtx, onCopied }: {
  /** The render that is selected, read in full (its generation): the tile menu's actions are for it. */
  subject: Asset | null;
  aim: TimelineAim | null;
  settingCtx: SettingCtx;
  onCopied(text: string): void;
}) {
  const [, go] = useLocation();
  const client = useQueryClient();
  const say = useBanners((b) => b.push);
  const tree = useTreeActions();
  const projects = (useProjects().data?.items ?? []).filter((p) => !p.archivedAt);
  const queue = useQueue();
  const setup = useSetup();
  const modelSettings = useModelSettings();
  const openNew = useOpenNewDraft();
  const selectedClip = useSelectedClip((c) => c.clip);
  const draftOpen = useOpenDraft((d) => Boolean(d.id));
  const [viewing, setViewing] = useState<Asset | null>(null);
  const tile = useTileMenu({ onOpen: setViewing, subject });

  const failed = (title: string) => (err: unknown) => say({ id: `bar:${Date.now()}`, tone: "bad", title, text: err instanceof Error ? err.message : String(err), href: "/", go: "Open the Studio" });
  const good = (title: string, text?: string, href = "/", goTo = "Open the Studio") => say({ id: `bar:${Date.now()}`, tone: "good", title, text, href, go: goTo });

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
  const lookingAt = (project: string | null) => {
    const current = useProject.getState().id;
    if (current !== null && current !== (project ?? "none")) useProject.getState().set(project ?? "none");
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
    useStudio.getState().set({ place: a.folderId ? { type: "folder", id: a.folderId } : { type: "unfiled" } });
    useHandover.getState().set({ show: a.id });
    go("/");
  };
  /** A request left for the timeline editor, which is opened on it: the jobs a render queued come back. */
  const askTimeline = (t: TimelineAim, request: TimelineRequest) => {
    const answer = useTimelineRequest.getState().ask(request);
    go(`/timelines/${t.id}`);
    return answer;
  };
  /** The editor's render, then its jobs moved to the top of the queue as the queue's "Move to the top" does, in their order. */
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
    key: `${e.kind}:${e.id}`, kind: e.kind === "asset" ? "item" : e.kind, id: e.id, label: e.label, meta: "", bytes: null, depth: 0, prefix: "", foldable: false, open: false, parent: null,
    group: e.kind === "project" ? e.id : e.project, ...over,
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

  /** A command with its figures: what it does, then (Ctrl + Enter) where it does it. */
  const commandActions = (c: Command, recipe?: RecipeInfo): Action[] => {
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
          { label: `Render the missing clips of ${aim.name}`, icon: <Play size={14} />, note: "at the end of the queue", run: () => askTimeline(aim, { timeline: aim.id, do: "render-missing" }) },
          atTopAction(aim, { timeline: aim.id, do: "render-missing" }),
          { label: `Open ${aim.name}`, icon: <Film size={14} />, run: () => go(`/timelines/${aim.id}`) },
        ] : [noTimeline];
      case "export":
        return aim ? [
          { label: `Export ${aim.name}…`, icon: <FileOutput size={14} />, note: "the export dialog opens", run: () => askTimeline(aim, { timeline: aim.id, do: "export" }) },
          { label: `Open ${aim.name}`, icon: <Film size={14} />, run: () => go(`/timelines/${aim.id}`) },
        ] : [noTimeline];
      case "bin-unused": {
        const e = aim?.entry;
        return e ? [{ label: `Bin the unused takes of ${e.label}…`, icon: <Trash2 size={14} />, danger: true, disabled: !e.unusedTakes, note: e.unusedTakes ? `${e.unusedTakes} · ${size(e.unusedBytes)}` : "none", run: () => tree.binUnused(row(e, { unused: { takes: e.unusedTakes, bytes: e.unusedBytes } })) }] : [noTimeline];
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
          const value = c.cmd === "size" ? { width: c.width, height: c.height } : c.cmd === "length" ? c.seconds : c.value;
          if (spec.type === "number" && typeof value === "number" && (value < spec.min || value > spec.max)) return say({ id: "bar:form", tone: "bad", title: `${spec.label} goes from ${spec.min} to ${spec.max}`, href: "/", go: "Open the Studio" });
          t.set(spec.id, value);
          good(`${spec.label || c.cmd} set to ${c.cmd === "size" ? `${c.width}×${c.height}` : String(value)}`, `In the open draft (${t.recipe.title}).`);
        };
        const said = c.cmd === "size" ? `${c.width}×${c.height}` : c.cmd === "length" ? `${c.seconds} s` : String(c.value);
        return [{ label: `Set ${c.cmd === "cfg" ? "the CFG" : `the ${c.cmd}`} to ${said}`, icon: <PenLine size={14} />, note: "in the open draft", run: set }];
      }
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
      case "new-draft":
        if (!recipe) return [{ label: `No model called “${c.recipe}”`, disabled: true, run: () => {} }];
        return [{ label: `New draft on ${recipe.title}`, icon: <Sparkles size={14} />, run: () => api.createDraft({ recipe: recipe.id }).then(openNew, failed("Could not make the draft")) }];
      case "pause":
        return [{ label: "Pause the queue", icon: <Pause size={14} />, disabled: queue.data?.paused, note: queue.data?.paused ? "already paused" : undefined, run: () => api.pause().then((q) => client.setQueryData(["queue"], q), failed("Could not pause the queue")) }];
      case "resume":
        return [{ label: "Resume the queue", icon: <Play size={14} />, disabled: queue.data ? !queue.data.paused : false, note: queue.data && !queue.data.paused ? "it is running" : undefined, run: () => api.resume().then((q) => client.setQueryData(["queue"], q), failed("Could not resume the queue")) }];
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
            ? api.linkFolder(c.path, undefined, group).then((m) => { void client.invalidateQueries({ queryKey: ["projects"] }); good(`${m.name} linked: ${m.files ?? 0} files`, "Its files are used where they are; nothing was copied."); }, failed(`${c.path} could not be linked`))
            : tree.link(t)),
        }];
      }
      case "new-project":
        return [{
          label: `New project “${c.name}”`, icon: <FolderPlus size={14} />, note: "and work in it",
          run: () => api.createProject(c.name).then((p) => { void client.invalidateQueries({ queryKey: ["projects"] }); useProject.getState().set(p.id); good(`${p.name} made`, "You work in it now: what you make lands in its root folder."); }, failed("Could not make the project")),
        }];
    }
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
          ...moveTo({ kind: "draft", id: d.id, group: d.project, name: d.label }, d.project),
          { label: "Delete…", icon: <Trash2 size={14} />, danger: true, note: "what was made from it stays", run: () => tree.remove([row(d)]) },
        ];
      }
      case "render": {
        const a = e as Extract<CommandEntry, { kind: "asset" }>;
        const own = subject && subject.id === a.id ? flatten(tile.items(subject)).filter((x) => x.label !== "Open") : [];
        return [
          { label: a.assetKind === "audio" ? "Open" : "View", icon: <Eye size={14} />, run: () => view(a.id).catch(failed("Could not open it")) },
          { label: "Show in its folder", icon: <FolderOpen size={14} />, note: "in the Studio", run: () => showInFolder(a.id, a.project).catch(failed("Could not show it")) },
          ...(own.length ? own : [{ label: "Reading what was made with it…", disabled: true, run: () => {} }]),
        ];
      }
      case "project": {
        const p = e as Extract<CommandEntry, { kind: "project" }>;
        const r = row(p, { archived: p.archived });
        return [
          { label: p.archived ? "Unarchive it to work in it" : "Work in it", icon: <FolderKanban size={14} />, disabled: p.archived, note: "the library, drafts and timelines show its own", run: () => useProject.getState().set(p.id) },
          { label: "Show in Projects", icon: <FolderKanban size={14} />, run: () => openProjects(p.label) },
          { label: "Rename…", icon: <Pencil size={14} />, run: rename(p) },
          p.archived
            ? { label: "Unarchive", icon: <ArchiveRestore size={14} />, run: () => tree.archive(r, false) }
            : { label: "Archive", icon: <Archive size={14} />, note: "hides it, keeps everything", run: () => tree.archive(r, true) },
          { label: "Delete…", icon: <Trash2 size={14} />, danger: true, note: "its things go to the Inbox", run: () => tree.removeProject(r) },
        ];
      }
      case "folder": {
        const f = e as FolderEntry;
        const linkedRoot = f.linked && f.parent === null;
        return [
          { label: "Open in the library", icon: <FolderOpen size={14} />, run: () => openFolder(f.id, f.project) },
          { label: "Show in Projects", icon: <FolderKanban size={14} />, run: () => openProjects(f.label) },
          ...(!f.linked || linkedRoot ? [{ label: "Rename…", icon: <Pencil size={14} />, run: rename(f) }] : []),
          ...(!f.linked || linkedRoot ? moveTo({ kind: "folder", id: f.id, group: f.project, parent: f.parent, name: f.label, linkedRoot }, f.project) : []),
          ...(!f.linked || linkedRoot ? [{ label: f.linked ? "Unlink…" : "Delete…", icon: <Trash2 size={14} />, danger: true, note: f.linked ? "nothing on your disk is touched" : "its items move to the folder above", run: () => (f.linked ? tree.unlink(row(f, { linked: true, linkedRoot: true })) : tree.remove([row(f)])) }] : []),
        ];
      }
      case "command":
        if (it.command) return commandActions(it.command, it.recipe);
        return [];
      case "setting": {
        const s = it.setting!;
        const open: Action = { label: `Open Settings › ${pageLabel(s.page)}`, icon: <Settings2 size={14} />, run: () => go(pageHref(s.page)) };
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
      case "job": {
        const { job, state } = it.job!;
        const toQueue: Action = { label: "Open the queue", icon: <ListOrdered size={14} />, run: () => go("/queue") };
        const toDraft: Action[] = job.draftId ? [{ label: "Open its draft", icon: <PenLine size={14} />, run: () => openDraft(job.draftId!) }] : [];
        if (state === "running") return [toQueue, { label: "Stop it", icon: <X size={14} />, danger: true, note: "nothing is added", run: () => api.cancel(job.id).then(() => client.invalidateQueries({ queryKey: ["queue"] }), failed("Could not stop it")) }, ...toDraft];
        if (state === "waiting") {
          const ids = queue.data?.waiting.map((w) => w.id) ?? [];
          return [
            toQueue,
            { label: "Move to the top", icon: <ArrowUpToLine size={14} />, disabled: ids[0] === job.id, run: () => api.queueOrder(moved(ids, job.id, 0)).then((q) => client.setQueryData(["queue"], q), failed("Could not move it")) },
            { label: "Remove from the queue", icon: <X size={14} />, danger: true, run: () => api.cancel(job.id).then(() => client.invalidateQueries({ queryKey: ["queue"] }), failed("Could not remove it")) },
            ...toDraft,
          ];
        }
        return [
          { label: "Retry", icon: <RotateCcw size={14} />, note: "the same job again", run: () => api.retryJob(job.id).then(() => { void client.invalidateQueries({ queryKey: ["queue"] }); good(`${job.label} queued again`, undefined, "/queue", "Open queue"); }, failed("Could not retry it")) },
          toQueue,
          ...toDraft,
        ];
      }
      case "calc": {
        const c = it.card!;
        return [{ label: `Copy ${c.copy}`, icon: <Copy size={14} />, stay: true, run: () => navigator.clipboard?.writeText(c.copy).then(() => onCopied(c.copy), () => onCopied("")) }];
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
          { label: "Copy the prompt", icon: <Copy size={14} />, stay: true, run: () => navigator.clipboard?.writeText(h.prompt).then(() => onCopied("the prompt"), () => onCopied("")) },
        ];
      }
      case "person": {
        const p = it.person!;
        const toDraft: Action = {
          label: "Add to the open draft", icon: <UserPlus size={14} />, note: "its cast",
          run: async () => {
            const t = await form();
            if (!t?.setLook) return say({ id: "bar:form", tone: "bad", title: "No draft is open", href: "/", go: "Open the Studio" });
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
        return [
          ...toClip,
          ...(!clip || draftOpen ? [toDraft] : []),
          { label: "Open the Prompt kit", icon: <Clapperboard size={14} />, run: () => go("/kit") },
        ];
      }
    }
  };

  const element = (
    <>
      {tile.element}
      {viewing && <Suspense fallback={null}><Viewer asset={viewing} onClose={() => setViewing(null)} /></Suspense>}
    </>
  );
  return { actionsOf, element, reading: tile.reading };
}
