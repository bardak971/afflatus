import type { DragEvent, PointerEvent as ReactPointerEvent } from "react";
import { Link2, Scissors, TriangleAlert, VolumeX, X } from "lucide-react";
import { STRIP_FRAMES, stripUrl, thumbUrl, type Clip, type RecipeInfo, type RunningJob, type Timeline } from "../../api";
import { phaseLabel } from "../../format";
import { LivePreview } from "../../LivePreview";
import { Bar, cx } from "../../ui";
import { DRAG_CLIP, fileVersion, otherShape, PAD, pinInputs, playAt, titleOf, type Slot } from "../model";
import type { TimeRange } from "../Track";
import { HINTS, type PinPlace } from "./peek";
import { ROW, SOUND } from "./rows";
import type { Motion } from "./useMotionMarks";
import type { Over } from "./useTrackDrop";
import { Wave } from "./Wave";

/** An edge being dragged: the clip, which edge, and the length it has for now. */
export type Stretch = { clip: string; side: "start" | "end"; lengthMs: number };

/**
 * One clip on the track: its frames at their length, its number and title, what is pinned to it, its render
 * or its state, its edges to trim it by, the join before it, and its sound under it.
 */
export function TrackClip({ s, clips, timeline, recipes, selected, picked, running, stretch, over, range, slots, totalMs, pps, xOf, measureOf, restOn, leaveTip, pinOn, restPin, overClip, startPull, movePull, endPull, onSelect, onPick, onRange, onSeek, onMenu, onSoundMenu, onStop, onJoin }: {
  s: Slot;
  clips: Clip[];
  timeline: Timeline;
  recipes: RecipeInfo[];
  selected: string | null;
  picked?: Set<string>;
  running: RunningJob | null;
  stretch: Stretch | null;
  /** What a drop would do, while something is dragged over the track. */
  over: Over | null;
  range: TimeRange | null;
  slots: Slot[];
  totalMs: number;
  pps: number;
  /** A pointer's x, in the track's own pixels. */
  xOf(clientX: number): number;
  /** How a video or a sound file moves and sounds, once measured. */
  measureOf(id: string | undefined): Motion | undefined;
  /** The tooltip: the pointer rests on the clip, or leaves it. */
  restOn(id: string, el: HTMLElement): void;
  leaveTip(): void;
  /** Its pinned picture whose card shows, if any; and the pointer resting on one of its pinned pictures (null: leaving it). */
  pinOn?: PinPlace | null;
  restPin(clip: string, where: PinPlace | null, el?: HTMLImageElement): void;
  /** Something is dragged over the clip. */
  overClip(e: DragEvent, s: Slot): void;
  /** Its edges: drag to shorten it (or to give back what was cut). */
  startPull(e: ReactPointerEvent, s: Slot, side: "start" | "end"): void;
  movePull(e: ReactPointerEvent): void;
  endPull(): void;
  onSelect(clip: string): void;
  onPick?(clip: string): void;
  onRange(range: TimeRange | null): void;
  onSeek(playMs: number, trackMs?: number): void;
  onMenu?(clip: Clip, e: React.MouseEvent): void;
  onSoundMenu?(clip: Clip, e: React.MouseEvent): void;
  onStop(job: string): void;
  onJoin?(clip: Clip, joined: "continue" | "cut"): void;
}) {
  const recipeOf = (c: Clip) => recipes.find((r) => r.id === c.recipe);

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
  const heard = c.kind === "still" || s.planned ? (c.sound === "file" ? c.soundAsset?.name || "Audio file" : "") : c.sound === "file" ? c.soundAsset?.name || "Audio file" : c.sound === "muted" ? "Muted" : video?.hasSound ? "Own audio" : "Silent";
  return (
    <div key={c.id}>
      {/* a div that acts as a button, not a button: the stop button of a render sits inside it, and a button holds no button */}
      <div
        role="button"
        tabIndex={0}
        draggable={!stretch}
        onDragStart={(e) => {
          leaveTip();
          e.dataTransfer.setData(DRAG_CLIP, c.id);
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragOver={(e) => overClip(e, s)}
        onPointerEnter={(e) => restOn(c.id, e.currentTarget)}
        onPointerLeave={leaveTip}
        onPointerDown={leaveTip}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
          e.preventDefault();
          onSelect(c.id);
        }}
        onClick={(e) => {
          // Ctrl: the clip is picked (or dropped) for a render of several together
          if ((e.ctrlKey || e.metaKey) && onPick) {
            onPick(c.id);
            return;
          }
          // Shift: the range reaches to cover this clip too (or starts as this clip)
          if (e.shiftKey && c.lengthMs > 0) {
            onRange(range ? { inMs: Math.min(range.inMs, c.atMs), outMs: Math.max(range.outMs, c.atMs + c.lengthMs) } : { inMs: c.atMs, outMs: c.atMs + c.lengthMs });
            return;
          }
          onSelect(c.id);
          const x = xOf(e.clientX);
          onSeek(playAt(slots, x), Math.max(0, Math.min(totalMs, ((x - PAD) / pps) * 1000)));
        }}
        onContextMenu={(e) => {
          if (!onMenu) return;
          onSelect(c.id);
          onMenu(c, e);
        }}
        aria-pressed={on}
        data-hint={HINTS.clip}
        // a clip that has its picture is read over it: the colours of the dark stage
        data-stage={s.planned ? undefined : ""}
        aria-label={`Clip ${s.index + 1}, ${titleOf(c, recipe)}${s.planned ? ", not rendered yet" : `, ${(c.lengthMs / 1000).toFixed(1)} seconds`}`}
        style={{ left: s.left + 1, width: Math.max(8, s.width - 2), top: ROW.top, height: ROW.height }}
        className={cx(
          "absolute overflow-hidden rounded-lg border-2 text-left",
          on ? "border-accent" : picked?.has(c.id) ? "border-accent/60" : s.planned ? "border-dashed border-line-strong" : "border-line-strong",
          picked?.has(c.id) && "ring-2 ring-accent/40",
          s.planned && "bg-raised",
        )}
      >
        {cells.length > 0 && (
          <span className="absolute inset-0 flex">
            {cells.map((frame, k) => (
              <span key={k} className="h-full grow bg-raised" style={{ backgroundImage: `url(${stripUrl(video!.id)}?v=${fileVersion(video!)})`, backgroundSize: `${STRIP_FRAMES * 100}% 100%`, backgroundPosition: `${(frame / (STRIP_FRAMES - 1)) * 100}% 0` }} />
            ))}
          </span>
        )}
        {c.kind === "still" && c.still && <img src={thumbUrl(c.still.id)} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover" />}
        {live && <LivePreview job={live} className="pointer-events-none absolute inset-0 h-full w-full object-cover" />}
        {/* its number only: the frames stay clean (the prompt is in its hover card and its panel) */}
        <span className="absolute top-1 left-1.5 rounded bg-ground/85 px-1.5 py-px text-[11px] font-bold">{s.index + 1}</span>
        <span className="absolute inset-x-1.5 bottom-1 flex items-end justify-between gap-1">
          {c.job ? (
            <span className="flex min-w-0 grow flex-col gap-1 rounded bg-ground/85 px-1.5 py-1 text-[11px]">
              <span className="flex items-center gap-1">
                <span className="min-w-0 grow truncate font-semibold">{live ? phaseLabel(live.phase) : "Queued"}</span>
                <button
                  type="button"
                  aria-label={live ? `Stop the render of clip ${s.index + 1}` : `Remove clip ${s.index + 1} from the queue`}
                  data-hint={live ? "click: stop the render" : "click: remove it from the queue"}
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
                {c.kind === "still" && s.width > 70 && <span className="rounded bg-ground/85 px-1.5 py-px text-[10px] text-ink-2">Still</span>}
                {c.kind === "video" && !recipe && c.take && s.width > 96 && <span className="rounded bg-ground/85 px-1.5 py-px text-[10px] text-ink-2">Imported</span>}
                {otherShape(c, timeline) && s.width > 120 && <span className="rounded bg-ground/85 px-1.5 py-px text-[10px] text-warn-ink">other aspect ratio</span>}
                {c.takes.length > 1 && s.width > 110 && <span className="rounded bg-ground/85 px-1.5 py-px text-[10px] text-ink-2">take {c.takes.findIndex((x) => x.id === c.take?.id) + 1} of {c.takes.length}</span>}
              </span>
            </>
          )}
        </span>
        {/* pictures pinned to its start, its end and its middle: resting on one shows it large (PinPeek) */}
        {opens && <img src={thumbUrl(opens)} alt="" data-pin draggable={false} onPointerEnter={(e) => restPin(c.id, "start", e.currentTarget)} onPointerLeave={() => restPin(c.id, null)} className={pinLook(pinOn === "start", "left-3.5")} />}
        {ends && <img src={thumbUrl(ends)} alt="" data-pin draggable={false} onPointerEnter={(e) => restPin(c.id, "end", e.currentTarget)} onPointerLeave={() => restPin(c.id, null)} className={pinLook(pinOn === "end", "right-3.5")} />}
        {through && <img src={thumbUrl(through.asset)} alt="" data-pin draggable={false} onPointerEnter={(e) => restPin(c.id, "mid", e.currentTarget)} onPointerLeave={() => restPin(c.id, null)} className={pinLook(pinOn === "mid", "-translate-x-1/2")} style={{ left: `${through.part * 100}%` }} />}
        {pinned && <span aria-hidden className={cx("absolute inset-y-0 w-2 bg-accent", pinned === "start" ? "left-0" : pinned === "end" ? "right-0" : "left-1/2 -translate-x-1/2")} />}
      </div>

      {/* its edges: drag to shorten */}
      {on && !s.planned && !c.job && (
        <>
          {c.kind === "video" && (
            <span role="separator" aria-label="Drag to trim the start of the clip" data-hint="drag: trim the start" onPointerDown={(e) => startPull(e, s, "start")} onPointerMove={movePull} onPointerUp={endPull} onPointerCancel={endPull} className="absolute z-10 w-2.5 cursor-ew-resize rounded-l-lg bg-accent" style={{ left: s.left + 1, top: ROW.top, height: ROW.height }} />
          )}
          <span role="separator" aria-label="Drag to trim the end of the clip" data-hint={c.kind === "still" ? "drag: change the still's duration" : "drag: trim the end"} onPointerDown={(e) => startPull(e, s, "end")} onPointerMove={movePull} onPointerUp={endPull} onPointerCancel={endPull} className="absolute z-10 w-2.5 cursor-ew-resize rounded-r-lg bg-accent" style={{ left: s.left + s.width - 11.5, top: ROW.top, height: ROW.height }} />
        </>
      )}

      {/* how it starts: flowing on from the clip before, or a cut; a click switches, when the model can extend */}
      {s.index > 0 && c.kind === "video" && (() => {
        const r = recipeOf(c);
        const prev = clips[s.index - 1];
        const canCarry = Boolean(r?.traits?.continues) || (prev?.kind === "still" && Boolean(pinInputs(r).start));
        const toggles = c.join !== "stale" && canCarry && Boolean(onJoin);
        return (
        <button
          type="button"
          onClick={() => (toggles ? onJoin!(c, c.joined === "continue" ? "cut" : "continue") : onSelect(c.id))}
          data-hint={c.join === "stale" ? `Clip ${s.index + 1} no longer follows clip ${s.index}` : c.joined === "continue" ? `${c.join === "fresh" ? "Extends" : "Will extend"} clip ${s.index}${toggles ? ". Click: make it a cut" : ""}` : `A cut${toggles ? `. Click: extend clip ${s.index}` : r && c.kind === "video" ? ": this model cannot extend a clip" : ""}`}
          aria-label={c.join === "stale" ? `The join before clip ${s.index + 1} no longer holds` : c.joined === "continue" ? `The join before clip ${s.index + 1}: it extends clip ${s.index}` : `The join before clip ${s.index + 1}: a cut`}
          style={{ left: s.left - 11, top: ROW.top + ROW.height / 2 - 11 }}
          className={cx(
            "absolute z-10 flex h-[22px] w-[22px] items-center justify-center rounded-full border",
            toggles && "hover:scale-110 hover:border-accent",
            c.join === "stale" ? "border-warn bg-warn text-warn-on" : c.joined === "continue" ? (c.join === "fresh" ? "border-accent bg-accent-wash text-accent" : "border-dashed border-accent bg-panel text-accent") : "border-line-strong bg-raised text-ink-3",
          )}
        >
          {c.join === "stale" ? <TriangleAlert size={11} /> : c.joined === "continue" ? <Link2 size={11} /> : <Scissors size={10} />}
        </button>
        );
      })()}

      {/* its sound */}
      <button
        type="button"
        onClick={() => onSelect(c.id)}
        onDragOver={(e) => overClip(e, s)}
        onContextMenu={(e) => {
          if (!onSoundMenu) return;
          onSelect(c.id);
          onSoundMenu(c, e);
        }}
        aria-label={`Audio of clip ${s.index + 1}: ${heard || "none yet"}`}
        style={{ left: s.left + 1, width: Math.max(8, s.width - 2), top: SOUND.top, height: SOUND.height }}
        className={cx(
          "absolute flex items-center gap-1 overflow-hidden rounded px-1.5 text-[10px]",
          c.sound === "file" ? "bg-picture/20 text-picture" : c.sound === "muted" || heard === "Silent" || !heard ? "bg-raised text-ink-3" : "bg-good/15 text-good",
          over?.kind === "sound" && over.clip === c.id && "outline outline-2 outline-accent",
        )}
      >
        {/* how loud it is along the clip: its own sound over the part that plays, or the sound file from its start */}
        {c.sound === "own" && video && c.take && <Wave sound={measureOf(video.id)?.sound ?? null} rate={measureOf(video.id)?.rate ?? 10} fromMs={c.take.startMs} toMs={c.take.endMs} />}
        {c.sound === "file" && c.soundAsset && <Wave sound={measureOf(c.soundAsset.id)?.sound ?? null} rate={measureOf(c.soundAsset.id)?.rate ?? 10} fromMs={0} toMs={s.lengthMs} />}
        {(c.sound === "muted" || heard === "Silent") && <VolumeX size={10} className="relative shrink-0" />}
        {s.width > 64 && <span className="relative truncate">{heard}</span>}
      </button>
    </div>
  );

}

/** A pinned picture on a clip: framed in the colour of pictures, ringed in the accent while its card shows. */
const pinLook = (on: boolean, place: string) =>
  cx("absolute top-6 h-7 w-7 rounded border-2 object-cover transition-shadow", place, on ? "border-accent ring-[3px] ring-accent/30" : "border-picture");
