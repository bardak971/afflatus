import { useState, type DragEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Eye, Film, SlidersHorizontal, Split, Trash2 } from "lucide-react";
import { sourceWindows, windowShapeOf, type ClipValue, type SourceWindow } from "@afflatus/core";
import { ContextMenu, useMenu } from "../../ContextMenu";
import { STRIP_FRAMES, stripUrl, type Asset, type Clip, type RecipeInfo, type Timeline } from "../../api";
import { cx } from "../../ui";
import { fileVersion, PAD, type Slot } from "../model";
import { ROW, SOURCE } from "./rows";

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

/** The windows a source's stretch would be made in now (before Make: the clips to come, drawn on the track; scene cuts are read by the server). */
export function plannedWindows(source: NonNullable<Timeline["source"]>, recipe: RecipeInfo | undefined) {
  const w = windowed(recipe, source.inputs);
  return w ? sourceWindows({ fromMs: source.fromMs, toMs: source.toMs, windowMs: source.windowMs, shape: w.shape }) : [];
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

export type SourcePlace ={ atMs: number; lengthMs: number; made: boolean; windows: SourceWindow[]; replaces: string | null };

/**
 * Where a timeline's source lies on the track (in the track's own time, as the clips are laid out), as the music lies
 * under the clips: before Make, its stretch starts where the made clips will go (in place of the clip it was taken from, or
 * after the last clip), the clips to come as `windows`; once made, where it was laid then. Null without a source.
 */
export function sourcePlace(t: Timeline, slots: Slot[], recipes: RecipeInfo[]): SourcePlace | null {
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
    windows: made ? [] : plannedWindows(source, recipes.find((r) => r.id === source.recipe)),
    replaces: replaced ? replaced.clip.id : null,
  };
}

/**
 * The source lane, drawn as the music lane: the long video under the clips, its stretch to make lit where the made clips go,
 * the rest faint past both ends. Before Make, dragging it chooses where in the video Motion transfer starts (the video slides
 * under its place), its right end where it stops; once made, the clips made from it are outlined over their parts. Empty: a
 * place to drop one. A click opens it (the stage plays it); right-click: its menu (split at the playhead among it).
 */
