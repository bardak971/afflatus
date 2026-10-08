import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { fileUrl } from "../api";

/** The paint is kept on a canvas no larger than this on its long side: enough to follow an outline, light enough to undo. */
const WORK_EDGE = 1600;
const UNDO = 10;
/** What the paint looks like over the picture. Only where it is counts, not its colour. */
const PAINT = "#ff4d3d";

export type Tool = "paint" | "erase" | "move";

const load = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("the image could not be opened"));
    img.src = src;
  });

/**
 * The canvas the mask is painted on, over the picture: the picture and what was painted before loaded into
 * it, strokes of the brush or the rubber, undo, start over, and the mask as a black picture of the picture's
 * own size with the painted part in white. `zoom` is how close the picture is shown (the brush keeps its
 * size on screen).
 */
export function useBrushCanvas({ picture, mask, tool, brush, zoom }: { picture: string; mask: string | null; tool: Tool; brush: number; zoom: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [painted, setPainted] = useState(Boolean(mask));
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const history = useRef<ImageData[]>([]);
  const [steps, setSteps] = useState(0);
  const last = useRef<{ x: number; y: number } | null>(null);

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

  const ctxOf = () => canvas.current!.getContext("2d", { willReadFrequently: true })!;
  /** Where the pointer is, in the canvas's own pixels, and how many of them one screen pixel is. */
  const at = (e: ReactPointerEvent) => {
    const c = canvas.current!;
    const r = c.getBoundingClientRect();
    const k = c.width / r.width;
    // sx, sy: the same place in the pixels of the picture as it is laid out, before it is brought closer
    return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k, k, sx: (e.clientX - r.left) / zoom, sy: (e.clientY - r.top) / zoom };
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
  /** What there is now, kept for an undo. */
  const remember = () => {
    const c = canvas.current!;
    history.current = [...history.current.slice(-(UNDO - 1)), ctxOf().getImageData(0, 0, c.width, c.height)];
    setSteps(history.current.length);
  };
  const begin = (e: ReactPointerEvent) => {
    remember();
    const p = at(e);
    last.current = p;
    stroke(p, p, p.k);
    if (tool === "paint") setPainted(true);
  };
  const follow = (e: ReactPointerEvent) => {
    const p = at(e);
    setCursor({ x: p.sx, y: p.sy });
    if (!last.current) return;
    stroke(last.current, p, p.k);
    last.current = p;
  };
  const end = () => {
    last.current = null;
  };
  const undo = () => {
    const before = history.current.pop();
    if (!before) return;
    ctxOf().putImageData(before, 0, 0);
    setSteps(history.current.length);
  };
  const clear = () => {
    const c = canvas.current!;
    remember();
    ctxOf().clearRect(0, 0, c.width, c.height);
  };
  /** The mask as a PNG: black, the painted part in white, at the size of the picture itself. Nothing painted at all is an error. */
  const maskPng = async (): Promise<Blob> => {
    const c = canvas.current!;
    // anything painted at all? (erasing everything leaves nothing to redo)
    const d = ctxOf().getImageData(0, 0, c.width, c.height).data;
    let any = false;
    for (let i = 3; i < d.length; i += 4) if (d[i]! > 127) { any = true; break; }
    if (!any) throw new Error("The mask is empty. Paint over the part to redo.");
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
    return blob;
  };
  return { canvas, img, failed, painted, cursor, setCursor, steps, begin, follow, end, undo, clear, maskPng };
}
