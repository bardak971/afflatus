import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { cx } from "../../ui";
import { themeInUse, useThemeChoice } from "../../theme/store";
import { brushWindow, curve, statOf } from "./chartMath";
import { useBrush } from "./useBrush";
import { PLOT, useChartScale, type Series } from "./useChartScale";

/**
 * A panel with lines over time, after Grafana's: soft fills under the lines, a crosshair that reads
 * every series where the pointer is, and a legend whose entries can be clicked to look at one alone.
 */

/** The colours lines are drawn in: the accents of the theme that is up, the one in use first. */
export function useChartColors(): string[] {
  const choice = useThemeChoice();
  return useMemo(() => {
    const theme = themeInUse(choice);
    const mine = choice.accents[theme.family];
    const all = Object.entries(theme.accents);
    const first = all.find(([name]) => name === mine) ?? all[0];
    return [...new Set([first?.[1], ...all.map(([, c]) => c)].filter((c): c is string => Boolean(c)))];
  }, [choice]);
}

export function TimeChart({ title, note, times, series, format, axisFormat, stacked, stat = "mean", height = 190, timeLabel, top, bottom = 0, fill, children, step, onBrush, detail }: {
  title: string;
  note?: string;
  /** The start of each stretch of time, ms since the epoch. */
  times: number[];
  series: Series[];
  format(value: number): string;
  /** The same, short, for the scale on the left. */
  axisFormat?(value: number): string;
  /** Each series on top of the one before: parts of a whole. */
  stacked?: boolean;
  /** What the legend says beside each name. */
  stat?: "mean" | "sum" | "last" | "max";
  height?: number;
  timeLabel(time: number, long?: boolean): string;
  /** The top of the scale, when it is known (100 for a share). */
  top?: number;
  /** Where the scale starts, when not at nothing. */
  bottom?: number;
  /** A soft fill under each line. Left to itself: only where few lines share the panel. */
  fill?: boolean;
  children?: ReactNode;
  /** The length of a stretch, so that a drag ends after the last stretch it covers. */
  step?: number;
  /** A drag across the panel: look at that window of time alone. */
  onBrush?(from: number, to: number): void;
  /** More about the stretch under the pointer, under the figures. */
  detail?(index: number): ReactNode;
}) {
  const id = useId().replace(/:/g, "");
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(560);
  const [solo, setSolo] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  /** A drag under way: where it began and where the pointer is, in pixels across the panel. */
  const brush = useBrush(Boolean(onBrush));
  const drag = brush.drag;
  const palette = useChartColors();
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const watch = new ResizeObserver(() => setWidth(Math.max(240, el.clientWidth)));
    watch.observe(el);
    setWidth(Math.max(240, el.clientWidth));
    return () => watch.disconnect();
  }, []);

  const { coloured, shown, stacks, max, x, y, W, H, n } = useChartScale({ series, times, width, height, palette, solo, stacked, top, bottom });
  const { L, T } = PLOT;
  const filled = fill ?? (stacked || series.length <= 3);
  const onAxis = axisFormat ?? format;
  // as many labels along the bottom as fit without touching, for labels of the length these are
  const labelWidth = Math.max(60, (n ? timeLabel(times[0]!).length : 8) * 6.5 + 24);
  const ticks = Math.max(2, Math.min(n, Math.floor(W / labelWidth)));

  return (
    <section className="flex min-w-0 flex-col gap-1.5 rounded-xl border border-line bg-panel p-3.5">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-[13px] font-semibold">{title}</h3>
        {note && <span className="truncate text-xs text-ink-3">{note}</span>}
      </div>
      <div ref={box} className="relative" style={{ height }}>
        <svg
          width={width}
          height={height}
          className="block"
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const px = e.clientX - rect.left;
            setHover(Math.max(0, Math.min(n - 1, Math.round(((px - L) / W) * (n - 1)))));
            brush.move(e);
          }}
          onMouseLeave={() => {
            setHover(null);
            brush.cancel();
          }}
          onMouseDown={(e) => {
            if (brush.start(e)) e.preventDefault();
          }}
          onMouseUp={() => {
            if (!drag || !onBrush) return;
            const span = brush.end();
            const window = span && brushWindow(span[0], span[1], { left: L, width: W }, times, step);
            if (window) onBrush(window.from, window.to);
          }}
          style={onBrush ? { cursor: drag ? "col-resize" : "crosshair" } : undefined}
        >
          <defs>
            {stacks.map((s, i) => (
              <linearGradient key={s.name} id={`${id}-${i}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor={s.color} stopOpacity={stacked ? 0.55 : 0.3} />
                <stop offset="1" stopColor={s.color} stopOpacity={stacked ? 0.25 : 0.02} />
              </linearGradient>
            ))}
          </defs>
          {[0, 0.25, 0.5, 0.75, 1].map((g) => (
            <g key={g}>
              <line x1={L} x2={L + W} y1={y(bottom + (max - bottom) * g)} y2={y(bottom + (max - bottom) * g)} className="stroke-line" strokeWidth="1" strokeDasharray={g ? "2 4" : undefined} />
              <text x={L - 8} y={y(bottom + (max - bottom) * g) + 3.5} textAnchor="end" className="fill-ink-3 font-mono text-[10px]">{onAxis(bottom + (max - bottom) * g)}</text>
            </g>
          ))}
          {Array.from({ length: ticks }, (_x, k) => Math.round((k / (ticks - 1)) * (n - 1))).map((i, k) => (
            <text key={i} x={x(i)} y={height - 5} textAnchor={k === 0 ? "start" : k === ticks - 1 ? "end" : "middle"} className="fill-ink-3 font-mono text-[10px]">{timeLabel(times[i]!)}</text>
          ))}
          {stacks.map((s, i) => {
            const points = s.high.map((v, k) => (v === null ? null : ([x(k), y(v)] as [number, number]))).filter((p): p is [number, number] => p !== null);
            if (!points.length) return null;
            const line = curve(points);
            const floor = stacked
              ? curve(s.low.map((v, k) => [x(k), y(v)] as [number, number]).reverse()).replace(/^M/, "L")
              : `L${points.at(-1)![0].toFixed(1)},${y(bottom).toFixed(1)}L${points[0]![0].toFixed(1)},${y(bottom).toFixed(1)}`;
            return (
              <g key={s.name}>
                {filled && !s.dashed && <path d={`${line}${floor}Z`} fill={`url(#${id}-${i})`} />}
                <path d={line} fill="none" stroke={s.color} strokeWidth={s.dashed ? 1.25 : 1.75} strokeDasharray={s.dashed ? "5 4" : undefined} strokeLinejoin="round" strokeLinecap="round" />
                {points.length === 1 && <circle cx={points[0]![0]} cy={points[0]![1]} r="2.5" fill={s.color} />}
              </g>
            );
          })}
          {drag && Math.abs(drag.x1 - drag.x0) >= 2 && (
            <rect pointerEvents="none" x={Math.min(drag.x0, drag.x1)} y={T} width={Math.abs(drag.x1 - drag.x0)} height={H} className="fill-accent/15 stroke-accent" strokeWidth="1" />
          )}
          {hover !== null && (
            <g pointerEvents="none">
              <line x1={x(hover)} x2={x(hover)} y1={T} y2={T + H} className="stroke-ink-3" strokeWidth="1" />
              {stacks.map((s) => s.high[hover] !== null && s.values[hover] !== null && <circle key={s.name} cx={x(hover)} cy={y(s.high[hover]!)} r="3.5" fill={s.color} className="stroke-panel" strokeWidth="1.5" />)}
            </g>
          )}
        </svg>
        {hover !== null && !drag && (
          <div
            className="pointer-events-none absolute top-1 z-10 flex min-w-40 max-w-[320px] flex-col gap-1 rounded-lg border border-line-strong bg-raised px-2.5 py-2 text-xs shadow-xl shadow-shade/40"
            style={x(hover) > width / 2 ? { right: width - x(hover) + 12 } : { left: x(hover) + 12 }}
          >
            <span className="font-semibold">{timeLabel(times[hover]!, true)}</span>
            {[...shown].sort((a, b) => (b.values[hover] ?? -1) - (a.values[hover] ?? -1)).map((s) => (
              <span key={s.name} className="flex items-center gap-2">
                <span className="h-0.5 w-3 shrink-0 rounded-full" style={{ background: coloured.find((c) => c.name === s.name)!.color }} />
                <span className="grow truncate text-ink-2">{s.name}</span>
                <span className="font-mono">{s.values[hover] === null ? "—" : format(s.values[hover]!)}</span>
              </span>
            ))}
            {detail?.(hover)}
          </div>
        )}
        {drag && Math.abs(drag.x1 - drag.x0) >= 6 && n > 1 && (
          <span className="pointer-events-none absolute top-1 left-1/2 -translate-x-1/2 rounded-full bg-ground/85 px-2.5 py-0.5 text-[11px] text-ink-2">release to look at this window</span>
        )}
      </div>
      <div className="flex flex-wrap gap-x-3.5 gap-y-1">
        {coloured.map((s) => {
          const value = statOf(s.values, stat);
          return (
            <button
              key={s.name}
              type="button"
              data-tip={solo === s.name ? "Show them all again" : "Look at this one alone"}
              onClick={() => setSolo(solo === s.name ? null : s.name)}
              className={cx("flex items-center gap-1.5 rounded px-1 text-xs hover:bg-hover", solo && solo !== s.name ? "text-ink-3 opacity-60" : "text-ink-2")}
            >
              <span className="h-0.5 w-3.5 rounded-full" style={{ background: s.color }} />
              {s.name}
              {value !== null && <span className="font-mono text-ink">{format(value)}</span>}
            </button>
          );
        })}
      </div>
      {children}
    </section>
  );
}
