/**
 * The app's motion (styles.css, "The app's motion"): what opens plays its class, what closes plays its exit before it
 * is taken away. The exit classes set pointer-events: none, so a thing leaving never blocks input.
 */

import { motionAllowed } from "./useFlip";

/** How long an exit plays: what waits for one (a banner leaving, a copy left behind by a leave) waits this long. */
export const OUT_MS = 75;

/**
 * The style that makes an `m-pop` (a menu, a list, a popover) open from its side: one opening upward rises from a few
 * pixels below, as one opening downward drops from a few above. Its transform-origin is set beside it, by its user.
 */
export const popFrom = (upward: boolean): Record<string, string> => (upward ? { "--pop-from": "4px" } : {});

/**
 * Marks a place the app just took the eye to (a machine's row, a step of the import) with an accent ring for `ms`: a ring
 * that fades out where motion is allowed, one that stands and then goes under "reduce motion", so the mark still shows.
 */
export function markPlace(el: HTMLElement, ms: number): void {
  const ring = "0 0 0 2px var(--color-accent)";
  if (motionAllowed() && el.animate) {
    el.animate([{ boxShadow: ring }, { boxShadow: "0 0 0 2px transparent" }], { duration: ms, easing: "ease-out" });
    return;
  }
  const was = el.style.boxShadow;
  el.style.boxShadow = ring;
  window.setTimeout(() => {
    el.style.boxShadow = was;
  }, ms);
}
