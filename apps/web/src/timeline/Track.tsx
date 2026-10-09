import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { Minus, Plus } from "lucide-react";
import type { ClipMusic } from "@afflatus/core";
import type { Clip, RecipeInfo, Timeline, TimelinePatch } from "../api";
import { Keys } from "../Keys";
import { useKeysHere } from "../keys/here";
import { cx } from "../ui";
import { layout, NEW_CLIP, otherShape, PAD, placeOf, roomOf, ZOOM, type ShownPatch, type Slot } from "./model";
import type { Clock } from "./clock";
import { FramePeek } from "./track/FramePeek";
import type { PinPlace } from "./track/peek";
import { PinPeek, type PinOver } from "./track/PinPeek";
import { Playhead } from "./track/Playhead";
import { MusicLane } from "./track/MusicLane";
import { HEIGHT, MUSIC, ROW, SOUND } from "./track/rows";
import { TrackClip, type Stretch, type TrackClipActs } from "./track/TrackClip";
import { TrackRuler } from "./track/TrackRuler";
import { useMotionMarks } from "./track/useMotionMarks";
import { LEGEND, useTrackDrop } from "./track/useTrackDrop";

/** What the editor's keys reach on the track: a zoom step around the playhead, and Fit all. */
export interface TrackKeys {
  zoom(by: -1 | 1): void;
  fit(): void;
}

/** How long the pointer rests on a pinned picture before its card shows. */
const PIN_AFTER_MS = 250;

/** In and Out on the timeline, on the clock of what plays. */
export interface TimeRange {
  inMs: number;
  outMs: number;
}

/**
 * The timeline itself: a ruler, the clips at their length with their own frames, each clip's sound,
 * and the music under all of it. Things are dragged onto it; a clip's edges shorten it.
 */
