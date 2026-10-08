import { useMemo, useState } from "react";
import type { RenderItem } from "../../api";
import { took } from "../../format";
import { cx } from "../../ui";
import { useChartColors } from "./Chart";
import { useBrush } from "./useBrush";

/**
 * The renders of the window as bars, one lane per model, each as long as it took and where it ran: what
 * took the time, at a glance. Hover for the render, click to open what it made, drag to zoom in.
 */
export function Lanes({ items, from, to, models, names, timeLabel, onZoom, onOpen }: {
  items: RenderItem[];
  from: number;
  to: number;
  /** The models in the order of the table, which is also the order of their colours. */
  models: string[];
  names: Record<string, string>;
  timeLabel(time: number, full?: boolean): string;
  onZoom(from: number, to: number): void;
  onOpen(assetId: string): void;
}) {
  const palette = useChartColors();
  /** The bar under the pointer, and where it sits across the chart (0 to 1), for the tooltip to stand beside it. */
  const [hover, setHover] = useState<{ item: RenderItem; at: number; lane: number } | null>(null);
  const brush = useBrush();
  const drag = brush.drag;
  const span = Math.max(1, to - from);
  const laneOf = useMemo(() => {
    const seen = [...new Set([...models, ...items.map((r) => r.recipe)])];
    return Object.fromEntries(seen.map((k, i) => [k, i]));
  }, [models, items]);
  const laneKeys = Object.keys(laneOf);
  const ROW = 18;
  const height = Math.max(1, laneKeys.length) * ROW + 22;
  const ticks = 6;
  return (
    <section className="flex min-w-0 flex-col gap-1.5 rounded-xl border border-line bg-panel p-3.5">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-[13px] font-semibold">What rendered when</h3>
        <span className="truncate text-xs text-ink-3">one bar per render, as long as it took · hover for which, click to open what it made, drag to zoom in</span>
      </div>
      <div className="grid grid-cols-[minmax(120px,180px)_minmax(0,1fr)] gap-2">
        <div className="flex flex-col pt-0.5 text-xs text-ink-2" style={{ height }}>
          {laneKeys.map((k) => {
            const short = (names[k] ?? k).split(" · ")[0]!;
            const twice = laneKeys.filter((o) => (names[o] ?? o).split(" · ")[0] === short).length > 1;
            return <span key={k} className="truncate" style={{ height: ROW, lineHeight: `${ROW}px` }} title={names[k] ?? k}>{twice ? names[k] ?? k : short}</span>;
          })}
        </div>
        <div className="relative min-w-0">
        <div
          className="relative select-none overflow-hidden rounded-md bg-ground"
          style={{ height, cursor: drag ? "col-resize" : "crosshair" }}
          onMouseDown={(e) => brush.start(e)}
          onMouseMove={(e) => brush.move(e)}
          onMouseUp={(e) => {
            const width = e.currentTarget.getBoundingClientRect().width;
            const dragged = brush.end();
            if (dragged) onZoom(from + (dragged[0] / width) * span, from + (dragged[1] / width) * span);
          }}
          onMouseLeave={brush.cancel}
        >
          {Array.from({ length: ticks }, (_x, k) => from + (k / (ticks - 1)) * span).map((time, k) => (
            <span key={k} className="pointer-events-none absolute bottom-0 border-l border-line pl-1 font-mono text-[10px] text-ink-3" style={{ left: `${(k / (ticks - 1)) * 100}%`, height: "100%", ...(k === ticks - 1 ? { transform: "translateX(-100%)", borderLeft: 0, paddingLeft: 0, paddingRight: 4 } : {}) }}>
              <span className="absolute bottom-0.5">{timeLabel(time)}</span>
            </span>
          ))}
          {items.map((r) => {
            const end = Date.parse(r.at);
            const start = end - r.totalMs;
            const left = ((Math.max(from, start) - from) / span) * 100;
            const width = Math.max(0.15, ((Math.min(to, end) - Math.max(from, start)) / span) * 100);
            const lane = laneOf[r.recipe] ?? 0;
            const color = palette[models.indexOf(r.recipe) >= 0 ? models.indexOf(r.recipe) % palette.length : lane % palette.length] ?? "currentColor";
            return (
              <button
                key={r.id}
                type="button"
                aria-label={`${r.name}, ${took(r.totalMs)}, ${r.status}`}
                onMouseEnter={() => setHover({ item: r, at: (left + width / 2) / 100, lane })}
                onMouseLeave={() => setHover((h) => (h?.item.id === r.id ? null : h))}
                onClick={(e) => {
                  e.stopPropagation();
                  if (r.assetId) onOpen(r.assetId);
                  else document.getElementById(`render-${r.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
                }}
                onMouseDown={(e) => e.stopPropagation()}
                className={cx("absolute rounded-sm", r.status !== "done" && "opacity-60 outline outline-1 outline-warn")}
                style={{ left: `${left}%`, width: `${width}%`, top: 2 + lane * ROW, height: ROW - 4, background: r.status === "done" && !r.spilled ? color : "var(--color-warn)", minWidth: 2 }}
              />
            );
          })}
          {drag && Math.abs(drag.x1 - drag.x0) >= 2 && <div className="pointer-events-none absolute inset-y-0 border-x border-accent bg-accent/15" style={{ left: Math.min(drag.x0, drag.x1), width: Math.abs(drag.x1 - drag.x0) }} />}
        </div>
          {/* outside the box that clips its bars, so that it can hang below a short chart */}
          {hover && !drag && (() => {
            const h = hover.item;
            // beside the bar, under its lane; on the other side of the pointer past the middle
            const place = hover.at > 0.5 ? { right: `${(1 - hover.at) * 100}%`, marginRight: 10 } : { left: `${hover.at * 100}%`, marginLeft: 10 };
            return (
              <div className="pointer-events-none absolute z-20 flex max-w-[360px] flex-col gap-0.5 rounded-lg border border-line-strong bg-raised px-2.5 py-2 text-xs shadow-xl shadow-shade/40" style={{ top: 2 + (hover.lane + 1) * ROW, ...place }}>
                <span className="font-semibold">{h.name}</span>
                <span className="truncate text-ink-2">{[h.model, h.width && h.height ? `${h.width} × ${h.height}` : "", h.seconds ? `${h.seconds} s` : "", `${h.steps} steps`].filter(Boolean).join(" · ")}</span>
                <span className="font-mono">{h.status === "done" ? took(h.totalMs) : `${h.status} after ${took(h.totalMs)}`}{h.cold ? " · cold start" : ""}</span>
                {h.spilled && <span className="text-warn-ink">Ran out of video memory, it seems: {h.expectedMs ? `expected ${took(h.expectedMs)}` : "far slower than usual"}, with the memory full</span>}
                <span className="text-ink-3">{timeLabel(Date.parse(h.at) - h.totalMs, true)} → {timeLabel(Date.parse(h.at), true)}</span>
                <span className="text-ink-3">{[`load ${took(h.phases.loading)}`, `sampling ${took(h.phases.sampling)}`, h.phases.refining > 500 ? `refine ${took(h.phases.refining)}` : "", `finish ${took(h.phases.finishing)}`].filter(Boolean).join(" · ")}</span>
              </div>
            );
          })()}
        </div>
      </div>
    </section>
  );
}
