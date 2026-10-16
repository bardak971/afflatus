import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Minus, Plus } from "lucide-react";
import { newTransition, TRANSITIONS, type ClipMusic, type Transition } from "@afflatus/core";
import type { Asset, Clip, RecipeInfo, Timeline, TimelinePatch } from "../api";
import { Keys } from "../Keys";
import { useKeysHere } from "../keys/here";
import { cx } from "../ui";
import { DRAG_TRANSITION, layout, NEW_CLIP, otherShape, PAD, ZOOM, type PinWhere, type ShownPatch, type TimeRange } from "./model";
import { STRIP_KINDS } from "./inspector/join";
import { SWATCH } from "./transitionLook";
import type { Clock } from "./clock";
import { FramePeek } from "./track/FramePeek";
import type { PinPlace } from "./track/peek";
import { PinPeek, type PinOver } from "./track/PinPeek";
import { Playhead } from "./track/Playhead";
import { MusicLane } from "./track/MusicLane";
import { HEIGHT, MUSIC, ROW, SOUND, SOURCE } from "./track/rows";
import { SourceLane, ToCome, type SourcePlace } from "./track/SourceLane";
import { TrackClip, type TrackClipActs } from "./track/TrackClip";
import { TrackRuler } from "./track/TrackRuler";
import { useRangeDrag } from "./track/useRangeDrag";
import { useStretch } from "./track/useStretch";
import { useTrackZoom, type TrackKeys } from "./track/useTrackZoom";
import { LEGEND, useTrackDrop } from "./track/useTrackDrop";

export type { TrackKeys } from "./track/useTrackZoom";

/** How long the pointer rests on a pinned picture before its card shows. */
const PIN_AFTER_MS = 250;

/**
 * The timeline itself: a ruler, the clips at their length with their own frames, each clip's sound,
 * and the music under all of it. Things are dragged onto it (useTrackDrop); a clip's edges shorten it (useStretch); the
 * range is drawn and snapped on it (useRangeDrag); it zooms and fits (useTrackZoom).
 */
