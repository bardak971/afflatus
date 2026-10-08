import { useEffect, useMemo, useRef, useState } from "react";
import { PanelLeftClose, PanelLeftOpen, Plus, Search, SlidersHorizontal, Star } from "lucide-react";
import { groupItems } from "../screens/studio/grouping";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Asset, Timeline } from "../api";
import { useAssets, useFolders, useProjects } from "../data";
import { useSettled } from "../hooks";
import { LoadMore } from "../LoadMore";
import { Popover } from "../Popover";
import { useProject } from "../project";
import { FolderPanel, Tile } from "../screens/Library";
import { useStudio } from "../store";
import { useTileMenu } from "../TileMenu";
import type { MenuItem } from "../ContextMenu";
import { cx, Segmented } from "../ui";
import { Select } from "../Select";
import { useFit } from "../useFit";

/** Whether the library is open over the editor's stage: kept from one visit to the next. */
const useMediaOpen = create<{ open: boolean; set(open: boolean): void; size: "S" | "M" | "L"; group: "timeline" | "none"; setView(v: Partial<{ size: "S" | "M" | "L"; group: "timeline" | "none" }>): void }>()(
  persist((set) => ({ open: false, set: (open) => set({ open }), size: "M", group: "timeline", setView: (v) => set(v) }), { name: "afflatus.media-open" }),
);
const TILES = { S: "minmax(110px, 1fr)", M: "minmax(150px, 1fr)", L: "minmax(220px, 1fr)" } as const;

type Scope = "timeline" | "folder" | "recent";
type Kind = "all" | "image" | "video" | "audio";
const DAY = 86_400_000;

/**
 * The library over the editor's stage: the Studio's own grid, with its folder button, its scopes ("This
 * timeline" in place of "This draft"), its kinds and its search, on the same place the Studio is looking
 * at. Folded, it is the Media tab at the left edge; open, it covers the stage and nothing else: the track
 * keeps its width and the clip's form stays at hand. A tile is dragged onto the track or into the form,
 * or clicked to go at the end. What the timeline already uses is dimmed.
 */
