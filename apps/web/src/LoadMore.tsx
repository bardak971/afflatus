import { useEffect, useRef } from "react";
import { cx } from "./ui";

/**
 * The box a list scrolls in: the nearest one up the page that scrolls on its own, or null for the page itself. The
 * lists of this app scroll in boxes of their own, which clip what is below them: watched against the window, the end
 * of a list only comes into view as the box's bottom edge reaches it, whatever margin is asked for.
 */
function scrollBoxOf(el: HTMLElement): HTMLElement | null {
  for (let up = el.parentElement; up; up = up.parentElement) {
    const y = getComputedStyle(up).overflowY;
    if (y === "auto" || y === "scroll") return up;
  }
  return null;
}

/**
 * The end of a list that has more: as it comes within 600 px of the view of the box the list scrolls in, the next
 * page is asked for, so a long library is read by scrolling and the page is there before the end is reached. A
 * quiet line while a page loads; a click asks too, for a list that fits its box without scrolling.
 */
export function LoadMore({ more, busy, onMore, size = "md" }: { more: boolean; busy: boolean; onMore(): void; size?: "md" | "sm" }) {
  const ref = useRef<HTMLButtonElement>(null);
  // the callers hand a new onMore at every draw: the observer calls the latest one, and is made again only when the list
  // gains or loses a page to ask for, not at each draw (a new one says at once that the end is in view, and asked again)
  const latest = useRef(onMore);
  latest.current = onMore;
  useEffect(() => {
    const el = ref.current;
    if (!el || !more || busy) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) latest.current();
    }, { root: scrollBoxOf(el), rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, [more, busy]);
  if (!more) return null;
  return (
    <button type="button" ref={ref} onClick={onMore} disabled={busy} aria-label="More" className={cx("flex w-full justify-center text-ink-3 hover:text-ink-2", size === "sm" ? "py-2 text-[11px]" : "py-4 text-xs")}>
      {busy ? "Loading…" : "more"}
    </button>
  );
}
