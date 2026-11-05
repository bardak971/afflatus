import { useEffect, useRef, useState } from "react";
import { MousePointerClick, ScanFace, Wand2 } from "lucide-react";
import { fileUrl } from "../api";
import { cx } from "../cx";
import type { Size } from "../viewer/zoom";
import { percentOf } from "./geometry";
import { picturePixels, planeFrom } from "./maskImage";
import { combine, dropStrays, newPlane, wand, workSize, type Plane, type Rect } from "./raster";
import type { LayerPointer, LayerShape, LayerTool } from "./tools";
import type { MaskLayer } from "./useMaskLayer";

/**
 * The tools that find a mask rather than paint one: a click on a thing (SAM, run in ComfyUI), the detector's faces, hands
 * and persons, and the colour wand (in the page, no job). Each writes into the mask as one step, with the brush's feather,
 * so undo, invert and the eraser work on what they found. The jobs are the caller's (`find`: the Stage wires the server's
 * find-mask routes), so the layer never calls the API itself.
 */

/** What the detector looks for. */
export type FindWhat = "face" | "hands" | "person";

/** What is asked: SAM's points (picture pixels, to add and to take away), or the detector's kind of thing. The find-mask route's own body. */
export type FindRequest = { way: "points"; add: Array<{ x: number; y: number }>; remove: Array<{ x: number; y: number }> } | { way: "detect"; what: FindWhat };

/** The most points of each kind the find-mask route takes. */
const MOST_POINTS = 32;

/** A mask found: the asset holding it (its id: white where found, the picture's size) and its box in picture pixels. */
export interface FoundMask {
  asset: string;
  box: Rect;
}

/**
 * Runs a find job to its end: its masks, none when nothing was found; an error when the job failed. `signal`: aborted when
 * the answer is no longer waited for (a newer click, the tool put down, the layer gone), so the job is not left running.
 */
export type Find = (req: FindRequest, signal?: AbortSignal) => Promise<FoundMask[]>;

/** How long a click waits for the next before it asks: quick clicks placing several points make one SAM job, not one each. */
const CLICK_SETTLE_MS = 150;

/**
 * The one find a tool waits for: a new one gives up the last (its job cancelled by `find`), and so does the layer going
 * away, a new picture, or the tool's own reset.
 */
function useOneFind() {
  const on = useRef<AbortController | null>(null);
  useEffect(() => () => on.current?.abort(), []);
  return {
    next() {
      on.current?.abort();
      on.current = new AbortController();
      return on.current.signal;
    },
    stop() {
      on.current?.abort();
      on.current = null;
    },
  };
}

/** A found mask read into a plane of `w` × `h`: the asset's file, by default. Tests hand their own. */
export type LoadMask = (asset: string, w: number, h: number) => Promise<Plane>;
const loadAsset: LoadMask = (asset, w, h) => planeFrom(fileUrl(asset), w, h);

/** The mask's step a tool made last, while it is still the last change: a new result takes its place rather than adding. */
function useOwnStep(mask: MaskLayer) {
  const latest = useRef(mask);
  latest.current = mask;
  const mine = useRef<number | null>(null);
  return {
    get mask() {
      return latest.current;
    },
    /** Puts `found` in, first taking back this tool's last step if nothing changed the mask since (`replace`). */
    put(found: Plane, ink: "add" | "subtract", replace: boolean) {
      const m = latest.current;
      const took = replace && mine.current !== null && m.version === mine.current;
      if (took) m.undo();
      // a step that changed nothing is not this tool's: owning it would make the next result undo the user's own last step
      const made = m.apply(found, ink);
      if (made !== null || took) mine.current = made;
    },
    /** Takes this tool's last step back, if it is still the last change. */
    drop() {
      const m = latest.current;
      if (mine.current !== null && m.version === mine.current) m.undo();
      mine.current = null;
    },
    forget() {
      mine.current = null;
    },
  };
}

/** The work plane's size for the picture: the found masks are read at it. */
const planeSize = (natural: Size) => workSize(natural.w, natural.h);

/** Found masks read and added into one, each without its strays (a speck SAM put elsewhere on the picture). */
async function together(found: FoundMask[], natural: Size, load: LoadMask): Promise<Plane> {
  const { w, h } = planeSize(natural);
  const all = newPlane(w, h);
  for (const p of await Promise.all(found.map((f) => load(f.asset, w, h)))) combine(all, dropStrays(p), "add");
  return all;
}

export interface ClickTool {
  tool: LayerTool;
  /** The points clicked this time, in picture pixels: to add (a click) or take away (Shift-click). */
  points: Array<{ x: number; y: number; add: boolean }>;
  busy: boolean;
  error: string | null;
  /** Starts again: the points cleared, the mask they found kept. */
  done(): void;
}

/**
 * Click to mask (C): a click on a thing adds a point, a Shift-click one that takes away; each click asks SAM for the mask of
 * all the points so far, which takes the place of the one the clicks before found. A click while one is being found waits
 * for nothing: the answer to the newest points wins. `active`: off, the points are cleared and the next click starts anew.
 */
