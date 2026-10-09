import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Folder as FolderIcon, PanelLeftClose, PanelLeftOpen, Search, Star, Trash2, X } from "lucide-react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Asset, Timeline } from "../api";
import { useAssets, useFolders, useProjects } from "../data";
import { clock } from "../format";
import { useSettled } from "../hooks";
import { Kbd } from "../Keys";
import { LoadMore } from "../LoadMore";
import { Popover } from "../Popover";
import { useProject } from "../project";
import { FolderPanel, Tile } from "../screens/Library";
import { aspectOf } from "../screens/library/justify";
import { JustifiedRows, type Placed } from "../screens/studio/MediaGrid";
import { useStudio } from "../store";
import { useTileMenu } from "../TileMenu";
import type { MenuItem } from "../ContextMenu";
import { cx, Segmented } from "../ui";
import { Select } from "../Select";
import { useFit } from "../useFit";
import { Viewer } from "../Viewer";

/** Whether the library is open over the editor's stage: kept from one visit to the next. */
const useMediaOpen = create<{ open: boolean; set(open: boolean): void }>()(
  persist((set) => ({ open: false, set: (open) => set({ open }) }), { name: "afflatus.media-open" }),
);
/** The rows' height: the Studio's justified rows, a little lower (the stage's room). The caption under a tile of this timeline. */
const ROW = 150;

type Scope = "timeline" | "folder" | "recent";
type Kind = "all" | "image" | "video" | "audio";
const DAY = 86_400_000;

/** What an item does on this timeline, said under its tile. */
interface Role {
  words: string;
  /** It plays on a clip: the ▶ dot and the ring. */
  plays: boolean;
  /** Its length on the timeline. */
  length: string;
  /** Clip order, so the section reads left to right as the track does. */
  order: number;
}

/**
 * The library over the editor's stage: the Studio's own grid (its justified rows, its tiles, its menu), with
 * its folder button, its scopes ("This timeline" in place of "Draft"), its kinds and its search, on the same
 * place the Studio is looking at. Folded, it is the Media tab at the left edge; open, it covers the stage and
 * nothing else: the track keeps its width and the clip's form stays at hand. In two parts: what is on this
 * timeline, its role said under each tile, then the rest as the library shows it. A tile is dragged onto the
 * track or into the form; a click opens it, the arrow keys going through the shelf.
 */
