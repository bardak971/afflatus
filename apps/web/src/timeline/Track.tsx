import { useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useQueries } from "@tanstack/react-query";
import { api } from "../api";
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

/** In and Out on the timeline, on the clock of what plays. */
export interface TimeRange {
  inMs: number;
  outMs: number;
}

/** How loud a sound is along a stretch of it, drawn behind the words of its row: -60 dB is the floor, 0 the top. */
function Wave({ sound, rate, fromMs, toMs }: { sound: number[] | null; rate: number; fromMs: number; toMs: number }) {
  if (!sound || sound.length < 2) return null;
  const step = 1000 / rate;
  const a = Math.max(0, Math.floor(fromMs / step));
  const b = Math.min(sound.length - 1, Math.ceil(toMs / step));
  const vals = sound.slice(a, b + 1).map((db) => Math.max(0, Math.min(1, (db + 60) / 60)));
  if (vals.length < 2) return null;
  const W = 200;
  const H = 10;
  const d = `M0 ${H} ${vals.map((v, i) => `L${((i / (vals.length - 1)) * W).toFixed(1)} ${(H - v * H).toFixed(2)}`).join(" ")} L${W} ${H} Z`;
  return (
    <svg aria-hidden className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <path d={d} fill="currentColor" opacity={0.3} />
    </svg>
  );
}

/** How far apart the ruler's labels are, in seconds: the first step that leaves them room. */
const stepFor = (pps: number) => [1, 2, 5, 10, 15, 30, 60, 120].find((s) => s * pps >= 58) ?? 300;

/**
 * The timeline itself: a ruler, the clips at their length with their own frames, each clip's sound,
 * and the music under all of it. Things are dragged onto it; a clip's edges shorten it.
 */
