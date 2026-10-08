/**
 * A size on a model's grid: the nearest multiple of `grid`, and never under `min` (the grid itself unless
 * said otherwise). The picture models want multiples of 16, SDXL and the video encoders 8, H3's latent upscale 32.
 */
export const roundTo = (n: number, grid: number, min = grid): number => Math.max(min, Math.round(n / grid) * grid);

/** The frame H3's latent re-sample makes of a clip's: each edge `by` times, on the latent's 32-pixel grid. The same sum on the server and on the form. */
export const latentUpscaleSize = (frame: { width: number; height: number }, by: number): { width: number; height: number } => ({
  width: roundTo(frame.width * by, 32, 64),
  height: roundTo(frame.height * by, 32, 64),
});

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

/**
 * The run-up of a continuation a finish need not restore: the frames it shares with the clip before, hidden under that
 * clip's end, less a margin. They are never seen (a trim only moves the start later; a seamless join shows one frame early,
 * the export half a frame), yet they are 0.9 s of a 5.9 s H3 continuation. The finish enlarges them plainly (lanczos), so
 * that the file keeps its length and every join keeps its timing. The same sum on the server and in the Finish estimate.
 */
const FINISH_MARGIN_MS = 125;
export const hiddenRunUp = (headMs: number): number => (headMs > FINISH_MARGIN_MS ? headMs - FINISH_MARGIN_MS : 0);

/** Megapixels of a frame, said short: "0.59 MP", "2.1 MP". */
export const megapixels = (width: number, height: number): string => {
  const mp = (width * height) / 1e6;
  return `${mp.toFixed(mp < 1 ? 2 : 1)} MP`;
};
