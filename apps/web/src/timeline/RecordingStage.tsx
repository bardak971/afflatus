import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, fileUrl, type Asset } from "../api";
import { clock } from "../format";
import { queryKeys } from "../queryKeys";
import { barsOf } from "../screens/library/SoundWave";
import { cx } from "../ui";
import type { PlayerHandle } from "./Player";
import { partAt, type RecordingPlace } from "./recordingPlace";

/** How many bars the stage's waveform has: about one every 5 px of a wide stage. */
const BARS = 180;
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
}>(function RecordingStage({ recording, place, playing, onPlaying, onTime, stopAt, startAt, master = 1 }, ref) {
  const el = useRef<HTMLAudioElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [local, setLocal] = useState(() => place.toRecording(startAt));
  const placeNow = useRef(place);
  placeNow.current = place;
  const length = place.lengthMs;
  /** The recording put at a moment of it (ms of the recording), the playhead with it. */
  const put = (ms: number) => {
    const at = Math.max(0, Math.min(placeNow.current.lengthMs, ms));
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
  // its clips made anew (a trim, a cut): the playhead follows the moment heard to where it now plays
  useEffect(() => {
    if (!playing) onTime(place.toTrack(local));
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
    if (a.currentTime * 1000 >= length - 40) a.currentTime = 0;
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
  const bars = barsOf(motion.data?.sound, BARS);
  const share = (ms: number) => `${(Math.max(0, Math.min(length, ms)) / length) * 100}%`;
  // the pauses it was cut at: where a part ends and the next one starts; the others are pauses it was not cut at
  const cuts = place.parts.slice(0, -1).map((p) => p.endMs);
  const marks = [
    ...cuts.map((ms) => ({ ms, used: true })),
    ...(pauses.data?.pauses ?? []).map((p) => ((p.start + p.end) / 2) * 1000).filter((ms) => ms < length && !cuts.some((c) => Math.abs(c - ms) < AT_A_CUT_MS)).map((ms) => ({ ms, used: false })),
  ];
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

  // a click or a drag on the waveform: the playhead there
  const wave = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const at = (e: ReactPointerEvent) => {
    const r = wave.current!.getBoundingClientRect();
    return r.width ? ((e.clientX - r.left) / r.width) * length : 0;
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
  const ticks = Array.from({ length: 6 }, (_, k) => (length * k) / 5);
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

      <div className="relative mx-9 mt-24 mb-6 min-h-24 grow basis-0">
        {bars ? (
          <svg aria-hidden className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${BARS * 3} 100`} preserveAspectRatio="none">
            <path d={bars.map((v, i) => `M${i * 3} ${(1 - v) * 50}h2v${v * 100}h-2z`).join("")} className="fill-ink-3" />
          </svg>
        ) : (
          // not measured yet, or nothing to measure: a quiet line where the waveform goes
          <span aria-hidden className="absolute inset-x-0 top-1/2 h-px bg-line-strong" />
        )}
        {/* outside In and Out: dimmed, as the source shows its whole video */}
        <span aria-hidden className="pointer-events-none absolute -inset-y-8 left-0 bg-stage/65" style={{ width: share(place.fromMs) }} />
        <span aria-hidden className="pointer-events-none absolute -inset-y-8 right-0 bg-stage/65" style={{ left: share(place.toMs) }} />
        {place.parts.map((p) => {
          const here = p === now;
          return (
            <div
              key={p.clip.id}
              data-part={p.number}
              className={cx("pointer-events-none absolute -top-7 -bottom-3.5 border-l", here ? "border-accent bg-accent/10" : "border-line-strong")}
              style={{ left: share(p.startMs), width: share(p.endMs - p.startMs) }}
            >
              <span className={cx("absolute top-0 left-1.5 text-xs whitespace-nowrap", here ? "font-semibold text-accent" : "text-ink-2")}>
                Clip {p.number} · {((p.endMs - p.startMs) / 1000).toFixed(1)} s{here && playing ? " · playing" : ""}
              </span>
            </div>
          );
        })}
        {marks.map((m) => (
          <span
            key={`${m.used}:${m.ms}`}
            data-pause={m.used ? "used" : "unused"}
            aria-hidden
            className={cx("pointer-events-none absolute -bottom-2 size-2.5 -translate-x-1/2 rotate-45 rounded-xs bg-ink-3", !m.used && "opacity-40")}
            style={{ left: share(m.ms) }}
          />
        ))}
        {[{ ms: place.fromMs, label: "In" }, { ms: place.toMs, label: "Out" }].map((x) => (
          <span key={x.label} aria-hidden className="pointer-events-none absolute -top-10 -bottom-5 w-0.5 bg-good" style={{ left: share(x.ms) }}>
            {/* Out's words on its left, inside the stage: at the recording's end they ran past its edge */}
            <span className={cx("absolute bottom-0 text-micro font-bold whitespace-nowrap text-good", x.label === "In" ? "left-1.5" : "right-1.5")}>{x.label} {clock(x.ms, { decimals: 1 })}</span>
          </span>
        ))}
        <span aria-hidden className="pointer-events-none absolute -inset-y-10 w-0.5 bg-ink-strong" style={{ left: share(local) }} />
        {/* last, over the marks drawn under it (each lets the pointer through) */}
        <div
          ref={wave}
          role="slider"
          tabIndex={-1}
          aria-label="The recording: click or drag to move the playhead"
          aria-valuemin={0}
          aria-valuemax={Math.round(length)}
          aria-valuenow={Math.round(local)}
          aria-valuetext={clock(local, { decimals: 1 })}
          onPointerDown={down}
          onPointerMove={(e) => dragging && put(at(e))}
          onPointerUp={() => setDragging(false)}
          onPointerCancel={() => setDragging(false)}
          className="absolute inset-0 cursor-text"
        />
      </div>
      <div aria-hidden className="mx-9 flex justify-between font-mono text-micro text-ink-3">
        {ticks.map((ms) => <span key={ms}>{clock(ms)}</span>)}
      </div>
      <span className="py-2 text-center text-xs text-ink-3">Click or drag: the playhead · I / O: In and Out · ◆ the pauses it was cut at (faint: pauses not used)</span>
    </div>
  );
});