export function MediaOverlay({ timeline, placeItems }: {
  timeline: Timeline;
  /** Where the item can go in what is being edited: into the selected clip's places, onto the timeline. First in its menu. */
  placeItems(asset: Asset): MenuItem[];
}) {
  const open = useMediaOpen((s) => s.open);
  const setOpen = useMediaOpen((s) => s.set);
  const place = useStudio((s) => s.place);
  const setStudio = useStudio((s) => s.set);
  const [scope, setScope] = useState<Scope>("folder");
  const [kept, setKept] = useState(false);
  const [kind, setKind] = useState<Kind>("all");
  const [typed, setTyped] = useState("");
  const q = useSettled(typed.trim());
  const folderButton = useRef<HTMLButtonElement>(null);
  // its bar stays on one line, as the Studio's: 1 the kinds fold into a menu, 2 the scopes too
  const bar = useRef<HTMLDivElement>(null);
  const fold = useFit(bar, 2);
  const [folders, setFolders] = useState(false);
  // the item open large: the shelf's own viewer, so that ← → go through what the shelf shows
  const [viewing, setViewing] = useState<Asset | null>(null);

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

  // what the timeline uses (every take, the stills, the sounds, the music: its role; the pinned pictures: their clip)
  const used = useMemo(() => {
    const out = new Map<string, Asset>();
    const roles = new Map<string, Role>();
    const pinned = new Map<string, number>();
    const len = (a: Asset, ms = a.durationMs) => (ms ? clock(ms, { decimals: a.kind === "audio" ? 0 : 1 }) : "");
    const role = (a: Asset, r: Role) => { out.set(a.id, a); if (!roles.has(a.id)) roles.set(a.id, r); };
    timeline.clips.forEach((c, i) => {
      const n = i + 1;
      // a take says its clip and take on its tile, as in the library's own listing (where the server says it): a copy, the
      // timeline's own objects left as they are
      const asTake = (t: (typeof c.takes)[number], k: number): Asset => {
        if (t.asset.clipOf) return t.asset;
        const from = t.finishedFrom ? c.takes.find((x) => x.id === t.finishedFrom)?.asset : undefined;
        const upscaledBy = t.finishedFrom ? (from?.width && t.asset.width ? Math.round((t.asset.width / from.width) * 10) / 10 : 1) : null;
        return { ...t.asset, clipOf: { timeline: timeline.id, timelineName: timeline.name, clip: n, take: k + 1, takes: c.takes.length, playing: c.take?.id === t.id, upscaledBy } };
      };
      const takes = c.takes.map(asTake);
      const playing = c.take ? takes.find((a) => a.id === c.take!.asset.id) ?? c.take.asset : null;
      if (playing) role(playing, { words: `Clip ${n}`, plays: true, length: len(playing), order: n });
      for (const a of takes) role(a, { words: `Clip ${n} · take`, plays: false, length: len(a), order: n });
      if (c.still) role(c.still, { words: `Clip ${n}`, plays: true, length: len(c.still, c.lengthMs), order: n });
      for (const p of c.pictures) { out.set(p.asset.id, p.asset); if (!pinned.has(p.asset.id)) pinned.set(p.asset.id, n); }
      if (c.soundAsset) role(c.soundAsset, { words: `Clip ${n} · sound`, plays: false, length: len(c.soundAsset), order: n });
    });
    if (timeline.music) role(timeline.music.asset, { words: "Music", plays: false, length: len(timeline.music.asset), order: timeline.clips.length + 1 });
    return { items: [...out.values()], roles, pinned };
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
  // on this timeline first, in clip order; then the rest, as listed (a pinned picture is not on the track: it is in the rest, tagged)
  const [on, off] = useMemo(() => {
    const mine = items.filter((a) => used.roles.has(a.id)).sort((a, b) => used.roles.get(a.id)!.order - used.roles.get(b.id)!.order);
    return [mine, items.filter((a) => !used.roles.has(a.id))];
  }, [items, used]);
  const shown = useMemo(() => [...on, ...off], [on, off]);
  // the right-click: what the Studio's tiles offer, with the timeline's own line first
  const menu = useTileMenu({
    onOpen: setViewing,
    first: placeItems,
    compact: true,
  });

  const tab = (
    <aside className={cx("flex w-10 shrink-0 flex-col items-center border-r border-line py-2", open ? "bg-raised" : "bg-panel")}>
      <button
        type="button"
        aria-pressed={open}
        aria-label={open ? "Fold the media away" : "Show the media"}
        data-tip={open ? "Fold the media away: the stage comes back" : "Media: your library over the stage. Drag onto the track or into the clip's form."}
        onClick={() => setOpen(!open)}
        className={cx("flex h-8 w-8 items-center justify-center rounded-lg hover:bg-hover hover:text-ink", open ? "text-accent" : "text-ink-2")}
      >
        {open ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
      </button>
      <span className={cx("mt-3 text-[10px] font-semibold tracking-wide uppercase [writing-mode:vertical-rl]", open ? "text-accent" : "text-ink-3")}>Media</span>
    </aside>
  );
  const viewer = viewing && <Viewer asset={shown.find((a) => a.id === viewing.id) ?? viewing} items={shown} onOpen={setViewing} onClose={() => setViewing(null)} />;
  // short, as the Studio's, so the three stay a segmented control
  const scopes: Array<{ value: Scope; label: string }> = [{ value: "timeline", label: "This timeline" }, { value: "folder", label: "Folder" }, { value: "recent", label: "Recent" }];
  const kinds: Array<{ value: Kind; label: string }> = [{ value: "all", label: "All" }, { value: "image", label: "Images" }, { value: "video", label: "Videos" }, { value: "audio", label: "Audio" }];

  // on this timeline: the library's own tile (its length, its clip and take, its name and card on hover); what plays is ringed
  const onTile = (a: Asset): Placed => ({
    key: a.id,
    aspect: aspectOf(a),
    render: () => (
      <div className={cx("h-full rounded-xl", used.roles.get(a.id)?.plays && "ring-2 ring-accent/60")}>
        <Tile fill asset={a} onOpen={() => setViewing(a)} onMenu={(e) => menu.open(e, a)} />
      </div>
    ),
  });
  // the rest: the library's tile, a pinned picture tagged with its clip
  const offTile = (a: Asset): Placed => ({
    key: a.id,
    aspect: aspectOf(a),
    render: () => {
      const n = used.pinned.get(a.id);
      return (
        <div className="relative h-full">
          <Tile fill asset={a} onOpen={() => setViewing(a)} onMenu={(e) => menu.open(e, a)} />
          {n && <span className="pointer-events-none absolute top-1.5 left-1.5 z-10 flex h-5 items-center rounded-full bg-ground px-[7px] text-[11px] font-bold text-accent">pinned · clip {n}</span>}
        </div>
      );
    },
  });
  const head = (words: string) => <div className="mb-2 text-[11px] font-bold tracking-[0.08em] text-ink-3 uppercase">{words}</div>;
  if (!open) return <>{tab}{viewer}</>;
  return (
    <>
      {tab}
      {/* it takes Escape: one press folds it away and leaves the range, the selection and the music panel as they are */}
      <section aria-label="Your library" data-takes-escape className="absolute inset-y-0 right-0 left-10 z-20 flex flex-col bg-ground">
        <div ref={bar} className="flex h-14 shrink-0 flex-nowrap items-center gap-2 overflow-hidden border-b border-line px-4">
          <span className="shrink-0 text-[11px] font-bold tracking-[0.08em] text-accent uppercase">Media</span>
          <button
            ref={folderButton}
            type="button"
            aria-haspopup="dialog"
            aria-expanded={folders}
            data-tip="Folders, items in no folder, and the bin"
            onClick={() => setFolders((o) => !o)}
            className={cx("flex h-9 max-w-56 shrink-0 items-center gap-2 rounded-lg border bg-raised px-3 text-sm font-semibold", folders ? "border-accent" : "border-line-strong")}
          >
            {place.type === "bin" ? <Trash2 size={15} className="shrink-0" /> : <FolderIcon size={15} className="shrink-0" />}
            <span className="truncate">{placeName}</span>
            <ChevronDown size={14} className="shrink-0 text-ink-2" />
          </button>
          {fold >= 2
            ? <div className="w-36 shrink-0"><Select size="sm" className="h-9" label="What is shown" value={scope} onChange={(v) => setScope(v as Scope)} options={scopes} /></div>
            : <Segmented<Scope> oneLine label="What is shown" value={scope} onChange={setScope} options={scopes} />}
          {fold >= 1
            ? <div className="w-32 shrink-0"><Select size="sm" className={cx("h-9", kind !== "all" && "border-accent")} label="Kind" value={kind} onChange={(v) => setKind(v as Kind)} options={kinds} /></div>
            : <Segmented<Kind> oneLine label="Kind" value={kind} onChange={setKind} options={kinds} />}
          <span className="min-w-2 grow" />
          <label className="flex h-9 w-64 min-w-28 shrink items-center gap-2 rounded-lg border border-line bg-raised px-2.5 focus-within:border-accent">
            <Search size={14} className="shrink-0 text-ink-3" />
            <input data-search="media" aria-label="Search the media" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Search prompts and names" className="min-w-0 grow bg-transparent placeholder:text-ink-3 focus:outline-none" />
            {typed && <button type="button" aria-label="Clear the search" onClick={() => setTyped("")} className="text-ink-3 hover:text-ink"><X size={13} /></button>}
          </label>
          <button type="button" aria-pressed={kept} aria-label="Kept only" data-tip={kept ? "Kept only: on. Show everything again" : "Kept only"} onClick={() => setKept(!kept)} className={cx("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border", kept ? "border-accent text-accent" : "border-line text-ink-2 hover:text-ink")}>
            <Star size={14} fill={kept ? "currentColor" : "none"} />
          </button>
          <span className="flex shrink-0 items-center gap-1.5 text-[11.5px] whitespace-nowrap text-ink-3"><Kbd>Esc</Kbd> close</span>
        </div>
        <div className="min-h-0 grow overflow-y-auto px-4 py-3.5">
          {(fetched ? assets.isSuccess : true) && !items.length && (
            <div className="py-10 text-center text-sm text-ink-3">{scope === "timeline" ? "This timeline uses nothing of that kind yet." : "Nothing here. Change the folder, the scope or the kind."}</div>
          )}
          {on.length > 0 && (
            <section aria-label="On this timeline" className="mb-5">
              {head(`On this timeline · ${on.length}`)}
              <JustifiedRows rowHeight={ROW} places={on.map(onTile)} />
            </section>
          )}
          {off.length > 0 && (
            <section aria-label="Not on it">
              {head(`Not on it · ${off.length}`)}
              <JustifiedRows rowHeight={ROW} places={off.map(offTile)} />
            </section>
          )}
          {fetched && <LoadMore more={Boolean(assets.hasNextPage)} busy={assets.isFetchingNextPage} onMore={() => void assets.fetchNextPage()} />}
        </div>
      </section>
      {menu.element}
      {viewer}
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
