import { cx } from "../cx";
import { BoxHandles } from "../stageLayer/BoxHandles";
import { percentOf, perScreen } from "../stageLayer/geometry";
import type { Rect } from "../stageLayer/raster";
import type { Size } from "../viewer/zoom";
import type { LayerPlace } from "../viewer/ZoomPicture";
import { pixelBox } from "./geometry";
import type { RegionValue, UnitBox } from "./types";

/**
 * Edit in box's boxes as the owner picked them on mock-0.10-paint-look (2026-11-05): never in the mask's accent, so a box
 * never reads as paint. Each is a hard-cornered frame in the picture blue with its label ("✦ 1" and its instruction); the one
 * picked has round handles and a moving dash; drawing or moving one dims the rest of the picture, and a box being drawn says
 * its size at its corner. While a mask is painted the boxes are `ignored` (Fix takes the mask alone): grey, dashed and still,
 * as the bar's notice draws them. Everything here is drawn inside the zoomed box, so screen sizes are divided by the zoom.
 */

/** The least a label is given, in screen pixels, however narrow its box: wider labels would cover the box beside it. */
const LABEL_LEAST_PX = 150;
/** How large a picked box's handles are, in screen pixels. */
const HANDLE_PX = 10;
/** A box nearer the picture's top than this (screen pixels) carries its label inside, so the label stays on the picture. */
const LABEL_ROOM_PX = 30;
/** Past this part of the picture's width, a box hangs its label from its right corner. */
const RIGHT_FROM = 0.7;

type How = "plain" | "picked" | "ignored" | "drawing";

export function EditBoxes({ at, natural, regions, selected, live, ignored }: {
  at: LayerPlace;
  natural: Size;
  /** The boxes as they are now, a box being moved or resized already where it is dragged. */
  regions: readonly RegionValue[];
  selected: string | null;
  /** The drag going on: a new box ("new"), or the one moved or resized. */
  live: { id: string; box: UnitBox } | null;
  ignored: boolean;
}) {
  const dragged = live && live.id !== "new" ? live.id : null;
  return (
    // kept to the picture: the dimming ends at its edges (a label near the top sits inside its box, so none is cut)
    <div data-regions data-edit-boxes className="pointer-events-none absolute inset-0 overflow-hidden">
      {/* the box dragged last, so the dimming lies over every other box */}
      {regions.map((r, i) => ({ r, i })).sort((a, b) => Number(a.r.id === dragged) - Number(b.r.id === dragged)).map(({ r, i }) => (
        <EditBox
          key={r.id}
          id={r.id}
          at={at}
          box={pixelBox(r.box, natural)}
          n={i + 1}
          say={r.prompt}
          how={ignored ? "ignored" : r.id === selected || r.id === dragged ? "picked" : "plain"}
          dimmed={r.id === dragged}
        />
      ))}
      {live?.id === "new" && <EditBox at={at} box={pixelBox(live.box, natural)} n={regions.length + 1} how="drawing" dimmed />}
    </div>
  );
}

function EditBox({ id, at, box, n, say, how, dimmed }: { id?: string; at: LayerPlace; box: Rect; n: number; say?: string; how: How; dimmed?: boolean }) {
  const line = 1 / at.shown.scale;
  // one of the picture's pixels in screen pixels
  const k = 1 / perScreen(at.frame, at.fit, at.shown);
  const picked = how === "picked" || how === "drawing";
  const colour = how === "ignored" ? "var(--color-ink-3)" : "var(--color-picture)";
  const inside = (box.y + at.frame.y) * k < LABEL_ROOM_PX;
  const right = box.x + box.w > at.frame.w * RIGHT_FROM;
  return (
    <div
      data-region={id}
      data-selected={how === "picked" || undefined}
      data-ignored={how === "ignored" || undefined}
      className="absolute"
      style={percentOf(box, at.frame)}
    >
      {/* drawing or moving a box, the rest of the picture dims: the box is what is looked at */}
      {dimmed && <div aria-hidden className="m-box-dim absolute inset-0" style={{ boxShadow: `0 0 0 ${4000 * line}px rgb(0 0 0 / 0.42)` }} />}
      <svg aria-hidden className="absolute inset-0 size-full overflow-visible">
        <rect width="100%" height="100%" rx={2 * line} fill="none" stroke="rgb(0 0 0 / 0.55)" strokeWidth={3.5 * line} />
        <rect
          width="100%"
          height="100%"
          rx={2 * line}
          className={cx(picked && "m-box-dash")}
          style={{ ["--dash" as string]: `${10 * line}px` }}
          fill={how === "ignored" ? "none" : `color-mix(in srgb, ${colour} ${picked ? 6 : 12}%, transparent)`}
          stroke={colour}
          strokeWidth={1.5 * line}
          strokeDasharray={picked ? `${6 * line} ${4 * line}` : how === "ignored" ? `${4 * line} ${4 * line}` : undefined}
        />
      </svg>
      {how !== "drawing" && (
        <span
          data-region-chip
          className={cx(
            "absolute flex h-[22px] items-center gap-1.5 rounded-chip border pr-2 pl-1 text-meta font-semibold whitespace-nowrap shadow-pop backdrop-blur-md",
            how === "picked" ? "border-picture bg-picture text-ground" : how === "ignored" ? "border-ink-3/40 bg-ground/80 text-ink-3" : "border-picture/45 bg-ground/80 text-ink",
          )}
          style={{
            ...(inside ? { top: 6 * line } : { bottom: `calc(100% + ${6 * line}px)` }),
            ...(right ? { right: inside ? 6 * line : -line } : { left: inside ? 6 * line : -line }),
            transform: `scale(${line})`,
            transformOrigin: `${right ? "right" : "left"} ${inside ? "top" : "bottom"}`,
            maxWidth: Math.max(box.w * k, LABEL_LEAST_PX),
          }}
        >
          <span className={cx("flex h-4 shrink-0 items-center rounded-key px-1.5 text-micro font-extrabold", how === "picked" ? "bg-ground text-picture" : how === "ignored" ? "bg-line-strong text-ink-2" : "bg-picture text-ground")}>
            ✦ {n}
          </span>
          {say?.trim() ? <span className="truncate">{say}</span> : <span className="truncate font-medium italic opacity-70">no instruction yet</span>}
        </span>
      )}
      {picked && <BoxHandles scale={at.shown.scale} px={HANDLE_PX} colour={colour} round />}
      {how === "drawing" && (
        <span
          data-box-size
          className="absolute rounded-key bg-ground/80 px-1.5 py-px font-mono text-micro whitespace-nowrap text-ink"
          style={{ right: -line, top: `calc(100% + ${11 * line}px)`, transform: `scale(${line})`, transformOrigin: "right top" }}
        >
          {Math.round(box.w)} × {Math.round(box.h)}
        </span>
      )}
    </div>
  );
}
