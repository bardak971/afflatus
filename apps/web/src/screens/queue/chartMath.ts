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
 * stretch it touches to the end of the last. `left` and `width`: the plot's place across the panel.
 */
export function brushWindow(a: number, b: number, plot: { left: number; width: number }, times: number[], step?: number): { from: number; to: number } | null {
  const n = times.length;
  if (n < 2) return null;
  const at = (px: number) => Math.max(0, Math.min(n - 1, ((px - plot.left) / plot.width) * (n - 1)));
  const i0 = Math.floor(at(Math.min(a, b)));
  const i1 = Math.ceil(at(Math.max(a, b)));
  const span = step ?? times[1]! - times[0]!;
  return { from: times[i0]!, to: Math.min(times[n - 1]! + span, times[i1]! + (i1 === i0 ? span : 0)) };
}
