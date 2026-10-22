/**
 * Where the rows sit, top to bottom. The lanes under the clips are 28 px high, their hint inside them: drop targets of their
 * own (a voice recording, a long video, the music), never the smallest things on the screen (review 4, P6).
 */
export const RULER = 20;
export const ROW = { top: 24, height: 76 };
export const SOUND = { top: 104, height: 28 };
/** The source lane: a long video made into clips window by window (SourceLane.tsx). */
export const SOURCE = { top: 136, height: 28 };
export const MUSIC = { top: 168, height: 28 };
export const HEIGHT = 200;
