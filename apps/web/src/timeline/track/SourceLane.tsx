import { useLayoutEffect, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Eye, SlidersHorizontal, Split, Trash2 } from "lucide-react";
import { carriedOf, sourceWindows, trimIn, windowShapeOf, type ClipValue, type SourceMarks, type SourceWindow } from "@afflatus/core";
import { ContextMenu, groups, headLine, useMenu } from "../../ContextMenu";
import { STRIP_FRAMES, stripUrl, type Asset, type Clip, type RecipeInfo, type Timeline } from "../../api";
import { cx } from "../../ui";
import { clock } from "../../format";
import { motionAllowed } from "../../useFlip";
import { fileVersion, PAD, type Slot } from "../model";
import { RemovedMark } from "./RemovedMark";
import { ROW, SOURCE } from "./rows";
import { edgeGive, resisted } from "./spring";
import { useSpringBack } from "./useSpringBack";

/**
 * A recipe that makes a long source window by window, and the inputs a clip of it keeps its part of the source in. Its
 * shape with `inputs` (the source's form): the run-up as set there, as the server cuts it (windowShapeOf).
 */
export function windowed(recipe: RecipeInfo | undefined, inputs?: Record<string, unknown>) {
  const shape = windowShapeOf(recipe, inputs);
  const driving = recipe?.inputs.find((i) => i.type === "clip" && i.role === "source" && i.window);
  const runUp = recipe?.traits?.windows?.runUp;
  return recipe && shape && driving?.type === "clip" && driving.window ? { shape, driving: driving.id, start: driving.window.start, seconds: driving.window.seconds, ...(runUp ? { runUp } : {}) } : null;
}

/**
 * The windows a source's stretch would be made in now (before Make: the clips to come, drawn on the track), at the spots
 * its `marks` say within its ± (its scene cuts, pauses and loudness, as the server reads them: useSourceMarks); without
 * them yet, at the length.
 */
export function plannedWindows(source: NonNullable<Timeline["source"]>, recipe: RecipeInfo | undefined, marks?: SourceMarks) {
  const w = windowed(recipe, source.inputs);
  return w ? sourceWindows({ fromMs: source.fromMs, toMs: source.toMs, windowMs: source.windowMs, ...(marks ? { withinMs: source.withinMs, ...marks } : {}), shape: w.shape }) : [];
}

/** The clips made from a timeline's source: those of a window-by-window model driven by its video. */
export function madeFromSource(t: Timeline, recipes: RecipeInfo[]): Timeline["clips"] {
  const source = t.source;
  if (!source) return [];
  return t.clips.filter((c) => {
    const b = windowed(recipes.find((r) => r.id === c.recipe));
    return Boolean(b && (c.inputs[b.driving] as ClipValue | undefined)?.asset === source.asset);
  });
}

/**
 * The empty clip a video dropped on the source lane is made into windows in place of (and whose model it takes): one given a
 * model that makes a source window by window, the one selected, else the first. Never a window of the source the lane has
 * now: a new video dropped once it is made would go in the middle of the old windows, which would stay as clips no longer
 * bound to any source.
 */
export function sourceDropClip(t: Timeline, recipes: RecipeInfo[], selected?: Clip | null): Clip | undefined {
  const old = new Set(madeFromSource(t, recipes).map((c) => c.id));
  const empty = (c: Clip) => !c.take && !c.job && !old.has(c.id) && Boolean(windowed(recipes.find((r) => r.id === c.recipe)));
  return (selected && empty(selected) ? selected : undefined) ?? t.clips.find(empty);
}

/**
 * Where the source's end, brought in to `toMs` once made, comes to rest: the server's own rule (trimIn) from the windows
 * on the timeline, so that the lane draws it there while it is dragged. A rendered window, or one in the queue, is never
 * shortened (the end goes to its nearer end); an empty one is, down to the fewest frames a window takes. An end taken out,
 * or a source not made yet, rests where it is asked.
 */
