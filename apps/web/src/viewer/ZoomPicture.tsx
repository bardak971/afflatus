import { useEffect, useLayoutEffect, useRef, useState, type Dispatch, type ImgHTMLAttributes, type ReactNode, type RefObject, type SetStateAction } from "react";
import { cx } from "../cx";
import { typing } from "../Keys";
import { frameOf, percentOf, roomToPicture, type Frame, type Shown } from "../stageLayer/geometry";
import { FIT, fitted, held, mostZoom, panBy, placed, placedStyle, shownPercent, toggled, wheelFactor, zoomAround, type Size, type Zoom } from "./zoom";

/** How far the pointer goes before a press on a zoomed picture is a drag rather than a click. */
const DRAG_PX = 3;
/** How long a click waits for a second one: a double-click toggles the zoom, and must not also open the details. */
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
export function useZoomGestures({ room, view, onView, fit, size, natural, pans, toggles = true }: {
  room: RefObject<HTMLElement | null>;
  view: Zoom;
  onView: Dispatch<SetStateAction<Zoom>>;
  fit: Size | null;
  size: Size | null;
  natural: Size | null;
  /** Which presses pan; by default the main button's once zoomed in (over a drawing layer: the middle button's, or with Space held). */
  pans?(e: React.PointerEvent, zoomed: boolean): boolean;
  /** Whether a double-click goes between fitted and 1:1 (not over a drawing layer, where two quick dabs are not a zoom). */
  toggles?: boolean;
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
  // a drag that moved: the click its release makes is not a click on the picture (open) nor beside it (close)
  const dragged = useRef(false);
  const [dragging, setDragging] = useState(false);
  const zoomed = view.zoom > 1;
  const handlers = {
    onPointerDown: (e: React.PointerEvent) => {
      // fitted, a press is the picture's own (dragged out onto a folder, a form): only zoomed in does it pan
      if (pans ? !pans(e, zoomed) : e.button !== 0 || !zoomed) return;
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
      if (!toggles || !fit || !size || !natural) return;
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
 * Where a drawing layer over the picture is, handed to `overlay` at each render: the picture's size, the frame the room
 * fits (the picture's own, or `canvas`), how it is drawn, and the pointer in the picture's pixels.
 */
export interface LayerPlace {
  natural: Size;
  frame: Frame;
  /** The frame's size fitted in the room, before the zoom. */
  fit: Size;
  room: Size;
  shown: Shown;
  view: Zoom;
  /** A press now moves the picture rather than drawing (Space held, or the room panning by a drag): the layer leaves it. */
  panning: boolean;
  /** A point of the screen (a pointer event's client x and y) in the picture's pixels. */
  toPicture(clientX: number, clientY: number): { x: number; y: number };
}

/** Space held down, while `on`: what pans over a drawing layer, as in every paint program. */
function useSpaceHeld(on: boolean): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!on) {
      setHeld(false);
      return;
    }
    const down = (e: KeyboardEvent) => {
      // typed into the Stage's prompt bar, Space is a space
      if (e.code !== "Space" || typing(e)) return;
      e.preventDefault();
      setHeld(true);
    };
    const up = (e: KeyboardEvent) => e.code === "Space" && setHeld(false);
    // a Space let go in another window never comes back as a key up
    const lost = () => setHeld(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", lost);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", lost);
    };
  }, [on]);
  return held;
}

/**
 * A picture shown large that can be looked at closely: wheel zoom around the pointer, drag to pan once zoomed in, a
 * double-click between fitted and 1:1, the zoom in a corner. Fitted, it is the picture as before: dragged out like a tile,
 * a click its own (`onPick`: the details), waiting a moment for a double-click. `view` and `onView`: given, the view
 * is the caller's (Compare's two sides in step); else its own, fitted again for each picture.
 *
 * A drawing layer (the Stage's: a mask, an outpaint frame, regions) is `overlay`, drawn over the picture inside the zoomed
 * box so that it moves with it. `panMode` "layer" gives the main button to it: the picture pans with the middle button or
 * with Space held, a double-click does not zoom, a click is not a pick; "hand" is the same with the main button panning
 * (the layer's Hand tool, for a finger or a pen that has neither Space nor a middle button). `canvas`: the room fits that frame rather than the
 * picture (an outpaint frame larger than it, the picture at its x and y; or a frame with no picture yet, `src` left out).
 * None of the three given, it is the picture as it always was.
 */
