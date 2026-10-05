import { useEffect, useMemo, useRef, useState } from "react";
import { PanelLeftClose, PanelLeftOpen, Plus, Search } from "lucide-react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Asset, Timeline } from "../api";
import { useAssets, useFolders, useProjects } from "../data";
import { useSettled } from "../hooks";
import { LoadMore } from "../LoadMore";
import { Popover } from "../Popover";
import { useProject } from "../project";
import { FolderPanel, Tile } from "../screens/Library";
import { useStudio } from "../screens/Studio";
import { useTileMenu } from "../TileMenu";
import { cx, Segmented } from "../ui";

/** Whether the library is open over the editor's stage: kept from one visit to the next. */
const useMediaOpen = create<{ open: boolean; set(open: boolean): void }>()(persist((set) => ({ open: false, set: (open) => set({ open }) }), { name: "afflatus.media-open" }));

type Scope = "timeline" | "folder" | "recent" | "kept";
type Kind = "all" | "image" | "video" | "audio";
const DAY = 86_400_000;

/**
 * The library over the editor's stage: the Studio's own grid, with its folder button, its scopes ("This
 * timeline" in place of "This draft"), its kinds and its search, on the same place the Studio is looking
 * at. Folded, it is the Media tab at the left edge; open, it covers the stage and nothing else: the track
 * keeps its width and the clip's form stays at hand. A tile is dragged onto the track or into the form,
 * or clicked to go at the end. What the timeline already uses is dimmed.
 */
