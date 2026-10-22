import { memo, useState, type ReactNode } from "react";
import { Check, Clock, FileX2, Film, Play, VolumeX } from "lucide-react";
import { HoverAudio, HoverVideo } from "../HoverVideo";
import { TileTip, useTileTip } from "../TileTip";
import type { Asset } from "../api";
import { clock, leftWords, when } from "../format";
import { DRAG_HAS_SOUND, DRAG_TYPE, dragKind } from "../dragging";
import { useHoverPlay } from "../store";
import { cx } from "../ui";
import { leftOf, SOON_MS } from "./library/justify";
import { unkeptMs, useKeepFor } from "../keepFor";
import { KIND_WORD, tileName } from "./library/tileName";
import { SoundWave } from "./library/SoundWave";

/** The pieces of the library that several screens use: a tile, what dragging one carries, and the folders. The screen itself is Studio. */

export type { Place } from "../store";
export { FolderPanel } from "./library/FolderPanel";

export { DRAG_PICTURE, DRAG_SOUND, DRAG_TYPE, DRAG_VIDEO } from "../dragging";

// what a tile is called, in a file of its own: the viewer and the menus name items without loading the library
export { tileName } from "./library/tileName";

/** The dim line under a tile's name: "picture · 1536×864 · 40 min ago · kept". */
function tileFacts(a: Asset): string {
  return [
    KIND_WORD[a.kind],
    a.width && a.height ? `${a.width}×${a.height}` : "",
    a.kind === "video" && a.durationMs !== null && !a.hasSound ? "silent" : "",
    a.clipOf ? `clip ${a.clipOf.clip}${a.clipOf.takes > 1 ? `, take ${a.clipOf.take}/${a.clipOf.takes}` : ""}` : "",
    when(a.createdAt),
    a.kept ? "kept" : "",
  ].filter(Boolean).join(" · ");
}

/** Why a linked file shows no picture, for its tile's tip. */
const missingTip = (a: Asset) => `${a.path ?? a.name} is not in its folder on the disk any more: moved, renamed or deleted. It is kept because a timeline or the Prompt kit uses it. Put the file back, or press Look again on its folder.`;

/**
 * One item of a grid. Drawn again only when what it is handed changes: a grid hands every tile the same callbacks, each
 * told which item it is for, so ticking one item, or a page arriving, does not draw the hundreds of others again.
 */
