import { useMemo, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Link2, Minus, Music, Plus, Scissors, TriangleAlert, VolumeX, X } from "lucide-react";
import { STRIP_FRAMES, stripUrl, thumbUrl, type Clip, type ClipPatch, type RecipeInfo, type RunningJob, type Timeline } from "../api";
import { phaseLabel } from "../format";
import { DRAG_PICTURE, DRAG_SOUND, DRAG_TYPE, DRAG_VIDEO } from "../screens/Library";
import { Bar, cx } from "../ui";
import { DRAG_CLIP, layout, NEW_CLIP, otherShape, PAD, pinInputs, placeOf, playAt, stamp, titleOf, ZOOM, type Slot } from "./model";
import { LivePreview } from "../LivePreview";

/** Where the rows sit, top to bottom. */
const RULER = 20;
const ROW = { top: 24, height: 76 };
const SOUND = { top: 104, height: 18 };
const MUSIC = { top: 126, height: 22 };
const HEIGHT = 152;

/** What a drop would do, worked out while something is dragged over the track. */
type Over =
  | { kind: "insert"; index: number }
  | { kind: "pin"; clip: string; where: "start" | "end" | "mid"; atS?: number }
  | { kind: "sound"; clip: string }
  | { kind: "music" };

/** How far apart the ruler's labels are, in seconds: the first step that leaves them room. */
const stepFor = (pps: number) => [1, 2, 5, 10, 15, 30, 60, 120].find((s) => s * pps >= 58) ?? 300;

/**
 * The timeline itself: a ruler, the clips at their length with their own frames, each clip's sound,
 * and the music under all of it. Things are dragged onto it; a clip's edges shorten it.
 */
