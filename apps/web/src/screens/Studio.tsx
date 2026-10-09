import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { useLocation } from "wouter";
import { Plus } from "lucide-react";
import { api, type Asset } from "../api";
import { useFolders, useProjects, useTimelines } from "../data";
import { useProject } from "../project";
import { plainKey } from "../Keys";
import { Popover } from "../Popover";
import { displayOf, useBanners, useHandover, useOpenDraft, useStudio, type Scope } from "../store";
import { cx, Empty, ErrorNote } from "../ui";
import { Viewer } from "../Viewer";
import { useTileMenu } from "../TileMenu";
import { DRAG_TYPE, FolderPanel, Tile } from "./Library";
import { TimelineCards } from "./studio/TimelineCards";
import { LoadMore } from "../LoadMore";
import { CreatePanel } from "./studio/CreatePanel";
import { DraftResults } from "./studio/DraftResults";
import { groupItems } from "./studio/grouping";
import { fuzzyScore } from "@afflatus/core";
import { LibraryHeader } from "./studio/LibraryHeader";
import { LiveTile } from "./studio/LiveTile";
import { JustifiedRows, NotKeptLine, ROW_HEIGHT, type Placed } from "./studio/MediaGrid";
import { aspectOf, FALLBACK_ASPECT } from "./library/justify";
import { useQueueOf } from "./studio/queueOf";
import { useLibraryFilters } from "./studio/useLibraryFilters";
import { useSelection } from "./studio/useSelection";

/**
 * Studio: the library, with the form that makes things as a panel that opens and closes on its left.
 * Closed, the library has the whole width. Open, what is made lands in the folder that is open, and
 * the right side shows either that folder or only what the draft in the form has made, its newest
 * result large.
 */

export { useStudio, displayOf, openFolderId, type Display, type Scope } from "../store";

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
      <button type="button" aria-label="Create: open the form" data-tip="Create: open the form (N)" onClick={onOpen} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-accent text-accent-ink shadow-[0_4px_12px_color-mix(in_srgb,var(--color-accent)_30%,transparent)] hover:brightness-110">
        <Plus size={16} strokeWidth={2.6} />
      </button>
      {/* read bottom to top, as a spine */}
      <span aria-hidden className="rotate-180 text-[11px] font-bold tracking-[.1em] text-ink-2 uppercase [writing-mode:vertical-rl]">Create</span>
    </aside>
  );
}

