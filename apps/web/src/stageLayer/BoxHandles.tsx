import { cx } from "../cx";
import { AT, CURSOR, HANDLES } from "./geometry";

/**
 * A box's eight handles on the Stage's layer, drawn inside the box they resize (the outpaint frame, a region's box): so many
 * screen pixels whatever the zoom, so they are drawn at `px` over the zoom's `scale`. `grabbable`: they take the pointer
 * themselves (the frame's), for their own cursor over the picture.
 */
export function BoxHandles({ scale, px, colour = "var(--color-accent)", grabbable }: { scale: number; px: number; colour?: string; grabbable?: boolean }) {
  const line = 1 / scale;
  const side = px / scale;
  return (
    <>
      {HANDLES.map((h) => (
        <i
          key={h}
          data-handle={h}
          className={cx("absolute rounded-key bg-panel", grabbable && "pointer-events-auto")}
          style={{ left: `calc(${AT[h][0] * 100}% - ${side / 2}px)`, top: `calc(${AT[h][1] * 100}% - ${side / 2}px)`, width: side, height: side, border: `${line * 1.5}px solid ${colour}`, cursor: CURSOR[h] }}
        />
      ))}
    </>
  );
}