export const Tile = memo(function Tile({ asset, onOpen, selected, selecting, onSelect, dragIds, onMenu, fill, corner, plain }: {
  asset: Asset;
  onOpen(asset: Asset): void;
  /** It is one of the items ticked; and whether any is: a click then ticks instead of opening. */
  selected?: boolean;
  selecting?: boolean;
  /** Tick or untick it. With the Shift key held: everything from the last one ticked to this one. */
  onSelect?(range: boolean, asset: Asset): void;
  /** What a drag of it carries: every ticked item when it is one of them. */
  dragIds?: string[];
  /** A right-click: the menu of what can be done with it. */
  onMenu?(e: React.MouseEvent, asset: Asset): void;
  /** It fills the box it is put in (the library's justified rows size it at the item's own shape); else it is a 3:4 card. */
  fill?: boolean;
  /** A control for its top-right corner, beside the not-kept clock (a stack's "3 takes" button). */
  corner?: ReactNode;
  /** Nothing written over the picture (its length, its clip, its name on hover, the hover card): what it is is said under it (the draft's results column). */
  plain?: boolean;
}) {
  // a video has a preview frame when the server could read one from it
  const [noFrame, setNoFrame] = useState(false);
  // the tooltip, after the pointer has rested on the tile; gone as soon as it moves, leaves or presses
  const tip = useTileTip();
  // the pointer's place along a video or a sound (0 to 1): a video scrubs to it, a sound plays from it; null off the tile
  const [at, setAt] = useState<number | null>(null);
  const [playing, setPlaying] = useState<null | { muted: boolean }>(null);
  const hoverVideo = useHoverPlay((s) => s.video);
  const follows = !asset.missing && (asset.kind === "audio" || (asset.kind === "video" && !noFrame && hoverVideo));
  const track = (e: React.PointerEvent<HTMLElement>) => {
    if (!follows || e.pointerType !== "mouse") return;
    const r = e.currentTarget.getBoundingClientRect();
    setAt(Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width))));
  };
  const name = tileName(asset);
  const length = asset.durationMs ? clock(asset.durationMs, { decimals: asset.kind === "video" ? 1 : 0 }) : "";
  // over a video that scrubs: the time under the pointer leads the facts
  const facts = asset.kind === "video" && at !== null && asset.durationMs ? `${((at * asset.durationMs) / 1000).toFixed(1)} s of ${length} · ${tileFacts(asset)}` : tileFacts(asset);
  // expiring (nobody kept it): a small clock in the corner, in the warning colour in its last hours, the exact time in
  // its tip; the status bar's expiring chip says the rest
  // (read here so that a change of the days in Settings › Storage draws the clocks again)
  const unkeptDays = useKeepFor((s) => s.unkeptDays);
  const ms = !asset.kept && !asset.inBin ? leftOf(asset, Date.now(), unkeptMs(unkeptDays)) : null;
  const clockMark = ms !== null && (
    <span data-tip={`Expires in ${leftWords(ms)} · S keeps it`} aria-label={`Expires in ${leftWords(ms)}`} className={cx("flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ground/60", ms < SOON_MS ? "text-warn" : "text-ink-2")}>
      <Clock size={11} strokeWidth={2.6} />
    </span>
  );
  const sound = asset.kind === "audio";
  return (
    <div className={cx("group relative select-none", fill && "h-full")}>
    {tip.tip && !plain && <TileTip asset={asset} at={tip.tip} />}
    <button
      type="button"
      draggable
      onPointerEnter={(e) => { tip.props.onPointerEnter(e); track(e); }}
      onPointerMove={(e) => { tip.props.onPointerMove(e); track(e); }}
      onPointerLeave={() => { tip.props.onPointerLeave(); setAt(null); }}
      onPointerDown={tip.props.onPointerDown}
      aria-pressed={onSelect ? Boolean(selected) : undefined}
      onDragStart={(e) => {
        setAt(null);
        e.dataTransfer.setData(DRAG_TYPE, (dragIds ?? [asset.id]).join(","));
        e.dataTransfer.setData(dragKind(asset.kind), asset.id);
        if (asset.kind === "video" && asset.hasSound) e.dataTransfer.setData(DRAG_HAS_SOUND, asset.id);
        e.dataTransfer.effectAllowed = "copyMove";
      }}
      onClick={(e) => {
        // with something ticked, or with Ctrl or Shift held, a click ticks; otherwise it opens
        if (onSelect && (selecting || e.ctrlKey || e.metaKey || e.shiftKey)) onSelect(e.shiftKey, asset);
        else onOpen(asset);
      }}
      aria-label={`Open ${name}`}
      onContextMenu={onMenu && ((e) => onMenu(e, asset))}
      data-stage
      className={cx(
        // a container: what sits on the tile (its clip and take) says less on a narrow one
        "@container/tile relative block w-full select-none overflow-hidden bg-panel outline-none focus-visible:ring-2 focus-visible:ring-accent",
        // in the draft's column it sits 6px inside a 12px card: its corner is the card's less that gap
        plain ? "rounded-md" : "rounded-xl",
        // in the draft's results column the card around it marks the hover: a ring of its own drew a second border inside it
        !plain && "hover:ring-2 hover:ring-accent",
        fill ? "h-full" : "aspect-[3/4]",
        selected && "ring-2 ring-accent",
      )}
    >
      {asset.missing ? (
        // a linked file gone from its folder but kept (a timeline or the Prompt kit uses it): said so, rather than a picture
        // that never comes
        <span className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-panel px-3 text-center text-ink-2" data-tip={missingTip(asset)}>
          <FileX2 size={22} className="text-warn" />
          <span className="text-body font-bold text-ink">Missing on disk</span>
          <span className="w-full truncate text-meta">{name}</span>
        </span>
      ) : sound ? (
        // a sound: its card, the waveform lit up to the pointer; it plays from there (Settings → Appearance allowing)
        <span className="absolute inset-0 flex flex-col gap-2 bg-gradient-to-br from-accent-wash to-panel px-3.5 py-3 text-left">
          <span className="flex min-w-0 items-center gap-2">
            <span className={cx("flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full text-ground", at !== null ? "bg-accent" : "bg-ink-2")}>
              <Play size={10} fill="currentColor" strokeWidth={0} className="ml-px" />
            </span>
            <span className="min-w-0 grow truncate text-body font-bold">{name}</span>
            {length && <span className="shrink-0 font-mono text-meta text-ink-2">{length}</span>}
            {clockMark}
          </span>
          <SoundWave asset={asset.id} at={at} className="relative min-h-3 grow" />
          <span className={cx("truncate text-meta text-ink-2", onSelect && "pr-6")}>{tileFacts(asset)}</span>
          <HoverAudio asset={asset.id} at={at} />
        </span>
      ) : asset.kind === "image" || (asset.kind === "video" && !noFrame) ? (
        <HoverVideo
          asset={asset.id}
          video={asset.kind === "video"}
          shaped={fill}
          at={asset.kind === "video" ? at : undefined}
          onNoFrame={() => setNoFrame(true)}
          onPlaying={(on, muted) => setPlaying(on ? { muted } : null)}
        />
      ) : (
        <span className="flex h-full flex-col items-center justify-center gap-1.5 text-ink-2">
          <Play size={20} />
          Video
        </span>
      )}
      {asset.kind === "video" && !plain && (
        // its length, or while it plays on hover that it does (and whether muted); clear of the tick when the tick shows
        <span className={cx("absolute top-2 flex max-w-[calc(100%-1rem)] items-center gap-1.5 overflow-hidden rounded-md bg-ground/75 px-1.5 py-0.5 text-micro whitespace-nowrap transition-[left] duration-100", onSelect ? (selecting ? "left-9" : "left-2 group-hover:left-9") : "left-2")}>
          {playing ? (
            <>
              <span className="h-1.5 w-1.5 rounded-full bg-accent" />
              {playing.muted ? "playing, muted" : "playing"}
            </>
          ) : (
            <>
              <span className="font-mono">{length || "Video"}</span>
              {asset.durationMs !== null && !asset.hasSound && <VolumeX size={11} aria-label="No audio" className="text-ink-2" />}
            </>
          )}
        </span>
      )}
      {!sound && !plain && (
        // on hover: its name and a dim line of facts; out of the way while the fuller tip shows
        <span className={cx("pointer-events-none absolute inset-x-0 bottom-0 flex flex-col gap-px bg-gradient-to-b from-transparent to-ground/90 px-2.5 pt-6 pb-2 text-left opacity-0 transition-opacity duration-100 group-hover:opacity-100 group-focus-within:opacity-100", tip.tip && "!opacity-0")}>
          <span className="truncate text-body font-bold text-ink">{name}</span>
          <span className="truncate text-meta text-ink-2">{facts}</span>
        </span>
      )}
      {asset.kind === "video" && at !== null && <span aria-hidden className="absolute bottom-0 left-0 z-2 h-[3px] bg-accent" style={{ width: `${at * 100}%` }} />}
      {asset.clipOf && !sound && !plain && <ClipMark of={asset.clipOf} className="absolute right-2 bottom-2 transition-opacity group-hover:opacity-0" />}
    </button>
    {/* the corner's control and the clock sit over the tile, beside the button (a button holds no other control); clicks through the clock open the tile */}
    {((!sound && clockMark) || corner) && <span className="pointer-events-none absolute top-2 right-2 z-10 flex items-center gap-1 [&>button]:pointer-events-auto">{corner}{!sound && clockMark}</span>}
    {/* the tick sits over the tile, beside the button rather than inside it: a button holds no other control */}
    {onSelect && (
      <span
        role="checkbox"
        tabIndex={0}
        aria-checked={Boolean(selected)}
        aria-label="Select, to move, keep or delete several at once"
        data-tip="Select (also Ctrl + click; Shift + click selects the range)"
        onClick={(e) => onSelect(e.shiftKey, asset)}
        onKeyDown={(e) => {
          if (e.key !== " " && e.key !== "Enter") return;
          e.preventDefault();
          onSelect(e.shiftKey, asset);
        }}
        className={cx(
          // a sound's card has its play dot top-left: its tick sits bottom-right
          "absolute z-10 flex h-[18px] w-[18px] cursor-pointer items-center justify-center rounded-md transition-colors",
          sound ? "right-2 bottom-2" : "top-2 left-2",
          selected ? "bg-accent text-accent-ink" : "border-[1.5px] border-white/80 bg-ground/60",
          !selected && !selecting && "opacity-0 group-hover:opacity-100 focus:opacity-100",
        )}
      >
        {selected && <Check size={12} strokeWidth={3.5} />}
      </span>
    )}
    </div>
  );
});

