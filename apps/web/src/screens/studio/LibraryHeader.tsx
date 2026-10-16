import { useMemo, useRef, useState, type RefObject } from "react";
import { Clock, Film, Search, SlidersHorizontal, Star, Trash2, Undo2, X } from "lucide-react";
import { Popover } from "../../Popover";
import { useFit } from "../../useFit";
import { useLocation } from "wouter";
import { useMakeTimelineOf } from "../../actions";
import type { Asset } from "../../api";
import { useAssetFamilies, useAssetModels, useFolders, useRecipes, useProjects } from "../../data";
import { fileLabel } from "../../format";
import { Select } from "../../Select";
import { Button, Checkbox, cx, Help, SectionTitle, Segmented } from "../../ui";
import type { Place } from "../Library";
import { displayOf, type Scope, type useStudio } from "../../store";
import { PlaceCrumbs } from "../library/FolderPanel";
import { KINDS, type LibraryFilters } from "./useLibraryFilters";
import type { Selection } from "./useSelection";
import { binFor, daysSaid, insteadOfWaiting, unkeepTip, unkeptMs, useKeepFor } from "../../keepFor";

// "Kept" is not a scope any more: Kept only, in Filters, does it. "All recent": the last two days of every folder, whatever folder is open
// short, so the three stay a segmented control at any width
const SCOPES: Array<{ value: Scope; label: string }> = [{ value: "draft", label: "Draft" }, { value: "all", label: "Folder" }, { value: "recent", label: "Recent" }];
// the kinds of media, the Timelines being a view of their own (Media · Timelines)
const MEDIA_KINDS = KINDS.filter((k) => k.id !== "timeline");
// what each grouping keeps: on its choice's tooltip
const GROUP_HINT = {
  none: "Everything, newest first.",
  timeline: "Only takes of a timeline's clips, the takes of a clip stacked.",
  draft: "Only what a draft made, a section per draft.",
  day: "Everything, a section per day.",
} as const;

/**
 * The library's top row: the place (a breadcrumb inside the project worked in), what the grid shows beside an open form, the
 * kinds, the search, and either the filters or, with items ticked, what is done with them together.
 */
