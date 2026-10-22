import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { fileUrl, type Clip, type RecipeInfo } from "../../api";
import { cx } from "../../ui";
import { PAD, pinInputs, stamp, type Slot } from "../model";
import { ClipFacts } from "./ClipFacts";
import { fitFrame, frameUrl, HINTS, PEEK, pinnedNote } from "./peek";
import { PeekCard, PeekEmpty, PeekFooter, PeekFrame, preload } from "./PeekCard";
import { ROW } from "./rows";

/** How long the pointer is over the track before the frame card shows; and how often it asks for another frame. */
const SHOW_AFTER_MS = 120;
const FRAME_EVERY_MS = 60;

/** Where the pointer is over the track: in the track's pixels and the viewport's, the clip under it, and the gesture hint of what is there. */
interface Over {
  x: number;
  clientX: number;
  /** The ruler's top edge, in the viewport: the card stands on it. */
  top: number;
  slot: Slot;
  hint: string;
  /** On the clip itself, not the ruler above it: the card says the clip's figures too. */
  onClip: boolean;
}

/**
 * The frame under the pointer, shown on a card above the ruler as the pointer moves along the ruler and the
 * clips: the take's own frame, the still, or a short card for a clip that is not rendered yet. A thin line marks
 * the pointer's place through the ruler and the clips, and the clip under it is outlined. It listens on the
 * track itself, so that only it draws again as the pointer moves; it hides while a button is held (the
 * playhead or a range being dragged: the viewer shows the frame then), while something is dragged, and while
 * `paused` (a pinned picture's card is up, an edge is being dragged). On a clip, the card says the clip's
 * words too (ClipFacts: its form, its chips), beside a standing frame or under a lying one; over the ruler, the frame
 * alone. About 320 px wide, and never up to the stage's middle.
 */
