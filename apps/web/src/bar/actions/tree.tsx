import { Archive, ArchiveRestore, Download, ExternalLink, FileOutput, Film, FolderInput, FolderKanban, FolderOpen, FolderPlus, Layers, Pencil, PenLine, Pin, PinOff, Play, RefreshCw, Sparkles, Trash2, Upload, Wand2 } from "lucide-react";
import { api, type CommandEntry } from "../../api";
import { ask, askText } from "../../Confirm";
import { DRAFT_LIST } from "../../data";
import { size } from "../../format";
import { useProject } from "../../project";
import type { Moving, Row, Target } from "../../projects/tree";
import { formWhenOpen, openProjects, workflowEditHref } from "../bridge";
import type { Action, TimelineAim } from "../useActions";
import type { BarCtx, FolderEntry, TimelineEntry } from "./ctx";

/** The Projects panel's row of an entry, as its actions take them. */
export const row = (e: CommandEntry, over: Partial<Row> = {}): Row => ({
  key: `${e.kind}:${e.id}`, kind: e.kind === "asset" ? "item" : (e.kind as Row["kind"]), id: e.id, label: e.label, meta: "", bytes: null, depth: 0, prefix: "", foldable: false, open: false, parent: null,
  group: e.kind === "project" ? e.id : "project" in e ? e.project : null, ...over,
});

const targets = (x: BarCtx): Target[] => [
  ...x.projects.map((p): Target => ({ kind: "group", group: p.id, root: p.folderId, name: p.name })),
  { kind: "group", group: null, root: null, name: "the Inbox" },
];
const moveTo = (x: BarCtx, moving: Moving, from: string | null): Action[] =>
  targets(x).filter((t) => t.kind === "group" && t.group !== from).map((t) => ({
    label: `Move to ${t.name}`, icon: <FolderInput size={14} />, note: t.kind === "group" && t.group === null ? "out of every project" : undefined,
    run: () => x.tree.move([moving], t),
  }));
const rename = (x: BarCtx, e: CommandEntry) => async () => {
  const name = await askText({ title: `Rename ${e.label}`, value: e.label, placeholder: "A name", yes: "Rename" });
  if (name) await x.tree.rename(row(e), name);
};

/** A timeline: the editor's own buttons (through bridge.ts) and the Projects panel's menu on it. */
export function timelineActions(x: BarCtx, t: TimelineEntry): Action[] {
  const { go, tree, askTimeline } = x;
  const aimed: TimelineAim = { id: t.id, name: t.label, entry: t };
  return [
    { label: "Open in the editor", icon: <Film size={14} />, run: () => go(`/timelines/${t.id}`) },
    { label: "Show in Projects", icon: <FolderKanban size={14} />, run: () => openProjects(t.label) },
    { label: "Render missing clips", icon: <Play size={14} />, run: () => askTimeline(aimed, { timeline: t.id, do: "render-missing" }) },
    { label: "Export…", icon: <FileOutput size={14} />, note: t.exported ? "exported before" : undefined, run: () => askTimeline(aimed, { timeline: t.id, do: "export" }) },
    { label: "Finish…", icon: <Sparkles size={14} />, run: () => askTimeline(aimed, { timeline: t.id, do: "finish" }) },
    { label: "Fix all", icon: <Wand2 size={14} />, note: "what Needs attention lists", run: () => askTimeline(aimed, { timeline: t.id, do: "fix-all" }) },
    { label: "Bin unused takes…", icon: <Trash2 size={14} />, disabled: !t.unusedTakes, note: t.unusedTakes ? `${t.unusedTakes} · ${size(t.unusedBytes)}` : "none", run: () => tree.binUnused(row(t, { unused: { takes: t.unusedTakes, bytes: t.unusedBytes } })) },
    { label: "Rename…", icon: <Pencil size={14} />, run: rename(x, t) },
    ...moveTo(x, { kind: "timeline", id: t.id, group: t.project, folder: t.folder, name: t.label }, t.project),
    { label: "Delete…", icon: <Trash2 size={14} />, danger: true, note: "its videos stay in the library", run: () => tree.remove([row(t)]) },
  ];
}

