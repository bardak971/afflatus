import { Archive, ArchiveRestore, ArrowRight, FileOutput, Film, Folder, FolderKanban, FolderOpen, FolderPlus, FolderRoot, Layers, Link2, LogIn, Pencil, PenLine, Pin, PinOff, Play, RefreshCw, Sparkles, Trash2, Unlink, Upload, Wand2, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { fold, type MenuItem } from "../ContextMenu";
import { plural, size } from "../format";

/**
 * The one list of what can be done with a timeline, a draft, a folder (of the library, or linked from the disk), a project
 * and the Inbox, as itemActions.tsx is for an item of the library: every place that shows actions on one (the Studio's
 * timeline cards and drafts list, the Projects panel's rows, the command bar) shows this list, in this order, with these
 * labels, keys and notes. A place only leaves out what makes no sense there (Show in Projects inside the Projects panel,
 * Open on the draft that is open); it never adds a variant of its own. Pure, for the tests: the hook that fills it with
 * what each action does is useKindActions.tsx.
 */

export type MenuKind = "timeline" | "draft" | "folder" | "linked" | "project" | "inbox";

export type KindActionId =
  | "open" | "show"
  | "render-missing" | "finish" | "export" | "fix-all" | "generate" | "duplicate" | "pin"
  | "new-folder" | "import" | "root" | "link" | "rescan" | "relink"
  | "rename" | "put" | "move"
  | "archive" | "bin-unused" | "delete" | "unlink";

interface Spec {
  id: KindActionId;
  label: string;
  /** The key that does it where the list's keys act (a timeline card, a row of the Projects panel). */
  key?: string;
  icon: LucideIcon;
  /** What it does, in a sentence: the line's tip. */
  tip: string;
  /** A few quiet words on what it does, when nothing more pressing (why it is off, how many) is said. */
  note?: string;
  danger?: boolean;
  /** It acts on several picked at once ("Delete 3…"); the others are left out then. */
  many?: boolean;
  /** A submenu: in the command bar each of its lines is a row of its own, these words first ("Move to Client work"). */
  flat?: string;
  /** The family it folds into in a menu (`toMenu`): the ways to add a folder; the command bar keeps them as rows. */
  sub?: "add";
}

const OPEN: Omit<Spec, "icon" | "tip"> = { id: "open", label: "Open", key: "Enter" };
const SHOW: Spec = { id: "show", label: "Show in Projects", icon: FolderKanban, tip: "The Projects panel, on it." };
// it asks the name (in the row, or in a dialog) before anything is done: an ellipsis, as the library's Rename…
const RENAME: Spec = { id: "rename", label: "Rename…", key: "F2", icon: Pencil, tip: "A name of your own." };
const MOVE: Spec = { id: "move", label: "Move to", icon: ArrowRight, note: "another project", tip: "Into another project, or out of every project to the Inbox.", many: true, flat: "Move to" };
const NEW_FOLDER: Spec = { id: "new-folder", label: "New folder inside…", icon: FolderPlus, tip: "A folder inside it, asked a name.", sub: "add" };
const IMPORT: Spec = { id: "import", label: "Import a folder here…", icon: Upload, note: "copies it in", tip: "A folder of your computer copied in, with its sub-folders.", sub: "add" };
const LINK: Spec = { id: "link", label: "Link a disk folder…", icon: Link2, note: "used in place", tip: "A folder of your disk shown here, its files used where they are: nothing is copied.", sub: "add" };
const PIN: Spec = { id: "pin", label: "Pin to the rail", icon: Pin, note: "one click away", tip: "A square on the rail, under the project worked in: one click works in it." };
const WORK: Spec = { id: "open", label: "Work in it", key: "Enter", icon: LogIn, tip: "The library, the drafts and the timelines show its own, and what you make lands in it." };

/** Every kind's list, in order; a rule ("—") between its sections. */
export const MENUS: Record<MenuKind, ReadonlyArray<Spec | "—">> = {
  timeline: [
    { ...OPEN, icon: Film, tip: "Open it in the timeline editor." },
    SHOW,
    "—",
    { id: "render-missing", label: "Render all", icon: Play, tip: "Queue the clips with nothing to play yet, as the editor's Render all does." },
    { id: "finish", label: "Finish…", icon: Sparkles, tip: "The editor's Finish: its takes made again at full quality, asked first." },
    { id: "export", label: "Export…", icon: FileOutput, tip: "The editor's Export: one video of the whole timeline." },
    { id: "fix-all", label: "Fix all", icon: Wand2, note: "what Needs a look lists", tip: "What the editor's Needs a look lists, mended as its Fix all does." },
    "—",
    RENAME,
    { id: "put", label: "Put in a folder", icon: Folder, note: "renders land there", tip: "Listed in a folder of its project; what it renders lands there.", many: true, flat: "Put in" },
    MOVE,
    "—",
    { id: "bin-unused", label: "Bin unused takes…", icon: Trash2, danger: true, tip: "The takes no clip plays and nothing else needs, to the bin: asked first, and Undo in the timeline brings them back." },
    { id: "delete", label: "Delete…", key: "Del", icon: Trash2, danger: true, note: "videos stay", many: true, tip: "The timeline deleted, asked first: its videos stay in your library." },
  ],
  draft: [
    { ...OPEN, icon: PenLine, tip: "Open it in the Studio's form." },
    SHOW,
    "—",
    { id: "generate", label: "Render again", icon: Play, note: "as its Render button", tip: "Open it and queue it, as its Render button does." },
    { id: "duplicate", label: "Duplicate", icon: Layers, note: "a new draft with its forms", tip: "A new draft with its forms, in its project." },
    "—",
    RENAME,
    MOVE,
    "—",
    { id: "delete", label: "Delete…", key: "Del", icon: Trash2, danger: true, note: "its outputs stay", many: true, tip: "The draft deleted with its conversation, asked first: what was made from it stays." },
  ],
  folder: [
    { ...OPEN, icon: FolderOpen, tip: "Its items, in the Studio." },
    SHOW,
    "—",
    NEW_FOLDER,
    IMPORT,
    { id: "root", label: "Use as the project's root", icon: FolderRoot, note: "renders land there", tip: "What is made in its project lands in it, unless another of its folders is open." },
    "—",
    RENAME,
    { ...MOVE, note: undefined },
    "—",
    { id: "delete", label: "Delete…", key: "Del", icon: Trash2, danger: true, note: "items move up", many: true, tip: "The folder deleted, asked first: its items move to the folder above it." },
  ],
  linked: [
    { ...OPEN, icon: FolderOpen, tip: "Its files, in the Studio." },
    SHOW,
    "—",
    { id: "rescan", label: "Rescan", icon: RefreshCw, note: "what changed on disk", tip: "The folder read again: what is new appears, what is gone goes." },
    { id: "relink", label: "Link again…", icon: Link2, note: "where it is now", tip: "A folder that was moved on your disk, pointed at where it is now: its files keep their places." },
    { ...NEW_FOLDER, note: "on your disk", tip: "A new directory inside it, on your disk." },
    "—",
    RENAME,
    { ...MOVE, note: undefined },
    "—",
    { id: "unlink", label: "Unlink…", icon: Unlink, danger: true, note: "disk untouched", tip: "No longer shown, asked first: nothing on your disk is touched." },
  ],
  project: [
    WORK,
    SHOW,
    PIN,
    "—",
    NEW_FOLDER,
    IMPORT,
    LINK,
    { id: "root", label: "Make a root folder", icon: FolderRoot, note: "renders land there", tip: "A folder named after the project, where what is made in it lands." },
    "—",
    RENAME,
    { id: "archive", label: "Archive", icon: Archive, note: "hides it, keeps all", tip: "Out of the lists, everything in it kept: Unarchive brings it back." },
    "—",
    { id: "delete", label: "Delete…", key: "Del", icon: Trash2, danger: true, note: "items go to the Inbox", tip: "The project deleted, asked first: its drafts, timelines and folders go to the Inbox." },
  ],
  inbox: [
    { ...WORK, tip: "The library, the drafts and the timelines out of every project." },
    SHOW,
    PIN,
    "—",
    NEW_FOLDER,
    IMPORT,
    LINK,
  ],
};

/** What the list is made from: what is known of the one (or the several) it acts on. A fact not known here is left out. */
export interface KindFacts {
  kind: MenuKind;
  /** How many it acts on: several picked keep only what acts on them all, counted in the label ("Delete 3…"). */
  count?: number;
  /** A timeline's clips, and those with nothing to play yet. */
  clips?: number;
  toRender?: number;
  exported?: boolean;
  /** A timeline's unused takes; null: none; left out while they are read; "unread": the read failed. */
  unused?: { takes: number; bytes: number } | null | "unread";
  /** A folder in a project (a folder of the Inbox is no project's root). */
  inProject?: boolean;
  /** A sub-folder of a folder of the disk: only the folder that was linked is renamed, moved or unlinked. */
  sub?: boolean;
  /** A folder of the disk whose directory is not found. */
  missing?: boolean;
  /** A project. */
  archived?: boolean;
  hasRoot?: boolean;
  pinned?: boolean;
  /** The rail holds four. */
  pinsFull?: boolean;
  /** The project (or the Inbox) is the one worked in. */
  working?: boolean;
}

/** One action of the list, as a place draws it. */
export interface KindAction {
  id: KindActionId;
  label: string;
  key?: string;
  icon: LucideIcon;
  tip: string;
  note?: string;
  disabled: boolean;
  danger?: boolean;
  /** Its section in the list: a rule is drawn where it changes. */
  section: number;
  flat?: string;
  sub?: "add";
  run?(): void;
  items?: MenuItem[];
}

export type KindRuns = Partial<Record<KindActionId, () => void>>;
/** The submenus' lines: the projects to move to, the folders to put a timeline in. */
export type KindSubs = Partial<Record<"move" | "put", MenuItem[]>>;

/** Whether a submenu has a line that works. */
const anyOn = (items: MenuItem[] | undefined): boolean => Boolean(items?.some((it) => it !== "—" && !it.disabled && (it.run || anyOn(it.items))));

/**
 * The kind's list: every action it has, in order; one that cannot run now stays in its place, off, with the reason as its
 * note, when the user can make it run (clips to add, a project to unarchive). One that would change nothing whatever the
 * user does is not in it (the menus' rule, ContextMenu.tsx): Work in it where one works already, Render all with nothing
 * to render, Bin unused takes with none, Link again on a folder that was not moved, what the place does not do at all.
 * `hide` is what the place leaves out. Several picked (`count` over one): only what acts on them all.
 */
export function kindActions(f: KindFacts, runs: KindRuns, subs: KindSubs = {}, hide: readonly KindActionId[] = []): KindAction[] {
  const n = f.count ?? 1;
  const many = n > 1;
  const noClips = f.clips === 0 ? "no clips" : undefined;
  const why = (id: KindActionId): string | undefined => {
    switch (id) {
      case "open": return f.kind === "project" && f.archived ? "unarchive it first" : (f.kind === "project" || f.kind === "inbox") && f.working ? "working in it" : undefined;
      case "render-missing": return noClips ?? (f.toRender === 0 ? "none to render" : undefined);
      case "finish": case "export": case "fix-all": return noClips;
      case "bin-unused": return f.unused === undefined ? "reading…" : f.unused === "unread" ? "could not be read" : f.unused === null || !f.unused.takes ? "none" : undefined;
      case "root": return f.kind === "folder" && !f.inProject ? "in the Inbox" : undefined;
      case "rescan": return f.missing ? "not found on your disk" : undefined;
      case "relink": return f.missing ? undefined : "only when moved";
      case "pin": return f.pinned ? undefined : f.archived ? "unarchive it first" : f.pinsFull ? "the rail holds four" : undefined;
      case "put": return anyOn(subs.put) ? undefined : "no folder in its project";
      case "move": return anyOn(subs.move) ? undefined : "no project yet";
      default: return undefined;
    }
  };
  // what is not there at all: a sub-folder of the disk is not renamed, moved or unlinked; a project with a root folder makes none
  const gone = (id: KindActionId) => hide.includes(id) || (f.sub && (id === "rename" || id === "move" || id === "unlink")) || (id === "root" && f.kind === "project" && f.hasRoot) || dead(id);
  /** What can never do anything here, whatever the user does: not drawn. */
  function dead(id: KindActionId): boolean {
    switch (id) {
      case "open": return (f.kind === "project" || f.kind === "inbox") && Boolean(f.working) && !f.archived;
      case "render-missing": return f.clips !== 0 && f.toRender === 0;
      case "bin-unused": return f.unused === null || (typeof f.unused === "object" && !f.unused.takes);
      case "relink": return !f.missing;
      default: return false;
    }
  }
  const out: KindAction[] = [];
  let section = 0;
  for (const spec of MENUS[f.kind]) {
    if (spec === "—") {
      section++;
      continue;
    }
    if (gone(spec.id) || (many && !spec.many)) continue;
    const off = why(spec.id);
    const items = spec.id === "move" || spec.id === "put" ? subs[spec.id] : undefined;
    const run = runs[spec.id];
    // what the place does not do (no run there, nothing to choose, no reason the user could change): not drawn
    if (!off && !run && !items?.length) continue;
    const a: KindAction = {
      id: spec.id, label: spec.label, key: spec.key, icon: spec.icon, tip: spec.tip, note: off ?? spec.note, danger: spec.danger, section, flat: spec.flat, sub: spec.sub,
      disabled: Boolean(off) || (!run && !items?.length), run, items: off ? undefined : items,
    };
    out.push(counted(withState(a, f, off), n));
  }
  return out;
}

/** What the facts change in a line beyond off and on: how many, a switch's other side. */
function withState(a: KindAction, f: KindFacts, off: string | undefined): KindAction {
  switch (a.id) {
    case "render-missing": return off || !f.toRender ? a : { ...a, note: plural(f.toRender, "clip") };
    case "export": return off || !f.exported ? a : { ...a, note: "exported before" };
    case "bin-unused": return off || !f.unused || f.unused === "unread" ? a : { ...a, note: `${f.unused.takes} · ${size(f.unused.bytes)}` };
    case "import": return f.kind === "project" && !f.hasRoot ? { ...a, note: "makes its root folder first" } : a;
    case "pin": return f.pinned ? { ...a, label: "Unpin from the rail", icon: PinOff, note: undefined, tip: "Off the rail; it stays among the projects." } : a;
    case "archive": return f.archived ? { ...a, label: "Unarchive", icon: ArchiveRestore, note: "back among the projects", tip: "Back among the projects, to work in." } : a;
    default: return a;
  }
}

/** Several picked: the count in the label, as "Delete 3…", "Move 3 to", "Put 3 in a folder". */
function counted(a: KindAction, n: number): KindAction {
  if (n < 2) return a;
  switch (a.id) {
    case "delete": return { ...a, label: `Delete ${n}…`, note: undefined };
    case "move": return { ...a, label: `Move ${n} to` };
    case "put": return { ...a, label: `Put ${n} in a folder` };
    default: return a;
  }
}

/**
 * The list as a menu: a rule between its sections, the keys drawn where they act (`keys`). The ways to add a folder (New
 * folder, Import, Link) fold into "Add a folder" when they are three and the menu holds more than them (a project's tree,
 * scoped, keeps only them: flat there).
 */
export function toMenu(list: KindAction[], keys: boolean): MenuItem[] {
  const line = (a: KindAction): MenuItem => ({ label: a.label, key: keys ? a.key : undefined, icon: <a.icon size={14} />, note: a.note, danger: a.danger, disabled: a.disabled, ...(a.items ? { items: a.items } : { run: a.run }) });
  const adds = list.filter((a) => a.sub === "add");
  const folding = adds.length >= 3 && adds.length < list.length;
  const out: MenuItem[] = [];
  let section: number | null = null;
  for (const a of list) {
    if (section !== null && a.section !== section) out.push("—");
    section = a.section;
    if (folding && a.sub === "add") {
      if (a === adds[0]) out.push(...fold("Add a folder", <FolderPlus size={14} />, adds.map(line)));
      continue;
    }
    out.push(line(a));
  }
  return out;
}

/** A line of the command bar: the shape of its actions (bar/useActions.tsx). */
export interface BarLine {
  label: string;
  note?: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  run(): unknown;
}

/** A submenu's line named after the action, for the bar: "The Inbox" under Move to is "Move to the Inbox". */
const flatLabel = (flat: string, label: string) => `${flat} ${label.replace(/^The /, "the ")}`;

/** The list as the command bar's rows: a submenu becomes a row per line ("Move to Client work", "Put in Rushes"), where it is not already. */
export function toBar(list: KindAction[]): BarLine[] {
  return list.flatMap((a): BarLine[] => {
    if (a.flat && a.items) {
      return a.items.flatMap((it): BarLine[] => (it === "—" || !it.run || it.disabled ? [] : [{ label: flatLabel(a.flat!, it.label), icon: it.icon ?? <a.icon size={14} />, note: it.note, disabled: it.disabled, run: it.run }]));
    }
    if (a.flat) return [];
    return [{ label: a.label, icon: <a.icon size={14} />, note: a.note, danger: a.danger, disabled: a.disabled, run: () => a.run?.() }];
  });
}

/** The one Delete question of each kind, for one or several of it: the words every place asks with. */
export function deleteQuestion(kind: "timeline" | "draft" | "folder", names: string[]): { title: string; text: string; yes: string } {
  const one = names.length === 1;
  const title = one ? `Delete ${names[0]}?` : `Delete these ${names.length} ${kind}s?`;
  const text = {
    timeline: one
      ? "Its videos stay in your library; only the sequence goes. A deleted timeline cannot be restored from the bin."
      : "Their videos stay in your library; only the sequences go. Deleted timelines cannot be restored from the bin.",
    draft: one
      ? "It goes with its form and its conversation with the designer. What was made from it stays in your library. A deleted draft cannot be restored from the bin."
      : "They go with their forms and their conversations with the designer. What was made from them stays in your library. Deleted drafts cannot be restored from the bin.",
    folder: one
      ? "Its items move to the folder above it. A deleted folder cannot be restored from the bin."
      : "Their items move to the folder above each. Deleted folders cannot be restored from the bin.",
  }[kind];
  return { title, text, yes: "Delete" };
}