export function FramePeek({ area, floor, slots, clips, recipes, pps, totalMs, paused }: {
  /** The track's inner surface, ruler included: what the pointer moves over. */
  area: RefObject<HTMLDivElement | null>;
  /** The editor's track panel: the card stays between its edges. */
  floor: RefObject<HTMLDivElement | null>;
  slots: Slot[];
  clips: Clip[];
  recipes: RecipeInfo[];
  pps: number;
  totalMs: number;
  paused: boolean;
}) {
  const [over, setOver] = useState<Over | null>(null);
  /** The frame asked for, at most every FRAME_EVERY_MS; it trails the pointer by that much at most. */
  const [url, setUrl] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const live = useRef({ slots, pps, totalMs, paused });
  live.current = { slots, pps, totalMs, paused };

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let trail: ReturnType<typeof setTimeout> | null = null;
    let askedAt = 0;
    let isArmed = false;
    let latest: string | null = null;
    const ask = () => {
      trail = null;
      askedAt = performance.now();
      setUrl(latest);
      if (latest) preload(latest).catch(() => {});
    };
    const hide = () => setOver(null);
    const reset = () => {
      if (timer) clearTimeout(timer);
      if (trail) clearTimeout(trail);
      timer = trail = null;
      isArmed = false;
      setArmed(false);
      hide();
    };
    const move = (e: PointerEvent) => {
      const { slots, pps, totalMs, paused } = live.current;
      const box = el.getBoundingClientRect();
      const x = e.clientX - box.left;
      const y = e.clientY - box.top;
      const target = e.target as Element | null;
      // held down: the playhead or a range is being dragged, a clip's edge pulled; the viewer shows the frame
      if (paused || e.buttons || y > ROW.top + ROW.height || target?.closest("[data-pin]")) return hide();
      const slot = slots.find((s) => x >= s.left && x < s.left + s.width);
      if (!slot || x > PAD + (totalMs / 1000) * pps) return hide();
      const c = slot.clip;
      const take = !slot.planned && c.take ? c.take : null;
      // short of the very end, where ffmpeg finds no picture (see pinCompare)
      latest = take ? frameUrl(take.asset, Math.min(take.endMs - 60, take.startMs + Math.max(0, Math.min(1, (x - slot.left) / Math.max(1, slot.width))) * slot.lengthMs), fitFrame(take.asset.width, take.asset.height, PEEK.frame).h) : null;
      if (performance.now() - askedAt >= FRAME_EVERY_MS) ask();
      else trail ??= setTimeout(ask, FRAME_EVERY_MS);
      setOver({ x, clientX: e.clientX, top: box.top, slot, hint: target?.closest<HTMLElement>("[data-hint]")?.dataset.hint ?? HINTS.ruler, onClip: y >= ROW.top });
      if (!isArmed && !timer) {
        timer = setTimeout(() => {
          timer = null;
          isArmed = true;
          setArmed(true);
        }, SHOW_AFTER_MS);
      }
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", reset);
    el.addEventListener("pointerdown", hide);
    el.addEventListener("pointercancel", hide);
    // the wheel scrolls or zooms the track from under the pointer: the card would show what is no longer there
    el.addEventListener("wheel", hide, { passive: true });
    el.addEventListener("dragstart", reset);
    el.addEventListener("dragenter", reset);
    return () => {
      reset();
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", reset);
      el.removeEventListener("pointerdown", hide);
      el.removeEventListener("pointercancel", hide);
      el.removeEventListener("wheel", hide);
      el.removeEventListener("dragstart", reset);
      el.removeEventListener("dragenter", reset);
    };
  }, [area]);

  useEffect(() => {
    if (paused) setOver(null);
  }, [paused]);

  if (!over || paused) return null;
  const s = over.slot;
  const c = s.clip;
  const take = !s.planned && c.take ? c.take : null;
  const still = c.kind === "still" && c.still ? c.still : null;
  const atMs = Math.max(0, Math.min(totalMs, ((over.x - PAD) / pps) * 1000));
  const bounds = floor.current?.getBoundingClientRect();
  // the card stands on the ruler and stops short of the stage's middle, where the picture being scrubbed is: a frame of
  // its own beside the clip, not a second picture over the first (the stage is the [data-stage] just above the track)
  const stage = [...document.querySelectorAll<HTMLElement>("[data-stage]")].map((e) => e.getBoundingClientRect()).filter((r) => r.height > 40 && r.bottom <= over.top + 1).sort((a, b) => b.bottom - a.bottom)[0];
  const ceiling = stage ? stage.top + stage.height / 2 : 0;
  const words = over.onClip;
  // what the card has for its frame: its room under the ceiling, without its padding, the footer and (a lying frame)
  // the clip's words under it
  const room = over.top - PEEK.margin * 2 - ceiling - PEEK.chrome * 2 - PEEK.footer;
  const asset = take ? take.asset : still;
  const standing = Boolean(asset?.width && asset.height && asset.height > asset.width);
  const box = standing ? { w: PEEK.side, h: Math.max(64, Math.min(200, room)) } : { w: PEEK.card, h: Math.max(64, Math.min(170, room - (words ? 72 : 0))) };

  let frame: ReactNode;
  let title: string;
  if (asset) {
    const size = fitFrame(asset.width, asset.height, box);
    frame = <PeekFrame url={take ? url : fileUrl(still!.id)} w={size.w} h={size.h} className={standing ? undefined : "mx-auto"} />;
    title = take ? `clip ${s.index + 1} · take ${c.takes.findIndex((t) => t.id === take.id) + 1}` : `clip ${s.index + 1} · still`;
  } else {
    const pins = pinInputs(recipes.find((r) => r.id === c.recipe));
    const has = (id: string | undefined) => Boolean(id && typeof c.inputs[id] === "string");
    const carries = s.index > 0 && c.joined === "continue";
    const note = pinnedNote({ start: !carries && has(pins.start), end: has(pins.end), mid: has(pins.mid) });
    // the clip's words say what is happening to it: the stand-in is only the frame's place
    frame = words ? null : <PeekEmpty w={PEEK.card}>{c.job ? (c.job.status === "running" ? "Rendering now" : "Queued") : c.failed ? "The render failed" : "Not rendered yet"}</PeekEmpty>;
    title = `clip ${s.index + 1}${note ? ` · ${note}` : c.failed ? " · render failed" : " · not rendered yet"}`;
  }

  return (
    <>
      {armed && (
        <>
          {/* where the pointer is, through the ruler and the clips; and the clip it is over */}
          <div aria-hidden className="pointer-events-none absolute top-0 z-[13] w-[1.5px] bg-accent" style={{ left: over.x - 0.75, height: ROW.top + ROW.height }} />
          <div aria-hidden className={cx("pointer-events-none absolute z-[13] rounded-lg border-2 border-accent", s.planned && "border-dashed")} style={{ left: s.left + 1, width: Math.max(8, s.width - 2), top: ROW.top, height: ROW.height }} />
          <PeekCard x={over.clientX} y={over.top - PEEK.margin} width={PEEK.card} bounds={bounds ? { left: bounds.left, right: bounds.right } : undefined} label={`Frame at ${stamp(atMs)}`}>
            {/* a standing frame beside the clip's words, a lying one over them: about 320 px wide either way */}
            <div className={cx("flex gap-3", standing ? "items-start" : "flex-col")}>
              {frame}
              {words && <ClipFacts clip={c} index={s.index} clips={clips} />}
            </div>
            <PeekFooter title={title} right={stamp(atMs)} mono hint={over.hint} />
          </PeekCard>
        </>
      )}
    </>
  );
}
