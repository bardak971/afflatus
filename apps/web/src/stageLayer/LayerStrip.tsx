import type { ReactNode } from "react";
import { Eye, EyeOff, RotateCcw } from "lucide-react";
import { cx } from "../cx";
import { plural } from "../format";
import { Slider } from "../Slider";
import { Help, IconButton, Segmented, Toggle } from "../ui";
import { FRAME_ASPECTS, FRAME_RULES, padded } from "./frame";
import type { ClickTool, DetectTool, FindWhat, WandTool } from "./useFindTools";
import type { FrameTool } from "./useFrameTool";
import { MASK_VIEW_NAMES, nextView, type MaskView } from "./maskView";
import { BRUSH_LIMITS, type MaskLayer } from "./useMaskLayer";
import type { Size } from "../viewer/zoom";

/**
 * The strip over the Stage while the layer is on: what it is doing (its title), then the active tool's options. The same
 * strip for every use of the layer; the options are the job's (the mask's brush, the outpaint frame's shapes).
 */
export function LayerStrip({ title, tone, children, end, className }: {
  title: ReactNode;
  /** "box": Edit in box's boxes are what the bar works on, in their own blue with their ✦. */
  tone?: "box";
  children?: ReactNode;
  end?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("flex min-h-11 flex-wrap items-center gap-x-4 gap-y-1 px-1", className)}>
      <span className={cx("inline-flex h-[26px] shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-bold transition-colors", tone === "box" ? "bg-picture/12 text-picture" : "bg-accent-wash text-accent")}>
        {tone === "box" && <span aria-hidden>✦</span>}
        {title}
      </span>
      {children}
      {/* the end pushed right by its own margin, so an option that asks for the end (the eye's ml-auto) gets it too */}
      {end && <span className="ml-auto flex items-center gap-2">{end}</span>}
    </div>
  );
}

/**
 * A slider's width on the strip: its track, the number box and its unit together (the Slider's className sizes all three),
 * so the unit never runs into the next option's name.
 */
const SLIDER = "w-48 shrink-0";

/** One option on the strip: its name, then its control, kept whole (the strip wraps between options, never inside one). */
function Option({ name, help, children }: { name: string; help?: string; children: ReactNode }) {
  return (
    <span className="flex shrink-0 items-center gap-2 whitespace-nowrap text-ink-2">
      {name}
      {help && <Help text={help} />}
      {children}
    </span>
  );
}

/** Each view's swatch on the eye: the tint, the picture darkened round the mask, black and white, nothing. */
const SWATCH: Record<MaskView, string> = {
  tint: "color-mix(in srgb, var(--color-accent) 55%, transparent)",
  spot: "linear-gradient(90deg, #000 50%, color-mix(in srgb, var(--color-accent) 40%, white) 50%)",
  bw: "linear-gradient(90deg, #000 50%, #fff 50%)",
  off: "transparent",
};

/**
 * The eye: how the mask is shown, its view named beside it; a click (or M) shows the next one. Pushed to the strip's end,
 * where it stays whatever the tool's options before it.
 */
export function MaskEye({ mask }: { mask: MaskLayer }) {
  const off = mask.view === "off";
  return (
    <button
      type="button"
      data-mask-eye
      data-soft-focus
      aria-label={`Show the mask: ${MASK_VIEW_NAMES[mask.view]}`}
      data-tip="Show the mask: Tint, Spotlight (the rest darkened), B&W (the mask as sent), Off. A click for the next"
      data-tip-keys="M"
      onClick={() => mask.setView(nextView)}
      className="ml-auto inline-flex h-7 shrink-0 items-center gap-1.5 rounded-control border border-line bg-panel px-2 text-xs font-semibold text-ink-2 transition-colors hover:text-ink"
    >
      {off ? <EyeOff size={14} /> : <Eye size={14} />}
      <span aria-hidden className={cx("size-2.5 shrink-0 rounded-xs", off && "border border-line-strong")} style={{ background: SWATCH[mask.view] }} />
      <span className="w-16 text-left">{MASK_VIEW_NAMES[mask.view]}</span>
    </button>
  );
}

/**
 * The mask's options: the brush's size and feather (in the picture's pixels, as the brush paints them), the grow the fix
 * applies (the job's, not the mask's own: `grow` is its value), and the eye (M).
 */
