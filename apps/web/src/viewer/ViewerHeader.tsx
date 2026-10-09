import { useRef, useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Film, Folder, X } from "lucide-react";
import { api, type Asset, type AssetDetail } from "../api";
import { openProjects } from "../bar/bridge";
import { assetKey, useFolders, useProjects, type useAsset } from "../data";
import { Kbd } from "../Keys";
import { cx } from "../ui";
import { factsOf, placesOf } from "./facts";
import type { ViewerActions } from "./useViewerActions";

const chip = "flex min-w-0 max-w-full items-center gap-1.5 rounded-lg border border-line bg-raised px-2.5 py-1 text-xs text-ink hover:border-line-strong hover:bg-hover";

/** Where it is filed: its project and folder, "root folder" for the project's own, the Inbox when in none. Opens the Projects panel searched on it. */
function PlaceChip({ a, onLeave }: { a: Asset; onLeave(): void }) {
  const folders = useFolders();
  const projects = useProjects();
  const all = folders.data?.items ?? [];
  const folder = a.folderId ? all.find((f) => f.id === a.folderId) : undefined;
  // a folder not read yet: nothing rather than a wrong "Inbox"
  if (a.folderId && !folder) return null;
  const project = folder?.projectId ? projects.data?.items.find((p) => p.id === folder.projectId) : undefined;
  const root = Boolean(project && project.folderId === folder?.id);
  // a folder inside another shows where it is, up to the project's root folder
  const pathOf = (id: string | null): string[] => {
    const f = all.find((x) => x.id === id);
    return !f || f.id === project?.folderId ? [] : [...pathOf(f.parentId), f.name];
  };
  const label = !folder ? "Inbox" : `${project?.name ?? "Inbox"} › ${root ? "root folder" : pathOf(folder.id).join(" › ")}`;
  const search = !folder ? undefined : root ? project!.name : folder.name;
  return (
    <button type="button" data-tip="Show it in the Projects panel" onClick={() => { onLeave(); openProjects(search); }} className={chip}>
      <Folder size={13} className="shrink-0 text-accent" />
      <span className="truncate">{label}</span>
    </button>
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
 * The top of the viewer's side: where it is in the list and the way out, the item's name (F2 or a click
 * renames it in place), what it is in one line, and where it lives: its folder and the timeline clips it is in.
 */
export function ViewerHeader({ acts, asset, detail, title, trail, onTrail, items, naming, onNaming, onClose }: {
  acts: ViewerActions;
  /** The item as it was listed: what the listing knows of it (its timeline clip) before its details are read. */
  asset: Asset;
  detail: ReturnType<typeof useAsset>;
  /** What made it: shown in place of a name it has not been given. */
  title: string;
  trail: Asset[];
  onTrail(trail: Asset[]): void;
  items?: Asset[];
  naming: boolean;
  onNaming(naming: boolean): void;
  onClose(): void;
}) {
  const { a, g, at, move } = acts;
  const qc = useQueryClient();
  const [, go] = useLocation();
  const rename = useMutation({
    mutationFn: (v: { id: string; name: string }) => api.renameAsset(v.id, v.name),
    onSuccess: (_, v) => {
      // the new name at once; the lists read theirs again
      qc.setQueryData<AssetDetail>(assetKey(v.id), (d) => (d ? { ...d, name: v.name } : d));
      void qc.invalidateQueries({ queryKey: ["assets"] });
    },
  });
  const save = (name: string) => {
    onNaming(false);
    if (name !== a.name) rename.mutate({ id: a.id, name });
  };
  const own = detail.data?.id === a.id ? detail.data : undefined;
  const places = placesOf(own?.clipOf ?? (asset.id === a.id ? asset.clipOf : undefined), own?.usedIn ?? []);
  const count = at >= 0 && items && items.length > 1 ? items.length : 0;
  const button = "flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-line-strong text-ink-2 hover:bg-hover hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent";
  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-b border-line px-5 pt-3.5 pb-3.5">
      <div className="flex items-center gap-2.5 text-xs text-ink-3">
        {trail.length > 0 && (
          <button type="button" aria-label="Back to the previous item" data-tip="Back to the previous item" onClick={() => onTrail(trail.slice(0, -1))} className={button}><ChevronLeft size={14} /></button>
        )}
        {count > 0 && (
          <>
            <span data-tip="Arrow keys: previous and next item">{at + 1} of {count}</span>
            <button type="button" aria-label="Previous" data-tip="Previous (←)" disabled={at <= 0} onClick={() => move(-1)} className={button}><ChevronLeft size={14} /></button>
            <button type="button" aria-label="Next" data-tip="Next (→)" disabled={at >= count - 1} onClick={() => move(1)} className={button}><ChevronRight size={14} /></button>
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
          {!a.inBin && <span className="shrink-0 text-[11px] font-medium text-ink-3 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"><Kbd>F2</Kbd></span>}
        </button>
      )}
      {rename.isError && <span className="text-xs text-warn-ink">{rename.error.message}</span>}

      <span className="text-[12.5px] text-ink-2">{factsOf(a, g, a.shownName || a.name ? title : "")}</span>

      <div className="mt-1 flex flex-wrap gap-1.5">
        <PlaceChip a={a} onLeave={onClose} />
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
