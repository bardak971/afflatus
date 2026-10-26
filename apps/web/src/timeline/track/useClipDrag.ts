import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { motionAllowed } from "../../useFlip";
import { PAD, type Slot } from "../model";
import { follow, releaseSpeed, rubberband, stepSpring, type Spring, type Trail } from "./spring";

/** How far the pointer goes before a press on a clip (or on its trim edge) is a drag rather than a click (px). */
export const SLOP_PX = 4;
/** Near the track's visible ends, a dragged clip scrolls it: how near (px), and how fast at the very edge (px per second). */
const EDGE_PX = 40;
const EDGE_SPEED = 700;
/** How long a dropped order is kept on screen after its move was answered, waiting for the timeline read again (ms). */
const HOLD_MS = 3000;

/** Where each clip starts when they stand in `order`, edge to edge from the track's start (the layout's own sum). */
export function leftsOf(order: readonly string[], widths: ReadonlyMap<string, number>): Map<string, number> {
  const at = new Map<string, number>();
  let x = PAD;
  for (const id of order) {
    at.set(id, x);
    x += widths.get(id) ?? 0;
  }
  return at;
}

/**
 * The order while `clip` is dragged with its left edge at `left`: it goes before the first other clip whose middle its own
 * middle has not passed (as the mock's drag, section 4), the others keeping theirs. Read against where the others stand
 * now, so that a clip just passed does not swap back for a pixel's move.
 */
export function orderWhileDragged(order: readonly string[], clip: string, left: number, widths: ReadonlyMap<string, number>): string[] {
  const at = leftsOf(order, widths);
  const mid = left + (widths.get(clip) ?? 0) / 2;
  const rest = order.filter((id) => id !== clip);
  let k = rest.findIndex((id) => mid < (at.get(id) ?? 0) + (widths.get(id) ?? 0) / 2);
  if (k < 0) k = rest.length;
  return [...rest.slice(0, k), clip, ...rest.slice(k)];
}

/** A press on a clip, from the press to the release or Esc. */
type Session = {
  clip: string;
  pointer: number;
  el: HTMLElement;
  downX: number;
  clientX: number;
  /** Where on the clip it was taken, in track px from its left edge: the clip stays under the pointer by that much. */
  grab: number;
  moved: boolean;
  /** The order now, and the one it started from. */
  order: string[];
  from: string[];
  trail: Trail;
};

/** What the track shows of a clip move: the clip, the order it would land in, and whether the pointer still holds it. */
export type ClipMove = { clip: string; order: string[]; holding: boolean };

/**
 * A clip moved along the track by the pointer, 1:1 (review 4, P7; the apple-design skill §2–§5). The clip follows the
 * pointer at the place it was taken by, the others slide aside as it passes their middles, and on release it settles into
 * its slot carrying the pointer's speed, on a critically damped spring (spring.ts). Under reduced motion the others and the
 * landing jump instead of gliding; the clip itself still follows the pointer, which is not an animation. Esc during the
 * drag puts everything back. The move is the one patch it always was (one Undo step).
 *
 * Nothing here draws through React while it moves: each clip's parts sit in a wrapper (`mount(id)`) moved by a transform
 * written every frame, from the slot the timeline gives it. The timeline is not changed until the move comes back from the
 * server: meanwhile the dropped order is held on screen, and once the timeline says it, the clips' new slots replace the
 * transforms without a jump. A move refused lets the clips glide back.
 */
