import { useRef, useState } from "react";
import { Frame as FrameIcon } from "lucide-react";
import { cx } from "../cx";
import { useLiveValue } from "../hooks";
import type { Size } from "../viewer/zoom";
import type { LayerPlace } from "../viewer/ZoomPicture";
import { BoxHandles } from "./BoxHandles";
import { frameOf, handleOn, perScreen, percentOf, ratioOf, type Frame, type Handle } from "./geometry";
import { dragFrame, FRAME_RULES, NO_PADS, paddedFrame, padsForRatio, type Pads } from "./frame";
import type { LayerPointer, LayerTool } from "./tools";

/** How near a handle or an edge a press takes it, in screen pixels. */
const GRAB_PX = 12;
/** How large a handle is drawn, in screen pixels. */
const HANDLE_PX = 11;
/** Room left round the frame on the Stage, as a part of its size, so its edges can be dragged further out. */
const ROOM_AROUND = 0.12;

/** What the frame gives the job: the outpaint forms' own rows (pictureForm's outpaint), "Custom" since it says the sides. */
export interface FrameSides extends Pads {
  shape: "Custom";
}

/**
 * The handle or edge a press at `p` (picture pixels) takes, within `grab` picture pixels: a corner before a side, a side
 * anywhere along its length.
 */
export function handleAt(p: { x: number; y: number }, natural: Size, pads: Pads, grab: number): Handle | null {
  const f = paddedFrame(natural, pads);
  return handleOn(p, { x: -f.x, y: -f.y, w: f.w, h: f.h }, grab);
}

/** The frame the Stage fits for a frame of pads: the frame and a margin round it, the picture where it sits in both. */
export function roomFor(natural: Size, pads: Pads): Frame {
  const f = paddedFrame(natural, pads);
  const mx = Math.round(Math.max(f.w, f.h) * ROOM_AROUND);
  return { w: f.w + 2 * mx, h: f.h + 2 * mx, x: f.x + mx, y: f.y + mx };
}

export interface FrameTool {
  tool: LayerTool;
  pads: Pads;
  /** The aspect chip on ("Free", "16:9"…). */
  aspect: string;
  /** A chip picked: the frame brought to that shape round the picture (Free keeps it as it is). */
  setAspect(chip: string): void;
  /** Back to the picture's own edges. */
  reset(): void;
  /** For ZoomPicture's `canvas`: the frame with room round it, held still while a handle is dragged. */
  canvas: Frame | undefined;
  /** The frame's size now. */
  size: Size;
}

/**
 * The outpaint frame (R): its eight handles and its edges dragged out round the picture, snapped so the frame's size stays
 * on the model's step (FRAME_RULES; Alt held, not snapped), each side under the recipes' most, optionally held to an
 * aspect. Its `pads` are the sides as the outpaint rows take them.
 */
