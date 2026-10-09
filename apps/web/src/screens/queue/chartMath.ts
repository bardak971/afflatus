/** The arithmetic of the render-time charts (Chart.tsx, Lanes.tsx), apart from the drawing so that it can be tested. */

/** A curve through the points that never overshoots them (monotone cubic), as an SVG path. */
export function curve(points: Array<[number, number]>): string {
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
export function ceiling(max: number): number {
  if (max <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * power >= max) return m * power;
  return max;
}

/** What a legend says beside a series: its mean, sum, last or highest value, over the stretches that have one. */
export function statOf(values: Array<number | null>, stat: "mean" | "sum" | "last" | "max"): number | null {
  const real = values.filter((v): v is number => v !== null);
  if (!real.length) return null;
  return stat === "sum" ? real.reduce((a, b) => a + b, 0) : stat === "last" ? real.at(-1)! : stat === "max" ? Math.max(...real) : real.reduce((a, b) => a + b, 0) / real.length;
}

/** Each series with where it is drawn from and to: stacked, on the sum of the ones before it; else from nothing. */
export function stackSeries<S extends { values: Array<number | null> }>(series: S[], n: number, stacked: boolean): Array<S & { low: number[]; high: Array<number | null> }> {
  const base = new Array<number>(n).fill(0);
  return series.map((s) => {
    const low = [...base];
    const high = s.values.map((v, i) => (stacked ? (base[i] = base[i]! + (v ?? 0)) : v));
    return { ...s, low, high };
  });
}

/**
 * A drag across a chart of `n` stretches as the window of time it covers: from the start of the first
 * stretch it touches to the end of the last. `left` and `width`: the plot's place across the panel;
 * `bars`: the stretches are drawn as bars, each in its own band, not as points on a line.
 */
export function brushWindow(a: number, b: number, plot: { left: number; width: number }, times: number[], step?: number, bars?: boolean): { from: number; to: number } | null {
  const n = times.length;
  if (n < 2) return null;
  const span = step ?? times[1]! - times[0]!;
  if (bars) {
    // bars: each stretch owns a band of the width, so a drag covers the bars it touches, whole
    const band = (px: number) => Math.max(0, Math.min(n - 1, Math.floor(((px - plot.left) / plot.width) * n)));
    return { from: times[band(Math.min(a, b))]!, to: times[band(Math.max(a, b))]! + span };
  }
  const at = (px: number) => Math.max(0, Math.min(n - 1, ((px - plot.left) / plot.width) * (n - 1)));
  const i0 = Math.floor(at(Math.min(a, b)));
  const i1 = Math.ceil(at(Math.max(a, b)));
  return { from: times[i0]!, to: Math.min(times[n - 1]! + span, times[i1]! + (i1 === i0 ? span : 0)) };
}

/** A bar as an SVG path, from `y0` (its foot) up to `y1`, its top corners rounded by `r` (less when the bar is too narrow or short for it). */
export function bar(x: number, width: number, y0: number, y1: number, r: number): string {
  const h = y0 - y1;
  if (h <= 0 || width <= 0) return "";
  const k = Math.max(0, Math.min(r, width / 2, h));
  const f = (v: number) => v.toFixed(1);
  if (!k) return `M${f(x)},${f(y0)}V${f(y1)}H${f(x + width)}V${f(y0)}Z`;
  return `M${f(x)},${f(y0)}V${f(y1 + k)}Q${f(x)},${f(y1)} ${f(x + k)},${f(y1)}H${f(x + width - k)}Q${f(x + width)},${f(y1)} ${f(x + width)},${f(y1 + k)}V${f(y0)}Z`;
}

/**
 * The left axis's labels: the chart's own format, unless two come out the same (gridlines close together, rounded
 * alike: "3 min/s" on every line). Then the number in each is written with more decimals, up to three, until they differ;
 * the words around it stay.
 */
export function axisLabels(values: number[], format: (v: number) => string): string[] {
  const labels = values.map(format);
  if (new Set(labels).size === labels.length) return labels;
  for (let decimals = 1; decimals <= 3; decimals++) {
    const finer = values.map((v, i) => labels[i]!.replace(/-?\d+(?:[.,]\d+)?/, () => v.toFixed(decimals)));
    if (new Set(finer).size === finer.length) return finer;
  }
  return labels;
}