/** On a video that is a take of a timeline clip: the clip's number ("c1 · t12" on a narrow tile, cut to nothing otherwise), the rest in its tip. */
function ClipMark({ of, className }: { of: NonNullable<Asset["clipOf"]>; className?: string }) {
  const what = `${of.timelineName}: clip ${of.clip}${of.takes > 1 ? `, take ${of.take} of ${of.takes}` : ""}${of.playing ? " (the one playing)" : of.takes > 1 ? " (not the one playing)" : ""}${of.upscaledBy ? `, upscaled${of.upscaledBy !== 1 ? ` ×${of.upscaledBy}` : ""}` : ""}`;
  return (
    <span data-tip={what} aria-label={what} className={cx("flex max-w-[calc(100%-1rem)] items-center gap-1 overflow-hidden rounded-md bg-ground/80 px-1.5 py-0.5 text-micro font-semibold whitespace-nowrap", of.playing || of.takes === 1 ? "text-accent" : "text-ink-2", className)}>
      <Film size={11} className="shrink-0" />
      <span className="hidden @min-[10rem]/tile:inline">Clip {of.clip}</span>
      {of.takes > 1 && <span className="hidden font-normal text-ink-2 @min-[10rem]/tile:inline">· take {of.take}/{of.takes}</span>}
      <span className="@min-[10rem]/tile:hidden">c{of.clip}{of.takes > 1 && <span className="font-normal text-ink-2"> · t{of.take}</span>}</span>
    </span>
  );
}
