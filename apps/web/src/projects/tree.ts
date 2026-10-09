import type { Asset, DraftLeaf, FolderNode, ProjectsTree, TreeGroup } from "../api/types/library";
import { size } from "../format";

/**
 * The Projects panel's tree as the rows it draws: what is unfolded, in order, each with its `tree`
 * branch prefix (├─ └─ │). Pure: the panel hands it the tree, what is open and the drafts read so far.
 */

/**
 * `empty`: a group's unused drafts (no prompt, no name, nothing rendered) folded into one row. `loose`: the Inbox's items in
 * no folder, a row of the one-project tree only (an item in no folder is in no project).
 */
export type RowKind = "inbox" | "project" | "archive" | "folder" | "item" | "timeline" | "drafts" | "draft" | "empty" | "more" | "bin" | "loose";

/** Something a row can be moved as: its place now, to tell a move from staying put. */
export type Moving =
  | { kind: "folder"; id: string; group: string | null; /** Its parent in the tree; null at the top of its group. */ parent: string | null; name: string; /** The top of a folder of the disk: it changes project, never nests. */ linkedRoot?: boolean }
  | { kind: "timeline"; id: string; group: string | null; folder: string | null; name: string }
  | { kind: "draft"; id: string; group: string | null; name: string }
  | { kind: "asset"; id: string; folder: string | null; name: string; /** A file of a folder of the disk: it only goes to another such folder. */ onDisk?: boolean };

/** Somewhere a row can be dropped. `group`: the project, null for the Inbox. */
export type Target =
  | { kind: "group"; group: string | null; root: string | null; /** Its root folder is a folder of the disk: what lands in it is written there. */ rootLinked?: boolean; name: string }
  | { kind: "folder"; id: string; group: string | null; linked: boolean; /** Its folders above, nearest last. */ ancestors: string[]; name: string };

export interface Row {
  /** Unique among the rows: "g:<id|inbox>", "archived", "f:<id>", "a:<id>", "t:<id>", "d:<group>", "e:<group>", "dr:<id>", "more:<d:group|f:id>". */
  key: string;
  kind: RowKind;
  /** What it is on the server (a project, folder, timeline or draft id); null for the others. */
  id: string | null;
  label: string;
  /** What it holds, said in a few words: the Holds column. */
  meta: string;
  bytes: number | null;
  depth: number;
  prefix: string;
  foldable: boolean;
  open: boolean;
  /** The row it is under. */
  parent: string | null;
  /** The group it belongs to: a project id, null for the Inbox (and for Archived and the Bin). */
  group: string | null;
  linked?: boolean;
  /** A folder of the disk that was linked itself (not one of its sub-folders). */
  linkedRoot?: boolean;
  /** That folder's directory, in full (the meta shows its end). */
  path?: string;
  /** That directory cannot be read now. */
  missing?: boolean;
  archived?: boolean;
  /** A project without a root folder. */
  noRoot?: boolean;
  /** With a search: its name holds it. */
  match?: boolean;
  /** With a search: neither it nor anything under it matches; with a kind: a folder that holds none of it. */
  faded?: boolean;
  /** With a kind: a folder that holds none of it. */
  empty?: boolean;
  /** A group or a folder with nothing in it: no folder, timeline, draft or item. */
  dim?: boolean;
  /** When it was made (ISO): the Created column. */
  created?: string;
  /** An empty-drafts row: how many drafts it folds. */
  drafts?: number;
  /** A timeline: its takes no clip plays and nothing else needs. */
  unused?: { takes: number; bytes: number };
  moving?: Moving;
  target?: Target;
  /** An item of a folder: the item. */
  asset?: Asset;
  /** A "Show more" row: the key of the row whose list grows. */
  more?: string;
}

/** The items of a folder as read so far (null: not yet), and whether there are more to read. */
export interface ItemsRead {
  items: Asset[] | null;
  more: boolean;
}

