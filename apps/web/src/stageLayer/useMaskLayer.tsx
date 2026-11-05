import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Brush as BrushIcon, Contrast, Eraser, Lasso, SquareDashed } from "lucide-react";
import { fileUrl } from "../api";
import { useLiveValue } from "../hooks";
import { motionAllowed } from "../useFlip";
import type { Size } from "../viewer/zoom";
import type { LayerPlace } from "../viewer/ZoomPicture";
import { boxFrom, percentOf } from "./geometry";
import { planeFrom, pngOf } from "./maskImage";
import { FADE_MS, MaskFilters, viewFilter, type MaskView } from "./maskView";
import {
  bounds, chase, clear as clearPlane, clip, combine, dab, EMPTY_BELOW, feathered, fillPolygon, fillRect, History, invert, line, newPlane, resample, tint, union, workSize,
  type Ink, type Plane, type Rect,
} from "./raster";
import type { LayerPointer, LayerTool } from "./tools";

/** The brush, in the picture's own pixels: `size` across its core, `feather` the soft band past it. */
export interface Brush {
  size: number;
  feather: number;
}

export const BRUSH_LIMITS = { size: { min: 2, max: 600 }, feather: { min: 0, max: 200 } };

/** What the canvas holds: white, as strong as the mask; each view's filter (maskView.tsx) colours it. */
const LEVELS: readonly [number, number, number] = [255, 255, 255];

/** Past this much, a mask's grey levels are not all 0 and 255: it has a soft edge ("1 area, soft"). */
const isSoft = (plane: Plane) => plane.data.some((v) => v > EMPTY_BELOW && v < 255 - EMPTY_BELOW);

/** A pen's pressure on the brush: from a fifth of its size at the lightest touch to all of it pressed down. */
const pressed = (p: LayerPointer) => (p.pen ? 0.2 + 0.8 * Math.min(1, Math.max(0, p.pressure)) : 1);

/** The mask's state, said to whoever shows it (the form's painter, the Stage's mask chip). */
export interface MaskLayer {
  tools: { brush: LayerTool; eraser: LayerTool; box: LayerTool; lasso: LayerTool; invert: LayerTool };
  brush: Brush;
  setBrush(change: Partial<Brush>): void;
  /**
   * How the mask is drawn over the picture: the eye's view. `setView(nextView)` steps from the view as it is then, so
   * presses quicker than a render (M held, its repeats) each step one further.
   */
  view: MaskView;
  setView(view: MaskView | ((now: MaskView) => MaskView)): void;
  /** Undo steps there are, and redo steps. */
  steps: number;
  redos: number;
  undo(): void;
  redo(): void;
  clear(): void;
  /** The masked part in the picture's pixels; null while nothing is masked. */
  area: Rect | null;
  /** Whether it has a soft edge anywhere. */
  soft: boolean;
  /** Up by one at every change: what a caller watching the mask follows. */
  version: number;
  /** The picture's plane is made (and a mask painted before read into it). */
  ready: boolean;
  failed: string | null;
  /** The mask as a PNG at the picture's own size; an empty one is an error. */
  png(): Promise<Blob>;
  /**
   * A mask from elsewhere (a click's, a detector's), at any size, added or taken away as one step, with the brush's feather
   * past its edge. Returns the mask's version after it: the step is still the last one while `version` says the same.
   * Null when it changed nothing (adding over what is masked, taking away where nothing is): there is no step to own.
   */
  apply(found: Plane, ink: Ink): number | null;
  /** The mask drawn over the picture, for StageLayer. */
  draw(place: LayerPlace): ReactNode;
}

/**
 * The soft mask painted over a picture of `natural` pixels: its plane (raster.ts, capped at WORK_EDGE), the tools that
 * paint it, undo by patches, and the tinted canvas that shows it. `from`: a mask painted before (an asset id), read in
 * as it was. Made again when the picture or that mask changes.
 */
