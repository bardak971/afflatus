import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Minus, Music, Plus } from "lucide-react";
import type { Clip, RecipeInfo, RunningJob, Timeline } from "../api";
import { Kbd } from "../Keys";
import { cx } from "../ui";
import { layout, NEW_CLIP, PAD, placeOf, roomOf, ZOOM, type ShownPatch, type Slot } from "./model";
import type { Clock } from "./clock";
import { ClipTip } from "./ClipTip";
import { FramePeek } from "./track/FramePeek";
import type { PinPlace } from "./track/peek";
import { PinPeek, type PinOver } from "./track/PinPeek";
import { Playhead } from "./track/Playhead";
import { HEIGHT, MUSIC, ROW, SOUND } from "./track/rows";
import { TrackClip, type Stretch } from "./track/TrackClip";
import { TrackRuler } from "./track/TrackRuler";
import { useMotionMarks } from "./track/useMotionMarks";
import { LEGEND, useTrackDrop } from "./track/useTrackDrop";
import { Wave } from "./track/Wave";

/** How long the pointer rests on a clip before its tooltip shows; on a pinned picture, before its card shows. */
const TIP_AFTER_MS = 1000;
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
export function Track({ timeline, recipes, pps, onZoom, selected, musicSelected, clock, cursorMs, running, busy, onStop, onSelect, picked, onPick, onUpload, onSelectMusic, onSeek, onMove, onInsert, onPin, onClipSound, onMusic, onTrim, onNewClip, onMenu, onSoundMenu, onMusicMenu, onJoin, range, onRange, onRangeMenu, snapQuiet, renderOf }: {
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
  running: RunningJob | null;
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
  /** The join dot before a clip was clicked: it extends the clip before, or is a cut. */
  onJoin?(clip: Clip, joined: "continue" | "cut"): void;
  /** In and Out, on the clock of what plays; null = no range. */
  range: TimeRange | null;
  onRange(range: TimeRange | null): void;
  /** A right-click on the range: its menu. */
  onRangeMenu?(e: React.MouseEvent): void;
  /** In and Out snap to quiet moments of the clips (their motion is measured once a range exists). */
  snapQuiet?: boolean;
}) {
  const clips = timeline.clips;
  const floor = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  /** An edge being dragged: the clip, which edge, and the length it has for now. */
  const [stretch, setStretch] = useState<Stretch | null>(null);
  /** The clip whose tooltip shows, and where; the timer that is counting towards showing one. */
  const [tip, setTip] = useState<{ clip: string; left: number; top: number } | null>(null);
  const tipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restOn = (id: string, el: HTMLElement) => {
    if (tipTimer.current) clearTimeout(tipTimer.current);
    tipTimer.current = setTimeout(() => {
      const r = el.getBoundingClientRect();
      setTip({ clip: id, left: r.left, top: r.bottom });
    }, TIP_AFTER_MS);
  };
  /** The pinned picture whose card shows (PinPeek), and the timer counting towards showing one. */
  const [pinOver, setPinOver] = useState<PinOver | null>(null);
  const pinTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restPin = (clip: string, where: PinPlace | null, el?: HTMLImageElement) => {
    if (pinTimer.current) clearTimeout(pinTimer.current);
    pinTimer.current = null;
    if (!where || !el) return setPinOver(null);
    pinTimer.current = setTimeout(() => setPinOver({ clip, where, el }), PIN_AFTER_MS);
  };
  // a press, a drag or leaving the clip puts both away
  const leaveTip = () => {
    if (tipTimer.current) clearTimeout(tipTimer.current);
    if (pinTimer.current) clearTimeout(pinTimer.current);
    tipTimer.current = pinTimer.current = null;
    setTip(null);
    setPinOver(null);
  };
  useEffect(() => () => {
    if (tipTimer.current) clearTimeout(tipTimer.current);
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
    if (totalMs > 0) onZoom(Math.max(ZOOM.least, Math.min(ZOOM.most, room / (totalMs / 1000))));
  };
  // arriving on a timeline, the whole of it is in view; zooming after that is the person's
  const fittedFor = useRef<string | null>(null);
  useEffect(() => {
    if (totalMs <= 0 || fittedFor.current === timeline.id) return;
    fittedFor.current = timeline.id;
    const id = requestAnimationFrame(fitAll);
    return () => cancelAnimationFrame(id);
    // once per timeline, when its length is known
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeline.id, totalMs]);
  // a clip added (New clip, a drop, a continuation): the whole timeline in view again, the new clip with it
  // (kept asked for until it has run: the new clip's length may settle a render later)
  // the new clip's panel opens beside the track as it is added and narrows it: a fit just made is made again for the new width
  const fittedAt = useRef(0);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let width = el.clientWidth;
    const seen = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      if (performance.now() - fittedAt.current < 1500) fitAll();
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

            {/* a pinned picture's card says more about that spot than the clip's tooltip: the tooltip waits */}
            {tip && !pinOver && (() => {
              const i = clips.findIndex((c) => c.id === tip.clip);
              return i >= 0 ? <ClipTip clip={clips[i]!} index={i} clips={clips} at={tip} /> : null;
            })()}
            {slots.map((s) => (
              <TrackClip
                key={s.clip.id}
                s={s}
                clips={clips}
                timeline={timeline}
                recipes={recipes}
                selected={selected}
                picked={picked}
                running={running}
                stretch={stretch}
                over={over}
                range={range}
                slots={slots}
                totalMs={totalMs}
                pps={pps}
                xOf={xOf}
                measureOf={measureOf}
                restOn={restOn}
                leaveTip={leaveTip}
                pinOn={pinOver?.clip === s.clip.id ? pinOver.where : null}
                restPin={restPin}
                overClip={overClip}
                startPull={startPull}
                movePull={movePull}
                endPull={endPull}
                onSelect={onSelect}
                onPick={onPick}
                onRange={onRange}
                onSeek={onSeek}
                onMenu={onMenu}
                onSoundMenu={onSoundMenu}
                onStop={onStop}
                renderOf={renderOf}
                onJoin={onJoin}
              />
            ))}

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
              onContextMenu={(e) => onMusicMenu?.(e)}
              aria-label={timeline.music ? `Music: ${timeline.music.asset.name || "an audio file"}` : "Music: none. Drop an audio file here."}
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
              {timeline.music && <Wave sound={measureOf(timeline.music.asset.id)?.sound ?? null} rate={measureOf(timeline.music.asset.id)?.rate ?? 10} fromMs={0} toMs={Math.min(totalMs, timeline.music.asset.durationMs || totalMs)} />}
              <Music size={11} className="relative shrink-0" />
              <span className="relative truncate">{timeline.music ? timeline.music.asset.name || "Music" : "Drop an audio file here to play it under the whole video"}</span>
            </button>

            {lineAt !== null && <div aria-hidden className="pointer-events-none absolute z-20 w-[3px] rounded bg-accent" style={{ left: lineAt - 1.5, top: ROW.top - 2, height: ROW.height + 4 }} />}
            <Playhead clock={clock} slots={slots} cursorMs={cursorMs} totalMs={totalMs} pps={pps} />
            <FramePeek area={inner} floor={floor} slots={slots} recipes={recipes} pps={pps} totalMs={totalMs} paused={Boolean(pinOver || stretch || dragging)} />
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
            {LEGEND.map((l) => <span key={l.words} aria-hidden className="flex shrink-0 items-center gap-1.5">{l.keys.map((k) => <Kbd key={k}>{k}</Kbd>)}{l.words}</span>)}
          </span>
        ) : (
          <span className={cx("min-w-0 grow truncate", dragging ? "font-semibold text-accent" : "text-ink-3")}>{hint}</span>
        )}
        <button type="button" aria-label="Zoom out" data-tip="Zoom out" onClick={() => onZoom(Math.max(ZOOM.least, pps / 1.3))} className="flex h-6 w-6 items-center justify-center rounded-md text-ink-2 hover:bg-hover hover:text-ink"><Minus size={13} /></button>
        <button type="button" aria-label="Zoom in" data-tip="Zoom in" onClick={() => onZoom(Math.min(ZOOM.most, pps * 1.3))} className="flex h-6 w-6 items-center justify-center rounded-md text-ink-2 hover:bg-hover hover:text-ink"><Plus size={13} /></button>
        <button type="button" onClick={fitAll} className="h-6 rounded-md border border-line-strong px-2 font-semibold text-ink-2 hover:bg-hover hover:text-ink">Fit all</button>
      </div>
    </div>
  );
}