/** An item's row: "Image" when it has no name; what it is, how long or how big. */
export const itemLabel = (a: Asset) => a.shownName || a.name || (a.kind === "image" ? "Image" : a.kind === "video" ? "Video" : "Sound");
export const itemMeta = (a: Asset) =>
  [a.kind === "image" ? "image" : a.kind === "video" ? "video" : "sound", a.kind === "image" ? (a.width && a.height ? `${a.width}×${a.height}` : null) : a.durationMs !== null ? clock(a.durationMs) : null].filter(Boolean).join(" · ");

/** The drafts of a group as read so far: what there is, and how many to show. */
export interface DraftsRead {
  items: DraftLeaf[] | null;
  /** How many are shown (50, then 50 more each time). */
  limit: number;
}

export type ItemKind = "image" | "video" | "audio";
const KIND_WORD: Record<ItemKind, string> = { image: "image", video: "video", audio: "sound" };
/** A folder's items, as many as there are of the kind shown: "3 here · 12 items in all", "4 videos", "on your disk". */
export function folderMeta(f: { items: number; totalItems: number; linked: boolean; path?: string; missing?: boolean }, kind?: ItemKind | null): string {
  const word = kind ? KIND_WORD[kind] : "item";
  const counted = f.totalItems !== f.items ? `${f.items} here · ${plural(f.totalItems, word)} in all` : plural(f.totalItems, word);
  // the folder that was linked says where it is on the disk (the end of its path); its sub-folders are under it
  if (f.path) return f.missing ? `not found · ${pathEnd(f.path)}` : `${pathEnd(f.path)} · ${counted}`;
  return counted;
}

/** The end of a path, its last two parts: "…\renders\refs" (the whole of a short one). */
export function pathEnd(path: string): string {
  const sep = path.includes("\\") ? "\\" : "/";
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.length > 2 ? `…${sep}${parts.slice(-2).join(sep)}` : path;
}

