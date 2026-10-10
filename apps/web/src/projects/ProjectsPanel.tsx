import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { Reveal } from "../bar/bridge";
import { useQueryClient } from "@tanstack/react-query";
import type { Asset } from "../api";
import { ContextMenu } from "../ContextMenu";
import { useFolders, useProjects, useProjectsTree, useStorage } from "../data";
import { size } from "../format";
import { useProject } from "../project";
import { useOpenDraft, type Place } from "../store";
import { Button, cx, ErrorNote } from "../ui";
import { usePins } from "./pins";
import { groupKey, rangePick, type Row, type Target } from "./tree";
import { PanelBar, ScopedFoot, SortHeads } from "./PanelParts";
import { TreeRow } from "./TreeRow";
import { useTreePrefs } from "./useTreePrefs";
import { useFolds } from "./useFolds";
import { useReveal } from "./useReveal";
import { useRowActivate } from "./useRowActivate";
import { usePanelPlace } from "./usePanelPlace";
import { useRowMenus } from "./useRowMenus";
import { useRowWindow } from "./useRowWindow";
import { useTreeActions } from "./useTreeActions";
import { useTreeDrag } from "./useTreeDrag";
import { useTreeKeys } from "./useTreeKeys";
import { useTreeRows } from "./useTreeRows";

/** The columns of every row, under their heads: Name · Holds · Created · Size. */
const COLUMNS = "grid-cols-[minmax(160px,1fr)_minmax(0,300px)_84px_72px]";
/** One project's tree, under the library's breadcrumb: narrower, so Name · Holds · Size. */
const SCOPED_COLUMNS = "grid-cols-[minmax(140px,1fr)_minmax(0,220px)_72px]";

/**
 * The Projects panel, beside the rail: every project as a tree of its folders, timelines and drafts.
 * A click switches to a project or opens what it is; Ctrl / Shift + click picks several; rows are dragged
 * onto a project, the Inbox or a folder to move them; a right-click gives the rest. Escape or a click
 * elsewhere closes it; a menu or a question opened from it does not.
 *
 * With `scope`, the same tree for one project only (or the Inbox), under the library's breadcrumb: its rows are places
 * of the library (`onPlace`), it takes the library's items and timelines dropped on it, and it never lists another
 * project (the rail switches projects).
 */