export function MediaOverlay({ timeline, selected, onAdd, onOpen, placeItems }: {
  timeline: Timeline;
  /** Whether a clip is selected (a sound needs one to go on). */
  selected: boolean;
  /** Pictures and videos go at the end of the timeline; a sound goes on the selected clip. */
  onAdd(asset: Asset): void;
  /** The viewer, on this item: large, with everything that can be done with it. */
  onOpen(asset: Asset): void;
  /** Where the item can go in what is being edited: into the selected clip's places, onto the timeline. First in its menu. */
  placeItems(asset: Asset): MenuItem[];
}) {
  const open = useMediaOpen((s) => s.open);
  const setOpen = useMediaOpen((s) => s.set);
  const place = useStudio((s) => s.place);
  const setStudio = useStudio((s) => s.set);
  const [scope, setScope] = useState<Scope>("folder");
  const size = useMediaOpen((s) => s.size ?? "M");
  const group = useMediaOpen((s) => s.group ?? "timeline");
  const setView = useMediaOpen((s) => s.setView);
  const [kept, setKept] = useState(false);
  const filtersButton = useRef<HTMLButtonElement>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [kind, setKind] = useState<Kind>("all");
  const [typed, setTyped] = useState("");
  const q = useSettled(typed.trim());
  const folderButton = useRef<HTMLButtonElement>(null);
  // its bar stays on one line, as the Studio's: 1 the kinds fold into a menu, 2 the scopes too
  const bar = useRef<HTMLDivElement>(null);
  const fold = useFit(bar, 2);
  const [folders, setFolders] = useState(false);

  // the place, named as the Studio names it
  const projectId = useProject((s) => s.id);
  const folderList = useFolders();
  const projects = useProjects();
  const rootId = projectId && projectId !== "none" ? projects.data?.items.find((p) => p.id === projectId)?.folderId ?? null : null;
  const folder = place.type === "folder" ? folderList.data?.items.find((f) => f.id === place.id) : rootId ? folderList.data?.items.find((f) => f.id === rootId) : undefined;
  const placeName = place.type === "bin" ? "Bin" : place.type === "unfiled" ? "Inbox" : place.type === "folder" ? folder?.name ?? "Folder" : "All";

  // Escape folds it away, unless something is open over it
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector("[role=dialog][aria-modal=true], [role=menu], [role=listbox]")) return;
      if ((e.target as HTMLElement | null)?.closest?.("input, textarea")) return;
      setOpen(false);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open, setOpen]);

  // what the timeline already uses (every take, the stills, the pinned pictures, the sounds, the music), and where
  const used = useMemo(() => {
    const out = new Map<string, Asset>();
    const playing = new Set<string>();
    const where = new Map<string, string>();
    const at = (id: string, words: string) => { if (!where.has(id)) where.set(id, words); };
    timeline.clips.forEach((c, i) => {
      const n = i + 1;
      if (c.take) { playing.add(c.take.asset.id); at(c.take.asset.id, `Playing on clip ${n}`); }
      for (const t of c.takes) { out.set(t.asset.id, t.asset); at(t.asset.id, `A take of clip ${n}`); }
      if (c.still) { out.set(c.still.id, c.still); at(c.still.id, `Clip ${n}`); }
      for (const p of c.pictures) { out.set(p.asset.id, p.asset); at(p.asset.id, `Pinned on clip ${n}`); }
      if (c.soundAsset) { out.set(c.soundAsset.id, c.soundAsset); at(c.soundAsset.id, `Sound of clip ${n}`); }
    });
    if (timeline.music) { out.set(timeline.music.asset.id, timeline.music.asset); at(timeline.music.asset.id, "Music"); }
    return { items: [...out.values()], playing, where };
  }, [timeline]);

  const since = useMemo(() => new Date(Date.now() - 2 * DAY).toISOString(), [scope]); // eslint-disable-line react-hooks/exhaustive-deps
  const fetched = scope !== "timeline";
  const assets = useAssets(
    {
      kind: kind === "all" ? undefined : kind,
      bin: place.type === "bin" || undefined,
      folder: scope === "folder" ? (place.type === "folder" ? place.id : place.type === "unfiled" ? "none" : undefined) : undefined,
      since: scope === "recent" ? since : undefined,
      kept: kept || undefined,
      q: q || undefined,
    },
    open && fetched,
  );
  const items = fetched
    ? (assets.data?.pages.flatMap((p) => p.items) ?? [])
    : used.items.filter((a) => (kind === "all" || a.kind === kind) && (!kept || a.kept) && (!q || (a.name ?? "").toLowerCase().includes(q.toLowerCase())));
  // by timeline: this timeline's first, then the others', then what is on none (nothing is left out here: it is a shelf to pick from)
  const sections = useMemo(() => {
    if (group === "none" || scope === "timeline") return null;
    const every = new Set(items.filter((a) => a.clipOf).map((a) => `${a.clipOf!.timeline}:${a.clipOf!.clip}`));
    const secs = groupItems(items, "timeline", every);
    const placed = new Set(secs.flatMap((x) => x.entries.map((e) => e.asset.id)));
    const rest = items.filter((a) => !placed.has(a.id));
    const mine = secs.filter((x) => x.key === timeline.id).map((x) => ({ ...x, label: "This timeline", timeline: undefined }));
    const others = secs.filter((x) => x.key !== timeline.id);
    return [...mine, ...others, ...(rest.length ? [{ key: "rest", label: "On no timeline", note: `${rest.length} item${rest.length === 1 ? "" : "s"}`, entries: rest.map((asset) => ({ asset })) }] : [])];
  }, [items, group, scope, timeline.id]);
  const active = [kept && "Kept only", group === "none" && scope !== "timeline" && "no groups"].filter(Boolean).length;
  // the right-click: what the Studio's tiles offer, with the timeline's own line first
  const menu = useTileMenu({
    onOpen,
    first: placeItems,
    compact: true,
  });
  const what = (a: Asset) => (a.kind === "audio" ? "Click to open. Drag it onto a clip's audio, a voice sample or the music track; right-click for the same places." : "Click to open. Drag it onto the track or into a clip's places; right-click for the same places.");

  const tab = (
    <aside className={cx("flex w-10 shrink-0 flex-col items-center border-r border-line py-2", open ? "bg-raised" : "bg-panel")}>
      <button
        type="button"
        aria-pressed={open}
        aria-label={open ? "Fold the media away" : "Show the media"}
        data-tip={open ? "Fold the media away: the stage comes back" : "Media: your library over the stage. Drag onto the track or into the clip's form; a click adds at the end."}
        onClick={() => setOpen(!open)}
        className={cx("flex h-8 w-8 items-center justify-center rounded-lg hover:bg-hover hover:text-ink", open ? "text-accent" : "text-ink-2")}
      >
        {open ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
      </button>
      <span className={cx("mt-3 text-[10px] font-semibold tracking-wide uppercase [writing-mode:vertical-rl]", open ? "text-accent" : "text-ink-3")}>Media</span>
    </aside>
  );
  const scopes: Array<{ value: Scope; label: string }> = [{ value: "timeline", label: "This timeline" }, { value: "folder", label: place.type === "all" ? "Everything" : "Whole folder" }, { value: "recent", label: "All recent" }];
  const kinds: Array<{ value: Kind; label: string }> = [{ value: "all", label: "All" }, { value: "image", label: "Images" }, { value: "video", label: "Videos" }, { value: "audio", label: "Audio" }];
  const tileOf = (a: Asset) => {
    const where = used.where.get(a.id);
    return (
      <div key={a.id} data-tip={where ? `${where} of this timeline. ${what(a)}` : what(a)} className={cx("relative rounded-[10px]", used.playing.has(a.id) && "ring-2 ring-accent")}>
        <Tile asset={a} onOpen={() => onOpen(a)} onMenu={(e) => menu.open(e, a)} />
        {where && scope !== "timeline" && <span className="pointer-events-none absolute top-2 left-2 z-10 rounded-md bg-accent px-1.5 py-0.5 text-[11px] font-bold text-accent-ink shadow">{where}</span>}
      </div>
    );
  };
  if (!open) return tab;
  return (
    <>
      {tab}
      <section aria-label="Your library" className="absolute inset-y-0 right-0 left-10 z-20 flex flex-col bg-ground">
        <div ref={bar} className="flex h-12 shrink-0 flex-nowrap items-center gap-2 overflow-hidden border-b border-line px-4">
          <button ref={folderButton} type="button" aria-expanded={folders} data-tip="Folders, the Inbox and the bin" onClick={() => setFolders((o) => !o)} className="flex h-8 items-center gap-1.5 rounded-lg border border-line bg-panel px-2.5 text-sm font-semibold">
            {placeName} <span className="text-ink-3">▾</span>
          </button>
          {fold >= 2
            ? <div className="w-36 shrink-0"><Select size="sm" label="What is shown" value={scope} onChange={(v) => setScope(v as Scope)} options={scopes} /></div>
            : <Segmented<Scope> oneLine label="What is shown" value={scope} onChange={setScope} options={scopes} />}
          <Segmented oneLine label="Tile size" value={size} options={[{ value: "S", label: "S" }, { value: "M", label: "M" }, { value: "L", label: "L" }]} onChange={(v) => setView({ size: v })} />
          {fold >= 1
            ? <div className="w-28 shrink-0"><Select size="sm" label="Media type" value={kind} onChange={(v) => setKind(v as Kind)} options={kinds} /></div>
            : <Segmented<Kind> oneLine label="Media type" value={kind} onChange={setKind} options={kinds} />}
          <span className="min-w-2 grow" />
          <label className="flex h-8 w-56 min-w-28 shrink items-center gap-2 rounded-lg border border-line bg-raised px-2.5">
            <Search size={13} className="shrink-0 text-ink-3" />
            <input data-search="media" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Search prompts and names" className="min-w-0 grow bg-transparent text-xs text-ink outline-none placeholder:text-ink-3" />
          </label>
          <button
            ref={filtersButton}
            type="button"
            aria-haspopup="dialog"
            aria-expanded={filtersOpen}
            data-tip="Kept only, and how the shelf is grouped"
            onClick={() => setFiltersOpen(!filtersOpen)}
            className={cx("flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-semibold", active || filtersOpen ? "border-accent text-ink" : "border-line text-ink-2 hover:text-ink")}
          >
            <SlidersHorizontal size={13} /> Filters
            {active > 0 && <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-1 text-[11px] font-bold text-accent-ink">{active}</span>}
          </button>
        </div>
        <div className="min-h-0 grow overflow-y-auto px-4 py-3">
          {(fetched ? assets.isSuccess : true) && !items.length && (
            <div className="py-10 text-center text-sm text-ink-3">{scope === "timeline" ? "This timeline uses nothing of that kind yet." : "Nothing here. Change the folder, the scope or the kind."}</div>
          )}
          {sections
            ? sections.map((sec) => (
                <section key={sec.key} aria-label={sec.label} className="mb-4 flex flex-col gap-2">
                  <div className="flex items-baseline gap-2 border-b border-line pb-1">
                    <span className={cx("truncate text-sm font-semibold", sec.key === timeline.id && "text-accent")}>{sec.label}</span>
                    <span className="shrink-0 text-xs text-ink-2">{sec.note}</span>
                  </div>
                  <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(auto-fill, ${TILES[size]})` }}>{sec.entries.map((e) => tileOf(e.asset))}</div>
                </section>
              ))
            : <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(auto-fill, ${TILES[size]})` }}>{items.map((a) => tileOf(a))}</div>}
          {fetched && <LoadMore more={Boolean(assets.hasNextPage)} busy={assets.isFetchingNextPage} onMore={() => void assets.fetchNextPage()} />}
        </div>
      </section>
      {filtersOpen && (
        <Popover anchor={filtersButton} onClose={() => setFiltersOpen(false)} label="Filters" width={280} height={220}>
          <div className="flex flex-col gap-3 p-3">
            {scope !== "timeline" && (
              <div className="flex flex-col gap-1">
                <span className="text-[11px] font-bold tracking-[0.08em] text-ink-2 uppercase">Group by</span>
                <Segmented label="Group by" value={group} onChange={(g) => setView({ group: g })} options={[{ value: "timeline", label: "Timeline" }, { value: "none", label: "None" }]} />
                <span className="text-xs text-ink-3">{group === "timeline" ? "This timeline's first, then the other timelines', then what is on none." : "Everything, newest first."}</span>
              </div>
            )}
            <button type="button" aria-pressed={kept} onClick={() => setKept(!kept)} className={cx("flex h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold", kept ? "border-accent text-accent" : "border-line text-ink-2 hover:text-ink")}>
              <Star size={13} fill={kept ? "currentColor" : "none"} /> Kept only
            </button>
          </div>
        </Popover>
      )}
      {menu.element}
      {folders && (
        <Popover anchor={folderButton} onClose={() => setFolders(false)} label="Folders" width={300} height={520}>
          <FolderPanel
            place={place}
            onPlace={(p) => {
              setStudio({ place: p });
              setFolders(false);
            }}
          />
        </Popover>
      )}
    </>
  );
}
