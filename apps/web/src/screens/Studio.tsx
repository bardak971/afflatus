import { Suspense, useCallback, useEffect, useRef, useState, useMemo } from "react";
import { useLocation } from "wouter";
import { Plus } from "lucide-react";
import { api, type Asset } from "../api";
import { useFolders, useProjects, useSettings, useTimelines } from "../data";
import { Keys } from "../Keys";
import { useProject } from "../project";
import { useKeysHere } from "../keys/here";
import { displayOf, useBanners, useHandover, useOpenDraft, usePanelWidth, useStudio, type Scope } from "../store";
import { cx, Empty, ErrorNote, IconButton } from "../ui";
import { Viewer } from "../viewer/LazyViewer";
import { useTileMenu } from "../TileMenu";
import { FolderPanel, Tile } from "./Library";
import { LoadMore } from "../LoadMore";
import { BinStrip } from "./studio/BinStrip";
import { DraftResults } from "./studio/DraftResults";
import { groupItems } from "./studio/grouping";
import { fuzzyScore } from "@afflatus/core";
import { LibraryHeader } from "./studio/LibraryHeader";
import { LiveTile } from "./studio/LiveTile";
import { GroupedRows, JustifiedRows, morePlaces, PlaceholderRows, rememberShapes, ROW_HEIGHT, type Placed } from "./studio/MediaGrid";
import { aspectOf, FALLBACK_ASPECT } from "./library/justify";
import { useQueueOf } from "./studio/queueOf";
import { useLibraryFilters } from "./studio/useLibraryFilters";
import { useFolderDrag } from "./studio/useFolderDrag";
import { useSelection } from "./studio/useSelection";
import { useStudioAddress } from "./studio/useStudioAddress";
import { lazyPart, loadCreatePanel, loadTimelineCards } from "../lazyParts";
import { binFor } from "../keepFor";
import { failedBanner } from "../sayFailed";
import { usePasteIntoLibrary } from "../PasteHere";

// the form and the timeline cards are chunks of their own (lazyParts.ts): the library is drawn without them, and the
// form, when the app opens on it ("/create"), is asked for at once rather than once the screen is drawn
const CreatePanel = lazyPart(loadCreatePanel, (m) => m.CreatePanel);
const TimelineCards = lazyPart(loadTimelineCards, (m) => m.TimelineCards);
if (useStudio.getState().form) void loadCreatePanel();

/** The form's panel while its code comes: its width and its edge, so the library beside it does not move. */
function PanelShape() {
  const width = usePanelWidth((s) => s.width);
  return <aside aria-label="Create" aria-busy style={{ width }} className="shrink-0 border-r border-line bg-panel" />;
}

/**
 * Studio: the library, with the form that makes things as a panel that opens and closes on its left.
 * Closed, the library has the whole width. Open, what is made lands in the folder that is open, and
 * the right side shows either that folder or only what the draft in the form has made, its newest
 * result large.
 */

/** What is being made now, first in the grid where its result will land: the only part of the screen that follows its progress. */
function RunningTile({ onDraft }: { onDraft(id: string): void }) {
  const running = useQueueOf((q) => (q.running?.kind === "render" ? q.running : null));
  if (!running) return null;
  return (
    <LiveTile
      fill
      job={running}
      title={running.draftId ? "Open the draft it was queued from" : undefined}
      // to the draft it comes from: the form opens on it, with what it has made beside it
      onClick={running.draftId ? () => onDraft(running.draftId!) : undefined}
    />
  );
}

/** The form folded away: a rail at the left edge, as the timeline's media shelf folds, with the way to open it. */
function FormRail({ onOpen }: { onOpen(): void }) {
  return (
    <aside aria-label="Create (folded)" className="flex w-[46px] shrink-0 flex-col items-center gap-2.5 border-r border-line bg-panel py-3.5">
      <IconButton tone="primary" label="Create: open the form" keys="N" onClick={onOpen} className="shadow-[0_4px_12px_color-mix(in_srgb,var(--color-accent)_30%,transparent)]">
        <Plus size={16} strokeWidth={2.6} />
      </IconButton>
      {/* read bottom to top, as a spine */}
      <span aria-hidden className="rotate-180 text-meta font-bold tracking-label text-ink-2 uppercase [writing-mode:vertical-rl]">Create</span>
    </aside>
  );
}

