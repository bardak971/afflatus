import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, fileUrl, type Asset, type RemovedPart } from "../api";
import { clock } from "../format";
import { queryKeys } from "../queryKeys";
import { cx } from "../ui";
import type { PlayerHandle } from "./Player";
import { partAt, type RecordingPlace } from "./recordingPlace";
import { removedSaid } from "./track/RemovedMark";
import { useViewOf, type TrackView, type ViewStore } from "./track/useTrackView";

/** How many bars the stage's waveform has at most: about one every 5 px of a wide stage (fewer on a short stretch: one a measure). */
const BARS = 180;
/** The shortest stretch the stage shows, however far the track is zoomed in. */
const LEAST_MS = 2000;
/** A pause the recording was cut at: its middle within this of where a part ends. */
const AT_A_CUT_MS = 150;

/**
 * A recording open on the stage (its band on the Audio row clicked), as the source lane opens: its sound played and
 * scrubbed with the timeline's own transport, the playhead following it in the track's own time. Drawn as a big waveform
 * from the loudness the server keeps (GET /assets/:id/motion), with its clips' parts named (the one under the playhead in
 * the accent), the pauses it was cut at (those not used faint), its In and Out (dimmed outside them), and, when the clip
 * under the playhead has a take, that take's picture faint behind it, in step, to check the mouth against the words.
 */
