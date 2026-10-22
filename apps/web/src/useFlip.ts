import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * Whether the app may move things: off under "reduce motion", and where the browser cannot say (tests), so that
 * nothing waits on an animation there.
 */
export const motionAllowed = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: no-preference)").matches === true;

/**
 * A timing of the app's motion (styles.css, "The app's motion"), in milliseconds, for the animations started from
 * script: the Web Animations API takes a number, not var(--t-panel). Read from the page so that one place sets it.
 */
export function motionMs(token: "--t-pop" | "--t-panel" | "--t-out", fallback: number): number {
  if (typeof document === "undefined") return fallback;
  const said = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(token));
  return Number.isFinite(said) ? said : fallback;
}

/** The app's ease (--ease-snap), for the same animations: they cannot read a custom property either. */
export function motionEase(): string {
  if (typeof document === "undefined") return "ease-out";
  return getComputedStyle(document.documentElement).getPropertyValue("--ease-snap").trim() || "cubic-bezier(0.3, 0.9, 0.3, 1)";
}

type Spot = { x: number; y: number };

/** Where each thing is laid out, as offsets in the layout. */
function spots(els: Map<string, HTMLElement>): Map<string, Spot> {
  const at = new Map<string, Spot>();
  for (const [key, el] of els) at.set(key, { x: el.offsetLeft, y: el.offsetTop });
  return at;
}

/**
 * Things put in a new order slide from where they were to where they now are, the others moving aside, rather than
 * jumping (FLIP: where each was is read as the new order is drawn, before the page changes; each one is drawn at once in
 * its new place, shifted back by the difference, and the shift runs out in --t-panel). `order` is what says the
 * order changed: the ids in it, joined; anything else redrawn (a name typed, a resize) moves nothing. Give each
 * thing's element `ref(key)`. Places are read as offsets in the layout, not on the screen: a list scrolled between
 * two drawings does not slide. A thing inside another that moves (a setting in a section) slides by its own move
 * only. Nothing moves under "reduce motion", nor while `still` (a drag of the same list whose drag picture would
 * fight it: the move then plays on the drop, when the order changes). Input is never held: a key pressed again
 * mid-slide starts the next one from where the thing is seen.
 */
export function useFlip(order: readonly string[], still = false): (key: string) => (el: HTMLElement | null) => void {
  const els = useRef(new Map<string, HTMLElement>());
  const refs = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const running = useRef(new Map<HTMLElement, Animation>());
  const signature = order.join("\u0000");
  const before = useRef(signature);
  // where each one was, read only when the order changed, while the page still shows the order before: read after every
  // drawing, it laid the page out once more at each key typed in a form (a pinned field, a section's setting)
  const was = useRef<{ signature: string; at: Map<string, Spot> } | null>(null);
  if (before.current !== signature && was.current?.signature !== signature) was.current = { signature, at: spots(els.current) };
  useLayoutEffect(() => {
    const changed = before.current !== signature;
    before.current = signature;
    if (!changed) return;
    const old = was.current?.at ?? new Map<string, Spot>();
    was.current = null;
    if (still || !motionAllowed()) return;
    const now = spots(els.current);
    // each one's whole move first, then a thing's own part of it (its parent's slide carries it the rest of the way)
    const moves = new Map<HTMLElement, Spot>();
    for (const [key, el] of els.current) {
      const from = old.get(key);
      const to = now.get(key);
      if (!from || !to) continue;
      // caught mid-slide: it starts from where it is seen, not from where it was last laid out
      let seen = { x: 0, y: 0 };
      const going = running.current.get(el);
      if (going) {
        const m = new DOMMatrixReadOnly(getComputedStyle(el).transform === "none" ? undefined : getComputedStyle(el).transform);
        seen = { x: m.m41, y: m.m42 };
        going.cancel();
        running.current.delete(el);
      }
      moves.set(el, { x: from.x + seen.x - to.x, y: from.y + seen.y - to.y });
    }
    const duration = motionMs("--t-panel", 140);
    const easing = motionEase();
    for (const [el, move] of moves) {
      let dx = move.x;
      let dy = move.y;
      for (let up = el.parentElement; up; up = up.parentElement) {
        const carried = moves.get(up);
        if (carried) {
          dx -= carried.x;
          dy -= carried.y;
          break;
        }
      }
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      if (typeof el.animate !== "function") continue;
      const slide = el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration, easing });
      running.current.set(el, slide);
      slide.onfinish = slide.oncancel = () => {
        if (running.current.get(el) === slide) running.current.delete(el);
      };
    }
  });
  return useCallback((key: string) => {
    let ref = refs.current.get(key);
    if (!ref) {
      ref = (el: HTMLElement | null) => {
        if (el) els.current.set(key, el);
        else els.current.delete(key);
      };
      refs.current.set(key, ref);
    }
    return ref;
  }, []);
}
