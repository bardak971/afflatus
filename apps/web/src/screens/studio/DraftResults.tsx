import { useEffect, useRef, useState } from "react";
import { Images, Square, X } from "lucide-react";
import type { Asset } from "../../api";
import { useAssets, useQueue } from "../../data";
import { about, clock, phaseLabel } from "../../format";
import { Kbd } from "../../Keys";
import { useStudio } from "../../store";
import { LivePreview, StageStrip } from "../../LivePreview";
import { useStop } from "../../ModelLoad";
import { Bar, Button, cx, Empty, ErrorNote } from "../../ui";
import { Viewer } from "../../Viewer";
import { useTileMenu } from "../../TileMenu";
import { Tile, tileName } from "../Library";
import { LiveTile } from "./LiveTile";

/**
 * What the draft in the form has made: the newest result large, with what can be done with it under
 * it, and the earlier ones as a strip to go back to. While the draft renders, what is forming is shown
 * large instead, until one of the results is picked.
 */
export function DraftResults({ draft, folder, list, title, empty }: {
  /** The draft whose outputs these are: its renders show live. Without it, `list` is what is shown. */
  draft?: string;
  folder: string | undefined;
  /** The scope's own list (Recent, Kept, the folder), for the stage in any scope. */
  list?: { items: Asset[]; hasNextPage: boolean; more(): void; hasPreviousPage: boolean; newer(): void; loading: boolean; ready: boolean };
  title?: string;
  /** What an empty `list` says, when it is empty because of the grouping rather than the place. */
  empty?: { title: string; body: string };
}) {
  // the scope's own list given: the draft's is not asked for
  const own = useAssets({ draft: draft ?? "__none__" }, !list, true);
  const queue = useQueue();
  const items = list ? list.items : own.data?.pages.flatMap((p) => p.items) ?? [];
  const assets = list
    ? { isSuccess: list.ready, hasNextPage: list.hasNextPage, fetchNextPage: list.more, hasPreviousPage: list.hasPreviousPage, fetchPreviousPage: list.newer, isFetchingNextPage: list.loading, isFetchingPreviousPage: list.loading }
    : own;
  const busy = assets.isFetchingNextPage || assets.isFetchingPreviousPage;
  const tileMenu = useTileMenu({ onOpen: (a) => setPicked(a.id), into: { draft, folder } });
  // a draft's stage shows its own renders forming; another scope's, whatever renders now
  const running = draft ? (queue.data?.running?.draftId === draft ? queue.data.running : null) : queue.data?.running?.kind === "render" ? queue.data.running : null;
  const inLine = (queue.data?.waiting ?? []).filter((j) => (draft ? j.draftId === draft : true));
  const waiting = inLine.length;
  const stop = useStop();
  // what is shown large: the one that was picked, else what is forming, else the newest
  const [picked, setPicked] = useState<string | "live" | null>(null);
  const [details, setDetails] = useState<Asset | null>(null);
  // a new result takes the large place: the pick is forgotten when the list gets a new first item (a new one at the
  // very top: not the first page let go past the cap, nor read again on the way back up)
  const newest = assets.hasPreviousPage ? undefined : items[0]?.id;
  const seen = useRef(newest);
  useEffect(() => {
    if (newest && newest !== seen.current) setPicked(null);
    if (newest) seen.current = newest;
  }, [newest]);
  useEffect(() => setPicked(null), [draft]);
  const chosen = picked && picked !== "live" ? items.find((a) => a.id === picked) : undefined;
  const live = running && (picked === "live" || !chosen);
  const shown = chosen ?? (live ? undefined : items[0]);

  if (assets.isSuccess && !items.length && !running && !waiting) {
    if (!draft && empty) return <Empty title={empty.title}>{empty.body}</Empty>;
    if (!draft) return <Empty title="Nothing here yet">Nothing in this view. Another scope or folder may have what you are looking for.</Empty>;
    return <NothingYet />;
  }
  return (
    <div className="flex h-full min-h-0 gap-4">
      <div data-stage className="flex min-h-0 min-w-0 grow flex-col rounded-xl bg-stage p-[var(--stage-pad)]">
        {live && running && (
          <div className="flex min-h-0 grow flex-col items-center justify-center gap-3 pb-4">
            <LivePreview job={running} sound className="h-[calc(100%-70px)] min-h-0 w-auto max-w-full rounded-lg object-contain" />
            <StageStrip job={running} className="flex max-w-full gap-2 overflow-x-auto" />
            <div className="flex w-72 flex-col items-center gap-1.5 text-center">
              <span className="font-semibold">{phaseLabel(running.phase)}{running.steps ? ` · step ${running.step} of ${running.steps}` : ""}{running.eta ? ` · ${about(running.eta)}` : ""}</span>
              <div className="w-full"><Bar value={running.progress * 100} /></div>
              {waiting > 0 && <span className="text-xs text-ink-2">{waiting} more queued</span>}
              <div className="flex flex-wrap justify-center gap-2 pt-1">
                <Button size="sm" onClick={() => stop.mutate([running.id])} disabled={stop.isPending} data-tip={waiting ? "Cancel this render. Nothing is saved; the next queued job starts." : "Cancel this render. Nothing is saved."}>
                  <Square size={11} fill="currentColor" /> Cancel render
                </Button>
                {waiting > 0 && (
                  <Button size="sm" onClick={() => stop.mutate([...inLine.map((j) => j.id), running.id])} disabled={stop.isPending} data-tip="Cancel this render and remove the queued jobs from the queue.">
                    Cancel all {waiting + 1}
                  </Button>
                )}
              </div>
              {stop.isError && <ErrorNote>{stop.error.message}</ErrorNote>}
            </div>
          </div>
        )}
        {!live && shown && (
          <Viewer
            inline
            asset={shown}
            items={items}
            onOpen={(a) => setPicked(a.id)}
            onClose={() => {}}
            onDetails={() => setDetails(shown)}
            into={{ draft, folder }}
          />
        )}
      </div>
      <div className="flex w-[172px] shrink-0 flex-col gap-2.5 overflow-y-auto px-1 pb-4">
        <span className="text-[11px] font-bold tracking-[0.08em] text-ink-3 uppercase">{draft ? "This draft" : title ?? "Here"} · {items.length}</span>
        {running && <LiveTile job={running} on={Boolean(live)} onClick={() => setPicked("live")} />}
        {waiting > 0 && (
          <span className="flex items-center justify-between gap-1 rounded-lg border border-dashed border-line-strong py-1 pr-1 pl-2 text-xs text-ink-2">
            {waiting} queued
            <button type="button" aria-label={`Remove the ${waiting} queued jobs from the queue`} data-tip="Remove from the queue" disabled={stop.isPending} onClick={() => stop.mutate(inLine.map((j) => j.id))} className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-hover hover:text-warn">
              <X size={13} />
            </button>
          </span>
        )}
        {/* the newer pages, let go past the cap (useAssets) */}
        {assets.hasPreviousPage && <Button size="sm" onClick={() => assets.fetchPreviousPage()} disabled={busy}>Newer</Button>}
        {items.map((a) => {
          const on = !live && shown?.id === a.id;
          return (
            // at its own shape (a portrait take stays portrait), with its name under it; the one shown large is marked
            <div key={a.id} className={cx("flex flex-col gap-1.5 rounded-[12px] p-1.5", on ? "bg-accent-wash shadow-[inset_0_0_0_1px_var(--color-accent)]" : "hover:shadow-[inset_0_0_0_1px_var(--color-line-strong)]")}>
              <div style={{ aspectRatio: shapeOf(a), width: `min(100%, ${Math.round(TILE_H * shapeOf(a))}px)` }} className="mx-auto">
                <Tile fill plain asset={a} onOpen={() => setPicked(a.id)} onMenu={(e) => tileMenu.open(e, a)} />
              </div>
              {/* what it is, under the picture: its name, then its clip and its length (or size) */}
              <span className="flex min-w-0 flex-col gap-1 px-0.5">
                <span className="truncate text-[12.5px] font-bold" data-tip={tileName(a)}>{tileName(a)}</span>
                <span className="flex min-w-0 items-center gap-1.5">
                  {/* in the accent, flush with the name above it */}
                  {a.clipOf && <span className="min-w-0 truncate text-[11px] font-semibold text-accent">Clip {a.clipOf.clip}{a.clipOf.takes > 1 ? ` · take ${a.clipOf.take}` : ""}</span>}
                  <span className="grow" />
                  <span className="shrink-0 font-mono text-[11px] text-ink-2">{a.durationMs !== null && a.kind !== "image" ? clock(a.durationMs, { decimals: 1 }) : a.width && a.height ? `${a.width}×${a.height}` : ""}</span>
                </span>
              </span>
            </div>
          );
        })}
        {assets.hasNextPage && <Button size="sm" onClick={() => assets.fetchNextPage()} disabled={busy}>More</Button>}
      </div>
      {details && <Viewer asset={items.find((a) => a.id === details.id) ?? details} items={items} onOpen={setDetails} onClose={() => setDetails(null)} into={{ draft, folder }} />}
      {tileMenu.element}
    </div>
  );
}

/** How tall a tile of the column gets at most: a portrait take is narrower, not taller. */
const TILE_H = 170;

/** A tile's own shape, width over height, kept between a tall portrait and a wide landscape (a sound: a wide strip). */
function shapeOf(a: Asset): number {
  if (a.kind === "audio" || !a.width || !a.height) return a.kind === "audio" ? 2 : 3 / 4;
  return Math.max(0.5, Math.min(2, a.width / a.height));
}

/** The draft has made nothing yet: one line, the key that generates, and the way to the rest of the folder. */
function NothingYet() {
  const set = useStudio((s) => s.set);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 rounded-xl bg-ground">
      <Images size={28} strokeWidth={1.5} className="text-ink-3" />
      <span className="text-[15px] font-semibold">Nothing made in this draft yet</span>
      <span className="flex items-center gap-1.5 text-ink-2">
        <Kbd>Ctrl</Kbd><Kbd>↵</Kbd> generates
        <span className="text-line-strong">·</span>
        <button type="button" onClick={() => set({ scope: "all" })} className="font-semibold text-accent hover:underline">Folder</button> shows the rest
      </span>
    </div>
  );
}