export const RecordingStage = forwardRef<PlayerHandle, {
  recording: Asset;
  place: RecordingPlace;
  playing: boolean;
  onPlaying(playing: boolean): void;
  /** Where it stands, in the track's own time. */
  onTime(ms: number): void;
  /** Where a range playing alone ends, said the frame it is reached (usePlayhead's, as the Player's frame loop reads it). */
  stopAt?: () => number | null;
  /** Where the playhead stood when the stage turned to the recording, in the track's own time. */
  startAt: number;
  master?: number;
  /** The stretch the track shows: the stage shows the same stretch of the recording (all of it when the track shows all its clips). */
  view?: ViewStore;
  /** The parts cut out of its middle by removing their clips (card #75): drawn where the track jumps over them. */
  removed?: RemovedPart[];
}>(function RecordingStage({ recording, place, playing, onPlaying, onTime, stopAt, startAt, master = 1, view, removed = [] }, ref) {
  const el = useRef<HTMLAudioElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [local, setLocal] = useState(() => place.toRecording(startAt));
  const placeNow = useRef(place);
  placeNow.current = place;
  const length = place.lengthMs;
  /** The recording put at a moment of it (ms of the recording), the playhead with it. Never before the moment heard at the
   * track's start: with its first clip opening the timeline and In trimmed in, what lies before In plays before 0 on the
   * track, and the playhead put there said 0:00 while the stage said the moment clicked. */
  const put = (ms: number) => {
    const at = Math.max(earliestOf(placeNow.current), Math.min(placeNow.current.lengthMs, ms));
    if (el.current) el.current.currentTime = at / 1000;
    setLocal(at);
    onTime(placeNow.current.toTrack(at));
  };
  useImperativeHandle(ref, () => ({
    seek: (trackMs: number) => put(placeNow.current.toRecording(trackMs)),
    fullscreen() {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
      else void box.current?.requestFullscreen().catch(() => {});
    },
    // a moment of the recording is no clip's frame: Save frame and Extend have nothing to act on here
    where: () => null,
  }));
  // the playhead stands on the recording from the start: the moment of it heard where it was
  useEffect(() => {
    onTime(place.toTrack(local));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- once, as the stage turns to the recording
  // its clips made anew (a trim, a cut): the playhead follows the moment heard to where it now plays. Only when that moved:
  // the place is made anew on every read of the timeline (a take landing), and following it then took the playhead back
  // from where it was put, in a clip's tail, to the end of its part
  const placeBefore = useRef(place);
  useEffect(() => {
    const before = placeBefore.current;
    placeBefore.current = place;
    const moved = place.toTrack(local);
    if (!playing && before !== place && Math.abs(moved - before.toTrack(local)) > 0.5) onTime(moved);
  }, [place]); // eslint-disable-line react-hooks/exhaustive-deps -- when the parts move under it
  // played with the transport: the waveform's head on every frame, the playhead as the Player says it (at most 15 times a
  // second, but the frame a range's Out is reached: card #55)
  useEffect(() => {
    const a = el.current;
    if (!a) return;
    if (!playing) {
      a.pause();
      return;
    }
    // played again from the end: from the first moment heard on the track, not the recording's 0 (before the track's start
    // when the first clip opens the timeline and In is trimmed in)
    if (a.currentTime * 1000 >= length - 40) a.currentTime = earliestOf(placeNow.current) / 1000;
    void a.play().catch(() => onPlaying(false));
    let id = 0;
    let said = 0;
    const tick = (now: number) => {
      const ms = a.currentTime * 1000;
      const track = placeNow.current.toTrack(ms);
      setLocal(ms);
      const out = stopAt?.() ?? null;
      if (now - said > 66 || (out !== null && track >= out - 15)) {
        said = now;
        onTime(track);
      }
      if (a.ended) {
        onTime(track);
        onPlaying(false);
      } else id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [playing, length]); // eslint-disable-line react-hooks/exhaustive-deps -- the loop starts again only when what plays changes
  useEffect(() => {
    if (el.current) el.current.volume = Math.max(0, Math.min(1, master));
  }, [master]);

  const motion = useQuery({ queryKey: queryKeys.motion(recording.id), queryFn: () => api.motion(recording.id), staleTime: Infinity, retry: 0 });
  const pauses = useQuery({ queryKey: queryKeys.pauses(recording.id), queryFn: () => api.pauses(recording.id), staleTime: Infinity, retry: 0 });
  // the stretch shown: as the track is zoomed and scrolled, the same stretch of the recording
  const shown = stretchOf(place, useViewOf(view));
  const span = shown.toMs - shown.fromMs;
  const top = useMemo(() => loudestOf(motion.data?.sound), [motion.data?.sound]);
  // kept between frames: while it plays the stage draws again on every frame (the moment heard), the bars only when the
  // stretch shown or the loudness change
  const wave = useMemo(() => barsIn(motion.data?.sound, motion.data?.rate ?? 0, top, shown), [motion.data?.sound, motion.data?.rate, top, shown.fromMs, shown.toMs]); // eslint-disable-line react-hooks/exhaustive-deps -- the stretch by its two ends, made anew on every draw
  const path = useMemo(() => wave?.bars.map((v, i) => `M${i * 3} ${(1 - v) * 50}h2v${v * 100}h-2z`).join("") ?? "", [wave]);
  // where a moment of the recording is across the stretch shown, unclamped: what lies outside it is cut off at the stage's
  // sides. No length (old clips with no recordingSeconds, the recording's own not read yet): everything at the start, never NaN%
  const ratio = (ms: number) => (span > 0 ? (ms - shown.fromMs) / span : 0);
  const share = (ms: number) => `${ratio(ms) * 100}%`;
  const shareIn = (ms: number) => `${Math.max(0, Math.min(1, ratio(ms))) * 100}%`;
  const sizeOf = (ms: number) => `${span > 0 ? (ms / span) * 100 : 0}%`;
  // the pauses it was cut at: where a part ends and the next one starts; the others are pauses it was not cut at
  const marks = useMemo(() => {
    const cuts = place.parts.slice(0, -1).map((p) => p.endMs);
    return [
      ...cuts.map((ms) => ({ ms, used: true })),
      ...(pauses.data?.pauses ?? []).map((p) => ((p.start + p.end) / 2) * 1000).filter((ms) => ms < length && !cuts.some((c) => Math.abs(c - ms) < AT_A_CUT_MS)).map((ms) => ({ ms, used: false })),
    ];
  }, [place, pauses.data, length]);
  const now = partAt(place, local);
  // the clip under the playhead and its take, if it has one: its picture behind the waveform, in step with the sound
  const trackNow = place.toTrack(local);
  const under = place.parts.find((p) => trackNow >= p.clipFromMs && trackNow < p.clipToMs) ?? now;
  const take = under?.clip.take ?? null;
  const takeAt = take && under ? (take.startMs + (trackNow - under.clipFromMs)) / 1000 : 0;
  const pic = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = pic.current;
    if (!v || !take) return;
    if (playing) {
      if (v.paused) void v.play().catch(() => {});
      if (Math.abs(v.currentTime - takeAt) > 0.12) v.currentTime = takeAt;
    } else {
      v.pause();
      if (Math.abs(v.currentTime - takeAt) > 0.02) v.currentTime = takeAt;
    }
  }, [takeAt, playing, take?.id]); // eslint-disable-line react-hooks/exhaustive-deps -- the picture's own time is read from it

  // a click or a drag on the waveform: the playhead there, in the stretch shown
  const surface = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const at = (e: ReactPointerEvent) => {
    const r = surface.current!.getBoundingClientRect();
    return r.width ? shown.fromMs + ((e.clientX - r.left) / r.width) * span : 0;
  };
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // a pointer that cannot be captured is followed while it stays over the waveform
    }
    setDragging(true);
    put(at(e));
  };
  // the keys of the timeline's other playhead slider (the full screen's): a second, five with Shift, Home and End. Kept
  // from the editor's own keys, which step a frame
  const keys = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const by = e.shiftKey ? 5000 : 1000;
    const next = e.key === "ArrowRight" || e.key === "ArrowUp" ? local + by : e.key === "ArrowLeft" || e.key === "ArrowDown" ? local - by : e.key === "Home" ? 0 : e.key === "End" ? length : null;
    if (next === null || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    put(next);
  };
  const ticks = Array.from({ length: 6 }, (_, k) => shown.fromMs + (span * k) / 5);
  const number = (p: NonNullable<typeof under>) => p.clip.takes.findIndex((x) => x.id === take?.id) + 1;

  return (
    <div ref={box} data-stage data-recording-stage className="relative flex min-h-0 grow flex-col overflow-hidden bg-stage">
      {take && under && (
        <video
          key={take.id}
          ref={pic}
          src={fileUrl(take.asset.id)}
          muted
          preload="auto"
          playsInline
          aria-label={`Clip ${under.number}'s take under the sound`}
          onLoadedMetadata={(e) => (e.currentTarget.currentTime = takeAt)}
          className="pointer-events-none absolute inset-0 h-full w-full object-contain opacity-40"
        />
      )}
      <audio key={recording.id} ref={el} src={fileUrl(recording.id)} preload="auto" onLoadedMetadata={(e) => (e.currentTarget.currentTime = local / 1000)} />

      <div className="absolute top-3 left-4 z-10 flex items-center gap-2 text-xs">
        <span className="rounded-chip border border-accent bg-ground/80 px-2 py-1 font-semibold text-accent">Recording</span>
        <span className="rounded-chip border border-line-strong bg-ground/80 px-2 py-1">
          {clock(local, { decimals: 1 })} of {(length / 1000).toFixed(1)} s{now ? ` · in clip ${now.number}` : local < place.fromMs ? " · before In" : " · past Out"}
        </span>
        {take && under && <span className="rounded-chip border border-line-strong bg-ground/80 px-2 py-1">take {number(under)} under the sound</span>}
      </div>
      <span className="absolute top-3 right-4 z-10 max-w-[40%] truncate rounded-chip bg-ground/80 px-2 py-1 font-mono text-xs text-ink-2">{recording.name}</span>

      {/* cut off at the stage's sides (what lies outside the stretch shown), not above or below: the marks reach past the waveform */}
      <div className="relative mx-9 mt-24 mb-6 min-h-24 grow basis-0" style={{ clipPath: "inset(-2.75rem 0 -1.5rem 0)" }}>
        {wave ? (
          <svg
            aria-hidden
            className="pointer-events-none absolute inset-y-0 h-full"
            style={{ left: share(wave.fromMs), width: sizeOf(wave.toMs - wave.fromMs) }}
            viewBox={`0 0 ${Math.max(1, wave.bars.length) * 3} 100`}
            preserveAspectRatio="none"
          >
            <path d={path} className="fill-ink-3" />
          </svg>
        ) : (
          // not measured yet, or nothing to measure: a quiet line where the waveform goes
          <span aria-hidden className="absolute inset-x-0 top-1/2 h-px bg-line-strong" />
        )}
        {/* outside In and Out: dimmed, as the source shows its whole video */}
        <span aria-hidden className="pointer-events-none absolute -inset-y-8 left-0 bg-stage/65" style={{ width: shareIn(place.fromMs) }} />
        <span aria-hidden className="pointer-events-none absolute -inset-y-8 right-0 bg-stage/65" style={{ left: shareIn(place.toMs) }} />
        {place.parts.filter((p) => p.endMs > shown.fromMs && p.startMs < shown.toMs).map((p) => {
          const here = p === now;
          // a part begun before the stretch shown: its name where it comes into view, not off the stage's side
          const into = p.startMs < shown.fromMs && p.endMs > p.startMs ? (shown.fromMs - p.startMs) / (p.endMs - p.startMs) : 0;
          return (
            <div
              key={p.clip.id}
              data-part={p.number}
              className={cx("pointer-events-none absolute -top-7 -bottom-3.5 border-l", here ? "border-accent bg-accent/10" : "border-line-strong")}
              style={{ left: share(p.startMs), width: sizeOf(p.endMs - p.startMs) }}
            >
              <span className={cx("absolute top-0 text-xs whitespace-nowrap", here ? "font-semibold text-accent" : "text-ink-2")} style={{ left: `calc(${into * 100}% + 0.375rem)` }}>
                Clip {p.number} · {((p.endMs - p.startMs) / 1000).toFixed(1)} s{here && playing ? " · playing" : ""}
              </span>
            </div>
          );
        })}
        {/* a part cut out of the middle: the clips jump over it, the recording with them */}
        {removed.filter((r) => r.toMs > shown.fromMs && r.fromMs < shown.toMs).map((r) => (
          <div
            key={r.before}
            data-removed=""
            className="pointer-events-none absolute -top-7 -bottom-3.5 border-x border-warn bg-[repeating-linear-gradient(135deg,transparent_0_5px,color-mix(in_srgb,var(--color-warn)_30%,transparent)_5px_7px)]"
            style={{ left: share(r.fromMs), width: sizeOf(r.toMs - r.fromMs) }}
          >
            <span className="absolute top-0 left-1.5 text-xs font-semibold whitespace-nowrap text-warn-ink">{removedSaid(r)}</span>
          </div>
        ))}
        {marks.filter((m) => m.ms >= shown.fromMs && m.ms <= shown.toMs).map((m) => (
          <span
            key={`${m.used}:${m.ms}`}
            data-pause={m.used ? "used" : "unused"}
            aria-hidden
            className={cx("pointer-events-none absolute -bottom-2 size-2.5 -translate-x-1/2 rotate-45 rounded-xs bg-ink-3", !m.used && "opacity-40")}
            style={{ left: share(m.ms) }}
          />
        ))}
        {[{ ms: place.fromMs, label: "In" }, { ms: place.toMs, label: "Out" }].map((x) => {
          const words = `${x.label} ${clock(x.ms, { decimals: 1 })}`;
          // out of the stretch shown: said at the side it lies beyond, with an arrow, so it never just goes
          if (x.ms < shown.fromMs || x.ms > shown.toMs) {
            const left = x.ms < shown.fromMs;
            return (
              <span key={x.label} data-beyond={x.label} aria-hidden className={cx("pointer-events-none absolute -bottom-5 text-micro font-bold whitespace-nowrap text-good", left ? "left-0" : "right-0")}>
                {left ? `◂ ${words}` : `${words} ▸`}
              </span>
            );
          }
          return (
            <span key={x.label} aria-hidden className="pointer-events-none absolute -top-10 -bottom-5 w-0.5 bg-good" style={{ left: share(x.ms) }}>
              {/* Out's words on its left, inside the stage: at the recording's end they ran past its edge */}
              <span className={cx("absolute bottom-0 text-micro font-bold whitespace-nowrap text-good", x.label === "In" ? "left-1.5" : "right-1.5")}>{words}</span>
            </span>
          );
        })}
        <span aria-hidden className="pointer-events-none absolute -inset-y-10 w-0.5 bg-ink-strong" style={{ left: share(local) }} />
        {/* last, over the marks drawn under it (each lets the pointer through) */}
        <div
          ref={surface}
          role="slider"
          tabIndex={0}
          aria-label="The recording: click or drag to move the playhead"
          aria-valuemin={Math.round(earliestOf(place))}
          aria-valuemax={Math.round(length)}
          aria-valuenow={Math.round(local)}
          aria-valuetext={clock(local, { decimals: 1 })}
          onKeyDown={keys}
          onPointerDown={down}
          onPointerMove={(e) => dragging && put(at(e))}
          onPointerUp={() => setDragging(false)}
          onPointerCancel={() => setDragging(false)}
          className="absolute inset-0 cursor-text"
        />
      </div>
      <div aria-hidden className="mx-9 flex justify-between font-mono text-micro text-ink-3">
        {ticks.map((ms) => <span key={ms}>{clock(ms, span < 20_000 ? { decimals: 1 } : undefined)}</span>)}
      </div>
      <span className="py-2 text-center text-xs text-ink-3">Click or drag: the playhead · I / O: In and Out · ◆ the pauses it was cut at (faint: pauses not used)</span>
    </div>
  );
});

