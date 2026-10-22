import { Magnet } from "lucide-react";
import type { Clip } from "../api";
import type { MenuItem } from "../ContextMenu";
import { Button, CloseButton, IconButton } from "../ui";
import { stamp, type TimeRange } from "./model";

/** The range bar's words for its actions: the menu says them in full. */
const SHORT: Record<string, string> = { "Play range": "Play", "Loop: on": "Loop", "Loop: off": "Loop", "Regenerate range": "Regenerate", "Insert a clip here": "Insert clip", "Split at In and Out": "Split at In / Out", "Remove range": "Remove", "Copy to library": "Copy", "Slow motion ×2": "Slow ×2", "Slow motion ×4": "Slow ×4" };

/** The bar under the video while a range is set: In and Out, what they span, the magnet, and the range's actions as buttons. */
export function RangeBar({ range, emptyRange, clips, snapQuiet, onSnapQuiet, items }: {
  range: TimeRange;
  emptyRange: boolean;
  clips: Clip[];
  snapQuiet: boolean;
  onSnapQuiet(): void;
  /** What can be done with the range, as the menu lists it. */
  items: MenuItem[];
}) {
  const spanned = clips.filter((c) => c.lengthMs > 0 && c.atMs < Math.max(range.outMs, range.inMs + 1) && c.atMs + c.lengthMs > range.inMs).map((c) => clips.indexOf(c) + 1);
  const where = emptyRange ? "a cut" : spanned.length <= 1 ? `clip ${spanned[0] ?? "?"}` : `clips ${spanned[0]}–${spanned.at(-1)}`;
  return (
    <div role="toolbar" aria-label="Range" className="flex h-10 shrink-0 items-center gap-1.5 overflow-hidden border-t border-line bg-accent-wash/40 px-3 text-sm whitespace-nowrap">
      <span className="shrink-0 font-semibold text-accent">Range</span>
      <span className="shrink-0 font-mono">{stamp(range.inMs)} <span className="text-ink-3">→</span> {stamp(range.outMs)}</span>
      <span className="min-w-0 truncate text-ink-2">· {emptyRange ? "" : `${((range.outMs - range.inMs) / 1000).toFixed(1)} s · `}{where}</span>
      <IconButton size={28} label="Snap to quiet moments" pressed={snapQuiet} tip={snapQuiet ? "In and Out snap to quiet moments of the clips (the ticks under the ruler), to cuts and to the playhead. Click to snap to cuts and the playhead only." : "Snapping to quiet moments is off: In and Out snap to cuts and to the playhead. Click to snap to quiet moments too."} onClick={onSnapQuiet} className="ml-1"><Magnet size={14} /></IconButton>
      <span className="grow" />
      {items.filter((it): it is Exclude<MenuItem, "—"> => it !== "—" && it.key !== "Space" && it.key !== "L").map((it, i) =>
        it.label === "Clear the range" ? (
          <CloseButton key={i} size={28} label="Clear the range" keys="Esc" onClose={() => it.run?.()} className="ml-1" />
        ) : (
          <Button key={i} size="sm" aria-label={it.label} disabled={it.disabled} data-tip={[it.label, it.note].filter(Boolean).join(" · ")} onClick={it.run} className="shrink-0">
            {it.icon} {SHORT[it.label] ?? it.label}
          </Button>
        ),
      )}
    </div>
  );
}
