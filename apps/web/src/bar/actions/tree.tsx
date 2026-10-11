import { Download, ExternalLink, Pencil, Play, Trash2 } from "lucide-react";
import { api, type CommandEntry } from "../../api";
import { ask } from "../../Confirm";
import { toBar } from "../../projects/kindActions";
import type { Row } from "../../projects/tree";
import { rowOf } from "../../projects/useKindActions";
import { workflowEditHref } from "../bridge";
import type { Action, BarCtx, FolderEntry, TimelineEntry } from "./ctx";
import { queryKeys } from "../../queryKeys";

/** The Projects panel's row of an entry, as its actions take them. */
export const row = (e: CommandEntry, over: Partial<Row> = {}): Row =>
  rowOf(e.kind === "asset" ? "item" : (e.kind as Row["kind"]), e.id, e.label, e.kind === "project" ? e.id : "project" in e ? e.project : null, over);

/** A timeline: the list every place shows (projects/kindActions.tsx), a submenu as a row per target. */
export const timelineActions = (x: BarCtx, t: TimelineEntry): Action[] =>
  toBar(x.kinds.timeline([{ id: t.id, name: t.label, project: t.project, folder: t.folder, clips: t.clips, exported: t.exported, unused: t.unusedTakes ? { takes: t.unusedTakes, bytes: t.unusedBytes } : null }]));

/** A draft: the list every place shows. */
export const draftActions = (x: BarCtx, d: Extract<CommandEntry, { kind: "draft" }>): Action[] => toBar(x.kinds.draft([{ id: d.id, name: d.label, project: d.project }]));

/** A project, or the Inbox (`inbox`): the list every place shows. */
export function projectActions(x: BarCtx, e: CommandEntry | undefined, inbox: boolean): Action[] {
  if (inbox || !e) return toBar(x.kinds.inbox());
  const p = e as Extract<CommandEntry, { kind: "project" }>;
  return toBar(x.kinds.project({ id: p.id, name: p.label, archived: p.archived, root: x.allProjects.find((y) => y.id === p.id)?.folderId ?? null }));
}

/** A folder, of the library or linked from the disk: the list every place shows. */
export const folderActions = (x: BarCtx, f: FolderEntry): Action[] =>
  toBar(x.kinds.folder([{ id: f.id, name: f.label, project: f.project, parent: f.parent, linked: f.linked }]));

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
        await api.deleteWorkflow(w.id).then(() => { for (const queryKey of [queryKeys.recipes(), queryKeys.setup(), queryKeys.workflows()]) void x.client.invalidateQueries({ queryKey }); x.reindex(); }, failed(`${w.label} could not be removed`));
      },
    },
  ];
}