export function useClickTool({ mask, natural, find, load = loadAsset, active }: { mask: MaskLayer; natural: Size | null; find: Find; load?: LoadMask; active: boolean }): ClickTool {
  const [points, setPoints] = useState<ClickTool["points"]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const own = useOwnStep(mask);
  const asked = useRef(0);
  const pointsNow = useRef(points);
  const one = useOneFind();
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(settle.current), []);
  const done = () => {
    asked.current += 1;
    clearTimeout(settle.current);
    one.stop();
    pointsNow.current = [];
    setPoints([]);
    setBusy(false);
    own.forget();
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- done only clears this tool's own state
  useEffect(() => (active ? undefined : done()), [active]);
  // another picture (a version flipped to): the points were on the one before, and so was what they found
  const findFor = useRef(find);
  useEffect(() => {
    if (findFor.current === find) return;
    findFor.current = find;
    done();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- done only clears this tool's own state
  }, [find]);

  const ask = async (all: ClickTool["points"]) => {
    if (!natural) return;
    const n = ++asked.current;
    setBusy(true);
    setError(null);
    const pair = (p: { x: number; y: number }) => ({ x: Math.round(p.x), y: Math.round(p.y) });
    try {
      const found = await find({ way: "points", add: all.filter((p) => p.add).map(pair), remove: all.filter((p) => !p.add).map(pair) }, one.next());
      if (n !== asked.current) return;
      if (!found.length) own.drop();
      else {
        const plane = await together(found, natural, load);
        if (n !== asked.current) return;
        own.put(plane, "add", true);
      }
    } catch (err) {
      if (n === asked.current) setError((err as Error).message);
    } finally {
      if (n === asked.current) setBusy(false);
    }
  };

  return {
    points,
    busy,
    error,
    done,
    tool: {
      id: "click", key: "C", label: "Click to mask", icon: MousePointerClick, cursor: "crosshair",
      tip: "Click a thing to mask it (SAM 3, run in ComfyUI). Shift-click a part to take it away",
      disabled: natural ? undefined : "The picture is not loaded yet",
      down: (p: LayerPointer) => {
        if (!natural || p.x < 0 || p.y < 0 || p.x >= natural.w || p.y >= natural.h) return;
        const add = !p.shift;
        if (pointsNow.current.filter((q) => q.add === add).length >= MOST_POINTS) {
          setError(`At most ${MOST_POINTS} points of each kind: start again to place more`);
          return;
        }
        const all = [...pointsNow.current, { x: p.x, y: p.y, add }];
        pointsNow.current = all;
        setPoints(all);
        // shown at once, asked once the clicks settle
        setBusy(true);
        clearTimeout(settle.current);
        settle.current = setTimeout(() => void ask(pointsNow.current), CLICK_SETTLE_MS);
      },
      draw: (place) => (
        <>
          {points.map((p, i) => (
            <span
              key={i}
              aria-hidden
              className={cx("pointer-events-none absolute flex items-center justify-center rounded-full font-bold text-white shadow", p.add ? "bg-good" : "bg-warn")}
              style={{ ...percentOf({ x: p.x, y: p.y, w: 0, h: 0 }, place.frame), width: 18 / place.shown.scale, height: 18 / place.shown.scale, fontSize: 12 / place.shown.scale, transform: "translate(-50%, -50%)" }}
            >
              {p.add ? "+" : "−"}
            </span>
          ))}
        </>
      ),
    },
  };
}

export interface DetectTool {
  tool: LayerTool;
  what: FindWhat;
  /** Looks for faces, hands or persons (once each; again with `again`). */
  look(what: FindWhat, again?: boolean): void;
  /** What was found of each kind, as shapes on the layer to click. */
  found: Partial<Record<FindWhat, Array<LayerShape<FoundMask>>>>;
  /** The shapes clicked into the mask, by id. */
  picked: ReadonlySet<string>;
  busy: boolean;
  error: string | null;
}

/**
 * Mask the face, the hands, the person (D): the detector's finds drawn as boxes; a click on one adds its mask, a click
 * again takes it away. It looks for faces when first picked; the strip's chips look for the others.
 */
