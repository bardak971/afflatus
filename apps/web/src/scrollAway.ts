/**
 * When a scroll closes what is open over the page from a button (a list, a popover): the page moving under it would leave
 * it hanging in the wrong place, so a scroll the user begins while it is open closes it. Not the tail of a scroll still
 * going as it was clicked (the form scrolled down to the Grid's Y with the wheel, its glide not over): that closed the list
 * a few milliseconds after it opened, and the first click on it seemed to do nothing (2026-11-04). Nor a scroll the page
 * does by itself once it is open, with no wheel, finger, key or press of the user's since (a part of the form changing
 * height as the values typed beside it are taken, a glide to a part shown): that closed the Grid's Y list 2 times in 5 (card
 * #316). It follows its button through both. A scroll that leaves the button where it was (another box, the browser keeping
 * the view in place as something above changes height) changes nothing.
 */

/** Scroll events closer together than this are one scroll still going (a wheel's glide, a trackpad's momentum). */
const SCROLL_GAP_MS = 150;
/** When anything on the page last scrolled. */
let scrolledAt = -Infinity;
/** When the user last did something that scrolls (a wheel, a finger moved, a key), and a press with where it was. */
let askedAt = -Infinity;
let pressedAt = -Infinity;
let pressed: EventTarget | null = null;
if (typeof window !== "undefined") {
  window.addEventListener("scroll", () => void (scrolledAt = performance.now()), { capture: true, passive: true });
  for (const type of ["wheel", "touchmove", "keydown"]) window.addEventListener(type, () => void (askedAt = performance.now()), { capture: true, passive: true });
  // a press on a scrollbar drags it; the press on the button that opens the list is not one (it is checked against it)
  window.addEventListener("pointerdown", (e) => {
    pressedAt = performance.now();
    pressed = e.target;
  }, { capture: true, passive: true });
}

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
  const openedAt = performance.now();
  // a scroll already going as it opened
  let tail = openedAt - scrolledAt < SCROLL_GAP_MS ? scrolledAt : null;
  /** Whether the user did something that scrolls since it opened: else the page is scrolling by itself. */
  const asked = () => askedAt > openedAt || (pressedAt > openedAt && !(pressed instanceof Node && anchor()?.contains(pressed)) && !inside(pressed));
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
    if (!asked()) {
      was = r;
      follow();
      return;
    }
    tail = null;
    close();
  };
}