export function SourceLane({ timeline, place, recipes, pps, width, selected, over, onDragOver, onSelect, onOpen, onRemove, onStretch, onSplit, onPeek }: {
  timeline: Timeline;
  place: SourcePlace | null;
  recipes: RecipeInfo[];
  pps: number;
  width: number;
  selected: boolean;
  /** A video is dragged over the lane. */
  over: boolean;
  onDragOver(e: DragEvent): void;
  onSelect(): void;
  /** Its video in the viewer; the source taken away. */
  onOpen?(video: Asset): void;
  onRemove?(): void;
  /** Where Motion transfer starts and stops in the video, the lane dragged. */
  onStretch?(fromMs: number, toMs: number): void;
  /** The moment of the video a drag stands on (its new start, or its new end), to be shown meanwhile; null: the drag is over. */
  onPeek?(ms: number | null): void;
  /** Split at the playhead: the part before it a clip of its own, played as it is (null: the playhead is not in the stretch). */
  onSplit?: (() => void) | null;
}) {
  const menu = useMenu<true>();
  /** A drag under way: the whole video slid, or its right end; where it started and what it shows meanwhile. */
  const [held, setHeld] = useState<{ kind: "slide" | "end"; x: number; from: number; to: number; fromMs: number; toMs: number; moved: boolean } | null>(null);
  const source = timeline.source;
  const x = (ms: number) => PAD + (ms / 1000) * pps;
  if (!source || !place) {
    return (
      <button
        type="button"
        onDragOver={onDragOver}
        onClick={onSelect}
        aria-label="Source: none. Drop a long video here."
        style={{ left: PAD + 1, top: SOURCE.top, height: SOURCE.height, width: Math.max(160, width - PAD * 2 - 60) }}
        className={cx("absolute flex items-center gap-1.5 overflow-hidden rounded border border-dashed border-line-strong px-2 text-left text-[11px] text-ink-3", over && "outline outline-2 outline-accent")}
      >
        <Film size={11} className="relative shrink-0" />
        <span className="relative truncate">Drop a long video here: Motion transfer, window by window</span>
      </button>
    );
  }
  const video = source.video;
  const length = place.lengthMs;
  const fromMs = held?.fromMs ?? source.fromMs;
  const toMs = held?.toMs ?? source.toMs;
  // the video slides under the stretch's place: its start sits where the stretch starts, less the stretch's start in it
  const atMs = place.made ? place.atMs : place.atMs + source.fromMs - fromMs;
  const left = x(atMs);
  const w = (length / 1000) * pps;
  const cells = Math.max(1, Math.round(w / 40));
  // the lane is drawn from the track's start at the earliest: a video that starts before it is cut there
  const box = Math.max(PAD, left);
  const cut = box - left;
  const editable = Boolean(onStretch) && !place.made;

  const down = (kind: "slide" | "end") => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (!editable) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // a pointer that cannot be captured is followed while it stays over the lane
    }
    setHeld({ kind, x: e.clientX, from: source.fromMs, to: source.toMs, fromMs: source.fromMs, toMs: source.toMs, moved: false });
  };
  const move = (e: ReactPointerEvent) => {
    if (!held) return;
    const dx = e.clientX - held.x;
    if (!held.moved && Math.abs(dx) < 4) return;
    const dms = Math.round(((dx / pps) * 1000) / 100) * 100;
    if (held.kind === "slide") {
      // the video slides under the place where the clips go, as the music's song does: left, Motion transfer starts later
      // in it (where it stops stays)
      const from = Math.max(0, Math.min(held.to - 1000, held.from - dms));
      setHeld({ ...held, moved: true, fromMs: from });
      onPeek?.(from);
    } else {
      const to = Math.max(held.from + 1000, Math.min(length, held.to + dms));
      setHeld({ ...held, moved: true, toMs: to });
      onPeek?.(to);
    }
  };
  const up = () => {
    if (held?.moved && (held.fromMs !== source.fromMs || held.toMs !== source.toMs)) onStretch?.(held.fromMs, held.toMs);
    if (held?.moved) onPeek?.(null);
    else if (held && !held.moved) onSelect();
    setHeld(null);
  };
  // a drag the browser took back (a touch turned into a scroll, the window lost): nothing is saved, and the stage leaves
  // the moment it was showing for the drag, where it stayed
  const cancel = () => {
    if (held?.moved) onPeek?.(null);
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
          else if (e.key === "Delete" && onRemove) {
            e.preventDefault();
            e.stopPropagation();
            onRemove();
          }
        }}
        onPointerDown={editable ? down("slide") : undefined}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={cancel}
        onClick={() => !editable && onSelect()}
        onDragOver={onDragOver}
        onContextMenu={(e) => menu.open(e, true)}
        aria-label={`Source: ${video.name}`}
        aria-pressed={selected}
        data-hint={editable ? "click: the source in the stage · drag: where Motion transfer starts in it · its right end: where it stops · right-click: split" : "click: the source in the stage, its settings · right-click: its menu"}
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
        <span className="pointer-events-none absolute inset-y-0 left-0 bg-ground/75" style={{ width: Math.max(0, inLane(fromMs)) }} />
        <span className="pointer-events-none absolute inset-y-0 bg-ground/75" style={{ left: inLane(toMs), right: 0 }} />
        {/* the stretch made into clips, lit, where its clips are */}
        <span className={cx("pointer-events-none absolute inset-y-0 rounded border-2", selected ? "border-accent" : "border-ink-3")} style={{ left: Math.max(0, inLane(fromMs)), width: Math.max(4, inLane(toMs) - Math.max(0, inLane(fromMs))) }} />
        {bound.map((b) => (
          <span key={b.id} className="pointer-events-none absolute inset-y-1 rounded-sm border border-accent/70" style={{ left: inLane(b.from), width: Math.max(4, ((b.to - b.from) / 1000) * pps) }} />
        ))}
        <span className="pointer-events-none absolute top-0.5 rounded bg-ground/85 px-1 text-[10px] font-semibold whitespace-nowrap" style={{ left: Math.max(2, inLane(fromMs) + 3) }}>
          {held ? `${((held.kind === "slide" ? fromMs : toMs) / 1000).toFixed(1)} s${held.kind === "end" ? ": stops here" : ": starts here"}` : `${video.name} · from ${(fromMs / 1000).toFixed(1)} s`}
        </span>
        {/* its right end: where Motion transfer stops */}
        {editable && (
          <span
            role="separator"
            aria-label="Drag: where Motion transfer stops in the source"
            data-hint={`drag: where Motion transfer stops (${(toMs / 1000).toFixed(1)} s of the source)`}
            onPointerDown={down("end")}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={cancel}
            className="absolute inset-y-0 z-10 w-2 cursor-ew-resize rounded-r bg-accent"
            style={{ left: inLane(toMs) - 8 }}
          />
        )}
      </div>
      {menu.menu && (
        <ContextMenu
          at={menu.menu.at}
          label="The source"
          head={{ title: "Source", sub: video.name }}
          items={[
            { label: "Source settings", icon: <SlidersHorizontal size={14} />, note: "its form, Make N clips", run: onSelect },
            ...(onSplit !== undefined && !place.made ? [{ label: "Split at the playhead", key: "S", icon: <Split size={14} />, disabled: !onSplit, note: onSplit ? "the part before plays as it is; Motion transfer starts there" : "put the playhead inside the stretch", run: () => onSplit?.() }] : []),
            ...(onOpen ? [{ label: "Open its video", icon: <Eye size={14} />, note: "the viewer", run: () => onOpen(video) }] : []),
            "—" as const,
            ...(onRemove ? [{ label: "Remove the source", icon: <Trash2 size={14} />, key: "Del", note: "with the clips made from it (Undo brings them back)", run: onRemove }] : []),
          ]}
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
          className="pointer-events-none absolute flex flex-col justify-between overflow-hidden rounded-lg border-2 border-dashed border-accent/70 bg-accent-wash/40 px-1.5 py-1 text-[11px]"
          style={{ left: x(place.atMs + w.fromMs) + 1, width: Math.max(8, ((w.toMs - w.fromMs) / 1000) * pps - 2), top: ROW.top, height: ROW.height }}
        >
          <span className="truncate font-bold text-accent">{k + 1} · {label}</span>
          <span className="truncate text-ink-2">to make · {((w.toMs - w.fromMs) / 1000).toFixed(1)} s</span>
        </div>
      ))}
    </>
  );
}