export function Track({ timeline, recipes, pps, onZoom, selected, musicSelected, clock, cursorMs, running, busy, onStop, onSelect, picked, onPick, onUpload, onSelectMusic, onSeek, onMove, onInsert, onPin, onClipSound, onMusic, onTrim, onNewClip, onMenu, onSoundMenu, onMusicMenu, onMusicEdit, onClipMusic, onJoin, range, onRange, onRangeMenu, snapQuiet, renderOf, keys }: {
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
  onMusicMenu?(e: React.MouseEvent): void;
  /** The music's place changed on its lane: which part of the song plays, the clip it starts with. */
  onMusicEdit?(patch: TimelinePatch): void;
  /** What a clip asks of the music under it (null: as the rest). */
  onClipMusic?(clip: Clip, music: ClipMusic | null): void;
  /** The join dot before a clip was clicked: it extends the clip before, or is a cut. */
  onJoin?(clip: Clip, joined: "continue" | "cut"): void;
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
  /** An edge being dragged: the clip, which edge, and the length it has for now. */
  const [stretch, setStretch] = useState<Stretch | null>(null);
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
  const pull = useRef<{ x: number; base: number; least: number; most: number } | null>(null);

  const slots = useMemo(() => layout(clips, pps, recipes, stretch ?? undefined), [clips, pps, recipes, stretch]);
  const end = slots.length ? slots.at(-1)!.left + slots.at(-1)!.width : PAD;
  const totalMs = slots.length ? slots.at(-1)!.startMs + slots.at(-1)!.lengthMs : 0;
  const width = end + NEW_CLIP + PAD * 2 + 40;
  const xOf = (clientX: number) => clientX - (inner.current?.getBoundingClientRect().left ?? 0);

  const { over, dragging, draggedOf, hover, overClip, drop, hint, legend, lineAt, leave } = useTrackDrop({ clips, slots, end, recipes, onUpload, onMove, onInsert, onPin, onClipSound, onMusic });

  // ---- the range: In and Out, swept on the ruler with Shift, or dragged by their brackets; they snap to cuts, to the playhead and to quiet moments
  const playEnd = clips.reduce((sum, c) => sum + c.lengthMs, 0);
  const { measureOf, motion, snapRange } = useMotionMarks({ slots, clips, timeline, playEnd, pps, clock, snapQuiet });
  const xAt = (ms: number) => placeOf(slots, ms)?.x ?? null;
  const band = (() => {
    if (!range) return null;
    const a = xAt(range.inMs);
    const b = xAt(range.outMs);
    return a === null || b === null ? null : { a: Math.min(a, b), b: Math.max(a, b) };
  })();
  const rangeMenuAt = (e: ReactMouseEvent) => {
    if (e.defaultPrevented || !band || !onRangeMenu) return;
    const x = xOf(e.clientX);
    if (x >= band.a - 10 && x <= band.b + 10) onRangeMenu(e);
  };

  // ---- a clip's edges: drag to shorten it (or to give back what was cut)
  const startPull = (e: ReactPointerEvent, s: Slot, side: "start" | "end") => {
    e.stopPropagation();
    e.preventDefault();
    const c = s.clip;
    // what is seen can reach back to the first frame it does not share with the clip before, and on to the last one it does not share with the clip after
    const t = c.take;
    const most = c.kind === "still" ? 60_000 : Math.max(c.lengthMs, c.lengthMs + (side === "start" ? t!.startMs - t!.headMs : t!.headMs + roomOf(t!) - t!.endMs));
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
      // asked by what is seen: the server works out the trims, so that the cut lands on the frame that was seen there
      else if (stretch.side === "start") onTrim(c, { shownFromMs: Math.max(0, c.take!.startMs + cut) });
      else onTrim(c, { shownToMs: Math.max(0, c.take!.endMs - cut) });
    }
    setStretch(null);
  };

  // the whole timeline is in view because it was fitted (on arriving, Fit all, a clip added), not zoomed by hand since:
  // then a change of the track's width (the window, the column dragged or folded) fits it again
  const whole = useRef(false);
  /** A zoom asked by hand: what it shows is the person's from then on, kept through a change of width. */
  const zoomTo = (next: number) => {
    whole.current = false;
    onZoom(next);
  };
  // Ctrl + wheel zooms around the pointer; a plain wheel scrolls the track sideways (a mouse has no sideways wheel)
  const ppsNow = useRef(pps);
  ppsNow.current = pps;
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const ms = ((px + el.scrollLeft - PAD) / ppsNow.current) * 1000;
        const next = Math.max(ZOOM.least, Math.min(ZOOM.most, ppsNow.current * Math.exp(-e.deltaY * 0.0015)));
        whole.current = false;
        onZoom(next);
        // the moment under the pointer stays under it
        requestAnimationFrame(() => { el.scrollLeft = Math.max(0, PAD + (ms / 1000) * next - px); });
      } else if (!e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onZoom]);

  const fitAll = () => {
    const room = (scroller.current?.clientWidth ?? 800) - NEW_CLIP - PAD * 3 - 40;
    if (totalMs <= 0) return;
    whole.current = true;
    onZoom(Math.max(ZOOM.least, Math.min(ZOOM.most, room / (totalMs / 1000))));
  };
  /** One zoom step out (-1) or in (1) around the playhead: it stays where it is on screen (brought to the middle when it was out of view). */
  const zoomAtHead = (by: -1 | 1) => {
    const el = scroller.current;
    const next = Math.max(ZOOM.least, Math.min(ZOOM.most, by > 0 ? pps * ZOOM.step : pps / ZOOM.step));
    if (!el || next === pps) return;
    whole.current = false;
    const layoutMs = cursorMs !== null ? Math.min(cursorMs, totalMs) : placeOf(slots, clock.get())?.layoutMs ?? 0;
    const shown = PAD + (layoutMs / 1000) * pps - el.scrollLeft;
    const px = shown >= 0 && shown <= el.clientWidth ? shown : el.clientWidth / 2;
    onZoom(next);
    requestAnimationFrame(() => { el.scrollLeft = Math.max(0, PAD + (layoutMs / 1000) * next - px); });
  };
  if (keys) keys.current = { zoom: zoomAtHead, fit: fitAll };
  // arriving on a timeline, the whole of it is in view; zooming after that is the person's
  const fittedFor = useRef<string | null>(null);
  useEffect(() => {
    if (totalMs <= 0 || fittedFor.current === timeline.id) return;
    // marked done only once it has run: a frame cancelled (the length settling a render later) asks again
    const id = requestAnimationFrame(() => {
      fittedFor.current = timeline.id;
      fitAll();
    });
    return () => cancelAnimationFrame(id);
    // once per timeline, when its length is known
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeline.id, totalMs]);
  // a clip added (New clip, a drop, a continuation): the whole timeline in view again, the new clip with it
  // (kept asked for until it has run: the new clip's length may settle a render later)
  // the new clip's panel opens beside the track as it is added and narrows it: a fit just made is made again for the new
  // width; and a track showing the whole timeline keeps showing all of it at any width (useRef `whole`)
  const fittedAt = useRef(0);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let width = el.clientWidth;
    const seen = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      if (whole.current || performance.now() - fittedAt.current < 1500) fitAll();
    });
    seen.observe(el);
    return () => seen.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalMs]);
  const counted = useRef(clips.length);
  const fitAsked = useRef(false);
  useEffect(() => {
    if (clips.length > counted.current) fitAsked.current = true;
    counted.current = clips.length;
    if (!fitAsked.current || totalMs <= 0) return;
    const id = requestAnimationFrame(() => {
      fitAsked.current = false;
      fitAll();
      fittedAt.current = performance.now();
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clips.length, totalMs]);

  // what the clips do when pressed: read when it happens, so that a clip draws again only when what it shows changes
  const acts = useRef<TrackClipActs>(null!);
  acts.current = {
    xOf, slots, totalMs, pps, range, leaveTip, restPin, overClip, startPull, movePull, endPull, onSelect, onPick, onRange, onSeek, onMenu, onSoundMenu, onStop, onJoin,
    render: (c) => renderOf?.(c)?.run(),
  };

  return (
    <div ref={floor} data-designer-floor className="flex shrink-0 flex-col border-t border-line bg-panel select-none">
      <div className="flex">
        <div className="relative w-[64px] shrink-0 border-r border-line text-[11px] font-semibold text-ink-2" style={{ height: HEIGHT }}>
          <span className="absolute left-3" style={{ top: ROW.top + ROW.height / 2 - 8 }}>Video</span>
          <span className="absolute left-3" style={{ top: SOUND.top + 1 }}>Audio</span>
          <span className="absolute left-3" style={{ top: MUSIC.top + 3 }}>Music</span>
        </div>
        <div
          ref={scroller}
          className="relative min-w-0 grow overflow-x-auto overflow-y-hidden"
          onDragOver={(e) => hover(e, draggedOf(e) === "sound" ? null : { kind: "insert", index: clips.length })}
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
            <Playhead clock={clock} slots={slots} cursorMs={cursorMs} totalMs={totalMs} pps={pps} />
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
          // the keys and their words; the line said in full for a screen reader
          <span className="flex min-w-0 grow items-center gap-3.5 overflow-hidden text-[11.5px] whitespace-nowrap text-ink-3">
            <span className="sr-only">{hint}</span>
            {LEGEND.map((l) => <span key={l.words} aria-hidden className="flex shrink-0 items-center gap-1.5"><Keys keys={l.keys} size="sm" />{l.words}</span>)}
          </span>
        ) : (
          <span className={cx("min-w-0 grow truncate", dragging ? "font-semibold text-accent" : "text-ink-3")}>{hint}</span>
        )}
        <button type="button" aria-label="Zoom out" data-tip="Zoom out" data-tip-keys="-" onClick={() => zoomTo(Math.max(ZOOM.least, pps / ZOOM.step))} className="flex h-6 w-6 items-center justify-center rounded-md text-ink-2 hover:bg-hover hover:text-ink"><Minus size={13} /></button>
        <button type="button" aria-label="Zoom in" data-tip="Zoom in" data-tip-keys="=" onClick={() => zoomTo(Math.min(ZOOM.most, pps * ZOOM.step))} className="flex h-6 w-6 items-center justify-center rounded-md text-ink-2 hover:bg-hover hover:text-ink"><Plus size={13} /></button>
        <button type="button" data-tip="The whole video in view" data-tip-keys="Shift+Z" onClick={fitAll} className="h-6 rounded-md border border-line-strong px-2 font-semibold text-ink-2 hover:bg-hover hover:text-ink">Fit all</button>
      </div>
    </div>
  );
}