export function Track({ timeline, recipes, pps, onZoom, selected, musicSelected, time, cursorMs, running, busy, onStop, onSelect, onSelectMusic, onSeek, onMove, onInsert, onPin, onClipSound, onMusic, onTrim, onNewClip }: {
  timeline: Timeline;
  recipes: RecipeInfo[];
  /** Pixels per second. */
  pps: number;
  onZoom(pps: number): void;
  selected: string | null;
  musicSelected: boolean;
  /** The moment of what plays. */
  time: number;
  /** Where the playhead was put by hand, in the track's own time: it can stand on a clip that is not rendered yet. null = it follows what plays. */
  cursorMs: number | null;
  running: RunningJob | null;
  busy: boolean;
  /** Stop a clip's render, or take it out of the queue. */
  onStop(job: string): void;
  onSelect(clip: string): void;
  onSelectMusic(): void;
  /** The playhead was moved: the moment of what plays, and where it stands on the track. */
  onSeek(playMs: number, trackMs?: number): void;
  onMove(clip: string, after: string | null): void;
  /** A picture or a video of the library, put between clips. */
  onInsert(asset: string, after: string | null): void;
  /** A picture pinned to a clip: it opens on it, ends on it, or passes through it at `atS` seconds. */
  onPin(clip: Clip, where: "start" | "end" | "mid", asset: string, atS?: number): void;
  onClipSound(clip: string, asset: string): void;
  onMusic(asset: string): void;
  onTrim(clip: Clip, patch: ClipPatch): void;
  onNewClip(after: string | undefined): void;
}) {
  const clips = timeline.clips;
  const scroller = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState<Over | null>(null);
  const [dragging, setDragging] = useState<"clip" | "picture" | "video" | "sound" | null>(null);
  /** An edge being dragged: the clip, which edge, and the length it has for now. */
  const [stretch, setStretch] = useState<{ clip: string; side: "start" | "end"; lengthMs: number } | null>(null);
  const pull = useRef<{ x: number; base: number; least: number; most: number } | null>(null);

  const slots = useMemo(() => layout(clips, pps, recipes, stretch ?? undefined), [clips, pps, recipes, stretch]);
  const end = slots.length ? slots.at(-1)!.left + slots.at(-1)!.width : PAD;
  const totalMs = slots.length ? slots.at(-1)!.startMs + slots.at(-1)!.lengthMs : 0;
  const width = end + NEW_CLIP + PAD * 2 + 40;
  const playing = placeOf(slots, time);
  const head = cursorMs !== null ? { x: PAD + (Math.min(cursorMs, totalMs) / 1000) * pps } : playing;
  const recipeOf = (c: Clip) => recipes.find((r) => r.id === c.recipe);
  const xOf = (clientX: number) => clientX - (inner.current?.getBoundingClientRect().left ?? 0);

  // ---- what is being dragged, and what dropping it here would do
  const draggedOf = (e: DragEvent) => {
    const t = e.dataTransfer.types;
    return t.includes(DRAG_CLIP) ? "clip" : t.includes(DRAG_PICTURE) ? "picture" : t.includes(DRAG_SOUND) ? "sound" : t.includes(DRAG_VIDEO) || t.includes(DRAG_TYPE) ? "video" : null;
  };
  const hover = (e: DragEvent, what: Over | null) => {
    const d = draggedOf(e);
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    if (d !== dragging) setDragging(d);
    setOver((o) => (JSON.stringify(o) === JSON.stringify(what) ? o : what));
  };
  const overClip = (e: DragEvent, s: Slot) => {
    const d = draggedOf(e);
    if (!d) return;
    if (d === "sound") return hover(e, s.planned && s.clip.kind !== "still" ? null : { kind: "sound", clip: s.clip.id });
    const r = e.currentTarget.getBoundingClientRect();
    const fx = (e.clientX - r.left) / Math.max(1, r.width);
    const half: Over = { kind: "insert", index: fx < 0.5 ? s.index : s.index + 1 };
    if (d !== "picture" || s.clip.kind === "still") return hover(e, half);
    const pins = pinInputs(recipeOf(s.clip));
    const carries = s.index > 0 && s.clip.joined === "continue";
    const edge = Math.min(0.2, 18 / Math.max(1, r.width));
    if (fx < edge || fx > 1 - edge) return hover(e, half);
    // the middle third, for a model that can pass through a picture: pinned at that moment, to the half second
    if (pins.mid && fx > 0.3 && fx < 0.7) {
      const seconds = Math.max(1, s.lengthMs / 1000);
      return hover(e, { kind: "pin", clip: s.clip.id, where: "mid", atS: Math.max(0.5, Math.round(fx * seconds * 2) / 2) });
    }
    if (fx < 0.5) return hover(e, pins.start && !carries ? { kind: "pin", clip: s.clip.id, where: "start" } : half);
    return hover(e, pins.end ? { kind: "pin", clip: s.clip.id, where: "end" } : half);
  };
  const drop = (e: DragEvent) => {
    const d = draggedOf(e);
    if (!d) return;
    e.preventDefault();
    const target = over;
    setOver(null);
    setDragging(null);
    if (!target) return;
    const moved = e.dataTransfer.getData(DRAG_CLIP);
    const asset = e.dataTransfer.getData(DRAG_TYPE);
    if (target.kind === "insert") {
      const afterId = target.index === 0 ? null : clips[target.index - 1]!.id;
      if (moved) {
        if (afterId !== moved && clips[target.index]?.id !== moved) onMove(moved, afterId);
      } else if (asset) onInsert(asset, afterId);
    } else if (target.kind === "pin" && asset) onPin(clips.find((c) => c.id === target.clip)!, target.where, asset, target.atS);
    else if (target.kind === "sound" && asset) onClipSound(target.clip, asset);
    else if (target.kind === "music" && asset) onMusic(asset);
  };
  const n = (id: string) => clips.findIndex((c) => c.id === id) + 1;
  const hint = !dragging
    ? clips.length
      ? "Drag pictures, videos and sounds here from the left. Click a clip to change it; drag its edges to shorten it."
      : "Your clips will line up here, left to right, in the order they play."
    : !over
      ? dragging === "sound" ? "Drop it on a clip to replace its sound, or on the music row." : "Drop it on the timeline."
      : over.kind === "insert"
        ? `Drop to ${dragging === "clip" ? "move it" : dragging === "picture" ? "hold this picture on screen" : "put it"} ${over.index === 0 ? "at the start" : over.index >= clips.length ? "at the end" : `between clip ${over.index} and clip ${over.index + 1}`}.`
        : over.kind === "pin"
          ? over.where === "mid" ? `Drop to make clip ${n(over.clip)} pass through this picture at ${over.atS} s.` : `Drop to make clip ${n(over.clip)} ${over.where === "start" ? "open" : "end"} on this picture.`
          : over.kind === "sound"
            ? `Drop to replace the sound of clip ${n(over.clip)}.`
            : "Drop to play it under the whole video.";
  const lineAt = over?.kind === "insert" ? (over.index < slots.length ? slots[over.index]!.left : end) : null;

  // ---- the playhead: click or drag on the ruler
  const scrub = (e: ReactPointerEvent) => {
    const x = xOf(e.clientX);
    onSeek(playAt(slots, x), Math.max(0, Math.min(totalMs, ((x - PAD) / pps) * 1000)));
  };

  // ---- a clip's edges: drag to shorten it (or to give back what was cut)
  const startPull = (e: ReactPointerEvent, s: Slot, side: "start" | "end") => {
    e.stopPropagation();
    e.preventDefault();
    const c = s.clip;
    const most = c.kind === "still" ? 60_000 : c.lengthMs + (side === "start" ? c.take!.trimStartMs : c.take!.trimEndMs);
    pull.current = { x: e.clientX, base: c.lengthMs, least: Math.min(c.lengthMs, 400), most };
    e.currentTarget.setPointerCapture(e.pointerId);
    setStretch({ clip: c.id, side, lengthMs: c.lengthMs });
  };
  const movePull = (e: ReactPointerEvent) => {
    const p = pull.current;
    if (!p || !stretch) return;
    const moved = ((e.clientX - p.x) / pps) * 1000;
    const length = Math.round(Math.max(p.least, Math.min(p.most, p.base + (stretch.side === "end" ? moved : -moved))) / 100) * 100;
    if (length !== stretch.lengthMs) setStretch({ ...stretch, lengthMs: Math.max(p.least, Math.min(p.most, length)) });
  };
  const endPull = () => {
    const p = pull.current;
    pull.current = null;
    if (!p || !stretch) return setStretch(null);
    const c = clips.find((x) => x.id === stretch.clip);
    const cut = p.base - stretch.lengthMs;
    if (c && cut !== 0) {
      if (c.kind === "still") onTrim(c, { stillMs: stretch.lengthMs });
      else if (stretch.side === "start") onTrim(c, { trimStartMs: Math.max(0, c.take!.trimStartMs + cut) });
      else onTrim(c, { trimEndMs: Math.max(0, c.take!.trimEndMs + cut) });
    }
    setStretch(null);
  };

  const fitAll = () => {
    const room = (scroller.current?.clientWidth ?? 800) - NEW_CLIP - PAD * 3 - 40;
    if (totalMs > 0) onZoom(Math.max(ZOOM.least, Math.min(ZOOM.most, room / (totalMs / 1000))));
  };

  // ---- the ruler's marks
  const step = stepFor(pps);
  const marks = [];
  for (let s = 0; s * 1000 <= totalMs + step * 1000; s += step) marks.push(s);

  return (
    <div className="flex shrink-0 flex-col border-t border-line bg-panel select-none">
      <div className="flex">
        <div className="relative w-[64px] shrink-0 border-r border-line text-[11px] font-semibold text-ink-2" style={{ height: HEIGHT }}>
          <span className="absolute left-3" style={{ top: ROW.top + ROW.height / 2 - 8 }}>Picture</span>
          <span className="absolute left-3" style={{ top: SOUND.top + 1 }}>Sound</span>
          <span className="absolute left-3" style={{ top: MUSIC.top + 3 }}>Music</span>
        </div>
        <div
          ref={scroller}
          className="relative min-w-0 grow overflow-x-auto overflow-y-hidden"
          onDragOver={(e) => hover(e, draggedOf(e) === "sound" ? null : { kind: "insert", index: clips.length })}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
              setOver(null);
              setDragging(null);
            }
          }}
          onDrop={drop}
        >
          <div ref={inner} className="relative" style={{ width, height: HEIGHT }}>
            {/* the ruler: a click or a drag moves the playhead */}
            <div
              role="slider"
              aria-label="Move the playhead"
              aria-valuemin={0}
              aria-valuemax={Math.round(timeline.durationMs / 1000)}
              aria-valuenow={Math.round(time / 1000)}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft") onSeek(Math.max(0, time - 200));
                if (e.key === "ArrowRight") onSeek(Math.min(timeline.durationMs, time + 200));
              }}
              onPointerDown={(e) => {
                // the browser must not take this for the start of a text selection or of a drag
                e.preventDefault();
                e.currentTarget.setPointerCapture(e.pointerId);
                scrub(e);
              }}
              onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && scrub(e)}
              onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
              onDragStart={(e) => e.preventDefault()}
              className="absolute inset-x-0 top-0 cursor-ew-resize touch-none border-b border-line"
              style={{ height: RULER }}
            >
              {marks.map((s) => (
                <span key={s} className="pointer-events-none absolute top-0 h-full border-l border-line-strong pl-1 font-mono text-[10px] leading-[18px] text-ink-3" style={{ left: PAD + s * pps }}>
                  {stamp(s * 1000).slice(0, -2)}
                </span>
              ))}
            </div>

            {slots.map((s) => {
              const c = s.clip;
              const on = c.id === selected;
              const live = running?.clipId === c.id ? running : null;
              const recipe = recipeOf(c);
              const pins = pinInputs(recipe);
              const carries = s.index > 0 && c.joined === "continue";
              const opens = !carries && pins.start && typeof c.inputs[pins.start] === "string" ? (c.inputs[pins.start] as string) : null;
              const ends = pins.end && typeof c.inputs[pins.end] === "string" ? (c.inputs[pins.end] as string) : null;
              // the frames along the clip: as many as fit, each from the moment it stands at
              const video = c.take?.asset;
              const cells: number[] = [];
              if (video?.durationMs && video.width && video.height) {
                const count = Math.max(1, Math.round(s.width / Math.max(24, ROW.height * (video.width / video.height))));
                const from = stretch?.clip === c.id && stretch.side === "start" ? c.take!.endMs - s.lengthMs : c.take!.startMs;
                for (let k = 0; k < count; k++) cells.push(Math.min(STRIP_FRAMES - 1, Math.max(0, Math.floor(((from + ((k + 0.5) / count) * s.lengthMs) / video.durationMs) * STRIP_FRAMES))));
              }
              const pinned = over?.kind === "pin" && over.clip === c.id ? over.where : null;
              const through = pins.mid && pins.midAt && typeof c.inputs[pins.mid] === "string" ? { asset: c.inputs[pins.mid] as string, part: Math.max(0.15, Math.min(0.85, (Number(c.inputs[pins.midAt] ?? 2.5) * 1000) / Math.max(1, s.lengthMs))) } : null;
              const heard = c.kind === "still" || s.planned ? (c.sound === "file" ? c.soundAsset?.name || "A sound file" : "") : c.sound === "file" ? c.soundAsset?.name || "A sound file" : c.sound === "muted" ? "Muted" : video?.hasSound ? "Its own sound" : "Silent";
              return (
                <div key={c.id}>
                  <button
                    type="button"
                    draggable={!stretch}
                    onDragStart={(e) => {
                      e.dataTransfer.setData(DRAG_CLIP, c.id);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onDragOver={(e) => overClip(e, s)}
                    onClick={(e) => {
                      onSelect(c.id);
                      const x = xOf(e.clientX);
                      onSeek(playAt(slots, x), Math.max(0, Math.min(totalMs, ((x - PAD) / pps) * 1000)));
                    }}
                    aria-pressed={on}
                    aria-label={`Clip ${s.index + 1}, ${titleOf(c, recipe)}${s.planned ? ", not rendered yet" : `, ${(c.lengthMs / 1000).toFixed(1)} seconds`}`}
                    style={{ left: s.left + 1, width: Math.max(8, s.width - 2), top: ROW.top, height: ROW.height }}
                    className={cx(
                      "absolute overflow-hidden rounded-lg border-2 text-left",
                      on ? "border-accent" : s.planned ? "border-dashed border-line-strong" : "border-line-strong",
                      s.planned && "bg-raised",
                    )}
                  >
                    {cells.length > 0 && (
                      <span className="absolute inset-0 flex">
                        {cells.map((frame, k) => (
                          <span key={k} className="h-full grow bg-raised" style={{ backgroundImage: `url(${stripUrl(video!.id)})`, backgroundSize: `${STRIP_FRAMES * 100}% 100%`, backgroundPosition: `${(frame / (STRIP_FRAMES - 1)) * 100}% 0` }} />
                        ))}
                      </span>
                    )}
                    {c.kind === "still" && c.still && <img src={thumbUrl(c.still.id)} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover" />}
                    {live && <LivePreview job={live} className="pointer-events-none absolute inset-0 h-full w-full object-cover" />}
                    <span className="absolute inset-x-0 top-0 flex items-center gap-1 bg-gradient-to-b from-ground/85 to-transparent px-1.5 pt-1 pb-3">
                      <span className="shrink-0 rounded bg-ground/85 px-1.5 py-px text-[11px] font-bold">{s.index + 1}</span>
                      {s.width > 86 && <span className="min-w-0 truncate text-[11px] font-semibold">{titleOf(c, recipe)}</span>}
                    </span>
                    <span className="absolute inset-x-1.5 bottom-1 flex items-end justify-between gap-1">
                      {c.job ? (
                        <span className="flex min-w-0 grow flex-col gap-1 rounded bg-ground/85 px-1.5 py-1 text-[11px]">
                          <span className="flex items-center gap-1">
                            <span className="min-w-0 grow truncate font-semibold">{live ? phaseLabel(live.phase) : "Waiting"}</span>
                            <button
                              type="button"
                              aria-label={live ? `Stop the render of clip ${s.index + 1}` : `Take clip ${s.index + 1} out of the queue`}
                              title={live ? "Stop this render" : "Take it out of the queue"}
                              onPointerDown={(e) => e.stopPropagation()}
                              onClick={(e) => {
                                e.stopPropagation();
                                onStop(c.job!.id);
                              }}
                              className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-ink-2 hover:bg-hover hover:text-ink"
                            >
                              <X size={10} />
                            </button>
                          </span>
                          <Bar value={(live?.progress ?? 0) * 100} />
                        </span>
                      ) : (
                        <>
                          <span className={cx("truncate rounded bg-ground/85 px-1.5 py-px text-[11px]", c.failed && s.planned ? "text-warn-ink" : s.planned ? "text-ink-2" : "font-semibold")}>
                            {s.planned ? (c.failed ? "The render failed" : s.width > 100 ? "Not rendered yet" : "…") : `${(s.lengthMs / 1000).toFixed(1)} s`}
                          </span>
                          <span className="flex shrink-0 items-center gap-1">
                            {c.kind === "still" && s.width > 70 && <span className="rounded bg-ground/85 px-1.5 py-px text-[10px] text-ink-2">Picture</span>}
                            {c.kind === "video" && !recipe && c.take && s.width > 96 && <span className="rounded bg-ground/85 px-1.5 py-px text-[10px] text-ink-2">Your file</span>}
                            {otherShape(c, timeline) && s.width > 120 && <span className="rounded bg-ground/85 px-1.5 py-px text-[10px] text-warn-ink">other shape</span>}
                            {c.takes.length > 1 && s.width > 110 && <span className="rounded bg-ground/85 px-1.5 py-px text-[10px] text-ink-2">take {c.takes.findIndex((x) => x.id === c.take?.id) + 1} of {c.takes.length}</span>}
                          </span>
                        </>
                      )}
                    </span>
                    {/* pictures pinned to its start and its end */}
                    {opens && <img src={thumbUrl(opens)} alt="" title="Opens on this picture" draggable={false} className="absolute top-6 left-3.5 h-7 w-7 rounded border-2 border-picture object-cover" />}
                    {ends && <img src={thumbUrl(ends)} alt="" title="Ends on this picture" draggable={false} className="absolute top-6 right-3.5 h-7 w-7 rounded border-2 border-picture object-cover" />}
                    {through && <img src={thumbUrl(through.asset)} alt="" title="Passes through this picture" draggable={false} className="absolute top-6 h-7 w-7 -translate-x-1/2 rounded border-2 border-picture object-cover" style={{ left: `${through.part * 100}%` }} />}
                    {pinned && <span aria-hidden className={cx("absolute inset-y-0 w-2 bg-accent", pinned === "start" ? "left-0" : pinned === "end" ? "right-0" : "left-1/2 -translate-x-1/2")} />}
                  </button>

                  {/* its edges: drag to shorten */}
                  {on && !s.planned && !c.job && (
                    <>
                      {c.kind === "video" && (
                        <span role="separator" aria-label="Drag to cut from the start of the clip" title="Drag to cut from the start" onPointerDown={(e) => startPull(e, s, "start")} onPointerMove={movePull} onPointerUp={endPull} onPointerCancel={endPull} className="absolute z-10 w-2.5 cursor-ew-resize rounded-l-lg bg-accent" style={{ left: s.left + 1, top: ROW.top, height: ROW.height }} />
                      )}
                      <span role="separator" aria-label="Drag to change where the clip ends" title={c.kind === "still" ? "Drag to hold the picture for a shorter or a longer time" : "Drag to cut from the end"} onPointerDown={(e) => startPull(e, s, "end")} onPointerMove={movePull} onPointerUp={endPull} onPointerCancel={endPull} className="absolute z-10 w-2.5 cursor-ew-resize rounded-r-lg bg-accent" style={{ left: s.left + s.width - 11.5, top: ROW.top, height: ROW.height }} />
                    </>
                  )}

                  {/* how it starts: flowing on from the clip before, or a cut */}
                  {s.index > 0 && c.kind === "video" && (
                    <button
                      type="button"
                      onClick={() => onSelect(c.id)}
                      title={c.join === "stale" ? `Clip ${s.index + 1} no longer follows clip ${s.index}` : c.joined === "continue" ? (c.join === "fresh" ? `Flows on from clip ${s.index}` : `Will flow on from clip ${s.index}`) : "A cut"}
                      aria-label={c.join === "stale" ? `The join before clip ${s.index + 1} no longer holds` : c.joined === "continue" ? `The join before clip ${s.index + 1}: it flows on from clip ${s.index}` : `The join before clip ${s.index + 1}: a cut`}
                      style={{ left: s.left - 11, top: ROW.top + ROW.height / 2 - 11 }}
                      className={cx(
                        "absolute z-10 flex h-[22px] w-[22px] items-center justify-center rounded-full border",
                        c.join === "stale" ? "border-warn bg-warn text-[#2a0e00]" : c.joined === "continue" ? (c.join === "fresh" ? "border-accent bg-accent-wash text-accent" : "border-dashed border-accent bg-panel text-accent") : "border-line-strong bg-raised text-ink-3",
                      )}
                    >
                      {c.join === "stale" ? <TriangleAlert size={11} /> : c.joined === "continue" ? <Link2 size={11} /> : <Scissors size={10} />}
                    </button>
                  )}

                  {/* its sound */}
                  <button
                    type="button"
                    onClick={() => onSelect(c.id)}
                    onDragOver={(e) => overClip(e, s)}
                    aria-label={`Sound of clip ${s.index + 1}: ${heard || "none yet"}`}
                    style={{ left: s.left + 1, width: Math.max(8, s.width - 2), top: SOUND.top, height: SOUND.height }}
                    className={cx(
                      "absolute flex items-center gap-1 overflow-hidden rounded px-1.5 text-[10px]",
                      c.sound === "file" ? "bg-picture/20 text-picture" : c.sound === "muted" || heard === "Silent" || !heard ? "bg-raised text-ink-3" : "bg-good/15 text-good",
                      over?.kind === "sound" && over.clip === c.id && "outline outline-2 outline-accent",
                    )}
                  >
                    {(c.sound === "muted" || heard === "Silent") && <VolumeX size={10} className="shrink-0" />}
                    {s.width > 64 && <span className="truncate">{heard}</span>}
                  </button>
                </div>
              );
            })}

            <button
              type="button"
              onClick={() => onNewClip(clips.at(-1)?.id)}
              disabled={busy}
              style={{ left: end + PAD, width: NEW_CLIP, top: ROW.top, height: ROW.height }}
              className="absolute flex flex-col items-center justify-center gap-1 rounded-lg border-[1.5px] border-dashed border-line-strong text-ink-2 hover:text-ink"
            >
              <Plus size={15} />
              <span className="text-xs font-semibold">New clip</span>
            </button>

            {/* the music: one sound under the whole video */}
            <button
              type="button"
              onClick={() => timeline.music && onSelectMusic()}
              onDragOver={(e) => hover(e, draggedOf(e) === "sound" ? { kind: "music" } : null)}
              aria-label={timeline.music ? `Music: ${timeline.music.asset.name || "a sound"}` : "Music: none. Drop a sound here."}
              aria-pressed={musicSelected}
              style={{
                left: PAD + 1, top: MUSIC.top, height: MUSIC.height,
                width: Math.max(140, (timeline.music ? Math.min(totalMs, timeline.music.asset.durationMs || totalMs) / 1000 : totalMs / 1000) * pps - 2),
              }}
              className={cx(
                "absolute flex items-center gap-1.5 overflow-hidden rounded px-2 text-left text-[11px]",
                timeline.music ? "bg-accent-wash text-accent" : "border border-dashed border-line-strong text-ink-3",
                (musicSelected || over?.kind === "music") && "outline outline-2 outline-accent",
              )}
            >
              <Music size={11} className="shrink-0" />
              <span className="truncate">{timeline.music ? timeline.music.asset.name || "Music" : "Drop a sound here to play it under the whole video"}</span>
            </button>

            {lineAt !== null && <div aria-hidden className="pointer-events-none absolute z-20 w-[3px] rounded bg-accent" style={{ left: lineAt - 1.5, top: ROW.top - 2, height: ROW.height + 4 }} />}
            {head && (
              <div aria-hidden className="pointer-events-none absolute top-0 z-20" style={{ left: head.x - 1, height: HEIGHT - 4 }}>
                <div className="h-full w-0.5 bg-white" />
                <div className="absolute -top-px -left-[5px] h-2.5 w-3 rounded-b bg-white" />
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="flex h-8 items-center gap-2 border-t border-line pr-2 pl-3 text-xs">
        <span className={cx("min-w-0 grow truncate", dragging ? "font-semibold text-accent" : "text-ink-3")}>{hint}</span>
        <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => onZoom(Math.max(ZOOM.least, pps / 1.3))} className="flex h-6 w-6 items-center justify-center rounded-md text-ink-2 hover:bg-hover hover:text-ink"><Minus size={13} /></button>
        <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => onZoom(Math.min(ZOOM.most, pps * 1.3))} className="flex h-6 w-6 items-center justify-center rounded-md text-ink-2 hover:bg-hover hover:text-ink"><Plus size={13} /></button>
        <button type="button" onClick={fitAll} className="h-6 rounded-md border border-line-strong px-2 font-semibold text-ink-2 hover:bg-hover hover:text-ink">Fit all</button>
      </div>
    </div>
  );
}