export function MaskOptions({ mask, grow, onGrow }: { mask: MaskLayer; grow?: number; onGrow?(px: number): void }) {
  return (
    <>
      <Option name="Size">
        <Slider label="Size of the brush" value={mask.brush.size} min={BRUSH_LIMITS.size.min} max={BRUSH_LIMITS.size.max} step={1} unit=" px" onChange={(size) => mask.setBrush({ size })} className={SLIDER} />
      </Option>
      <Option name="Feather" help="The mask's own soft edge, painted into it past the brush's core: the dashed ring shows where it fades out, and a box, a lasso or a found mask fades out by the same. Not the fix's Mask blur (⚙): that one blurs the whole mask again when the new part is put back, on top of this.">
        <Slider label="Feather of the brush" value={mask.brush.feather} min={BRUSH_LIMITS.feather.min} max={BRUSH_LIMITS.feather.max} step={1} unit=" px" onChange={(feather) => mask.setBrush({ feather })} className={SLIDER} />
      </Option>
      {grow !== undefined && onGrow && (
        <Option name="Grow" help="Grows the whole mask outward before the fix.">
          <Slider label="Grow the mask" value={grow} min={0} max={128} step={1} unit=" px" onChange={onGrow} className={SLIDER} />
        </Option>
      )}
      <MaskEye mask={mask} />
    </>
  );
}

/**
 * The outpaint frame's options: the shape it is held to (Free: each side as dragged), the size it brings the picture to,
 * and back to the picture's own edges. `step` and `most`: the frame tool's rules, said in its ?.
 *
 */
export function FrameOptions({ frame, natural }: { frame: FrameTool; natural: Size | null }) {
  const { step, most } = FRAME_RULES;
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

/** A find's state on the strip: finding, or why it failed. */
function Finding({ busy, error }: { busy: boolean; error: string | null }) {
  if (error) return <span className="text-warn-ink">{error}</span>;
  return busy ? <span className="text-ink-2" aria-live="polite">Finding…</span> : null;
}

/** Click to mask's options: how it is used, the points so far, and starting again. */
export function ClickOptions({ click }: { click: ClickTool }) {
  const n = click.points.length;
  return (
    <>
      <span className="text-ink-2"><b className="text-ink">Click</b> adds · <b className="text-ink">Shift-click</b> takes away</span>
      <Help text="SAM 3, run in ComfyUI: each click finds the whole thing it lands on. The mask it finds takes the brush's feather; paint, rub out or invert it as any mask." />
      {n > 0 && <button type="button" className="text-ink-2 underline-offset-2 hover:text-ink hover:underline" onClick={click.done}>{plural(n, "point")} · start again</button>}
      <Finding busy={click.busy} error={click.error} />
    </>
  );
}

const KINDS: Array<{ value: FindWhat; label: string }> = [{ value: "face", label: "Face" }, { value: "hands", label: "Hands" }, { value: "person", label: "Person" }];

/** The detector's options: what it looks for, with how many it found of each. */
export function DetectOptions({ detect }: { detect: DetectTool }) {
  return (
    <>
      <Segmented<FindWhat>
        label="What to find" size="sm" oneLine value={detect.what}
        options={KINDS.map((k) => ({ value: k.value, label: detect.found[k.value] ? `${k.label} · ${detect.found[k.value]!.length}` : k.label }))}
        onChange={(w) => detect.look(w)}
      />
      <span className="text-ink-2">Click a box to mask it, again to take it away</span>
      <Finding busy={detect.busy} error={detect.error} />
    </>
  );
}

/** The wand's options: its tolerance, and whether it keeps to what touches the click. */
export function WandOptions({ wand }: { wand: WandTool }) {
  return (
    <>
      <Option name="Tolerance" help="How far a colour may be from the one clicked, on each of red, green and blue: 0 is that colour alone, 100 every colour.">
        <Slider label="Tolerance of the wand" value={wand.tolerance} min={0} max={100} step={1} onChange={wand.setTolerance} className={SLIDER} />
      </Option>
      <span className="flex items-center gap-2 text-ink-2">
        Contiguous
        <Toggle bare label="Contiguous" tip="Only what touches the click; off, every close colour in the picture" on={wand.contiguous} onChange={wand.setContiguous} />
      </span>
      <span className="text-ink-2"><b className="text-ink">Shift</b> adds · <b className="text-ink">Alt</b> takes away</span>
      {wand.error && <span className="text-warn-ink">{wand.error}</span>}
    </>
  );
}
