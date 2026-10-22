import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "./api";
import { dialogOver } from "./Dialog";
import { useKeysHere } from "./keys/here";
import { useLeave } from "./leave";
import { nameFor } from "./maskName";
import { PainterToolbar } from "./maskPainter/PainterToolbar";
import { useBrushCanvas, type Tool } from "./maskPainter/useBrushCanvas";
import { cx, ErrorNote } from "./ui";

/** How far in the picture can be brought: enough to paint around an eye. */
const MAX_ZOOM = 8;
/** At least this much of the picture stays in sight however it is moved. */
const KEEP_IN_SIGHT = 80;

/**
 * The painter itself, over the whole screen: a brush and a rubber over the picture, zoom and pan, undo.
 * A chunk of its own, fetched when a mask is first painted (MaskField). The canvas and its strokes are
 * `useBrushCanvas`; this is the room the picture sits in, brought closer and moved around.
 */
export function MaskPainter({ picture, mask, onDone, onClose }: { picture: string; mask: string | null; onDone(id: string): void; onClose(): void }) {
  useKeysHere("mask", true, { over: true });
  // it comes in as a panel and fades as a still copy when closed or saved (the strokes copied as they are)
  const painterRef = useLeave<HTMLDivElement>("m-out");
  const [tool, setTool] = useState<Tool>("paint");
  // how close the picture is, and where it was moved to (in screen pixels from its place in the middle)
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  const [space, setSpace] = useState(false);
  const drag = useRef<{ x: number; y: number; from: { x: number; y: number } } | null>(null);
  const moving = tool === "move" || space;
  const [brush, setBrush] = useState(60);
  const paint = useBrushCanvas({ picture, mask, tool, brush, zoom: view.zoom });
  const { canvas, img, cursor } = paint;
  // the picture as large as the room allows, at its own shape: the canvas lies exactly over it
  const room = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    const el = room.current;
    if (!el || !img) return;
    const measure = () => {
      const k = Math.min(el.clientWidth / img.naturalWidth, el.clientHeight / img.naturalHeight);
      setFit({ width: Math.floor(img.naturalWidth * k), height: Math.floor(img.naturalHeight * k) });
    };
    measure();
    const seen = new ResizeObserver(measure);
    seen.observe(el);
    return () => seen.disconnect();
  }, [img]);

  // the keys and the wheel are bound once: what they act on is read through `now` as it stands
  const now = useRef({ onClose, undo: () => {}, redo: () => {}, zoomTo: (_zoom: number, _px?: number, _py?: number) => {}, zoom: 1 });
  useEffect(() => {
    const typing = (e: KeyboardEvent) => e.target instanceof HTMLInputElement && e.target.type !== "range";
    const onKey = (e: KeyboardEvent) => {
      // a modal over the painter (the keyboard shortcuts) has the keys: no stroke undone, no pan behind it
      if (dialogOver(room.current)) return;
      if (e.key === "Escape") now.current.onClose();
      // Ctrl+Z takes the last stroke back, Ctrl+Shift+Z or Ctrl+Y puts it again (the timeline editor's keys)
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && ((k === "z" && e.shiftKey) || k === "y")) {
        e.preventDefault();
        now.current.redo();
      } else if ((e.ctrlKey || e.metaKey) && k === "z") {
        e.preventDefault();
        now.current.undo();
      }
      // the space bar held down: the picture is moved instead of painted on
      if (e.code === "Space" && !typing(e)) {
        e.preventDefault();
        setSpace(true);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => e.code === "Space" && setSpace(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  /** The picture never leaves the room altogether; at its own size it sits in the middle. */
  const held = (v: { zoom: number; x: number; y: number }) => {
    const el = room.current;
    if (!el || !fit || v.zoom <= 1) return { zoom: 1, x: 0, y: 0 };
    const left = (el.clientWidth - fit.width) / 2;
    const top = (el.clientHeight - fit.height) / 2;
    const within = (at: number, start: number, length: number, span: number) => Math.min(span - KEEP_IN_SIGHT - start, Math.max(KEEP_IN_SIGHT - start - length, at));
    return { zoom: v.zoom, x: within(v.x, left, fit.width * v.zoom, el.clientWidth), y: within(v.y, top, fit.height * v.zoom, el.clientHeight) };
  };
  /** Closer or further, the point at (px, py) of the room staying where it is. Without a point: its middle. */
  const zoomTo = (zoom: number, px?: number, py?: number) => {
    const el = room.current;
    if (!el || !fit) return;
    setView((v) => {
      const z = Math.min(MAX_ZOOM, Math.max(1, zoom));
      const left = (el.clientWidth - fit.width) / 2;
      const top = (el.clientHeight - fit.height) / 2;
      const cx = px ?? el.clientWidth / 2;
      const cy = py ?? el.clientHeight / 2;
      // the point of the picture under (cx, cy) now, in its own unscaled pixels
      const lx = (cx - left - v.x) / v.zoom;
      const ly = (cy - top - v.y) / v.zoom;
      return held({ zoom: z, x: cx - left - lx * z, y: cy - top - ly * z });
    });
  };
  // the wheel brings the picture closer where the pointer is (a listener of its own: React's cannot stop the page from scrolling)
  now.current.zoomTo = zoomTo;
  now.current.zoom = view.zoom;
  now.current.onClose = onClose;
  useEffect(() => {
    const el = room.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      now.current.zoomTo(now.current.zoom * (e.deltaY < 0 ? 1.25 : 0.8), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);
  // a window made smaller must not leave the picture out of sight
  useEffect(() => setView((v) => held(v)), [fit]); // eslint-disable-line react-hooks/exhaustive-deps -- held only bounds the view; it is new at every render

  const down = (e: ReactPointerEvent) => {
    // moving: with the Move tool, the space bar held, or the middle button
    if (e.button === 1 || (e.button === 0 && moving)) {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { x: e.clientX, y: e.clientY, from: { x: view.x, y: view.y } };
      return;
    }
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    paint.begin(e);
  };
  const move = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (d) return setView((v) => held({ zoom: v.zoom, x: d.from.x + e.clientX - d.x, y: d.from.y + e.clientY - d.y }));
    paint.follow(e);
  };
  const up = () => {
    paint.end();
    drag.current = null;
  };
  now.current.undo = paint.undo;
  now.current.redo = paint.redo;

  const save = useMutation({
    mutationFn: async () => api.upload(new File([await paint.maskPng()], nameFor(picture), { type: "image/png" }), { mask: true }),
    onSuccess: (a) => onDone(a.id),
  });

  return (
    <div ref={painterRef} data-stage role="dialog" aria-modal="true" aria-label="Paint the mask" className="m-panel fixed inset-0 z-50 flex flex-col bg-stage/95">
      <PainterToolbar
        tool={tool} onTool={setTool} brush={brush} onBrush={setBrush}
        canUndo={paint.steps > 0} onUndo={paint.undo} canClear={paint.painted} onClear={paint.clear}
        zoom={view.zoom} maxZoom={MAX_ZOOM} onZoom={(z) => zoomTo(z)} onWhole={() => setView({ zoom: 1, x: 0, y: 0 })}
        error={save.isError ? save.error.message : null} saving={save.isPending} canSave={Boolean(img)} onSave={() => save.mutate()} onClose={onClose}
      />
      <div className="min-h-0 grow p-6">
        {paint.failed && <ErrorNote>{paint.failed}</ErrorNote>}
        <div ref={room} className="flex h-full w-full items-center justify-center overflow-hidden rounded-lg">
        <div className={cx("relative shrink-0 select-none", !fit && "invisible")} style={fit ? { ...fit, transformOrigin: "0 0", transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` } : undefined}>
          {img && <img src={img.src} alt="" draggable={false} className="absolute inset-0 h-full w-full rounded-lg object-contain" />}
          <canvas
            ref={canvas}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
            onPointerLeave={() => paint.setCursor(null)}
            onAuxClick={(e) => e.preventDefault()}
            className={cx("absolute inset-0 h-full w-full touch-none rounded-lg opacity-60", moving ? "cursor-grab active:cursor-grabbing" : "cursor-none")}
          />
          {/* the brush as it is on screen, whatever the zoom: its size here is divided by it, since all of this is scaled */}
          {cursor && !moving && (
            <span
              aria-hidden
              className="pointer-events-none absolute rounded-full border-white mix-blend-difference"
              style={{ left: cursor.x - brush / view.zoom / 2, top: cursor.y - brush / view.zoom / 2, width: brush / view.zoom, height: brush / view.zoom, borderWidth: 1 / view.zoom, borderStyle: "solid" }}
            />
          )}
        </div>
        </div>
      </div>
    </div>
  );
}