export function sourceEndRest(t: Timeline, recipes: RecipeInfo[], toMs: number): number {
  const source = t.source;
  const recipe = recipes.find((r) => r.id === source?.recipe);
  const w = windowed(recipe);
  const mine = madeFromSource(t, recipes);
  if (!source || !w || source.clip || !mine.length || toMs >= source.toMs) return toMs;
  const parts = mine.map((c, k) => {
    const from = Number(c.inputs[w.start] ?? 0) * 1000;
    // a window that carries on starts its own frames past its run-up, as the server reads it
    const start = c.joined === "continue" && k > 0 ? from + (carriedOf(recipe, c.inputs) * 1000) / w.shape.fps : from;
    return { id: c.id, from, start, end: from + Number(c.inputs[w.seconds] ?? 0) * 1000, whole: Boolean(c.take || c.job), busy: Boolean(c.job) };
  });
  return trimIn(parts, toMs, (w.shape.least / w.shape.fps) * 1000).toMs;
}

/** An end of the source's stretch: 8 px drawn, 24 px to take (WCAG 2.5.8), inside the lane where it is cut at its edge. */
const END_HIT = "absolute inset-y-0 z-10 w-2 cursor-ew-resize bg-accent before:absolute before:inset-y-0 before:-inset-x-2 before:content-['']";

export type SourcePlace ={ atMs: number; lengthMs: number; made: boolean; windows: SourceWindow[]; replaces: string | null };

/**
 * Where a timeline's source lies on the track (in the track's own time, as the clips are laid out), as the music lies
 * under the clips: before Make, its stretch starts where the made clips will go (in place of the clip it was taken from, or
 * after the last clip), the clips to come as `windows`; once made, where it was laid then. Null without a source.
 */
export function sourcePlace(t: Timeline, slots: Slot[], recipes: RecipeInfo[], marks?: SourceMarks): SourcePlace | null {
  const source = t.source;
  if (!source) return null;
  const made = !source.clip && madeFromSource(t, recipes).length > 0;
  const end = slots.length ? slots.at(-1)!.startMs + slots.at(-1)!.lengthMs : 0;
  const replaced = source.clip ? slots.find((s) => s.clip.id === source.clip) : undefined;
  const anchor = replaced ? replaced.startMs : end;
  return {
    atMs: made ? source.atMs : anchor - source.fromMs,
    lengthMs: source.video.durationMs ?? source.toMs,
    made,
    windows: made ? [] : plannedWindows(source, recipes.find((r) => r.id === source.recipe), marks),
    replaces: replaced ? replaced.clip.id : null,
  };
}

/**
 * The source lane, drawn as the music lane: the long video under the clips, its stretch to make lit where the made clips go,
 * the rest faint past both ends. Before Make, dragging it chooses where in the video Motion transfer starts (the video slides
 * under its place), its right end where it stops; once made, the clips made from it are outlined over their parts. Empty:
 * nothing here (its drop is the end column's, after the last clip). A click opens it (the stage plays it); right-click: its menu (split at the playhead among it).
 */