/** The first moment of the recording heard at or after the track's start (0 of the track): the stage's playhead goes no earlier. */
export function earliestOf(place: RecordingPlace): number {
  return place.toTrack(0) >= 0 ? 0 : place.toRecording(0);
}

/**
 * The stretch of the recording the stage shows: what the track shows of it, at least LEAST_MS; all of it when the track
 * shows every one of its clips (Fit all), or says nothing yet.
 */
export function stretchOf(place: RecordingPlace, view: TrackView | null): { fromMs: number; toMs: number } {
  const all = { fromMs: 0, toMs: place.lengthMs };
  if (!view || place.lengthMs <= 0) return all;
  let fromMs = place.toRecording(view.fromMs);
  let toMs = place.toRecording(view.toMs);
  if (fromMs <= place.fromMs && toMs >= place.toMs) return all;
  if (toMs - fromMs < LEAST_MS) {
    const mid = (fromMs + toMs) / 2;
    fromMs = Math.max(0, Math.min(place.lengthMs - LEAST_MS, mid - LEAST_MS / 2));
    toMs = Math.min(place.lengthMs, fromMs + LEAST_MS);
  }
  return { fromMs, toMs };
}

/** How loud the whole sound gets (0 to 1): the bars of any stretch of it are measured against it, so zooming in keeps their heights. */
function loudestOf(sound: number[] | null | undefined): number {
  let top = 0;
  for (const db of sound ?? []) top = Math.max(top, levelOf(db));
  return top;
}
const levelOf = (db: number) => Math.max(0, Math.min(1, (db + 60) / 60));

