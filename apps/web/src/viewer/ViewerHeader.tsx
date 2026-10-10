import { Fragment, useRef, useState } from "react";
import { useLocation } from "wouter";
import { ChevronDown, ChevronLeft, ChevronRight, Film, Folder, FolderPlus, FolderTree, X } from "lucide-react";
import type { Asset } from "../api";
import { openProjects } from "../bar/bridge";
import { useFolders, useProjects, type useAsset } from "../data";
import { ContextMenu, useMenu, type MenuItem } from "../ContextMenu";
import { Keys } from "../Keys";
import { cx } from "../ui";
import { tileName } from "../screens/Library";
import { factsOf, placesOf } from "./facts";
import type { ViewerActions } from "./useViewerActions";

const chip = "flex min-w-0 max-w-full items-center gap-1.5 rounded-lg border border-line bg-raised px-2.5 py-1 text-xs text-ink hover:border-line-strong hover:bg-hover";

/**
 * Where it is filed: its project and folder, "root folder" for the project's own, the Inbox when in none. A picker: the
 * item's Move to (project › folder, the Inbox), a new folder for it, and the way to it in the Projects panel. The one
 * place of the side where the folder is shown and changed.
 */
function PlaceChip({ a, acts, onLeave }: { a: Asset; acts: ViewerActions; onLeave(): void }) {
  const folders = useFolders();
  const projects = useProjects();
  const menu = useMenu<true>();
  const all = folders.data?.items ?? [];
  const folder = a.folderId ? all.find((f) => f.id === a.folderId) : undefined;
  // a folder not read yet: a quiet chip of the same size rather than a wrong "Inbox" (no jump when it is read)
  if (a.folderId && !folder) return <span aria-hidden className={cx(chip, "w-24 animate-pulse")}>&nbsp;</span>;
  const project = folder?.projectId ? projects.data?.items.find((p) => p.id === folder.projectId) : undefined;
  const root = Boolean(project && project.folderId === folder?.id);
  // a folder inside another shows where it is, up to the project's root folder
  const pathOf = (id: string | null): string[] => {
    const f = all.find((x) => x.id === id);
    return !f || f.id === project?.folderId ? [] : [...pathOf(f.parentId), f.name];
  };
  const label = !folder ? "Inbox" : `${project?.name ?? "Inbox"} › ${root ? "root folder" : pathOf(folder.id).join(" › ")}`;
  const items: MenuItem[] = a.inBin
    ? [{ label: "Show in Projects", icon: <FolderTree size={14} />, run: () => { onLeave(); openProjects(undefined, { asset: a.id, folder: a.folderId ?? null, group: folder?.projectId ?? null }); } }]
    : [
        ...acts.mutations.moves(a),
        { label: "New folder…", icon: <FolderPlus size={14} />, note: "and move it there", run: () => void acts.mutations.newFolderFor(a) },
        "—",
        { label: "Show in Projects", icon: <FolderTree size={14} />, run: () => { onLeave(); openProjects(undefined, { asset: a.id, folder: a.folderId ?? null, group: folder?.projectId ?? null }); } },
      ];
  return (
    <>
      <button type="button" aria-haspopup="menu" data-tip="Where it is filed: move it to another project or folder" onClick={(e) => menu.open(e, true)} className={chip}>
        <Folder size={13} className="shrink-0 text-accent" />
        <span className="truncate">{label}</span>
        <ChevronDown size={12} className="shrink-0 text-ink-3" />
      </button>
      {menu.menu && <ContextMenu at={menu.menu.at} label="Move to" items={items} onClose={menu.close} />}
    </>
  );
}

/** The name, edited in place: Enter or leaving the box saves, Escape lets it be. */
function NameField({ value, onSave, onCancel }: { value: string; onSave(name: string): void; onCancel(): void }) {
  const [draft, setDraft] = useState(value);
  // Escape: the box goes without saving, whatever the browser says of its focus on the way
  const cancelled = useRef(false);
  return (
    <input
      autoFocus
      aria-label="Name"
      value={draft}
      maxLength={200}
      placeholder="A name for it"
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        // its keys are the box's: Escape does not close the viewer
        e.stopPropagation();
        if (e.key === "Enter") e.currentTarget.blur();
        else if (e.key === "Escape") {
          cancelled.current = true;
          onCancel();
        }
      }}
      onBlur={() => {
        if (!cancelled.current) onSave(draft.trim());
      }}
      className="-mx-[9px] rounded-lg border border-accent bg-raised px-2 py-1 text-[19px] leading-tight font-bold text-ink placeholder:font-semibold placeholder:text-ink-3"
    />
  );
}

/**
 * The trail followed from the item the viewer was opened on ("made from", "used to make"), as a breadcrumb:
 * each step goes back to it; the one shown is plain text.
 */
function Trail({ steps, crumbs, onStep }: { steps: Asset[]; crumbs: Record<string, string>; onStep(index: number): void }) {
  const label = (x: Asset, i: number) => (i > 0 && crumbs[x.id]) || tileName(x);
  return (
    <nav aria-label="Trail" className="flex min-w-0 flex-wrap items-center gap-1">
      {steps.map((x, i) => (
        <span key={`${i}:${x.id}`} className="flex min-w-0 items-center gap-1">
          {/* the › goes with the step before it: a line that wraps starts on a step */}
          {i < steps.length - 1
            ? <><button type="button" data-tip={`Back to ${label(x, i)}`} onClick={() => onStep(i)} className="flex h-6 min-w-0 max-w-[150px] items-center rounded-md border border-line bg-raised px-2 font-semibold text-ink-2 hover:border-line-strong hover:bg-hover hover:text-ink"><span className="truncate">{label(x, i)}</span></button><span aria-hidden className="text-ink-3">›</span></>
            : <span aria-current="page" className="max-w-[150px] truncate px-0.5 font-semibold text-ink">{label(x, i)}</span>}
        </span>
      ))}
    </nav>
  );
}