export function ProjectsPanel({ anchor, onClose, onNew, onView, hidden, search: searchFor, reveal, scope }: {
  anchor: RefObject<HTMLElement | null>;
  /** An item to open on ("Show in the Projects panel"): its project and folders unfolded, its row picked and in sight. */
  reveal?: Reveal;
  /** What the search starts on (a name the command bar was asked to show). */
  search?: string;
  onClose(): void;
  onNew?(): void;
  /** One project's tree (`group`: its id, null for the Inbox), for the library's breadcrumb. */
  scope?: {
    group: string | null;
    /** Where the library is: its row is lit. */
    place: Place;
    onPlace(p: Place): void;
    /** Opened by itself while something is dragged: a line says to drop it on a folder. */
    dragging?: boolean;
  };
  /** An item clicked: shown large in the Viewer, the panel kept underneath. */
  onView(asset: Asset): void;
  /** Kept as it is but not shown, while the Viewer is over it. */
  hidden?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const current = useProject((s) => s.id);
  const setProject = useProject((s) => s.set);
  const openDraftId = useOpenDraft((s) => s.id);
  const projects = useProjects();
  const folders = useFolders();
  const storage = useStorage();
  const actions = useTreeActions();
  const pins = usePins();
  const client = useQueryClient();
  // "Import a folder…": the computer's folder picker, and where what it picks goes
  const picker = useRef<HTMLInputElement>(null);
  const importTo = useRef<Target | null>(null);
  const importInto = (t: Target) => {
    importTo.current = t;
    picker.current?.click();
  };

  const scoped = Boolean(scope);
  const { place, covered } = usePanelPlace({ panel, anchor, scoped, onClose });

  // the search: what is typed, and what is asked for a quarter second after the last key
  const [text, setText] = useState(searchFor ?? "");
  const [q, setQ] = useState(searchFor?.trim().slice(0, 100) ?? "");
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim().slice(0, 100)), 250);
    return () => clearTimeout(t);
  }, [text]);
  // which kind of item the folders show and count, and the column the rows are sorted by: kept per browser
  const { kind, setKind, sort, sortBy } = useTreePrefs(scoped);
  const tree = useProjectsTree(q, kind);
  const only = scope ? { group: scope.group } : undefined;

  // unfolded rows: kept per browser; while searching every branch is open unless folded then
  const currentKey = groupKey({ id: current === "none" ? null : current });
  const { folds, searchFolded, isOpen, setOpen } = useFolds(q, currentKey);
  // the rows: the drafts of each open drafts row and the items of each unfolded folder read when they open
  const { groups, rows, byKey, sibs, footHeight, found, readMore } = useTreeRows({ data: tree.data, q, kind, sort, only, current, isOpen, folds, searchFolded, bin: storage.data?.bin });

  // picked rows (kept with what they are, so that one folded away still moves with the others), the last one picked, the row the keys are on
  const [picked, setPicked] = useState<Map<string, Row>>(new Map());
  const [pickAnchor, setPickAnchor] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  // the focused row's ring shows once the keys moved it, not after a click
  const [keyed, setKeyed] = useState(false);
  // "Show in the Projects panel": the item's row unfolded to, picked and in sight
  useReveal({ reveal, folders: folders.data?.items, setOpen, rows, setFocused, setPicked });
  const [renaming, setRenamingState] = useState<{ key: string; name: string } | null>(null);
  // also in a ref: Enter and the blur that follows it, or Escape and that blur, end the same renaming once
  const renameRef = useRef<{ key: string; name: string } | null>(null);
  const setRenaming = (v: { key: string; name: string } | null) => {
    renameRef.current = v;
    setRenamingState(v);
  };
  const clearPicks = () => setPicked(new Map());
  // the list drawn in a window: only the rows in sight, the row the keys are on brought into sight
  const { head, firstGap, measure, drawn } = useRowWindow({ list, rows, focused, footHeight, opened: place !== null });

  // the row lit: the project worked in; in one project's tree, the place the library is on
  const at = scope?.place;
  const hereKey = !at ? currentKey : at.type === "folder" ? `f:${at.id}` : at.type === "bin" ? "bin" : at.type === "unfiled" ? "loose" : currentKey;
  const toggle = (r: Row) => r.foldable && setOpen(r.key, !r.open);
  // what a plain click (or Enter) does: switch to it, open it, or fold it
  const { activate, showInStudio, targetOf } = useRowActivate({ scope, current, setProject, toggle, readMore, onView, onClose });

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

  const remove = (rs: Row[]) => void actions.remove(rs).then(clearPicks);
  /** A group's empty drafts deleted, asked in place on their row (from its Clear button or its menu); the open one stays. */
  const [clearAsk, setClearAsk] = useState<string | null>(null);
  const clearEmpty = (r: Row) => void actions.clearEmpty(r.group, groups.find((g) => g.id === r.group)?.name ?? "the Inbox", openDraftId);
  const startRename = (r: Row) => (r.kind === "project" || (r.kind === "folder" && (!r.linked || r.linkedRoot)) || r.kind === "timeline") && r.id && setRenaming({ key: r.key, name: r.label });

  // the right-click menus: one per kind of row, and the selection bar's "Move to"
  const menus = useRowMenus({
    picked, rows, byKey, scoped, current, projects: projects.data?.items ?? [], folders: folders.data?.items ?? [], groups,
    binCount: storage.data?.bin.count ?? 0, binBytes: storage.data?.bin.bytes ?? 0, actions, pins, setProject, setOpen, setFocused, setClearAsk,
    clearPicks, activate, startRename, remove, importInto, onView, showInStudio,
  });
  // dragging rows onto a project, the Inbox or a folder, and the library's items and files from the computer
  const drag = useTreeDrag({ picked, renaming: Boolean(renaming), setOpen, actions, clearPicks, targetOf, list, head, footHeight });
  // the keys: ↑ ↓ walk, ← → fold or go up, Enter opens, F2 renames, Del deletes, typing searches, Escape closes
  useTreeKeys({
    panel, list, search, anchor, opened: place !== null, hidden, rows, byKey, hereKey, focused, setFocused, setKeyed, picked, clearPicks,
    pickedItems: menus.pickedItems, renaming, setRenaming, clearAsk, setClearAsk, text, setText, toggle, click, startRename, remove,
    openRowMenu: menus.openRowMenu, itemMenu: menus.itemMenu, actions, onClose,
  });

  if (!place) return null;

  const commitRename = async () => {
    const cur = renameRef.current;
    if (!cur) return;
    const r = byKey.get(cur.key);
    const name = cur.name.trim();
    setRenaming(null);
    if (r) await actions.rename(r, name);
    list.current?.focus({ preventScroll: true });
  };

  const scopeName = scope ? (scope.group === null ? "Inbox" : projects.data?.items.find((p) => p.id === scope.group)?.name ?? "…") : "";
  const columns = scoped ? SCOPED_COLUMNS : COLUMNS;
  // the foot of one project's tree makes things where the library is: in the open folder, else at the project's top
  // (read from the folders, not the rows: the open folder may be folded away under another)
  const openF = at?.type === "folder" ? folders.data?.items.find((f) => f.id === at.id) : undefined;
  const groupRow = scope ? byKey.get(groupKey({ id: scope.group })) : undefined;

  return createPortal(
    <div
      ref={panel}
      role="dialog"
      aria-label={scoped ? `${scopeName}: folders, timelines and drafts` : "Projects"}
      style={{ left: place.left, top: place.top, width: place.width, maxHeight: place.maxHeight }}
      className={cx("fixed z-[66] flex flex-col rounded-2xl border border-line-strong bg-panel text-sm shadow-2xl shadow-shade/60 motion-safe:animate-[peek-rise_120ms_ease-out]", (hidden || covered) && "invisible")}
    >
      {/* the notch that points at the rail's button */}
      {!scoped && <span aria-hidden className="absolute -left-[7px] h-3 w-3 rotate-45 border-b border-l border-line-strong bg-panel" style={{ top: Math.max(10, Math.min(place.arrow - 6, 40)) }} />}
      {scope?.dragging && <div className="mx-3 mt-3 rounded-lg bg-accent px-2.5 py-1.5 text-xs font-bold text-accent-ink">Drop on a folder to put it there</div>}
      <PanelBar
        scoped={scoped}
        scopeName={scopeName}
        inboxOnly={scope?.group === null}
        searchRef={search}
        text={text}
        setText={setText}
        found={q ? found : null}
        kind={kind}
        setKind={setKind}
        onNew={onNew}
      />

      <div
        ref={list}
        role="tree"
        aria-label="Projects, folders, timelines and drafts"
        aria-multiselectable
        aria-activedescendant={focused ? `tree-${focused}` : undefined}
        tabIndex={0}
        onScroll={measure}
        onDragOver={drag.edgeScroll}
        // no ring around the whole list: the row the keys are on has its own (the app's :focus-visible outline would beat a class)
        style={{ outline: "none" }}
        // no padding above or below: a sticky row stops at the padding's edge, so the rows scrolled past would show in it, above the column heads and under the Bin
        className="relative min-h-0 grow overflow-y-auto border-t border-line px-2"
      >
        {/* the columns: a click sorts each level by it, again turns it around */}
        <SortHeads headRef={head} columns={columns} scoped={scoped} sort={sort} sortBy={sortBy} />
        {tree.isError && <div className="p-3"><ErrorNote>{tree.error.message}</ErrorNote></div>}
        {tree.isPending && <div className="p-4 text-ink-2">Reading your projects…</div>}
        {tree.isSuccess && q && !groups.length && <div className="py-10 text-center text-ink-2">Nothing called “{q}”. The search looks at projects, folders, timelines and drafts.</div>}
        {/* the rows drawn: those in sight and a few more, the row the keys are on, the one renamed or dragged, the Bin (it stays at the foot) */}
        {drawn([focused, renaming?.key, drag.dragFrom.current, footHeight ? "bin" : null]).map((d, n) => {
          // the rows not drawn, as tall as they are; never what the browser keeps in place on a change (it grows as the list scrolls)
          if ("gap" in d) return <div key={`gap-${n}`} ref={n === 0 ? firstGap : undefined} aria-hidden style={{ height: d.gap, overflowAnchor: "none" }} />;
          const { r, i } = d;
          return (
            <TreeRow
              key={r.key}
              r={r}
              setSize={sibs.size[i]}
              posInSet={sibs.pos[i]}
              columns={columns}
              scoped={scoped}
              q={q}
              isPicked={picked.has(r.key)}
              here={r.key === hereKey}
              ringed={keyed && focused === r.key}
              pinned={pins.has(r.id ?? "none")}
              renaming={renaming}
              setRenaming={setRenaming}
              commitRename={commitRename}
              drag={drag}
              clearAsk={clearAsk}
              setClearAsk={setClearAsk}
              clearEmpty={clearEmpty}
              onClick={(e) => {
                setKeyed(false);
                click(r, e);
              }}
              onMenu={(e) => {
                setKeyed(false);
                menus.rowMenu(r, e);
              }}
              onFold={() => {
                setKeyed(false);
                setFocused(r.key);
                toggle(r);
              }}
              onMakeRoot={() => {
                if (r.id) void actions.setRoot({ id: r.id, name: r.label });
              }}
            />
          );
        })}
      </div>

      {picked.size > 0 && (
        <div className="flex items-center gap-2 border-t border-line bg-picture/8 px-3 py-2">
          <span className="text-[13px] font-bold text-picture">{picked.size} selected</span>
          <span className="text-xs text-ink-2">drag them together, or</span>
          <span className="grow" />
          <Button size="sm" onClick={(e) => menus.openMenu(e, "picked")}>Move to…</Button>
          <Button size="sm" tone="danger" onClick={() => remove([...picked.values()])}>Delete…</Button>
          <Button size="sm" tone="quiet" onClick={clearPicks}>Clear</Button>
        </div>
      )}
      {scoped ? (
        // what is made in this project, where the library is: in the open folder, else at its top
        <ScopedFoot folder={openF} groupTarget={groupRow?.target} actions={actions} importInto={importInto} onClose={onClose} />
      ) : (
        <div className="flex items-center gap-3.5 border-t border-line px-4 py-2.5 text-xs text-ink-2">
          <span className="shrink-0 font-mono whitespace-nowrap text-ink">{tree.data ? `${size(tree.data.totalBytes)} in all` : ""}</span>
        </div>
      )}
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
      {menus.itemMenu.element}
      {menus.menu && <ContextMenu at={menus.menu.at} label={menus.menu.subject === "picked" ? "Move to" : menus.menu.subject.label} head={menus.menuHead(menus.menu.subject)} items={menus.menuItems(menus.menu.subject)} onClose={menus.closeMenu} />}
    </div>,
    document.body,
  );
}