export function MediaOverlay({ timeline, selected, onAdd, onOpen }: {
  timeline: Timeline;
  /** Whether a clip is selected (a sound needs one to go on). */
  selected: boolean;
  /** Pictures and videos go at the end of the timeline; a sound goes on the selected clip. */
  onAdd(asset: Asset): void;
  /** The viewer, on this item: large, with everything that can be done with it. */
  onOpen(asset: Asset): void;
}) {
  const open = useMediaOpen((s) => s.open);
  const setOpen = useMediaOpen((s) => s.set);
  const place = useStudio((s) => s.place);
  const setStudio = useStudio((s) => s.set);
  const [scope, setScope] = useState<Scope>("folder");
  const [kind, setKind] = useState<Kind>("all");
  const [typed, setTyped] = useState("");
  const q = useSettled(typed.trim());
  const folderButton = useRef<HTMLButtonElement>(null);
  const [folders, setFolders] = useState(false);

  // the place, named as the Studio names it
  const projectId = useProject((s) => s.id);
  const folderList = useFolders();
  const projects = useProjects();
  const rootId = projectId && projectId !== "none" ? projects.data?.items.find((p) => p.id === projectId)?.folderId ?? null : null;
  const folder = place.type === "folder" ? folderList.data?.items.find((f) => f.id === place.id) : rootId ? folderList.data?.items.find((f) => f.id === rootId) : undefined;
  const placeName = place.type === "bin" ? "Bin" : place.type === "unfiled" ? "No folder" : place.type === "folder" ? folder?.name ?? "Folder" : "All";

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

  // what the timeline already uses: every take, the stills, the pinned pictures, the sounds, the music
  const used = useMemo(() => {
    const out = new Map<string, Asset>();
    const playing = new Set<string>();
    for (const c of timeline.clips) {
      if (c.take) playing.add(c.take.asset.id);
      for (const t of c.takes) out.set(t.asset.id, t.asset);
      if (c.still) out.set(c.still.id, c.still);
      for (const p of c.pictures) out.set(p.asset.id, p.asset);
      if (c.soundAsset) out.set(c.soundAsset.id, c.soundAsset);
    }
    if (timeline.music) out.set(timeline.music.asset.id, timeline.music.asset);
    return { items: [...out.values()], playing };
  }, [timeline]);

  const since = useMemo(() => new Date(Date.now() - 2 * DAY).toISOString(), [scope]); // eslint-disable-line react-hooks/exhaustive-deps
  const fetched = scope !== "timeline";
  const assets = useAssets(
    {
      kind: kind === "all" ? undefined : kind,
      bin: place.type === "bin" || undefined,
      folder: scope === "folder" ? (place.type === "folder" ? place.id : place.type === "unfiled" ? "none" : undefined) : undefined,
      since: scope === "recent" ? since : undefined,
      kept: scope === "kept" || undefined,
      q: q || undefined,
    },
    open && fetched,
  );
  const items = fetched
    ? (assets.data?.pages.flatMap((p) => p.items) ?? [])
    : used.items.filter((a) => (kind === "all" || a.kind === kind) && (!q || (a.name ?? "").toLowerCase().includes(q.toLowerCase())));
  const usedIds = useMemo(() => new Set(used.items.map((a) => a.id)), [used]);
  // the right-click: what the Studio's tiles offer, with the timeline's own line first
  const menu = useTileMenu({
    onOpen,
    first: (a) => [
      { label: a.kind === "audio" ? (selected ? "Use on the selected clip" : "Use on a clip (select one first)") : a.kind === "image" ? "Add at the end, as a still" : "Add at the end of the timeline", icon: <Plus size={14} />, disabled: a.kind === "audio" && !selected, run: () => onAdd(a) },
      "—",
    ],
  });
  const what = (a: Asset) => (a.kind === "video" ? "Click: add this video at the end of the timeline. Or drag it onto the track." : a.kind === "image" ? "Click: add this picture at the end, as a still. Or drag it onto the track, or onto a clip's first frame, keyframe or last frame." : selected ? "Click: use this sound on the selected clip. Or drag it onto a clip or the music track." : "Select a clip first, or drag the sound onto a clip or the music track.");

  const tab = (
    <aside className={cx("flex w-10 shrink-0 flex-col items-center border-r border-line py-2", open ? "bg-raised" : "bg-panel")}>
      <button
        type="button"
        aria-pressed={open}
        aria-label={open ? "Fold the media away" : "Show the media"}
        title={open ? "Fold the media away: the stage comes back" : "Media: your library over the stage. Drag onto the track or into the clip's form; a click adds at the end."}
        onClick={() => setOpen(!open)}
        className={cx("flex h-8 w-8 items-center justify-center rounded-lg hover:bg-hover hover:text-ink", open ? "text-accent" : "text-ink-2")}
      >
        {open ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
      </button>
      <span className={cx("mt-3 text-[10px] font-semibold tracking-wide uppercase [writing-mode:vertical-rl]", open ? "text-accent" : "text-ink-3")}>Media</span>
    </aside>
  );
  if (!open) return tab;
  return (
    <>
      {tab}
      <section aria-label="Your library" className="absolute inset-y-0 right-0 left-10 z-20 flex flex-col bg-ground">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
          <button ref={folderButton} type="button" aria-expanded={folders} title="Folders, the bin, and items in no folder" onClick={() => setFolders((o) => !o)} className="flex h-8 items-center gap-1.5 rounded-lg border border-line bg-panel px-2.5 text-sm font-semibold">
            {placeName} <span className="text-ink-3">▾</span>
          </button>
          <Segmented<Scope>
            label="What is shown"
            value={scope}
            onChange={setScope}
            options={[{ value: "timeline", label: "This timeline" }, { value: "folder", label: place.type === "all" ? "Everything" : "Whole folder" }, { value: "recent", label: "Recent" }, { value: "kept", label: "Kept" }]}
          />
          <Segmented<Kind> label="Media type" value={kind} onChange={setKind} options={[{ value: "all", label: "All" }, { value: "image", label: "Images" }, { value: "video", label: "Videos" }, { value: "audio", label: "Audio" }]} />
          <label className="ml-auto flex h-8 w-56 items-center gap-2 rounded-lg border border-line bg-raised px-2.5">
            <Search size={13} className="shrink-0 text-ink-3" />
            <input data-search="media" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Search prompts and names" className="min-w-0 grow bg-transparent text-xs text-ink outline-none placeholder:text-ink-3" />
          </label>
        </div>
        <div className="min-h-0 grow overflow-y-auto px-4 py-3">
          {(fetched ? assets.isSuccess : true) && !items.length && (
            <div className="py-10 text-center text-sm text-ink-3">{scope === "timeline" ? "This timeline uses nothing of that kind yet." : "Nothing here. Change the folder, the scope or the kind."}</div>
          )}
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
            {items.map((a) => (
              <div key={a.id} title={what(a)} className={cx("relative rounded-[10px]", usedIds.has(a.id) && scope !== "timeline" && "opacity-55", used.playing.has(a.id) && "ring-2 ring-accent")}>
                <Tile asset={a} onOpen={() => onAdd(a)} onMenu={(e) => menu.open(e, a)} />
              </div>
            ))}
          </div>
          {fetched && <LoadMore more={Boolean(assets.hasNextPage)} busy={assets.isFetchingNextPage} onMore={() => void assets.fetchNextPage()} />}
        </div>
        <div className="border-t border-line px-4 py-1.5 text-xs text-ink-3">Drag a tile onto the track, or onto a clip's first frame, keyframe or last frame in its form. A click adds it at the end. Esc folds the library away.</div>
      </section>
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
