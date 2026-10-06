import { useMemo, useRef, useState, type RefObject } from "react";
import { ChevronDown, Film, Folder as FolderIcon, Search, SlidersHorizontal, Star, Trash2, Undo2, X } from "lucide-react";
import { Popover } from "../../Popover";
import { useFit } from "../../useFit";
import { useLocation } from "wouter";
import { useMakeTimelineOf } from "../../actions";
import type { Asset } from "../../api";
import { useAssetFamilies, useAssetModels, useFolders, useRecipes, useProjects } from "../../data";
import { fileLabel } from "../../format";
import { Select } from "../../Select";
import { Button, cx, Segmented } from "../../ui";
import type { Place } from "../Library";
import { displayOf, type Scope, type useStudio } from "../Studio";
import { KINDS, type LibraryFilters } from "./useLibraryFilters";
import type { Selection } from "./useSelection";

// "Kept" is not a scope any more: Kept only, in Filters, does it. "All recent": the last two days of every folder, whatever folder is open
const SCOPES: Array<{ value: Scope; label: string }> = [{ value: "draft", label: "This draft" }, { value: "all", label: "Whole folder" }, { value: "recent", label: "All recent" }];
// the kinds of media, the Timelines being a view of their own (Media · Timelines)
const MEDIA_KINDS = KINDS.filter((k) => k.id !== "timeline");
const GROUP_HINT = {
  none: "Everything, newest first.",
  timeline: "Only takes of a timeline's clips, the takes of a clip stacked.",
  draft: "Only what a draft made, a section per draft.",
  day: "Everything, a section per day.",
} as const;

/**
 * The library's top row: the place (folders, bin, no folder), what the grid shows beside an open form, the
 * kinds, and either the search and filters or, with items ticked, what is done with them together.
 */
