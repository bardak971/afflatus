import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Folder, FolderKanban, Inbox } from "lucide-react";
import { askText } from "../Confirm";
import type { MenuItem } from "../ContextMenu";
import { useFolders, useProjects } from "../data";
import { duplicateDraft, useOpenNewDraft } from "../draft";
import { formWhenOpen, openProjects, useTimelineRequest, type TimelineRequest } from "../bar/bridge";
import { useProject } from "../project";
import { queryKeys } from "../queryKeys";
import { useSayFailed } from "../sayFailed";
import { useBanners, useOpenDraft, useStudio } from "../store";
import { kindActions, type KindAction, type KindActionId, type KindFacts, type KindRuns, type KindSubs } from "./kindActions";
import { usePins } from "./pins";
import { planDrop, type Moving, type Row, type Target } from "./tree";
import { useTreeActions } from "./useTreeActions";

/** A timeline, as every place knows it; what a place does not know (its clips to render, its unused takes) is left out. */
export interface TimelineSubject {
  id: string;
  name: string;
  project: string | null;
  folder: string | null;
  clips?: number;
  toRender?: number;
  exported?: boolean;
  /** Null: none; left out while it is read. */
  unused?: { takes: number; bytes: number } | null | "unread";
}
export interface DraftSubject { id: string; name: string; project: string | null }
export interface FolderSubject {
  id: string;
  name: string;
  project: string | null;
  parent: string | null;
  linked: boolean;
  /** A folder of the disk that was linked itself (not one of its sub-folders). */
  linkedRoot?: boolean;
  missing?: boolean;
  path?: string;
}
export interface ProjectSubject { id: string; name: string; archived: boolean; root: string | null }

/**
 * What a place changes in the list: what it leaves out (`hide`), and the few runs it does its own way (the Projects
 * panel renames in its row, the drafts list switches draft as its own click does). `done` runs after a move or a delete
 * (a selection dropped).
 */
export interface KindPlace {
  hide?: readonly KindActionId[];
  runs?: KindRuns;
  subs?: KindSubs;
  done?(): void;
}

/** The Projects panel's row of a thing, as the tree's actions (useTreeActions) take it. */
export const rowOf = (kind: Row["kind"], id: string, label: string, group: string | null, over: Partial<Row> = {}): Row => ({
  key: `${kind}:${id}`, kind, id, label, meta: "", bytes: null, depth: 0, prefix: "", foldable: false, open: false, parent: null, group, ...over,
});

/**
 * The lists of kindActions.tsx with what each action does, for every place that shows them: a timeline card, a row of
 * the Projects panel, the command bar, the Studio's drafts list. Each builder takes the one, or the several picked, it
 * acts on. `importInto` is the place's folder picker ("Import a folder here…"), where it has one.
 */
