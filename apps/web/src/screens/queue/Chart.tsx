import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { cx } from "../../ui";
import { themeInUse, useThemeChoice } from "../../theme/store";

/**
 * A panel with lines over time, after Grafana's: soft fills under the lines, a crosshair that reads
 * every series where the pointer is, and a legend whose entries can be clicked to look at one alone.
 */

export interface Series {
  name: string;
  /** One value per time; null where there is nothing to say (no render in that stretch): the line passes over it. */
  values: Array<number | null>;
  color?: string;
  dashed?: boolean;
}

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

/** A curve through the points that never overshoots them (monotone cubic). */
function curve(points: Array<[number, number]>): string {
  const n = points.length;
  if (!n) return "";
  if (n < 3) return points.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(points[i + 1]![0] - points[i]![0]);
    slope.push((points[i + 1]![1] - points[i]![1]) / (dx[i] || 1));
  }
  const m: number[] = [slope[0]!];
  for (let i = 1; i < n - 1; i++) m.push(slope[i - 1]! * slope[i]! <= 0 ? 0 : (slope[i - 1]! + slope[i]!) / 2);
  m.push(slope[n - 2]!);
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i]! / slope[i]!;
    const b = m[i + 1]! / slope[i]!;
    const h = Math.hypot(a, b);
    if (h > 3) { m[i] = (3 / h) * a * slope[i]!; m[i + 1] = (3 / h) * b * slope[i]!; }
  }
  let d = `M${points[0]![0].toFixed(1)},${points[0]![1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = points[i]!;
    const [x1, y1] = points[i + 1]!;
    const k = dx[i]! / 3;
    d += `C${(x0 + k).toFixed(1)},${(y0 + m[i]! * k).toFixed(1)} ${(x1 - k).toFixed(1)},${(y1 - m[i + 1]! * k).toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
  }
  return d;
}

/** A round figure at or above the largest value, so the top grid line says something. */
function ceiling(max: number): number {
  if (max <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * power >= max) return m * power;
  return max;
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
  const [drag, setDrag] = useState<{ x0: number; x1: number } | null>(null);
  const palette = useChartColors();
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const watch = new ResizeObserver(() => setWidth(Math.max(240, el.clientWidth)));
    watch.observe(el);
    setWidth(Math.max(240, el.clientWidth));
    return () => watch.disconnect();
  }, []);

  // past the last colour they come round again, dashed, so two lines of one colour can be told apart
  const coloured = series.map((s, i) => ({ ...s, color: s.color ?? palette[i % palette.length] ?? "currentColor", dashed: s.dashed ?? (!s.color && i >= palette.length) }));
  const filled = fill ?? (stacked || series.length <= 3);
  const onAxis = axisFormat ?? format;
  const shown = coloured.filter((s) => !solo || s.name === solo);
  const L = 48, R = 10, T = 8, B = 20;
  const W = width - L - R;
  const H = height - T - B;
  const n = times.length;
  const x = (i: number) => L + (n > 1 ? (i / (n - 1)) * W : W / 2);

  // stacked: each series sits on the sum of the ones under it
  const stacks = useMemo(() => {
    const base = new Array<number>(n).fill(0);
    return shown.map((s) => {
      const low = [...base];
      const high = s.values.map((v, i) => (stacked ? (base[i] = base[i]! + (v ?? 0)) : v));
      return { ...s, low, high };
    });
  }, [shown, stacked, n]);
  const max = top ?? ceiling(Math.max(0, ...stacks.flatMap((s) => s.high.filter((v): v is number => v !== null))));
  const y = (v: number) => T + H - ((Math.max(bottom, v) - bottom) / (max - bottom || 1)) * H;

  const statOf = (values: Array<number | null>) => {
    const real = values.filter((v): v is number => v !== null);
    if (!real.length) return null;
    return stat === "sum" ? real.reduce((a, b) => a + b, 0) : stat === "last" ? real.at(-1)! : stat === "max" ? Math.max(...real) : real.reduce((a, b) => a + b, 0) / real.length;
  };
  const ticks = Math.max(2, Math.min(n, Math.floor(W / 86)));

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
            if (drag) setDrag({ ...drag, x1: px });
          }}
          onMouseLeave={() => {
            setHover(null);
            setDrag(null);
          }}
          onMouseDown={(e) => {
            if (!onBrush || e.button !== 0) return;
            e.preventDefault();
            const rect = e.currentTarget.getBoundingClientRect();
            setDrag({ x0: e.clientX - rect.left, x1: e.clientX - rect.left });
          }}
          onMouseUp={() => {
            if (!drag || !onBrush) return;
            const [a, b] = [Math.min(drag.x0, drag.x1), Math.max(drag.x0, drag.x1)];
            setDrag(null);
            if (b - a < 6 || n < 2) return;
            const at = (px: number) => Math.max(0, Math.min(n - 1, ((px - L) / W) * (n - 1)));
            const i0 = Math.floor(at(a));
            const i1 = Math.ceil(at(b));
            const span = step ?? (times[1]! - times[0]!);
            onBrush(times[i0]!, Math.min(times[n - 1]! + span, times[i1]! + (i1 === i0 ? span : 0)));
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
          const value = statOf(s.values);
          return (
            <button
              key={s.name}
              type="button"
              title={solo === s.name ? "Show them all again" : "Look at this one alone"}
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
