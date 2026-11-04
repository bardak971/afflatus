import type { LayerPlace } from "../viewer/ZoomPicture";

/**
 * The brush as it will paint, where the pointer is: its core (full strength) as a solid ring, its feather (where it fades
 * out) as a dashed one. Drawn in the picture's pixels inside the zoomed box, so it is the size it paints at whatever the
 * zoom; its lines are divided by the zoom to stay one screen pixel.
 */
export function BrushCursor({ place, at, size, feather }: { place: LayerPlace; at: { x: number; y: number }; size: number; feather: number }) {
  const k = place.frame.w > 0 ? place.fit.w / place.frame.w : 1;
  const x = (at.x + place.frame.x) * k;
  const y = (at.y + place.frame.y) * k;
  const line = 1 / place.shown.scale;
  const ring = (r: number, dashed: boolean) => (
    <span
      className="pointer-events-none absolute rounded-full border-white mix-blend-difference"
      style={{ left: x - r, top: y - r, width: r * 2, height: r * 2, borderWidth: line, borderStyle: dashed ? "dashed" : "solid" }}
    />
  );
  return (
    <span aria-hidden data-brush-cursor>
      {ring(Math.max(0.5, (size / 2) * k), false)}
      {feather > 0 && ring((size / 2 + feather) * k, true)}
    </span>
  );
}
