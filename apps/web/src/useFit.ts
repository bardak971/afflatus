import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/**
 * A bar that stays on one line: how many steps of folding it needs to fit (0: none). Each step is the bar's
 * own choice (the kinds become a menu, the search an icon, ...). A step is taken when the bar overflows; it is
 * undone when the bar has grown wider than it was when the step was taken (and taken again at once if that
 * was not enough). The bar is `flex-nowrap overflow-hidden`, so what it holds never wraps.
 */
export function useFit(ref: RefObject<HTMLElement | null>, steps: number, resetKey = ""): number {
  const [level, setLevel] = useState(0);
  // the width the bar had when each step was taken
  const at = useRef<number[]>([]);
  // what the bar holds changed: fold again from nothing (the layout effect takes the steps needed)
  useEffect(() => {
    setLevel(0);
    at.current = [];
  }, [resetKey]);
  const over = (el: HTMLElement) => el.scrollWidth > el.clientWidth + 1;
  // after a step (or a fold from nothing): still too wide, one more step, before the bar is seen. Not after every draw:
  // reading the bar's width then laid the whole page out at once on each draw of the screen that holds it (the library's
  // header drawn again with every page of the grid); what it holds changing is seen by the observers below
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && over(el) && level < steps) {
      at.current[level] = el.clientWidth;
      setLevel(level + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [level, steps, resetKey]);
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
    // what it holds changes too (a selection bar put in it from elsewhere, a name read in)
    const changed = new MutationObserver(check);
    changed.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      sized.disconnect();
      changed.disconnect();
    };
  }, [ref, steps]);
  return Math.min(level, steps);
}
