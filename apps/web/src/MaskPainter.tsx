import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { Eraser, Minus, Plus, Undo2, X } from "lucide-react";
import { api, fileUrl } from "./api";
import { Button, cx, ErrorNote, NumberBox, Segmented } from "./ui";

/** The paint is kept on a canvas no larger than this on its long side: enough to follow an outline, light enough to undo. */
const WORK_EDGE = 1600;
const UNDO = 10;
/** How far in the picture can be brought: enough to paint around an eye. */
const MAX_ZOOM = 8;
/** At least this much of the picture stays in sight however it is moved. */
const KEEP_IN_SIGHT = 80;
/** What the paint looks like over the picture. Only where it is counts, not its colour. */
const PAINT = "#ff4d3d";

/** A mask is named after the picture it was painted on, so that it is never put on another one. */
export const nameFor = (picture: string) => `mask:${picture}`;

const load = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("the image could not be opened"));
    img.src = src;
  });

/**
 * The painter itself, over the whole screen: a brush and a rubber over the picture, zoom and pan, undo.
 * A chunk of its own, fetched when a mask is first painted (MaskField).
 */
export function MaskPainter({ picture, mask, onDone, onClose }: { picture: string; mask: string | null; onDone(id: string): void; onClose(): void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [tool, setTool] = useState<"paint" | "erase" | "move">("paint");
  // how close the picture is, and where it was moved to (in screen pixels from its place in the middle)
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  const [space, setSpace] = useState(false);
  const drag = useRef<{ x: number; y: number; from: { x: number; y: number } } | null>(null);
  const moving = tool === "move" || space;
  const [brush, setBrush] = useState(60);
  const [painted, setPainted] = useState(Boolean(mask));
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const history = useRef<ImageData[]>([]);
  const [steps, setSteps] = useState(0);
  const last = useRef<{ x: number; y: number } | null>(null);
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

  // the picture, and what was painted before when there is something
  useEffect(() => {
    let gone = false;
    void (async () => {
      try {
        const p = await load(fileUrl(picture));
        if (gone) return;
        const c = canvas.current!;
        const k = Math.min(1, WORK_EDGE / Math.max(p.naturalWidth, p.naturalHeight));
        c.width = Math.max(1, Math.round(p.naturalWidth * k));
        c.height = Math.max(1, Math.round(p.naturalHeight * k));
        if (mask) {
          const m = await load(fileUrl(mask));
          if (gone) return;
          const ctx = c.getContext("2d", { willReadFrequently: true })!;
          ctx.drawImage(m, 0, 0, c.width, c.height);
          // white on black → paint on nothing
          const d = ctx.getImageData(0, 0, c.width, c.height);
          for (let i = 0; i < d.data.length; i += 4) {
            const a = d.data[i]!;
            d.data[i] = 255; d.data[i + 1] = 77; d.data[i + 2] = 61; d.data[i + 3] = a;
          }
          ctx.putImageData(d, 0, 0);
        }
        setImg(p);
      } catch (err) {
        if (!gone) setFailed((err as Error).message);
      }
    })();
    return () => {
      gone = true;
    };
  }, [picture, mask]);

  // the keys and the wheel are bound once: what they act on is read through `now` as it stands
  const now = useRef({ onClose, undo: () => {}, zoomTo: (_zoom: number, _px?: number, _py?: number) => {}, zoom: 1 });
  useEffect(() => {
    const typing = (e: KeyboardEvent) => e.target instanceof HTMLInputElement && e.target.type !== "range";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") now.current.onClose();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
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
  useEffect(() => setView((v) => held(v)), [fit]); // eslint-disable-line react-hooks/exhaustive-deps

  const ctxOf = () => canvas.current!.getContext("2d", { willReadFrequently: true })!;
  /** Where the pointer is, in the canvas's own pixels, and how many of them one screen pixel is. */
  const at = (e: ReactPointerEvent) => {
    const c = canvas.current!;
    const r = c.getBoundingClientRect();
    const k = c.width / r.width;
    // sx, sy: the same place in the pixels of the picture as it is laid out, before it is brought closer
    return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k, k, sx: (e.clientX - r.left) / view.zoom, sy: (e.clientY - r.top) / view.zoom };
  };
  const stroke = (from: { x: number; y: number }, to: { x: number; y: number }, k: number) => {
    const ctx = ctxOf();
    ctx.globalCompositeOperation = tool === "erase" ? "destination-out" : "source-over";
    if (tool === "move") return;
    ctx.strokeStyle = PAINT;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = brush * k;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    // a click without a move still leaves a dot
    ctx.lineTo(to.x + (from.x === to.x && from.y === to.y ? 0.01 : 0), to.y);
    ctx.stroke();
  };
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
    const c = canvas.current!;
    history.current = [...history.current.slice(-(UNDO - 1)), ctxOf().getImageData(0, 0, c.width, c.height)];
    setSteps(history.current.length);
    const p = at(e);
    last.current = p;
    stroke(p, p, p.k);
    if (tool === "paint") setPainted(true);
  };
  const move = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (d) return setView((v) => held({ zoom: v.zoom, x: d.from.x + e.clientX - d.x, y: d.from.y + e.clientY - d.y }));
    const p = at(e);
    setCursor({ x: p.sx, y: p.sy });
    if (!last.current) return;
    stroke(last.current, p, p.k);
    last.current = p;
  };
  const up = () => {
    last.current = null;
    drag.current = null;
  };
  const undo = () => {
    const before = history.current.pop();
    if (!before) return;
    ctxOf().putImageData(before, 0, 0);
    setSteps(history.current.length);
  };
  now.current.undo = undo;
  const clear = () => {
    const c = canvas.current!;
    history.current = [...history.current.slice(-(UNDO - 1)), ctxOf().getImageData(0, 0, c.width, c.height)];
    setSteps(history.current.length);
    ctxOf().clearRect(0, 0, c.width, c.height);
  };

  const save = useMutation({
    mutationFn: async () => {
      const c = canvas.current!;
      // anything painted at all? (erasing everything leaves nothing to redo)
      const d = ctxOf().getImageData(0, 0, c.width, c.height).data;
      let any = false;
      for (let i = 3; i < d.length; i += 4) if (d[i]! > 127) { any = true; break; }
      if (!any) throw new Error("The mask is empty. Paint over the part to redo.");
      // the size of the picture itself, black, the painted part in white
      const white = document.createElement("canvas");
      white.width = img!.naturalWidth;
      white.height = img!.naturalHeight;
      const w = white.getContext("2d")!;
      w.drawImage(c, 0, 0, white.width, white.height);
      w.globalCompositeOperation = "source-in";
      w.fillStyle = "#fff";
      w.fillRect(0, 0, white.width, white.height);
      const out = document.createElement("canvas");
      out.width = white.width;
      out.height = white.height;
      const o = out.getContext("2d")!;
      o.fillStyle = "#000";
      o.fillRect(0, 0, out.width, out.height);
      o.drawImage(white, 0, 0);
      const blob = await new Promise<Blob | null>((r) => out.toBlob(r, "image/png"));
      if (!blob) throw new Error("the painted part could not be saved");
      return api.upload(new File([blob], nameFor(picture), { type: "image/png" }), { mask: true });
    },
    onSuccess: (a) => onDone(a.id),
  });

  return (
    <div data-stage role="dialog" aria-modal="true" aria-label="Paint the mask" className="fixed inset-0 z-50 flex flex-col bg-ground/95">
      <header className="flex h-16 shrink-0 items-center gap-4 border-b border-line bg-panel px-5">
        <h2 className="text-base font-semibold">Paint the mask</h2>
        <Segmented<"paint" | "erase" | "move"> label="Tool" value={tool} options={[{ value: "paint", label: "Paint" }, { value: "erase", label: "Rub out" }, { value: "move", label: "Move" }]} onChange={setTool} />
        <label className="flex items-center gap-2 text-ink-2">
          Brush
          <input type="range" min={8} max={300} step={2} value={brush} aria-label="Size of the brush" onChange={(e) => setBrush(Number(e.target.value))} className="w-36 accent-accent" />
          <NumberBox label="Size of the brush" value={brush} min={8} max={300} step={2} unit="px" onCommit={setBrush} />
        </label>
        <Button size="sm" onClick={undo} disabled={!steps} title="Undo the last stroke (Ctrl+Z)"><Undo2 size={14} /> Undo</Button>
        <Button size="sm" onClick={clear} disabled={!painted}><Eraser size={14} /> Start over</Button>
        <span className="flex items-center gap-1">
          <button type="button" aria-label="Further away" title="Further away" disabled={view.zoom <= 1} onClick={() => zoomTo(view.zoom / 1.5)} className="flex h-8 w-8 items-center justify-center rounded-md border border-line-strong hover:bg-hover disabled:opacity-40"><Minus size={14} /></button>
          <span className="w-12 text-center text-xs text-ink-2 tabular-nums">{Math.round(view.zoom * 100)}%</span>
          <button type="button" aria-label="Closer" title="Closer" disabled={view.zoom >= MAX_ZOOM} onClick={() => zoomTo(view.zoom * 1.5)} className="flex h-8 w-8 items-center justify-center rounded-md border border-line-strong hover:bg-hover disabled:opacity-40"><Plus size={14} /></button>
          <Button size="sm" onClick={() => setView({ zoom: 1, x: 0, y: 0 })} disabled={view.zoom === 1}>Whole picture</Button>
        </span>
        <span className="grow" />
        {save.isError && <span className="text-warn-ink">{save.error.message}</span>}
        <Button tone="primary" onClick={() => save.mutate()} disabled={!img || save.isPending}>{save.isPending ? "Saving…" : "Done"}</Button>
        <button type="button" aria-label="Close without saving" onClick={onClose} className="flex h-9 w-9 items-center justify-center rounded-lg text-ink-2 hover:bg-hover"><X size={18} /></button>
      </header>
      <div className="min-h-0 grow p-6">
        {failed && <ErrorNote>{failed}</ErrorNote>}
        <div ref={room} className="flex h-full w-full items-center justify-center overflow-hidden rounded-lg">
        <div className={cx("relative shrink-0 select-none", !fit && "invisible")} style={fit ? { ...fit, transformOrigin: "0 0", transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` } : undefined}>
          {img && <img src={img.src} alt="" draggable={false} className="absolute inset-0 h-full w-full rounded-lg object-contain" />}
          <canvas
            ref={canvas}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
            onPointerLeave={() => setCursor(null)}
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
      <footer className="shrink-0 border-t border-line bg-panel px-5 py-2.5 text-xs text-ink-2">
        Paint a little wider than the thing itself. Only what is painted is redone; the rest of the picture stays exactly as it is.
        For something small, turn the mouse wheel to bring the picture closer; to move around, pick Move or hold the space bar and drag.
      </footer>
    </div>
  );
}
