/**
 * The frame of a video from its proportions and the short side asked for: the short side is kept, the
 * other follows the proportions, both land on the model's grid, and the whole stays within the most
 * pixels the model takes (the long edge gives way, both for a square). The same sum on the server, where
 * the graph is built, and in the browser, where the form says what will come out.
 */
export function frameOf(shape: { width: number; height: number }, short: number, by: { grid: number; maxPixels: number }): { width: number; height: number } {
  const r = shape.width / shape.height;
  let w = r >= 1 ? short * r : short;
  let h = r >= 1 ? short : short / r;
  if (w * h > by.maxPixels) {
    const k = Math.sqrt(by.maxPixels / (w * h));
    w *= k;
    h *= k;
  }
  const snap = (n: number) => Math.max(by.grid, Math.round(n / by.grid) * by.grid);
  let W = snap(w);
  let H = snap(h);
  // rounding can land just over the largest the model takes
  while (W * H > by.maxPixels && (W > by.grid || H > by.grid)) {
    if (W >= H) W -= by.grid;
    else H -= by.grid;
  }
  return { width: W, height: H };
}

/** Megapixels of a frame, said short: "0.59 MP", "2.1 MP". */
export const megapixels = (width: number, height: number): string => {
  const mp = (width * height) / 1e6;
  return `${mp.toFixed(mp < 1 ? 2 : 1)} MP`;
};
