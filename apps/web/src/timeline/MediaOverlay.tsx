import { useEffect, useMemo, useRef, useState } from "react";
import { Images, Search, Star } from "lucide-react";
import type { Asset, Timeline } from "../api";
import { useAssets, useFolders } from "../data";
import { clock } from "../format";
import { useSettled } from "../hooks";
import { Keys } from "../Keys";
import { useKeysHere } from "../keys/here";
import { useLeave } from "../leave";
import { LoadMore } from "../LoadMore";
import { FolderPanel, Tile } from "../screens/Library";
import { PlaceCrumbs } from "../screens/library/FolderPanel";
import { aspectOf } from "../screens/library/justify";
import { JustifiedRows, type Placed } from "../screens/studio/MediaGrid";
import { useStudio } from "../store";
import { useTileMenu } from "../TileMenu";
import type { MenuItem } from "../ContextMenu";
import { cx, Empty, IconButton, SearchField, SectionTitle, Segmented } from "../ui";
import { Select } from "../Select";
import { useFit } from "../useFit";
import { Viewer } from "../viewer/LazyViewer";
import { useMediaOpen } from "./mediaOpen";

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
 * place the Studio is looking at. Folded, it is the Media tab at the left edge (the whole strip one button); open, it covers the stage and
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
  useKeysHere("media", open);
  const place = useStudio((s) => s.place);
  const setStudio = useStudio((s) => s.set);
  const [scope, setScope] = useState<Scope>("folder");
  const [kept, setKept] = useState(false);
  const [kind, setKind] = useState<Kind>("all");
  const [typed, setTyped] = useState("");
  const q = useSettled(typed.trim());
  const folderButton = useRef<HTMLDivElement>(null);
  // its bar stays on one line, as the Studio's (LibraryHeader): 1 the kinds fold into a menu, 2 the scopes too, 3 the
  // "Esc close" hint goes (Esc still closes), 4 the search into an icon that opens it, 5 the breadcrumb narrower. At
  // 1280 px the stage is about 800 px wide, and the search was cut and the star pushed off its edge.
  const bar = useRef<HTMLDivElement>(null);
  // the bar is only drawn while the shelf is open: opened, it is measured from nothing (it overflowed at its first open)
  const fold = useFit(bar, 5, open ? "open" : "");
  const [searching, setSearching] = useState(false);
  const [folders, setFolders] = useState(false);
  // the item open large: the shelf's own viewer, so that ← → go through what the shelf shows
  const [viewing, setViewing] = useState<Asset | null>(null);
  // the shelf comes over the stage as a panel and, folded away, fades as a still copy: the stage's keys are back at once
  const shelfRef = useLeave<HTMLElement>("m-out");

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

  const since = useMemo(() => new Date(Date.now() - 2 * DAY).toISOString(), [scope]); // eslint-disable-line react-hooks/exhaustive-deps -- the cutoff is taken again when the scope changes, not at every render
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
  const items = useMemo(
    () =>
      fetched
        ? (assets.data?.pages.flatMap((p) => p.items) ?? [])
        : used.items.filter((a) => (kind === "all" || a.kind === kind) && (!kept || a.kept) && (!q || (a.name ?? "").toLowerCase().includes(q.toLowerCase()))),
    [fetched, assets.data, used.items, kind, kept, q],
  );
  // on this timeline first, in clip order; then the rest, as listed (a pinned picture is not on the track: it is in the rest, tagged)
  const [on, off] = useMemo(() => {
    const mine = items.filter((a) => used.roles.has(a.id)).sort((a, b) => used.roles.get(a.id)!.order - used.roles.get(b.id)!.order);
    return [mine, items.filter((a) => !used.roles.has(a.id))];
  }, [items, used]);
  const shown = useMemo(() => [...on, ...off], [on, off]);
  // the right-click: the item's list, as every tile's menu, after the timeline's own section (Use in clip N, Place on
  // the timeline); the open form is the clip's, which the first section serves
  const menu = useTileMenu({
    onOpen: setViewing,
    first: placeItems,
    place: "shelf",
    form: false,
  });

  // how many items the shelf's scope holds, said on the tab when it is known without asking for it: what the shelf shows
  // when that is all of it (this timeline's, or every page read), else the folder's own count from the folder list the
  // editor reads anyway (only while nothing narrows the shelf). Nothing rather than the length of the first page.
  const folderList = useFolders().data?.items;
  const narrowed = kind !== "all" || kept || Boolean(q);
  const count = !fetched || (assets.data && !assets.hasNextPage)
    ? items.length
    : scope === "folder" && place.type === "folder" && !narrowed ? folderList?.find((f) => f.id === place.id)?.count : undefined;

  // the whole strip is the button (Nicolas never thought of clicking a 28 px glyph in a margin): a media icon, the word,
  // the count, one hover over all of it. Grey at rest; open, it takes the rail's active look.
  const tab = (
    <button
      type="button"
      aria-pressed={open}
      aria-label={open ? "Fold the media away" : "Show the media"}
      data-tip={open ? "Fold the media away: the stage comes back" : "Media: your library over the stage. Drag onto the track or into the clip's form."}
      onClick={() => setOpen(!open)}
      className={cx(
        "group flex w-11 shrink-0 flex-col items-center gap-2.5 border-r border-line pt-2.5 transition-colors focus-visible:outline-offset-[-2px]",
        open ? "bg-raised" : "bg-panel hover:bg-hover",
      )}
    >
      <span className={cx("flex h-[30px] w-[30px] items-center justify-center rounded-full", open ? "bg-accent/18 text-accent" : "text-ink-2 group-hover:text-ink")}>
        <Images size={17} />
      </span>
      <span className={cx("text-meta font-semibold tracking-wide uppercase [writing-mode:vertical-rl]", open ? "text-accent" : "text-ink-2 group-hover:text-ink")}>Media</span>
      {count ? <span className="font-mono text-micro text-ink-3">{count}</span> : null}
    </button>
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
          {n && <span className="pointer-events-none absolute top-1.5 left-1.5 z-10 flex h-5 items-center rounded-full bg-ground px-[7px] text-meta font-bold text-accent">pinned · clip {n}</span>}
        </div>
      );
    },
  });
  const head = (words: string) => <SectionTitle className="mb-2">{words}</SectionTitle>;
  if (!open) return <>{tab}{viewer}</>;
  return (
    <>
      {tab}
      {/* it takes Escape: one press folds it away and leaves the range, the selection and the music panel as they are */}
      <section ref={shelfRef} aria-label="Your library" data-takes-escape className="m-panel absolute inset-y-0 right-0 left-11 z-20 flex flex-col bg-ground">
        <div ref={bar} className="flex h-14 shrink-0 flex-nowrap items-center gap-2 overflow-hidden border-b border-line px-4">
          <span className="shrink-0 text-meta font-bold tracking-label text-accent uppercase">Media</span>
          {/* the place, as the Studio's breadcrumb: inside the project worked in, its tree under it */}
          <PlaceCrumbs place={place} onPlace={(p) => setStudio({ place: p })} anchor={folderButton} open={folders} onOpen={setFolders} className={fold >= 5 ? "w-[clamp(110px,9vw,140px)]!" : undefined} />
          {fold >= 2
            ? <div className="w-36 shrink-0"><Select size="sm" className="h-9" label="What is shown" value={scope} onChange={(v) => setScope(v as Scope)} options={scopes} /></div>
            : <Segmented<Scope> oneLine label="What is shown" value={scope} onChange={setScope} options={scopes} />}
          {fold >= 1
            ? <div className="w-32 shrink-0"><Select size="sm" className={cx("h-9", kind !== "all" && "border-accent")} label="Kind" value={kind} onChange={(v) => setKind(v as Kind)} options={kinds} /></div>
            : <Segmented<Kind> oneLine label="Kind" value={kind} onChange={setKind} options={kinds} />}
          <span className="min-w-2 grow" />
          {fold >= 4 && !searching && !typed ? (
            <IconButton size={36} tone="outline" label="Search the media" tip="Search prompts and names" onClick={() => setSearching(true)}>
              <Search size={15} />
            </IconButton>
          ) : (
            // as tall as the bar's switches beside it (36 px), not the kit's small height
            <SearchField
              size={36}
              data-search="media"
              label="Search the media"
              placeholder="Search prompts and names"
              autoFocus={searching}
              onBlur={() => setSearching(false)}
              value={typed}
              onChange={setTyped}
              onClear={() => setTyped("")}
              className={cx("min-w-28 shrink", fold >= 4 ? "w-48" : "w-64")}
            />
          )}
          <IconButton size={36} tone="outline" pressed={kept} label="Kept only" tip={kept ? "Kept only: on. Show everything again" : "Kept only"} onClick={() => setKept(!kept)}>
            <Star size={14} fill={kept ? "currentColor" : "none"} />
          </IconButton>
          {fold < 3 && <span className="flex shrink-0 items-center gap-1.5 text-meta whitespace-nowrap text-ink-3"><Keys keys="Esc" size="sm" /> close</span>}
        </div>
        <div className="min-h-0 grow overflow-y-auto px-4 py-3.5">
          {(fetched ? assets.isSuccess : true) && !items.length && (
            <Empty title="Nothing here">{scope === "timeline" ? "This timeline uses nothing of that kind yet." : "Change the folder, the scope or the kind."}</Empty>
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
        <FolderPanel
          place={place}
          anchor={folderButton}
          onClose={() => setFolders(false)}
          onPlace={(p) => {
            setStudio({ place: p });
            setFolders(false);
          }}
        />
      )}
    </>
  );
}