export function useClipDrag({ slots, pps, xOf, scroller, onMove }: {
  slots: Slot[];
  pps: number;
  xOf(clientX: number): number;
  scroller: RefObject<HTMLDivElement | null>;
  /** The clip put after `after` (null: first); its answer, when it gives one, says whether the move held. */
  onMove(clip: string, after: string | null): Promise<unknown> | void;
}) {
  const live = useRef({ slots, xOf, onMove });
  live.current = { slots, xOf, onMove };
  const els = useRef(new Map<string, HTMLElement>());
  const refs = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const springs = useRef(new Map<string, Spring>());
  const session = useRef<Session | null>(null);
  /** The order dropped, shown until the timeline read again says it. */
  const held = useRef<string[] | null>(null);
  const frame = useRef<number | null>(null);
  const lastAt = useRef(0);
  /** The click that follows a drag's release is not a click on the clip. */
  const swallow = useRef(false);
  const seenPps = useRef(pps);
  const [shown, setShown] = useState<ClipMove | null>(null);

  const realOrder = () => live.current.slots.map((s) => s.clip.id);
  const widths = () => new Map(live.current.slots.map((s) => [s.clip.id, s.width]));

  /** Each spring's target: the slot its clip has in the order dragged, dropped, or the timeline's. */
  const aim = () => {
    const order = session.current?.moved ? session.current.order : (held.current ?? realOrder());
    const at = leftsOf(order, widths());
    for (const [id, s] of springs.current) s.to = at.get(id) ?? s.to;
  };

  /** Each clip drawn where its spring is, as a shift from the slot the page lays it out at. */
  const draw = () => {
    const base = new Map(live.current.slots.map((s) => [s.clip.id, s.left]));
    for (const [id, s] of springs.current) {
      const el = els.current.get(id);
      const from = base.get(id);
      if (!el || from === undefined) continue;
      const dx = s.x - from;
      el.style.transform = Math.abs(dx) < 0.01 ? "" : `translateX(${dx}px)`;
    }
  };

  const onKey = useRef<(e: KeyboardEvent) => void>(() => {});
  // the one function added and removed: onKey is made anew at each render, and the one removed was not the one added
  const keyHeard = useRef((e: KeyboardEvent) => onKey.current(e)).current;
  const listen = (on: boolean) => {
    // capturing, so that the editor's own Esc (which lets go of the selection) does not hear the one that put a clip back
    if (on) window.addEventListener("keydown", keyHeard, true);
    else window.removeEventListener("keydown", keyHeard, true);
  };

  /** All at rest, nothing held: the clips are where the timeline lays them, with no transform left. */
  const finish = () => {
    for (const el of els.current.values()) el.style.transform = "";
    springs.current.clear();
    lastAt.current = 0;
    setShown(null);
  };

  /** The dragged clip at the pointer, the track's ends resisting (§9), and the order it makes. */
  const place = (ses: Session) => {
    const w = widths();
    const width = w.get(ses.clip) ?? 0;
    const end = [...w.values()].reduce((a, b) => a + b, PAD) - width;
    let x = live.current.xOf(ses.clientX) - ses.grab;
    if (x < PAD) x = PAD - rubberband(PAD - x, Math.max(40, width));
    else if (x > end) x = end + rubberband(x - end, Math.max(40, width));
    const sp = springs.current.get(ses.clip);
    if (sp) {
      sp.x = x;
      sp.v = 0;
    }
    const next = orderWhileDragged(ses.order, ses.clip, x, w);
    if (next.join("\u0000") !== ses.order.join("\u0000")) {
      ses.order = next;
      aim();
      setShown({ clip: ses.clip, order: next, holding: true });
    }
  };

  const tick = (t: number) => {
    frame.current = null;
    const dt = Math.min(0.064, (t - (lastAt.current || t)) / 1000);
    lastAt.current = t;
    const ses = session.current?.moved ? session.current : null;
    // held near an end of the visible track, the clip scrolls it, faster the nearer
    const box = ses && scroller.current;
    if (ses && box) {
      const r = box.getBoundingClientRect();
      const push = ses.clientX < r.left + EDGE_PX ? -(r.left + EDGE_PX - ses.clientX) : ses.clientX > r.right - EDGE_PX ? ses.clientX - (r.right - EDGE_PX) : 0;
      if (push) {
        const was = box.scrollLeft;
        box.scrollLeft += Math.max(-1, Math.min(1, push / EDGE_PX)) * EDGE_SPEED * dt;
        if (box.scrollLeft !== was) place(ses);
      }
    }
    const glide = motionAllowed();
    let resting = !ses;
    for (const [id, s] of springs.current) {
      if (ses && id === ses.clip) continue;
      if (!glide) {
        s.x = s.to;
        s.v = 0;
      } else if (!stepSpring(s, dt)) resting = false;
    }
    draw();
    if (!resting) {
      frame.current = requestAnimationFrame(tick);
      return;
    }
    lastAt.current = 0;
    // at rest: done, unless the order dropped is still waiting for the timeline to say it (the clips stay where they landed)
    if (!session.current && !held.current) finish();
  };
  const run = () => {
    if (frame.current === null) frame.current = requestAnimationFrame(tick);
  };

  /** The drag let go of without a move: the clips glide back to the order they had (Esc, or a pointer the browser took back). */
  const putBack = () => {
    const ses = session.current;
    session.current = null;
    if (!ses?.moved) {
      if (springs.current.size) run();
      return;
    }
    listen(false);
    swallow.current = true;
    try {
      ses.el.releasePointerCapture(ses.pointer);
    } catch {
      // already let go of
    }
    const sp = springs.current.get(ses.clip);
    if (sp) sp.v = 0;
    aim();
    setShown({ clip: ses.clip, order: held.current ?? realOrder(), holding: false });
    run();
  };
  onKey.current = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !session.current?.moved) return;
    e.preventDefault();
    e.stopPropagation();
    putBack();
  };

  const down = (e: ReactPointerEvent<HTMLElement>, s: Slot) => {
    if (e.button !== 0 || session.current) return;
    swallow.current = false;
    // taken again while it still glides: from where it is seen, not from its slot (§3)
    const seen = springs.current.get(s.clip.id)?.x ?? s.left;
    const from = held.current ?? realOrder();
    session.current = { clip: s.clip.id, pointer: e.pointerId, el: e.currentTarget, downX: e.clientX, clientX: e.clientX, grab: live.current.xOf(e.clientX) - seen, moved: false, order: from, from, trail: [] };
  };

  const move = (e: ReactPointerEvent) => {
    const ses = session.current;
    if (!ses || e.pointerId !== ses.pointer) return;
    ses.clientX = e.clientX;
    if (!ses.moved) {
      if (Math.abs(e.clientX - ses.downX) < SLOP_PX) return;
      ses.moved = true;
      try {
        ses.el.setPointerCapture(ses.pointer);
      } catch {
        // a pointer that cannot be captured is followed while it stays over the clip
      }
      const base = new Map(live.current.slots.map((x) => [x.clip.id, x.left]));
      for (const [id, left] of base) if (!springs.current.has(id)) springs.current.set(id, { x: left, v: 0, to: left });
      listen(true);
      setShown({ clip: ses.clip, order: ses.order, holding: true });
      aim();
    }
    follow(ses.trail, e.clientX, e.timeStamp);
    place(ses);
    // drawn at once, not at the next frame: the clip is under the pointer at every move (§1)
    draw();
    run();
  };

  const up = (e: ReactPointerEvent) => {
    const ses = session.current;
    // the click this release makes comes before any timer: the one after a drag (or after Esc put it back) is swallowed,
    // and none later (a click made by a key or a script has no press before it to clear it)
    const once = () => setTimeout(() => (swallow.current = false), 0);
    if (!ses || e.pointerId !== ses.pointer) {
      if (swallow.current) once();
      return;
    }
    session.current = null;
    // a click: a glide it interrupted, if any, carries on to its end
    if (!ses.moved) {
      if (springs.current.size) run();
      return;
    }
    listen(false);
    swallow.current = true;
    once();
    const sp = springs.current.get(ses.clip);
    // the pointer's speed handed to the spring (§5): the landing carries on the motion, without a seam
    if (sp) sp.v = releaseSpeed(ses.trail, e.timeStamp);
    if (ses.order.join("\u0000") !== ses.from.join("\u0000")) {
      const order = ses.order;
      held.current = order;
      const k = order.indexOf(ses.clip);
      const letGo = () => {
        if (held.current !== order) return;
        held.current = null;
        aim();
        run();
      };
      // refused: the clips glide back; answered but not read back in time: the same, rather than held for ever
      Promise.resolve(live.current.onMove(ses.clip, k > 0 ? order[k - 1]! : null)).then(() => setTimeout(letGo, HOLD_MS), letGo);
    }
    aim();
    setShown({ clip: ses.clip, order: held.current ?? realOrder(), holding: false });
    run();
  };

  // the timeline read again (or the zoom, or a clip added or gone): the clips' slots moved under their springs
  useLayoutEffect(() => {
    if (!springs.current.size) {
      seenPps.current = pps;
      return;
    }
    const real = realOrder();
    if (held.current && held.current.join("\u0000") === real.join("\u0000")) held.current = null;
    // a dropped order that no longer has the timeline's clips (one added or removed meanwhile) is let go of
    if (held.current && (held.current.length !== real.length || held.current.some((id) => !real.includes(id)))) held.current = null;
    const ses = session.current;
    if (ses?.moved && !real.includes(ses.clip)) putBack();
    for (const id of springs.current.keys()) if (!real.includes(id)) springs.current.delete(id);
    for (const s of slots) if (!springs.current.has(s.clip.id)) springs.current.set(s.clip.id, { x: s.left, v: 0, to: s.left });
    if (session.current?.moved) {
      if (session.current.order.length !== real.length || session.current.order.some((id) => !real.includes(id))) session.current.order = orderWhileDragged(real, session.current.clip, springs.current.get(session.current.clip)!.x, widths());
    }
    aim();
    // zoomed meanwhile: what was in pixels is not at this scale any more, so all of it lands where it goes
    if (seenPps.current !== pps) {
      for (const [id, s] of springs.current) {
        if (session.current?.moved && id === session.current.clip) continue;
        s.x = s.to;
        s.v = 0;
      }
      if (session.current?.moved) place(session.current);
    }
    seenPps.current = pps;
    draw();
    run();
  }, [slots, pps]); // eslint-disable-line react-hooks/exhaustive-deps -- the clips' slots are what it follows; the rest is read through refs

  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    window.removeEventListener("keydown", keyHeard, true);
  }, [keyHeard]);

  /** Each clip's wrapper, the one thing moved for it (its parts inside are laid out from its slot). */
  const mount = useCallback((id: string) => {
    let ref = refs.current.get(id);
    if (!ref) {
      ref = (el: HTMLElement | null) => {
        if (el) els.current.set(id, el);
        else els.current.delete(id);
      };
      refs.current.set(id, ref);
    }
    return ref;
  }, []);

  /** A click that is the end of a drag: not a click on the clip (it would select it and move the playhead there). */
  const dragged = () => {
    const was = swallow.current;
    swallow.current = false;
    return was;
  };

  return { down, move, up, cancel: putBack, mount, dragged, shown };
}
