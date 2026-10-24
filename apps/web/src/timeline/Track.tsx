import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { Minus, Plus } from "lucide-react";
import { newTransition, TRANSITIONS, type ClipMusic, type Transition } from "@afflatus/core";
import type { Asset, Clip, RecipeInfo, Timeline, TimelinePatch } from "../api";
import { Keys } from "../Keys";
import { useKeysHere } from "../keys/here";
import { cx, IconButton } from "../ui";
import { DRAG_TRANSITION, keptSlots, layout, NEW_CLIP, otherShape, PAD, ZOOM, type PinWhere, type ShownPatch, type Slot, type TimeRange } from "./model";
import { STRIP_KINDS } from "./inspector/join";
import { SWATCH } from "./transitionLook";
import type { Clock } from "./clock";
import { FramePeek } from "./track/FramePeek";
import type { PinPlace } from "./track/peek";
import { PinPeek, type PinOver } from "./track/PinPeek";
import { Playhead } from "./track/Playhead";
import { MusicLane } from "./track/MusicLane";
import { ownSoundModel, RecordingBands, voiceOf } from "./track/RecordingBand";
import { EndColumnLive } from "./track/EndColumn";
import { useLaneMenus } from "./track/LaneMenus";
import { HEIGHT, MUSIC, ROW, SOUND, SOURCE } from "./track/rows";
import { SourceLane, ToCome, type SourcePlace } from "./track/SourceLane";
import { nearJoin } from "./track/nearJoin";
import { joinCovered, TrackClip, type TrackClipActs } from "./track/TrackClip";
import { TrackRuler } from "./track/TrackRuler";
import { useClipDrag, type ClipMove } from "./track/useClipDrag";
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
/** How wide the zone round a join is where its "+" shows (px): 20 either side of the cut. */
const JOIN_ZONE = 40;

/** The line under the track while a clip is held: where it lands if let go of now, named by the clips' numbers as they are. */
function moveHint(m: ClipMove, now: string[]): string {
  const n = (id: string) => now.indexOf(id) + 1;
  const k = m.order.indexOf(m.clip);
  if (m.order.join() === now.join()) return `Clip ${n(m.clip)}: drag it past another clip's middle to move it · Esc puts it back`;
  const where = k === 0 ? "at the start" : k === m.order.length - 1 ? "at the end" : `between clip ${n(m.order[k - 1]!)} and clip ${n(m.order[k + 1]!)}`;
  return `Let go to move clip ${n(m.clip)} ${where} · Esc puts it back`;
}

