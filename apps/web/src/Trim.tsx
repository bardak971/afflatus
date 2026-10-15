import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Clapperboard, Gauge, Link2, Pause, Play, Repeat, Scissors, Split, X, ZoomIn, ZoomOut } from "lucide-react";
import { stripUrl, type Asset } from "./api";
import { clock, plural } from "./format";
import { Kbd } from "./Keys";
import { Select } from "./Select";
import { Button, cx } from "./ui";
import { useSettled } from "./hooks";
import { frameSpan, stepFrames } from "./frameStep";
import { stamp, STRIP_FRAMES, type Range } from "./trim/range";
import { Strip, type Hover } from "./trim/Strip";
import { useFrameLoop } from "./trim/useFrameLoop";
import { usePeek } from "./trim/usePeek";
import { useTrimKeys } from "./trim/useTrimKeys";
import { useWheelZoom } from "./trim/useWheelZoom";
import { CutButtons } from "./trim/CutButtons";

export type { Range } from "./trim/range";

/** Where the cut's quality is remembered, per browser. */
const CRF_KEY = "afflatus.cut.crf";
const CRFS = [
  { value: "10", label: "CRF 10 · near-lossless", note: "large file" },
  { value: "16", label: "CRF 16 · very good", note: "half the size" },
  { value: "23", label: "CRF 23 · web", note: "small" },
];
const cutCrf = (): number => {
  try {
    return Number(localStorage.getItem(CRF_KEY) ?? 10) || 10;
  } catch {
    return 10;
  }
};

