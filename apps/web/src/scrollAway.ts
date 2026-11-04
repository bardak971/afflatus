/**
 * When a scroll closes what is open over the page from a button (a list, a popover): the page moving under it would leave
 * it hanging in the wrong place, so a scroll begun while it is open closes it. Not the tail of a scroll still going as it
 * was clicked (the form scrolled down to the Grid's Y with the wheel, its glide not over): that closed the list a few
 * milliseconds after it opened, and the first click on it seemed to do nothing (2026-11-04). It follows its button until
 * that scroll ends. A scroll that leaves the button where it was (another box, the browser keeping the view in place as
 * something above changes height) changes nothing.
 */

/** Scroll events closer together than this are one scroll still going (a wheel's glide, a trackpad's momentum). */
const SCROLL_GAP_MS = 150;
/** When anything on the page last scrolled. */
let scrolledAt = -Infinity;
if (typeof window !== "undefined") window.addEventListener("scroll", () => void (scrolledAt = performance.now()), { capture: true, passive: true });

/**
 * The scroll listener for what is open now, to add on the window in the capture phase as it opens. `anchor` is the button
 * it hangs from, `inside` whether a scrolled box is its own (its list), `follow` places it again, `close` closes it.
 */
export function scrollAway({ anchor, inside, follow, close }: {
  anchor(): Element | null | undefined;
  inside(target: EventTarget | null): boolean;
  follow(): void;
  close(): void;
}): (e: Event) => void {
  let was = anchor()?.getBoundingClientRect() ?? null;
  // a scroll already going as it opened
  let tail = performance.now() - scrolledAt < SCROLL_GAP_MS ? scrolledAt : null;
  return (e) => {
    if (inside(e.target)) return;
    const r = anchor()?.getBoundingClientRect() ?? null;
    if (r && was && Math.abs(r.top - was.top) < 1 && Math.abs(r.left - was.left) < 1) return;
    const at = performance.now();
    if (tail !== null && at - tail < SCROLL_GAP_MS) {
      tail = at;
      was = r;
      follow();
      return;
    }
    tail = null;
    close();
  };
}
