import { Scissors } from "lucide-react";
import type { RemovedPart } from "../../api";
import { clock, plural, seconds } from "../../format";
import { cx } from "../../ui";

/** What a removed part's mark says: "cut · 4.8 s set aside". */
export const removedSaid = (p: RemovedPart) => `cut · ${seconds(p.toMs - p.fromMs)} set aside`;

/**
 * Where a part was cut out of the middle of a recording or the source by removing its clips (card #75), on its band or the
 * Source lane: a line where it jumps, and its words; a click brings the part back (its clips and takes, before `number`'s
 * clip), as Undo would. `width`: the stretch it covers where the lane is drawn in the source's own time (0: a line).
 */
export function RemovedMark({ part, left, width = 0, number, onBringBack, className }: { part: RemovedPart; left: number; width?: number; number: number; onBringBack?(before: string): void; className?: string }) {
  const said = removedSaid(part);
  const tip = `${clock(part.fromMs, { decimals: 1 })}–${clock(part.toMs, { decimals: 1 })} cut out here, with ${plural(part.clips, "clip")}${part.takes ? ` (${plural(part.takes, "rendered")})` : ""}: clip ${number} starts after a cut.${onBringBack ? " Click: bring it back" : ""}`;
  return (
    <span className={cx("absolute inset-y-0", className)} style={{ left, width: Math.max(2, width) }}>
      <span aria-hidden className={cx("pointer-events-none absolute inset-y-0 left-0", width > 2 ? "right-0 bg-[repeating-linear-gradient(135deg,transparent_0_4px,color-mix(in_srgb,var(--color-warn)_35%,transparent)_4px_6px)]" : "w-0.5 bg-warn")} />
      <button
        type="button"
        aria-label={`${said}: ${tip}`}
        data-tip={tip}
        disabled={!onBringBack}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onBringBack?.(part.before);
        }}
        className="pointer-events-auto absolute bottom-0.5 left-1 flex h-5 items-center gap-1 rounded bg-warn-wash px-1 text-micro font-semibold whitespace-nowrap text-warn-ink enabled:hover:bg-warn enabled:hover:text-warn-on"
      >
        <Scissors size={10} aria-hidden className="shrink-0" />
        {said}
      </button>
    </span>
  );
}