/** The frames at in and at out, large enough to judge, beside the video while trimming. Asked for once the handles settle. */
export function RangeFrames({ asset, range }: { asset: Asset; range: Range }) {
  const shown = useSettled(range, 220);
  return (
    <div className="flex h-full min-h-0 w-[22%] max-w-[260px] min-w-[120px] shrink-0 flex-col justify-center gap-2" onClick={(e) => e.stopPropagation()}>
      {[{ label: "In", at: shown.startMs }, { label: "Out", at: shown.endMs }].map((f) => (
        <div key={f.label} className="flex min-h-0 flex-1 flex-col gap-1">
          <span className="text-[11px] font-semibold text-ink-2">{f.label} <span className="font-mono font-normal">{stamp(f.at)}</span></span>
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg border border-line bg-raised">
            <img src={`/api/assets/${asset.id}/peek?at=${Math.round(f.at)}&h=480`} alt="" className="max-h-full max-w-full object-contain" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The Trim mode of a video: a filmstrip of the whole video with the playhead and an in and an out handle,
 * a second strip of the part zoomed into (down to one tile per frame), a picture of the exact frame
 * under the mouse, and what can be done with the range. The `<video>` is the viewer's own; this takes
 * it over (its native controls are off while trimming). Keys: I / O set in and out on the frame shown (in on it,
 * out after it), , and . step one frame, ← and → too (Shift: ten), L loops the range, Space plays, Home / End, Z zooms
 * to the range (useTrimKeys). The In and Out handles take the arrows too, a frame at a time (Shift: ten). Its parts are
 * in trim/: the strips (Strip), the playhead's loop (useFrameLoop), the frame under the mouse (usePeek), the wheel's zoom.
 */
export function Trim({ asset, player, busy, initial, actions, compact, onCopy, onSplit, onRemove, onSlow, onBetween, onExtendHere, onRange, scenes, onEveryScene, onClose }: {
  asset: Asset;
  player: RefObject<HTMLVideoElement | null>;
  busy?: boolean;
  /** The range to start on (a timeline clip: what plays of its take); the whole video otherwise. */
  initial?: Range;
  /** A host's own action row (the timeline's), in place of the library's. */
  actions?(ctx: { range: Range; at: number; crf: number; whole: boolean }): ReactNode;
  /** Less tall, where the video above needs the room (the timeline). */
  compact?: boolean;
  onCopy?(range: Range, crf: number): void;
  onSplit?(range: Range, crf: number): void;
  onRemove?(range: Range, crf: number): void;
  /** The range slowed down ×2 or ×4, as a new video (RIFE on the GPU when ComfyUI has it, else ffmpeg). */
  onSlow?(range: Range, factor: 2 | 4): void;
  /** A new clip from the frame at in to the frame at out. */
  onBetween?(range: Range): void;
  /** A new clip that starts at the playhead's moment. */
  onExtendHere?(atMs: number): void;
  /** The range as it stands, for whoever shows its frames. */
  onRange?(range: Range): void;
  /** Where the video cuts between shots (moments), shown as marks; and every shot copied out as its own video. */
  scenes?: number[];
  onEveryScene?(cuts: number[], crf: number): void;
  onClose(): void;
}) {
  const duration = asset.durationMs ?? 0;
  const fps = asset.fps && asset.fps > 0 ? asset.fps : 24;
  const frameMs = 1000 / fps;
  const [range, setRange] = useState<Range>(initial ? { startMs: Math.max(0, initial.startMs), endMs: Math.min(duration, initial.endMs) } : { startMs: 0, endMs: duration });
  const [at, setAt] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [looping, setLooping] = useState(false);
  const [crf, setCrf] = useState(String(cutCrf()));
  // the part zoomed into: null is the whole video
  const [zoom, setZoom] = useState<Range | null>(null);
  // the exact frame under the mouse, on either strip
  const [hover, setHover] = useState<Hover | null>(null);
  const peek = usePeek(hover?.ms);
  const dragging = useRef<"in" | "out" | "head" | null>(null);
  useEffect(() => { onRange?.(range); }, [range]); // eslint-disable-line react-hooks/exhaustive-deps -- the parent's callback is told when the range changes, not when it is passed anew
  const seek = useCallback((ms: number) => {
    const v = player.current;
    const to = Math.max(0, Math.min(duration, ms));
    if (v) v.currentTime = to / 1000;
    setAt(to);
  }, [player, duration]);

  // the playhead follows the video, frame by frame
  useFrameLoop(player, looping, range, { setAt, setPlaying });

  const zoomTo = useCallback((win: Range | null) => {
    if (!win) return setZoom(null);
    const least = Math.min(duration, STRIP_FRAMES * frameMs);
    let a = Math.max(0, win.startMs);
    let b = Math.min(duration, win.endMs);
    if (b - a < least) { const mid = (a + b) / 2; a = Math.max(0, mid - least / 2); b = Math.min(duration, a + least); a = Math.max(0, b - least); }
    if (a <= 0 && b >= duration) return setZoom(null);
    setZoom({ startMs: a, endMs: b });
  }, [duration, frameMs]);

  /** The range with room on both sides: zoomed to, its two handles show inside the strip, not on its edges. */
  const roomy = useCallback((r: Range): Range => {
    const pad = Math.max((r.endMs - r.startMs) * 0.08, 4 * frameMs);
    return { startMs: r.startMs - pad, endMs: r.endMs + pad };
  }, [frameMs]);

  /** Loop on: from the range's start when the playhead is outside it, and playing. Loop off: the video goes on. */
  const toggleLoop = () => {
    const v = player.current;
    if (looping) { setLooping(false); return; }
    setLooping(true);
    if (!v) return;
    if (at < range.startMs - 1 || at > range.endMs - frameMs) seek(range.startMs + frameMs / 2);
    if (v.paused) void v.play();
  };

  const root = useRef<HTMLDivElement>(null);
  useTrimKeys({ root, player, duration, fps, frameMs, at, range, zoom, setRange, seek, zoomTo, roomy, toggleLoop, onClose });
  const length = range.endMs - range.startMs;
  const frames = Math.round(length / frameMs);
  const whole = range.startMs <= 0 && range.endMs >= duration;
  const choose = (v: string) => {
    setCrf(v);
    try { localStorage.setItem(CRF_KEY, v); } catch { /* nowhere to remember it */ }
  };
  const crfN = Number(crf) || 10;
  const moveIn = (ms: number) => setRange((r) => ({ startMs: Math.max(0, Math.min(ms, r.endMs - frameMs)), endMs: r.endMs }));
  const moveOut = (ms: number) => setRange((r) => ({ startMs: r.startMs, endMs: Math.min(duration, Math.max(ms, r.startMs + frameMs)) }));
  /** The picture of the frame that starts at a frame's edge on a strip: a seek to the edge itself can show the one before. */
  const showFrom = (edge: number) => seek(Math.min(duration, edge + frameMs / 2));
  const zoomFrames = zoom ? Math.min(STRIP_FRAMES, Math.max(2, Math.ceil((zoom.endMs - zoom.startMs) / frameMs))) : 0;
  const exact = zoom ? (zoom.endMs - zoom.startMs) / frameMs <= STRIP_FRAMES + 0.5 : false;
  const wholeSrc = useMemo(() => `${stripUrl(asset.id)}&frames=${Math.min(STRIP_FRAMES, Math.max(16, Math.round(duration / 1000)))}&height=48`, [asset.id, duration]);
  // the strip of the zoomed part is asked for once the zoom has settled: a wheel gesture is many small steps
  const settled = useSettled(zoom, 160);
  // out of the zoom at once
  const settledZoom = zoom ? settled : null;
  const zoomSrc = useMemo(() => {
    if (!settledZoom) return "";
    const n = Math.min(STRIP_FRAMES, Math.max(2, Math.ceil((settledZoom.endMs - settledZoom.startMs) / frameMs)));
    return `${stripUrl(asset.id)}&frames=${n}&height=64&from=${Math.round(settledZoom.startMs)}&to=${Math.round(settledZoom.endMs)}`;
  }, [asset.id, settledZoom, frameMs]);

  // the wheel on a strip zooms around the moment under the mouse
  const wheelTargets = useWheelZoom(duration, zoom, zoomTo);
  /** One strip: the whole video, or the part zoomed into. */
  const bar = (win: Range, kind: "whole" | "zoom", src: string, tall: boolean) => (
    <Strip
      key={kind} assetId={asset.id} win={win} kind={kind} src={src} tall={tall} compact={compact} range={range} at={at} zoom={zoom} settledZoom={settledZoom}
      scenes={scenes} hover={hover} peek={peek} dragging={dragging} duration={duration} frameMs={frameMs} player={player}
      moveIn={moveIn} moveOut={moveOut} showFrom={showFrom} setHover={setHover} placed={(el) => { wheelTargets.current[kind] = el; }}
    />
  );

  return (
    <div ref={root} className={cx("flex w-full shrink-0 flex-col rounded-xl border border-line-strong bg-panel", compact ? "gap-1.5 p-2" : "gap-2 p-3")} onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-2 text-xs text-ink-2">
        <Scissors size={14} className="text-accent" />
        <span className="font-semibold text-ink">Trim</span>
        <span className="font-mono">in {stamp(range.startMs)} · out {stamp(range.endMs)} · {(length / 1000).toFixed(2)} s · {plural(frames, "frame")}</span>
        <span className="grow" />
        <span className="font-mono">{stamp(at)} / {clock(duration)}</span>
        <button type="button" aria-label="Leave Trim" data-tip="Leave Trim (Esc)" onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-hover hover:text-ink"><X size={14} /></button>
      </div>

      {/* the whole video; under it, the part zoomed into */}
      {bar({ startMs: 0, endMs: duration }, "whole", wholeSrc, !zoom)}
      {zoom && (
        <div className="flex flex-col gap-1">
          {bar(zoom, "zoom", zoomSrc, true)}
          <span className="font-mono text-[11px] text-ink-3">{stamp(zoom.startMs)} – {stamp(zoom.endMs)} · {exact ? "one tile per frame" : `${Math.round((zoom.endMs - zoom.startMs) / frameMs / zoomFrames)} frames per tile`} · wheel to zoom, Z to leave</span>
        </div>
      )}

      {/* two rows of groups, each group kept whole when the room runs out (a group wraps, never one button of it):
          the playhead and the range with what makes a new clip from them; then what is cut out of the video. The
          frame at the playhead is Save frame (G), which the viewer's own list keeps while Trim is open */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Button size="sm" tone={playing ? "primary" : "plain"} aria-pressed={playing} aria-label="Play / pause" onClick={() => { const v = player.current; if (!v) return; if (v.paused) void v.play(); else v.pause(); }} data-tip="Play / pause (Space)">{playing ? <Pause size={13} /> : <Play size={13} />}</Button>
        <div role="group" aria-label="Range" className="flex items-center gap-1">
          <Button size="sm" onClick={() => moveIn(frameSpan(at, fps).startMs)} data-tip="Set in on the frame shown">In <Kbd>I</Kbd></Button>
          <Button size="sm" onClick={() => moveOut(frameSpan(at, fps).endMs)} data-tip="Set out after the frame shown">Out <Kbd>O</Kbd></Button>
        </div>
        <div role="group" aria-label="Frames" className="flex items-center gap-1">
          <Button size="sm" aria-label="One frame back" onClick={() => { player.current?.pause(); seek(stepFrames(at, -1, fps, duration)); }} data-tip="One frame back (Shift + ←: ten)"><Kbd>,</Kbd></Button>
          <Button size="sm" aria-label="One frame forward" onClick={() => { player.current?.pause(); seek(stepFrames(at, 1, fps, duration)); }} data-tip="One frame forward (Shift + →: ten)"><Kbd>.</Kbd></Button>
          <Button size="sm" tone={looping ? "primary" : "plain"} aria-pressed={looping} onClick={toggleLoop} data-tip={looping ? "Stop looping (the video goes on playing)" : "Loop the range"}><Repeat size={13} /> Loop <Kbd>L</Kbd></Button>
          {/* one label whether zoomed or not, so that the row does not move when it is pressed */}
          <Button size="sm" tone={zoom ? "primary" : "plain"} aria-pressed={Boolean(zoom)} onClick={() => zoomTo(zoom ? null : roomy(range))} data-tip={zoom ? "Back to the whole video" : "Zoom into the range: a second strip, down to one tile per frame. The mouse wheel on a strip zooms too."}>{zoom ? <ZoomOut size={13} /> : <ZoomIn size={13} />} Zoom <Kbd>Z</Kbd></Button>
        </div>
        {!actions && (onBetween || onExtendHere) && (
          <>
            <span className="grow" />
            <div role="group" aria-label="New clip" className="flex items-center gap-1">
              {onBetween && <Button size="sm" disabled={busy} data-tip="A new clip from the frame at in to the frame at out, on the video model used last: first frame, last frame, duration = the range." onClick={() => onBetween(range)}><Clapperboard size={13} /> Generate between</Button>}
              {onExtendHere && <Button size="sm" disabled={busy} data-tip="A new clip that starts at the playhead's moment (H3 carries the motion on from there; the others open on that frame). Extend (C) carries on from the end instead." onClick={() => onExtendHere(at)}><Link2 size={13} /> Extend from here</Button>}
            </div>
          </>
        )}
      </div>

      {actions ? (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-line pt-2">
          {actions({ range, at, crf: crfN, whole })}
          <span className="grow" />
          <div className="w-44">
            <Select size="sm" className="h-8" label="Quality of the cut" value={crf} onChange={choose} options={CRFS} />
          </div>
        </div>
      ) : (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-line pt-2">
        <div role="group" aria-label="Cut and scenes" className="flex items-center gap-1">
          <CutButtons what="video" busy={Boolean(busy)} whole={whole} edge={range.startMs <= 0 || range.endMs >= duration} onCopy={() => onCopy?.(range, crfN)} onSplit={() => onSplit?.(range, crfN)} onRemove={() => onRemove?.(range, crfN)} />
          {onEveryScene && scenes && scenes.length > 0 && (
            <Button size="sm" disabled={busy} data-tip={`${scenes.length + 1} shots found by their cuts: each copied out as its own video. This one stays.`} onClick={() => onEveryScene(scenes, crfN)}><Split size={13} /> Extract scenes ({scenes.length + 1})</Button>
          )}
          <div className="w-44">
            <Select size="sm" className="h-8" label="Quality of the cut" value={crf} onChange={choose} options={CRFS} />
          </div>
        </div>
        {onSlow && (
          <div role="group" aria-label="Slow motion" className="flex items-center gap-1">
            <Button size="sm" disabled={busy} data-tip="The range at half speed, as a new video, its sound slowed with it (pitch kept): RIFE on the GPU through the queue when ComfyUI has it, else ffmpeg's motion interpolation on the processor, which is slow." onClick={() => onSlow(range, 2)}><Gauge size={13} /> Slow ×2</Button>
            <Button size="sm" disabled={busy} data-tip="The range at a quarter speed, as a new video, its sound slowed with it." onClick={() => onSlow(range, 4)}><Gauge size={13} /> Slow ×4</Button>
          </div>
        )}
      </div>
      )}
    </div>
  );
}
