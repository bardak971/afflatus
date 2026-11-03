import { useEffect, useLayoutEffect, useRef, useState, type Dispatch, type ImgHTMLAttributes, type RefObject, type SetStateAction } from "react";
import { cx } from "../cx";
import { FIT, fitted, held, mostZoom, panBy, placed, shownPercent, toggled, wheelFactor, zoomAround, type Size, type Zoom } from "./zoom";

/** How far the pointer goes before a press on a zoomed picture is a drag rather than a click. */
const DRAG_PX = 3;
/** How long a click waits for a second one: a double-click toggles the zoom, and must not also copy or open. */
const DOUBLE_MS = 250;

/** The room's size, measured, and measured again as it changes (a window made smaller, the side folded). */
export function useRoomSize(room: RefObject<HTMLElement | null>): Size | null {
  const [size, setSize] = useState<Size | null>(null);
  useLayoutEffect(() => {
    const el = room.current;
    if (!el) return;
    const measure = () => setSize((was) => (was && was.w === el.clientWidth && was.h === el.clientHeight ? was : { w: el.clientWidth, h: el.clientHeight }));
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [room]);
  return size;
}

/**
 * The wheel, the drag and the double-click on a picture's room: the wheel zooms around the pointer, a drag pans once it is
 * zoomed in, a double-click goes between fitted and 1:1. `onView` is the view's setter: two rooms handed the same one (Compare)
 * move together. The wheel is a listener of its own, React's cannot stop the page from scrolling or zooming.
 */
export function useZoomGestures({ room, view, onView, fit, size, natural }: {
  room: RefObject<HTMLElement | null>;
  view: Zoom;
  onView: Dispatch<SetStateAction<Zoom>>;
  fit: Size | null;
  size: Size | null;
  natural: Size | null;
}) {
  const now = useRef({ fit, size, natural, onView });
  now.current = { fit, size, natural, onView };
  const most = fit && natural ? mostZoom(natural, fit) : 8;
  useEffect(() => {
    const el = room.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const { fit: f, size: s, natural: n, onView: set } = now.current;
      if (!f || !s || !n) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const at = { x: e.clientX - r.left, y: e.clientY - r.top };
      set((v) => zoomAround(v, v.zoom * wheelFactor(e), at, f, s, mostZoom(n, f)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [room]);
  const drag = useRef<{ x: number; y: number; id: number; moved: boolean } | null>(null);
  // a drag that moved: the click its release makes is not a click on the picture (copy, open) nor beside it (close)
  const dragged = useRef(false);
  const [dragging, setDragging] = useState(false);
  const zoomed = view.zoom > 1;
  const handlers = {
    onPointerDown: (e: React.PointerEvent) => {
      // fitted, a press is the picture's own (dragged out onto a folder, a form): only zoomed in does it pan
      if (e.button !== 0 || !zoomed) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { x: e.clientX, y: e.clientY, id: e.pointerId, moved: false };
      dragged.current = false;
    },
    onPointerMove: (e: React.PointerEvent) => {
      const d = drag.current;
      if (!d || d.id !== e.pointerId || !fit || !size) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) < DRAG_PX) return;
      if (!d.moved) setDragging(true);
      d.moved = true;
      d.x = e.clientX;
      d.y = e.clientY;
      onView((v) => panBy(v, dx, dy, fit, size, most));
    },
    onPointerUp: (e: React.PointerEvent) => {
      if (drag.current?.id !== e.pointerId) return;
      dragged.current = drag.current.moved;
      drag.current = null;
      setDragging(false);
    },
    onPointerCancel: () => {
      drag.current = null;
      setDragging(false);
    },
    onClickCapture: (e: React.MouseEvent) => {
      if (!dragged.current) return;
      dragged.current = false;
      e.stopPropagation();
      e.preventDefault();
    },
    onDoubleClick: (e: React.MouseEvent) => {
      if (!fit || !size || !natural) return;
      e.stopPropagation();
      const r = e.currentTarget.getBoundingClientRect();
      const at = { x: e.clientX - r.left, y: e.clientY - r.top };
      onView((v) => toggled(v, at, natural, fit, size));
    },
  };
  return { handlers, zoomed, dragging, most };
}

/** What the zoom is at, small in a corner: the picture's pixels in percent of the screen's; a click fits it whole again. */
export function ZoomReadout({ view, natural, fit, onFit, className }: { view: Zoom; natural: Size | null; fit: Size | null; onFit(): void; className?: string }) {
  if (!natural || !fit || fit.w <= 0) return null;
  const zoomed = view.zoom > 1;
  return (
    <button
      type="button"
      data-zoom-readout
      onClick={(e) => {
        e.stopPropagation();
        onFit();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      data-tip={zoomed ? "Fit it whole again. Wheel: zoom around the pointer · drag: pan · double-click: fit / 1:1" : "Wheel: zoom around the pointer · drag: pan · double-click: fit / 1:1"}
      className={cx(
        "absolute z-10 rounded-md bg-shade/60 px-1.5 py-0.5 font-mono text-meta text-ink-strong transition-opacity",
        zoomed ? "opacity-100" : "opacity-0 group-hover/zoom:opacity-100 focus-visible:opacity-100",
        // where it sits: the bottom right corner, unless the place has something there (the wipe's labels)
        className ?? "right-2.5 bottom-2.5",
      )}
    >
      {zoomed ? `${shownPercent(view, natural, fit)} %` : `Fit · ${shownPercent(view, natural, fit)} %`}
    </button>
  );
}

/** The picture's own size: from the library when it says it, else read from the picture once it has loaded. */
function useNatural(known: Size | null | undefined): [Size | null, (img: HTMLImageElement) => void] {
  const [read, setRead] = useState<Size | null>(null);
  const natural = known && known.w > 0 && known.h > 0 ? known : read;
  return [natural, (img) => img.naturalWidth > 0 && setRead({ w: img.naturalWidth, h: img.naturalHeight })];
}

/**
 * A picture shown large that can be looked at closely: wheel zoom around the pointer, drag to pan once zoomed in, a
 * double-click between fitted and 1:1, the zoom in a corner. Fitted, it is the picture as before: dragged out like a tile,
 * a click its own (`onPick`: copy it, open it), waiting a moment for a double-click. `view` and `onView`: given, the view
 * is the caller's (Compare's two sides in step); else its own, fitted again for each picture.
 */
export function ZoomPicture({ src, natural: known, view: given, onView: setGiven, onPick, pickLabel, imgProps, className }: {
  src: string;
  natural?: Size | null;
  view?: Zoom;
  onView?: Dispatch<SetStateAction<Zoom>>;
  /** A click on the picture (not beside it): what the place does with one. */
  onPick?(): void;
  /** Said for the picture as a button, when its click does something. */
  pickLabel?: string;
  imgProps?: ImgHTMLAttributes<HTMLImageElement>;
  className?: string;
}) {
  const [own, setOwn] = useState<Zoom>(FIT);
  // each picture its own view when the place does not keep one: the next one opens fitted
  useEffect(() => setOwn(FIT), [src]);
  const view = given ?? own;
  const onView = setGiven ?? setOwn;
  const room = useRef<HTMLDivElement>(null);
  const size = useRoomSize(room);
  const [natural, onLoaded] = useNatural(known);
  const fit = natural && size ? fitted(natural, size) : null;
  const { handlers, zoomed, dragging, most } = useZoomGestures({ room, view, onView, fit, size, natural });
  // the view held to this room (Compare's other side may have moved it further than this picture goes)
  const shown = fit && size ? placed(held(view, fit, size, most), fit, size) : null;
  const pending = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(pending.current), []);
  const percent = natural && fit ? shownPercent(view, natural, fit) : 100;
  return (
    <div
      ref={room}
      data-zoom-room
      {...handlers}
      onDoubleClick={(e) => {
        window.clearTimeout(pending.current);
        handlers.onDoubleClick(e);
      }}
      className={cx("group/zoom relative h-full w-full touch-none overflow-hidden select-none", zoomed && (dragging ? "cursor-grabbing" : "cursor-grab"), className)}
    >
      <div
        // until its size is known (read from the picture as it loads), drawn fitted by its own shape, unzoomed
        style={shown && fit ? { width: fit.w, height: fit.h, transformOrigin: "0 0", transform: `translate(${shown.left}px, ${shown.top}px) scale(${shown.scale})` } : { width: "100%", height: "100%" }}
        className="absolute top-0 left-0"
      >
        <img
          src={src}
          alt=""
          {...imgProps}
          // zoomed in, a press pans: the picture is not dragged out from under it
          draggable={!zoomed && imgProps?.draggable}
          role={onPick ? "button" : undefined}
          tabIndex={onPick ? 0 : undefined}
          aria-label={onPick ? pickLabel : undefined}
          onLoad={(e) => onLoaded(e.currentTarget)}
          onKeyDown={onPick ? (e) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            onPick();
          } : undefined}
          onClick={(e) => {
            e.stopPropagation();
            if (!onPick || e.detail > 1) return;
            window.clearTimeout(pending.current);
            pending.current = window.setTimeout(onPick, DOUBLE_MS);
          }}
          // past 1:1 the pixels are seen as pixels, not smoothed over: what judging an upscale or a face pass needs
          style={{ imageRendering: percent > 100 ? "pixelated" : undefined }}
          // its own cursor (copy, open) only fitted: zoomed in, the room's grab hand says a press pans
          className={cx("block h-full w-full rounded-lg object-contain", !zoomed && imgProps?.className)}
        />
      </div>
      <ZoomReadout view={view} natural={natural} fit={fit} onFit={() => onView(FIT)} />
    </div>
  );
}