export function useMaskLayer({ natural, from = null, start = { size: 64, feather: 16 } }: { natural: Size | null; from?: string | null; start?: Brush }): MaskLayer {
  const plane = useRef<Plane | null>(null);
  const history = useRef(new History());
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [brush, setBrushState] = useState<Brush>(start);
  const [view, setViewState] = useState<MaskView>("tint");
  // the views' filters are this layer's own: two layers on a page (the form's painter over the Stage) never share one
  const filterId = `mask${useId().replace(/[^\w-]/g, "")}`;
  const [version, setVersion] = useState(0);
  // the version as it is this instant (the state is a render late): what apply returns
  const versionNow = useRef(0);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [said, setSaid] = useState<{ area: Rect | null; soft: boolean }>({ area: null, soft: false });

  /** How many plane pixels one picture pixel is. */
  const k = () => (plane.current && natural ? plane.current.w / natural.w : 1);

  // the mask as shown: the plane's levels, reached a little later where they just changed (a fresh stroke fades in)
  const display = useRef<Uint8ClampedArray | null>(null);
  const fading = useRef<Rect[]>([]);
  const frame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  /** The shown levels of `r` put on the canvas. */
  const draw = useCallback((r: Rect) => {
    const p = plane.current;
    const c = canvas.current;
    const d = display.current;
    if (!p || !c || !d) return;
    if (c.width !== p.w || c.height !== p.h) {
      c.width = p.w;
      c.height = p.h;
      r = { x: 0, y: 0, w: p.w, h: p.h };
    }
    // no 2D context (a page that draws nothing, as the tests'): the mask is kept all the same, only not shown
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const { data, rect } = tint({ w: p.w, h: p.h, data: d }, LEVELS, 1, r);
    ctx.putImageData(new ImageData(data as Uint8ClampedArray<ArrayBuffer>, rect.w, rect.h), rect.x, rect.y);
  }, []);

  /**
   * A part of the plane changed: shown as it is now, faded to over FADE_MS (at `once`, or with motion reduced, at once).
   * Each frame moves the parts still fading a step nearer the plane; a part that arrived is dropped.
   */
  const paint = useCallback((r: Rect | null, once = false) => {
    const p = plane.current;
    const part = p && r && clip(r, p);
    if (!p || !part) return;
    if (display.current?.length !== p.data.length) {
      display.current = p.data.slice();
      fading.current = [];
      return draw({ x: 0, y: 0, w: p.w, h: p.h });
    }
    if (once || !motionAllowed()) {
      for (let y = part.y; y < part.y + part.h; y++) display.current.set(p.data.subarray(y * p.w + part.x, y * p.w + part.x + part.w), y * p.w + part.x);
      return draw(part);
    }
    fading.current.push(part);
    if (frame.current) return;
    let last = performance.now();
    const tick = (t: number) => {
      const d = display.current;
      const q = plane.current;
      if (!d || !q || d.length !== q.data.length) {
        frame.current = 0;
        return;
      }
      const step = Math.max(1, Math.round((255 * (t - last)) / FADE_MS));
      last = t;
      fading.current = fading.current.filter((f) => {
        const arrived = chase(d, q, f, step);
        draw(f);
        return !arrived;
      });
      frame.current = fading.current.length ? requestAnimationFrame(tick) : 0;
    };
    frame.current = requestAnimationFrame(tick);
  }, [draw]);

  // one ref for the canvas's whole life: a new one at each render would draw the whole plane again at every pointer move
  const canvasRef = useCallback((c: HTMLCanvasElement | null) => {
    canvas.current = c;
    if (c && plane.current) paint({ x: 0, y: 0, w: plane.current.w, h: plane.current.h }, true);
  }, [paint]);

  // read through a ref: a caller handing a new {w, h} at each render must not make the plane again (only its size does)
  const naturalNow = useRef(natural);
  naturalNow.current = natural;
  /** After a step: what the mask covers, said again, in the picture's pixels. */
  const changed = useCallback(() => {
    const p = plane.current;
    versionNow.current += 1;
    setVersion(versionNow.current);
    const n = naturalNow.current;
    if (!p || !n) return;
    const b = bounds(p);
    const s = p.w / n.w;
    setSaid({ area: b && { x: b.x / s, y: b.y / s, w: b.w / s, h: b.h / s }, soft: isSoft(p) });
  }, []);

  const w = natural?.w ?? 0;
  const h = natural?.h ?? 0;
  useEffect(() => {
    if (!w || !h) return;
    let gone = false;
    const size = workSize(w, h);
    plane.current = newPlane(size.w, size.h);
    history.current = new History();
    setReady(false);
    setFailed(null);
    void (async () => {
      try {
        if (from) {
          const read = await planeFrom(fileUrl(from), size.w, size.h);
          if (gone) return;
          plane.current = read;
        }
        setReady(true);
        display.current = null;
        paint({ x: 0, y: 0, w: size.w, h: size.h }, true);
        changed();
      } catch (err) {
        if (!gone) setFailed((err as Error).message);
      }
    })();
    return () => {
      gone = true;
    };
  }, [w, h, from, paint, changed]);

  /**
   * One step: opened, done, kept as an undo patch, drawn, said. Whether it changed anything: one that did not is no step,
   * and the version stays, so a tool's own last step is still the last change after it.
   */
  const step = (does: (p: Plane) => Rect | null): boolean => {
    const p = plane.current;
    if (!p) return false;
    history.current.begin(p);
    const dirty = does(p);
    const kept = history.current.commit(p, dirty);
    paint(dirty);
    if (kept) changed();
    return kept;
  };

  // a stroke of the brush or the rubber, its points in the plane's pixels
  const stroke = useRef<{ last: { x: number; y: number; r: number }; dirty: Rect | null } | null>(null);
  const brushTool = (id: "brush" | "eraser", ink: Ink): Omit<LayerTool, "key" | "label" | "icon"> => ({
    id,
    cursor: "brush",
    down: (pt) => {
      const p = plane.current;
      if (!p) return;
      const s = k();
      const r = (brush.size / 2) * s * pressed(pt);
      history.current.begin(p);
      const at = { x: pt.x * s, y: pt.y * s, r };
      stroke.current = { last: at, dirty: dab(p, at.x, at.y, r, brush.feather * s, ink) };
      paint(stroke.current.dirty);
    },
    move: (pt) => {
      const p = plane.current;
      const st = stroke.current;
      if (!p || !st) return;
      const s = k();
      const at = { x: pt.x * s, y: pt.y * s, r: (brush.size / 2) * s * pressed(pt) };
      const dirty = line(p, st.last, at, st.last.r, brush.feather * s, ink, at.r);
      st.last = at;
      st.dirty = union(st.dirty, dirty);
      paint(dirty);
    },
    up: () => {
      const p = plane.current;
      const st = stroke.current;
      stroke.current = null;
      if (!p || !st) return;
      history.current.commit(p, st.dirty);
      changed();
    },
    cancel: () => {
      const p = plane.current;
      stroke.current = null;
      if (p) paint(history.current.abandon(p));
    },
  });

  // a box or a lasso being drawn, in the picture's pixels: drawn live over the picture, filled when let go
  // held in a ref as well as drawn: the release can come in the same frame as the last move, before a render
  const [boxing, setBoxing] = useLiveValue<{ a: { x: number; y: number }; b: { x: number; y: number }; square: boolean; ink: Ink }>();
  const [lassoing, setLassoing] = useLiveValue<{ points: Array<{ x: number; y: number }>; ink: Ink }>();
  const boxOf = (b: NonNullable<typeof boxing.current>) => boxFrom(b.a, b.b, b.square ? 1 : null);
  const scaled = (r: Rect, s: number): Rect => ({ x: r.x * s, y: r.y * s, w: r.w * s, h: r.h * s });

  const tools: MaskLayer["tools"] = {
    brush: { ...brushTool("brush", "add"), key: "P", label: "Soft brush", icon: BrushIcon, tip: "Paint the part to redo: a full core, then a soft edge (the dashed ring). [ ] its size, Shift+[ ] its feather" },
    eraser: { ...brushTool("eraser", "subtract"), key: "E", label: "Eraser", icon: Eraser, tip: "Take the mask away, with the brush's own softness" },
    box: {
      id: "box", key: "B", label: "Rectangle mask", icon: SquareDashed, cursor: "crosshair",
      tip: "Drag a box to mask it. Shift: a square · Alt: take it away",
      down: (pt) => setBoxing({ a: pt, b: pt, square: pt.shift, ink: pt.alt ? "subtract" : "add" }),
      move: (pt) => setBoxing((b) => b && { ...b, b: pt, square: pt.shift }),
      up: () => {
        const b = boxing.current;
        if (!b) return;
        const r = boxOf(b);
        setBoxing(null);
        if (r.w < 1 || r.h < 1) return;
        const s = k();
        step((p) => fillRect(p, scaled(r, s), brush.feather * s, b.ink));
      },
      cancel: () => setBoxing(null),
      draw: (place) => boxing.current && (
        <div className="pointer-events-none absolute border border-dashed border-white mix-blend-difference" style={{ ...percentOf(boxOf(boxing.current), place.frame), borderWidth: 1 / place.shown.scale }} />
      ),
    },
    lasso: {
      id: "lasso", key: "L", label: "Lasso", icon: Lasso, cursor: "crosshair",
      tip: "Draw round the part to mask it. Alt: take it away",
      down: (pt) => setLassoing({ points: [pt], ink: pt.alt ? "subtract" : "add" }),
      move: (pt) => setLassoing((l) => {
        if (!l) return l;
        const last = l.points[l.points.length - 1]!;
        // a point every couple of pixels of the picture is enough to follow an outline
        return Math.hypot(pt.x - last.x, pt.y - last.y) < 2 ? l : { ...l, points: [...l.points, pt] };
      }),
      up: () => {
        if (!lassoing.current) return;
        const { points, ink } = lassoing.current;
        setLassoing(null);
        const s = k();
        step((p) => fillPolygon(p, points.map((q) => ({ x: q.x * s, y: q.y * s })), brush.feather * s, ink));
      },
      cancel: () => setLassoing(null),
      draw: (place) => lassoing.current && (
        <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" viewBox={`0 0 ${place.frame.w} ${place.frame.h}`} preserveAspectRatio="none">
          <polygon
            points={lassoing.current.points.map((q) => `${q.x + place.frame.x},${q.y + place.frame.y}`).join(" ")}
            fill="rgba(255,77,61,0.25)" stroke="white" strokeWidth={1.5} strokeDasharray="6 4" vectorEffect="non-scaling-stroke"
          />
        </svg>
      ),
    },
    invert: {
      id: "invert", key: "X", label: "Invert the mask", icon: Contrast, cursor: "default",
      tip: "What is masked is kept, and the rest is redone",
      act: () => step(invert),
    },
  };

  return {
    tools,
    brush,
    setBrush: (change) => setBrushState((b) => ({
      size: Math.round(Math.min(BRUSH_LIMITS.size.max, Math.max(BRUSH_LIMITS.size.min, change.size ?? b.size))),
      feather: Math.round(Math.min(BRUSH_LIMITS.feather.max, Math.max(BRUSH_LIMITS.feather.min, change.feather ?? b.feather))),
    })),
    view,
    setView: (next) => {
      setViewState(next);
      // the views cross-fade, but never under reduced motion (Off is the canvas hidden: nothing to fade in)
      if (motionAllowed()) canvas.current?.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS * 0.8, easing: "ease-out" });
    },
    steps: history.current.steps,
    redos: history.current.redos,
    undo: () => {
      const p = plane.current;
      if (!p) return;
      paint(history.current.undo(p));
      changed();
    },
    redo: () => {
      const p = plane.current;
      if (!p) return;
      paint(history.current.redo(p));
      changed();
    },
    clear: () => step(clearPlane),
    area: said.area,
    soft: said.soft,
    version,
    ready,
    failed,
    png: async () => {
      const p = plane.current;
      if (!p || !natural || !bounds(p)) throw new Error("The mask is empty. Paint over the part to redo.");
      return pngOf(p, natural.w, natural.h);
    },
    apply: (found, ink) => {
      const p = plane.current;
      if (!p || !natural) return null;
      const fitted = found.w === p.w && found.h === p.h ? found : resample(found, p.w, p.h);
      return step((q) => combine(q, feathered(fitted, brush.feather * (p.w / natural.w)), ink)) ? versionNow.current : null;
    },
    draw: (place) => (
      <>
        <MaskFilters id={filterId} scale={place.shown.scale} />
        <canvas
          ref={canvasRef}
          aria-hidden
          data-mask-view={view}
          className="pointer-events-none absolute rounded-lg"
          style={{ ...percentOf({ x: 0, y: 0, w: place.natural.w, h: place.natural.h }, place.frame), filter: viewFilter(filterId, view), opacity: view === "off" ? 0 : 1 }}
        />
      </>
    ),
  };
}

