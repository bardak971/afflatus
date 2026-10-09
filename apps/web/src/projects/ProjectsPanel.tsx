import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { keepPreviousData, useQueries, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, Check, ChevronRight, CircleDashed, Eraser, Film, Folder, FolderInput, FolderKanban, FolderOpen, FolderPlus, FolderRoot, FolderSymlink, Globe, Inbox, Link2, List, Music, RefreshCw, Unlink, PenLine, Pencil, Plus, Search, Trash2, Upload } from "lucide-react";
import { api, thumbUrl, type Asset, type DraftLeaf } from "../api";
import { ContextMenu, useMenu, type MenuHead, type MenuItem } from "../ContextMenu";
import { DRAFT_LIST, useFolders, useProjects, useProjectsTree, useRecipes, useStorage } from "../data";
import { recipeLabel, size } from "../format";
import { useProject } from "../project";
import { useHandover, useOpenDraft, useStudio } from "../store";
import { Button, cx, ErrorNote, Help, Segmented, TwoStep } from "../ui";
import { DEFAULT_SORT, draftsKey, flatten, groupKey, itemsOrder, nextSort, planBin, planDrop, rangePick, rowHeight, rowOffsets, rowWindow, shortDate, siblings, step, whyRefused, type DraftsRead, type ItemKind, type ItemsRead, type Moving, type Row, type Sort, type Target } from "./tree";
import { useItemMenu } from "./useItemMenu";
import { useTreeActions } from "./useTreeActions";

/** Which rows are unfolded, kept per browser. */
const FOLDS = "afflatus.projects.open";
/** Which kind of item the folders show and count, kept per browser. */
const KIND = "afflatus.projects.kind";
const KINDS = [{ value: "all", label: "All" }, { value: "image", label: "Images" }, { value: "video", label: "Videos" }, { value: "audio", label: "Audio" }] as const;
const readKind = (): ItemKind | null => {
  try {
    const v = localStorage.getItem(KIND);
    return v === "image" || v === "video" || v === "audio" ? v : null;
  } catch {
    return null;
  }
};
/** The column the rows are sorted by, and which way, kept per browser. */
const SORT = "afflatus.projects.sort";
const readSort = (): Sort => {
  try {
    const v = JSON.parse(localStorage.getItem(SORT) ?? "null") as Partial<Sort> | null;
    return v && (v.by === "name" || v.by === "created" || v.by === "size") ? { by: v.by, desc: Boolean(v.desc) } : DEFAULT_SORT;
  } catch {
    return DEFAULT_SORT;
  }
};
/** The columns of every row, under their heads: Name · Holds · Created · Size. */
const COLUMNS = "grid-cols-[minmax(160px,1fr)_minmax(0,300px)_84px_72px]";
const readFolds = (): Record<string, boolean> => {
  try {
    const v = JSON.parse(localStorage.getItem(FOLDS) ?? "{}") as unknown;
    return v && typeof v === "object" ? (v as Record<string, boolean>) : {};
  } catch {
    return {};
  }
};
const DRAFTS_PAGE = 50;
/** A folder's items are read 50 at a time. */
const ITEMS_PAGE = 50;
/** Rows drawn above and below those in sight: a long list draws only these (a folder of thousands of items stays quick). */
const OVERSCAN = 10;
/** How near the top or the foot of the list a drag scrolls it, in px. */
const EDGE = 32;
/** Something open over the panel that keeps its own keys and clicks: a menu, a dialog. */
const OVER = "[role=menu], [role=dialog][aria-modal=true]";
const HELP =
  "Your projects as a tree: their folders, timelines and drafts, with what each holds and its size. Click All, the Inbox or a project to work in it (the library, the drafts and the timelines then show its own); click a folder, a timeline or a draft to open it. Ctrl + click or Shift + click picks several. Drag rows onto a project, the Inbox or a folder to move them there: a timeline takes its takes and export along. Files dropped from your computer are imported where they land; onto a linked folder they are written into it on disk (never over a file: \"name (2).png\"). Unfold a folder to see its items; click one to see it large. Right-click for rename, archive, delete and the root folder: a project's root folder is where what you make lands when no other folder of it is open. Click Name, Created or Size to sort each level by it, again to reverse it: folders stay first. Drafts with no prompt, no name and nothing rendered fold into one row of empty drafts; its Clear deletes them (the open draft stays).";

const ICONS: Record<Row["kind"], { icon: ReactNode; tone: string }> = {
  all: { icon: <Globe size={16} />, tone: "text-ink-2" },
  inbox: { icon: <Inbox size={16} />, tone: "text-ink-2" },
  project: { icon: <FolderKanban size={16} />, tone: "text-accent" },
  archive: { icon: <Archive size={16} />, tone: "text-ink-3" },
  folder: { icon: <Folder size={16} />, tone: "text-picture" },
  item: { icon: <Music size={14} />, tone: "text-ink-2" },
  bin: { icon: <Trash2 size={16} />, tone: "text-ink-2" },
  timeline: { icon: <Film size={16} />, tone: "text-warn-ink" },
  drafts: { icon: <List size={16} />, tone: "text-ink-2" },
  draft: { icon: <PenLine size={14} />, tone: "text-ink-3" },
  empty: { icon: <CircleDashed size={14} />, tone: "text-ink-3" },
  more: { icon: null, tone: "" },
};
/** A folder of the disk: its own icon and colour, on it and on every folder under it. */
const LINKED = { icon: <FolderSymlink size={16} />, tone: "text-good" };

