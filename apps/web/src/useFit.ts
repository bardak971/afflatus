import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/**
 * A bar that stays on one line: how many steps of folding it needs to fit (0: none). Each step is the bar's
 * own choice (the kinds become a menu, the search an icon, ...). A step is taken when the bar overflows; it is
 * undone when the bar has grown wider than it was when the step was taken (and taken again at once if that
 * was not enough). The bar is `flex-nowrap overflow-hidden`, so what it holds never wraps.
 */
export function useFit(ref: RefObject<HTMLElement | null>, steps: number): number {
  const [level, setLevel] = useState(0);
  // the width the bar had when each step was taken
  const at = useRef<number[]>([]);
  const over = (el: HTMLElement) => el.scrollWidth > el.clientWidth + 1;
  // after every draw: still too wide, one more step
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && over(el) && level < steps) {
      at.current[level] = el.clientWidth;
      setLevel(level + 1);
    }
  });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () =>
      setLevel((l) => {
        if (over(el) && l < steps) {
          at.current[l] = el.clientWidth;
          return l + 1;
        }
        // wider than when the last step was taken: try without it
        if (l > 0 && el.clientWidth > (at.current[l - 1] ?? Infinity) + 24) return l - 1;
        return l;
      });
    const sized = new ResizeObserver(check);
    sized.observe(el);
    // what it holds changes too (a selection bar put in it from elsewhere)
    const changed = new MutationObserver(check);
    changed.observe(el, { childList: true, subtree: true });
    return () => {
      sized.disconnect();
      changed.disconnect();
    };
  }, [ref, steps]);
  return level;
}