/**
 * The waveform's bars over a stretch of the sound (its loudness, `rate` values a second, in dB): at most BARS, one a measure
 * on a short stretch; and the stretch they cover, on the measures' own grid. Null when there is nothing to draw.
 */
export function barsIn(sound: number[] | null | undefined, rate: number, top: number, stretch: { fromMs: number; toMs: number }): { bars: number[]; fromMs: number; toMs: number } | null {
  if (!sound || sound.length < 2 || rate <= 0) return null;
  const a = Math.max(0, Math.floor((stretch.fromMs / 1000) * rate));
  const b = Math.min(sound.length, Math.max(a + 1, Math.ceil((stretch.toMs / 1000) * rate)));
  const n = Math.min(BARS, b - a);
  const bars: number[] = [];
  for (let i = 0; i < n; i++) {
    const from = a + Math.floor((i * (b - a)) / n);
    const to = Math.max(from + 1, a + Math.floor(((i + 1) * (b - a)) / n));
    let peak = 0;
    for (let j = from; j < to; j++) peak = Math.max(peak, levelOf(sound[j]!));
    bars.push(top > 0 ? Math.max(0.06, peak / top) : 0.06);
  }
  return { bars, fromMs: (a / rate) * 1000, toMs: (b / rate) * 1000 };
}
