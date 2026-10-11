import type { MouseEvent } from "react";
import { Eraser, Folder, FolderKanban, FolderOpen, Inbox, Trash2 } from "lucide-react";
import type { Asset, Folder as FolderInfo, Project, TreeGroup } from "../api";
import { useMenu, type MenuHead, type MenuItem } from "../ContextMenu";
import { size } from "../format";
import { planDrop, type Row, type Target } from "./tree";
import { toMenu, type KindAction, type KindActionId } from "./kindActions";
import { useItemMenu } from "./useItemMenu";
import { useKindActions, type KindPlace } from "./useKindActions";
import type { useTreeActions } from "./useTreeActions";
import { movingOf } from "./useTreeDrag";

/** In one project's tree, its row and the Inbox's keep only what makes something inside them: the rest is the panel's. */
const INSIDE: readonly KindActionId[] = ["open", "show", "pin", "rename", "archive", "delete"];

/**
 * The Projects panel's right-click menus: one per kind of row, the menu of several picked rows ("Move 3 to", "Delete 3…"),
 * the library tile's own menu on an item, and the selection bar's "Move to".
 */
export function useRowMenus({ picked, rows, byKey, scoped, projects, folders, groups, binCount, binBytes, actions, setProject, setOpen, setFocused, setClearAsk, clearPicks, activate, startRename, duplicate, remove, importInto, onView, showInStudio }: {
  picked: Map<string, Row>;
  rows: Row[];
  byKey: Map<string, Row>;
  /** One project's tree, under the library's breadcrumb: its menus are for working inside it. */
  scoped: boolean;
  projects: Project[];
  folders: FolderInfo[];
  groups: TreeGroup[];
  /** What the Bin holds, when it was read. */
  binCount: number;
  binBytes: number;
  actions: ReturnType<typeof useTreeActions>;
  setProject(id: string | null): void;
  setOpen(key: string, open: boolean): void;
  setFocused(key: string): void;
  /** Ask in place, on an empty-drafts row, whether to clear them. */
  setClearAsk(key: string): void;
  clearPicks(): void;
  /** What a plain click (or Enter) does on the row. */
  activate(r: Row): void;
  startRename(r: Row): void;
  /** A draft copied into its project, its copy's name box open. */
  duplicate(r: Row): void;
  remove(rs: Row[]): void;
  /** "Import a folder…" into that target: the computer's folder picker. */
  importInto(t: Target): void;
  onView(asset: Asset): void;
  /** An item shown in the Studio, in its folder. */
  showInStudio(a: Asset, group: string | null): void;
}) {

  // what is moved or deleted: the picked rows when the row is one of them, else the row alone
  const subjectOf = (r: Row): Row[] => (picked.has(r.key) && picked.size > 1 ? [...picked.values()] : [r]);
  // the projects, then the Inbox, as every Move to lists them (useKindActions)
  const targets: Target[] = [
    ...projects.filter((p) => !p.archivedAt).map((p): Target => ({ kind: "group", group: p.id, root: p.folderId, name: p.name })),
    { kind: "group", group: null, root: null, name: "the Inbox" },
  ];
  // items go to folders: every folder that is not one of the disk, by project, with its project said
  const projectName = (id: string | null) => (id ? projects.find((p) => p.id === id)?.name ?? "a project" : "Inbox");
  const folderTargets = (): Target[] => {
    const all = folders;
    const above = (id: string | null): string[] => {
      const out: string[] = [];
      for (let f = all.find((x) => x.id === id); f; f = f.parentId ? all.find((x) => x.id === f!.parentId) : undefined) out.unshift(f.id);
      return out;
    };
    return all
      .filter((f) => !f.path)
      .sort((a, b) => projectName(a.projectId).localeCompare(projectName(b.projectId)) || a.name.localeCompare(b.name))
      .map((f): Target => ({ kind: "folder", id: f.id, group: f.projectId, linked: false, ancestors: above(f.parentId), name: f.name }));
  };
  const moveItems = (rs: Row[]): MenuItem[] => {
    const moving = movingOf(rs);
    const item = (t: Target): MenuItem => ({
      label: t.kind === "group" && t.group === null ? "The Inbox" : t.name,
      icon: t.kind === "folder" ? <Folder size={14} /> : t.group === null ? <Inbox size={14} /> : <FolderKanban size={14} />,
      note: t.kind === "folder" ? projectName(t.group) : t.group === null ? "out of every project" : undefined,
      disabled: !planDrop(moving, t),
      run: () => void actions.move(moving, t).then(clearPicks),
    });
    const assets = moving.some((m) => m.kind === "asset");
    const others = moving.some((m) => m.kind !== "asset");
    return [...(others ? targets.map(item) : []), ...(assets && others ? ["—" as const] : []), ...(assets ? folderTargets().map(item) : [])];
  };

  // the right-click menus: one per kind of row, and the selection bar's "Move to"
  const kind = useKindActions({ importInto });
  const { menu, open: openMenu, close: closeMenu } = useMenu<Row | "picked">();
  const menuItems = (r: Row | "picked"): MenuItem[] => {
    if (r === "picked") return moveItems([...picked.values()]);
    const rs = subjectOf(r);
    // several kinds picked (a timeline and a draft, a folder): the kind's list builds its moves as the clicked row's kind,
    // so they go through the panel's own Move to, which keeps each row's kind
    const mixed = rs.some((x) => x.kind !== r.kind);
    // the kind's list (kindActions.tsx), without Show in Projects (it is here); the panel renames in the row, opens as a
    // click does, and drops the picks after a move or a delete
    const place: KindPlace = {
      hide: ["show", ...(mixed ? (["put"] as const) : [])],
      runs: {
        open: () => activate(r),
        rename: () => startRename(r),
        delete: () => remove(rs),
        "new-folder": () => void actions.newFolder({ name: r.kind === "inbox" ? "the Inbox" : r.label, parent: r.kind === "folder" ? r.id : r.kind === "project" ? groups.find((x) => x.id === r.id)?.rootFolderId ?? null : null, project: r.kind === "project" ? r.id : r.group }).then((ok) => ok && setOpen(r.key, true)),
        ...(r.target ? { import: () => importInto(r.target!), link: () => void actions.link(r.target!) } : {}),
      },
      // items among those picked go to folders, which only the panel's own Move to lists; it also keeps each row's kind
      subs: mixed || rs.some((x) => x.kind === "item") ? { move: moveItems(rs) } : undefined,
      done: clearPicks,
    };
    const menu = (list: KindAction[]) => toMenu(list, true);
    switch (r.kind) {
      case "loose":
        return [{ label: "Open", key: "Enter", icon: <FolderOpen size={14} />, run: () => activate(r) }];
      // one project's tree (under the library's breadcrumb) is for working inside it: what is made in it, nothing else
      case "inbox":
        return menu(kind.inbox({ ...place, hide: scoped ? INSIDE : place.hide, runs: { ...place.runs, open: () => setProject("none") } }));
      case "project":
        return menu(kind.project(
          { id: r.id!, name: r.label, archived: Boolean(r.archived), root: groups.find((x) => x.id === r.id)?.rootFolderId ?? null },
          { ...place, hide: scoped ? INSIDE : place.hide, runs: { ...place.runs, open: () => setProject(r.id) } },
        ));
      case "folder":
        return menu(kind.folder(rs.map((x) => ({ id: x.id!, name: x.label, project: x.group, parent: x.moving?.kind === "folder" ? x.moving.parent : null, linked: Boolean(x.linked), linkedRoot: Boolean(x.linkedRoot), missing: x.missing, path: x.path })), place));
      case "timeline":
        return menu(kind.timeline(rs.map((x) => ({ id: x.id!, name: x.label, project: x.group, folder: x.moving?.kind === "timeline" ? x.moving.folder : null, unused: x.unused ?? null })), place));
      case "draft":
        return menu(kind.draft(rs.map((x) => ({ id: x.id!, name: x.label, project: x.group })), { ...place, runs: { ...place.runs, duplicate: () => duplicate(r) } }));
      case "empty":
        return [{ label: `Clear ${r.label}…`, icon: <Eraser size={14} />, danger: true, note: "the open one stays", run: () => setClearAsk(r.key) }];
      case "item": {
        const several = pickedItems();
        return itemMenu.many(several.map((x) => x.asset!), { moveTo: moveItems(several), bin: () => void actions.bin(several).then(clearPicks) });
      }
      case "bin":
        return [
          { label: "Open the bin", key: "Enter", icon: <Trash2 size={14} />, run: () => activate(r) },
          ...(binCount ? ["—" as const, { label: "Empty the bin…", icon: <Trash2 size={14} />, danger: true, note: size(binBytes), run: () => void actions.emptyBin() }] : []),
        ];
      default:
        return [];
    }
  };
  /** The head of a row's menu: its name and what it holds; several picked: how many. */
  const menuHead = (r: Row | "picked"): MenuHead => {
    const n = r === "picked" ? picked.size : r.key === "picked-items" ? pickedItems().length : subjectOf(r).length;
    return r === "picked" || n > 1 ? { title: `${n} items` } : { title: r.label, sub: r.meta || undefined };
  };
  // an item: the library tile's own menu; one of several picked items: a menu for them all
  const itemMenu = useItemMenu({ onView, onStudio: (a) => showInStudio(a, byKey.get(`a:${a.id}`)?.group ?? null) });
  const pickedItems = () => {
    const order = new Map(rows.map((x, i) => [x.key, i]));
    return [...picked.values()].filter((x) => x.kind === "item" && x.asset).sort((x, y) => (order.get(x.key) ?? Infinity) - (order.get(y.key) ?? Infinity));
  };
  const openRowMenu = (r: Row, e: { preventDefault(): void; clientX: number; clientY: number; currentTarget?: EventTarget | null }) => {
    setFocused(r.key);
    if (r.kind === "item" && r.asset) {
      const several = pickedItems();
      if (picked.has(r.key) && several.length > 1) return openMenu(e, { ...r, key: "picked-items" });
      return itemMenu.open(e, r.asset);
    }
    if (!menuItems(r).length) return e.preventDefault();
    openMenu(e, r);
  };
  const rowMenu = (r: Row, e: MouseEvent) => openRowMenu(r, e);
  return { menu, openMenu, closeMenu, menuItems, menuHead, itemMenu, pickedItems, openRowMenu, rowMenu };
}
