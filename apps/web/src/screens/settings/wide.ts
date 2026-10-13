/**
 * Settings › ComfyUI and Rented GPUs are two columns of cards from this window width, one below it, as the other tabs
 * are. `COLUMNS`'s `min-[1600px]:` is the same width, for what CSS can lay out alone.
 */
export const WIDE = "(min-width: 1600px)";

/** Two columns, each as wide as the other tabs' one: a list of two column boxes, side by side when wide, one under the other when not. */
export const COLUMNS = "grid items-start gap-4 min-[1600px]:grid-cols-[repeat(2,minmax(0,860px))]";