/** A draft: opened in the Studio, generated again, and the Projects panel's menu on it. */
export function draftActions(x: BarCtx, d: Extract<CommandEntry, { kind: "draft" }>): Action[] {
  const { client, failed, openDraft } = x;
  return [
    { label: "Open in the Studio", icon: <PenLine size={14} />, run: () => openDraft(d.id) },
    { label: "Show in Projects", icon: <FolderKanban size={14} />, run: () => openProjects(d.label) },
    { label: "Generate again", icon: <Play size={14} />, note: "as its Generate button", run: () => formWhenOpen(d.id, () => openDraft(d.id)).then((t) => (t?.generate ? t.generate() : x.say({ id: "bar:gen", tone: "bad", title: "The draft could not be opened", href: "/", go: "Open the Studio" }))) },
    {
      label: "Duplicate", icon: <Layers size={14} />, note: "a new draft with its form",
      run: () => api.draft(d.id).then((y) => api.createDraft({ recipe: y.recipe, forms: y.forms, count: y.count, look: y.look, project: d.project })).then((made) => { void client.invalidateQueries({ queryKey: DRAFT_LIST }); x.openNew(made); }, failed("Could not duplicate the draft")),
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
    ...moveTo(x, { kind: "draft", id: d.id, group: d.project, name: d.label }, d.project),
    { label: "Delete…", icon: <Trash2 size={14} />, danger: true, note: "what was made from it stays", run: () => x.tree.remove([row(d)]) },
  ];
}

/** A project, or the Inbox (`inbox`): worked in, pinned, and the Projects panel's menu on it. */
export function projectActions(x: BarCtx, e: CommandEntry | undefined, inbox: boolean): Action[] {
  const { tree, pins } = x;
  // the Inbox: worked in like a project, as the Projects panel's row of it
  if (inbox) return [
    { label: "Work in it", icon: <FolderKanban size={14} />, note: "the library, drafts and timelines out of every project", run: () => useProject.getState().set("none") },
    { label: "Show in Projects", icon: <FolderKanban size={14} />, run: () => openProjects("Inbox") },
  ];
  const p = e as Extract<CommandEntry, { kind: "project" }>;
  const r = row(p, { archived: p.archived });
  const root = x.allProjects.find((y) => y.id === p.id)?.folderId ?? null;
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
    { label: "Import a folder here…", icon: <Upload size={14} />, note: root ? "copies it in" : "makes its root folder first", run: () => x.importInto({ kind: "group", group: p.id, root, name: p.label }) },
    { label: "Rename…", icon: <Pencil size={14} />, run: rename(x, p) },
    ...(p.archived ? [] : [{ label: "Archive", icon: <Archive size={14} />, note: "hides it, keeps everything", run: () => tree.archive(r, true) }]),
    { label: "Delete…", icon: <Trash2 size={14} />, danger: true, note: "its things go to the Inbox", run: () => tree.removeProject(r) },
  ];
}

/** A folder, of the library or linked from the disk: the Projects panel's menu on it. */
export function folderActions(x: BarCtx, f: FolderEntry): Action[] {
  const { tree } = x;
  const linkedRoot = f.linked && f.parent === null;
  return [
    { label: "Open in the library", icon: <FolderOpen size={14} />, run: () => x.openFolder(f.id, f.project) },
    { label: "Show in Projects", icon: <FolderKanban size={14} />, run: () => openProjects(f.label) },
    ...(f.linked ? [{ label: "Rescan", icon: <RefreshCw size={14} />, note: "what changed on your disk", run: () => tree.rescan(row(f, { linked: true })) }] : []),
    { label: "New folder inside…", icon: <FolderPlus size={14} />, note: f.linked ? "a new directory on your disk" : undefined, run: () => tree.newFolder({ name: f.label, parent: f.id, project: f.project }) },
    ...(!f.linked ? [{ label: "Import a folder here…", icon: <Upload size={14} />, note: "copies it in", run: () => x.importInto({ kind: "folder", id: f.id, group: f.project, linked: false, ancestors: [], name: f.label }) }] : []),
    ...(!f.linked || linkedRoot ? [{ label: "Rename…", icon: <Pencil size={14} />, run: rename(x, f) }] : []),
    ...(!f.linked || linkedRoot ? moveTo(x, { kind: "folder", id: f.id, group: f.project, parent: f.parent, name: f.label, linkedRoot }, f.project) : []),
    ...(!f.linked || linkedRoot ? [{ label: f.linked ? "Unlink…" : "Delete…", icon: <Trash2 size={14} />, danger: true, note: f.linked ? "nothing on your disk is touched" : "its items move to the folder above", run: () => (f.linked ? tree.unlink(row(f, { linked: true, linkedRoot: true })) : tree.remove([row(f)])) }] : []),
  ];
}

/** A workflow: the Workflows screen's row (Try it), then its menu. */
export function workflowActions(x: BarCtx, w: Extract<CommandEntry, { kind: "workflow" }>): Action[] {
  const { failed } = x;
  const ready = !w.problem && x.recipes.some((r) => r.id === w.id);
  const online = x.setup.data?.comfy.online ?? false;
  return [
    { label: "Try it", icon: <Play size={14} />, disabled: !ready, note: ready ? "the form, on a new draft" : "it cannot be built as mapped", run: () => api.createDraft({ recipe: w.id }).then(x.openNew, failed("Could not make the draft")) },
    { label: "Edit", icon: <Pencil size={14} />, note: "its mapping and form", run: () => x.go(workflowEditHref(w.id)) },
    { label: "Export", icon: <Download size={14} />, note: "a file another Afflatus imports", run: () => import("../../screens/Workflows").then((m) => m.share({ id: w.id, title: w.label })).catch(failed("Could not export it")) },
    { label: "Open in ComfyUI", icon: <ExternalLink size={14} />, disabled: !online, note: online ? undefined : "ComfyUI is not running", run: () => x.openWorkflow.mutate({ id: w.id, title: w.label }) },
    {
      label: "Remove…", icon: <Trash2 size={14} />, danger: true, note: "what it made stays in the library",
      run: async () => {
        if (!(await ask({ title: `Remove ${w.label}?`, text: "What you generated with it stays in your library.", yes: "Remove" }))) return;
        await api.deleteWorkflow(w.id).then(() => { for (const key of ["recipes", "setup", "workflows"]) void x.client.invalidateQueries({ queryKey: [key] }); x.reindex(); }, failed(`${w.label} could not be removed`));
      },
    },
  ];
}
