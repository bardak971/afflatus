import { useMemo, type RefObject } from "react";
import { ChevronDown, Film, Folder as FolderIcon, Search, Star, Trash2, Undo2, X } from "lucide-react";
import { useLocation } from "wouter";
import { useMakeTimelineOf } from "../../actions";
import type { Asset } from "../../api";
import { useAssetFamilies, useAssetModels, useFolders, useRecipes, useProjects } from "../../data";
import { fileLabel } from "../../format";
import { Select } from "../../Select";
import { Button, cx, Segmented } from "../../ui";
import type { Place } from "../Library";
import type { useStudio } from "../Studio";
import { KINDS, type LibraryFilters } from "./useLibraryFilters";
import type { Selection } from "./useSelection";

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
  const { kind, setKind, typed, setTyped, made, setMade, lora, setLora, kept, setKept } = filters;
  const { picked, setPicked, bulk, moveTo, chosen, binChosen } = selection;
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
    out.push({ value: "__none__", label: "No folder", note: "out of every project", group: "Inbox" });
    return out;
  }, [folders.data, projects.data]);
  return (

    <header className="flex h-[60px] shrink-0 items-center gap-2 px-5">
      <h1 className="sr-only">Studio</h1>
      <button
        ref={folderButton}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={Boolean(foldersOpen)}
        title="Folders, the bin, and items in no folder"
        onClick={() => setFoldersOpen(foldersOpen ? false : "click")}
        className={cx("flex h-9 max-w-64 shrink-0 items-center gap-2 rounded-lg border bg-raised px-3 text-sm font-semibold", foldersOpen ? "border-accent" : "border-line-strong")}
      >
        {place.type === "bin" ? <Trash2 size={15} className="shrink-0" /> : <FolderIcon size={15} className="shrink-0" />}
        <span className="truncate">{placeName}</span>
        <ChevronDown size={14} className="shrink-0 text-ink-2" />
      </button>
      {view.form && draftId && (
        <Segmented
          label="Results shown"
          value={view.scope}
          options={[{ value: "draft", label: "This draft" }, { value: "all", label: "Whole folder" }, { value: "recent", label: "Recent" }, { value: "kept", label: "Kept" }]}
          onChange={(scope) => view.set({ scope })}
        />
      )}
      {!draftOnly && KINDS.map((k) => (
        <button
          key={k.id}
          type="button"
          aria-pressed={kind === k.id}
          onClick={() => setKind(k.id)}
          className={cx("h-[30px] shrink-0 rounded-full border px-3 text-xs font-semibold", kind === k.id ? "border-ink bg-ink text-ground" : "border-line text-ink-2 hover:text-ink", view.form && "max-[1700px]:hidden")}
        >
          {k.label}
        </button>
      ))}
      <span className="grow" />
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
          <label className="flex h-9 w-64 min-w-28 shrink items-center gap-2 rounded-lg border border-line bg-raised px-2.5 focus-within:border-accent">
            <Search size={14} className="shrink-0 text-ink-3" />
            <input data-search aria-label="Search the library" placeholder="Search prompts and names" value={typed} onChange={(e) => setTyped(e.target.value)} className="min-w-0 grow bg-transparent placeholder:text-ink-3 focus:outline-none" />
            {typed && <button type="button" aria-label="Clear the search" onClick={() => setTyped("")} className="text-ink-3 hover:text-ink"><X size={13} /></button>}
          </label>
          {!view.form && (families.data?.items.length ?? 0) > 0 && (
            <div className="w-40 shrink-0">
              <Select
                size="sm" className={cx("h-9", made && "border-accent")} label="Filter by model" searchHint="Search models used in the library" value={made} onChange={setMade}
                options={[
                  { value: "", label: "Any model" },
                  ...families.data!.items.map((f) => ({ value: `f:${f}`, label: familyName(f), group: "Model family" })),
                  ...(usedModels.data?.models ?? []).map((m) => ({ value: `m:${m.file}`, label: fileLabel(m.file), note: String(m.count), search: m.file, group: "Checkpoint or model file" })),
                ]}
              />
            </div>
          )}
          {!view.form && (usedModels.data?.loras.length ?? 0) > 0 && (
            <div className="w-36 shrink-0">
              <Select
                size="sm" className={cx("h-9", lora && "border-accent")} label="Filter by LoRA" searchHint="Search LoRAs used in the library" value={lora} onChange={setLora}
                options={[{ value: "", label: "Any LoRA" }, ...usedModels.data!.loras.map((l) => ({ value: l.file, label: fileLabel(l.file), note: String(l.count), search: l.file }))]}
              />
            </div>
          )}
          <button type="button" aria-pressed={kept} onClick={() => setKept(!kept)} className={cx("flex h-9 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold", kept ? "border-accent text-accent" : "border-line text-ink-2 hover:text-ink")}>
            <Star size={13} fill={kept ? "currentColor" : "none"} /> Kept only
          </button>
          <Segmented label="Thumbnail size" value={view.size} options={[{ value: "S", label: "S" }, { value: "M", label: "M" }, { value: "L", label: "L" }]} onChange={(size) => view.set({ size })} />
        </>
      )}
    </header>

  );
}