export function Studio({ open: forced, timelines: onTimelines }: { open?: boolean; /** Opened from the rail's Timelines entry: the grid shows the timelines. */ timelines?: boolean }) {
  const view = useStudio();
  const [, go] = useLocation();
  // N opens the form, or folds it away, from anywhere on the screen (not while typing)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "n" || e.ctrlKey || e.metaKey || e.altKey || !plainKey(e) || document.querySelector("[role=dialog][aria-modal=true]")) return;
      e.preventDefault();
      useStudio.getState().set({ form: !useStudio.getState().form });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // "/create" (a link from elsewhere, a key in the viewer) opens the form; the screen itself lives at "/"
  useEffect(() => {
    if (!forced) return;
    view.set({ form: true });
    go("/", { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forced]);

  const folders = useFolders();
  const place = view.place;
  const projectId = useProject((s) => s.id);
  // a folder that is gone is no place to be, nor one of another project once the rail looks at a project (or the Inbox)
  useEffect(() => {
    if (place.type !== "folder" || !folders.isSuccess) return;
    const open = folders.data.items.find((f) => f.id === place.id);
    const elsewhere = open && projectId !== null && (projectId === "none" ? open.projectId !== null : open.projectId !== projectId);
    if (!open || elsewhere) view.set({ place: { type: "all" } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [place, folders.data, projectId]);
  // the folder what is made lands in: the one that is open, else the root of the project the app looks at
  const projectsList = useProjects();
  const rootId = projectId && projectId !== "none" ? projectsList.data?.items.find((p) => p.id === projectId)?.folderId ?? null : null;
  const folder = place.type === "folder" ? folders.data?.items.find((f) => f.id === place.id) : rootId ? folders.data?.items.find((f) => f.id === rootId) : undefined;
  const placeName = place.type === "bin" ? "Bin" : place.type === "unfiled" ? "Inbox" : place.type === "folder" ? folder?.name ?? "Folder" : "All";

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
    void api.asset(shown).then((a) => setOpen(a)).catch((err: Error) => say({ id: `shown:${Date.now()}`, tone: "bad", title: "The item that was dropped could not be opened", text: err.message, href: "/", go: "Open the library" }));
  }, [shown, hand, say]);
  // the address says which it is: the timelines live at /timelines, the media at /, so the rail's two entries always land somewhere
  const filters = useLibraryFilters({ place, view, draftId, initialKind: onTimelines ? "timeline" : "all", onKind: (k) => { if ((k === "timeline") !== Boolean(onTimelines)) go(k === "timeline" ? "/timelines" : "/", { replace: true }); } });
  const { kind, q, made, lora, kept, unkept, setUnkept, showTimelines, reach, filter, assets, items, filtered } = filters;
  // the stage (the newest large, the rest in a strip) in place of the grid, when the scope is on it; the timelines still show when asked for
  const display = displayOf(view, reach as Scope);
  const draftOnly = display === "Stage" && !showTimelines && (reach !== "draft" || Boolean(draftId));
  const stageOfDraft = draftOnly && reach === "draft";
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

  // the folders: a panel under their button, which also opens by itself while something is dragged, to drop it on a folder
  const folderButton = useRef<HTMLButtonElement>(null);
  const [foldersOpen, setFoldersOpen] = useState<false | "click" | "drag">(false);
  useEffect(() => {
    // after the drag has started (see dragging.ts): opened in the dragstart itself, the drag was sometimes cancelled
    const start = (e: DragEvent) => e.dataTransfer?.types.includes(DRAG_TYPE) && setTimeout(() => setFoldersOpen((o) => o || "drag"), 0);
    const end = () => setFoldersOpen((o) => (o === "drag" ? false : o));
    // a file from the computer: the same panel, so that it can be dropped straight into a folder (the drop tray stays for the other actions)
    const files = (e: DragEvent) => Boolean(e.dataTransfer?.types.includes("Files"));
    let depth = 0;
    const enter = (e: DragEvent) => {
      if (!files(e)) return;
      depth++;
      setFoldersOpen((o) => o || "drag");
    };
    const leave = (e: DragEvent) => {
      if (!files(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) end();
    };
    const dropped = (e: DragEvent) => {
      if (!files(e)) return;
      depth = 0;
      end();
    };
    window.addEventListener("dragstart", start);
    window.addEventListener("dragend", end);
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", dropped);
    return () => {
      window.removeEventListener("dragstart", start);
      window.removeEventListener("dragend", end);
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", dropped);
    };
  }, []);

  // what is ticked is of the list that is shown: another folder, another search, and nothing is
  const listKey = JSON.stringify([place, kind, q, made, lora, kept, unkept, draftOnly, reach]);
  const selection = useSelection({ items, listKey, binned: place.type === "bin", off: draftOnly || Boolean(open) });
  const { picked, tick, bulk, moveTo } = selection;
  // the grid in sections (grouping.ts); the stacks of takes shown opened
  const [openStacks, setOpenStacks] = useState<Set<string>>(new Set());
  const sections = useMemo(() => groupItems(items, view.groupBy ?? "none", openStacks), [items, view.groupBy, openStacks]);
  // the stage's strip: the grid's sections end to end (By timeline / By draft keep only what has one)
  const staged = useMemo(() => sections.flatMap((s) => s.entries.map((e) => e.asset)), [sections]);
  const groupedEmpty = view.groupBy === "draft"
    ? { title: "Nothing here came from a draft", body: "Grouped by draft, only what a draft made shows. Imports and older renders have no draft. Choose No groups to see everything." }
    : { title: "Nothing here is on a timeline", body: "Grouped by timeline, only takes of a timeline's clips show. Choose No groups to see everything." };
  const flipStack = (key: string) => setOpenStacks((old) => { const n = new Set(old); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const tileOf = (e: ReturnType<typeof groupItems>[number]["entries"][number]) => {
    const a = e.asset;
    const opened = e.stack ? openStacks.has(e.stack) : false;
    return (
      <div className="relative isolate h-full">
        <Tile
          fill
          asset={a}
          onOpen={() => setOpen(a)}
          selected={picked.includes(a.id)}
          selecting={picked.length > 0}
          onSelect={(range) => tick(a, range)}
          dragIds={picked.includes(a.id) ? picked : undefined}
          onMenu={(ev) => gridMenu.open(ev, a)}
          // a stack of takes: how many, and a way in; opened, the first take folds them back
          corner={e.takes && e.stack && (!opened || e.takes[0]!.id === a.id) && (
            <button
              type="button"
              onClick={() => flipStack(e.stack!)}
              data-tip={opened ? "Fold the takes of this clip back into one" : "Show every take of this clip"}
              className="rounded-md bg-ground/85 px-1.5 py-0.5 text-[11px] font-semibold text-ink shadow hover:bg-accent hover:text-accent-ink"
            >
              {opened ? "Fold takes" : `${e.takes.length} takes`}
            </button>
          )}
        />
        {!opened && e.takes && <span aria-hidden className="pointer-events-none absolute inset-x-2 -bottom-1.5 -z-10 h-full rounded-[12px] border border-line-strong bg-raised" />}
      </div>
    );
  };
  // the grid in justified rows (MediaGrid): each item at its own shape, rows as high as the display's size asks
  const rowHeight = ROW_HEIGHT[display === "Stage" ? view.size : display];
  const placesOf = (entries: ReturnType<typeof groupItems>[number]["entries"]): Placed[] => entries.map((e) => ({ key: e.asset.id, aspect: aspectOf(e.asset), render: () => tileOf(e) }));
  const gridMenu = useTileMenu({ onOpen: setOpen, onSelect: (a) => tick(a, false), into: { draft: draftOnly ? draftId ?? undefined : undefined, folder: folder?.id } });

  // what the Create panel is handed keeps its identity from one draw to the next: the panel is not drawn again for nothing
  const panelFolder = useMemo(() => (folder ? { id: folder.id, name: folder.name, path: folder.path } : null), [folder?.id, folder?.name, folder?.path]); // eslint-disable-line react-hooks/exhaustive-deps
  const closePanel = useCallback(() => useStudio.getState().set({ form: false }), []);
  const openRunningDraft = (id: string) => {
    openDraft(id);
    view.set({ form: true, scope: "draft" });
  };

  return (
    <div className="flex min-h-0 min-w-0 grow">
      {view.form ? <CreatePanel folder={panelFolder} onClose={closePanel} /> : <FormRail onOpen={() => view.set({ form: true })} />}
      <div className="flex min-w-0 grow flex-col">
        <LibraryHeader place={place} placeName={placeName} folderButton={folderButton} foldersOpen={foldersOpen} onFolders={setFoldersOpen} view={view} draftId={draftId} draftOnly={stageOfDraft} items={items} filters={filters} selection={selection} />

        <div className={cx("min-h-0 grow px-5 pt-1.5", draftOnly ? "overflow-hidden" : "overflow-y-auto pb-6")}>
          {draftOnly ? (
            stageOfDraft
              ? <DraftResults draft={draftId!} folder={folder?.id} />
              : <DraftResults folder={folder?.id} empty={items.length && !staged.length ? groupedEmpty : undefined} list={{ items: staged, hasNextPage: Boolean(assets.hasNextPage), more: () => void assets.fetchNextPage(), hasPreviousPage: Boolean(assets.hasPreviousPage), newer: () => void assets.fetchPreviousPage(), loading: assets.isFetchingNextPage || assets.isFetchingPreviousPage, ready: assets.isSuccess }} title={reach === "recent" ? "All recent" : placeName} />
          ) : (
            <>
              {assets.isError && <ErrorNote>{assets.error.message}</ErrorNote>}
              {(bulk.isError || moveTo.isError) && <ErrorNote>{(bulk.error ?? moveTo.error)?.message}</ErrorNote>}
              {showTimelines && <TimelineCards timelines={shownTimelines} ready={timelines.isSuccess} place={place} size={view.timelineSize ?? "M"} searched={Boolean(q)} />}
              {!showTimelines && assets.isSuccess && !items.length && !running && (
                <Empty title={filtered ? "No match" : place.type === "bin" ? "The bin is empty" : place.type === "folder" ? "This folder is empty" : "Nothing here yet"}>
                  {filtered
                    ? "Nothing here matches this search, model, LoRA or Kept filter. Change the search or the filters."
                    : place.type === "bin"
                      ? "Items you bin wait here a week before they are deleted for good."
                      : place.type === "folder"
                        ? "What you generate while it is open lands in it. Or drag images onto it from All."
                        : "Images and videos you generate appear here. Start with Create."}
                </Empty>
              )}
              {/* the pages above, let go past the cap (useAssets), read again when scrolled back up to */}
              {!showTimelines && <LoadMore more={Boolean(assets.hasPreviousPage)} busy={assets.isFetchingPreviousPage || assets.isFetchingNextPage} onMore={() => void assets.fetchPreviousPage()} />}
              {!showTimelines && items.length > 0 && !sections.length && <Empty title={groupedEmpty.title}>{groupedEmpty.body}</Empty>}
              {!showTimelines && place.type !== "bin" && <NotKeptLine items={items} filter={filter} whole={Boolean(assets.hasNextPage || assets.hasPreviousPage)} only={unkept} onOnly={setUnkept} />}
              {/* what is being made now comes first, where its result will land */}
              {!showTimelines && (
                <JustifiedRows
                  rowHeight={rowHeight}
                  places={[
                    ...(running && !("other" in running) && place.type !== "bin" && !filtered ? [{ key: "running", aspect: FALLBACK_ASPECT, render: () => <RunningTile onDraft={openRunningDraft} /> }] : []),
                    ...(sections.length === 1 && !sections[0]!.key ? placesOf(sections[0]!.entries) : []),
                  ]}
                />
              )}
              {(sections.length > 1 || Boolean(sections[0]?.key)) && sections.map((sec) => (
                <section key={sec.key} aria-label={sec.label} className="mt-4 flex flex-col gap-2 first:mt-1">
                  <div className="flex items-baseline gap-2 border-b border-line pb-1">
                    <span className="truncate text-sm font-semibold">{sec.label}</span>
                    <span className="shrink-0 text-xs text-ink-2">{sec.note}</span>
                    {sec.timeline && <button type="button" onClick={() => go(`/timelines/${sec.timeline}`)} className="shrink-0 text-xs font-semibold text-accent hover:underline">Open timeline</button>}
                  </div>
                  <JustifiedRows rowHeight={rowHeight} places={placesOf(sec.entries)} />
                </section>
              ))}
              {!showTimelines && <LoadMore more={Boolean(assets.hasNextPage)} busy={assets.isFetchingNextPage || assets.isFetchingPreviousPage} onMore={() => void assets.fetchNextPage()} />}
            </>
          )}
        </div>
      </div>

      {foldersOpen && (
        <Popover anchor={folderButton} onClose={() => setFoldersOpen(false)} label="Folders" width={300} height={520}>
          <FolderPanel
            place={place}
            dragging={foldersOpen === "drag"}
            onPlace={(p) => {
              view.set({ place: p });
              setFoldersOpen(false);
            }}
          />
        </Popover>
      )}
      {open && <Viewer asset={items.find((a) => a.id === open.id) ?? open} items={items} onOpen={setOpen} onClose={() => setOpen(null)} />}
      {gridMenu.element}
    </div>
  );
}
