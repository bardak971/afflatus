import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Images, Square, X } from "lucide-react";
import type { Asset } from "../../api";
import { useAssets, useFamilyName } from "../../data";
import { clock, phaseLabel, timeLeft, when } from "../../format";
import { Keys } from "../../Keys";
import { useStudio } from "../../store";
import { LivePreview, StageStrip } from "../../LivePreview";
import { useStop } from "../../ModelLoad";
import { Bar, Button, cx, Empty, ErrorNote } from "../../ui";
import { Viewer } from "../../viewer/LazyViewer";
import { useTileMenu } from "../../TileMenu";
import { Tile, tileName } from "../Library";
import { LiveTile } from "./LiveTile";
import { useQueueOf } from "./queueOf";
import { drawnIndices, stackBands, useHeld, useSpan } from "./virtual";

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
  list?: { items: Asset[]; hasNextPage: boolean; more(): void; hasPreviousPage: boolean; newer(): void; loading: boolean; ready: boolean; failed?: boolean };
  title?: string;
  /** What an empty `list` says, when it is empty because of the grouping rather than the place. */
  empty?: { title: string; body: string };
}) {
  // the scope's own list given: the draft's is not asked for
  const own = useAssets({ draft: draft ?? "__none__" }, !list, true);
  const items = list ? list.items : own.data?.pages.flatMap((p) => p.items) ?? [];
  const assets = list
    ? { isSuccess: list.ready, hasNextPage: list.hasNextPage, fetchNextPage: list.more, hasPreviousPage: list.hasPreviousPage, fetchPreviousPage: list.newer, isFetchingNextPage: list.loading, isFetchingPreviousPage: list.loading }
    : own;
  const busy = assets.isFetchingNextPage || assets.isFetchingPreviousPage;
  // the viewer's arrow past the last one loaded reads the next page
  const more = { has: Boolean(assets.hasNextPage), busy, load: () => void assets.fetchNextPage() };
  // the column's menu: the item's list, its keys shown (they act on the stage, on the item shown large)
  const tileMenu = useTileMenu({ onOpen: (a) => setPicked(a.id), into: { draft, folder }, place: "stage" });
  // a draft's stage shows its own renders forming; another scope's, whatever renders now. Only which job and
  // which are queued: the stage does not draw again at every step, the live parts read their progress themselves
  const ours = useQueueOf((q) => {
    const r = q.running;
    const mine = r && (draft ? r.draftId === draft : r.kind === "render");
    return { running: mine ? r.id : null, inLine: q.waiting.filter((j) => (draft ? j.draftId === draft : true)).map((j) => j.id) };
  });
  const running = ours?.running ?? null;
  const inLine = ours?.inLine ?? [];
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

  // the first page on its way, nothing forming to show instead: the stage and its column as placeholders, at their size
  const failed = list ? Boolean(list.failed) : own.isError;
  if (!assets.isSuccess && !failed && !items.length && !running && !waiting) return <StagePlaceholder title={draft ? "This draft" : title ?? "Here"} />;
  if (assets.isSuccess && !items.length && !running && !waiting) {
    if (!draft && empty) return <Empty title={empty.title} help={empty.body} />;
    if (!draft) return <Empty title="Nothing here yet" help="Nothing in this view. Another scope or folder may have what you are looking for." />;
    return <NothingYet />;
  }
  return (
    <div className="flex h-full min-h-0 gap-4">
      <div data-stage className="flex min-h-0 min-w-0 grow flex-col rounded-xl bg-stage p-[var(--stage-pad)]">
        {live && running && (
          <div className="flex min-h-0 grow flex-col items-center justify-center gap-3 pb-4">
            <LiveStage id={running} />
            <div className="flex w-72 flex-col items-center gap-1.5 text-center">
              <LiveProgress id={running} />
              {waiting > 0 && <span className="text-xs text-ink-2">{waiting} more queued</span>}
              <div className="flex flex-wrap justify-center gap-2 pt-1">
                <Button size="sm" onClick={() => stop.mutate([running])} disabled={stop.isPending} data-tip={waiting ? "Cancel this render. Nothing is saved; the next queued job starts." : "Cancel this render. Nothing is saved."}>
                  <Square size={11} fill="currentColor" /> Cancel render
                </Button>
                {waiting > 0 && (
                  <Button size="sm" onClick={() => stop.mutate([...inLine, running])} disabled={stop.isPending} data-tip="Cancel this render and remove the queued jobs from the queue.">
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
            more={more}
            onOpen={(a) => setPicked(a.id)}
            onClose={() => {}}
            onDetails={() => setDetails(shown)}
            into={{ draft, folder }}
          />
        )}
      </div>
      <div className="flex w-[172px] shrink-0 flex-col gap-2.5 overflow-y-auto px-1 pb-4">
        <span className="text-[11px] font-bold tracking-[0.08em] text-ink-3 uppercase">{draft ? "This draft" : title ?? "Here"} · {items.length}</span>
        {running && <RunningTile id={running} on={Boolean(live)} onClick={() => setPicked("live")} />}
        {waiting > 0 && (
          <span className="flex items-center justify-between gap-1 rounded-lg border border-dashed border-line-strong py-1 pr-1 pl-2 text-xs text-ink-2">
            {waiting} queued
            <button type="button" aria-label={`Remove the ${waiting} queued jobs from the queue`} data-tip="Remove from the queue" disabled={stop.isPending} onClick={() => stop.mutate(inLine)} className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-hover hover:text-warn">
              <X size={13} />
            </button>
          </span>
        )}
        {/* the newer pages, let go past the cap (useAssets) */}
        {assets.hasPreviousPage && <Button size="sm" onClick={() => assets.fetchPreviousPage()} disabled={busy}>Newer</Button>}
        <StripItems items={items} byModel={Boolean(draft)} shown={live ? undefined : shown?.id} onPick={(a) => setPicked(a.id)} onMenu={(e, a) => tileMenu.open(e, a)} />
        {assets.hasNextPage && <Button size="sm" onClick={() => assets.fetchNextPage()} disabled={busy}>More</Button>}
      </div>
      {details && <Viewer asset={items.find((a) => a.id === details.id) ?? details} items={items} more={more} onOpen={setDetails} onClose={() => setDetails(null)} into={{ draft, folder }} />}
      {tileMenu.element}
    </div>
  );
}

/** How far apart the results of the column are (its gap-2.5), and what one takes before it is measured. */
const STRIP_GAP = 10;
const STRIP_EXTRA = 52;
const STRIP_WIDTH = 152;

/**
 * The column's results, drawn only where they are seen (virtual.ts): it may hold every page of the library read in
 * the grid, thousands of items. Each one's height is known before it is drawn, from its shape and what the others
 * drawn measured (the caption and the padding), and measured again once drawn, so the column keeps its height and
 * nothing moves as results come and go.
 */
function StripItems({ items, byModel, shown, onPick, onMenu }: { items: Asset[]; byModel: boolean; shown: string | undefined; onPick(a: Asset): void; onMenu(e: React.MouseEvent, a: Asset): void }) {
  const list = useRef<HTMLDivElement>(null);
  // a draft tried on several models: each run of results of one model under its name, how many and when ("Krea 2 · 2 · now")
  const familyName = useFamilyName();
  const heads = useMemo(() => {
    const out = new Map<number, { model: string; rest: string }>();
    if (!byModel || new Set(items.map((a) => a.family ?? "")).size < 2) return out;
    for (let i = 0; i < items.length; ) {
      let j = i;
      while (j < items.length && (items[j]!.family ?? "") === (items[i]!.family ?? "")) j++;
      const f = items[i]!.family;
      out.set(i, { model: f ? familyName(f) : "Other", rest: `${j - i} · ${when(items[i]!.createdAt)}` });
      i = j;
    }
    return out;
  }, [byModel, items, familyName]);
  // the heights measured, by item; the room around a tile and the column's width, from the first one measured
  const measured = useRef(new Map<string, number>());
  const room = useRef({ extra: STRIP_EXTRA, width: STRIP_WIDTH });
  const [version, setVersion] = useState(0);
  const watch = useRef<ResizeObserver | null>(null);
  if (!watch.current && typeof ResizeObserver !== "undefined") {
    watch.current = new ResizeObserver((entries) => {
      let changed = false;
      for (const e of entries) {
        const el = e.target as HTMLElement;
        const id = el.dataset.itemId;
        if (!id) continue;
        const h = el.getBoundingClientRect().height;
        // the room around a tile, from one without a model's name over it
        const tile = el.dataset.head ? undefined : el.querySelector("[data-strip-tile]")?.getBoundingClientRect();
        if (tile && tile.height > 0) room.current = { extra: h - tile.height, width: el.clientWidth - 12 };
        if (Math.abs((measured.current.get(id) ?? -1) - h) > 0.5) {
          measured.current.set(id, h);
          changed = true;
        }
      }
      if (changed) setVersion((v) => v + 1);
    });
  }
  useEffect(() => () => watch.current?.disconnect(), []);
  const bands = useMemo(() => stackBands(items.map((a) => measured.current.get(a.id) ?? room.current.extra + Math.min(room.current.width, TILE_H * shapeOf(a)) / shapeOf(a)), STRIP_GAP), [items, version]); // eslint-disable-line react-hooks/exhaustive-deps -- the measures are read when they change (version)
  const span = useSpan(list, bands);
  const { held, handlers } = useHeld();
  const drawn = drawnIndices(bands.map((_, i) => ({ start: i, end: i + 1 })), span, held.map((id) => items.findIndex((a) => a.id === id)));
  const total = bands.length ? bands[bands.length - 1]!.bottom : 0;
  const first = drawn.length ? bands[drawn[0]!]!.top : 0;
  const last = drawn.length ? bands[drawn[drawn.length - 1]!]!.bottom : 0;
  const observe = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    watch.current?.observe(el);
    return () => watch.current?.unobserve(el);
  }, []);
  // the room of the results not drawn, above and below, as the list's padding; between those drawn, the column's gap
  return (
    <div ref={list} className="flex shrink-0 flex-col gap-2.5" style={{ paddingTop: first, paddingBottom: total - last }} {...handlers}>
      {drawn.map((i) => {
        const a = items[i]!;
        const on = shown === a.id;
        const head = heads.get(i);
        return (
          // measured with the model's name over it, when it starts a run of one model
          <div key={a.id} ref={observe} data-item-id={a.id} data-head={head ? "" : undefined} className="flex flex-col gap-1.5">
          {head && <span className={cx("truncate px-1.5 text-xs font-bold text-ink", i > 0 && "pt-1.5")}>{head.model} <span className="font-normal text-ink-3">· {head.rest}</span></span>}
          {/* at its own shape (a portrait take stays portrait), with its name under it; the one shown large is marked */}
          <div className={cx("flex flex-col gap-1.5 rounded-[12px] p-1.5", on ? "bg-accent-wash shadow-[inset_0_0_0_1px_var(--color-accent)]" : "hover:shadow-[inset_0_0_0_1px_var(--color-line-strong)]")}>
            <div data-strip-tile style={{ aspectRatio: shapeOf(a), width: `min(100%, ${Math.round(TILE_H * shapeOf(a))}px)` }} className="mx-auto">
              <Tile fill plain asset={a} onOpen={() => onPick(a)} onMenu={(e) => onMenu(e, a)} />
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
          </div>
        );
      })}
    </div>
  );
}