export function useFrameTool({ natural }: { natural: Size | null }): FrameTool {
  const rules = FRAME_RULES;
  const [now, setPads] = useLiveValue<Pads>();
  const pads = now.current ?? NO_PADS;
  // the handlers read the ref: the release can come in the same frame as the last move, before a render
  const padsNow = () => now.current ?? NO_PADS;
  const [aspect, setAspectState] = useState("Free");
  // the Stage's frame is held while dragging: fitted again at every move, the picture would slide from under the pointer
  const [held, setHeld] = useState<Pads | null>(null);
  const drag = useRef<{ handle: Handle; from: { x: number; y: number }; start: Pads } | null>(null);
  const place = useRef<LayerPlace | null>(null);
  const ratio = ratioOf(aspect);

  const tool: LayerTool = {
    id: "frame", key: "R", label: "Outpaint frame", icon: FrameIcon, cursor: "default",
    tip: `Drag the frame's edges out: what is added round the picture is painted. Snaps to ${rules.step} px (Alt: free)`,
    disabled: natural ? undefined : "The picture is not loaded yet",
    down: (p: LayerPointer) => {
      const at = place.current;
      if (!natural || !at) return;
      // the grab in picture pixels: so many screen pixels whatever the zoom
      const handle = handleAt(p, natural, padsNow(), GRAB_PX * perScreen(at.frame, at.fit, at.shown));
      if (!handle) return;
      drag.current = { handle, from: { x: p.x, y: p.y }, start: padsNow() };
      setHeld(padsNow());
    },
    move: (p: LayerPointer) => {
      const d = drag.current;
      if (!d || !natural) return;
      setPads(dragFrame(d.start, d.handle, p.x - d.from.x, p.y - d.from.y, natural, { ...rules, step: p.alt ? 1 : rules.step, ratio }));
    },
    up: () => {
      if (!drag.current) return;
      drag.current = null;
      setHeld(null);
    },
    cancel: () => {
      const d = drag.current;
      drag.current = null;
      setHeld(null);
      if (d) setPads(d.start);
    },
    draw: (at) => {
      place.current = at;
      if (!natural) return null;
      const f = paddedFrame(natural, pads);
      const box = { x: -f.x, y: -f.y, w: f.w, h: f.h };
      const line = 1 / at.shown.scale;
      // what a side adds, in the middle of what it adds (on the edge itself when it adds nothing)
      const edge = (text: number, x: number, y: number) => (
        <span
          className={cx("pointer-events-none absolute rounded bg-shade/70 px-1 font-mono", text > 0 ? "text-ink-strong" : "text-ink-3")}
          style={{ left: `${(x / f.w) * 100}%`, top: `${(y / f.h) * 100}%`, transform: "translate(-50%, -50%)", fontSize: 11 / at.shown.scale }}
        >
          {text > 0 ? `+${text}` : "0"}
        </span>
      );
      return (
        <div data-outpaint-frame className="pointer-events-none absolute" style={percentOf(box, at.frame)}>
          {/* the part to be painted, the frame less the picture, shown as empty: a band on each side that adds */}
          {[
            { x: 0, y: 0, w: f.w, h: pads.padTop },
            { x: 0, y: f.h - pads.padBottom, w: f.w, h: pads.padBottom },
            { x: 0, y: pads.padTop, w: pads.padLeft, h: natural.h },
            { x: f.w - pads.padRight, y: pads.padTop, w: pads.padRight, h: natural.h },
          ].filter((b) => b.w > 0 && b.h > 0).map((b, i) => (
            <div
              key={i}
              className="absolute bg-[repeating-conic-gradient(var(--color-raised)_0_25%,var(--color-panel)_0_50%)] bg-size-[24px_24px]"
              style={percentOf(b, frameOf(f))}
            />
          ))}
          <div className="absolute inset-0 border-dashed border-accent" style={{ borderWidth: line * 2 }} />
          <BoxHandles scale={at.shown.scale} px={HANDLE_PX} grabbable />
          {edge(pads.padLeft, pads.padLeft / 2, f.h / 2)}
          {edge(pads.padRight, f.w - pads.padRight / 2, f.h / 2)}
          {edge(pads.padTop, f.w / 2, pads.padTop / 2)}
          {edge(pads.padBottom, f.w / 2, f.h - pads.padBottom / 2)}
        </div>
      );
    },
  };

  const shown = held ?? pads;
  return {
    tool,
    pads,
    aspect,
    setAspect: (chip) => {
      setAspectState(chip);
      const r = ratioOf(chip);
      if (!r || !natural) return;
      const next = padsForRatio(natural, r, rules);
      setPads(next);
    },
    reset: () => {
      setPads(NO_PADS);
      setAspectState("Free");
    },
    canvas: natural ? roomFor(natural, shown) : undefined,
    size: natural ? { w: natural.w + pads.padLeft + pads.padRight, h: natural.h + pads.padTop + pads.padBottom } : { w: 0, h: 0 },
  };
}
