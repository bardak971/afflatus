import { Star } from "lucide-react";
import { thumbUrl, type Asset } from "../api";
import { plural } from "../format";
import { Kbd } from "../Keys";
import { Thumb } from "../Thumb";
import { Button, cx } from "../ui";
import { useQueueOf } from "../screens/studio/queueOf";
import { LiveTile } from "../screens/studio/LiveTile";
import type { Versions } from "./useVersions";

/** How wide a tile of the strip is (px): the mock's 76, the picture's shape below it. */
const TILE_W = 76;

/** Which version a step of ← → lands on, from the one shown: null past either end (the arrows then go to the next item). */
export function stepVersion(all: readonly Asset[], shown: string, by: -1 | 1): Asset | null {
  const at = all.findIndex((a) => a.id === shown);
  return at < 0 ? null : all[at + by] ?? null;
}

/** What Keep says for the one shown: the original by name, a version by its number. */
export const keepLabel = (all: readonly Asset[], shown: string) => {
  const at = all.findIndex((a) => a.id === shown);
  return at <= 0 ? "Keep the original" : `Keep ${at}`;
};

/**
 * The versions of the picture, under it (the mock's variant A): the original as 0, each version made in place, the
 * jobs still making more as live tiles. A click shows one large, ← → step through them, K keeps the one shown (the
 * others count down to the bin), Ctrl or Shift and a click puts a second one beside it in Compare.
 */
export function VersionStrip({ versions, shown, onShow, onCompare }: {
  versions: Versions;
  /** The id of the one shown large. */
  shown: string;
  onShow(a: Asset): void;
  /** The one shown and the one Ctrl- or Shift-clicked, side by side. */
  onCompare(other: Asset): void;
}) {
  const { all, running, waiting, keep, keepAll } = versions;
  const busy = keep.isPending || keepAll.isPending;
  const made = all.length - 1;
  return (
    <div role="group" aria-label="Versions" className="flex max-w-full shrink-0 items-center gap-2 overflow-x-auto px-1 pb-1">
      <span className="shrink-0 text-xs text-ink-2">Versions</span>
      {all.map((a, i) => (
        <button
          key={a.id}
          type="button"
          aria-pressed={a.id === shown}
          aria-label={i === 0 ? "The original" : `Version ${i}`}
          data-tip={a.id === shown ? undefined : "Click: show it · Ctrl or Shift+click: compare it with the one shown"}
          onClick={(e) => (e.ctrlKey || e.metaKey || e.shiftKey ? a.id !== shown && onCompare(a) : onShow(a))}
          style={{ width: TILE_W, aspectRatio: a.width && a.height ? `${a.width} / ${a.height}` : "1" }}
          className={cx("relative shrink-0 overflow-hidden rounded-lg border-2 bg-raised", a.id === shown ? "border-accent" : "border-transparent hover:border-line-strong")}
        >
          <Thumb src={thumbUrl(a.id)} alt="" sizes={`${TILE_W}px`} className="h-full w-full object-cover" />
          <span className="absolute top-0.5 left-0.5 rounded bg-ground/80 px-1 text-micro font-bold text-ink">{i === 0 ? "Original" : i}</span>
        </button>
      ))}
      {running.map((id) => <RunningVersion key={id} id={id} />)}
      {waiting > 0 && <span className="shrink-0 rounded-lg border border-dashed border-line-strong px-2 py-1 text-xs text-ink-2">{waiting} queued</span>}
      {made > 0 && <span className="shrink-0 text-xs text-ink-3">← →</span>}
      {made > 0 && (
        <Button size="sm" tone="primary" disabled={busy} onClick={() => keep.mutate(shown)} data-tip={all[0]?.id === shown ? "Keep the original as it is: the versions count down to the bin" : "This version becomes the picture: the original and the other versions count down to the bin"} className="shrink-0">
          <Star size={13} /> {keepLabel(all, shown)} <Kbd>K</Kbd>
        </Button>
      )}
      {made > 0 && (
        <Button size="sm" disabled={busy} onClick={() => keepAll.mutate()} data-tip={`The ${plural(made, "version")} kept as pictures of their own, beside the original`} className="shrink-0">
          Keep all as pictures
        </Button>
      )}
    </div>
  );
}

/** A version on its way: its live preview and its Stop, at the strip's size. */
function RunningVersion({ id }: { id: string }) {
  const job = useQueueOf((q) => [q.running, ...(q.machines ?? []).map((m) => m.running)].find((j) => j?.id === id) ?? null);
  return job ? <div style={{ width: TILE_W }} className="shrink-0"><LiveTile job={job} title="A version on its way" /></div> : null;
}