export function Track({ timeline, recipes, pps, onZoom, selected, musicSelected, clock, cursorMs, running, busy, onStop, onSelect, picked, onPick, onUpload, onSelectMusic, onSeek, onMove, onInsert, onPin, onClipSound, onMusic, onTrim, onNewClip, onMenu, onSoundMenu, onPinMenu, onMusicMenu, onMusicEdit, onClipMusic, onJoin, onOpenJoin, onTransition, onSource, sourceSelected, onSelectSource, onOpenSource, onRemoveSource, onStretchSource, onSplitSource, onPeekSource, sourcePlace, sourceMode, sourceLabel, range, onRange, onRangeMenu, snapQuiet, renderOf, keys }: {
  timeline: Timeline;
  recipes: RecipeInfo[];
  /** Pixels per second. */
  pps: number;
  onZoom(pps: number): void;
  selected: string | null;
  musicSelected: boolean;
  /** The moment of what plays: only the playhead draws from it, so only the playhead redraws on every tick. */
  clock: Clock;
  /** Where the playhead was put by hand, in the track's own time: it can stand on a clip that is not rendered yet. null = it follows what plays. */
  cursorMs: number | null;
  /** The clip that renders now, if any (its progress is read by the clip itself). */
  running: string | null;
  busy: boolean;
  /** Stop a clip's render, or take it out of the queue. */
  onStop(job: string): void;
  /** A clip with nothing to play yet that can be rendered: how, and about how long (each clip shows it). */
  renderOf?(clip: Clip): { run(): void; ms: number | null } | null;
  onSelect(clip: string): void;
  /** The clips picked with Ctrl + click, to render together; and the pick itself. */
  picked?: Set<string>;
  onPick?(clip: string): void;
  onSelectMusic(): void;
  /** The playhead was moved: the moment of what plays, and where it stands on the track. */
  onSeek(playMs: number, trackMs?: number): void;
  onMove(clip: string, after: string | null): void;
  /** A picture or a video of the library, put between clips. */
  onInsert(asset: string, after: string | null): void;
  /** A picture pinned to a clip: it opens on it, ends on it, or passes through it at `atS` seconds. */
  onPin(clip: Clip, where: "start" | "end" | "mid", asset: string, atS?: number): void;
  /** A file dropped from the computer: put into the library, giving what it became (null when it could not be). */
  onUpload?(file: File): Promise<{ id: string; kind: string } | null>;
  onClipSound(clip: string, asset: string): void;
  onMusic(asset: string): void;
  onTrim(clip: Clip, patch: ShownPatch): void;
  onNewClip(after: string | undefined): void;
  /** A right-click on a clip: its menu. */
  onMenu?(clip: Clip, e: React.MouseEvent): void;
  /** Right-click on a clip's audio strip, and on the music strip. */
  onSoundMenu?(clip: Clip, e: React.MouseEvent): void;
  /** Right-click on a clip's pinned picture: that frame's menu. */
  onPinMenu?(clip: Clip, where: PinWhere, e: React.MouseEvent): void;
  onMusicMenu?(e: React.MouseEvent): void;
  /** The music's place changed on its lane: which part of the song plays, the clip it starts with. */
  onMusicEdit?(patch: TimelinePatch): Promise<unknown> | void;
  /** What a clip asks of the music under it (null: as the rest). */
  onClipMusic?(clip: Clip, music: ClipMusic | null): void;
  /** The join dot before a clip was clicked: it extends the clip before, or is a cut. */
  onJoin?(clip: Clip, joined: "continue" | "cut"): void;
  /** The join before a clip, opened in the column. */
  onOpenJoin?(clip: Clip): void;
  /** A cut's transition into a clip set (dropped from the strip, a length dragged); null = a plain cut. */
  onTransition?(clip: string, transition: Transition | null): void;
  /** A video dropped on the source lane, and the lane opened in the column (and whether it is). */
  onSource?(asset: string): void;
  sourceSelected?: boolean;
  onSelectSource?(): void;
  /** The source's video in the viewer; the source taken away. */
  onOpenSource?(video: Asset): void;
  onRemoveSource?(): void;
  onStretchSource?(fromMs: number, toMs: number): void;
  /** Split the source at the playhead (null: the playhead is not inside its stretch). */
  onSplitSource?: (() => void) | null;
  /** The moment of the source a drag on its lane stands on (shown in the stage meanwhile); null: the drag is over. */
  onPeekSource?(ms: number | null): void;
  /** Where the source lies on the track, and whether the stage plays it (the playhead then stands in the track's own time). */
  sourcePlace?: SourcePlace | null;
  sourceMode?: boolean;
  /** What makes the clips to come: the source's model. */
  sourceLabel?: string;
  /** In and Out, on the clock of what plays; null = no range. */
  range: TimeRange | null;
  onRange(range: TimeRange | null): void;
  /** A right-click on the range: its menu. */
  onRangeMenu?(e: React.MouseEvent): void;
  /** In and Out snap to quiet moments of the clips (their motion is measured once a range exists). */
  snapQuiet?: boolean;
  /** Filled here for the editor's keys: - and = zoom around the playhead, Shift+Z fits the whole video. */
  keys?: RefObject<TrackKeys | null>;
}) {
  // the keys sheet's "Here now": the track is the timeline editor's, its keys act while it is shown
  useKeysHere("editor");
  const clips = timeline.clips;
  const floor = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  // a clip's edges: drag to shorten it (or to give back what was cut)
  const { stretch, startPull, movePull, endPull } = useStretch({ clips, pps, onTrim });
  /** The pinned picture whose card shows (PinPeek), and the timer counting towards showing one. */
  const [pinOver, setPinOver] = useState<PinOver | null>(null);
  const pinTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restPin = (clip: string, where: PinPlace | null, el?: HTMLImageElement) => {
    if (pinTimer.current) clearTimeout(pinTimer.current);
    pinTimer.current = null;
    if (!where || !el) return setPinOver(null);
    pinTimer.current = setTimeout(() => setPinOver({ clip, where, el }), PIN_AFTER_MS);
  };
  // a press, a drag or leaving the clip puts it away (the clip's own figures are on the frame card: FramePeek)
  const leaveTip = () => {
    if (pinTimer.current) clearTimeout(pinTimer.current);
    pinTimer.current = null;
    setPinOver(null);
  };
  useEffect(() => () => {
    if (pinTimer.current) clearTimeout(pinTimer.current);
  }, []);

  const slots = useMemo(() => layout(clips, pps, recipes, stretch ?? undefined), [clips, pps, recipes, stretch]);
  const clipsEnd = slots.length ? slots.at(-1)!.left + slots.at(-1)!.width : PAD;
  // the clips Make will add after the last one, and the source under them: the track reaches past them
  const toCome = sourcePlace && !sourcePlace.made && !sourcePlace.replaces && sourcePlace.windows.length ? PAD + ((sourcePlace.atMs + sourcePlace.windows.at(-1)!.toMs) / 1000) * pps : 0;
  const sourceEnd = sourcePlace ? PAD + ((sourcePlace.atMs + sourcePlace.lengthMs) / 1000) * pps : 0;
  const end = Math.max(clipsEnd, toCome);
  const totalMs = Math.max(slots.length ? slots.at(-1)!.startMs + slots.at(-1)!.lengthMs : 0, sourceMode && sourcePlace ? sourcePlace.atMs + sourcePlace.lengthMs : 0);
  const width = Math.max(end, sourceEnd) + NEW_CLIP + PAD * 2 + 40;
  // what Fit all shows: the clips, the source under them and the windows still to make, its panel open or not
  const toComeMs = sourcePlace && !sourcePlace.made && !sourcePlace.replaces && sourcePlace.windows.length ? sourcePlace.atMs + sourcePlace.windows.at(-1)!.toMs : 0;
  const fitMs = Math.max(totalMs, toComeMs, sourcePlace ? sourcePlace.atMs + sourcePlace.lengthMs : 0);
  const xOf = (clientX: number) => clientX - (inner.current?.getBoundingClientRect().left ?? 0);

  const { over, dragging, draggedOf, hover, overClip, overJoin, drop, hint, legend, lineAt, leave } = useTrackDrop({ clips, slots, end, recipes, onUpload, onMove, onInsert, onPin, onClipSound, onMusic, onTransition: onTransition ? (clip, kind) => onTransition(clip, newTransition(kind)) : undefined, onSource });

  // ---- the range: In and Out, swept on the ruler with Shift, or dragged by their brackets; they snap to cuts, to the playhead and to quiet moments
  const { playEnd, measureOf, motion, snapRange, band, rangeMenuAt } = useRangeDrag({ slots, clips, timeline, pps, clock, snapQuiet, range, xOf, onRangeMenu });

  const { zoomTo, fitAll } = useTrackZoom({ scroller, pps, onZoom, slots, totalMs, fitMs, clock, cursorMs, timelineId: timeline.id, clipCount: clips.length, keys });

  // what the clips do when pressed: read when it happens, so that a clip draws again only when what it shows changes
  const acts = useRef<TrackClipActs>(null!);
  acts.current = {
    xOf, slots, totalMs, pps, range, leaveTip, restPin, overClip, overJoin, startPull, movePull, endPull, onSelect, onPick, onRange, onSeek, onMenu, onSoundMenu, onPinMenu, onStop, onJoin, onOpenJoin, onTransition,
    render: (c) => renderOf?.(c)?.run(),
  };

  return (
    <div ref={floor} data-designer-floor className="flex shrink-0 flex-col border-t border-line bg-panel select-none">
      <div className="flex">
        <div className="relative w-[64px] shrink-0 border-r border-line text-[11px] font-semibold text-ink-2" style={{ height: HEIGHT }}>
          <span className="absolute left-3" style={{ top: ROW.top + ROW.height / 2 - 8 }}>Video</span>
          <span className="absolute left-3" style={{ top: SOUND.top + 1 }}>Audio</span>
          {onSource && <span className="absolute left-3" style={{ top: SOURCE.top + 4 }}>Source</span>}
          <span className="absolute left-3" style={{ top: MUSIC.top + 3 }}>Music</span>
        </div>
        <div
          ref={scroller}
          className="relative min-w-0 grow overflow-x-auto overflow-y-hidden"
          onDragOver={(e) => hover(e, draggedOf(e) === "sound" || draggedOf(e) === "transition" ? null : { kind: "insert", index: clips.length })}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) leave();
          }}
          onDrop={drop}
        >
          <div ref={inner} className="relative" style={{ width, height: HEIGHT }} onContextMenu={rangeMenuAt}>
            <TrackRuler
              clock={clock}
              durationMs={timeline.durationMs}
              slots={slots}
              totalMs={totalMs}
              playEnd={playEnd}
              pps={pps}
              xOf={xOf}
              range={range}
              onRange={onRange}
              onSeek={onSeek}
              band={band}
              motion={motion}
              snapRange={snapRange}
              snapQuiet={snapQuiet}
            />

            {slots.map((s) => {
              const c = s.clip;
              return (
                <TrackClip
                  key={c.id}
                  s={s}
                  prev={clips[s.index - 1]}
                  prevRecipe={recipes.find((r) => r.id === clips[s.index - 1]?.recipe)}
                  recipe={recipes.find((r) => r.id === c.recipe)}
                  misfit={otherShape(c, timeline)}
                  on={c.id === selected}
                  picked={Boolean(picked?.has(c.id))}
                  rendering={running === c.id}
                  stretch={stretch}
                  over={over && "clip" in over && over.clip === c.id ? over : null}
                  pinOn={pinOver?.clip === c.id ? pinOver.where : null}
                  ownSound={measureOf(c.take?.asset.id)}
                  fileSound={c.sound === "file" ? measureOf(c.soundAsset?.id) : undefined}
                  renderMs={s.planned ? renderOf?.(c)?.ms : undefined}
                  acts={acts}
                />
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

            {/* the source: a long video under the clips, made into clips window by window */}
            {onSource && (
              <SourceLane
                timeline={timeline}
                place={sourcePlace ?? null}
                onSplit={onSplitSource}
                onPeek={onPeekSource}
                recipes={recipes}
                pps={pps}
                width={width}
                selected={Boolean(sourceSelected)}
                over={over?.kind === "source"}
                onDragOver={(e) => hover(e, draggedOf(e) === "video" ? { kind: "source" } : null)}
                onSelect={() => onSelectSource?.()}
                onOpen={onOpenSource}
                onRemove={onRemoveSource}
                onStretch={onStretchSource}
              />
            )}

            {/* the music: one sound under the whole video, split at the clips */}
            <MusicLane
              timeline={timeline}
              slots={slots}
              pps={pps}
              width={width}
              selected={musicSelected}
              over={over?.kind === "music"}
              measureOf={measureOf}
              onDragOver={(e) => hover(e, draggedOf(e) === "sound" ? { kind: "music" } : null)}
              onSelectMusic={() => timeline.music && onSelectMusic()}
              onMusicMenu={onMusicMenu}
              onMusicEdit={onMusicEdit}
              onClipMusic={onClipMusic}
            />

            {lineAt !== null && <div aria-hidden className="pointer-events-none absolute z-20 w-[3px] rounded bg-accent" style={{ left: lineAt - 1.5, top: ROW.top - 2, height: ROW.height + 4 }} />}
            {sourcePlace && !sourcePlace.made && sourcePlace.windows.length > 0 && <ToCome place={sourcePlace} pps={pps} label={sourceLabel ?? "Motion transfer"} />}
            <Playhead clock={clock} slots={slots} cursorMs={cursorMs} totalMs={totalMs} pps={pps} free={sourceMode} />
            <FramePeek area={inner} floor={floor} slots={slots} clips={clips} recipes={recipes} pps={pps} totalMs={totalMs} paused={Boolean(pinOver || stretch || dragging)} />
            {pinOver && (() => {
              const s = slots.find((x) => x.clip.id === pinOver.clip);
              const r = floor.current?.getBoundingClientRect();
              return s && pinOver.el.isConnected ? <PinPeek over={pinOver} slot={s} recipe={recipes.find((x) => x.id === s.clip.recipe)} bounds={r ? { left: r.left, right: r.right } : undefined} /> : null;
            })()}
          </div>
        </div>
      </div>
      <div className="flex h-8 items-center gap-2 border-t border-line pr-2 pl-3 text-xs">
        {legend ? (
          // the keys and their words; the line said in full for a screen reader. A narrow footer drops the last ones
          // whole (they wrap onto a second line that is out of sight) rather than cutting one mid-word; the empty
          // first item lets even the first of them go when there is no room for it.
          <span className="flex h-5 min-w-0 grow flex-wrap items-center gap-x-3.5 overflow-hidden text-[11.5px] whitespace-nowrap text-ink-3">
            <span className="sr-only">{hint}</span>
            <span aria-hidden className="-mr-3.5 h-5" />
            {LEGEND.map((l) => <span key={l.words} aria-hidden className="flex h-5 shrink-0 items-center gap-1.5"><Keys keys={l.keys} size="sm" />{l.words}</span>)}
          </span>
        ) : (
          <span className={cx("min-w-0 grow truncate", dragging ? "font-semibold text-accent" : "text-ink-3")}>{hint}</span>
        )}
        {onTransition && clips.length > 1 && (
          // the transitions, dragged onto a join (a cut's dot); the rest are in the join's own panel
          <span className="flex shrink-0 items-center gap-1 border-r border-line pr-2" aria-label="Transitions: drag one onto a join">
            <span className="mr-0.5 text-[11px] font-semibold text-ink-3">Transitions</span>
            {STRIP_KINDS.map((k) => (
              <span
                key={k}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(DRAG_TRANSITION, k);
                  e.dataTransfer.effectAllowed = "copy";
                }}
                data-tip={`${TRANSITIONS[k].label}: drag it onto a join`}
                className="h-4 w-6 cursor-grab rounded-[4px] border border-line-strong"
                style={{ background: SWATCH[k] }}
              />
            ))}
          </span>
        )}
        <button type="button" aria-label="Zoom out" data-tip="Zoom out" data-tip-keys="-" onClick={() => zoomTo(Math.max(ZOOM.least, pps / ZOOM.step))} className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-2 hover:bg-hover hover:text-ink"><Minus size={13} /></button>
        <button type="button" aria-label="Zoom in" data-tip="Zoom in" data-tip-keys="=" onClick={() => zoomTo(Math.min(ZOOM.most, pps * ZOOM.step))} className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-2 hover:bg-hover hover:text-ink"><Plus size={13} /></button>
        <button type="button" data-tip="The whole video in view" data-tip-keys="Shift+Z" onClick={fitAll} className="h-6 shrink-0 rounded-md border border-line-strong px-2 font-semibold whitespace-nowrap text-ink-2 hover:bg-hover hover:text-ink">Fit all</button>
      </div>
    </div>
  );
}
