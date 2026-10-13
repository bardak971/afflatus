import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, fileUrl } from "./api";
import { claimPlayback, PlayButton, releasePlayback, savedVolume, SeekStrip, storeVolume, TimeReadout, VolumeControl } from "./mediaControls";
import { barsOf, BARS } from "./screens/library/SoundWave";
import { cx } from "./ui";
import { queryKeys } from "./queryKeys";

/**
 * The app's audio player, in place of the browser's: a play button, the name and the time, the sound's
 * waveform (the loudness the server measures once for the library and the timelines) with what was played
 * in the accent, and the volume. A click or a drag on the waveform goes there; with the focus on the
 * player, Space plays and pauses, and the arrow keys on the waveform go back and forth. A sound that is
 * not in the library (no `asset`) has a plain bar in place of its waveform. With `strip`, the place's own waveform is drawn
 * under the player in place of the small one (a part chosen on the whole sound: SoundRange), with the playhead on it.
 */

export function AudioPlayer({ asset, src, name, range, strip, bare, className, onClick, children }: {
  /** The sound (or the video whose sound it is) in the library: its waveform is drawn. */
  asset?: string;
  /** Another address than the asset's file: a sound that is not in the library. */
  src?: string;
  /** Written over the waveform; left out, the time goes after it on one line. */
  name?: string;
  /** Only a part is played, in seconds of the sound: the waveform and the time are those of the part. */
  range?: { from: number; to: number };
  /** Drawn under the player in place of its waveform: given where the sound is, in seconds of it (null: not started), and a way to play from a moment. */
  strip?(now: number | null, playFrom: (at: number) => void): ReactNode;
  /** Inside a card of its own: no border and no ground. */
  bare?: boolean;
  className?: string;
  onClick?(e: React.MouseEvent): void;
  /** After the volume: buttons of the place it is in. */
  children?: ReactNode;
}) {
  const url = src ?? (asset ? fileUrl(asset) : "");
  const audio = useRef<HTMLAudioElement>(null);
  const [on, setOn] = useState(false);
  // the position and the length, in seconds of the sound (the part's start is taken off when shown)
  const [now, setNow] = useState(range?.from ?? 0);
  const [length, setLength] = useState<number | null>(null);
  const [volume, setVolumeState] = useState(savedVolume);
  const [muted, setMuted] = useState(false);

  // the same key as the library's waveform and the timelines' curves: measured once for all of them
  const motion = useQuery({ queryKey: queryKeys.motion(asset), queryFn: () => api.motion(asset!), enabled: Boolean(asset), staleTime: Infinity, retry: 0 });

  const from = range ? range.from : 0;
  const to = range ? (length === null ? range.to : Math.min(range.to, length)) : length;
  const span = to === null ? null : Math.max(0.01, to - from);
  const at = span === null ? 0 : Math.max(0, Math.min(1, (now - from) / span));

  // the loudness of the part played, as bars
  const sound = motion.data?.sound;
  const rate = motion.data?.rate ?? 10;
  const bars = barsOf(sound && range ? sound.slice(Math.floor(range.from * rate), Math.ceil(range.to * rate)) : sound, BARS);

  // another sound or another part: from its start, paused
  useEffect(() => {
    setOn(false);
    setNow(range?.from ?? 0);
    setLength(null);
  }, [url, range?.from, range?.to]);

  useEffect(() => {
    const el = audio.current;
    if (el) {
      el.volume = volume;
      el.muted = muted;
    }
  }, [volume, muted, url]);

  // while it plays: the position read every frame (timeupdate comes four times a second, too few for the waveform)
  useEffect(() => {
    const el = audio.current;
    if (!on || !el) return;
    let frame = 0;
    const tick = () => {
      if (to !== null && el.currentTime >= to) {
        el.pause();
        el.currentTime = from;
      }
      setNow(el.currentTime);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [on, from, to]);

  // gone from the screen: silent
  useEffect(() => () => releasePlayback(audio.current), []);

  const toggle = () => {
    const el = audio.current;
    if (!el) return;
    if (!el.paused) return el.pause();
    if (el.currentTime < from || (to !== null && el.currentTime >= to - 0.05)) el.currentTime = from;
    claimPlayback(el);
    void el.play().catch(() => setOn(false));
  };
  const seek = (fraction: number) => {
    const el = audio.current;
    if (!el || span === null) return;
    const t = from + fraction * span;
    el.currentTime = t;
    setNow(t);
  };
  /** Plays from a moment of the sound, within the part played. */
  const playFrom = (t: number) => {
    const el = audio.current;
    if (!el) return;
    el.currentTime = Math.max(from, to === null ? t : Math.min(t, to - 0.05));
    setNow(el.currentTime);
    claimPlayback(el);
    void el.play().catch(() => setOn(false));
  };
  const setVolume = (v: number) => {
    const next = Math.round(Math.max(0, Math.min(1, v)) * 100) / 100;
    setVolumeState(next);
    setMuted(next === 0);
    storeVolume(next);
  };

  const onKeys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== " " || e.ctrlKey || e.metaKey || e.altKey) return;
    // Space plays and pauses whatever in the player has the focus (a button would click itself too)
    e.preventDefault();
    e.stopPropagation();
    if (!e.repeat) toggle();
  };
  const time = <TimeReadout now={now - from} span={span} />;
  const wave = strip ? null : <SeekStrip at={at} now={now - from} span={span} bars={bars} playing={on} name={name} onSeek={seek} />;

  const player = (
    <div
      onKeyDown={onKeys}
      onClick={onClick}
      className={cx("flex min-w-0 items-center gap-3.5", !bare && !strip && "rounded-[14px] border border-line bg-raised px-3.5 py-2.5", !strip && className)}
    >
      <audio
        key={url}
        ref={audio}
        src={url}
        preload="metadata"
        onLoadedMetadata={(e) => {
          const el = e.currentTarget;
          if (Number.isFinite(el.duration)) setLength(el.duration);
          if (from) el.currentTime = from;
        }}
        onDurationChange={(e) => Number.isFinite(e.currentTarget.duration) && setLength(e.currentTarget.duration)}
        onPlay={() => setOn(true)}
        onPause={(e) => {
          setOn(false);
          setNow(e.currentTarget.currentTime);
        }}
        onEnded={(e) => {
          setOn(false);
          e.currentTarget.currentTime = from;
          setNow(from);
        }}
        onSeeked={(e) => !on && setNow(e.currentTarget.currentTime)}
      />
      <PlayButton on={on} onClick={toggle} />
      {name ? (
        <span className="flex min-w-0 grow flex-col gap-1.5">
          <span className="flex min-w-0 items-center gap-2 text-[13px]">
            <span className="min-w-0 grow truncate font-semibold">{name}</span>
            {time}
          </span>
          {wave}
        </span>
      ) : (
        <>
          {wave}
          {time}
        </>
      )}
      <VolumeControl volume={volume} muted={muted} onVolume={setVolume} onMuted={setMuted} />
      {children}
    </div>
  );
  if (!strip) return player;
  // the playhead shows once the part has been played or sought into
  return (
    <div className={cx("flex min-w-0 flex-col gap-2", !bare && "rounded-[14px] border border-line bg-raised px-3.5 py-2.5", className)}>
      {player}
      {strip(on || now > from ? now : null, playFrom)}
    </div>
  );
}