export function Track({ timeline, recipes, pps, onZoom, selected, musicSelected, time, cursorMs, running, busy, onStop, onSelect, onSelectMusic, onSeek, onMove, onInsert, onPin, onClipSound, onMusic, onTrim, onNewClip, onMenu, range, onRange, onRangeMenu, snapQuiet }: {
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
  /** A right-click on a clip: its menu. */
  onMenu?(clip: Clip, e: React.MouseEvent): void;
  /** In and Out, on the clock of what plays; null = no range. */
  range: TimeRange | null;
  onRange(range: TimeRange | null): void;
  /** A right-click on the range: its menu. */
  onRangeMenu?(e: React.MouseEvent): void;
  /** In and Out snap to quiet moments of the clips (their motion is measured once a range exists). */
  snapQuiet?: boolean;
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
      ? "Drag images, videos and audio here from the left. Click a clip to change it; drag its edges to trim it. I and O mark a range."
      : "Your clips will line up here, left to right, in the order they play."
    : !over
      ? dragging === "sound" ? "Drop it on a clip to replace its audio, or on the music track." : "Drop it on the timeline."
      : over.kind === "insert"
        ? `Drop to ${dragging === "clip" ? "move it" : dragging === "picture" ? "add this image as a still" : "insert it"} ${over.index === 0 ? "at the start" : over.index >= clips.length ? "at the end" : `between clip ${over.index} and clip ${over.index + 1}`}.`
        : over.kind === "pin"
          ? over.where === "mid" ? `Drop to make this image a keyframe of clip ${n(over.clip)} at ${over.atS} s.` : `Drop to make this image the ${over.where === "start" ? "first" : "last"} frame of clip ${n(over.clip)}.`
          : over.kind === "sound"
            ? `Drop to replace the audio of clip ${n(over.clip)}.`
            : "Drop to play it under the whole video.";
  const lineAt = over?.kind === "insert" ? (over.index < slots.length ? slots[over.index]!.left : end) : null;

  // ---- the playhead: click or drag on the ruler
  const scrub = (e: ReactPointerEvent) => {
    const x = xOf(e.clientX);
    onSeek(playAt(slots, x), Math.max(0, Math.min(totalMs, ((x - PAD) / pps) * 1000)));
  };

  // ---- the range: In and Out, swept on the ruler with Shift, or dragged by their brackets; they snap to cuts, to the playhead and to quiet moments
  const sweep = useRef<number | null>(null);
  const grab = useRef<"in" | "out" | null>(null);
  const playEnd = clips.reduce((sum, c) => sum + c.lengthMs, 0);
  // how much moves along each clip's take and how loud it is (and the sound files, and the music): measured once, kept
  const played = useMemo(() => slots.filter((s) => !s.planned && s.clip.take), [slots]);
  const measured = useMemo(() => {
    const ids = new Set<string>();
    for (const s of played) ids.add(s.clip.take!.asset.id);
    for (const c of clips) if (c.sound === "file" && c.soundAsset) ids.add(c.soundAsset.id);
    if (timeline.music) ids.add(timeline.music.asset.id);
    return [...ids];
  }, [played, clips, timeline.music]);
  const measures = useQueries({
    queries: measured.map((id) => ({ queryKey: ["motion", id], queryFn: () => api.motion(id), staleTime: Infinity, retry: 0 })),
  });
  const measureOf = (id: string | undefined) => (id ? measures[measured.indexOf(id)]?.data : undefined);
  /** The motion of what plays, per clip: samples along the clip's playing part, each 0..1 of the clip's own peak; its quiet moments and its pauses in the sound, on the clock of what plays. */
  const motion = useMemo(() => {
    return played.map((s) => {
      const m = measureOf(s.clip.take!.asset.id);
      const take = s.clip.take!;
      if (!m) return { slot: s, curve: [] as number[], quiet: [] as number[], pauses: [] as number[] };
      const step = 1000 / m.rate;
      const from = Math.floor(take.startMs / step);
      const quiet: number[] = [];
      let curve: number[] = [];
      if (m.values.length) {
        const to = Math.min(m.values.length - 1, Math.ceil(take.endMs / step));
        const raw = m.values.slice(from, to + 1);
        // smoothed over three samples, so that one odd frame is not a dip
        const smooth = raw.map((_v, k) => ((raw[k - 1] ?? raw[k]!) + raw[k]! + (raw[k + 1] ?? raw[k]!)) / 3);
        const peak = Math.max(1, ...smooth);
        const sorted = [...smooth].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
        for (let k = 1; k < smooth.length - 1; k++) {
          if (smooth[k]! <= smooth[k - 1]! && smooth[k]! < smooth[k + 1]! && smooth[k]! < median * 0.8) {
            const assetMs = (from + k) * step;
            if (assetMs > take.startMs + 100 && assetMs < take.endMs - 100) quiet.push(s.clip.atMs + (assetMs - take.startMs));
          }
        }
        curve = smooth.map((v) => v / peak);
      }
      // pauses: stretches of at least a quarter second well under the loud parts, between sounds (not the clip's silent ends)
      const pauses: number[] = [];
      if (m.sound && m.sound.length && s.clip.sound === "own") {
        const to = Math.min(m.sound.length - 1, Math.ceil(take.endMs / step));
        const db = m.sound.slice(from, to + 1);
        const loud = [...db].sort((a, b) => a - b)[Math.floor(db.length * 0.9)] ?? 0;
        const threshold = Math.min(loud - 20, -25);
        let run = -1;
        for (let k = 0; k <= db.length; k++) {
          const low = k < db.length && db[k]! < threshold;
          if (low && run < 0) run = k;
          if (!low && run >= 0) {
            if (k - run >= 3 && run > 0 && k < db.length) pauses.push(s.clip.atMs + ((from + (run + k) / 2) * step - take.startMs));
            run = -1;
          }
        }
      }
      return { slot: s, curve, quiet, pauses };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [played, measures]);
  const snapRange = (ms: number) => {
    const marks = [...slots.filter((s) => !s.planned).flatMap((s) => [s.clip.atMs, s.clip.atMs + s.clip.lengthMs]), time];
    let best = ms;
    let gap = 7 / pps * 1000;
    for (const m of marks) {
      const d = Math.abs(m - ms);
      if (d < gap) {
        gap = d;
        best = m;
      }
    }
    // a quiet moment or a pause in the sound within a third of a second wins over nothing, not over a cut or the playhead at hand
    if (snapQuiet !== false && best === ms) {
      let near = 334;
      for (const q of motion.flatMap((m) => [...m.quiet, ...m.pauses])) {
        const d = Math.abs(q - ms);
        if (d < near) {
          near = d;
          best = q;
        }
      }
    }
    return Math.max(0, Math.min(playEnd, best));
  };
  const xAt = (ms: number) => placeOf(slots, ms)?.x ?? null;
  const band = (() => {
    if (!range) return null;
    const a = xAt(range.inMs);
    const b = xAt(range.outMs);
    return a === null || b === null ? null : { a: Math.min(a, b), b: Math.max(a, b) };
  })();
  const grabHandle = (e: ReactPointerEvent, which: "in" | "out") => {
    e.stopPropagation();
    e.preventDefault();
    grab.current = which;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const moveHandle = (e: ReactPointerEvent) => {
    if (!grab.current || !range) return;
    const ms = snapRange(playAt(slots, xOf(e.clientX)));
    onRange(grab.current === "in" ? { inMs: Math.min(ms, range.outMs), outMs: range.outMs } : { inMs: range.inMs, outMs: Math.max(ms, range.inMs) });
  };
  const dropHandle = (e: ReactPointerEvent) => {
    grab.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
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

  /** The frame under the pointer on the ruler: which video, at what moment, and where to draw it. */
  const [peek, setPeek] = useState<{ x: number; ms: number; asset: string; at: number } | null>(null);
  const peekAt = useRef(0);
  const peekFrom = (clientX: number) => {
    const t = performance.now();
    if (t - peekAt.current < 60) return;
    peekAt.current = t;
    const x = xOf(clientX);
    const ms = playAt(slots, x);
    const slot = slots.find((s) => !s.planned && ms >= s.clip.atMs && ms < s.clip.atMs + s.clip.lengthMs && s.clip.take);
    if (!slot) return setPeek(null);
    setPeek({ x, ms, asset: slot.clip.take!.asset.id, at: slot.clip.take!.startMs + (ms - slot.clip.atMs) });
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
    <div data-designer-floor className="flex shrink-0 flex-col border-t border-line bg-panel select-none">
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
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
              setOver(null);
              setDragging(null);
            }
          }}
          onDrop={drop}
        >
          <div ref={inner} className="relative" style={{ width, height: HEIGHT }} onContextMenu={rangeMenuAt}>
            {/* the ruler: a click or a drag moves the playhead */}
            <div
              role="slider"
              aria-label="Move the playhead"
              aria-valuemin={0}
              aria-valuemax={Math.round(timeline.durationMs / 1000)}
              aria-valuenow={Math.round(time / 1000)}
              tabIndex={0}
              onPointerDown={(e) => {
                // the browser must not take this for the start of a text selection or of a drag
                e.preventDefault();
                e.currentTarget.setPointerCapture(e.pointerId);
                if (e.shiftKey) {
                  // Shift: a range is swept from here
                  const ms = snapRange(playAt(slots, xOf(e.clientX)));
                  sweep.current = ms;
                  onRange({ inMs: ms, outMs: ms });
                } else scrub(e);
              }}
              onPointerMove={(e) => {
                if (!e.currentTarget.hasPointerCapture(e.pointerId)) return peekFrom(e.clientX);
                setPeek(null);
                if (sweep.current === null) return scrub(e);
                const ms = snapRange(playAt(slots, xOf(e.clientX)));
                onRange({ inMs: Math.min(sweep.current, ms), outMs: Math.max(sweep.current, ms) });
              }}
              onPointerUp={(e) => {
                sweep.current = null;
                e.currentTarget.releasePointerCapture(e.pointerId);
              }}
              onPointerLeave={() => setPeek(null)}
              onDragStart={(e) => e.preventDefault()}
              className="absolute inset-x-0 top-0 cursor-ew-resize touch-none border-b border-line"
              style={{ height: RULER }}
              title="Click or drag: the playhead. Shift-drag: a range. Ctrl + wheel zooms, the wheel scrolls."
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
              const heard = c.kind === "still" || s.planned ? (c.sound === "file" ? c.soundAsset?.name || "Audio file" : "") : c.sound === "file" ? c.soundAsset?.name || "Audio file" : c.sound === "muted" ? "Muted" : video?.hasSound ? "Own audio" : "Silent";
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
                    // a clip that has its picture is read over it: the colours of the dark stage
                    data-stage={s.planned ? undefined : ""}
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
                            <span className="min-w-0 grow truncate font-semibold">{live ? phaseLabel(live.phase) : "Queued"}</span>
                            <button
                              type="button"
                              aria-label={live ? `Stop the render of clip ${s.index + 1}` : `Remove clip ${s.index + 1} from the queue`}
                              title={live ? "Stop render" : "Remove from queue"}
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
                    {/* pictures pinned to its start and its end */}
                    {opens && <img src={thumbUrl(opens)} alt="" title="First frame" draggable={false} className="absolute top-6 left-3.5 h-7 w-7 rounded border-2 border-picture object-cover" />}
                    {ends && <img src={thumbUrl(ends)} alt="" title="Last frame" draggable={false} className="absolute top-6 right-3.5 h-7 w-7 rounded border-2 border-picture object-cover" />}
                    {through && <img src={thumbUrl(through.asset)} alt="" title="Keyframe" draggable={false} className="absolute top-6 h-7 w-7 -translate-x-1/2 rounded border-2 border-picture object-cover" style={{ left: `${through.part * 100}%` }} />}
                    {pinned && <span aria-hidden className={cx("absolute inset-y-0 w-2 bg-accent", pinned === "start" ? "left-0" : pinned === "end" ? "right-0" : "left-1/2 -translate-x-1/2")} />}
                  </button>

                  {/* its edges: drag to shorten */}
                  {on && !s.planned && !c.job && (
                    <>
                      {c.kind === "video" && (
                        <span role="separator" aria-label="Drag to trim the start of the clip" title="Drag to trim the start" onPointerDown={(e) => startPull(e, s, "start")} onPointerMove={movePull} onPointerUp={endPull} onPointerCancel={endPull} className="absolute z-10 w-2.5 cursor-ew-resize rounded-l-lg bg-accent" style={{ left: s.left + 1, top: ROW.top, height: ROW.height }} />
                      )}
                      <span role="separator" aria-label="Drag to trim the end of the clip" title={c.kind === "still" ? "Drag to change the still's duration" : "Drag to trim the end"} onPointerDown={(e) => startPull(e, s, "end")} onPointerMove={movePull} onPointerUp={endPull} onPointerCancel={endPull} className="absolute z-10 w-2.5 cursor-ew-resize rounded-r-lg bg-accent" style={{ left: s.left + s.width - 11.5, top: ROW.top, height: ROW.height }} />
                    </>
                  )}

                  {/* how it starts: flowing on from the clip before, or a cut */}
                  {s.index > 0 && c.kind === "video" && (
                    <button
                      type="button"
                      onClick={() => onSelect(c.id)}
                      title={c.join === "stale" ? `Clip ${s.index + 1} no longer follows clip ${s.index}` : c.joined === "continue" ? (c.join === "fresh" ? `Extends clip ${s.index}` : `Will extend clip ${s.index}`) : "A cut"}
                      aria-label={c.join === "stale" ? `The join before clip ${s.index + 1} no longer holds` : c.joined === "continue" ? `The join before clip ${s.index + 1}: it extends clip ${s.index}` : `The join before clip ${s.index + 1}: a cut`}
                      style={{ left: s.left - 11, top: ROW.top + ROW.height / 2 - 11 }}
                      className={cx(
                        "absolute z-10 flex h-[22px] w-[22px] items-center justify-center rounded-full border",
                        c.join === "stale" ? "border-warn bg-warn text-warn-on" : c.joined === "continue" ? (c.join === "fresh" ? "border-accent bg-accent-wash text-accent" : "border-dashed border-accent bg-panel text-accent") : "border-line-strong bg-raised text-ink-3",
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

            {range && motion.map(({ slot: s, curve, quiet, pauses }) =>
              curve.length > 1 || pauses.length ? (
                <svg key={s.clip.id} aria-hidden className="pointer-events-none absolute top-0 z-[11] text-accent" style={{ left: s.left, width: s.width, height: RULER }} viewBox={`0 0 ${Math.max(1, s.width)} ${RULER}`} preserveAspectRatio="none">
                  {curve.length > 1 && <path d={`M0 ${RULER} ${curve.map((v, k) => `L${((k / (curve.length - 1)) * s.width).toFixed(1)} ${(RULER - 2 - v * (RULER - 5)).toFixed(1)}`).join(" ")} L${s.width} ${RULER} Z`} fill="currentColor" opacity={0.22} />}
                  {snapQuiet !== false && quiet.map((q) => <line key={q} x1={((q - s.clip.atMs) / s.clip.lengthMs) * s.width} x2={((q - s.clip.atMs) / s.clip.lengthMs) * s.width} y1={RULER - 6} y2={RULER - 1} stroke="currentColor" strokeWidth={1.5} opacity={0.7} />)}
                  {/* pauses in the sound: a tick of the sound's green */}
                  {snapQuiet !== false && pauses.map((q) => <line key={`p${q}`} x1={((q - s.clip.atMs) / s.clip.lengthMs) * s.width} x2={((q - s.clip.atMs) / s.clip.lengthMs) * s.width} y1={1} y2={7} className="text-good" stroke="currentColor" strokeWidth={1.5} opacity={0.9} />)}
                </svg>
              ) : null,
            )}
            {band && range && (
              <>
                <div aria-hidden className="pointer-events-none absolute top-0 z-[12] border-x-2 border-accent bg-accent/15" style={{ left: band.a - 1, width: Math.max(2, band.b - band.a + 2), height: HEIGHT - 4 }} />
                <span
                  role="slider"
                  aria-label="In"
                  aria-valuemin={0}
                  aria-valuemax={Math.round(playEnd / 1000)}
                  aria-valuenow={Math.round(range.inMs / 1000)}
                  title={`In ${stamp(range.inMs)}: drag it (I sets it at the playhead)`}
                  onPointerDown={(e) => grabHandle(e, "in")}
                  onPointerMove={moveHandle}
                  onPointerUp={dropHandle}
                  onPointerCancel={dropHandle}
                  className="absolute top-0 z-[16] flex w-2.5 cursor-ew-resize touch-none items-center justify-center rounded-l bg-accent font-mono text-[10px] font-bold leading-none text-accent-ink"
                  style={{ left: band.a - 10, height: RULER - 1 }}
                >
                  [
                </span>
                <span
                  role="slider"
                  aria-label="Out"
                  aria-valuemin={0}
                  aria-valuemax={Math.round(playEnd / 1000)}
                  aria-valuenow={Math.round(range.outMs / 1000)}
                  title={`Out ${stamp(range.outMs)}: drag it (O sets it at the playhead)`}
                  onPointerDown={(e) => grabHandle(e, "out")}
                  onPointerMove={moveHandle}
                  onPointerUp={dropHandle}
                  onPointerCancel={dropHandle}
                  className="absolute top-0 z-[16] flex w-2.5 cursor-ew-resize touch-none items-center justify-center rounded-r bg-accent font-mono text-[10px] font-bold leading-none text-accent-ink"
                  style={{ left: band.b, height: RULER - 1 }}
                >
                  ]
                </span>
              </>
            )}
            {peek && (
              <div aria-hidden className="pointer-events-none absolute z-30 flex flex-col items-center gap-0.5" style={{ left: Math.max(PAD, Math.min(width - 130, peek.x - 60)), top: RULER + 4 }}>
                <img src={`/api/assets/${peek.asset}/peek?at=${Math.round(peek.at)}&h=120`} alt="" className="max-h-[120px] max-w-[120px] rounded-md border border-line-strong bg-black object-contain shadow-xl shadow-shade/40" />
                <span className="rounded bg-ground/90 px-1.5 font-mono text-[10px] text-ink">{stamp(peek.ms)}</span>
              </div>
            )}
            {lineAt !== null && <div aria-hidden className="pointer-events-none absolute z-20 w-[3px] rounded bg-accent" style={{ left: lineAt - 1.5, top: ROW.top - 2, height: ROW.height + 4 }} />}
            {head && (
              <div aria-hidden className="pointer-events-none absolute top-0 z-20" style={{ left: head.x - 1, height: HEIGHT - 4 }}>
                <div className="h-full w-0.5 bg-ink-strong" />
                <div className="absolute -top-px -left-[5px] h-2.5 w-3 rounded-b bg-ink-strong" />
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