export function SourceLane({ timeline, place, recipes, pps, selected, over, onDragOver, onSelect, onOpen, onRemove, onStretch, onSplit, onPeek, slots = [], onBringBack }: {
  timeline: Timeline;
  place: SourcePlace | null;
  recipes: RecipeInfo[];
  pps: number;
  selected: boolean;
  /** A video is dragged over the lane. */
  over: boolean;
  onDragOver(e: DragEvent): void;
  onSelect(): void;
  /** Its video in the viewer; the source taken away. */
  onOpen?(video: Asset): void;
  onRemove?(): void;
  /**
   * Where Motion transfer starts and stops in the video, the lane dragged: settles true once the change is read back (the
   * timeline given to the lane by then has it, or has what the server made of it), false when it is not made (asked first,
   * failed, or another one asked for in its place).
   */
  onStretch?(fromMs: number, toMs: number): Promise<boolean> | void;
  /** The moment of the video a drag stands on (its new start, or its new end), to be shown meanwhile; null: the drag is over. */
  onPeek?(ms: number | null): void;
  /** Split at the playhead: the part before it a clip of its own, played as it is (null: the playhead is not in the stretch). */
  onSplit?: (() => void) | null;
  /** The track's clips, for the number of the clip after a part removed from the middle. */
  slots?: Slot[];
  /** A part cut out of the middle (its mark) brought back, by the clip after it. */
  onBringBack?(before: string): void;
}) {
  const menu = useMenu<true>();
  /**
   * A drag under way: its body slipped (the same length, another part of the video, which slides under it), its left end
   * (where it starts) or its right end (where it stops); where it started and what it shows meanwhile.
   */
  const [held, setHeld] = useState<{ kind: "slip" | "start" | "end"; x: number; from: number; to: number; fromMs: number; toMs: number; moved: boolean; drawFrom?: number; drawTo?: number } | null>(null);
  /**
   * The stretch released, drawn until its trim settles: back to the old one meanwhile, the lane looked as if the drag had
   * not been taken, and invited a second one. Let go on the settle itself, taken or not, rather than once the timeline
   * changes: a trim settles taken only once the timeline is read back (onStretch), and one the server took but left as it
   * was (an end snapped back onto a rendered window) never changed it, so that the stretch refused stayed drawn and the
   * next drag started from it.
   */
  const [sent, setSent] = useState<{ fromMs: number; toMs: number; kind: "slip" | "start" | "end"; drawTo?: number } | null>(null);
  /**
   * Past a limit (the video's ends, a second at least between them) the part dragged follows the pointer with resistance,
   * `drawFrom` / `drawTo` where it is drawn (the stretch it gives stays at the limit); an end brought in onto a rendered
   * window resists toward where it will rest (sourceEndRest) rather than jumping there once let go of. Let go of, or over a
   * window's middle, it is carried to where it goes on the spring.
   */
  const back = useSpringBack<"slip" | "start" | "end">();
  /** What the last render drew, and the timeline's own stretch: a trim settling reads them to carry the lane over. */
  const live = useRef<{ lineFrom: number; lineTo: number; fromMs: number; toMs: number; sent: typeof sent } | null>(null);
  /**
   * A trim settled, its part drawn at `drawnMs` meanwhile: carried from there to the timeline's own on the spring, measured
   * on the render that lets go of `sent` rather than in the settle itself. The timeline read back reaches the lane with that
   * render (the editor is drawn again on the settle), while at the settle the lane's last drawing still had the stretch from
   * before the trim, so that a trim taken was measured off by the whole trim and sprang the wrong way first.
   */
  const landing = useRef<{ kind: "slip" | "start" | "end"; drawnMs: number } | null>(null);
  useLayoutEffect(() => {
    const g = landing.current;
    const l = live.current;
    if (!g || !l || l.sent) return;
    landing.current = null;
    const leftPx = back.left.tag === g.kind ? back.left.px : 0;
    back.jump((g.drawnMs / 1000) * pps + leftPx, ((g.kind === "end" ? l.toMs : l.fromMs) / 1000) * pps, g.kind);
  });
  const source = timeline.source;
  const x = (ms: number) => PAD + (ms / 1000) * pps;
  // none yet: its drop is in the end column after the last clip, where its clips go (EndColumn)
  if (!source || !place) return null;
  const video = source.video;
  const length = place.lengthMs;
  const drawn = held ?? sent;
  const fromMs = drawn?.fromMs ?? source.fromMs;
  const toMs = drawn?.toMs ?? source.toMs;
  // where each part is drawn: past a limit a little further, and what the spring still carries of a jump
  const leftMs = (kind: "slip" | "start" | "end") => (back.left.tag === kind ? (back.left.px / pps) * 1000 : 0);
  const kindNow = held?.kind ?? sent?.kind ?? back.left.tag;
  const lineFrom = (held?.drawFrom ?? fromMs) + leftMs("slip") + leftMs("start");
  const lineTo = (held ? (held.drawTo ?? toMs) : (sent?.drawTo ?? toMs)) + leftMs("slip") + leftMs("end");
  // slipped, the video slides under the stretch's place (its start sits where the stretch starts, less the stretch's start in
  // it); its ends dragged, the video stays where it is
  const atMs = kindNow === "slip" ? place.atMs + source.fromMs - lineFrom : place.atMs;
  live.current = { lineFrom, lineTo, fromMs: source.fromMs, toMs: source.toMs, sent };
  const left = x(atMs);
  const w = (length / 1000) * pps;
  const cells = Math.max(1, Math.round(w / 40));
  // the lane is drawn from the track's start at the earliest: a video that starts before it is cut there
  const box = Math.max(PAD, left);
  const cut = box - left;
  // made or not: before Make the stretch's settings, after Make a trim (its end sets windows aside and brings them back,
  // its start makes them anew: asked first when that leaves rendered takes behind)
  const editable = Boolean(onStretch);

  const down = (kind: "slip" | "start" | "end") => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (!editable) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // a pointer that cannot be captured is followed while it stays over the lane
    }
    // from the stretch drawn: one released and not yet read back is where the next drag starts
    back.stop();
    landing.current = null;
    setHeld({ kind, x: e.clientX, from: fromMs, to: toMs, fromMs, toMs, moved: false });
  };
  const px = (ms: number) => (ms / 1000) * pps;
  /** The part dragged as drawn now, in ms (what the spring still carries included). */
  const edgeNow = (h: NonNullable<typeof held>) => (h.kind === "end" ? (h.drawTo ?? h.toMs) : (h.drawFrom ?? h.fromMs)) + leftMs(h.kind);
  /** Where an end let go of at `to` comes to rest: onto a rendered window's nearer end, once made. */
  const restOf = (h: NonNullable<typeof held>, to: number) => (place.made && to !== h.to ? sourceEndRest(timeline, recipes, to) : to);
  const move = (e: ReactPointerEvent) => {
    if (!held) return;
    const dx = e.clientX - held.x;
    if (!held.moved && Math.abs(dx) < 4) return;
    const dms = Math.round(((dx / pps) * 1000) / 100) * 100;
    const raw = (dx / pps) * 1000;
    const give = edgeGive(px(held.to - held.from));
    const free = motionAllowed();
    // how much further than `lo`..`hi` it is drawn for a pointer asking `asked`, in ms (0 within them)
    const past = (asked: number, lo: number, hi: number) => (resisted(px(asked), px(lo), px(hi), give, free) - px(Math.max(lo, Math.min(hi, asked)))) * (1000 / pps);
    let next: NonNullable<typeof held>;
    if (held.kind === "slip") {
      // the video slides under the place where the clips go, as the music's song does: left, the same length of it taken
      // later on (the rethink's slip)
      const span = held.to - held.from;
      const from = Math.max(0, Math.min(length - span, held.from - dms));
      const extra = past(held.from - raw, 0, length - span);
      next = { ...held, moved: true, fromMs: from, toMs: from + span, drawFrom: from + extra, drawTo: from + span + extra };
      onPeek?.(from);
    } else if (held.kind === "start") {
      const from = Math.max(0, Math.min(held.to - 1000, held.from + dms));
      next = { ...held, moved: true, fromMs: from, drawFrom: from + past(held.from + raw, 0, held.to - 1000) };
      onPeek?.(from);
    } else {
      const lo = held.from + 1000;
      const to = Math.max(lo, Math.min(length, held.to + dms));
      // brought in onto a rendered window, it resists toward where it will rest (the window's nearer end) instead
      const rest = restOf(held, to);
      const drawTo = rest === to ? to + past(held.to + raw, lo, length) : rest + past(Math.max(lo, Math.min(length, held.to + raw)), rest, rest);
      next = { ...held, moved: true, toMs: to, drawTo };
      // over a window's middle, where it rests changes sides: carried across on the spring rather than jumping there
      if (held.moved && restOf(held, held.toMs) !== rest) back.jump(px(edgeNow(held)), px(drawTo), "end");
      onPeek?.(to);
    }
    back.seen(px(edgeNow(next)));
    setHeld(next);
  };
  const up = () => {
    if (held?.moved) {
      let asked: Promise<boolean> | void = undefined;
      if (held.fromMs !== held.from || held.toMs !== held.to) asked = onStretch?.(held.fromMs, held.toMs);
      // where it is drawn from now: an end where it will rest, while the trim is on its way; else the stretch it had
      const rest = held.kind === "end" ? restOf(held, held.toMs) : held.fromMs;
      const after = asked ? rest : held.kind === "end" ? (sent?.drawTo ?? held.to) : held.from;
      // drawn past a limit, or short of where it will rest: carried there from where it was let go of, on the spring
      back.jump(px(edgeNow(held)), px(after), held.kind);
      // drawn meanwhile; settled, the timeline's again, read back by then when taken (a newer release's own drawing is
      // left alone)
      if (asked) {
        const ours = { fromMs: held.fromMs, toMs: held.toMs, kind: held.kind, ...(held.kind === "end" ? { drawTo: rest } : {}) };
        setSent(ours);
        void asked.then(() => {
          // settled elsewhere than drawn (asked first, refused, or the server's end not the one foreseen): carried from
          // where it is drawn to the timeline's own, rather than jumping there (`landing`, once the lane has the timeline)
          if (live.current?.sent === ours) landing.current = { kind: ours.kind, drawnMs: ours.kind === "end" ? (ours.drawTo ?? ours.toMs) : ours.fromMs };
          setSent((now) => (now === ours ? null : now));
        });
      }
    }
    if (held?.moved) onPeek?.(null);
    else if (held && !held.moved) onSelect();
    setHeld(null);
  };
  // a drag the browser took back (a touch turned into a scroll, the window lost): nothing is saved, and the stage leaves
  // the moment it was showing for the drag, where it stayed
  const cancel = () => {
    if (held?.moved) onPeek?.(null);
    back.stop();
    setHeld(null);
  };
  const bound = place.made
    ? timeline.clips.flatMap((c: Clip) => {
        const b = windowed(recipes.find((r) => r.id === c.recipe));
        const value = b ? (c.inputs[b.driving] as ClipValue | undefined) : undefined;
        if (!b || value?.asset !== source.asset) return [];
        const start = Number(c.inputs[b.start] ?? 0) * 1000;
        return [{ id: c.id, from: start, to: start + Number(c.inputs[b.seconds] ?? 0) * 1000 }];
      })
    : [];
  // within the lane: a moment of the video, in pixels from the lane's left
  const inLane = (ms: number) => (ms / 1000) * pps - cut;
  return (
    <>
      <div
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") onSelect();
          // focused on the lane, Delete takes it away with its clips, as with it selected
          else if ((e.key === "Delete" || e.key === "Backspace") && onRemove) {
            e.preventDefault();
            e.stopPropagation();
            onRemove();
          }
        }}
        onPointerDown={editable ? down("slip") : undefined}
        // the ends' moves and releases bubble up to these, the lane's own: a handle of its own as well would trim twice
        // on one release, the second request reading the timeline before the first one's change
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={cancel}
        onClick={() => !editable && onSelect()}
        onDragOver={onDragOver}
        onContextMenu={(e) => menu.open(e, true)}
        aria-label={`Source: ${video.name}`}
        aria-pressed={selected}
        data-hint={editable ? "click: the source in the stage · drag: slip (the same length, another part of it) · its ends: where it starts and stops · right-click: split" : "click: the source in the stage, its settings · right-click: its menu"}
        style={{ left: box, width: Math.max(8, w - cut), top: SOURCE.top, height: SOURCE.height }}
        className={cx("absolute overflow-hidden rounded", editable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer", over && "outline outline-2 outline-accent")}
      >
        <span className="pointer-events-none absolute inset-y-0 flex" style={{ left: -cut, width: w }}>
          {Array.from({ length: cells }, (_, k) => {
            const frame = Math.min(STRIP_FRAMES - 1, Math.floor(((k + 0.5) / cells) * STRIP_FRAMES));
            return <span key={k} className="h-full grow bg-raised" style={{ backgroundImage: `url(${stripUrl(video.id)}&v=${fileVersion(video)})`, backgroundSize: `${STRIP_FRAMES * 100}% 100%`, backgroundPosition: `${(frame / (STRIP_FRAMES - 1)) * 100}% 0` }} />;
          })}
        </span>
        {/* the video before the stretch and after it faint, as the music's song past the clips */}
        <span className="pointer-events-none absolute inset-y-0 left-0 bg-ground/75" style={{ width: Math.max(0, inLane(lineFrom)) }} />
        <span className="pointer-events-none absolute inset-y-0 bg-ground/75" style={{ left: inLane(lineTo), right: 0 }} />
        {/* the stretch made into clips, lit, where its clips are */}
        <span className={cx("pointer-events-none absolute inset-y-0 rounded border-2", selected ? "border-accent" : "border-ink-3")} style={{ left: Math.max(0, inLane(lineFrom)), width: Math.max(4, inLane(lineTo) - Math.max(0, inLane(lineFrom))) }} />
        {bound.map((b) => (
          <span key={b.id} className="pointer-events-none absolute inset-y-1 rounded-sm border border-accent/70" style={{ left: inLane(b.from), width: Math.max(4, ((b.to - b.from) / 1000) * pps) }} />
        ))}
        {/* the parts cut out of the middle by removing their windows: the stretch of the video the clips jump over */}
        {/* none while the window after it is set aside itself (the Out brought in past it): it comes back with that window */}
        {(source.removed ?? []).map((p) => {
          const after = slots.find((s) => s.clip.id === p.before);
          return after ? <RemovedMark key={p.before} part={p} left={inLane(p.fromMs)} width={((p.toMs - p.fromMs) / 1000) * pps} number={after.index + 1} onBringBack={onBringBack} /> : null;
        })}
        <span className="pointer-events-none absolute top-0.5 rounded bg-ground/85 px-1 text-micro font-semibold whitespace-nowrap" style={{ left: Math.max(2, inLane(lineFrom) + 3) }}>
          {held ? (held.kind === "slip" ? `${(fromMs / 1000).toFixed(1)}–${(toMs / 1000).toFixed(1)} s` : `${((held.kind === "start" ? fromMs : toMs) / 1000).toFixed(1)} s${held.kind === "end" ? ": stops here" : ": starts here"}`) : `${video.name} · from ${(fromMs / 1000).toFixed(1)} s`}
        </span>
        {/* its left end: where it starts in the video */}
        {editable && (
          <span
            role="separator"
            aria-label="Drag: where the source's stretch starts"
            data-hint={`drag: where it starts (${(fromMs / 1000).toFixed(1)} s of the source)`}
            onPointerDown={down("start")}
            className={cx(END_HIT, "rounded-l")}
            style={{ left: Math.max(0, inLane(lineFrom)) }}
          />
        )}
        {/* its right end: where Motion transfer stops */}
        {editable && (
          <span
            role="separator"
            aria-label="Drag: where Motion transfer stops in the source"
            data-hint={`drag: where Motion transfer stops (${(toMs / 1000).toFixed(1)} s of the source)`}
            onPointerDown={down("end")}
            className={cx(END_HIT, "rounded-r")}
            style={{ left: inLane(lineTo) - 8 }}
          />
        )}
      </div>
      {menu.menu && (
        <ContextMenu
          at={menu.menu.at}
          label="The source"
          head={{ title: "Source", sub: headLine(video.name || "Video", video.durationMs ? <span className="font-mono">{clock(video.durationMs)}</span> : null) }}
          items={groups(
            [
              { label: "Source settings", icon: <SlidersHorizontal size={14} />, note: "its form, Make N clips", run: onSelect },
              ...(onOpen ? [{ label: "Open its video", icon: <Eye size={14} />, note: "the viewer", run: () => onOpen(video) }] : []),
            ],
            onSplit !== undefined && !place.made && [{ label: "Split at the playhead", key: "S", icon: <Split size={14} />, disabled: !onSplit, note: onSplit ? "the part before plays as it is; Motion transfer starts there" : "put the playhead inside the stretch", run: () => onSplit?.() }],
            onRemove && [{ label: "Remove the source", icon: <Trash2 size={14} />, key: "Del", danger: true, note: "with the clips made from it (Undo brings them back)", run: onRemove }],
          )}
          onClose={menu.close}
        />
      )}
    </>
  );
}

/** The clips Make will add, drawn on the video row where they will go: dashed, numbered, with what makes them. */
export function ToCome({ place, pps, label }: { place: SourcePlace; pps: number; label: string }) {
  const x = (ms: number) => PAD + (ms / 1000) * pps;
  return (
    <>
      {place.windows.map((w, k) => (
        <div
          key={k}
          aria-hidden
          data-hint="a clip Make will add here (the source's settings, in its panel)"
          className="pointer-events-none absolute flex flex-col justify-between overflow-hidden rounded-lg border-2 border-dashed border-accent/70 bg-accent-wash/40 px-1.5 py-1 text-meta"
          style={{ left: x(place.atMs + w.fromMs) + 1, width: Math.max(8, ((w.toMs - w.fromMs) / 1000) * pps - 2), top: ROW.top, height: ROW.height }}
        >
          <span className="truncate font-bold text-accent">{k + 1} · {label}</span>
          <span className="truncate text-ink-2">to make · {((w.toMs - w.fromMs) / 1000).toFixed(1)} s</span>
        </div>
      ))}
    </>
  );
}