/**
 * The top of the viewer's side: where it is in the list (or the trail followed) and the way out, the item's name (F2 or a click
 * renames it in place), what it is in one line, and where it lives: its folder and the timeline clips it is in.
 */
export function ViewerHeader({ acts, asset, detail, title, trail, crumbs = {}, onTrail, items, naming, onNaming, onClose }: {
  acts: ViewerActions;
  /** The item as it was listed: what the listing knows of it (its timeline clip) before its details are read. */
  asset: Asset;
  detail: ReturnType<typeof useAsset>;
  /** What made it: shown in place of a name it has not been given. */
  title: string;
  trail: Asset[];
  /** What a step of the trail was to the one before it (a source's role, a kit picture's owner), by its id. */
  crumbs?: Record<string, string>;
  onTrail(trail: Asset[]): void;
  items?: Asset[];
  naming: boolean;
  onNaming(naming: boolean): void;
  onClose(): void;
}) {
  const { a, g, at, more, move, first } = acts;
  const [, go] = useLocation();
  const save = (name: string) => {
    onNaming(false);
    // the new name shows as Enter is pressed, here and in the lists; a refusal brings the old one back (assetChange.tsx)
    if (name !== a.name) acts.mutations.rename(a.id, name);
  };
  const own = detail.data?.id === a.id ? detail.data : undefined;
  const places = placesOf(own?.clipOf ?? (asset.id === a.id ? asset.clipOf : undefined), own?.usedIn ?? []);
  const count = at >= 0 && items && items.length > 1 ? items.length : 0;
  const button = "flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-line-strong text-ink-2 hover:bg-hover hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent";
  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-b border-line px-5 pt-3.5 pb-3.5">
      <div className="flex items-center gap-2.5 text-xs text-ink-3">
        {trail.length > 0 && <Trail steps={[first, ...trail]} crumbs={crumbs} onStep={(i) => onTrail(trail.slice(0, i))} />}
        {count > 0 && (
          <>
            <span data-tip={more ? "Arrow keys: previous and next item; past the last one loaded, the next page is read" : "Arrow keys: previous and next item"}>{at + 1} of {count}{more ? "+" : ""}</span>
            <button type="button" aria-label="Previous" data-tip="Previous (←)" disabled={at <= 0} onClick={() => move(-1)} className={button}><ChevronLeft size={14} /></button>
            <button type="button" aria-label="Next" data-tip="Next (→)" disabled={at >= count - 1 && !more} onClick={() => move(1)} className={button}><ChevronRight size={14} /></button>
          </>
        )}
        <span className="grow" />
        <button type="button" aria-label="Keyboard shortcuts" data-tip="Keyboard shortcuts (?)" onClick={() => window.dispatchEvent(new Event("afflatus:keys"))} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-sm text-ink-2 hover:bg-hover hover:text-ink">?</button>
        <button type="button" aria-label="Close" data-tip="Close (Esc)" onClick={onClose} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink"><X size={16} /></button>
      </div>

      {naming && !a.inBin ? (
        <NameField key={a.id} value={a.name} onSave={save} onCancel={() => onNaming(false)} />
      ) : (
        <button
          type="button"
          disabled={a.inBin}
          onClick={() => onNaming(true)}
          data-tip={a.inBin ? undefined : "Rename (F2): a name of your own, which the library shows and the search goes by"}
          className="group -mx-[9px] flex min-w-0 cursor-text items-baseline gap-2 rounded-lg border border-transparent px-2 py-1 text-left text-[19px] leading-tight font-bold hover:border-line disabled:cursor-default disabled:hover:border-transparent"
        >
          {/* a name worked out from where it came from (its own says nothing) is dim, as no name is */}
          <span className={cx("min-w-0 break-words", (a.shownName || !a.name) && "text-ink-3")}>{a.shownName || a.name || title}</span>
          {!a.inBin && <span className="shrink-0 text-[11px] font-medium text-ink-3 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"><Keys keys="F2" size="sm" /></span>}
        </button>
      )}

      <span className="text-[12.5px] text-ink-2">
        {/* the seed is in its cell under the prompt, once */}
        {/* each fact whole on its line ("rendered in 5 s" never breaks before its unit): the line wraps between them */}
        {factsOf(a, g, a.shownName || a.name ? title : "").split(" · ").map((f, i) => <Fragment key={i}>{i ? " · " : ""}<span className="whitespace-nowrap">{f}</span></Fragment>)}
      </span>

      <div className="mt-1 flex flex-wrap gap-1.5">
        <PlaceChip a={a} acts={acts} onLeave={onClose} />
        {places.slice(0, 4).map(({ of, own }) => (
          <button
            key={`${of.timeline}:${of.clip}`}
            type="button"
            data-tip={own ? `Clip ${of.clip} of ${of.timelineName}${of.takes > 1 ? `, take ${of.take} of ${of.takes}` : ""}${of.playing ? "" : " (not the take that plays)"}: open the timeline` : `A take of clip ${of.clip} of ${of.timelineName} was made from it: open the timeline`}
            onClick={() => { onClose(); go(`/timelines/${of.timeline}?clip=${of.clip}`); }}
            className={chip}
          >
            <Film size={13} className="shrink-0 text-warn" />
            <span className="truncate">{own ? "In" : "Used in"} {of.timelineName} · clip {of.clip}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