/** The running job, read on its own: what shows it draws again at every step, not the stage around it. */
const useRunning = (id: string) => useQueueOf((q) => (q.running?.id === id ? q.running : null)) ?? null;

function LiveStage({ id }: { id: string }) {
  const job = useRunning(id);
  if (!job) return null;
  return (
    <>
      <LivePreview job={job} sound className="h-[calc(100%-70px)] min-h-0 w-auto max-w-full rounded-lg object-contain" />
      <StageStrip job={job} className="flex max-w-full gap-2 overflow-x-auto" />
    </>
  );
}

function LiveProgress({ id }: { id: string }) {
  const job = useRunning(id);
  if (!job) return null;
  return (
    <>
      <span className="font-semibold">{phaseLabel(job.phase)}{job.steps ? ` · step ${job.step} of ${job.steps}` : ""}{job.eta ? ` · ${timeLeft(job.eta)}` : ""}</span>
      <div className="w-full"><Bar value={job.progress * 100} /></div>
    </>
  );
}

function RunningTile({ id, ...rest }: { id: string; on: boolean; onClick(): void }) {
  const job = useRunning(id);
  return job ? <LiveTile job={job} {...rest} /> : null;
}

/**
 * The stage before its list has come: the large place and the column of results laid out as they will be, each a
 * placeholder with the loading shine, the count a dash until it is known (never a "0" that reads as empty).
 */
