import { clock } from "../format";

/** A stretch of a video, in and out, ms from its start. */
export interface Range {
  startMs: number;
  endMs: number;
}

/** "0:04.20": a moment to the frame, with hundredths. */
export const stamp = (ms: number) => clock(ms, { decimals: 2 });

/** The most frames a strip holds: past that, one tile stands for several frames. */
export const STRIP_FRAMES = 120;