export function Track({ timeline, recipes, pps, onZoom, selected, musicSelected, clock, cursorMs, running, busy, onStop, onSelect, picked, onPick, onUpload, onSelectMusic, onSeek, onMove, onInsert, onPin, onClipSound, onMusic, onTrim, onNewClip, onMenu, onSoundMenu, onPinMenu, onMusicMenu, onMusicEdit, onClipMusic, onJoin, onOpenJoin, onTransition, onSource, onRecording, onVoice, onRecipe, onSourceSettings, onRecordingTrim, recordingOpen, onOpenRecording, stageEndMs = null, sourceSelected, onSelectSource, onOpenSource, onRemoveSource, onStretchSource, onSplitSource, onPeekSource, sourcePlace, sourceMode, sourceLabel, range, onRange, onRangeMenu, snapQuiet, renderOf, keys }: {
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
  /** A clip moved along the track (by the pointer): put after `after`, null first. Its answer, if any, says whether it held. */
  onMove(clip: string, after: string | null): Promise<unknown> | void;
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
  /** A voice recording made into Lip sync clips (dropped past the clips, or on an empty one). */
  onRecording?(asset: string, clip?: string): void;
  /** A recording made the voice of a Lip sync clip that has none (dropped on its Audio cell, or chosen from its menu). */
  onVoice?(clip: Clip, asset: string): void;
  /** A clip given another model (a Lip sync clip without a voice switched to its family's Video with audio). */
  onRecipe?(clip: Clip, recipe: string): void;
  /** The source's settings in the column: how Motion transfer cuts its windows (the empty Source drop's menu). */
  onSourceSettings?(): void;
  /** A recording's band on the Audio row dragged: its In and Out, in ms of the recording (settled: RecordingBands' onTrim). */
  onRecordingTrim?(asset: string, fromMs: number, toMs: number): Promise<boolean> | void;
  /** The recording open on the stage (its asset's id; its band outlined), and a band clicked: that recording opened. */
  recordingOpen?: string | null;
  onOpenRecording?(asset: string): void;
  /** The stage plays a recording (in the track's own time, up to here): the playhead stands where it is heard, clips or not. */
  stageEndMs?: number | null;
  sourceSelected?: boolean;
  onSelectSource?(): void;
  /** The source's video in the viewer; the source taken away. */
  onOpenSource?(video: Asset): void;
  onRemoveSource?(): void;
  /** The source's lane dragged: its stretch (settled: SourceLane's onStretch). */
  onStretchSource?(fromMs: number, toMs: number): Promise<boolean> | void;
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

  // laid again keeping the slots that did not change (keptSlots): a clip draws again only when its own slot changed
  const laid = useRef<Slot[] | null>(null);
  const slots = useMemo(() => (laid.current = keptSlots(laid.current, layout(clips, pps, recipes, stretch ?? undefined))), [clips, pps, recipes, stretch]);
  const clipsEnd = slots.length ? slots.at(-1)!.left + slots.at(-1)!.width : PAD;
  // the clips Make will add after the last one, and the source under them: the track reaches past them
  const toCome = sourcePlace && !sourcePlace.made && !sourcePlace.replaces && sourcePlace.windows.length ? PAD + ((sourcePlace.atMs + sourcePlace.windows.at(-1)!.toMs) / 1000) * pps : 0;
  const sourceEnd = sourcePlace ? PAD + ((sourcePlace.atMs + sourcePlace.lengthMs) / 1000) * pps : 0;
  const end = Math.max(clipsEnd, toCome);
  const totalMs = Math.max(slots.length ? slots.at(-1)!.startMs + slots.at(-1)!.lengthMs : 0, sourceMode && sourcePlace ? sourcePlace.atMs + sourcePlace.lengthMs : 0, stageEndMs ?? 0);
  const width = Math.max(end, sourceEnd) + NEW_CLIP + PAD * 2 + 40;
  // what Fit all shows: the clips, the source under them and the windows still to make, its panel open or not
  const toComeMs = sourcePlace && !sourcePlace.made && !sourcePlace.replaces && sourcePlace.windows.length ? sourcePlace.atMs + sourcePlace.windows.at(-1)!.toMs : 0;
  const fitMs = Math.max(totalMs, toComeMs, sourcePlace ? sourcePlace.atMs + sourcePlace.lengthMs : 0);
  const xOf = (clientX: number) => clientX - (inner.current?.getBoundingClientRect().left ?? 0);

  const voiceTo = onVoice ? (id: string, asset: string) => {
    const c = clips.find((x) => x.id === id);
    if (c) onVoice(c, asset);
  } : undefined;
  const { over, dragging, draggedOf, hover, overClip, overJoin, drop, hint: dropHint, legend: dropLegend, lineAt, leave } = useTrackDrop({ clips, slots, end, recipes, onUpload, onInsert, onPin, onClipSound, onMusic, onTransition: onTransition ? (clip, kind) => onTransition(clip, newTransition(kind)) : undefined, onSource, onRecording, onVoice: voiceTo });

  // ---- right-click on a lane that holds nothing yet, and on a Lip sync clip's Audio cell while it has no voice
  const lanes = useLaneMenus({
    onSource,
    onRecording: onRecording ? (asset) => onRecording(asset) : undefined,
    onMusic,
    onVoice: voiceTo,
    onUpload,
    onSourceSettings,
    switchOf: (c) => {
      const to = onRecipe ? ownSoundModel(recipes.find((r) => r.id === c.recipe), recipes) : undefined;
      return to ? { title: to.title, run: () => onRecipe!(c, to.id) } : null;
    },
  });

  // ---- a clip moved along the track by the pointer, 1:1 (useClipDrag); while it is held the line under the track says where it lands
  const clipDrag = useClipDrag({ slots, pps, xOf, scroller, onMove });
  const moved = clipDrag.shown;
  const hint = moved?.holding ? moveHint(moved, clips.map((c) => c.id)) : dropHint;
  const legend = dropLegend && !moved?.holding;

  // the join the pointer is near, within 20 px either side of it on the video row: its "+" shows (review 4, P6). Kept
  // out of the Track's state (nearJoin.ts), so that crossing a join draws only the two clips concerned again
  const [near] = useState(nearJoin);
  const nearAt = (e: ReactPointerEvent) => {
    const box = inner.current?.getBoundingClientRect();
    const y = box ? e.clientY - box.top : -1;
    const x = xOf(e.clientX);
    const s = !moved && e.buttons === 0 && y >= ROW.top - 4 && y <= ROW.top + ROW.height ? slots.find((k) => k.index > 0 && Math.abs(x - k.left) <= JOIN_ZONE / 2) : undefined;
    near.set(s?.clip.id ?? null);
  };

  // ---- the range: In and Out, swept on the ruler with Shift, or dragged by their brackets; they snap to cuts, to the playhead and to quiet moments
  const { playEnd, measureOf, motion, snapRange, band, rangeMenuAt } = useRangeDrag({ slots, clips, timeline, pps, clock, snapQuiet, range, xOf, onRangeMenu });

  const { zoomTo, fitAll } = useTrackZoom({ scroller, pps, onZoom, slots, totalMs, fitMs, clock, cursorMs, timelineId: timeline.id, clipCount: clips.length, keys });

  /** A Lip sync clip's voice as its face says it: the recording's name, null while it has none; undefined for any other clip. */
  const voiceName = (c: Clip) => {
    const v = voiceOf(c, recipes.find((r) => r.id === c.recipe));
    return v ? timeline.recordings?.find((r) => r.asset.id === v)?.asset.name || "Recording" : v;
  };

  // what the clips do when pressed: read when it happens, so that a clip draws again only when what it shows changes
  const acts = useRef<TrackClipActs>(null!);
  acts.current = {
    xOf, slots, totalMs, pps, range, leaveTip, restPin, overClip, overJoin, startPull, movePull, endPull, onSelect, onPick, onRange, onSeek, onMenu, onSoundMenu, onPinMenu, onStop, onJoin, onOpenJoin, onTransition, onNewClip,
    render: (c) => renderOf?.(c)?.run(),
    overVoice: (e, s) => hover(e, draggedOf(e) === "sound" ? { kind: "voice", clip: s.clip.id } : null),
    onVoiceMenu: (c, e) => lanes.open(e, { kind: "voice", clip: c, n: clips.findIndex((x) => x.id === c.id) + 1 }),
    clipDown: clipDrag.down, clipMove: clipDrag.move, clipUp: clipDrag.up, clipCancel: clipDrag.cancel, mount: clipDrag.mount, dragged: clipDrag.dragged,
  };

  return (
    <div ref={floor} data-designer-floor className="flex shrink-0 flex-col border-t border-line bg-panel select-none">
      <div className="flex">
        <div className="relative w-[64px] shrink-0 border-r border-line text-meta font-semibold text-ink-2" style={{ height: HEIGHT }}>
          {/* each lane's name on the middle of its row */}
          <span className="absolute left-3 flex items-center" style={{ top: ROW.top, height: ROW.height }}>Video</span>
          <span className="absolute left-3 flex items-center" style={{ top: SOUND.top, height: SOUND.height }}>Audio</span>
          {onSource && <span className="absolute left-3 flex items-center" style={{ top: SOURCE.top, height: SOURCE.height }}>Source</span>}
          <span className="absolute left-3 flex items-center" style={{ top: MUSIC.top, height: MUSIC.height }}>Music</span>
        </div>
        <div
          ref={scroller}
          className="relative min-w-0 grow overflow-x-auto overflow-y-hidden"
          onDragOver={(e) => hover(e, draggedOf(e) === "sound" ? (onRecording ? { kind: "recording" } : null) : draggedOf(e) === "transition" ? null : { kind: "insert", index: clips.length })}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) leave();
          }}
          onDrop={drop}
        >
          <div
            ref={inner}
            className="relative"
            style={{ width, height: HEIGHT }}
            onContextMenu={rangeMenuAt}
            onPointerMove={nearAt}
            onPointerLeave={() => near.set(null)}
          >
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
                  edged={joinCovered(slots, s, selected)}
                  picked={Boolean(picked?.has(c.id))}
                  rendering={running === c.id}
                  stretch={stretch}
                  over={over && "clip" in over && over.clip === c.id ? over : null}
                  pinOn={pinOver?.clip === c.id ? pinOver.where : null}
                  ownSound={measureOf(c.take?.asset.id)}
                  fileSound={c.sound === "file" ? measureOf(c.soundAsset?.id) : undefined}
                  renderMs={s.planned ? renderOf?.(c)?.ms : undefined}
                  lift={moved?.clip === c.id ? (moved.holding ? "held" : "landing") : undefined}
                  moving={Boolean(moved)}
                  nearJoin={near}
                  voice={voiceName(c)}
                  acts={acts}
                />
              );
            })}

            {/* the voice recordings, each a band under the Lip sync clips made of it */}
            <RecordingBands timeline={timeline} slots={slots} recipes={recipes} pps={pps} onTrim={onRecordingTrim} onSelect={onSelect} onOpen={onOpenRecording} open={recordingOpen} />

            {/* the end column: New clip, a voice recording, a long video, the three drops that add their clips after the last one.
                After the last clip, and over the clips only while they run past the view (pinned at its right edge: at 1440 px
                the Audio hint went under the inspector after the last clip); the Audio hint pulled left whenever it did not fit
                whole sat over the last clip's own Audio cell (the owner's Timeline 9, 2026-10-22) and read as that clip's */}
            <EndColumnLive
              scroller={scroller}
              end={end}
              pad={PAD}
              busy={busy}
              overRecording={over?.kind === "recording" && !over.clip}
              overSource={over?.kind === "source"}
              onNewClip={() => onNewClip(clips.at(-1)?.id)}
              onRecordingOver={onRecording ? (e) => hover(e, draggedOf(e) === "sound" ? { kind: "recording" } : null) : undefined}
              onSourceOver={onSource && !timeline.source ? (e) => hover(e, draggedOf(e) === "video" ? { kind: "source" } : null) : undefined}
              onRecordingMenu={(e) => lanes.open(e, { kind: "recording" })}
              onSourceMenu={(e) => lanes.open(e, { kind: "source" })}
            />

            {/* the source: a long video under the clips, made into clips window by window */}
            {onSource && (
              <SourceLane
                timeline={timeline}
                place={sourcePlace ?? null}
                onSplit={onSplitSource}
                onPeek={onPeekSource}
                recipes={recipes}
                pps={pps}
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
              // empty, its own menu: the library's music, or a file from the computer
              onMusicMenu={timeline.music ? onMusicMenu : (e) => lanes.open(e, { kind: "music" })}
              onMusicEdit={onMusicEdit}
              onClipMusic={onClipMusic}
            />

            {lineAt !== null && <div aria-hidden className="pointer-events-none absolute z-20 w-[3px] rounded bg-accent" style={{ left: lineAt - 1.5, top: ROW.top - 2, height: ROW.height + 4 }} />}
            {sourcePlace && !sourcePlace.made && sourcePlace.windows.length > 0 && <ToCome place={sourcePlace} pps={pps} label={sourceLabel ?? "Motion transfer"} />}
            <Playhead clock={clock} slots={slots} cursorMs={cursorMs} totalMs={totalMs} pps={pps} free={sourceMode || stageEndMs !== null} />
            <FramePeek area={inner} floor={floor} slots={slots} clips={clips} recipes={recipes} pps={pps} totalMs={totalMs} paused={Boolean(pinOver || stretch || dragging || moved)} />
            {lanes.node}
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
          <span className="flex h-5 min-w-0 grow flex-wrap items-center gap-x-3.5 overflow-hidden text-meta whitespace-nowrap text-ink-3">
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
            <span className="mr-0.5 text-meta font-semibold text-ink-3">Transitions</span>
            {STRIP_KINDS.map((k) => (
              <span
                key={k}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(DRAG_TRANSITION, k);
                  e.dataTransfer.effectAllowed = "copy";
                }}
                data-tip={`${TRANSITIONS[k].label}: drag it onto a join`}
                className="h-6 w-7 cursor-grab rounded-key border border-line-strong"
                style={{ background: SWATCH[k] }}
              />
            ))}
          </span>
        )}
        <IconButton size={28} label="Zoom out" keys="-" onClick={() => zoomTo(Math.max(ZOOM.least, pps / ZOOM.step))}><Minus size={13} /></IconButton>
        <IconButton size={28} label="Zoom in" keys="=" onClick={() => zoomTo(Math.min(ZOOM.most, pps * ZOOM.step))}><Plus size={13} /></IconButton>
        <button type="button" data-tip="The whole video in view" data-tip-keys="Shift+Z" onClick={fitAll} className="h-6 shrink-0 rounded-md border border-line-strong px-2 font-semibold whitespace-nowrap text-ink-2 hover:bg-hover hover:text-ink">Fit all</button>
      </div>
    </div>
  );
}
