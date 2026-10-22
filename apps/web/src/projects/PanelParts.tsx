import type { RefObject } from "react";
import { ArrowDown, ArrowUp, FolderKanban, FolderPlus, FolderUp, Link2, Plus } from "lucide-react";
import type { Folder } from "../api";
import { Button, cx, Help, SearchField, Segmented } from "../ui";
import type { ItemKind, Sort, Target } from "./tree";
import type { useTreeActions } from "./useTreeActions";


const KINDS = [{ value: "all", label: "All" }, { value: "image", label: "Images" }, { value: "video", label: "Videos" }, { value: "audio", label: "Audio" }] as const;
const HELP_SCOPED =
  "This project's folders, timelines and drafts, with what each holds and its size; other projects are switched to from the rail. Click the project's own row for the whole of it, a folder to show it in the library, a timeline or a draft to open it. Drag rows, library items or files from your computer onto a folder to put them there, or onto the Bin. Right-click for the rest.";
// three lines, not a manual: the keys, the sorting and what a drop does are in the keys sheet ("Projects panel")
const HELP =
  "Your projects as a tree: folders, timelines and drafts, with their sizes. Click the Inbox or a project to work in it, a row to open it. Drag rows, library items or files onto a project or a folder to put them there. Right-click for the rest (Pin to the rail, root folder, archive); the keys and the sorting are in Keyboard shortcuts.";

/** The Projects panel's bar: its name (one project's tree: the project's), the search, and the kind chips and New project. */
export function PanelBar({ scoped, scopeName, inboxOnly, searchRef, text, setText, found, kind, setKind, onNew }: {
  scoped: boolean;
  /** One project's tree: the project's name. */
  scopeName: string;
  /** One project's tree, of the Inbox. */
  inboxOnly: boolean;
  searchRef: RefObject<HTMLInputElement | null>;
  text: string;
  setText(text: string): void;
  /** How many rows match what is searched for; null while nothing is. */
  found: number | null;
  kind: ItemKind | null;
  setKind(kind: ItemKind | null): void;
  onNew?(): void;
}) {
  return (
    <div className={cx("flex flex-wrap items-center gap-2.5", scoped ? "px-3.5 pt-3 pb-2.5" : "px-4 pt-3.5 pb-3")}>
      {scoped ? (
        <>
          <span className="min-w-0 truncate text-title font-bold">{scopeName}</span>
          <span className="shrink-0 text-xs text-ink-3">{inboxOnly ? "the Inbox only" : "this project only"}</span>
          <Help text={HELP_SCOPED} />
        </>
      ) : (
        <>
          <span className="text-base font-bold">Projects</span>
          <Help text={HELP} />
        </>
      )}
      <SearchField
        inputRef={searchRef}
        data-search=""
        label="Search projects, folders, timelines and drafts"
        placeholder="Search folders, timelines, drafts…"
        value={text}
        onChange={setText}
        maxLength={100}
        end={found !== null && <span className="shrink-0 text-xs text-ink-3">{found} found</span>}
        className="ml-1.5 grow basis-[180px]"
        inputClassName="text-sm"
      />
      {!scoped && (
        <>
          {/* the library's own chips: which kind of item the folders show and count */}
          <Segmented oneLine label="Items shown" value={kind ?? "all"} options={[...KINDS]} onChange={(v) => setKind(v === "all" ? null : v)} />
          <Button tone="primary" size="sm" onClick={onNew} className="shrink-0">
            <Plus size={14} strokeWidth={2.4} /> New project
          </Button>
        </>
      )}
    </div>
  );
}

/** The column heads of the Projects panel's list: a click sorts each level by it, again turns it around. */
export function SortHeads({ headRef, columns, scoped, sort, sortBy }: {
  headRef: RefObject<HTMLDivElement | null>;
  /** The grid of the columns. */
  columns: string;
  /** One project's tree: no Created column. */
  scoped: boolean;
  sort: Sort;
  sortBy(by: Sort["by"]): void;
}) {
  return (
    <div ref={headRef} className={cx("sticky top-0 z-10 -mx-2 mb-0.5 grid items-center gap-2.5 border-b border-line bg-panel px-[18px] py-1 text-meta font-semibold text-ink-3 uppercase", columns)}>
      {(
        [
          { by: "name", label: "Name", end: false },
          // what a row holds says different things for each kind of row: nothing to sort by
          null,
          ...(scoped ? [] : [{ by: "created", label: "Created", end: true }] as const),
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
  );
}

/**
 * The foot of one project's tree: what is made in this project, where the library is (in the open `folder`, else at the
 * project's top), and the way to all the projects.
 */
export function ScopedFoot({ folder, groupTarget, actions, importInto, onClose }: {
  /** The folder the library is on, if it is on one. */
  folder: Folder | undefined;
  /** The project's own row's target (the Inbox's, for the Inbox). */
  groupTarget: Target | undefined;
  actions: ReturnType<typeof useTreeActions>;
  importInto(t: Target): void;
  onClose(): void;
}) {
  const openFolderRow = folder ? { label: folder.name, target: { kind: "folder", id: folder.id, group: folder.projectId, linked: Boolean(folder.path), ancestors: [], name: folder.name } satisfies Target } : undefined;
  const footTarget: Target | undefined = openFolderRow?.target ?? groupTarget;
  return (
    <div className="flex flex-wrap items-center gap-1 border-t border-line px-2 py-1.5 text-xs">
      {(
        [
          { icon: <FolderPlus size={13} />, label: openFolderRow ? `New folder in ${openFolderRow.label}` : "New folder", tip: undefined, disabled: !footTarget, run: () => footTarget && void actions.newFolder(footTarget.kind === "folder" ? { name: footTarget.name, parent: footTarget.id, project: footTarget.group } : { name: footTarget.name, parent: footTarget.root, project: footTarget.group }) },
          { icon: <Link2 size={13} />, label: "Link a local folder", tip: "A folder of the disk Afflatus runs on, shown with its sub-folders. Its files are used in place: nothing is copied.", disabled: !groupTarget, run: () => groupTarget && void actions.link(groupTarget) },
          { icon: <FolderUp size={13} />, label: openFolderRow ? `Import a folder into ${openFolderRow.label}` : "Import a folder", tip: "Every image, video and audio file in a folder of your computer is copied in, with its sub-folders.", disabled: !footTarget, run: () => footTarget && importInto(footTarget) },
        ] as const
      ).map((a) => (
        <button key={a.label} type="button" disabled={a.disabled} data-tip={a.tip} onClick={a.run} className="flex h-8 max-w-64 items-center gap-1.5 rounded-lg px-2 font-semibold text-ink-2 hover:bg-hover hover:text-ink disabled:opacity-50">
          {a.icon}
          <span className="truncate">{a.label}</span>
        </button>
      ))}
      <span className="grow" />
      <button
        type="button"
        data-tip="All your projects: switch, pin to the rail, make, archive"
        onClick={() => {
          onClose();
          window.dispatchEvent(new CustomEvent("afflatus:projects", { detail: {} }));
        }}
        className="flex h-8 items-center gap-1.5 rounded-lg px-2 font-semibold text-ink-2 hover:bg-hover hover:text-ink"
      >
        <FolderKanban size={13} /> Open Projects
      </button>
    </div>
  );
}
