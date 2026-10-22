import { ArrowLeftRight } from "lucide-react";
import { frameOf, megapixels, withinPixels, type InputSpec, type SizeValue } from "@afflatus/core";
import { scaleOf, upscaledFrame } from "../form";
import { Select } from "../Select";
import { cx, IconButton, NumberBox, Segmented } from "../ui";
import { Label } from "./Label";

/** Proportions to choose from beyond the ones a recipe names, tallest to widest. */
const RATIOS: Array<{ label: string; w: number; h: number }> = [
  { label: "Portrait 9:16", w: 9, h: 16 }, { label: "Portrait 2:3", w: 2, h: 3 }, { label: "Portrait 3:4", w: 3, h: 4 }, { label: "Portrait 4:5", w: 4, h: 5 },
  { label: "Square 1:1", w: 1, h: 1 },
  { label: "Landscape 5:4", w: 5, h: 4 }, { label: "Landscape 4:3", w: 4, h: 3 }, { label: "Landscape 3:2", w: 3, h: 2 }, { label: "Widescreen 16:9", w: 16, h: 9 }, { label: "Ultrawide 21:9", w: 21, h: 9 },
];

/** An edge typed in pixels, as the size field keeps it: on the recipe's grid, within its least and most. */
export const snapEdge = (spec: { grid: number; min: number; max: number }, n: number) => Math.min(spec.max, Math.max(spec.min, Math.round(n / spec.grid) * spec.grid));

/**
 * The shape and size of what is made:the recipe's own shapes as buttons, any other proportion from a
 * list (at the same number of pixels, so the amount of detail and the time stay about the same), and the
 * width and height themselves, typed. A recipe that only takes the proportions gets no pixels to type.
 */
export function SizeField({ spec, value: size, values, onChange }: { spec: Extract<InputSpec, { type: "size" }>; value: SizeValue; values?: Record<string, unknown>; onChange(value: SizeValue): void }) {
  const shape = spec.shapes.find((s) => s.width === size.width && s.height === size.height);
  // a recipe that takes the proportions alone: the frame that comes out is the short side asked for, in these proportions
  const short = spec.ratioOnly && spec.short ? Number(values?.[spec.short]) : NaN;
  const frameOfShape = (s: { width: number; height: number }) => (Number.isFinite(short) && short > 0 ? frameOf(s, short, { grid: spec.grid, maxPixels: spec.maxPixels ?? Infinity }) : null);
  const comesOut = frameOfShape(size);
  // a pass that enlarges it afterwards: the frame it ends at
  const by = scaleOf(spec, values);
  const scaled = comesOut && by ? upscaledFrame(comesOut, by) : null;
  // what decides the shape instead, when something is there: a start image, a clip joined
  const decidedBy = (spec.decidedBy ?? []).find((id) => { const v = values?.[id]; return Array.isArray(v) ? v.length > 0 : Boolean(v); });
  const deciderLabel = decidedBy ? (/previous|next|clip/i.test(decidedBy) ? "the clip it joins" : "the start image") : null;
  const snap = (n: number) => snapEdge(spec, n);
  // an edge typed past the most pixels the model takes: it is kept and the other edge gives way, as the render would hold it
  const typed = (v: SizeValue, keep: "width" | "height") => (spec.maxPixels ? withinPixels(v, { grid: spec.grid, maxPixels: spec.maxPixels, min: spec.min }, keep) : v);
  // the pixels to keep when the proportions change: those of the size now, or of the recipe's own shape before one is set
  const first = spec.shapes.find((s) => s.id === spec.default) ?? spec.shapes[0]!;
  const area = size.width && size.height ? size.width * size.height : first.width * first.height;
  const sized = (r: { w: number; h: number }) => {
    const height = Math.sqrt((area * r.h) / r.w);
    return { width: snap((height * r.w) / r.h), height: snap(height) };
  };
  const others = RATIOS.map((r) => ({ ...r, ...sized(r) })).filter((r) => !spec.shapes.some((s) => s.width === r.width && s.height === r.height));
  const picked = others.find((r) => r.width === size.width && r.height === size.height);
  const said = (w: number, h: number) => `${w} × ${h} · ${megapixels(w, h)}`;
  return (
    <div className={cx("flex flex-col gap-1.5", deciderLabel && "opacity-60")} data-tip={deciderLabel ? `${deciderLabel[0]!.toUpperCase()}${deciderLabel.slice(1)} decides the shape: this does nothing now.` : undefined}>
      <Label note={spec.note} aside={deciderLabel ? `set by ${deciderLabel}${spec.ratioOnly ? ": only the resolution counts" : ""}` : spec.ratioOnly ? undefined : said(size.width, size.height)}>{spec.label}</Label>
      <div className="flex flex-wrap items-center gap-2">
        <Segmented label={spec.label} value={shape?.id ?? ""} options={spec.shapes.map((s) => ({ value: s.id, label: s.label }))} onChange={(shapeId) => {
          const s = spec.shapes.find((x) => x.id === shapeId)!;
          onChange({ width: s.width, height: s.height });
        }} />
        <div className="w-full">
          <Select
            size="sm"
            label="More shapes"
            placeholder="More shapes…"
            searchHint="a proportion, 16:9, portrait…"
            value={picked ? picked.label : ""}
            onChange={(label) => {
              const r = others.find((x) => x.label === label);
              if (r) onChange({ width: r.width, height: r.height });
            }}
            options={others.map((r) => {
              const f = spec.ratioOnly ? frameOfShape(r) : r;
              return { value: r.label, label: r.label, note: f ? `${f.width} × ${f.height}` : undefined };
            })}
          />
        </div>
      </div>
      {comesOut && !deciderLabel && (
        <span className="text-xs text-ink-2">
          Comes out as <span className="font-mono text-ink">{said(comesOut.width, comesOut.height)}</span>{comesOut.width !== Math.round(short) && comesOut.height !== Math.round(short) ? " (held within what the model takes)" : ""}
          {scaled && <>, upscaled to <span className="font-mono text-ink">{said(scaled.width, scaled.height)}</span></>}
        </span>
      )}
      {!spec.ratioOnly && (
        <div className="flex items-center gap-2 text-ink-2">
          <NumberBox label="Width, in pixels" value={size.width} min={spec.min} max={spec.max} step={spec.grid} unit="px" onCommit={(width) => onChange(typed({ width: snap(width), height: size.height }, "width"))} />
          <IconButton tone="outline" label="Swap width and height" onClick={() => onChange({ width: size.height, height: size.width })}>
            <ArrowLeftRight size={14} />
          </IconButton>
          <NumberBox label="Height, in pixels" value={size.height} min={spec.min} max={spec.max} step={spec.grid} unit="px" onCommit={(height) => onChange(typed({ width: size.width, height: snap(height) }, "height"))} />
          <span className="text-xs">width × height</span>
        </div>
      )}
    </div>
  );
}