/** The order of the rows of each level, set by the column headers: by name, by when it was made, by size; `desc` turns it around. */
export interface Sort {
  by: "name" | "created" | "size";
  desc: boolean;
}
export const DEFAULT_SORT: Sort = { by: "created", desc: true };
/** A header clicked: its column, turned around when it was the one sorted by already. Name starts A to Z, Created and Size newest and largest first. */
export const nextSort = (s: Sort, by: Sort["by"]): Sort => (s.by === by ? { by, desc: !s.desc } : { by, desc: by !== "name" });
/** A folder's items in that order, as the library listing is asked for them (it sorts them, a page at a time). */
export const itemsOrder = (s: Sort): { sort: "new" | "old" | "name" | "size"; dir?: "asc" | "desc" } =>
  s.by === "created" ? { sort: s.desc ? "new" : "old" } : { sort: s.by, dir: s.desc ? "desc" : "asc" };
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
/** Timelines and drafts of a level in that order (drafts found by a search have no size: sorting by size, they keep theirs). */
function sortLeaves<T>(list: T[], s: Sort, of: (x: T) => { name: string; created: string; bytes?: number }): T[] {
  const sign = s.desc ? -1 : 1;
  return [...list].sort((x, y) => {
    const a = of(x);
    const b = of(y);
    if (s.by === "name") return sign * byName(a, b);
    if (s.by === "created") return sign * a.created.localeCompare(b.created) || byName(a, b);
    return a.bytes === undefined || b.bytes === undefined ? 0 : sign * (a.bytes - b.bytes) || byName(a, b);
  });
}
/** Folders come first, in the same order; those of an older server, with no date, by name when sorted by Created. */
const sortFolders = (list: FolderNode[], s: Sort) =>
  [...list].sort((a, b) => {
    const sign = s.desc ? -1 : 1;
    if (s.by === "size") return sign * (a.bytes - b.bytes) || byName(a, b);
    if (s.by === "created") return sign * (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || byName(a, b);
    return sign * byName(a, b);
  });

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** The Created column: "14:32" today, "yesterday", "3 Oct" this year, "3 Oct 2025" before. */
export function shortDate(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const ago = Math.round((day(now) - day(d)) / 86_400_000);
  if (ago === 0) return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (ago === 1) return "yesterday";
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() === now.getFullYear() ? "" : ` ${d.getFullYear()}`}`;
}

export const groupKey = (g: { id: string | null }) => `g:${g.id ?? "inbox"}`;
export const draftsKey = (group: string | null) => `d:${group ?? "inbox"}`;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const clock = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** A group's drafts: those worked on, and the unused ones (no prompt, no name, nothing rendered) apart. */
export const draftCounts = (g: TreeGroup) => {
  const empty = Math.min(g.counts.unusedDrafts ?? 0, g.counts.drafts);
  return { used: g.counts.drafts - empty, empty };
};
/** "1 timeline · 9 drafts · 43 items": the drafts counted are those worked on. */
export const groupMeta = (g: TreeGroup) => [plural(g.counts.timelines, "timeline"), plural(draftCounts(g).used, "draft"), plural(g.counts.items, "item")].join(" · ");

/** The text of a draft row: its name, else the start of its prompt; "No prompt yet" is an unused one's. */
export const draftLabel = (d: DraftLeaf) => d.name || d.title || (d.unused ? "No prompt yet" : "Untitled draft");

export function flatten(tree: ProjectsTree, s: {
  isOpen(key: string): boolean;
  /** The drafts of a group, by its draftsKey; absent while not read. Not used with a search: the tree carries them. */
  drafts(key: string): DraftsRead | undefined;
  q?: string;
  /** Only pictures, videos or sounds: folders count that kind (the tree was read for it), and those with none fade. */
  kind?: ItemKind | null;
  /** The items of a folder, by its row key; absent while not read. Not used with a search (it is on names of folders, timelines and drafts). */
  items?(key: string): ItemsRead | undefined;
  /** What the bin holds: its row ends the tree, searching or not. */
  bin?: { count: number; bytes: number } | null;
  /** "MiniMax H3 · 2 renders": what a draft row says it holds. */
  draftMeta?(d: DraftLeaf): string;
  /** The order of each level's folders, timelines and drafts (the items come in order from the server). Newest first when not said. */
  sort?: Sort;
  /**
   * One project's tree (or the Inbox's: null), for the library's breadcrumb: its own row first (the whole project), its
   * root folder's sub-folders brought up beside the root, the Inbox's loose items as a "No folder" row, then the Bin.
   */
  only?: { group: string | null };
}): Row[] {
  const q = (s.q ?? "").trim().toLowerCase();
  const order = s.sort ?? DEFAULT_SORT;
  const timelinesIn = (list: TreeGroup["timelines"]) => sortLeaves(list, order, (t) => ({ name: t.name, created: t.createdAt ?? t.updatedAt, bytes: t.bytes }));
  const draftsIn = (list: DraftLeaf[]) => sortLeaves(list, order, (d) => ({ name: draftLabel(d), created: d.createdAt ?? d.updatedAt, bytes: d.bytes }));
  const has = (text: string) => Boolean(q) && text.toLowerCase().includes(q);
  const rows: Row[] = [];
  type Node = { row: Omit<Row, "depth" | "prefix" | "parent" | "open" | "foldable">; kids: () => Node[]; count: number };

  // a folder of the disk under another of the disk is one of its sub-folders: it never moves on its own
  const folderNodes = (g: TreeGroup, list: FolderNode[], parent: string | null, ancestors: string[], parentLinked = false, filed: Map<string, TreeGroup["timelines"]> = new Map()): Node[] =>
    sortFolders(list, order).map((f) => ({
      row: {
        key: `f:${f.id}`, kind: "folder", id: f.id, label: f.name, bytes: f.bytes, ...(f.createdAt ? { created: f.createdAt } : {}), group: g.id, linked: f.linked, linkedRoot: f.linked && !parentLinked, archived: g.archived,
        meta: folderMeta(f, s.kind),
        ...(f.path ? { path: f.path, ...(f.missing ? { missing: true } : {}) } : {}),
        ...(s.kind && !f.totalItems ? { empty: true } : {}),
        ...(!f.totalItems && !f.children.length && !filed.get(f.id)?.length ? { dim: true } : {}),
        match: has(f.name),
        ...(f.linked && parentLinked ? {} : { moving: { kind: "folder" as const, id: f.id, group: g.id, parent, name: f.name, ...(f.linked ? { linkedRoot: true } : {}) } }),
        target: { kind: "folder", id: f.id, group: g.id, linked: f.linked, ancestors, name: f.name },
      },
      // its items show when it is unfolded, not while searching
      count: f.children.length + (filed.get(f.id)?.length ?? 0) + (q ? 0 : f.items),
      // its sub-folders, the timelines filed in it, then its items
      kids: () => [...folderNodes(g, f.children, f.id, [...ancestors, f.id], f.linked, filed), ...timelinesIn(filed.get(f.id) ?? []).map((t) => timelineNode(g, t)), ...(q ? [] : itemNodes(g, f))],
    }));
  const itemNodes = (g: TreeGroup, f: FolderNode): Node[] => {
    if (!f.items) return [];
    const key = `f:${f.id}`;
    const read = s.items?.(key);
    if (!read?.items) return [{ row: { key: `more:${key}`, kind: "more", id: null, label: "Reading…", meta: "", bytes: null, group: g.id }, count: 0, kids: () => [] }];
    return [
      ...read.items.map((a): Node => ({
        row: { key: `a:${a.id}`, kind: "item", id: a.id, label: itemLabel(a), meta: itemMeta(a), bytes: a.bytes, created: a.createdAt, group: g.id, archived: g.archived, asset: a, moving: { kind: "asset", id: a.id, folder: f.id, name: itemLabel(a), ...(a.path ? { onDisk: true } : {}) } },
        count: 0,
        kids: () => [],
      })),
      ...(read.more ? [{ row: { key: `more:${key}`, kind: "more" as const, id: null, label: "Show more", meta: "", bytes: null, group: g.id, more: key }, count: 0, kids: () => [] }] : []),
    ];
  };

  const groupNode = (g: TreeGroup, hoist = false): Node => {
    const key = groupKey(g);
    const dk = draftsKey(g.id);
    const searched = q ? g.drafts ?? [] : null;
    const draftCount = searched ? searched.length : g.counts.drafts;
    // "Drafts · 9 · 12 empty": the unused ones are said apart (a search finds none: they have no prompt and no name)
    const counted = draftCounts(g);
    const draftsLabel = searched || !counted.empty ? `Drafts · ${draftCount}` : counted.used ? `Drafts · ${counted.used} · ${counted.empty} empty` : `Drafts · ${counted.empty} empty`;
    const draftRows = (): Node[] => {
      if (searched) return draftsIn(searched).map((d) => draftNode(g, d));
      const read = s.drafts(dk);
      if (!read?.items) return [{ row: { key: `more:${g.id ?? "inbox"}`, kind: "more", id: null, label: "Reading…", meta: "", bytes: null, group: g.id }, count: 0, kids: () => [] }];
      const used = read.items.filter((d) => !d.unused);
      const unused = read.items.filter((d) => d.unused);
      const shown = draftsIn(used).slice(0, read.limit).map((d) => draftNode(g, d));
      const left = used.length - read.limit;
      const more: Node[] = left > 0 ? [{ row: { key: `more:${g.id ?? "inbox"}`, kind: "more", id: null, label: "Show more", meta: `${left} more`, bytes: null, group: g.id, more: dk }, count: 0, kids: () => [] }] : [];
      // the unused ones folded into one row, last: unfolded, they are listed; its Clear deletes them
      const empty: Node[] = unused.length
        ? [{ row: { key: `e:${g.id ?? "inbox"}`, kind: "empty", id: null, label: plural(unused.length, "empty draft"), drafts: unused.length, meta: "", bytes: null, group: g.id, archived: g.archived, dim: true }, count: unused.length, kids: () => draftsIn(unused).map((d) => draftNode(g, d)) }]
        : [];
      return [...shown, ...more, ...empty];
    };
    // a timeline filed in one of the group's folders shows inside it; one in no folder, or in the project's root, under the group
    const shown = new Set<string>();
    const walkFolders = (list: FolderNode[]) => list.forEach((f) => { shown.add(f.id); walkFolders(f.children); });
    walkFolders(g.folders);
    const filed = new Map<string, TreeGroup["timelines"]>();
    const loose: TreeGroup["timelines"] = [];
    for (const t of g.timelines) {
      if (t.folderId && shown.has(t.folderId)) filed.set(t.folderId, [...(filed.get(t.folderId) ?? []), t]);
      else loose.push(t);
    }
    // the one-project tree: the root folder first, as "Name (root)" with its own items, and its sub-folders beside it rather than
    // under it (the project's row stands for the whole of it, so the root is one more level for nothing)
    const root = hoist ? g.folders.find((f) => f.id === g.rootFolderId && !f.linked) : undefined;
    const tops = (): Node[] =>
      root
        ? [
            ...folderNodes(g, [{ ...root, name: `${root.name} (root)`, children: [] }], null, [], false, filed),
            ...folderNodes(g, root.children, root.id, [root.id], false, filed),
            ...folderNodes(g, g.folders.filter((f) => f !== root), null, [], false, filed),
          ]
        : folderNodes(g, g.folders, null, [], false, filed);
    const kids = (): Node[] => [
      ...tops(),
      ...timelinesIn(loose).map((t) => timelineNode(g, t)),
      ...(draftCount ? [{ row: { key: dk, kind: "drafts" as const, id: null, label: draftsLabel, meta: "", bytes: null, group: g.id, archived: g.archived }, count: draftCount, kids: draftRows }] : []),
    ];
    const count = g.folders.length + (root ? root.children.length : 0) + loose.length + (draftCount ? 1 : 0);
    return {
      row: {
        key, kind: g.kind, id: g.id, label: g.name, meta: groupMeta(g), bytes: g.bytes, ...(g.createdAt ? { created: g.createdAt } : {}), group: g.id, archived: g.archived, noRoot: g.kind === "project" && !g.rootFolderId,
        ...(!g.counts.items && !g.counts.timelines && !g.counts.drafts && !g.folders.length && !g.timelines.length ? { dim: true } : {}),
        match: has(g.name),
        target: { kind: "group", group: g.id, root: g.rootFolderId, ...(g.folders.some((f) => f.id === g.rootFolderId && f.linked) ? { rootLinked: true } : {}), name: g.kind === "inbox" ? "the Inbox" : g.name },
      },
      count,
      kids,
    };
  };
  const timelineNode = (g: TreeGroup, t: TreeGroup["timelines"][number]): Node => ({
    row: {
      key: `t:${t.id}`, kind: "timeline", id: t.id, label: t.name, bytes: t.bytes, group: g.id, archived: g.archived, created: t.createdAt ?? t.updatedAt,
      meta: [plural(t.clips, "clip"), clock(t.durationMs), ...(t.exported ? ["exported"] : []), ...(t.unusedTakes > 0 ? [`${t.unusedTakes} unused`, size(t.unusedBytes)] : [])].join(" · "),
      ...(t.unusedTakes > 0 ? { unused: { takes: t.unusedTakes, bytes: t.unusedBytes } } : {}),
      match: has(t.name),
      moving: { kind: "timeline", id: t.id, group: g.id, folder: t.folderId, name: t.name },
    },
    count: 0,
    kids: () => [],
  });
  const draftNode = (g: TreeGroup, d: DraftLeaf): Node => ({
    row: { key: `dr:${d.id}`, kind: "draft", id: d.id, label: draftLabel(d), meta: s.draftMeta?.(d) ?? "", bytes: d.bytes ? d.bytes : null, created: d.createdAt ?? d.updatedAt, group: g.id, archived: g.archived, match: has(draftLabel(d)), moving: { kind: "draft", id: d.id, group: g.id, name: draftLabel(d) } },
    count: 0,
    kids: () => [],
  });

  const active = tree.groups.filter((g) => !g.archived);
  const archived = tree.groups.filter((g) => g.archived);
  const bin: Node[] = s.bin ? [{ row: { key: "bin", kind: "bin" as const, id: null, label: "Bin", meta: s.bin.count ? `${plural(s.bin.count, "item")} · kept a week` : "empty", bytes: s.bin.bytes, group: null }, count: 0, kids: () => [] }] : [];
  const one = s.only ? tree.groups.find((g) => g.id === s.only!.group) : undefined;
  // the one-project tree: its row is the whole of it (a place, never folded), what it holds is the top level
  const scoped = (g: TreeGroup): Node[] => {
    const n = groupNode(g, true);
    const inbox = g.kind === "inbox";
    return [
      { row: { ...n.row, meta: `${inbox ? "the whole Inbox" : "the whole project"} · ${n.row.meta}` }, count: 0, kids: () => [] },
      ...n.kids(),
      ...(inbox ? [{ row: { key: "loose", kind: "loose" as const, id: null, label: "No folder", meta: "items in no folder", bytes: null, group: null }, count: 0, kids: () => [] }] : []),
    ];
  };
  const top: Node[] = s.only
    ? [...(one ? scoped(one) : []), ...bin]
    : [
        ...active.map((g) => groupNode(g)),
        ...(archived.length
          ? [{ row: { key: "archived", kind: "archive" as const, id: null, label: `Archived (${archived.length})`, meta: plural(archived.length, "project"), bytes: archived.reduce((n, g) => n + g.bytes, 0), group: null }, count: archived.length, kids: () => archived.map((g) => groupNode(g)) }]
          : []),
        ...bin,
      ];

  /** With a search: it, or something under it, matches. */
  const lit = (n: Node): boolean => Boolean(n.row.match) || n.kids().some((k) => k.row.kind !== "more" && lit(k));
  const walk = (nodes: Node[], depth: number, prefixes: string, parent: string | null) => {
    nodes.forEach((n, i) => {
      const last = i === nodes.length - 1;
      const foldable = n.count > 0;
      const open = foldable && s.isOpen(n.row.key);
      rows.push({ ...n.row, depth, parent, foldable, open, prefix: depth === 0 ? "" : prefixes + (last ? "└─ " : "├─ "), ...(q || n.row.empty ? { faded: Boolean(n.row.empty) || (Boolean(q) && !lit(n)) } : {}) });
      if (open) walk(n.kids(), depth + 1, depth === 0 ? "" : prefixes + (last ? "   " : "│  "), n.row.key);
    });
  };
  walk(top, 0, "", null);
  return rows;
}

/**
 * Shift + click: the rows from the last one picked to this one, in the order they are shown, keeping only
 * those that can be picked. Without a last one (or one no longer shown), only this one.
 */
export function rangePick(order: string[], anchor: string | null, to: string, pickable: (key: string) => boolean = () => true): string[] {
  const a = anchor ? order.indexOf(anchor) : -1;
  const b = order.indexOf(to);
  if (b < 0) return [];
  if (a < 0) return pickable(to) ? [to] : [];
  return order.slice(Math.min(a, b), Math.max(a, b) + 1).filter(pickable);
}

/** A move to make on the server, one per row moved. */
export type Op =
  | { kind: "folder"; id: string; patch: { parentId?: string | null; project?: string | null } }
  | { kind: "timeline"; id: string; patch: { project: string | null; folder: string | null } }
  | { kind: "draft"; id: string; project: string | null }
  | { kind: "asset"; id: string; folder: string };

/**
 * What a drop of these rows on that one does: the moves to make, or null when it is refused (a draft onto
 * a folder, a folder into itself or one under it, anything but items onto a folder of the disk, an item onto a
 * project without a root folder or the Inbox, a file of the disk anywhere but another folder of the disk,
 * a folder of the disk into any folder: it only changes project). Rows already where
 * they would go are left out; a drop that moves nothing is refused too.
 */
export function planDrop(items: Moving[], t: Target): Op[] | null {
  if (!items.length) return null;
  const ops: Op[] = [];
  for (const m of items) {
    if (t.kind === "folder") {
      if (m.kind === "draft") return null;
      // items may go into a folder of the disk (the server writes the file there); nothing else does
      if (m.kind === "asset") {
        // a file of the disk stays on the disk: only into another folder of it (the server moves the file there)
        if (m.onDisk && !t.linked) return null;
        if (m.folder !== t.id) ops.push({ kind: "asset", id: m.id, folder: t.id });
        continue;
      }
      if (t.linked) return null;
      if (m.kind === "folder") {
        if (m.linkedRoot) return null;
        if (m.id === t.id || t.ancestors.includes(m.id)) return null;
        if (m.parent === t.id) continue;
        ops.push({ kind: "folder", id: m.id, patch: { parentId: t.id } });
      } else {
        // filed in that folder but listed in another project (a folder moved without it): it still has to move
        if (m.folder === t.id && m.group === t.group) continue;
        ops.push({ kind: "timeline", id: m.id, patch: { project: t.group, folder: t.id } });
      }
      continue;
    }
    // onto a project (into its root folder when it has one) or the Inbox; an item only into a root folder
    if (m.kind === "asset") {
      if (!t.root || m.onDisk) return null;
      if (m.folder !== t.root) ops.push({ kind: "asset", id: m.id, folder: t.root });
    } else if (m.kind === "folder" && m.linkedRoot) {
      // a folder of the disk changes project, at the top of it
      if (m.group === t.group) continue;
      ops.push({ kind: "folder", id: m.id, patch: { project: t.group } });
    } else if (m.kind === "folder") {
      if (m.group === t.group && m.parent === null) continue;
      ops.push({ kind: "folder", id: m.id, patch: t.root ? { parentId: t.root } : { parentId: null, project: t.group } });
    } else if (m.kind === "timeline") {
      if (m.group === t.group && (m.folder === null || m.folder === t.root)) continue;
      ops.push({ kind: "timeline", id: m.id, patch: { project: t.group, folder: null } });
    } else {
      if (m.group === t.group) continue;
      ops.push({ kind: "draft", id: m.id, project: t.group });
    }
  }
  return ops.length ? ops : null;
}

/**
 * Why a refused drop is refused, when the reason is the disk (the rest needs no words: a folder into itself is plain).
 * Null when it is not refused, or not for that.
 */
export function whyRefused(items: Moving[], t: Target): string | null {
  if (!items.length || planDrop(items, t)) return null;
  for (const m of items) {
    if (m.kind === "asset" && m.onDisk && !(t.kind === "folder" && t.linked)) return "a file of your disk: only into another folder of your disk";
    if (m.kind === "folder" && m.linkedRoot && t.kind === "folder") return "a folder of your disk: drop it on a project";
    if (t.kind === "folder" && t.linked && m.kind !== "asset") return "a folder of your disk: only files go in it";
  }
  return null;
}

/** Where ↑ ↓ ← → go: the next or previous row, a row's parent. */
export function step(rows: Row[], from: string | null, by: 1 | -1): string | null {
  if (!rows.length) return null;
  const i = from ? rows.findIndex((r) => r.key === from) : -1;
  if (i < 0) return rows[by === 1 ? 0 : rows.length - 1]!.key;
  return rows[Math.max(0, Math.min(rows.length - 1, i + by))]!.key;
}

/** A row's height in the list, as the panel draws it: 40 px at the top level, 33 under it; Archived and the Bin 8 more (the space above their line). */
export const rowHeight = (r: Pick<Row, "depth" | "kind">) => (r.depth === 0 ? 40 : 33) + (r.kind === "archive" || r.kind === "bin" ? 8 : 0);

/** Where each row starts, from the top of the first; one more at the end: the height of them all. */
export function rowOffsets(rows: Pick<Row, "depth" | "kind">[]): number[] {
  const out = [0];
  for (const r of rows) out.push(out.at(-1)! + rowHeight(r));
  return out;
}

/** A part of a long list as drawn: rows `from` to `to` (not included), or the height of those left out. */
export type Piece = { from: number; to: number } | { gap: number };

/**
 * The rows of a long list that are drawn: those in sight from `top` for `height` px (measured from the first row's
 * top), `over` more above and below, and the `keep` ones wherever they are (the row the keys are on, one being
 * renamed or dragged, the Bin). Those left out are gaps of their height, so the list is as tall and scrolls the
 * same. It starts and ends with a gap, of 0 when there is none.
 */
export function rowWindow(offsets: number[], top: number, height: number, over: number, keep: number[] = []): Piece[] {
  const n = offsets.length - 1;
  if (n <= 0) return [{ gap: 0 }, { gap: 0 }];
  // the first row that reaches below `top`, the first that starts at or past the end of the view
  const first = (y: number) => {
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (offsets[mid + 1]! <= y) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const from = Math.max(0, first(top) - over);
  const to = Math.min(n, first(top + Math.max(0, height)) + 1 + over);
  const shown = new Set<number>();
  for (let i = from; i < to; i++) shown.add(i);
  for (const i of keep) if (i >= 0 && i < n) shown.add(i);
  const order = [...shown].sort((a, b) => a - b);
  const pieces: Piece[] = [{ gap: offsets[order[0]!]! }];
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && order[j + 1] === order[j]! + 1) j++;
    if (i > 0) pieces.push({ gap: offsets[order[i]!]! - offsets[order[i - 1]! + 1]! });
    pieces.push({ from: order[i]!, to: order[j]! + 1 });
    i = j + 1;
  }
  pieces.push({ gap: offsets[n]! - offsets[order.at(-1)! + 1]! });
  return pieces;
}

/** Where each row sits among the rows under the same one (1 on), and how many those are: for aria-posinset and aria-setsize, as the rows not drawn still count. */
export function siblings(rows: Pick<Row, "parent">[]): { pos: number[]; size: number[] } {
  const counts = new Map<string | null, number>();
  const pos = rows.map((r) => {
    const n = (counts.get(r.parent) ?? 0) + 1;
    counts.set(r.parent, n);
    return n;
  });
  return { pos, size: rows.map((r) => counts.get(r.parent)!) };
}

/**
 * What a drop on the Bin does: items go to the bin (restorable for a week); folders, timelines and drafts
 * are deleted (a folder's items go to the folder above it). Null when there is nothing to drop; projects
 * are never dragged, so never binned.
 */
export function planBin(items: Moving[]): { assets: string[]; folders: string[]; timelines: string[]; drafts: string[] } | null {
  if (!items.length) return null;
  const of = (k: Moving["kind"]) => items.filter((m) => m.kind === k).map((m) => m.id);
  return { assets: of("asset"), folders: of("folder"), timelines: of("timeline"), drafts: of("draft") };
}
