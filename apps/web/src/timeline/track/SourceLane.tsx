import type { DragEvent } from "react";
import { Film } from "lucide-react";
import { sourceWindows, type ClipValue } from "@afflatus/core";
import { STRIP_FRAMES, stripUrl, type Clip, type RecipeInfo, type Timeline } from "../../api";
import { cx } from "../../ui";
import { fileVersion, PAD } from "../model";
import { SOURCE } from "./rows";

/** A recipe that makes a long source window by window, and the inputs a clip of it keeps its part of the source in. */
export function windowed(recipe: RecipeInfo | undefined) {
  const w = recipe?.traits?.windows;
  const driving = recipe?.inputs.find((i) => i.type === "clip" && i.role === "source" && i.window);
  return recipe && w && driving?.type === "clip" && driving.window ? { shape: { fps: recipe.traits!.fps, ...w }, driving: driving.id, start: driving.window.start, seconds: driving.window.seconds } : null;
}

/** The windows a source's stretch would be made in now (before Make: the marks on the lane; scene cuts are read by the server). */
export function plannedWindows(source: NonNullable<Timeline["source"]>, recipe: RecipeInfo | undefined) {
  const w = windowed(recipe);
  return w ? sourceWindows({ fromMs: source.fromMs, toMs: source.toMs, windowMs: source.windowMs, shape: w.shape }) : [];
}

/**
 * The source lane: a long video laid under the clips (its own start at `atMs` on the timeline), the stretch made into clips
 * lit, the rest faint; each clip made from it outlined over its part, or, before Make, where the windows will fall. Empty: a
 * place to drop one. A click opens it in the column.
 */
export function SourceLane({ timeline, recipes, pps, width, selected, over, onDragOver, onSelect }: {
  timeline: Timeline;
  recipes: RecipeInfo[];
  pps: number;
  width: number;
  selected: boolean;
  /** A video is dragged over the lane. */
  over: boolean;
  onDragOver(e: DragEvent): void;
  onSelect(): void;
}) {
  const source = timeline.source;
  const x = (ms: number) => PAD + (ms / 1000) * pps;
  if (!source) {
    return (
      <button
        type="button"
        onDragOver={onDragOver}
        onClick={onSelect}
        aria-label="Source: none. Drop a long video here."
        style={{ left: PAD + 1, top: SOURCE.top, height: SOURCE.height, width: Math.max(160, width - PAD * 2 - 60) }}
        className={cx("absolute flex items-center gap-1.5 overflow-hidden rounded border border-dashed border-line-strong px-2 text-left text-[11px] text-ink-3", over && "outline outline-2 outline-accent")}
      >
        <Film size={11} className="relative shrink-0" />
        <span className="relative truncate">Drop a long video here: Motion transfer, window by window</span>
      </button>
    );
  }
  const video = source.video;
  const length = video.durationMs ?? source.toMs;
  const left = x(source.atMs);
  const w = (length / 1000) * pps;
  const cells = Math.max(1, Math.round(w / 40));
  // the clips made from it, outlined over their part of it
  const bound = timeline.clips.flatMap((c: Clip) => {
    const b = windowed(recipes.find((r) => r.id === c.recipe));
    const value = b ? (c.inputs[b.driving] as ClipValue | undefined) : undefined;
    if (!b || value?.asset !== source.asset) return [];
    const start = Number(c.inputs[b.start] ?? 0) * 1000;
    const seconds = Number(c.inputs[b.seconds] ?? 0) * 1000;
    return [{ id: c.id, from: start, to: start + seconds }];
  });
  const planned = !bound.length || source.clip ? plannedWindows(source, recipes.find((r) => r.id === source.recipe)) : [];
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onSelect()}
      onDragOver={onDragOver}
      aria-label={`Source: ${video.name}`}
      aria-pressed={selected}
      data-hint="click: the source's settings, Make N clips"
      style={{ left: Math.max(PAD, left), width: Math.max(8, w - Math.max(0, PAD - left)), top: SOURCE.top, height: SOURCE.height }}
      className={cx("absolute overflow-hidden rounded border-2", selected ? "border-accent" : "border-line-strong", over && "outline outline-2 outline-accent")}
    >
      <span className="absolute inset-y-0 flex" style={{ left: Math.min(0, left - PAD), width: w }}>
        {Array.from({ length: cells }, (_, k) => {
          const frame = Math.min(STRIP_FRAMES - 1, Math.floor(((k + 0.5) / cells) * STRIP_FRAMES));
          return <span key={k} className="h-full grow bg-raised" style={{ backgroundImage: `url(${stripUrl(video.id)}?v=${fileVersion(video)})`, backgroundSize: `${STRIP_FRAMES * 100}% 100%`, backgroundPosition: `${(frame / (STRIP_FRAMES - 1)) * 100}% 0` }} />;
        })}
        {/* outside the stretch made into clips: faint */}
        <span className="absolute inset-y-0 left-0 bg-ground/70" style={{ width: (source.fromMs / 1000) * pps }} />
        <span className="absolute inset-y-0 right-0 bg-ground/70" style={{ width: Math.max(0, ((length - source.toMs) / 1000) * pps) }} />
        {bound.map((b) => (
          <span key={b.id} className="absolute inset-y-0 rounded-sm border-2 border-accent" style={{ left: (b.from / 1000) * pps, width: Math.max(4, ((b.to - b.from) / 1000) * pps) }} />
        ))}
        {planned.map((p, k) => (
          <span key={k} className={cx("absolute inset-y-0 w-0.5", p.opens ? "bg-warn" : "bg-accent")} style={{ left: (p.fromMs / 1000) * pps - 1 }} />
        ))}
      </span>
      <span className="absolute top-0.5 left-1 rounded bg-ground/85 px-1 text-[10px] font-semibold">{video.name}</span>
    </div>
  );
}
