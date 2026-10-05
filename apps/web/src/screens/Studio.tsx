import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { Film, Plus } from "lucide-react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { api, thumbUrl, type Asset } from "../api";
import { useFolders, useProjects, useQueue, useTimelines } from "../data";
import { useProject } from "../project";
import { clock, when } from "../format";
import { plainKey } from "../Keys";
import { Popover } from "../Popover";
import { useBanners, useHandover, useOpenDraft } from "../store";
import { cx, Empty, ErrorNote } from "../ui";
import { Viewer } from "../Viewer";
import { useTileMenu } from "../TileMenu";
import { DRAG_TYPE, FolderPanel, Tile, type Place } from "./Library";
import { LoadMore } from "../LoadMore";
import { CreatePanel } from "./studio/CreatePanel";
import { DraftResults } from "./studio/DraftResults";
import { LibraryHeader } from "./studio/LibraryHeader";
import { LiveTile } from "./studio/LiveTile";
import { useLibraryFilters } from "./studio/useLibraryFilters";
import { useSelection } from "./studio/useSelection";

/**
 * Studio: the library, with the form that makes things as a panel that opens and closes on its left.
 * Closed, the library has the whole width. Open, what is made lands in the folder that is open, and
 * the right side shows either that folder or only what the draft in the form has made, its newest
 * result large.
 */

/** How the screen was left: kept from one visit to the next, and while another screen is open. */
export const useStudio = create<{
  form: boolean;
  size: "S" | "M" | "L";
  /** What the grid shows while the form is open: this draft's outputs, the whole folder, the last two days, what was kept. */
  scope: "draft" | "all" | "recent" | "kept";
  place: Place;
  set(patch: Partial<{ form: boolean; size: "S" | "M" | "L"; scope: "draft" | "all" | "recent" | "kept"; place: Place }>): void;
}>()(persist((set) => ({ form: false, size: "M", scope: "draft", place: { type: "all" }, set: (patch) => set(patch) }), { name: "afflatus.studio" }));
/** The folder open in the library, for what is brought in from outside (a drop, an upload): null when none is. */
export const openFolderId = (): string | null => {
  const p = useStudio.getState().place;
  return p.type === "folder" ? p.id : null;
};

const TILE = { S: "minmax(120px,1fr)", M: "minmax(170px,1fr)", L: "minmax(250px,1fr)" };

/** The form folded away: a rail at the left edge, as the timeline's media shelf folds, with the way to open it. */
function FormRail({ onOpen }: { onOpen(): void }) {
  return (
    <aside aria-label="Create (folded)" className="flex w-10 shrink-0 flex-col items-center gap-2 border-r border-line bg-panel py-2">
      <button type="button" aria-label="Create: open the form" title="Create: open the form (N)" onClick={onOpen} className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-accent-ink hover:brightness-110">
        <Plus size={16} strokeWidth={2.6} />
      </button>
      <span aria-hidden className="mt-1 text-[10px] font-semibold tracking-wide text-ink-3 uppercase [writing-mode:vertical-rl]">Create</span>
    </aside>
  );
}