export function Studio({ open: forced, timelines: onTimelines }: { open?: boolean; /** Opened from the rail's Timelines entry: the grid shows the timelines. */ timelines?: boolean }) {
  const view = useStudio();
  const [, go] = useLocation();
  // N opens and folds the form; the address follows it
  useStudioAddress({ forced, onTimelines });

  const folders = useFolders();
  const place = view.place;
  const projectId = useProject((s) => s.id);
  // a folder that is gone is no place to be, nor one of another project than the one worked in (or the Inbox)
  useEffect(() => {
    if (place.type !== "folder" || !folders.isSuccess) return;
    const open = folders.data.items.find((f) => f.id === place.id);
    const elsewhere = open && (projectId === "none" ? open.projectId !== null : open.projectId !== projectId);
    if (!open || elsewhere) view.set({ place: { type: "all" } });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- view is new at every render; the check runs when the folders or the place change
  }, [place, folders.data, projectId]);
  // the folder what is made lands in: the one that is open, else the root of the project the app looks at
  const projectsList = useProjects();
  const worked = projectId !== "none" ? projectsList.data?.items.find((p) => p.id === projectId) : undefined;
  const rootId = worked?.folderId ?? null;
  const folder = place.type === "folder" ? folders.data?.items.find((f) => f.id === place.id) : rootId ? folders.data?.items.find((f) => f.id === rootId) : undefined;
  // the whole of the place worked in is named after it: the project, or the Inbox
  const placeName = place.type === "bin" ? "Bin" : place.type === "unfiled" ? "No folder" : place.type === "folder" ? folder?.name ?? "Folder" : projectId === "none" ? "Inbox" : worked?.name ?? "Project";

  const draftId = useOpenDraft((s) => s.id);
  const openDraft = useOpenDraft((s) => s.open);

  const [open, setOpen] = useState<Asset | null>(null);
  // an item just dropped on the app: opened large, with everything that can be done with it
  const shown = useHandover((h) => h.show);
  const hand = useHandover((h) => h.set);
  const say = useBanners((b) => b.push);
  useEffect(() => {
    if (!shown) return;
    hand({ show: null });
    // the item already open is opened afresh: what it was handed with (a toast's Compare) is taken when it opens
    void api.asset(shown).then((a) => setOpen((was) => {
      if (was?.id === a.id) requestAnimationFrame(() => setOpen(a));
      return was?.id === a.id ? null : a;
    })).catch((err: unknown) => say(failedBanner({ id: "shown" }, "The item that was dropped could not be opened", err)));
  }, [shown, hand, say]);
  // the address says which it is: the timelines live at /timelines, the media at /, so the rail's two entries always land somewhere
  const filters = useLibraryFilters({ place, view, draftId, initialKind: onTimelines ? "timeline" : "all", onKind: (k) => { if ((k === "timeline") !== Boolean(onTimelines)) go(k === "timeline" ? "/timelines" : "/", { replace: true }); } });
  const { kind, q, made, lora, kept, unkept, showTimelines, reach, assets, items, filtered } = filters;
  // the stage (the newest large, the rest in a strip) in place of the grid, when the scope is on it; the timelines still show when asked for
  const display = displayOf(view, reach as Scope);
  const draftOnly = display === "Stage" && !showTimelines && (reach !== "draft" || Boolean(draftId));
  // the keys sheet's "Here now": N works on both lists; the grid's own keys only on the items
  useKeysHere("form");
  useKeysHere("grid", !showTimelines);
  const stageOfDraft = draftOnly && reach === "draft";
  // one Studio for / and /timelines: the address changing (the rail's Timelines entry, Back) sets what the grid shows
  useEffect(() => {
    if (Boolean(onTimelines) !== (filters.kind === "timeline")) filters.setKind(onTimelines ? "timeline" : "all");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the address sets the filter, not the other way round
  }, [onTimelines]);
  const timelines = useTimelines();
  // the timelines of the place that is open: a folder lists those whose renders land in it, the Inbox those in none,
  // the project as a whole every one of its own (the list comes scoped to the project already)
  // the search goes by name there; the order is the view's own
  const shownTimelines = (timelines.data?.items ?? [])
    .filter((t) => (view.place.type === "folder" ? t.folderId === view.place.id : view.place.type === "unfiled" ? t.folderId === null : true))
    .filter((t) => !q || fuzzyScore(q, t.name) !== null)
    .sort((a, b) => {
      const by = view.timelineSort ?? "recent";
      if (by === "name") return a.name.localeCompare(b.name, undefined, { numeric: true });
      if (by === "length") return b.durationMs - a.durationMs;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
  // whether a render runs, and from which draft: not its progress, which would draw the whole screen again at every step
  const running = useQueueOf((q) => (q.running?.kind === "render" ? { draftId: q.running.draftId } : q.running ? { draftId: null as string | null, other: true } : null)) ?? null;

  // the project's tree: under the breadcrumb, which also opens by itself while something is dragged, to drop it on a folder
  const folderButton = useRef<HTMLDivElement>(null);
  const { foldersOpen, setFoldersOpen } = useFolderDrag(showTimelines);
  // Ctrl+V with the media shown: into the folder open, else the project's root (the bin and the timelines take none)
  usePasteIntoLibrary(!showTimelines && place.type !== "bin", place.type === "folder" ? place.id : null, place.type === "folder" ? placeName : projectId === "none" ? "Inbox" : worked?.name ?? "Project");

  // the grid in sections (grouping.ts); the stacks of takes shown opened
  const [openStacks, setOpenStacks] = useState<Set<string>>(new Set());
  const sections = useMemo(() => groupItems(items, view.groupBy ?? "none", openStacks), [items, view.groupBy, openStacks]);
  // what is on screen, in its order: the grid's sections end to end (By timeline / By draft keep only what has one;
  // a folded stack is its top take). The stage's strip, and what is ticked, ranged and walked with the arrows
  const visible = useMemo(() => sections.flatMap((s) => s.entries.map((e) => e.asset)), [sections]);
  // what is ticked is of the list that is shown: another folder, another search, another grouping, and nothing is
  const listKey = JSON.stringify([place, kind, q, made, lora, kept, unkept, draftOnly, reach, view.groupBy ?? "none"]);
  // the shapes of what is shown, for the placeholders of the next visit to this list (MediaGrid.tsx rememberShapes)
  useEffect(() => {
    if (visible.length) rememberShapes(listKey, visible.slice(0, 120).map(aspectOf));
  }, [listKey, visible]);
  const selection = useSelection({ items: visible, listKey, binned: place.type === "bin", off: draftOnly || Boolean(open) });
  const { picked, setPicked, tick } = selection;
  const pickedSet = useMemo(() => new Set(picked), [picked]);
  const groupedEmpty = view.groupBy === "draft"
    ? { title: "Nothing here came from a draft", body: "Grouped by draft, only what a draft made shows. Imports and older renders have no draft. Choose No groups to see everything." }
    : { title: "Nothing here is on a timeline", body: "Grouped by timeline, only takes of a timeline's clips show. Choose No groups to see everything." };
  const flipStack = (key: string) => {
    // folded back, the takes under the top one leave the screen, and what is ticked of them is unticked
    if (openStacks.has(key)) {
      const hidden = new Set(sections.flatMap((s) => s.entries).filter((e) => e.stack === key && e.takes && e.asset.id !== e.takes[0]!.id).map((e) => e.asset.id));
      setPicked((old) => old.filter((id) => !hidden.has(id)));
    }
    setOpenStacks((old) => { const n = new Set(old); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  };
  // the tiles' callbacks, the same at every draw (Tile is memoised): each is told its item, and what it calls is read
  // when it is called, so a tick or a page redraws only the tiles whose own props changed
  const latest = useRef({ tick, menu: (_e: React.MouseEvent, _a: Asset) => {}, visible });
  const onTileSelect = useCallback((range: boolean, a: Asset) => latest.current.tick(a, range), []);
  const onTileMenu = useCallback((ev: React.MouseEvent, a: Asset) => latest.current.menu(ev, a), []);
  const tileOf = (e: ReturnType<typeof groupItems>[number]["entries"][number]) => {
    const a = e.asset;
    const opened = e.stack ? openStacks.has(e.stack) : false;
    return (
      <div className="relative isolate h-full">
        <Tile
          fill
          asset={a}
          onOpen={setOpen}
          selected={pickedSet.has(a.id)}
          selecting={picked.length > 0}
          onSelect={onTileSelect}
          dragIds={pickedSet.has(a.id) ? picked : undefined}
          onMenu={onTileMenu}
          // a stack of takes: how many, and a way in; opened, the first take folds them back
          corner={e.takes && e.stack && (!opened || e.takes[0]!.id === a.id) && (
            <button
              type="button"
              onClick={() => flipStack(e.stack!)}
              data-tip={opened ? "Fold the takes of this clip back into one" : "Show every take of this clip"}
              className="rounded-md bg-ground/85 px-1.5 py-0.5 text-meta font-semibold text-ink shadow hover:bg-accent hover:text-accent-ink"
            >
              {opened ? "Fold takes" : `${e.takes.length} takes`}
            </button>
          )}
        />
        {!opened && e.takes && <span aria-hidden className="pointer-events-none absolute inset-x-2 -bottom-1.5 -z-10 h-full rounded-xl border border-line-strong bg-raised" />}
      </div>
    );
  };
  // the grid in justified rows (MediaGrid): each item at its own shape, rows as high as the display's size asks
  const rowHeight = ROW_HEIGHT[display === "Stage" ? view.size : display];
  const placesOf = (entries: ReturnType<typeof groupItems>[number]["entries"]): Placed[] => entries.map((e) => ({ key: e.asset.id, aspect: aspectOf(e.asset), render: () => tileOf(e) }));
  // room for the next page after the last tile, while there is one (MediaGrid morePlaces): a page's worth of placeholders
  const coming = assets.hasNextPage ? morePlaces(assets.data?.pages[0]?.items.length ?? 0, assets.data?.pages.length ?? 0) : [];
  const gridMenu = useTileMenu({ onOpen: setOpen, onSelect: (a) => tick(a, false), into: { draft: draftOnly ? draftId ?? undefined : undefined, folder: folder?.id } });
  latest.current = { tick, menu: gridMenu.open, visible };
  const selectAll = useCallback(() => setPicked(latest.current.visible.map((a) => a.id)), [setPicked]);

  // what the Create panel is handed keeps its identity from one draw to the next: the panel is not drawn again for nothing
  const panelFolder = useMemo(() => (folder ? { id: folder.id, name: folder.name, path: folder.path } : null), [folder?.id, folder?.name, folder?.path]); // eslint-disable-line react-hooks/exhaustive-deps -- kept by its fields, so the panel is not drawn again for a new object with the same folder
  const closePanel = useCallback(() => useStudio.getState().set({ form: false }), []);
  const openRunningDraft = (id: string) => {
    openDraft(id);
    view.set({ form: true, scope: "draft" });
  };

  return (
    <div className="flex min-h-0 min-w-0 grow">
      {view.form ? <Suspense fallback={<PanelShape />}><CreatePanel folder={panelFolder} onClose={closePanel} /></Suspense> : <FormRail onOpen={() => view.set({ form: true })} />}
      <div className="flex min-w-0 grow flex-col">
        <LibraryHeader place={place} folderButton={folderButton} foldersOpen={foldersOpen} onFolders={setFoldersOpen} view={view} draftId={draftId} draftOnly={stageOfDraft} count={visible.length} onSelectAll={selectAll} filters={filters} selection={selection} />

        {/* no scroll anchoring of the browser's own: the grid's rows are placed absolutely, and only those in view are
            drawn (MediaGrid), so there is nothing above the view for it to follow */}
        <div className={cx("min-h-0 grow px-5 pt-1.5 [overflow-anchor:none]", draftOnly ? "overflow-hidden" : "overflow-y-auto pb-6")}>
          {draftOnly ? (
            stageOfDraft
              ? <DraftResults draft={draftId!} folder={folder?.id} />
              : <DraftResults folder={folder?.id} empty={items.length && !visible.length ? groupedEmpty : undefined} list={{ items: visible, hasNextPage: Boolean(assets.hasNextPage), more: () => void assets.fetchNextPage(), hasPreviousPage: Boolean(assets.hasPreviousPage), newer: () => void assets.fetchPreviousPage(), loading: assets.isFetchingNextPage || assets.isFetchingPreviousPage, ready: assets.isSuccess, failed: assets.isError }} title={reach === "recent" ? "All recent" : placeName} />
          ) : (
            <>
              {assets.isError && <ErrorNote>{assets.error.message}</ErrorNote>}
              {place.type === "bin" && <BinStrip />}
              {showTimelines && <Suspense fallback={null}><TimelineCards timelines={shownTimelines} ready={timelines.isSuccess} place={place} size={view.timelineSize ?? "M"} searched={Boolean(q)} /></Suspense>}
              {!showTimelines && assets.isSuccess && !items.length && !running && (
                <Empty
                  title={filtered ? "No match" : place.type === "bin" ? "The bin is empty" : place.type === "folder" ? "This folder is empty" : "Nothing here yet"}
                  help={filtered
                    ? "Nothing here matches this search, model, LoRA, Kept or Expiring filter. Change the search or the filters."
                    : place.type === "bin"
                      ? (binFor() ? `Items you bin wait here ${binFor()} before they are deleted for good.` : "Items you bin wait here until you empty the bin.")
                      : place.type === "folder"
                        ? "What you generate while it is open lands in it. Or drag items onto it in the project's tree, under the breadcrumb."
                        : "Images and videos you generate appear here. Start with Create."}
                  // the three ways in, said where the grid would be: what a first look at an empty library is for
                  action={!filtered && place.type !== "bin" && <WaysIn />}
                />
              )}
              {!showTimelines && items.length > 0 && !sections.length && <Empty title={groupedEmpty.title} help={groupedEmpty.body} />}
              {/* the first page on its way: placeholder tiles where the rows will be, at the display's size */}
              {!showTimelines && !assets.data && !assets.isError && <PlaceholderRows rowHeight={rowHeight} list={listKey} />}
              {/* what is being made now comes first, where its result will land */}
              {!showTimelines && Boolean(assets.data) && (
                <JustifiedRows
                  rowHeight={rowHeight}
                  places={[
                    ...(running && !("other" in running) && place.type !== "bin" && !filtered ? [{ key: "running", aspect: FALLBACK_ASPECT, render: () => <RunningTile onDraft={openRunningDraft} /> }] : []),
                    ...(sections.length === 1 && !sections[0]!.key ? [...placesOf(sections[0]!.entries), ...coming] : []),
                  ]}
                />
              )}
              {(sections.length > 1 || Boolean(sections[0]?.key)) && (
                <GroupedRows
                  rowHeight={rowHeight}
                  groups={sections.map((sec, n) => ({
                    key: sec.key,
                    label: sec.label,
                    places: n === sections.length - 1 ? [...placesOf(sec.entries), ...coming] : placesOf(sec.entries),
                    head: (
                      <>
                        <span className="truncate text-sm font-semibold">{sec.label}</span>
                        <span className="shrink-0 text-xs text-ink-2">{sec.note}</span>
                        {sec.timeline && <button type="button" onClick={() => go(`/timelines/${sec.timeline}`)} className="shrink-0 text-xs font-semibold text-accent hover:underline">Open timeline</button>}
                      </>
                    ),
                  }))}
                />
              )}
              {!showTimelines && <LoadMore more={Boolean(assets.hasNextPage)} busy={assets.isFetchingNextPage || assets.isFetchingPreviousPage} onMore={() => void assets.fetchNextPage()} />}
            </>
          )}
        </div>
      </div>

      {foldersOpen && (
        <FolderPanel
          place={place}
          anchor={folderButton}
          dragging={foldersOpen === "drag"}
          onClose={() => setFoldersOpen(false)}
          onPlace={(p) => {
            view.set({ place: p });
            setFoldersOpen(false);
          }}
        />
      )}
      {open && <Viewer asset={items.find((a) => a.id === open.id) ?? open} items={visible} more={{ has: Boolean(assets.hasNextPage), busy: assets.isFetchingNextPage || assets.isFetchingPreviousPage, load: () => void assets.fetchNextPage() }} onOpen={setOpen} onClose={() => setOpen(null)} />}
      {gridMenu.element}
    </div>
  );
}

/** How an empty library fills: a drop, the form's key, the command bar's key (the one set in Settings › Command bar). */
function WaysIn() {
  const bar = useSettings().data?.bar?.shortcut ?? "Ctrl+K";
  return (
    <span className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-body">
      <span>Drop pictures or videos here</span>
      <span className="text-ink-3">·</span>
      <span className="inline-flex items-center gap-1.5"><Keys keys="N" size="sm" /> opens the form</span>
      <span className="text-ink-3">·</span>
      <span className="inline-flex items-center gap-1.5"><Keys keys={bar} size="sm" /> finds a model</span>
    </span>
  );
}