export function useDetectTool({ mask, natural, find, load = loadAsset, active }: { mask: MaskLayer; natural: Size | null; find: Find; load?: LoadMask; active: boolean }): DetectTool {
  const [what, setWhat] = useState<FindWhat>("face");
  const [found, setFound] = useState<DetectTool["found"]>({});
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const own = useOwnStep(mask);
  const asked = useRef(0);
  const one = useOneFind();

  const look = (kind: FindWhat, again = false) => {
    setWhat(kind);
    if (!natural || (found[kind] && !again)) return;
    const n = ++asked.current;
    setBusy(true);
    setError(null);
    find({ way: "detect", what: kind }, one.next()).then(
      (masks) => {
        if (n !== asked.current) return;
        setFound((f) => ({ ...f, [kind]: masks.map((m, i) => ({ id: `${kind}-${i}`, box: m.box, label: `${kind} ${i + 1}`, payload: m })) }));
        setBusy(false);
      },
      (err: Error) => {
        if (n !== asked.current) return;
        setError(err.message);
        setBusy(false);
      },
    );
  };
  // faces first, the moment the tool is picked: the most asked for
  // eslint-disable-next-line react-hooks/exhaustive-deps -- look runs once per picking of the tool
  useEffect(() => void (active && natural && look(what)), [active, Boolean(natural)]);
  // another picture (a version flipped to, an outpaint bigger than the original): what was found was on the one before,
  // its boxes elsewhere and its masks another size; looked for again on this one while the tool is in hand
  const findFor = useRef(find);
  useEffect(() => {
    if (findFor.current === find) return;
    findFor.current = find;
    asked.current += 1;
    one.stop();
    setFound({});
    setPicked(new Set());
    setBusy(false);
    setError(null);
    own.forget();
    if (active && natural) look(what, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per picture: the rest is read as it stands then
  }, [find]);

  const shapes = found[what] ?? [];
  return {
    what,
    look,
    found,
    picked,
    busy,
    error,
    tool: {
      id: "detect", key: "D", label: "Mask the face, hands or person", icon: ScanFace, cursor: "default",
      tip: "The detector's faces, hands and persons as boxes: click one to mask it, click it again to take it away",
      disabled: natural ? undefined : "The picture is not loaded yet",
      down: (p: LayerPointer) => {
        if (!natural) return;
        // the smallest box under the click: a face inside a person's box is the face
        const hit = shapes
          .filter((s) => p.x >= s.box.x && p.x <= s.box.x + s.box.w && p.y >= s.box.y && p.y <= s.box.y + s.box.h)
          .sort((a, b) => a.box.w * a.box.h - b.box.w * b.box.h)[0];
        if (!hit) return;
        const on = picked.has(hit.id);
        setPicked((was) => {
          const next = new Set(was);
          if (on) next.delete(hit.id);
          else next.add(hit.id);
          return next;
        });
        void together([hit.payload], natural, load).then(
          (plane) => own.put(plane, on ? "subtract" : "add", false),
          (err: Error) => setError(err.message),
        );
      },
      draw: (place) => (
        <>
          {shapes.map((s) => (
            <div
              key={s.id}
              data-found={s.id}
              className={cx("pointer-events-none absolute rounded-key border-dashed", picked.has(s.id) ? "border-accent bg-accent/15" : "border-white/80")}
              style={{ ...percentOf(s.box, place.frame), borderWidth: 1.5 / place.shown.scale }}
            >
              <span className="absolute top-0 left-0 -translate-y-full rounded-key bg-shade/70 px-1 font-mono whitespace-nowrap text-ink-strong" style={{ fontSize: 11 / place.shown.scale }}>
                {s.label}
              </span>
            </div>
          ))}
        </>
      ),
    },
  };
}

export interface WandTool {
  tool: LayerTool;
  /** 0 to 100: how far a colour may be from the clicked one. */
  tolerance: number;
  setTolerance(t: number): void;
  /** Only what is reached from the click, or every close colour of the picture. */
  contiguous: boolean;
  setContiguous(on: boolean): void;
  error: string | null;
}

/** The picture's pixels at a size: the picture's file, by default. Tests hand their own. */
export type LoadPixels = (w: number, h: number) => Promise<Uint8ClampedArray>;

/**
 * The colour wand (W): a click masks the pixels close in colour to the one clicked (`tolerance`), only those reached from it
 * or all of the picture's (`contiguous`). A click takes the place of the wand's last one, Shift adds to it, Alt (or
 * Shift+Alt) takes away. In the page alone: the picture's pixels are read once at the work plane's size, no job.
 */
export function useWandTool({ mask, natural, src, pixels }: { mask: MaskLayer; natural: Size | null; src: string; pixels?: LoadPixels }): WandTool {
  const [tolerance, setTolerance] = useState(24);
  const [contiguous, setContiguous] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const own = useOwnStep(mask);
  // the picture's pixels, read once for the picture
  const read = useRef<{ src: string; data: Promise<Uint8ClampedArray> } | null>(null);
  const pixelsOf = (w: number, h: number) => {
    if (read.current?.src !== src) read.current = { src, data: pixels ? pixels(w, h) : picturePixels(src, w, h) };
    return read.current.data;
  };
  return {
    tolerance,
    setTolerance,
    contiguous,
    setContiguous,
    error,
    tool: {
      id: "wand", key: "W", label: "Magic wand", icon: Wand2, cursor: "crosshair",
      tip: "Click a colour to mask what is close to it. Shift: add to it · Alt: take away",
      disabled: natural ? undefined : "The picture is not loaded yet",
      down: (p: LayerPointer) => {
        if (!natural) return;
        const { w, h } = planeSize(natural);
        const s = w / natural.w;
        pixelsOf(w, h).then(
          (rgba) => {
            setError(null);
            own.put(wand(rgba, w, h, p.x * s, p.y * s, tolerance, contiguous), p.alt ? "subtract" : "add", !p.shift && !p.alt);
          },
          (err: Error) => setError(err.message),
        );
      },
    },
  };
}
