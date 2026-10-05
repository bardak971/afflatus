import { useEffect, useState } from "react";
import { Square, X } from "lucide-react";
import type { Asset } from "../../api";
import { useAssets, useQueue } from "../../data";
import { about, phaseLabel } from "../../format";
import { LivePreview } from "../../LivePreview";
import { useStop } from "../../ModelLoad";
import { Bar, Button, cx, Empty, ErrorNote } from "../../ui";
import { Viewer } from "../../Viewer";
import { useTileMenu } from "../../TileMenu";
import { Tile } from "../Library";
import { LiveTile } from "./LiveTile";

/**
 * What the draft in the form has made: the newest result large, with what can be done with it under
 * it, and the earlier ones as a strip to go back to. While the draft renders, what is forming is shown
 * large instead, until one of the results is picked.
 */
export function DraftResults({ draft, folder }: { draft: string; folder: string | undefined }) {
  const assets = useAssets({ draft });
  const queue = useQueue();
  const items = assets.data?.pages.flatMap((p) => p.items) ?? [];
  const tileMenu = useTileMenu({ onOpen: (a) => setPicked(a.id), into: { draft, folder } });
  const running = queue.data?.running?.draftId === draft ? queue.data.running : null;
  const inLine = (queue.data?.waiting ?? []).filter((j) => j.draftId === draft);
  const waiting = inLine.length;
  const stop = useStop();
  // what is shown large: the one that was picked, else what is forming, else the newest
  const [picked, setPicked] = useState<string | "live" | null>(null);
  const [details, setDetails] = useState<Asset | null>(null);
  // a new result takes the large place: the pick is forgotten when the list gets a new first item
  const newest = items[0]?.id;
  useEffect(() => setPicked(null), [newest, draft]);
  const chosen = picked && picked !== "live" ? items.find((a) => a.id === picked) : undefined;
  const live = running && (picked === "live" || !chosen);
  const shown = chosen ?? (live ? undefined : items[0]);

  if (assets.isSuccess && !items.length && !running && !waiting) {
    return <Empty title="No output from this draft yet">Write a prompt in the form and press Generate. This draft's outputs show here, the newest one large. "Whole folder" shows everything in the folder.</Empty>;
  }
  return (
    <div className="flex h-full min-h-0 gap-4">
      <div data-stage className="flex min-h-0 min-w-0 grow flex-col rounded-xl bg-ground p-[var(--stage-pad)]">
        {live && running && (
          <div className="flex min-h-0 grow flex-col items-center justify-center gap-3 pb-4">
            <LivePreview job={running} sound className="h-[calc(100%-70px)] min-h-0 w-auto max-w-full rounded-lg object-contain" />
            <div className="flex w-72 flex-col items-center gap-1.5 text-center">
              <span className="font-semibold">{phaseLabel(running.phase)}{running.steps ? ` · step ${running.step} of ${running.steps}` : ""}{running.eta ? ` · ${about(running.eta)}` : ""}</span>
              <div className="w-full"><Bar value={running.progress * 100} /></div>
              {waiting > 0 && <span className="text-xs text-ink-2">{waiting} more queued</span>}
              <div className="flex flex-wrap justify-center gap-2 pt-1">
                <Button size="sm" onClick={() => stop.mutate([running.id])} disabled={stop.isPending} title={waiting ? "Cancel this render. Nothing is saved; the next queued job starts." : "Cancel this render. Nothing is saved."}>
                  <Square size={11} fill="currentColor" /> Cancel render
                </Button>
                {waiting > 0 && (
                  <Button size="sm" onClick={() => stop.mutate([...inLine.map((j) => j.id), running.id])} disabled={stop.isPending} title="Cancel this render and remove the queued jobs from the queue.">
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
      <div className="flex w-[140px] shrink-0 flex-col gap-2.5 overflow-y-auto px-1 pb-4">
        <span className="text-[11px] font-bold tracking-[0.08em] text-ink-2 uppercase">This draft · {items.length}</span>
        {running && <LiveTile job={running} on={Boolean(live)} onClick={() => setPicked("live")} />}
        {waiting > 0 && (
          <span className="flex items-center justify-between gap-1 rounded-lg border border-dashed border-line-strong py-1 pr-1 pl-2 text-xs text-ink-2">
            {waiting} queued
            <button type="button" aria-label={`Remove the ${waiting} queued jobs from the queue`} title="Remove from the queue" disabled={stop.isPending} onClick={() => stop.mutate(inLine.map((j) => j.id))} className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-hover hover:text-warn">
              <X size={13} />
            </button>
          </span>
        )}
        {items.map((a) => (
          <div key={a.id} className={cx("rounded-[12px] border-2", !live && shown?.id === a.id ? "border-accent" : "border-transparent")}>
            <Tile asset={a} onOpen={() => setPicked(a.id)} onMenu={(e) => tileMenu.open(e, a)} />
          </div>
        ))}
        {assets.hasNextPage && <Button size="sm" onClick={() => assets.fetchNextPage()} disabled={assets.isFetchingNextPage}>More</Button>}
      </div>
      {details && <Viewer asset={items.find((a) => a.id === details.id) ?? details} items={items} onOpen={setDetails} onClose={() => setDetails(null)} into={{ draft, folder }} />}
      {tileMenu.element}
    </div>
  );
}