export function useKindActions({ importInto }: { importInto?(t: Target): void } = {}) {
  const tree = useTreeActions();
  const [, go] = useLocation();
  const client = useQueryClient();
  const pins = usePins();
  const working = useProject((s) => s.id);
  const setProject = useProject((s) => s.set);
  const openNew = useOpenNewDraft();
  const say = useBanners((b) => b.push);
  const failed = useSayFailed({ id: "kind-actions", go: "Open the Studio" });
  const allProjects = useProjects().data?.items ?? [];
  const projects = allProjects.filter((p) => !p.archivedAt);
  const folders = useFolders().data?.items ?? [];
  const rootOf = (project: string | null) => (project ? allProjects.find((p) => p.id === project)?.folderId ?? null : null);

  const after = (p: KindPlace, work: Promise<unknown>) => void work.then(() => p.done?.());
  const rename = (row: Row) => async () => {
    const name = await askText({ title: `Rename ${row.label}`, value: row.label, placeholder: "A name", yes: "Rename" });
    if (name) await tree.rename(row, name);
  };
  const line = (moving: Moving[], t: Target, label: string, icon: ReactNode, p: KindPlace, note?: string): MenuItem => ({
    label, icon, note, disabled: !planDrop(moving, t), run: () => after(p, tree.move(moving, t)),
  });
  /** Move to: every project not archived, then the Inbox; where it already is, off. */
  const moves = (moving: Moving[], p: KindPlace): MenuItem[] => [
    ...projects.map((x) => line(moving, { kind: "group", group: x.id, root: x.folderId, name: x.name }, x.name, <FolderKanban size={14} />, p)),
    line(moving, { kind: "group", group: null, root: null, name: "the Inbox" }, "The Inbox", <Inbox size={14} />, p, "out of every project"),
  ];
  /** Put in a folder: the folders of the project it is in (not those of the disk), then its root. */
  const puts = (moving: Moving[], project: string | null, p: KindPlace): MenuItem[] => {
    const root = rootOf(project);
    const own = folders.filter((f) => f.projectId === project && !f.path && f.id !== root).sort((a, b) => a.name.localeCompare(b.name));
    if (!own.length) return [];
    const name = project ? allProjects.find((x) => x.id === project)?.name ?? "the project" : "the Inbox";
    return [
      ...own.map((f) => line(moving, { kind: "folder", id: f.id, group: project, linked: false, ancestors: [], name: f.name }, f.name, <Folder size={14} />, p)),
      "—",
      line(moving, { kind: "group", group: project, root, name }, project ? "The project's root" : "No folder", <Folder size={14} />, p),
    ];
  };
  const list = (facts: KindFacts, runs: KindRuns, subs: KindSubs, p: KindPlace): KindAction[] =>
    kindActions(facts, { ...runs, ...p.runs }, { ...subs, ...p.subs }, p.hide);

  /** A request left for the timeline editor, which is opened on it (as the command bar's timeline commands). */
  const inEditor = (id: string, request: TimelineRequest) => () => {
    void useTimelineRequest.getState().ask(request);
    go(`/timelines/${id}`);
  };

  return {
    timeline(ts: TimelineSubject[], p: KindPlace = {}): KindAction[] {
      const t = ts[0]!;
      const rows = ts.map((x) => rowOf("timeline", x.id, x.name, x.project, { unused: x.unused && x.unused !== "unread" ? x.unused : undefined }));
      const moving: Moving[] = ts.map((x) => ({ kind: "timeline", id: x.id, group: x.project, folder: x.folder, name: x.name }));
      return list(
        { kind: "timeline", count: ts.length, clips: t.clips, toRender: t.toRender, exported: t.exported, unused: t.unused },
        {
          open: () => go(`/timelines/${t.id}`),
          show: () => openProjects(t.name),
          "render-missing": inEditor(t.id, { timeline: t.id, do: "render-missing" }),
          finish: inEditor(t.id, { timeline: t.id, do: "finish" }),
          export: inEditor(t.id, { timeline: t.id, do: "export" }),
          "fix-all": inEditor(t.id, { timeline: t.id, do: "fix-all" }),
          rename: rename(rows[0]!),
          "bin-unused": () => void tree.binUnused(rows[0]!),
          delete: () => after(p, tree.remove(rows)),
        },
        { move: moves(moving, p), put: puts(moving, t.project, p) },
        p,
      );
    },
    draft(ds: DraftSubject[], p: KindPlace = {}): KindAction[] {
      const d = ds[0]!;
      const rows = ds.map((x) => rowOf("draft", x.id, x.name, x.project));
      const open = () => {
        useOpenDraft.getState().open(d.id);
        useStudio.getState().set({ form: true, scope: "draft" });
        go("/");
      };
      return list(
        { kind: "draft", count: ds.length },
        {
          open,
          show: () => openProjects(d.name),
          generate: () => void formWhenOpen(d.id, open).then((t) => (t?.generate ? t.generate() : say({ id: "kind:gen", tone: "bad", title: "The draft could not be opened", href: "/", go: "Open the Studio" }))),
          duplicate: () => void duplicateDraft(d.id).then((made) => { void client.invalidateQueries({ queryKey: queryKeys.drafts.lists() }); openNew(made); }, failed("Could not duplicate the draft")),
          rename: rename(rows[0]!),
          delete: () => after(p, tree.remove(rows)),
        },
        { move: moves(ds.map((x) => ({ kind: "draft", id: x.id, group: x.project, name: x.name })), p) },
        p,
      );
    },
    folder(fs: FolderSubject[], p: KindPlace = {}): KindAction[] {
      const f = fs[0]!;
      const linkedRoot = f.linked && (f.linkedRoot ?? f.parent === null);
      const rows = fs.map((x) => rowOf("folder", x.id, x.name, x.project, { linked: x.linked, linkedRoot: x.linked && (x.linkedRoot ?? x.parent === null), missing: x.missing, path: x.path }));
      const target: Target = { kind: "folder", id: f.id, group: f.project, linked: f.linked, ancestors: [], name: f.name };
      return list(
        { kind: f.linked ? "linked" : "folder", count: fs.length, inProject: f.project !== null, sub: f.linked && !linkedRoot, missing: f.missing },
        {
          open: () => {
            if (working !== (f.project ?? "none")) setProject(f.project ?? "none");
            useStudio.getState().set({ place: { type: "folder", id: f.id } });
            go("/");
          },
          show: () => openProjects(f.name),
          "new-folder": () => void tree.newFolder({ name: f.name, parent: f.id, project: f.project }),
          ...(importInto ? { import: () => importInto(target) } : {}),
          root: () => f.project && void tree.setRoot({ id: f.project, name: allProjects.find((x) => x.id === f.project)?.name ?? "The project" }, { id: f.id, name: f.name }),
          rescan: () => void tree.rescan(rows[0]!),
          relink: () => void tree.relink(rows[0]!),
          rename: rename(rows[0]!),
          unlink: () => void tree.unlink(rows[0]!),
          delete: () => after(p, tree.remove(rows)),
        },
        { move: moves(fs.map((x) => ({ kind: "folder", id: x.id, group: x.project, parent: x.parent, name: x.name, linkedRoot: x.linked && (x.linkedRoot ?? x.parent === null) })), p) },
        p,
      );
    },
    project(x: ProjectSubject, p: KindPlace = {}): KindAction[] {
      const row = rowOf("project", x.id, x.name, x.id, { archived: x.archived, noRoot: !x.root });
      const target: Target = { kind: "group", group: x.id, root: x.root, name: x.name };
      return list(
        { kind: "project", archived: x.archived, hasRoot: Boolean(x.root), pinned: pins.has(x.id), pinsFull: pins.full, working: working === x.id },
        {
          open: () => setProject(x.id),
          show: () => openProjects(x.name),
          pin: () => (pins.has(x.id) ? pins.unpin(x.id) : pins.pin(x.id)),
          "new-folder": () => void tree.newFolder({ name: x.name, parent: x.root, project: x.id }),
          ...(importInto ? { import: () => importInto(target) } : {}),
          link: () => void tree.link(target),
          root: () => void tree.setRoot({ id: x.id, name: x.name }),
          rename: rename(row),
          archive: () => tree.archive(row, !x.archived),
          delete: () => void tree.removeProject(row),
        },
        {},
        p,
      );
    },
    inbox(p: KindPlace = {}): KindAction[] {
      const target: Target = { kind: "group", group: null, root: null, name: "the Inbox" };
      return list(
        { kind: "inbox", pinned: pins.has("none"), pinsFull: pins.full, working: working === "none" },
        {
          open: () => setProject("none"),
          show: () => openProjects("Inbox"),
          pin: () => (pins.has("none") ? pins.unpin("none") : pins.pin("none")),
          "new-folder": () => void tree.newFolder({ name: "the Inbox", parent: null, project: null }),
          ...(importInto ? { import: () => importInto(target) } : {}),
          link: () => void tree.link(target),
        },
        {},
        p,
      );
    },
  };
}
