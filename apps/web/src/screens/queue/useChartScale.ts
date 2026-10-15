import { ceiling, stackSeries } from "./chartMath";

export interface Series {
  name: string;
  /** One value per time; null where there is nothing to say (no render in that stretch): the line passes over it. */
  values: Array<number | null>;
  color?: string;
  dashed?: boolean;
  /** What the name stands for, on its legend entry. */
  tip?: string;
}

/** The plot's margins inside the panel: room for the scale on the left and the times underneath. */
export const PLOT = { L: 48, R: 10, T: 8, B: 20 };

/**
 * Where everything of a chart goes: each series' colour (past the last colour of the palette they come
 * round again, dashed, so two lines of one colour can be told apart), the stacks, the top of the scale,
 * and the functions from a stretch and a value to a point of the panel (and back, from a pixel across to a stretch).
 */
export function useChartScale({ series, times, width, height, palette, solo, stacked, top, bottom, bars, least }: {
  series: Series[];
  times: number[];
  width: number;
  height: number;
  palette: string[];
  /** The one series looked at alone, if any. */
  solo: string | null;
  stacked?: boolean;
  top?: number;
  bottom: number;
  /** One bar per stretch, each in its own band of the width, rather than points from edge to edge. */
  bars?: boolean;
  /** A value the scale reaches at least (a line drawn across, a cap): it stays in view above lower values. */
  least?: number;
}) {
  const coloured = series.map((s, i) => ({ ...s, color: s.color ?? palette[i % palette.length] ?? "currentColor", dashed: s.dashed ?? (!s.color && i >= palette.length) }));
  const shown = coloured.filter((s) => !solo || s.name === solo);
  const W = width - PLOT.L - PLOT.R;
  const H = height - PLOT.T - PLOT.B;
  const n = times.length;
  const band = n ? W / n : W;
  const x = (i: number) => PLOT.L + (bars ? (i + 0.5) * band : n > 1 ? (i / (n - 1)) * W : W / 2);
  /** The stretch under a pixel across the panel. */
  const at = (px: number) => Math.max(0, Math.min(n - 1, bars ? Math.floor((px - PLOT.L) / band) : Math.round(((px - PLOT.L) / W) * (n - 1))));
  // stacked: each series sits on the sum of the ones under it
  const stacks = stackSeries(shown, n, Boolean(stacked));
  const max = top ?? ceiling(Math.max(0, least ?? 0, ...stacks.flatMap((s) => s.high.filter((v): v is number => v !== null))));
  const y = (v: number) => PLOT.T + H - ((Math.max(bottom, v) - bottom) / (max - bottom || 1)) * H;
  return { coloured, shown, stacks, max, x, at, band, y, W, H, n };
}