export function Studio({ open: forced }: { open?: boolean }) {
  const view = useStudio();
  const [, go] = useLocation();
  // N opens the form, or folds it away, from anywhere on the screen (not while typing)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "n" || e.ctrlKey || e.metaKey || e.altKey || !plainKey(e)) return;
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
  // a folder that is gone is no place to be
  useEffect(() => {
    if (place.type === "folder" && folders.isSuccess && !folders.data.items.some((f) => f.id === place.id)) view.set({ place: { type: "all" } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [place, folders.data]);
  // the folder what is made lands in: the one that is open, else the root of the project the app looks at
  const projectId = useProject((s) => s.id);
  const projectsList = useProjects();
  const rootId = projectId && projectId !== "none" ? projectsList.data?.items.find((p) => p.id === projectId)?.folderId ?? null : null;
  const folder = place.type === "folder" ? folders.data?.items.find((f) => f.id === place.id) : rootId ? folders.data?.items.find((f) => f.id === rootId) : undefined;
  const placeName = place.type === "bin" ? "Bin" : place.type === "unfiled" ? "No folder" : place.type === "folder" ? folder?.name ?? "Folder" : "All";

  const draftId = useOpenDraft((s) => s.id);
  const openDraft = useOpenDraft((s) => s.open);
  const draftOnly = view.form && view.scope === "draft" && Boolean(draftId);

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
  const filters = useLibraryFilters({ place, view, draftId });
  const { kind, q, made, lora, kept, showTimelines, reach, assets, items, filtered } = filters;
  const timelines = useTimelines();
  const queue = useQueue();

  // the folders: a panel under their button, which also opens by itself while something is dragged, to drop it on a folder
  const folderButton = useRef<HTMLButtonElement>(null);
  const [foldersOpen, setFoldersOpen] = useState<false | "click" | "drag">(false);
  useEffect(() => {
    const start = (e: DragEvent) => e.dataTransfer?.types.includes(DRAG_TYPE) && setFoldersOpen((o) => o || "drag");
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
  const running = queue.data?.running ?? null;

  // what is ticked is of the list that is shown: another folder, another search, and nothing is
  const listKey = JSON.stringify([place, kind, q, made, lora, kept, draftOnly, reach]);
  const selection = useSelection({ items, listKey, binned: place.type === "bin", off: draftOnly || Boolean(open) });
  const { picked, tick, bulk, moveTo } = selection;
  const gridMenu = useTileMenu({ onOpen: setOpen, onSelect: (a) => tick(a, false), into: { draft: draftOnly ? draftId ?? undefined : undefined, folder: folder?.id } });

  return (
    <div className="flex min-h-0 min-w-0 grow">
      {view.form ? <CreatePanel folder={folder ? { id: folder.id, name: folder.name, path: folder.path } : null} onClose={() => view.set({ form: false })} /> : <FormRail onOpen={() => view.set({ form: true })} />}
      <div className="flex min-w-0 grow flex-col">
        <LibraryHeader place={place} placeName={placeName} folderButton={folderButton} foldersOpen={foldersOpen} onFolders={setFoldersOpen} view={view} draftId={draftId} draftOnly={draftOnly} items={items} filters={filters} selection={selection} />

        <div className={cx("min-h-0 grow px-5 pt-1.5", draftOnly ? "overflow-hidden" : "overflow-y-auto pb-6")}>
          {draftOnly ? (
            <DraftResults draft={draftId!} folder={folder?.id} />
          ) : (
            <>
              {assets.isError && <ErrorNote>{assets.error.message}</ErrorNote>}
              {(bulk.isError || moveTo.isError) && <ErrorNote>{(bulk.error ?? moveTo.error)?.message}</ErrorNote>}
              {showTimelines && (
                <>
                  {timelines.isSuccess && !timelines.data.items.length && <Empty title="No timeline yet">A timeline sequences clips one after the other. Create one in Timelines.</Empty>}
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-3.5">
                    {timelines.data?.items.map((t) => (
                      <Link key={t.id} href={`/timelines/${t.id}`} className="flex flex-col overflow-hidden rounded-[10px] border border-line bg-panel hover:border-accent">
                        <span className="relative flex aspect-video items-center justify-center overflow-hidden bg-raised text-ink-3">
                          {t.cover ? <img src={thumbUrl(t.cover)} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" /> : <Film size={26} />}
                        </span>
                        <span className="flex flex-col px-3 py-2">
                          <span className="truncate font-semibold">{t.name}</span>
                          <span className="text-xs text-ink-2">{t.clips === 0 ? "Empty" : `${t.clips} clip${t.clips > 1 ? "s" : ""}${t.durationMs ? ` · ${clock(t.durationMs)}` : ""}`} · {when(t.updatedAt)}</span>
                        </span>
                      </Link>
                    ))}
                  </div>
                </>
              )}
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
              <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(auto-fill, ${TILE[view.size]})` }}>
                {/* what is being made now comes first, where its result will land */}
                {!showTimelines && running && running.kind === "render" && place.type !== "bin" && !filtered && (
                  <LiveTile
                    job={running}
                    title={running.draftId ? "Open the draft it was queued from" : undefined}
                    // to the draft it comes from: the form opens on it, with what it has made beside it
                    onClick={running.draftId ? () => {
                      openDraft(running.draftId);
                      view.set({ form: true, scope: "draft" });
                    } : undefined}
                  />
                )}
                {items.map((a) => (
                  <Tile
                    key={a.id}
                    asset={a}
                    onOpen={() => setOpen(a)}
                    selected={picked.includes(a.id)}
                    selecting={picked.length > 0}
                    onSelect={(range) => tick(a, range)}
                    dragIds={picked.includes(a.id) ? picked : undefined}
                    onMenu={(e) => gridMenu.open(e, a)}
                  />
                ))}
              </div>
              {!showTimelines && <LoadMore more={Boolean(assets.hasNextPage)} busy={assets.isFetchingNextPage} onMore={() => void assets.fetchNextPage()} />}
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
