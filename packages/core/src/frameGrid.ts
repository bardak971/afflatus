/**
 * The frame counts a video model takes: `step·k + offset` (a recipe's `traits.frameGrid`), and where a latent's
 * chunks begin (every `step` frames). Each place that rounds onto a grid says which way it rounds: up (a clip
 * asked for that long gets at least that long), to the nearest, or down (a cut stays inside what was made).
 */

/** Valid frame counts: frames = step·k + offset. */
export interface FrameGrid {
  step: number;
  offset: number;
}

/**
 * The grid of the latents the app keeps, continues and lands in: MiniMax H3's (17k + 5 frames at 24 a second,
 * 17 frames to a chunk). The one model whose latent is kept (its family hands its recipes this grid).
 */
export const LATENT_GRID: FrameGrid = { step: 17, offset: 5 };

/** Whether a frame count is one the grid takes. */
export const onGrid = (frames: number, g: FrameGrid): boolean => frames >= g.offset && (frames - g.offset) % g.step === 0;

/** Which count on the grid this is (0 for `offset` frames, 1 for `step + offset`), or -1 for a count off it. */
export const gridIndex = (frames: number, g: FrameGrid): number => (onGrid(frames, g) ? (frames - g.offset) / g.step : -1);

/** The count on the grid at or above `frames`, never under `offset`. */
export const gridAtLeast = (frames: number, g: FrameGrid): number => Math.max(g.offset, Math.ceil((frames - g.offset) / g.step) * g.step + g.offset);

/** The count on the grid nearest to `frames`, never under `offset`. */
export const gridNearest = (frames: number, g: FrameGrid): number => Math.max(g.offset, Math.round((frames - g.offset) / g.step) * g.step + g.offset);

/** The count on the grid at or before `frames`: below `offset` it goes under it (a frame before any count), as the callers expect. */
export const gridAtOrBefore = (frames: number, g: FrameGrid): number => Math.floor((frames - g.offset) / g.step) * g.step + g.offset;

/** Whether a frame is where one of a latent's chunks begins (frame `step·j`). */
export const isChunkStart = (frame: number, g: FrameGrid): boolean => frame % g.step === 0;

/** The first frame of one of a latent's chunks at or after `frame`. */
export const chunkStartAtOrAfter = (frame: number, g: FrameGrid): number => Math.ceil(frame / g.step) * g.step;
