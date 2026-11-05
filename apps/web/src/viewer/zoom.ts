/**
 * How close a picture is looked at, and where: the viewer's, the stage's and Compare's. Said of the picture rather than the
 * screen, so that one view fits two pictures of different sizes in two panes of different sizes (Compare's side by side,
 * an Upscale's result beside its source): the same part of each shows, at the same size against its pane. Pure, for the
 * tests; ZoomPicture.tsx draws it.
 */
export interface Zoom {
  /** Times the size the picture is fitted at: 1 is fitted whole. */
  zoom: number;
  /** The point of the picture at the middle of the room, as a part of its width and height (0 to 1). */
  fx: number;
  fy: number;
}

export interface Size {
  w: number;
  h: number;
}

/** Fitted whole, in the middle. */
export const FIT: Zoom = { zoom: 1, fx: 0.5, fy: 0.5 };

/** The furthest in a picture is brought, in times its own pixels (at least 8 times its fitted size). */
const MOST_PIXELS = 4;

/**
 * The size a picture of `natural` pixels is fitted at in `room`: whole, at its own shape. `enlarge`: a small picture is
 * drawn larger than its pixels to fill it (the wipe's box); else never past them, as the viewer has always shown it.
 */
export function fitted(natural: Size, room: Size, enlarge = false): Size {
  if (natural.w <= 0 || natural.h <= 0 || room.w <= 0 || room.h <= 0) return { w: 0, h: 0 };
  const k = Math.min(room.w / natural.w, room.h / natural.h, enlarge ? Infinity : 1);
  return { w: natural.w * k, h: natural.h * k };
}

/** The zoom at which one pixel of the picture is one pixel of the screen (1:1). */
export const oneToOne = (natural: Size, fit: Size): number => (fit.w > 0 ? natural.w / fit.w : 1);

/** The most a picture is zoomed: 8 times its fitted size, or 4 times its own pixels when that is further. */
export const mostZoom = (natural: Size, fit: Size): number => Math.max(8, oneToOne(natural, fit) * MOST_PIXELS);

/**
 * The view kept in bounds: the zoom between fitted and the most; a picture larger than the room never leaves an empty
 * edge, one smaller stays in the middle of it on that side.
 */
export function held(v: Zoom, fit: Size, room: Size, most = 8): Zoom {
  const zoom = Math.min(most, Math.max(1, v.zoom));
  if (zoom <= 1 + 1e-9) return FIT;
  const bound = (f: number, length: number, span: number) => {
    if (length <= span) return 0.5;
    const half = span / 2 / length;
    return Math.min(1 - half, Math.max(half, f));
  };
  return { zoom, fx: bound(v.fx, fit.w * zoom, room.w), fy: bound(v.fy, fit.h * zoom, room.h) };
}

/** Where the fitted picture is drawn in the room for a view: its top left corner, and the scale on its fitted size. */
export function placed(v: Zoom, fit: Size, room: Size): { left: number; top: number; scale: number } {
  return { left: room.w / 2 - v.fx * fit.w * v.zoom, top: room.h / 2 - v.fy * fit.h * v.zoom, scale: v.zoom };
}

/** The style that draws the fitted picture where `placed` puts it: its fitted size, moved and scaled from its top left corner. */
export const placedStyle = (shown: { left: number; top: number; scale: number }, fit: Size) => ({ width: fit.w, height: fit.h, transformOrigin: "0 0", transform: `translate(${shown.left}px, ${shown.top}px) scale(${shown.scale})` });

/** Closer or further to `zoom`, the point of the room at `at` (from its top left corner) staying where it is. */
export function zoomAround(v: Zoom, zoom: number, at: { x: number; y: number }, fit: Size, room: Size, most = 8): Zoom {
  if (fit.w <= 0 || fit.h <= 0) return v;
  const z = Math.min(most, Math.max(1, zoom));
  // a pointer not known (an event without its place) zooms around the middle, rather than lose the view to NaN
  const dx = Number.isFinite(at.x) ? at.x - room.w / 2 : 0;
  const dy = Number.isFinite(at.y) ? at.y - room.h / 2 : 0;
  // the point of the picture under the pointer now, which must be under it after
  const ux = v.fx + dx / (fit.w * v.zoom);
  const uy = v.fy + dy / (fit.h * v.zoom);
  return held({ zoom: z, fx: ux - dx / (fit.w * z), fy: uy - dy / (fit.h * z) }, fit, room, most);
}

/** Moved by (dx, dy) screen pixels, as the pointer drags it. */
export function panBy(v: Zoom, dx: number, dy: number, fit: Size, room: Size, most = 8): Zoom {
  if (fit.w <= 0 || fit.h <= 0) return v;
  return held({ zoom: v.zoom, fx: v.fx - dx / (fit.w * v.zoom), fy: v.fy - dy / (fit.h * v.zoom) }, fit, room, most);
}

/**
 * A double-click: fitted whole again when zoomed in at all, else its own pixels (1:1) around the point clicked. A picture
 * fitted at its own size already (smaller than the room) has nowhere to go.
 */
export function toggled(v: Zoom, at: { x: number; y: number }, natural: Size, fit: Size, room: Size): Zoom {
  if (v.zoom > 1 + 1e-6) return FIT;
  return zoomAround(v, oneToOne(natural, fit), at, fit, room, mostZoom(natural, fit));
}

/** How much a wheel turn brings it closer (above 1) or sends it further: a mouse's notch about a fifth, a trackpad's glide by its small steps. */
export function wheelFactor(e: { deltaY: number; deltaMode: number }): number {
  // lines (Firefox's mouse wheel) to about the pixels a notch gives elsewhere
  const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
  return Math.exp(-Math.max(-200, Math.min(200, dy)) * 0.002);
}

/** The readout: how large the picture's pixels are shown, in percent of the screen's (100 % is 1:1). */
export const shownPercent = (v: Zoom, natural: Size, fit: Size): number => (natural.w > 0 ? Math.round(((fit.w * v.zoom) / natural.w) * 100) : 100);
