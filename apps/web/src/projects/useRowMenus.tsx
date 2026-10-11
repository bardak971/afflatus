import type { MouseEvent } from "react";
import { Archive, ArchiveRestore, Eraser, Film, Folder, FolderInput, FolderKanban, FolderOpen, FolderPlus, FolderRoot, Inbox, Layers, Link2, PenLine, Pencil, Pin, PinOff, RefreshCw, Trash2, Unlink, Upload } from "lucide-react";
import type { Asset, Folder as FolderInfo, Project, TreeGroup } from "../api";
import { useMenu, type MenuHead, type MenuItem } from "../ContextMenu";
import { size } from "../format";
import type { usePins } from "./pins";
import { planDrop, type Row, type Target } from "./tree";
import { useItemMenu } from "./useItemMenu";
import type { useTreeActions } from "./useTreeActions";
import { movingOf } from "./useTreeDrag";

/**
 * The Projects panel's right-click menus: one per kind of row, the menu of several picked rows ("Move 3 to", "Delete 3…"),
 * the library tile's own menu on an item, and the selection bar's "Move to".
 */
export function useRowMenus({ picked, rows, byKey, scoped, current, projects, folders, groups, binCount, binBytes, actions, pins, setProject, setOpen, setFocused, setClearAsk, clearPicks, activate, startRename, duplicate, remove, importInto, onView, showInStudio }: {
  picked: Map<string, Row>;
  rows: Row[];
  byKey: Map<string, Row>;
  /** One project's tree, under the library's breadcrumb: its menus are for working inside it. */
  scoped: boolean;
  /** The project worked in ("none": the Inbox). */
  current: string;
  projects: Project[];
  folders: FolderInfo[];
  groups: TreeGroup[];
  /** What the Bin holds, when it was read. */
  binCount: number;
  binBytes: number;
  actions: ReturnType<typeof useTreeActions>;
  pins: ReturnType<typeof usePins>;
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
  const targets: Target[] = [
    { kind: "group", group: null, root: null, name: "the Inbox" },
    ...projects.filter((p) => !p.archivedAt).map((p): Target => ({ kind: "group", group: p.id, root: p.folderId, name: p.name })),
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
      label: t.kind === "group" && t.group === null ? "Inbox" : t.name,
      icon: t.kind === "folder" ? <Folder size={14} /> : t.group === null ? <Inbox size={14} /> : <FolderKanban size={14} />,
      note: t.kind === "folder" ? projectName(t.group) : undefined,
      disabled: !planDrop(moving, t),
      run: () => void actions.move(moving, t).then(clearPicks),
    });
    const assets = moving.some((m) => m.kind === "asset");
    const others = moving.some((m) => m.kind !== "asset");
    return [...(others ? targets.map(item) : []), ...(assets && others ? ["—" as const] : []), ...(assets ? folderTargets().map(item) : [])];
  };

  // the right-click menus: one per kind of row, and the selection bar's "Move to"
  const { menu, open: openMenu, close: closeMenu } = useMenu<Row | "picked">();
  const menuItems = (r: Row | "picked"): MenuItem[] => {
    if (r === "picked") return moveItems([...picked.values()]);
    const rs = subjectOf(r);
    const many = rs.length > 1 ? ` ${rs.length}` : "";
    const moveTo: MenuItem = { label: `Move${many} to`, icon: <FolderInput size={14} />, items: moveItems(rs) };
    const del: MenuItem = { label: `Delete${many}…`, key: "Del", icon: <Trash2 size={14} />, danger: true, run: () => remove(rs) };
    const rename: MenuItem = { label: "Rename", key: "F2", icon: <Pencil size={14} />, run: () => startRename(r) };
    // the rail's pins: the Inbox and the projects that are not archived; the rail holds four
    const pin = (id: string): MenuItem =>
      pins.has(id)
        ? { label: "Unpin from the rail", icon: <PinOff size={14} />, run: () => pins.unpin(id) }
        : { label: "Pin to the rail", icon: <Pin size={14} />, disabled: pins.full || r.archived, note: r.archived ? "unarchive it first" : pins.full ? "the rail holds four" : "one click away", run: () => pins.pin(id) };
    switch (r.kind) {
      case "loose":
        return [{ label: "Open", key: "Enter", icon: <FolderOpen size={14} />, run: () => activate(r) }];
      case "inbox":
        return [
          scoped ? { label: "Open", key: "Enter", icon: <FolderOpen size={14} />, note: "the whole Inbox", run: () => activate(r) } : { label: "Work in it", key: "Enter", icon: <Inbox size={14} />, run: () => setProject("none") },
          ...(scoped ? [] : [pin("none")]),
          { label: "New folder inside…", icon: <FolderPlus size={14} />, run: () => void actions.newFolder({ name: "the Inbox", parent: null, project: null }).then((ok) => ok && setOpen(r.key, true)) },
          { label: "Import a folder here…", icon: <Upload size={14} />, note: "copies it in", run: () => r.target && importInto(r.target) },
          { label: "Link a disk folder…", icon: <Link2 size={14} />, note: "used in place", run: () => r.target && void actions.link(r.target) },
        ];
      case "project": {
        const g = groups.find((x) => x.id === r.id);
        const root = g?.rootFolderId ?? null;
        const make: MenuItem[] = [
          { label: "New folder inside…", icon: <FolderPlus size={14} />, run: () => void actions.newFolder({ name: r.label, parent: root, project: r.id }).then((ok) => ok && setOpen(r.key, true)) },
          ...(r.noRoot ? [{ label: "Make a root folder", icon: <FolderRoot size={14} />, note: "renders land there", run: () => void actions.setRoot({ id: r.id!, name: r.label }) }] : []),
          { label: "Import a folder here…", icon: <Upload size={14} />, note: r.noRoot ? "makes its root folder first" : "copies it in", run: () => r.target && importInto(r.target) },
          { label: "Link a disk folder…", icon: <Link2 size={14} />, note: "used in place", run: () => r.target && void actions.link(r.target) },
        ];
        // one project's tree is for working inside it: renaming, archiving and deleting projects stay in the Projects panel
        if (scoped) return [{ label: "Open", key: "Enter", icon: <FolderOpen size={14} />, note: "the whole project", run: () => activate(r) }, ...make];
        return [
          { label: "Work in it", key: "Enter", icon: <FolderKanban size={14} />, disabled: r.archived, note: r.archived ? "unarchive it first" : current === r.id ? "working in it" : undefined, run: () => setProject(r.id) },
          pin(r.id!),
          ...make,
          rename,
          "—",
          r.archived
            ? { label: "Unarchive", icon: <ArchiveRestore size={14} />, note: "show it again", run: () => actions.archive(r, false) }
            : { label: "Archive", icon: <Archive size={14} />, note: "hides it, keeps everything", run: () => actions.archive(r, true) },
          { label: "Delete…", key: "Del", icon: <Trash2 size={14} />, danger: true, note: "its items go to the Inbox", run: () => void actions.removeProject(r) },
        ];
      }
      case "folder":
        // a folder of the disk: opened, read again, and (the one that was linked) renamed or unlinked; it never nests
        if (r.linked)
          return [
            { label: "Open", key: "Enter", icon: <FolderOpen size={14} />, run: () => activate(r) },
            ...(r.missing ? [{ label: "Link again…", icon: <Link2 size={14} />, note: "where it is now", run: () => void actions.relink(r) }] : []),
            { label: "Rescan", icon: <RefreshCw size={14} />, disabled: r.missing, note: r.missing ? "not found on your disk" : "what changed on your disk", run: () => void actions.rescan(r) },
            ...(r.linkedRoot
              ? [rename, { ...moveTo, note: "to another project" }, "—" as const, { label: "Unlink…", icon: <Unlink size={14} />, danger: true, note: "nothing on your disk is touched", run: () => void actions.unlink(r) }]
              : []),
          ];
        return [
          { label: "Open", key: "Enter", icon: <FolderOpen size={14} />, run: () => activate(r) },
          { label: "New folder inside…", icon: <FolderPlus size={14} />, note: r.linked ? "a new directory on your disk" : undefined, run: () => void actions.newFolder({ name: r.label, parent: r.id, project: r.group }).then((ok) => ok && setOpen(r.key, true)) },
          ...(r.group && !r.linked ? [{ label: "Use as the project's root folder", icon: <FolderRoot size={14} />, note: "renders land there", run: () => void actions.setRoot({ id: r.group!, name: groups.find((x) => x.id === r.group)?.name ?? "The project" }, { id: r.id!, name: r.label }) }] : []),
          { label: "Import a folder inside…", icon: <Upload size={14} />, note: "copies it in", run: () => r.target && importInto(r.target) },
          rename,
          moveTo,
          "—",
          del,
        ];
      case "timeline":
        return [
          { label: "Open", key: "Enter", icon: <Film size={14} />, run: () => activate(r) },
          rename,
          moveTo,
          "—",
          { label: "Bin unused takes…", icon: <Trash2 size={14} />, danger: true, disabled: !r.unused, note: r.unused ? size(r.unused.bytes) : "none", run: () => void actions.binUnused(r) },
          del,
        ];
      case "draft":
        return [
          { label: "Open", key: "Enter", icon: <PenLine size={14} />, run: () => activate(r) },
          ...(rs.length > 1 ? [] : [rename, { label: "Duplicate", icon: <Layers size={14} />, note: "a new draft with its forms", run: () => duplicate(r) }]),
          moveTo,
          "—",
          del,
        ];
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