function StagePlaceholder({ title }: { title: string }) {
  return (
    <div aria-busy="true" aria-label="Loading" className="flex h-full min-h-0 gap-4">
      <div data-stage className="flex min-h-0 min-w-0 grow flex-col rounded-xl bg-stage p-[var(--stage-pad)]">
        <div className="m-skeleton min-h-0 grow" />
      </div>
      <div className="flex w-[172px] shrink-0 flex-col gap-2.5 overflow-hidden px-1 pb-4">
        <span className="text-[11px] font-bold tracking-[0.08em] text-ink-3 uppercase">{title} · <span className="font-mono">–</span></span>
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex flex-col gap-1.5 rounded-[12px] p-1.5">
            <div style={{ aspectRatio: PLACEHOLDER_SHAPE, width: `min(100%, ${Math.round(TILE_H * PLACEHOLDER_SHAPE)}px)` }} className="m-skeleton mx-auto rounded-md!" />
            {/* the two lines under a result, at their own line heights */}
            <span className="flex min-w-0 flex-col gap-1 px-0.5">
              <span className="text-[12.5px]"><span className="m-skeleton inline-block h-[0.8em] w-3/4 align-middle" /></span>
              <span className="text-[11px]"><span className="m-skeleton inline-block h-[0.8em] w-1/3 align-middle" /></span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The shape of a placeholder result in the column: a landscape take, the usual one. */
const PLACEHOLDER_SHAPE = 4 / 3;

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
        <Keys keys="Ctrl+Enter" size="sm" /> generates
        <span className="text-line-strong">·</span>
        <button type="button" onClick={() => set({ scope: "all" })} className="font-semibold text-accent hover:underline">Folder</button> shows the rest
      </span>
    </div>
  );
}
