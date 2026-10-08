import { useState } from "react";
import { Film, Music, Play, VolumeX } from "lucide-react";
import { HoverAudio, HoverVideo } from "../HoverVideo";
import { TileTip, useTileTip } from "../TileTip";
import type { Asset } from "../api";
import { clock, left as timeLeft } from "../format";
import { DRAG_HAS_SOUND, DRAG_TYPE, dragKind } from "../dragging";
import { cx } from "../ui";

/** The pieces of the library that several screens use: a tile, what dragging one carries, and the folders. The screen itself is Studio. */

/** A result nobody kept goes to the bin a day after its countdown started (when it was made, or when it was unkept or put back): how long it has left. */
const UNKEPT_MS = 24 * 60 * 60_000;
const left = (asset: Asset) => timeLeft(new Date(asset.countdownFrom ?? asset.createdAt).getTime() + UNKEPT_MS - Date.now());

export type { Place } from "../store";
export { FolderPanel } from "./library/FolderPanel";

export { DRAG_PICTURE, DRAG_SOUND, DRAG_TYPE, DRAG_VIDEO, dragKind } from "../dragging";

export function Tile({ asset, onOpen, selected, selecting, onSelect, dragIds, onMenu }: {
  asset: Asset;
  onOpen(): void;
  /** It is one of the items ticked; and whether any is: a click then ticks instead of opening. */
  selected?: boolean;
  selecting?: boolean;
  /** Tick or untick it. With the Shift key held: everything from the last one ticked to this one. */
  onSelect?(range: boolean): void;
  /** What a drag of it carries: every ticked item when it is one of them. */
  dragIds?: string[];
  /** A right-click: the menu of what can be done with it. */
  onMenu?(e: React.MouseEvent): void;
}) {
  // a video has a preview frame when the server could read one from it
  const [noFrame, setNoFrame] = useState(false);
  // the tooltip, after the pointer has rested on the tile; gone as soon as it moves off or presses
  const tip = useTileTip();
  return (
    <div className="group relative select-none">
    {tip.tip && <TileTip asset={asset} at={tip.tip} />}
    <button
      type="button"
      draggable
      {...tip.props}
      aria-pressed={onSelect ? Boolean(selected) : undefined}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, (dragIds ?? [asset.id]).join(","));
        e.dataTransfer.setData(dragKind(asset.kind), asset.id);
        if (asset.kind === "video" && asset.hasSound) e.dataTransfer.setData(DRAG_HAS_SOUND, asset.id);
        e.dataTransfer.effectAllowed = "copyMove";
      }}
      onClick={(e) => {
        // with something ticked, or with Ctrl or Shift held, a click ticks; otherwise it opens
        if (onSelect && (selecting || e.ctrlKey || e.metaKey || e.shiftKey)) onSelect(e.shiftKey);
        else onOpen();
      }}
      aria-label={`Open ${asset.name || asset.kind}`}
      onContextMenu={onMenu}
      data-stage
      className={cx("relative block w-full select-none aspect-[3/4] overflow-hidden rounded-[10px] border bg-panel", selected ? "border-2 border-accent" : "border-line")}
    >
      {asset.kind === "image" || (asset.kind === "video" && !noFrame) ? (
        <HoverVideo asset={asset.id} video={asset.kind === "video"} onNoFrame={() => setNoFrame(true)} />
      ) : asset.kind === "audio" ? (
        <HoverAudio asset={asset.id} />
      ) : (
        <span className="flex h-full flex-col items-center justify-center gap-1.5 text-ink-2">
          <Play size={20} />
          Video
        </span>
      )}
      {asset.kind === "audio" && asset.durationMs ? (
        <span className="absolute bottom-3 left-2 flex items-center gap-1.5 rounded-md bg-ground/80 px-1.5 py-0.5 text-[11px] font-semibold">
          <Music size={10} />
          {clock(asset.durationMs)}
        </span>
      ) : null}
      {asset.kind === "video" && (
        <span className="absolute bottom-2 left-2 flex items-center gap-1.5 rounded-md bg-ground/80 px-1.5 py-0.5 text-[11px] font-semibold">
          <Play size={10} fill="currentColor" />
          {asset.durationMs ? clock(asset.durationMs) : "Video"}
          {asset.durationMs !== null && !asset.hasSound && <VolumeX size={11} aria-label="No audio" className="text-ink-2" />}
        </span>
      )}
      {!asset.kept && !asset.inBin && (
        <span title="Goes to the bin then unless you keep it." className="absolute top-2 right-2 rounded-full bg-warn px-2 py-0.5 text-[10px] font-bold text-warn-on">{left(asset)}</span>
      )}
      {asset.clipOf && <ClipMark of={asset.clipOf} className="absolute right-2 bottom-2" />}
    </button>
    {/* the tick sits over the tile, beside the button rather than inside it: a button holds no other control */}
    {onSelect && (
      <span
        role="checkbox"
        tabIndex={0}
        aria-checked={Boolean(selected)}
        aria-label="Select, to move, keep or delete several at once"
        title="Select (also Ctrl + click; Shift + click selects the range)"
        onClick={(e) => onSelect(e.shiftKey)}
        onKeyDown={(e) => {
          if (e.key !== " " && e.key !== "Enter") return;
          e.preventDefault();
          onSelect(e.shiftKey);
        }}
        className={cx(
          "absolute top-2 left-2 z-10 flex h-5 w-5 cursor-pointer items-center justify-center rounded-full border-[1.5px] text-[11px] font-bold",
          selected ? "border-accent bg-accent text-accent-ink" : "border-white/80 bg-ground/60 text-transparent",
          !selected && !selecting && "opacity-0 group-hover:opacity-100 focus:opacity-100",
        )}
      >
        ✓
      </span>
    )}
    </div>
  );
}

/** On a video that is a take of a timeline clip: the clip's number, the rest on hover. */
function ClipMark({ of, className }: { of: NonNullable<Asset["clipOf"]>; className?: string }) {
  const what = `${of.timelineName}: clip ${of.clip}${of.takes > 1 ? `, take ${of.take} of ${of.takes}` : ""}${of.playing ? " (the one playing)" : of.takes > 1 ? " (not the one playing)" : ""}${of.upscaledBy ? `, upscaled${of.upscaledBy !== 1 ? ` ×${of.upscaledBy}` : ""}` : ""}`;
  return (
    <span title={what} aria-label={what} className={cx("flex items-center gap-1 rounded-md bg-ground/80 px-1.5 py-0.5 text-[10px] font-semibold", of.playing || of.takes === 1 ? "text-accent" : "text-ink-2", className)}>
      <Film size={11} />
      Clip {of.clip}
      {of.takes > 1 && <span className="font-normal text-ink-2">· take {of.take}/{of.takes}</span>}
    </span>
  );
}