export function LibraryHeader({ place, folderButton, foldersOpen, onFolders: setFoldersOpen, view, draftId, draftOnly, count, onSelectAll, filters, selection }: {
  place: Place;
  /** The breadcrumb: the project's tree opens under it. */
  folderButton: RefObject<HTMLDivElement | null>;
  /** The project's tree: opened from the breadcrumb, or by itself while something is dragged. */
  foldersOpen: false | "click" | "drag";
  onFolders(open: false | "click" | "drag"): void;
  view: ReturnType<typeof useStudio.getState>;
  draftId: string | null;
  /** The grid shows only the open draft's results: the search, the kinds and the ticks are out of the way. */
  draftOnly: boolean;
  /** How many items are on screen (a grouping leaves some out), and ticking them all: what "select all" does. A count, not the items, so the header's props stay the same while the grid reads its pages. */
  count: number;
  onSelectAll(): void;
  filters: LibraryFilters;
  selection: Selection;
}) {
  const { kind, setKind, typed, setTyped, made, lora, kept, reach, showTimelines } = filters;
  // the scope the display is remembered for: with the form closed, the grid is the folder's
  const scopeNow = reach as Scope;
  const { picked } = selection;
  // one line, always: what does not fit folds, step by step (useFit): 1 the kinds into a menu, 2 the search into an icon,
  // 3 the breadcrumb narrower (its middle folds to "…"), 4 the display into a menu, 5 Media/Timelines into a menu, 6 the
  // results shown into a menu. With items ticked the selection bar comes in, the kinds and the search staying: 7 its
  // buttons to icons, 8 the display and the results shown out of the header, 9 Media/Timelines out too (each is
  // back once nothing is ticked). With the form open the header is 760–920 px wide and the breadcrumb alone took a third.
  const bar = useRef<HTMLElement>(null);
  const ticking = !draftOnly && picked.length > 0;
  // the selection coming or going changes what the row holds: it folds again from nothing
  const fold = useFit(bar, 9, ticking ? "ticking" : "");
  const roomy = !ticking || fold < 8;
  const [searching, setSearching] = useState(false);
  // model, LoRA, Kept only and the grouping: set now and then, so in a panel; the button says how many are on
  const filtersButton = useRef<HTMLButtonElement>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const inBin = place.type === "bin";
  const active = [made && "model", lora && "LoRA", !inBin && kept && "Kept only", !inBin && filters.unkept && "Expiring only", !showTimelines && (view.groupBy ?? "none") !== "none" && `grouped by ${view.groupBy}`].filter((x): x is string => Boolean(x));
  return (
    <header ref={bar} className="relative flex h-[60px] shrink-0 flex-nowrap items-center gap-2 overflow-hidden px-5">
      <h1 className="sr-only">Studio</h1>
      <PlaceCrumbs place={place} onPlace={(p) => view.set({ place: p })} anchor={folderButton} open={Boolean(foldersOpen)} onOpen={(o) => setFoldersOpen(o ? "click" : false)} className={fold >= 3 ? "w-[clamp(110px,9vw,140px)]!" : undefined} />
      {/* what the library shows: media, or the timelines (the rail's Timelines entry lands on the second) */}
      {place.type !== "bin" && fold >= 5 && (!ticking || fold < 9) && (
        <div className="w-28 shrink-0">
          <Select size="sm" className="h-9" label="Show" value={showTimelines ? "timelines" : "media"} onChange={(v) => setKind(v === "timelines" ? "timeline" : "all")} options={[{ value: "media", label: "Media" }, { value: "timelines", label: "Timelines" }]} />
        </div>
      )}
      {place.type !== "bin" && fold < 5 && (
        <Segmented
          oneLine
          label="Show"
          value={showTimelines ? "timelines" : "media"}
          options={[{ value: "media", label: "Media" }, { value: "timelines", label: "Timelines" }]}
          onChange={(v) => setKind(v === "timelines" ? "timeline" : "all")}
        />
      )}
      {!showTimelines && view.form && draftId && roomy && (fold >= 6 ? (
        <div className="w-24 shrink-0">
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
      ) : !roomy ? null : fold >= 4 ? (
        <div className="w-24 shrink-0">
          <Select size="sm" className="h-9" label="Display" value={displayOf(view, scopeNow)} onChange={(d) => view.set({ displays: { ...view.displays, [scopeNow]: d as "Stage" | "S" | "M" | "L" }, ...(d === "Stage" ? {} : { size: d as "S" | "M" | "L" }) })} options={[{ value: "Stage", label: "Stage" }, { value: "S", label: "S" }, { value: "M", label: "M" }, { value: "L", label: "L" }]} />
        </div>
      ) : (
        <Segmented
          oneLine
          label="Display"
          value={displayOf(view, scopeNow)}
          options={[{ value: "Stage", label: "Stage" }, { value: "S", label: "S" }, { value: "M", label: "M" }, { value: "L", label: "L" }]}
          onChange={(d) => view.set({ displays: { ...view.displays, [scopeNow]: d }, ...(d === "Stage" ? {} : { size: d }) })}
        />
      )}
      {!showTimelines && !draftOnly && (fold >= 1 ? (
        <div className="w-28 shrink-0">
          <Select size="sm" className={cx("h-9", kind !== "all" && "border-accent")} label="Kind" value={kind} onChange={(k) => setKind(k as typeof kind)} options={MEDIA_KINDS.map((k) => ({ value: k.id, label: k.label }))} />
        </div>
      ) : (
        <Segmented oneLine label="Kind" value={kind} onChange={(k) => setKind(k)} options={MEDIA_KINDS.map((k) => ({ value: k.id, label: k.label }))} />
      ))}
      <span className="min-w-2 grow" />
      <div id="timeline-selection-slot" className="contents" />
      {/* the draft's stage has no search of its own: the button opens the library's, on the folder's grid, where results show */}
      {draftOnly && !showTimelines && (
        <button
          type="button" data-search-opener aria-label="Search the library" data-tip="Search the library (/): shows the folder's grid"
          onClick={() => {
            const grid = displayOf(view, "all") === "Stage" ? { displays: { ...view.displays, all: view.size } } : {};
            view.set({ scope: "all", ...grid });
            setSearching(true);
          }}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line bg-raised text-ink-2 hover:text-ink"
        >
          <Search size={15} />
        </button>
      )}
      {!draftOnly && (
        <>
          {fold >= 2 && !searching && !typed ? (
            <button type="button" data-search-opener aria-label="Search the library" data-tip="Search prompts and names (/)" onClick={() => setSearching(true)} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line bg-raised text-ink-2 hover:text-ink">
              <Search size={15} />
            </button>
          ) : (
            // folded to an icon and opened: the box lies over the header's controls, just left of Filters, rather than push
            // the row past its width (the header slid sideways and cut the breadcrumb); left with words in it, it is narrower
            <label
              style={fold >= 2 ? { right: (filtersButton.current?.offsetWidth ?? 80) + 28 } : undefined}
              className={cx("flex h-9 items-center gap-2 rounded-lg border border-line bg-raised px-2.5 focus-within:border-accent", fold >= 2 ? cx("absolute top-1/2 z-10 -translate-y-1/2 shadow-lg shadow-shade/40", searching ? "w-[min(320px,55%)]" : "w-40") : "w-64 min-w-28 shrink")}
            >
              <Search size={14} className="shrink-0 text-ink-3" />
              <input data-search autoFocus={searching} onBlur={() => setSearching(false)} aria-label={showTimelines ? "Search timelines" : "Search the library"} placeholder={showTimelines ? "Search timelines by name" : "Search prompts and names"} value={typed} onChange={(e) => setTyped(e.target.value)} className="min-w-0 grow bg-transparent placeholder:text-ink-3 focus:outline-none" />
              {typed && <button type="button" aria-label="Clear the search" onClick={() => setTyped("")} className="text-ink-3 hover:text-ink"><X size={13} /></button>}
            </label>
          )}
          {/* ticked items: what is done with them takes the filters' place, after the kinds and the search */}
          {ticking && <SelectionBar place={place} count={count} onSelectAll={onSelectAll} selection={selection} compact={fold >= 7} />}
          {!showTimelines && !ticking && <button
            ref={filtersButton}
            type="button"
            aria-haspopup="dialog"
            aria-expanded={filtersOpen}
            data-tip={active.length ? `Filters and grouping: ${active.join(", ")}` : "Filter by model, LoRA, Kept or Expiring, and group the grid"}
            onClick={() => setFiltersOpen(!filtersOpen)}
            className={cx("flex h-9 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold", active.length || filtersOpen ? "border-accent text-ink" : "border-line text-ink-2 hover:text-ink")}
          >
            <SlidersHorizontal size={14} /> Filters
            {active.length > 0 && <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-1 text-[11px] font-bold text-accent-ink">{active.length}</span>}
          </button>}
        </>
      )}
      {filtersOpen && <FiltersPanel anchor={filtersButton} onClose={() => setFiltersOpen(false)} view={view} filters={filters} active={active.length > 0} inBin={place.type === "bin"} />}
    </header>
  );
}

/**
 * With items ticked: how many, and what is done with them together (a timeline of them, a folder, keep, the bin).
 * `compact`: the header is short of room, the buttons are their icons (named by their tips).
 */
function SelectionBar({ place, count, onSelectAll, selection, compact }: { place: Place; count: number; onSelectAll(): void; selection: Selection; compact?: boolean }) {
  const { picked, setPicked, bulk, moveTo, chosen, binChosen, eraseChosen } = selection;
  const folders = useFolders();
  const projects = useProjects();
  // the ticked pictures and videos, in the order they were ticked: what a new timeline is made of
  const [, go] = useLocation();
  const make = useMakeTimelineOf({ onSuccess: (t) => go(`/timelines/${t.id}`) });
  const ordered = useMemo(() => {
    const byId = new Map(chosen.map((a) => [a.id, a]));
    return picked.map((id) => byId.get(id)).filter((a): a is Asset => Boolean(a && a.kind !== "audio"));
  }, [picked, chosen]);
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
    <div className="flex shrink-0 items-center gap-2 rounded-lg border border-accent bg-panel py-1 pr-1 pl-3">
      <span className="font-semibold whitespace-nowrap">{picked.length} selected</span>
      {picked.length < count && <button type="button" data-tip={compact ? `Select all ${count}` : undefined} onClick={onSelectAll} className="text-xs whitespace-nowrap text-ink-2 underline hover:text-ink">{compact ? "all" : `select all ${count}`}</button>}
      {place.type === "bin" ? (
        <>
          <Button size="sm" onClick={() => bulk("restore")}><Undo2 size={13} /> Put back</Button>
          <Button size="sm" data-tip={`Erased now, files and all, instead of ${insteadOfWaiting()}. Asked first (Del)`} onClick={() => void eraseChosen()}><Trash2 size={13} /> Delete now…</Button>
        </>
      ) : (
        <>
          {ordered.length > 0 && <Button size="sm" aria-label={compact ? "Make a timeline of these" : undefined} disabled={make.isPending} data-tip="A new timeline of the ticked pictures and videos, in the order you ticked them: videos as clips, pictures as stills" onClick={() => make.mutate(ordered)}><Film size={13} />{!compact && (make.isPending ? " Making…" : " Make a timeline of these")}</Button>}
          <div className={compact ? "w-32" : "w-44"}>
            <Select
              size="sm" label="Move the selected items to a folder" placeholder="Move to folder" searchHint="Search folders" value=""
              onChange={(to) => moveTo(to === "__none__" ? null : to)}
              options={folderOptions}
            />
          </div>
          {chosen.some((a) => !a.kept) && <Button size="sm" aria-label={compact ? "Keep" : undefined} data-tip={compact ? "Keep them" : undefined} onClick={() => bulk("keep")}><Star size={13} />{!compact && " Keep"}</Button>}
          {chosen.length > 0 && chosen.every((a) => a.kept) && <Button size="sm" data-tip={unkeepTip()} onClick={() => bulk("unkeep")}>Unkeep</Button>}
          <Button size="sm" aria-label={compact ? "Bin" : undefined} data-tip={`To the bin, where they wait ${binFor() ?? "until it is emptied"} (Del)`} onClick={() => void binChosen()}><Trash2 size={13} />{!compact && " Bin"}</Button>
        </>
      )}
      <button type="button" aria-label="Clear selection" data-tip="Clear selection (Esc)" onClick={() => setPicked([])} className="flex h-8 w-8 items-center justify-center rounded-md text-ink-2 hover:bg-hover hover:text-ink"><X size={14} /></button>
    </div>
  );
}

/** Model, LoRA, Kept only, Expiring only and the grouping: set now and then, so in a panel under the Filters button. */
function FiltersPanel({ anchor, onClose, view, filters, active, inBin }: { anchor: RefObject<HTMLButtonElement | null>; onClose(): void; view: ReturnType<typeof useStudio.getState>; filters: LibraryFilters; /** Something is set: "Clear all" is offered. */ active: boolean; /** The bin is open: Kept and Expiring mean nothing there (nothing in it counts down to the bin). */ inBin?: boolean }) {
  const { made, setMade, lora, setLora, kept, setKept, unkept, setUnkept, showTimelines } = filters;
  const usedModels = useAssetModels();
  const families = useAssetFamilies();
  const recipes = useRecipes();
  const familyName = (id: string) => recipes.data?.families.find((f) => f.id === id)?.name ?? id;
  return (
    <Popover anchor={anchor} onClose={onClose} label="Filters" width={300} height={380}>
      <div className="flex flex-col gap-3 p-3">
        {!showTimelines && (
          <div className="flex flex-col gap-1">
            <SectionTitle>Group by</SectionTitle>
            <Segmented
              label="Group by" value={view.groupBy ?? "none"}
              onChange={(g) => view.set({ groupBy: g })}
              options={[{ value: "none", label: "None", tip: GROUP_HINT.none }, { value: "timeline", label: "Timeline", tip: GROUP_HINT.timeline }, { value: "draft", label: "Draft", tip: GROUP_HINT.draft }, { value: "day", label: "Day", tip: GROUP_HINT.day }]}
            />
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <SectionTitle>Filter</SectionTitle>
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
          {!inBin && (<>
          <Checkbox checked={kept} onChange={setKept} className="h-8 text-xs font-semibold">
            <Star size={13} fill={kept ? "currentColor" : "none"} className={kept ? "text-accent" : "text-ink-2"} /> Kept only
          </Checkbox>
          {/* the same filter as "Show them" on the status bar's expiring chip */}
          <span className="flex items-center gap-1.5">
            <Checkbox checked={unkept} onChange={setUnkept} className="h-8 text-xs font-semibold">
              <Clock size={13} className={unkept ? "text-accent" : "text-ink-2"} /> Expiring only
            </Checkbox>
            <Help text={unkeptMs() === null ? "Renders nobody kept stay until you bin them (Settings › Storage). S keeps one." : `Renders nobody kept go to the bin by themselves ${daysSaid(useKeepFor.getState().unkeptDays)} after they were made (Settings › Storage). S keeps one.`} />
          </span>
          </>)}
        </div>
        {active && (
          <button type="button" onClick={() => { setMade(""); setLora(""); setKept(false); setUnkept(false); view.set({ groupBy: "none" }); }} className="self-start text-xs text-ink-2 underline hover:text-ink">Clear all</button>
        )}
      </div>
    </Popover>
  );
}
