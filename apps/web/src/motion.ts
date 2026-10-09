import { useEffect, useRef, useState } from "react";

/**
 * The app's motion (styles.css, "The app's motion"): what opens plays its class, what closes plays its exit before it
 * is taken away. `useExit(open, ms)` keeps a closed thing drawn for its exit's length and says which phase it is in;
 * under "reduce motion" there is no exit to wait for, so it goes at once. The thing never blocks input while leaving:
 * the exit classes set pointer-events: none.
 */
export const OUT_MS = 75;

// no way to ask (the tests' browser, an old one): no motion, so nothing waits on an exit
const reduced = () => typeof window === "undefined" || !window.matchMedia || !window.matchMedia("(prefers-reduced-motion: no-preference)").matches;

export function useExit(open: boolean, ms = OUT_MS): { shown: boolean; leaving: boolean } {
  const [shown, setShown] = useState(open);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (open) {
      setShown(true);
      return;
    }
    if (!shown) return;
    if (reduced()) {
      setShown(false);
      return;
    }
    timer.current = setTimeout(() => setShown(false), ms);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return { shown: open || shown, leaving: !open && shown };
}

/** The class of a menu-like thing for its phase: popping in, or leaving. */
export const popClass = (leaving: boolean) => (leaving ? "m-pop-out" : "m-pop");
/** The same for a big panel (viewer, shelf, designer). */
export const panelClass = (leaving: boolean) => (leaving ? "m-out" : "m-panel");
