import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motionAllowed } from "../../useFlip";
import { follow, releaseSpeed, stepSpring, type Spring, type Trail } from "./spring";

/**
 * What is left of a jump a drawn edge was spared (the apple-design skill, §3–§5 and §9), in px: added to where the edge
 * should be drawn, it carries it there on the clip drag's spring (spring.ts) from where it was, at the speed it was moving.
 * A trim's edge let go of past its limit springs back to the limit; a source's end that crosses a rendered window's middle
 * glides over to the window's other end. The value a drag gives is never this one: what is committed is the limit, as
 * before. Under reduced motion nothing is left over, and the edge is at once where it goes.
 *
 * `tag` says which edge the spring carries (a lane has two ends and a body): the one the last jump was for.
 */
export function useSpringBack<T extends string = string>() {
  const [left, setLeft] = useState<{ px: number; tag: T | null }>({ px: 0, tag: null });
  const spring = useRef<Spring | null>(null);
  const tag = useRef<T | null>(null);
  const trail = useRef<Trail>([]);
  const frame = useRef<number | null>(null);
  const lastAt = useRef(0);

  const stop = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    spring.current = null;
    lastAt.current = 0;
    setLeft((was) => (was.px === 0 && was.tag === null ? was : { px: 0, tag: null }));
  }, []);

  const tick = useCallback((t: number) => {
    frame.current = null;
    const s = spring.current;
    if (!s) return;
    const dt = Math.min(0.064, (t - (lastAt.current || t)) / 1000);
    lastAt.current = t;
    if (stepSpring(s, dt)) {
      spring.current = null;
      lastAt.current = 0;
      setLeft({ px: 0, tag: null });
      return;
    }
    setLeft({ px: s.x, tag: tag.current });
    frame.current = requestAnimationFrame(tick);
  }, []);

  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
  }, []);

  return useMemo(() => ({
    /** What is left to go, in px, and the edge it is for (0 and null at rest). */
    left,
    /** The edge drawn at `px` now (px along the track): the speed a jump hands to the spring is read from these. */
    seen(px: number) {
      follow(trail.current, px, performance.now());
    },
    /**
     * The edge, drawn at `fromPx` (what is left of a jump before included), should now be drawn at `toPx`: drawn there
     * plus what is left, which the spring brings to nothing. Read at once (in the same move, or the release), the drawing
     * does not jump.
     */
    jump(fromPx: number, toPx: number, edge: T) {
      const gap = fromPx - toPx;
      if (!motionAllowed() || Math.abs(gap) < 0.5) {
        trail.current = [];
        return stop();
      }
      const now = performance.now();
      // the edge's own speed when it jumped (§5): the pointer's, as the edge followed it, or the spring's own when the pointer had stopped
      const speed = releaseSpeed(trail.current, now) || (spring.current?.v ?? 0);
      trail.current = [];
      spring.current = { x: gap, v: speed, to: 0 };
      tag.current = edge;
      setLeft({ px: gap, tag: edge });
      if (frame.current === null) frame.current = requestAnimationFrame(tick);
    },
    /** A new drag: what was left of the last one dropped, and the speed read again from its first move. */
    stop() {
      trail.current = [];
      stop();
    },
  }), [left, stop, tick]);
}