/** The text with what was searched for marked in it. */
function Lit({ text, q }: { text: string; q: string }) {
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark className="rounded-[3px] bg-accent/30 px-px text-ink-strong">{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

/**
 * The Projects panel, beside the rail: every project as a tree of its folders, timelines and drafts.
 * A click switches to a project or opens what it is; Ctrl / Shift + click picks several; rows are dragged
 * onto a project, the Inbox or a folder to move them; a right-click gives the rest. Escape or a click
 * elsewhere closes it; a menu or a question opened from it does not.
 */
export function ProjectsPanel({ anchor, onClose, onNew, onView, hidden, search: searchFor }: {
  anchor: RefObject<HTMLElement | null>;
  /** What the search starts on (a name the command bar was asked to show). */
  search?: string;
  onClose(): void;
  onNew(): void;
  /** An item clicked: shown large in the Viewer, the panel kept underneath. */
  onView(asset: Asset): void;
  /** Kept as it is but not shown, while the Viewer is over it. */
  hidden?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  // the part of the list in sight, from its first row's top: a long list draws only the rows there
  const head = useRef<HTMLDivElement>(null);
  const firstGap = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 1200 });
  const measure = () => {
    const el = list.current;
    if (!el) return;
    const top = el.scrollTop - (firstGap.current?.offsetTop ?? 0);
    const height = el.clientHeight;
    setView((v) => (v.top === top && v.height === height ? v : { top, height }));
  };
  const search = useRef<HTMLInputElement>(null);
  const [, go] = useLocation();
  const current = useProject((s) => s.id);
  const setProject = useProject((s) => s.set);
  const openDraftId = useOpenDraft((s) => s.id);
  const recipes = useRecipes();
  const projects = useProjects();
  const folders = useFolders();
  const storage = useStorage();
  const actions = useTreeActions();
  const client = useQueryClient();
  // "Import a folder…": the computer's folder picker, and where what it picks goes
  const picker = useRef<HTMLInputElement>(null);
  const importTo = useRef<Target | null>(null);
  const importInto = (t: Target) => {
    importTo.current = t;
    picker.current?.click();
  };

  // where it sits: beside the rail, level with its button, inside the window
  const [place, setPlace] = useState<{ left: number; top: number; width: number; maxHeight: number; arrow: number } | null>(null);
  useLayoutEffect(() => {
    const at = () => {
      const r = anchor.current?.getBoundingClientRect();
      if (!r) return;
      const rail = anchor.current?.closest("nav")?.getBoundingClientRect().right ?? r.right;
      const left = rail + 8;
      const top = Math.max(8, r.top - 12);
      // wide screens: up to 1100 px, so long names keep more of themselves; never past 80 % of the window
      setPlace({ left, top, width: Math.max(320, Math.min(1100, Math.round(window.innerWidth * 0.8), window.innerWidth - left - 8)), maxHeight: Math.min(window.innerHeight * 0.8, window.innerHeight - top - 8), arrow: r.top + r.height / 2 - top });
    };
    at();
    window.addEventListener("resize", at);
    return () => window.removeEventListener("resize", at);
  }, [anchor]);
  // a click elsewhere closes it; not one on its button, a menu opened from it, or a question asked over it
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      const t = e.target as Element;
      if (panel.current?.contains(t) || anchor.current?.contains(t) || t.closest?.("[data-floating], [role=dialog][aria-modal=true]")) return;
      onClose();
    };
    window.addEventListener("pointerdown", outside, true);
    return () => window.removeEventListener("pointerdown", outside, true);
  }, [anchor, onClose]);

  // a dialog opened from it that sits lower than it (Add to a timeline, the Viewer's): the panel steps aside until it closes
  const [covered, setCovered] = useState(false);
  useEffect(() => {
    const look = () => setCovered([...document.querySelectorAll<HTMLElement>("body > [role=dialog][aria-modal=true]")].some((d) => (Number.parseInt(getComputedStyle(d).zIndex, 10) || 0) < 66));
    look();
    const watch = new MutationObserver(look);
    watch.observe(document.body, { childList: true });
    return () => watch.disconnect();
  }, []);

  // the search: what is typed, and what is asked for a quarter second after the last key
  const [text, setText] = useState(searchFor ?? "");
  const [q, setQ] = useState(searchFor?.trim().slice(0, 100) ?? "");
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim().slice(0, 100)), 250);
    return () => clearTimeout(t);
  }, [text]);
  const [kind, setKindState] = useState<ItemKind | null>(readKind);
  const setKind = (k: ItemKind | null) => {
    setKindState(k);
    try {
      if (k) localStorage.setItem(KIND, k);
      else localStorage.removeItem(KIND);
    } catch {
      // not kept: it starts on All next time
    }
  };
  const tree = useProjectsTree(q, kind);
  const [sort, setSortState] = useState<Sort>(readSort);
  const sortBy = (by: Sort["by"]) => {
    const next = nextSort(sort, by);
    setSortState(next);
    try {
      localStorage.setItem(SORT, JSON.stringify(next));
    } catch {
      // not kept: newest first next time
    }
  };

  // unfolded rows: kept per browser; while searching every branch is open unless folded then
  const [folds, setFolds] = useState(readFolds);
  const [searchFolded, setSearchFolded] = useState<Set<string>>(new Set());
  useEffect(() => setSearchFolded(new Set()), [q]);
  const currentKey = current === null ? null : groupKey({ id: current === "none" ? null : current });
  const isOpen = (key: string) => (q ? !searchFolded.has(key) : folds[key] ?? key === currentKey);
  const setOpen = (key: string, open: boolean) => {
    if (q) {
      setSearchFolded((s) => {
        const n = new Set(s);
        if (open) n.delete(key);
        else n.add(key);
        return n;
      });
      return;
    }
    setFolds((f) => {
      const n = { ...f, [key]: open };
      try {
        localStorage.setItem(FOLDS, JSON.stringify(n));
      } catch {
        // not kept: it opens folded next time
      }
      return n;
    });
  };

  // the drafts of each group whose drafts row is open, read when it opens
  const groups = tree.data?.groups ?? [];
  const draftGroups = q ? [] : groups.filter((g) => g.counts.drafts > 0 && isOpen(draftsKey(g.id)) && isOpen(groupKey(g)) && (!g.archived || isOpen("archived")));
  const draftReads = useQueries({
    queries: draftGroups.map((g) => ({ queryKey: [...DRAFT_LIST, "tree", g.id ?? "none"], queryFn: ({ signal }: { signal: AbortSignal }) => api.draftsOf(g.id, { signal }) })),
  });
  const [limits, setLimits] = useState<Record<string, number>>({});
  const drafts = new Map<string, DraftsRead>(
    draftGroups.map((g, i) => {
      // every one: the unused ones (the empty "New draft" among them) fold into the group's empty-drafts row
      const items = draftReads[i]?.data?.items ?? null;
      return [draftsKey(g.id), { items, limit: limits[draftsKey(g.id)] ?? DRAFTS_PAGE }];
    }),
  );
  const recipeName = (id: string) => {
    const r = recipes.data?.recipes.find((x) => x.id === id);
    return r ? recipeLabel(recipes.data?.families.find((f) => f.id === r.family)?.name, r.title) : id;
  };
  const draftMeta = (d: DraftLeaf) => `${recipeName(d.recipe)}${d.outputs ? ` · ${d.outputs} render${d.outputs === 1 ? "" : "s"}` : ""}`;
  // the items of each unfolded folder that is shown, read when it opens (the folders shown do not depend on items: they come first)
  const [itemPages, setItemPages] = useState<Record<string, number>>({});
  const openFolders = useMemo(
    () => (tree.data && !q ? flatten(tree.data, { isOpen, drafts: () => undefined }).filter((r) => r.kind === "folder" && r.open && r.id) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tree.data, folds, q, current],
  );
  const itemReads = useQueries({
    queries: openFolders.map((f) => {
      const pages = itemPages[f.key] ?? 1;
      return {
        queryKey: ["assets", "tree", f.id, kind, pages, sort.by, sort.desc],
        queryFn: async ({ signal }: { signal: AbortSignal }) => {
          const items: Asset[] = [];
          let after: string | undefined;
          for (let i = 0; i < pages; i++) {
            const page = await api.assets({ folder: f.id!, limit: ITEMS_PAGE, after, ...itemsOrder(sort), ...(kind ? { kind } : {}) }, { signal });
            items.push(...page.items);
            after = page.next ?? undefined;
            if (!after) break;
          }
          return { items, more: Boolean(after) };
        },
        placeholderData: keepPreviousData,
      };
    }),
  });
  const items = new Map<string, ItemsRead>(openFolders.map((f, i) => [f.key, { items: itemReads[i]?.data?.items ?? null, more: itemReads[i]?.data?.more ?? false }]));
  // what the loaded lists are, by when each was read: cheap to compare on every render, unlike the lists themselves
  const draftsRead = draftGroups.map((g, i) => `${g.id}:${draftReads[i]?.dataUpdatedAt ?? 0}:${limits[draftsKey(g.id)] ?? DRAFTS_PAGE}`).join("|");
  const itemsRead = openFolders.map((f, i) => `${f.key}:${itemReads[i]?.dataUpdatedAt ?? 0}:${itemReads[i]?.isPlaceholderData ? 1 : 0}`).join("|");
  const rows = useMemo(
    () => (tree.data ? flatten(tree.data, { isOpen, drafts: (k) => drafts.get(k), items: (k) => items.get(k), bin: storage.data?.bin ?? null, q, kind, draftMeta, sort }) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tree.data, folds, searchFolded, q, kind, sort, draftsRead, itemsRead, recipes.data, current, storage.data?.bin.count, storage.data?.bin.bytes],
  );
  const byKey = useMemo(() => new Map(rows.map((r) => [r.key, r])), [rows]);
  // the list drawn in a window: where each row sits, its place among its own (said to screen readers: rows out of sight are not drawn)
  const indexOf = useMemo(() => new Map(rows.map((r, i) => [r.key, i])), [rows]);
  const offsets = useMemo(() => rowOffsets(rows), [rows]);
  const sibs = useMemo(() => siblings(rows), [rows]);
  // the Bin stays in sight at the foot of the list: what it covers is not in sight
  const footHeight = rows.at(-1)?.kind === "bin" ? rowHeight(rows.at(-1)!) : 0;
  const found = q ? rows.filter((r) => r.match).length : 0;

  // picked rows (kept with what they are, so that one folded away still moves with the others), the last one picked, the row the keys are on
  const [picked, setPicked] = useState<Map<string, Row>>(new Map());
  const [pickAnchor, setPickAnchor] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  // the focused row's ring shows once the keys moved it, not after a click
  const [keyed, setKeyed] = useState(false);
  const [renaming, setRenamingState] = useState<{ key: string; name: string } | null>(null);
  // also in a ref: Enter and the blur that follows it, or Escape and that blur, end the same renaming once
  const renameRef = useRef<{ key: string; name: string } | null>(null);
  const setRenaming = (v: { key: string; name: string } | null) => {
    renameRef.current = v;
    setRenamingState(v);
  };
  const clearPicks = () => setPicked(new Map());

  const hereKey = current === null ? "all" : currentKey;
  const toggle = (r: Row) => r.foldable && setOpen(r.key, !r.open);

  /** What a plain click (or Enter) does: switch to it, open it, or fold it. */
  const activate = (r: Row) => {
    if (r.kind === "all") return setProject(null);
    if (r.kind === "inbox") return setProject("none");
    if (r.kind === "project") return r.archived ? toggle(r) : setProject(r.id);
    if (r.kind === "archive" || r.kind === "drafts" || r.kind === "empty") return toggle(r);
    if (r.kind === "more") {
      const more = r.more;
      if (!more) return;
      if (more.startsWith("f:")) setItemPages((p) => ({ ...p, [more]: (p[more] ?? 1) + 1 }));
      else setLimits((l) => ({ ...l, [more]: (l[more] ?? DRAFTS_PAGE) + DRAFTS_PAGE }));
      return;
    }
    if (r.kind === "item") return r.asset && onView(r.asset);
    if (r.kind === "bin") {
      useStudio.getState().set({ place: { type: "bin" } });
      onClose();
      return go("/");
    }
    if (r.kind === "folder") return openFolder(r.id!, r.group);
    if (r.kind === "timeline") {
      onClose();
      return go(`/timelines/${r.id}`);
    }
    if (r.kind === "draft") {
      useOpenDraft.getState().open(r.id);
      useStudio.getState().set({ form: true, scope: "draft" });
      onClose();
      go("/");
    }
  };
  /** The Studio on a folder: the app looks at its project when it looked at another one (else the Studio would leave it). */
  const openFolder = (id: string, group: string | null) => {
    if (current !== null && current !== (group ?? "none")) setProject(group ?? "none");
    useStudio.getState().set({ place: { type: "folder", id } });
    onClose();
    go("/");
  };
  /** An item shown in the Studio: its folder open (the Inbox's loose items: "in no folder"), the item large. */
  const showInStudio = (a: Asset, group: string | null) => {
    if (current !== null && current !== (group ?? "none")) setProject(group ?? "none");
    useStudio.getState().set({ place: a.folderId ? { type: "folder", id: a.folderId } : { type: "unfiled" } });
    useHandover.getState().set({ show: a.id });
    onClose();
    go("/");
  };
  const targetOf = (r: Row): (() => void) | undefined => (r.kind === "folder" && r.id ? () => openFolder(r.id!, r.group) : r.kind === "project" && !r.archived ? () => setProject(r.id) : r.kind === "inbox" ? () => setProject("none") : undefined);

  const click = (r: Row, e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => {
    setFocused(r.key);
    if (r.moving && (e.ctrlKey || e.metaKey)) {
      setPicked((p) => {
        const n = new Map(p);
        if (n.has(r.key)) n.delete(r.key);
        else n.set(r.key, r);
        return n;
      });
      setPickAnchor(r.key);
      return;
    }
    if (r.moving && e.shiftKey) {
      const keys = rangePick(rows.map((x) => x.key), pickAnchor, r.key, (k) => Boolean(byKey.get(k)?.moving));
      setPicked((p) => new Map([...p, ...keys.map((k) => [k, byKey.get(k)!] as const)]));
      if (!pickAnchor) setPickAnchor(r.key);
      return;
    }
    clearPicks();
    setPickAnchor(r.moving ? r.key : null);
    activate(r);
  };

  // what is moved or deleted: the picked rows when the row is one of them, else the row alone
  const subjectOf = (r: Row): Row[] => (picked.has(r.key) && picked.size > 1 ? [...picked.values()] : [r]);
  const movingOf = (rs: Row[]) => rs.map((x) => x.moving).filter((m): m is Moving => Boolean(m));
  const targets: Target[] = [
    { kind: "group", group: null, root: null, name: "the Inbox" },
    ...(projects.data?.items ?? []).filter((p) => !p.archivedAt).map((p): Target => ({ kind: "group", group: p.id, root: p.folderId, name: p.name })),
  ];
  // items go to folders: every folder that is not one of the disk, by project, with its project said
  const projectName = (id: string | null) => (id ? projects.data?.items.find((p) => p.id === id)?.name ?? "a project" : "Inbox");
  const folderTargets = (): Target[] => {
    const all = folders.data?.items ?? [];
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
  const remove = (rs: Row[]) => void actions.remove(rs).then(clearPicks);
  /** A group's empty drafts deleted, asked in place on their row (from its Clear button or its menu); the open one stays. */
  const [clearAsk, setClearAsk] = useState<string | null>(null);
  const clearEmpty = (r: Row) => void actions.clearEmpty(r.group, groups.find((g) => g.id === r.group)?.name ?? "the Inbox", openDraftId);
  const startRename = (r: Row) => (r.kind === "project" || (r.kind === "folder" && (!r.linked || r.linkedRoot)) || r.kind === "timeline") && r.id && setRenaming({ key: r.key, name: r.label });

  // the right-click menus: one per kind of row, and the selection bar's "Move to"
  const { menu, open: openMenu, close: closeMenu } = useMenu<Row | "picked">();
  const menuItems = (r: Row | "picked"): MenuItem[] => {
    if (r === "picked") return moveItems([...picked.values()]);
    const rs = subjectOf(r);
    const many = rs.length > 1 ? ` ${rs.length}` : "";
    const moveTo: MenuItem = { label: `Move${many} to`, icon: <FolderInput size={14} />, items: moveItems(rs) };
    const del: MenuItem = { label: `Delete${many}…`, key: "Del", icon: <Trash2 size={14} />, danger: true, run: () => remove(rs) };
    const rename: MenuItem = { label: "Rename", key: "F2", icon: <Pencil size={14} />, run: () => startRename(r) };
    switch (r.kind) {
      case "all":
        return [{ label: "Switch to All", key: "Enter", icon: <Globe size={14} />, run: () => setProject(null) }];
      case "inbox":
        return [
          { label: "Switch to the Inbox", key: "Enter", icon: <Inbox size={14} />, run: () => setProject("none") },
          { label: "New folder inside…", icon: <FolderPlus size={14} />, run: () => void actions.newFolder({ name: "the Inbox", parent: null, project: null }).then((ok) => ok && setOpen(r.key, true)) },
          { label: "Import a folder here…", icon: <Upload size={14} />, note: "copies it in", run: () => r.target && importInto(r.target) },
          { label: "Link a disk folder…", icon: <Link2 size={14} />, note: "used in place", run: () => r.target && void actions.link(r.target) },
        ];
      case "project": {
        const g = groups.find((x) => x.id === r.id);
        const root = g?.rootFolderId ?? null;
        return [
          { label: `Switch to ${r.label}`, key: "Enter", icon: <FolderKanban size={14} />, disabled: r.archived, note: r.archived ? "unarchive it first" : undefined, run: () => setProject(r.id) },
          { label: "New folder inside…", icon: <FolderPlus size={14} />, run: () => void actions.newFolder({ name: r.label, parent: root, project: r.id }).then((ok) => ok && setOpen(r.key, true)) },
          ...(r.noRoot ? [{ label: "Make a root folder", icon: <FolderRoot size={14} />, note: "renders land there", run: () => void actions.setRoot({ id: r.id!, name: r.label }) }] : []),
          { label: "Import a folder here…", icon: <Upload size={14} />, note: r.noRoot ? "makes its root folder first" : "copies it in", run: () => r.target && importInto(r.target) },
          { label: "Link a disk folder…", icon: <Link2 size={14} />, note: "used in place", run: () => r.target && void actions.link(r.target) },
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
        return [{ label: "Open", key: "Enter", icon: <PenLine size={14} />, run: () => activate(r) }, moveTo, "—", del];
      case "empty":
        return [{ label: `Clear ${r.label}…`, icon: <Eraser size={14} />, danger: true, note: "the open one stays", run: () => setClearAsk(r.key) }];
      case "item": {
        const several = pickedItems();
        return itemMenu.many(several.map((x) => x.asset!), { moveTo: moveItems(several), bin: () => void actions.bin(several).then(clearPicks) });
      }
      case "bin":
        return [{ label: "Open the bin", key: "Enter", icon: <Trash2 size={14} />, run: () => activate(r) }];
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

  // dragging rows onto a project, the Inbox or a folder: what is dragged, the row it is over, a folded one opening after a moment
  const dragged = useRef<Row[] | null>(null);
  // the row a drag started on stays drawn while it lasts, out of sight too: its dragend comes to it
  const dragFrom = useRef<string | null>(null);
  /** Whether what is dragged can be dropped on that row: moved there, or (the Bin) thrown away. */
  const takes = (r: Row) => {
    const moving = dragged.current ? movingOf(dragged.current) : [];
    return r.kind === "bin" ? Boolean(planBin(moving)) : Boolean(r.target && planDrop(moving, r.target));
  };
  const [over, setOver] = useState<string | null>(null);
  const [refused, setRefused] = useState<{ key: string; why: string } | null>(null);
  const opening = useRef<{ key: string; t: ReturnType<typeof setTimeout> } | null>(null);
  const stopOpening = () => {
    if (opening.current) clearTimeout(opening.current.t);
    opening.current = null;
  };
  const dragStart = (r: Row, e: DragEvent) => {
    if (!r.moving || renaming) return e.preventDefault();
    const rs = picked.has(r.key) ? [...picked.values()] : [r];
    dragged.current = rs;
    dragFrom.current = r.key;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/x-afflatus-tree", rs.map((x) => x.key).join(","));
    if (rs.length > 1) {
      const ghost = document.createElement("div");
      ghost.textContent = `${rs.length} items`;
      ghost.className = "fixed -top-96 left-0 rounded-lg border border-line-strong bg-raised px-3 py-1.5 text-sm font-semibold text-ink";
      document.body.append(ghost);
      e.dataTransfer.setDragImage(ghost, 12, 12);
      setTimeout(() => ghost.remove(), 0);
    }
  };
  /** Files from the computer go to a project, the Inbox or a folder (one of the disk: written into it there). */
  const takesFiles = (r: Row) => !r.archived && (r.kind === "project" || r.kind === "inbox" || r.kind === "folder") && Boolean(r.target);
  const dragOver = (r: Row, e: DragEvent) => {
    const fromDisk = !dragged.current && e.dataTransfer.types.includes("Files");
    if (fromDisk ? !takesFiles(r) : !dragged.current || !takes(r)) {
      if (over === r.key) setOver(null);
      // a drop refused for a reason of the disk says so, in place of the row's line
      const why = !fromDisk && dragged.current && r.target ? whyRefused(movingOf(dragged.current), r.target) : null;
      if (why ? refused?.key !== r.key || refused.why !== why : refused?.key === r.key) setRefused(why ? { key: r.key, why } : null);
      return;
    }
    if (refused) setRefused(null);
    e.preventDefault();
    e.dataTransfer.dropEffect = fromDisk ? "copy" : "move";
    if (over !== r.key) setOver(r.key);
    if (r.foldable && !r.open && opening.current?.key !== r.key) {
      stopOpening();
      opening.current = { key: r.key, t: setTimeout(() => setOpen(r.key, true), 700) };
    }
  };
  const dragLeave = (r: Row, e: DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    if (refused?.key === r.key) setRefused(null);
    if (over === r.key) setOver(null);
    if (opening.current?.key === r.key) stopOpening();
  };
  const drop = (r: Row, e: DragEvent) => {
    e.preventDefault();
    const items = dragged.current;
    dragged.current = null;
    setOver(null);
    setRefused(null);
    stopOpening();
    if (!items) {
      // files from the computer: uploaded there; a folder dropped is not read (its right-click "Import a folder…" is)
      if (!e.dataTransfer.files.length || !takesFiles(r) || !r.target) return;
      const dirs = new Set([...e.dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter((x) => x?.isDirectory).map((x) => x!.name));
      const files = [...e.dataTransfer.files].filter((f) => !(dirs.has(f.name) && !f.type));
      void actions.upload(files, r.target, dirs.size);
      return;
    }
    if (r.kind === "bin") void actions.bin(items).then(clearPicks);
    else if (r.target) void actions.move(movingOf(items), r.target, targetOf(r)).then(clearPicks);
  };
  const dragEnd = () => {
    dragged.current = null;
    dragFrom.current = null;
    setOver(null);
    setRefused(null);
    setOverBadge(null);
    stopOpening();
  };
  // the "no root folder" badge: one folder of that project, not of the disk, dropped on it becomes its root
  const [overBadge, setOverBadge] = useState<string | null>(null);
  const rootFrom = (r: Row): Row | null => {
    const d = dragged.current;
    const f = d?.length === 1 ? d[0]! : null;
    return f && f.kind === "folder" && f.id && f.group === r.id && !f.linked ? f : null;
  };
  const badgeOver = (r: Row, e: DragEvent) => {
    // never the row's own drop (a move into the project) while over the badge
    e.stopPropagation();
    if (over) setOver(null);
    if (!rootFrom(r)) {
      e.dataTransfer.dropEffect = "none";
      if (overBadge) setOverBadge(null);
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (overBadge !== r.key) setOverBadge(r.key);
  };
  const badgeDrop = (r: Row, e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const f = rootFrom(r);
    dragEnd();
    if (f && r.id) void actions.setRoot({ id: r.id, name: r.label }, { id: f.id!, name: f.label });
  };
  useEffect(() => stopOpening, []);

  // the keys: ↑ ↓ walk, ← → fold or go up, Enter opens, F2 renames, Del deletes, typing searches, Escape closes
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e) => {
    if (document.querySelector(OVER)) return;
    const el = panel.current;
    if (!el) return;
    const stop = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    const active = document.activeElement;
    if (e.key === "Escape") {
      stop();
      if (renaming) setRenaming(null);
      else if (clearAsk) setClearAsk(null);
      else if (active === search.current && text) setText("");
      else if (picked.size) clearPicks();
      else {
        onClose();
        anchor.current?.focus({ preventScroll: true });
      }
      return;
    }
    if (!el.contains(active) || renaming) return;
    // a Clear asked in place: its two buttons take Enter, not the tree
    if (clearAsk && active instanceof HTMLButtonElement && active.closest("[data-asking]")) return;
    if (active === search.current) {
      // typed into the box, not a jump to the next search box of the page
      if (e.key === "/") e.stopPropagation();
      if (e.key === "ArrowDown" || e.key === "Enter") {
        stop();
        list.current?.focus({ preventScroll: true });
        setKeyed(true);
        setFocused((f) => f ?? rows.find((r) => r.match)?.key ?? rows[0]?.key ?? null);
      }
      return;
    }
    if (e.altKey) return;
    const r = focused ? byKey.get(focused) : undefined;
    if (e.ctrlKey || e.metaKey) {
      if (e.key.toLowerCase() === "f") {
        stop();
        search.current?.focus();
      }
      return;
    }
    if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) setKeyed(true);
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp":
        stop();
        setFocused(step(rows, focused, e.key === "ArrowDown" ? 1 : -1));
        return;
      case "ArrowRight":
        stop();
        if (r?.foldable && !r.open) toggle(r);
        else if (r?.open) setFocused(step(rows, r.key, 1));
        return;
      case "ArrowLeft":
        stop();
        if (r?.open) toggle(r);
        else if (r?.parent) setFocused(r.parent);
        return;
      case "Home":
      case "End":
        stop();
        setFocused((e.key === "Home" ? rows[0] : rows.at(-1))?.key ?? null);
        return;
      case "Enter":
        stop();
        if (r) click(r, { ctrlKey: false, metaKey: false, shiftKey: e.shiftKey });
        return;
      case " ":
        stop();
        if (r) click(r, { ctrlKey: true, metaKey: false, shiftKey: false });
        return;
      case "F2":
        stop();
        if (r?.kind === "item" && r.asset) void itemMenu.renameIt(r.asset);
        else if (r) startRename(r);
        return;
      case "s":
      case "S":
        // an item kept or let go, as in the library
        if (r?.kind !== "item" || !r.asset || e.shiftKey) break;
        stop();
        if (picked.has(r.key) && pickedItems().length > 1) void api.bulkAssets(pickedItems().map((x) => x.id!), r.asset.kept ? "unkeep" : "keep").then(() => client.invalidateQueries({ queryKey: ["assets"] }));
        else itemMenu.keep.mutate({ id: r.asset.id, kept: !r.asset.kept });
        return;
      case "Delete":
      case "Backspace":
        stop();
        // items go to the bin as in the library (asked only for files of the disk); the rest asks first
        if (picked.size && [...picked.values()].every((x) => x.kind === "item")) void actions.bin([...picked.values()]).then(clearPicks);
        else if (!picked.size && r?.kind === "item") void actions.bin([r]);
        else if (picked.size) remove([...picked.values()]);
        else if (r?.kind === "project") void actions.removeProject(r);
        else if (r) remove([r]);
        return;
      case "ContextMenu":
      case "F10":
        if (e.key === "F10" && !e.shiftKey) return;
        stop();
        if (r) {
          const rowEl = list.current?.querySelector(`[data-key="${CSS.escape(r.key)}"]`) ?? null;
          openRowMenu(r, { preventDefault() {}, clientX: 0, clientY: 0, currentTarget: rowEl });
        }
        return;
      default:
        // "?" is the keyboard shortcuts everywhere, the tree included: this listener runs first and stops the key, so it asks for them itself
        if (e.key === "?") {
          stop();
          window.dispatchEvent(new Event("afflatus:keys"));
          return;
        }
        // a letter typed on the tree starts a search with it ("/" only goes to the box)
        if (e.key.length === 1) {
          stop();
          if (e.key !== "/" && e.key !== " ") setText((t) => t + e.key);
          search.current?.focus();
        }
    }
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  }, []);
  // opened: the keys are on the tree, on the row worked in
  useEffect(() => {
    list.current?.focus({ preventScroll: true });
  }, [place === null]); // eslint-disable-line react-hooks/exhaustive-deps
  // back from the Viewer: the keys are on the tree again
  useEffect(() => {
    if (!hidden) list.current?.focus({ preventScroll: true });
  }, [hidden]);
  useEffect(() => {
    if (!focused && rows.length && hereKey) setFocused(hereKey);
  }, [rows.length]); // eslint-disable-line react-hooks/exhaustive-deps
  // the list's size followed: more rows drawn when it grows
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [place === null]); // eslint-disable-line react-hooks/exhaustive-deps
  // the row the keys are on brought into sight inside the list (never the page), clear of the column heads and of the Bin at its foot
  useLayoutEffect(() => {
    const el = list.current;
    const i = focused ? indexOf.get(focused) : undefined;
    if (!el || i === undefined || rows[i]!.kind === "bin") return;
    const start = firstGap.current?.offsetTop ?? 0;
    const above = head.current?.offsetHeight ?? 0;
    const top = start + offsets[i]!;
    const bottom = start + offsets[i + 1]!;
    // the first row: the list from its very top, as it opens
    if (top < el.scrollTop + above) el.scrollTop = i === 0 ? 0 : top - above;
    else if (bottom > el.scrollTop + el.clientHeight - footHeight) el.scrollTop = bottom - el.clientHeight + footHeight;
    measure();
  }, [focused]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!place) return null;
  // the rows drawn: those in sight and a few more, the row the keys are on, the one renamed or dragged, the Bin (it stays at the foot)
  const keep = [focused, renaming?.key, dragFrom.current, footHeight ? "bin" : null].map((k) => (k ? indexOf.get(k) ?? -1 : -1));
  const drawn = rowWindow(offsets, view.top, view.height, OVERSCAN, keep).flatMap((p): ({ gap: number } | { r: Row; i: number })[] => ("gap" in p ? [p] : rows.slice(p.from, p.to).map((r, k) => ({ r, i: p.from + k }))));
  /** A drag near the top or the foot of the list scrolls it, so rows out of sight can be reached; over the Bin it stays put (a place to drop). */
  const edgeScroll = (e: DragEvent) => {
    const el = list.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const up = box.top + (head.current?.offsetHeight ?? 0) + EDGE - e.clientY;
    const foot = box.bottom - footHeight;
    const down = e.clientY - (foot - EDGE);
    if (up > 0) el.scrollTop -= Math.min(24, up);
    else if (down > 0 && e.clientY < foot) el.scrollTop += Math.min(24, down);
  };
  const commitRename = async () => {
    const cur = renameRef.current;
    if (!cur) return;
    const r = byKey.get(cur.key);
    const name = cur.name.trim();
    setRenaming(null);
    if (r) await actions.rename(r, name);
    list.current?.focus({ preventScroll: true });
  };

  return createPortal(
    <div
      ref={panel}
      role="dialog"
      aria-label="Projects"
      style={{ left: place.left, top: place.top, width: place.width, maxHeight: place.maxHeight }}
      className={cx("fixed z-[66] flex flex-col rounded-2xl border border-line-strong bg-panel text-sm shadow-2xl shadow-shade/60", (hidden || covered) && "invisible")}
    >
      {/* the notch that points at the rail's button */}
      <span aria-hidden className="absolute -left-[7px] h-3 w-3 rotate-45 border-b border-l border-line-strong bg-panel" style={{ top: Math.max(10, Math.min(place.arrow - 6, 40)) }} />
      <div className="flex flex-wrap items-center gap-2.5 px-4 pt-3.5 pb-3">
        <span className="text-base font-bold">Projects</span>
        <Help text={HELP} />
        <label className="ml-1.5 flex h-[34px] min-w-0 grow basis-[180px] items-center gap-2 rounded-[10px] border border-line-strong bg-raised px-3 text-ink-2 focus-within:border-accent">
          <Search size={15} className="shrink-0" />
          <input
            ref={search}
            data-search=""
            aria-label="Search projects, folders, timelines and drafts"
            placeholder="Search folders, timelines, drafts…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={100}
            className="h-8 min-w-0 grow border-0 bg-transparent text-sm text-ink outline-none placeholder:text-ink-3"
          />
          {q && <span className="shrink-0 text-xs text-ink-3">{found} found</span>}
        </label>
        {/* the library's own chips: which kind of item the folders show and count */}
        <Segmented oneLine label="Items shown" value={kind ?? "all"} options={[...KINDS]} onChange={(v) => setKind(v === "all" ? null : v)} />
        <Button tone="primary" size="sm" onClick={onNew} className="shrink-0">
          <Plus size={14} strokeWidth={2.4} /> New project
        </Button>
      </div>

      <div
        ref={list}
        role="tree"
        aria-label="Projects, folders, timelines and drafts"
        aria-multiselectable
        aria-activedescendant={focused ? `tree-${focused}` : undefined}
        tabIndex={0}
        onScroll={measure}
        onDragOver={edgeScroll}
        // no ring around the whole list: the row the keys are on has its own (the app's :focus-visible outline would beat a class)
        style={{ outline: "none" }}
        // no padding above or below: a sticky row stops at the padding's edge, so the rows scrolled past would show in it, above the column heads and under the Bin
        className="relative min-h-0 grow overflow-y-auto border-t border-line px-2"
      >
        {/* the columns: a click sorts each level by it, again turns it around */}
        <div ref={head} className={cx("sticky top-0 z-10 -mx-2 mb-0.5 grid items-center gap-2.5 border-b border-line bg-panel px-[18px] py-1 text-[11px] font-semibold text-ink-3 uppercase", COLUMNS)}>
          {(
            [
              { by: "name", label: "Name", end: false },
              // what a row holds says different things for each kind of row: nothing to sort by
              null,
              { by: "created", label: "Created", end: true },
              { by: "size", label: "Size", end: true },
            ] as const
          ).map((c, i) =>
            c ? (
              <button
                key={c.by}
                type="button"
                tabIndex={-1}
                aria-label={`Sort by ${c.label.toLowerCase()}${sort.by === c.by ? (sort.desc ? ", descending" : ", ascending") : ""}`}
                onClick={() => sortBy(c.by)}
                onMouseDown={(e) => e.preventDefault()}
                // a right-aligned head reversed (its main start is then on the right): the arrow on the far side, the word ending where the values do
                className={cx("flex w-full items-center justify-start gap-0.5 uppercase hover:text-ink", c.end && "flex-row-reverse", sort.by === c.by && "text-ink-2")}
              >
                {c.label}
                {sort.by === c.by && (sort.desc ? <ArrowDown size={11} strokeWidth={2.6} /> : <ArrowUp size={11} strokeWidth={2.6} />)}
              </button>
            ) : (
              <span key={i}>Holds</span>
            ),
          )}
        </div>
        {tree.isError && <div className="p-3"><ErrorNote>{tree.error.message}</ErrorNote></div>}
        {tree.isPending && <div className="p-4 text-ink-2">Reading your projects…</div>}
        {tree.isSuccess && q && !groups.length && <div className="py-10 text-center text-ink-2">Nothing called “{q}”. The search looks at projects, folders, timelines and drafts.</div>}
        {drawn.map((d, n) => {
          // the rows not drawn, as tall as they are; never what the browser keeps in place on a change (it grows as the list scrolls)
          if ("gap" in d) return <div key={`gap-${n}`} ref={n === 0 ? firstGap : undefined} aria-hidden style={{ height: d.gap, overflowAnchor: "none" }} />;
          const { r, i } = d;
          const top = r.depth === 0;
          const isPicked = picked.has(r.key);
          const here = r.key === hereKey;
          const icon = r.kind === "folder" && r.linked ? LINKED : ICONS[r.kind];
          const isRenaming = renaming?.key === r.key;
          return (
            <div
              key={r.key}
              id={`tree-${r.key}`}
              data-key={r.key}
              role="treeitem"
              aria-level={r.depth + 1}
              aria-setsize={sibs.size[i]}
              aria-posinset={sibs.pos[i]}
              aria-expanded={r.foldable ? r.open : undefined}
              aria-selected={isPicked}
              draggable={Boolean(r.moving) && !isRenaming}
              onDragStart={(e) => dragStart(r, e)}
              onDragOver={(e) => dragOver(r, e)}
              onDragLeave={(e) => dragLeave(r, e)}
              onDrop={(e) => drop(r, e)}
              onDragEnd={dragEnd}
              onClick={(e) => {
                if (isRenaming) return;
                setKeyed(false);
                click(r, e);
              }}
              onContextMenu={(e) => {
                setKeyed(false);
                rowMenu(r, e);
              }}
              className={cx(
                "grid cursor-pointer items-center gap-2.5 rounded-lg px-2.5 select-none",
                COLUMNS,
                top ? "h-10" : "h-[33px]",
                r.kind === "archive" && "mt-2 rounded-t-none border-t border-line",
                // the Bin stays in sight at the foot of the list, however far the tree scrolls: always there to drop on (square, so no row shows past its corners)
                r.kind === "bin" && "sticky bottom-0 z-10 mt-2 rounded-none border-t border-line bg-panel",
                // the Bin's tints are mixed into the panel's colour: see-through, the rows under it would show
                over === r.key
                  ? cx(r.kind === "bin" ? "bg-[color-mix(in_oklab,var(--color-accent)_15%,var(--color-panel))]" : "bg-accent/15", "shadow-[inset_0_0_0_1.5px_var(--color-accent)]")
                  : isPicked
                    ? cx(r.kind === "bin" ? "bg-[color-mix(in_oklab,var(--color-picture)_15%,var(--color-panel))]" : "bg-picture/15", "shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-picture)_55%,transparent)]")
                    : here
                      ? "bg-accent/10 shadow-[inset_3px_0_0_var(--color-accent)]"
                      : "hover:bg-hover",
                keyed && focused === r.key && "outline-2 -outline-offset-2 outline-accent/70",
                r.faded && "opacity-40",
              )}
            >
              <span className="flex min-w-0 items-center">
                <span className="font-mono text-[13px] whitespace-pre text-ink-3/60">{r.prefix}</span>
                {r.foldable ? (
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={`${r.open ? "Fold" : "Unfold"} ${r.label}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setKeyed(false);
                      setFocused(r.key);
                      toggle(r);
                    }}
                    onMouseDown={(e) => e.preventDefault()}
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-2 outline-none hover:text-ink focus-visible:outline-none"
                  >
                    <ChevronRight size={14} strokeWidth={2.2} className={cx("transition-transform duration-100", r.open && "rotate-90")} />
                  </button>
                ) : (
                  <span className="w-5 shrink-0" />
                )}
                {r.kind === "item" && r.asset && r.asset.kind !== "audio" ? (
                  <img src={thumbUrl(r.asset.id)} alt="" loading="lazy" draggable={false} className="mr-0.5 h-7 w-10 shrink-0 rounded object-cover" />
                ) : icon.icon && <span className={cx("flex w-[22px] shrink-0 items-center justify-center", r.archived && r.kind === "project" ? "text-ink-3" : icon.tone, r.dim && "opacity-50")}>{icon.icon}</span>}
                {isRenaming ? (
                  <input
                    autoFocus
                    aria-label={`New name for ${r.label}`}
                    value={renaming.name}
                    maxLength={120}
                    onChange={(e) => setRenaming({ key: r.key, name: e.target.value })}
                    onFocus={(e) => e.currentTarget.select()}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void commitRename();
                      }
                    }}
                    onBlur={() => void commitRename()}
                    className="ml-1.5 h-7 min-w-0 grow rounded-md border border-accent bg-raised px-2 text-sm text-ink outline-none"
                  />
                ) : (
                  <span
                    className={cx(
                      "ml-1.5 min-w-0 truncate",
                      top ? "text-sm font-bold" : r.kind === "folder" || r.kind === "project" ? "text-[13px] font-semibold" : "text-[13px] font-medium",
                      r.kind === "archive" || r.archived || r.dim ? "text-ink-3" : r.kind === "more" ? "text-ink-2 italic" : "text-ink",
                    )}
                  >
                    <Lit text={r.label} q={r.match ? q : ""} />
                  </span>
                )}
                {here && (
                  <span className="ml-2 flex shrink-0 items-center gap-1 rounded-full bg-accent px-2 py-px text-[11px] font-bold whitespace-nowrap text-accent-ink">
                    <Check size={11} strokeWidth={3} /> working in
                  </span>
                )}
                {r.noRoot && !r.archived && (
                  <button
                    type="button"
                    tabIndex={-1}
                    data-tip={`What is made while working in it lands in no folder. Click: a root folder named ${r.label} is made. Or drop one of its folders here: it becomes the root.`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (r.id) void actions.setRoot({ id: r.id, name: r.label });
                    }}
                    onDragOver={(e) => badgeOver(r, e)}
                    onDragLeave={() => overBadge === r.key && setOverBadge(null)}
                    onDrop={(e) => badgeDrop(r, e)}
                    className={cx(
                      "ml-2 shrink-0 rounded-full bg-warn-wash px-2 py-px text-[11px] font-semibold whitespace-nowrap text-warn-ink hover:shadow-[inset_0_0_0_1px_var(--color-warn-ink)]",
                      overBadge === r.key && "bg-accent text-accent-ink shadow-[0_0_0_2px_var(--color-accent)]",
                    )}
                  >
                    {overBadge === r.key ? "make it the root" : "no root folder"}
                  </button>
                )}
              </span>
              {r.kind === "empty" && refused?.key !== r.key ? (
                <span className="flex min-w-0 items-center" data-asking={clearAsk === r.key || undefined} onClick={(e) => e.stopPropagation()}>
                  {clearAsk === r.key ? (
                    <TwoStep open title={`Delete the ${r.label}`} note="Delete? The open one stays." yes="Delete" cancel="Keep" onCancel={() => setClearAsk(null)} onYes={() => clearEmpty(r)} />
                  ) : (
                    <button
                      type="button"
                      tabIndex={-1}
                      data-tip="Delete these drafts: no prompt, no name, nothing rendered. The open one stays."
                      onClick={(e) => {
                        e.stopPropagation();
                        setClearAsk(r.key);
                      }}
                      onMouseDown={(e) => e.preventDefault()}
                      className="flex h-6 items-center gap-1 rounded-md px-1.5 text-xs font-semibold text-ink-2 hover:bg-hover hover:text-warn-ink"
                    >
                      <Eraser size={12} /> Clear
                    </button>
                  )}
                </span>
              ) : (
                <span data-tip={r.path} className={cx("min-w-0 truncate text-xs", refused?.key === r.key || r.missing ? "text-warn-ink" : r.dim ? "text-ink-3" : "text-ink-2")}>{refused?.key === r.key ? refused.why : r.meta}</span>
              )}
              <span data-tip={r.created ? new Date(r.created).toLocaleString("en-GB") : undefined} className="text-right text-xs whitespace-nowrap text-ink-2 tabular-nums">{r.created ? shortDate(r.created) : ""}</span>
              <span className="text-right font-mono text-xs whitespace-nowrap text-ink-2">{r.bytes !== null ? size(r.bytes) : ""}</span>
            </div>
          );
        })}
      </div>

      {picked.size > 0 && (
        <div className="flex items-center gap-2 border-t border-line bg-picture/8 px-3 py-2">
          <span className="text-[13px] font-bold text-picture">{picked.size} selected</span>
          <span className="text-xs text-ink-2">drag them together, or</span>
          <span className="grow" />
          <Button size="sm" onClick={(e) => openMenu(e, "picked")}>Move to…</Button>
          <Button size="sm" tone="danger" onClick={() => remove([...picked.values()])}>Delete…</Button>
          <Button size="sm" tone="quiet" onClick={clearPicks}>Clear</Button>
        </div>
      )}
      <div className="flex items-center gap-3.5 border-t border-line px-4 py-2.5 text-xs text-ink-2">
        <span className="shrink-0 font-mono whitespace-nowrap text-ink">{tree.data ? `${size(tree.data.totalBytes)} in all` : ""}</span>
      </div>
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
          if (files.length && t) void actions.importFolder(files, t, client);
        }}
      />
      {itemMenu.element}
      {menu && <ContextMenu at={menu.at} label={menu.subject === "picked" ? "Move to" : menu.subject.label} head={menuHead(menu.subject)} items={menuItems(menu.subject)} onClose={closeMenu} />}
    </div>,
    document.body,
  );
}