export function LibraryHeader({ place, placeName, folderButton, foldersOpen, onFolders: setFoldersOpen, view, draftId, draftOnly, items, filters, selection }: {
  place: Place;
  placeName: string;
  folderButton: RefObject<HTMLButtonElement | null>;
  /** The folders panel: opened by its button, or by itself while something is dragged. */
  foldersOpen: false | "click" | "drag";
  onFolders(open: false | "click" | "drag"): void;
  view: ReturnType<typeof useStudio.getState>;
  draftId: string | null;
  /** The grid shows only the open draft's results: the search, the kinds and the ticks are out of the way. */
  draftOnly: boolean;
  items: Asset[];
  filters: LibraryFilters;
  selection: Selection;
}) {
  const { kind, setKind, typed, setTyped, made, setMade, lora, setLora, kept, setKept, reach, showTimelines } = filters;
  // the scope the display is remembered for: with the form closed, the grid is the folder's
  const scopeNow = reach as Scope;
  const { picked, setPicked, bulk, moveTo, chosen, binChosen } = selection;
  // one line, always: what does not fit folds, step by step (useFit): 1 the kinds into a menu, 2 the search into an icon, 3 the scopes into a menu
  const bar = useRef<HTMLElement>(null);
  const fold = useFit(bar, 3);
  const [searching, setSearching] = useState(false);
  // model, LoRA, Kept only and the grouping: set now and then, so in a panel; the button says how many are on
  const filtersButton = useRef<HTMLButtonElement>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const active = [made && "model", lora && "LoRA", kept && "Kept only", !showTimelines && (view.groupBy ?? "none") !== "none" && `grouped by ${view.groupBy}`].filter((x): x is string => Boolean(x));
  const folders = useFolders();
  const projects = useProjects();
  // the ticked pictures and videos, in the order they were ticked: what a new timeline is made of
  const [, go] = useLocation();
  const make = useMakeTimelineOf({ onSuccess: (t) => go(`/timelines/${t.id}`) });
  const ordered = picked.map((id) => items.find((a) => a.id === id)).filter((a): a is Asset => Boolean(a && a.kind !== "audio"));
  const usedModels = useAssetModels();
  const families = useAssetFamilies();
  const recipes = useRecipes();
  const familyName = (id: string) => recipes.data?.families.find((f) => f.id === id)?.name ?? id;
  // every place a selection can go, grouped by project: the project itself (its root folder), then its folders
  // indented under it; last the Inbox's folders. A folder's name alone does not say which project it is in.
  const folderOptions = useMemo(() => {
    const all = folders.data?.items ?? [];
    const out: Array<{ value: string; label: string; note?: string; group: string }> = [];
    const walk = (parent: string | null, project: string | null, path: string, group: string, skip: string | null) => {
      for (const f of all.filter((x) => x.parentId === parent && x.projectId === project && x.id !== skip)) {
        out.push({ value: f.id, label: path ? `${path} › ${f.name}` : f.name, group });
        walk(f.id, project, path ? `${path} › ${f.name}` : f.name, group, skip);
      }
    };
    for (const p of (projects.data?.items ?? []).filter((x) => !x.archivedAt)) {
      if (p.folderId) out.push({ value: p.folderId, label: "Root", note: "the project itself, in no folder", group: p.name });
      walk(null, p.id, "", p.name, p.folderId);
    }
    walk(null, null, "", "Inbox", null);
    out.push({ value: "__none__", label: "Inbox", note: "out of every folder and project", group: "Inbox" });
    return out;
  }, [folders.data, projects.data]);
  return (

    <header ref={bar} className="flex h-[60px] shrink-0 flex-nowrap items-center gap-2 overflow-hidden px-5">
      <h1 className="sr-only">Studio</h1>
      <button
        ref={folderButton}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={Boolean(foldersOpen)}
        title="Folders, the Inbox and the bin"
        onClick={() => setFoldersOpen(foldersOpen ? false : "click")}
        className={cx("flex h-9 max-w-56 shrink-0 items-center gap-2 rounded-lg border bg-raised px-3 text-sm font-semibold", foldersOpen ? "border-accent" : "border-line-strong")}
      >
        {place.type === "bin" ? <Trash2 size={15} className="shrink-0" /> : <FolderIcon size={15} className="shrink-0" />}
        <span className="truncate">{placeName}</span>
        <ChevronDown size={14} className="shrink-0 text-ink-2" />
      </button>
      {/* what the library shows: media, or the timelines (the rail's Timelines entry lands on the second) */}
      {place.type !== "bin" && (
        <Segmented
          oneLine
          label="Show"
          value={showTimelines ? "timelines" : "media"}
          options={[{ value: "media", label: "Media" }, { value: "timelines", label: "Timelines" }]}
          onChange={(v) => setKind(v === "timelines" ? "timeline" : "all")}
        />
      )}
      {!showTimelines && view.form && draftId && (fold >= 3 ? (
        <div className="w-36 shrink-0">
          <Select size="sm" className="h-9" label="Results shown" value={scopeNow} onChange={(sc) => view.set({ scope: sc as Scope })} options={SCOPES} />
        </div>
      ) : (
        <Segmented oneLine label="Results shown" value={scopeNow} options={SCOPES} onChange={(sc) => view.set({ scope: sc })} />
      ))}
      {/* the display sits right after the scopes, so it stays put whatever the rest of the header holds */}
      {showTimelines ? (
        <>
          <Segmented oneLine label="Card size" value={view.timelineSize ?? "M"} options={[{ value: "S", label: "S" }, { value: "M", label: "M" }, { value: "L", label: "L" }]} onChange={(timelineSize) => view.set({ timelineSize })} />
          <div className="w-36 shrink-0">
            <Select size="sm" className="h-9" label="Sort timelines" value={view.timelineSort ?? "recent"} onChange={(v) => view.set({ timelineSort: v as "recent" | "name" | "length" })} options={[{ value: "recent", label: "Recent first" }, { value: "name", label: "By name" }, { value: "length", label: "Longest first" }]} />
          </div>
        </>
      ) : (
        <Segmented
          oneLine
          label="Display"
          value={displayOf(view, scopeNow)}
          options={[{ value: "Stage", label: "Stage" }, { value: "S", label: "S" }, { value: "M", label: "M" }, { value: "L", label: "L" }]}
          onChange={(d) => view.set({ displays: { ...view.displays, [scopeNow]: d }, ...(d === "Stage" ? {} : { size: d }) })}
        />
      )}
      {!showTimelines && !draftOnly && picked.length === 0 && (fold >= 1 ? (
        <div className="w-32 shrink-0">
          <Select size="sm" className={cx("h-9", kind !== "all" && "border-accent")} label="Kind" value={kind} onChange={(k) => setKind(k as typeof kind)} options={MEDIA_KINDS.map((k) => ({ value: k.id, label: k.label }))} />
        </div>
      ) : MEDIA_KINDS.map((k) => (
        <button
          key={k.id}
          type="button"
          aria-pressed={kind === k.id}
          onClick={() => setKind(k.id)}
          className={cx("h-[30px] shrink-0 rounded-full border px-3 text-xs font-semibold", kind === k.id ? "border-ink bg-ink text-ground" : "border-line text-ink-2 hover:text-ink")}
        >
          {k.label}
        </button>
      )))}
      <span className="min-w-2 grow" />
      <div id="timeline-selection-slot" className="contents" />
      {!draftOnly && picked.length > 0 && (
        <div className="flex shrink-0 items-center gap-2 rounded-lg border border-accent bg-panel py-1 pr-1 pl-3">
          <span className="font-semibold whitespace-nowrap">{picked.length} selected</span>
          {picked.length < items.length && <button type="button" onClick={() => setPicked(items.map((a) => a.id))} className="text-xs text-ink-2 underline hover:text-ink">select all {items.length}</button>}
          {place.type === "bin" ? (
            <Button size="sm" disabled={bulk.isPending} onClick={() => bulk.mutate("restore")}><Undo2 size={13} /> Restore</Button>
          ) : (
            <>
              {ordered.length > 0 && <Button size="sm" disabled={make.isPending} title="A new timeline of the ticked pictures and videos, in the order you ticked them: videos as clips, pictures as stills" onClick={() => make.mutate(ordered)}><Film size={13} /> {make.isPending ? "Making…" : "Make a timeline of these"}</Button>}
              <div className="w-44">
                <Select
                  size="sm" label="Move the selected items to a folder" placeholder="Move to folder" searchHint="Search folders" value=""
                  onChange={(to) => moveTo.mutate(to === "__none__" ? null : to)}
                  options={folderOptions}
                />
              </div>
              {chosen.some((a) => !a.kept) && <Button size="sm" disabled={bulk.isPending} onClick={() => bulk.mutate("keep")}><Star size={13} /> Keep</Button>}
              {chosen.length > 0 && chosen.every((a) => a.kept) && <Button size="sm" disabled={bulk.isPending} title="They go back on the one-day countdown" onClick={() => bulk.mutate("unkeep")}>Unkeep</Button>}
              <Button size="sm" disabled={bulk.isPending} title="To the bin, where they wait a week (Del)" onClick={() => void binChosen()}><Trash2 size={13} /> Bin</Button>
            </>
          )}
          <button type="button" aria-label="Clear selection" title="Clear selection (Esc)" onClick={() => setPicked([])} className="flex h-8 w-8 items-center justify-center rounded-md text-ink-2 hover:bg-hover hover:text-ink"><X size={14} /></button>
        </div>
      )}
      {!draftOnly && picked.length === 0 && (
        <>
          {fold >= 2 && !searching && !typed ? (
            <button type="button" data-search-opener aria-label="Search the library" title="Search prompts and names (/)" onClick={() => setSearching(true)} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line bg-raised text-ink-2 hover:text-ink">
              <Search size={15} />
            </button>
          ) : (
            <label className={cx("flex h-9 shrink items-center gap-2 rounded-lg border border-line bg-raised px-2.5 focus-within:border-accent", fold >= 2 ? "w-48 min-w-28" : "w-64 min-w-28")}>
              <Search size={14} className="shrink-0 text-ink-3" />
              <input data-search autoFocus={searching} onBlur={() => setSearching(false)} aria-label={showTimelines ? "Search timelines" : "Search the library"} placeholder={showTimelines ? "Search timelines by name" : "Search prompts and names"} value={typed} onChange={(e) => setTyped(e.target.value)} className="min-w-0 grow bg-transparent placeholder:text-ink-3 focus:outline-none" />
              {typed && <button type="button" aria-label="Clear the search" onClick={() => setTyped("")} className="text-ink-3 hover:text-ink"><X size={13} /></button>}
            </label>
          )}
          {!showTimelines && <button
            ref={filtersButton}
            type="button"
            aria-haspopup="dialog"
            aria-expanded={filtersOpen}
            title={active.length ? `Filters and grouping: ${active.join(", ")}` : "Filter by model, LoRA or Kept, and group the grid"}
            onClick={() => setFiltersOpen(!filtersOpen)}
            className={cx("flex h-9 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold", active.length || filtersOpen ? "border-accent text-ink" : "border-line text-ink-2 hover:text-ink")}
          >
            <SlidersHorizontal size={14} /> Filters
            {active.length > 0 && <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-1 text-[11px] font-bold text-accent-ink">{active.length}</span>}
          </button>}
        </>
      )}
      {filtersOpen && (
        <Popover anchor={filtersButton} onClose={() => setFiltersOpen(false)} label="Filters" width={300} height={340}>
          <div className="flex flex-col gap-3 p-3">
            {!showTimelines && (
              <div className="flex flex-col gap-1">
                <span className="text-[11px] font-bold tracking-[0.08em] text-ink-2 uppercase">Group by</span>
                <Segmented
                  label="Group by" value={view.groupBy ?? "none"}
                  onChange={(g) => view.set({ groupBy: g })}
                  options={[{ value: "none", label: "None" }, { value: "timeline", label: "Timeline" }, { value: "draft", label: "Draft" }, { value: "day", label: "Day" }]}
                />
                <span className="text-xs text-ink-3">{GROUP_HINT[view.groupBy ?? "none"]}</span>
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] font-bold tracking-[0.08em] text-ink-2 uppercase">Filter</span>
          {(families.data?.items.length ?? 0) > 0 && (
            <div>
              <Select
                size="sm" className={cx(made && "border-accent")} label="Filter by model" searchHint="Search models used in the library" value={made} onChange={setMade}
                options={[
                  { value: "", label: "Any model" },
                  ...families.data!.items.map((f) => ({ value: `f:${f}`, label: familyName(f), group: "Model family" })),
                  ...(usedModels.data?.models ?? []).map((m) => ({ value: `m:${m.file}`, label: fileLabel(m.file), note: String(m.count), search: m.file, group: "Checkpoint or model file" })),
                ]}
              />
            </div>
          )}
          {(usedModels.data?.loras.length ?? 0) > 0 && (
            <div>
              <Select
                size="sm" className={cx(lora && "border-accent")} label="Filter by LoRA" searchHint="Search LoRAs used in the library" value={lora} onChange={setLora}
                options={[{ value: "", label: "Any LoRA" }, ...usedModels.data!.loras.map((l) => ({ value: l.file, label: fileLabel(l.file), note: String(l.count), search: l.file }))]}
              />
            </div>
          )}
              <button type="button" aria-pressed={kept} onClick={() => setKept(!kept)} className={cx("flex h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold", kept ? "border-accent text-accent" : "border-line text-ink-2 hover:text-ink")}>
                <Star size={13} fill={kept ? "currentColor" : "none"} /> Kept only
              </button>
            </div>
            {active.length > 0 && (
              <button type="button" onClick={() => { setMade(""); setLora(""); setKept(false); view.set({ groupBy: "none" }); }} className="self-start text-xs text-ink-2 underline hover:text-ink">Clear all</button>
            )}
          </div>
        </Popover>
      )}
    </header>

  );
}
