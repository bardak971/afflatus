import type { ReactNode } from "react";
import { Eye, EyeOff, RotateCcw } from "lucide-react";
import { cx } from "../cx";
import { Slider } from "../Slider";
import { Help, IconButton, Segmented } from "../ui";
import { FRAME_ASPECTS, padded } from "./frame";
import type { FrameTool } from "./useFrameTool";
import { BRUSH_LIMITS, type MaskLayer } from "./useMaskLayer";
import type { Size } from "../viewer/zoom";

/**
 * The strip over the Stage while the layer is on: what it is doing (its title), then the active tool's options. The same
 * strip for every use of the layer; the options are the job's (the mask's brush, the outpaint frame's shapes).
 */
export function LayerStrip({ title, children, end, className }: { title: ReactNode; children?: ReactNode; end?: ReactNode; className?: string }) {
  return (
    <div className={cx("flex min-h-11 flex-wrap items-center gap-x-4 gap-y-1 px-1", className)}>
      <span className="rounded-md bg-accent-wash px-2 py-0.5 text-xs font-semibold text-accent">{title}</span>
      {children}
      <span className="grow" />
      {end}
    </div>
  );
}

/** One option on the strip: its name, then its control. */
function Option({ name, help, children }: { name: string; help?: string; children: ReactNode }) {
  return (
    <span className="flex items-center gap-2 text-ink-2">
      {name}
      {help && <Help text={help} />}
      {children}
    </span>
  );
}

/**
 * The mask's options: the brush's size and feather (in the picture's pixels, as the brush paints them), the grow the fix
 * applies (the job's, not the mask's own: `grow` is its value), and the mask shown or hidden (M).
 */
export function MaskOptions({ mask, grow, onGrow }: { mask: MaskLayer; grow?: number; onGrow?(px: number): void }) {
  return (
    <>
      <Option name="Size">
        <Slider label="Size of the brush" value={mask.brush.size} min={BRUSH_LIMITS.size.min} max={BRUSH_LIMITS.size.max} step={1} unit=" px" onChange={(size) => mask.setBrush({ size })} className="w-40" />
      </Option>
      <Option name="Feather" help="The brush's soft edge, past its core: the dashed ring shows where it fades out. A box and a lasso fade out by the same.">
        <Slider label="Feather of the brush" value={mask.brush.feather} min={BRUSH_LIMITS.feather.min} max={BRUSH_LIMITS.feather.max} step={1} unit=" px" onChange={(feather) => mask.setBrush({ feather })} className="w-32" />
      </Option>
      {grow !== undefined && onGrow && (
        <Option name="Grow" help="Grows the whole mask outward before the fix.">
          <Slider label="Grow the mask" value={grow} min={0} max={128} step={1} unit=" px" onChange={onGrow} className="w-28" />
        </Option>
      )}
      <IconButton className="ml-1" label={mask.shown ? "Hide the mask" : "Show the mask"} keys="M" pressed={!mask.shown} onClick={() => mask.setShown(!mask.shown)}>
        {mask.shown ? <Eye size={15} /> : <EyeOff size={15} />}
      </IconButton>
    </>
  );
}

/**
 * The outpaint frame's options: the shape it is held to (Free: each side as dragged), the size it brings the picture to,
 * and back to the picture's own edges. `step` and `most`: the frame tool's rules, said in its ?.
 */
export function FrameOptions({ frame, natural, step = 64, most = 1024 }: { frame: FrameTool; natural: Size | null; step?: number; most?: number }) {
  return (
    <>
      <Segmented<string> label="Shape of the frame" size="sm" oneLine value={frame.aspect} options={FRAME_ASPECTS.map((a) => ({ value: a, label: a }))} onChange={frame.setAspect} />
      {natural && (
        <span className="font-mono text-xs text-ink-2 tabular-nums">
          {natural.w} × {natural.h} → <b className="text-ink">{frame.size.w} × {frame.size.h}</b>
        </span>
      )}
      <Help text={`The frame's size snaps to ${step} px, the step the model draws in; Alt held while dragging: not snapped. Each side adds at most ${most} px.`} />
      <IconButton label="Back to the picture's edges" disabled={!padded(frame.pads)} onClick={frame.reset}>
        <RotateCcw size={15} />
      </IconButton>
    </>
  );
}