export function ZoomPicture({ src, natural: known, view: given, onView: setGiven, onPick, pickLabel, imgProps, className, overlay, panMode = "drag", canvas }: {
  src?: string;
  natural?: Size | null;
  view?: Zoom;
  onView?: Dispatch<SetStateAction<Zoom>>;
  /** A click on the picture (not beside it): what the place does with one. */
  onPick?(): void;
  /** Said for the picture as a button, when its click does something. */
  pickLabel?: string;
  imgProps?: ImgHTMLAttributes<HTMLImageElement>;
  className?: string;
  overlay?(place: LayerPlace): ReactNode;
  panMode?: "drag" | "layer" | "hand";
  canvas?: Frame;
}) {
  const layer = panMode !== "drag";
  const hand = panMode === "hand";
  const space = useSpaceHeld(layer);
  const [own, setOwn] = useState<Zoom>(FIT);
  // each picture its own view when the place does not keep one: the next one opens fitted
  useEffect(() => setOwn(FIT), [src]);
  const view = given ?? own;
  const onView = setGiven ?? setOwn;
  const room = useRef<HTMLDivElement>(null);
  const size = useRoomSize(room);
  const [natural, onLoaded] = useNatural(known ?? (canvas && !src ? { w: canvas.w, h: canvas.h } : null));
  // what the room fits: the picture, or the frame around it; all the zoom's sums are of it
  const frame = canvas ?? (natural ? frameOf(natural) : null);
  const whole = frame ? { w: frame.w, h: frame.h } : null;
  const fit = whole && size ? fitted(whole, size) : null;
  const { handlers, zoomed, dragging, most } = useZoomGestures({
    room, view, onView, fit, size, natural: whole,
    ...(layer ? { pans: (e: React.PointerEvent) => e.button === 1 || (e.button === 0 && (space || hand)), toggles: false } : {}),
  });
  // the view held to this room (Compare's other side may have moved it further than this picture goes)
  const shown = fit && size ? placed(held(view, fit, size, most), fit, size) : null;
  const pending = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(pending.current), []);
  const percent = whole && fit ? shownPercent(view, whole, fit) : 100;
  const place: LayerPlace | null = overlay && natural && frame && fit && size && shown ? {
    natural, frame, fit, room: size, shown, view, panning: space || hand || dragging,
    toPicture: (clientX, clientY) => {
      const r = room.current!.getBoundingClientRect();
      return roomToPicture({ x: clientX - r.left, y: clientY - r.top }, shown, fit, frame);
    },
  } : null;
  // the picture inside a frame larger than it: where it sits, in parts of the frame
  const inFrame = canvas && natural && src ? percentOf({ x: 0, y: 0, w: natural.w, h: natural.h }, canvas) : null;
  const pick = layer ? undefined : onPick;
  return (
    <div
      ref={room}
      data-zoom-room
      {...handlers}
      onDoubleClick={(e) => {
        window.clearTimeout(pending.current);
        handlers.onDoubleClick(e);
      }}
      // over a layer the middle button pans: the browser's own scroll on it would take the press
      onAuxClick={layer ? (e) => e.preventDefault() : undefined}
      className={cx("group/zoom relative h-full w-full touch-none overflow-hidden select-none", (layer ? space || hand : zoomed) && (dragging ? "cursor-grabbing" : "cursor-grab"), className)}
    >
      <div
        // until its size is known (read from the picture as it loads), drawn fitted by its own shape, unzoomed
        style={shown && fit ? placedStyle(shown, fit) : { width: "100%", height: "100%" }}
        className="absolute top-0 left-0"
      >
        {src && (
          <img
            src={src}
            alt=""
            {...imgProps}
            // zoomed in, a press pans, and over a layer a press draws: the picture is not dragged out from under it
            draggable={!zoomed && !layer && imgProps?.draggable}
            role={pick ? "button" : undefined}
            tabIndex={pick ? 0 : undefined}
            aria-label={pick ? pickLabel : undefined}
            onLoad={(e) => onLoaded(e.currentTarget)}
            onKeyDown={pick ? (e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              pick();
            } : undefined}
            onClick={(e) => {
              e.stopPropagation();
              // zoomed in, a press is the start of a pan: one that barely moved is still not a pick (the fitted picture's own)
              if (!pick || e.detail > 1 || zoomed) return;
              window.clearTimeout(pending.current);
              pending.current = window.setTimeout(pick, DOUBLE_MS);
            }}
            // past 1:1 the pixels are seen as pixels, not smoothed over: what judging an upscale or a face pass needs
            style={{ imageRendering: percent > 100 ? "pixelated" : undefined, ...(inFrame ? { position: "absolute", ...inFrame } : {}) }}
            // its own cursor (open) only fitted: zoomed in, the room's grab hand says a press pans
            className={cx("block rounded-lg object-contain", !inFrame && "h-full w-full", !zoomed && !layer && imgProps?.className)}
          />
        )}
        {place && overlay?.(place)}
      </div>
      <ZoomReadout view={view} natural={whole} fit={fit} onFit={() => onView(FIT)} />
    </div>
  );
}
