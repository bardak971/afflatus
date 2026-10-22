import { useEffect, useRef, useState, type HTMLAttributes, type KeyboardEvent, type MouseEvent, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { Maximize, Minimize } from "lucide-react";
import { api, fileUrl, thumbUrl } from "./api";
import { claimPlayback, PlayButton, releasePlayback, savedVolume, SeekStrip, storeVolume, TimeReadout, VolumeControl } from "./mediaControls";
import { barsOf, BARS } from "./screens/library/SoundWave";
import { cx, IconButton } from "./ui";
import { queryKeys } from "./queryKeys";

/**
 * The app's video player, in place of the browser's controls: the video, and under it the same bar as the
 * audio player (play, the position on the sound's waveform or a plain bar, the time in mono, the volume)
 * with full screen at its end. A click on the video plays and pauses it; with the focus in the player,
 * Space does, and the arrow keys on the position go back and forth. Without `controls` it is the bare
 * video (a click still plays and pauses it): another screen has the controls, as Trim does.
 */
export function VideoPlayer({ asset, sound, lengthMs, video: outer, controls = true, barRoom, compact, muted: silent, className, videoClassName, videoProps, onVideoClick }: {
  /** The video in the library. */
  asset: string;
  /** It has a sound track: its waveform is the position strip. */
  sound?: boolean;
  /** Its length as the library knows it: the bar works with it until the file says its own (a file still being written may never say it). */
  lengthMs?: number | null;
  /** The video element, for whoever reads or moves its position (Trim, save frame, Compare). */
  video?: RefObject<HTMLVideoElement | null>;
  controls?: boolean;
  /** Without controls, the room of the bar kept under it: beside a player that has them, the two videos line up. */
  barRoom?: boolean;
  /** In a form: a slimmer bar with no box of its own, and no full screen. */
  compact?: boolean;
  /** Always silent, as the second video of Compare. */
  muted?: boolean;
  className?: string;
  videoClassName?: string;
  /** More on the video element: dragging it, its menu. */
  videoProps?: Omit<HTMLAttributes<HTMLVideoElement>, "onClick" | "className">;
  /** A click on the video, before it plays or pauses. */
  onVideoClick?(e: MouseEvent<HTMLVideoElement>): void;
}) {
  const own = useRef<HTMLVideoElement>(null);
  const el = outer ?? own;
  const box = useRef<HTMLDivElement>(null);
  const [on, setOn] = useState(false);
  const [now, setNow] = useState(0);
  const [length, setLength] = useState<number | null>(null);
  const [volume, setVolumeState] = useState(savedVolume);
  const [muted, setMuted] = useState(false);
  const [full, setFull] = useState(false);

  // the same key as the library's waveform and the audio player's: measured once for all of them
  const motion = useQuery({ queryKey: queryKeys.motion(asset), queryFn: () => api.motion(asset), enabled: Boolean(sound && controls), staleTime: Infinity, retry: 0 });
  const bars = sound ? barsOf(motion.data?.sound, BARS) : null;

  // another video: from its start, paused. Its length is read from the element, not cleared: a file the
  // browser has seen loads its metadata before this effect runs, and no event would say it again
  useEffect(() => {
    setOn(false);
    setNow(0);
    const d = el.current?.duration;
    setLength(d !== undefined && Number.isFinite(d) && d > 0 ? d : lengthMs ? lengthMs / 1000 : null);
  }, [asset]); // eslint-disable-line react-hooks/exhaustive-deps -- once per video: what the element knows then

  useEffect(() => {
    const v = el.current;
    if (!v) return;
    v.volume = volume;
    v.muted = silent || muted;
  }, [el, volume, muted, silent, asset]);

  // while it plays: the position read every frame (timeupdate comes four times a second, too few for the strip)
  useEffect(() => {
    const v = el.current;
    if (!on || !v || !controls) return;
    let frame = 0;
    const tick = () => {
      setNow(v.currentTime);
      // its length, the moment the file knows it, if no event said it
      if (Number.isFinite(v.duration) && v.duration > 0) setLength((l) => (l === v.duration ? l : v.duration));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [el, on, controls]);

  useEffect(() => {
    const v = el.current;
    return () => releasePlayback(v);
  }, [el]);

  useEffect(() => {
    const onChange = () => setFull(document.fullscreenElement === box.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggle = () => {
    const v = el.current;
    if (!v) return;
    if (!v.paused) return v.pause();
    if (!silent) claimPlayback(v);
    void v.play().catch(() => setOn(false));
  };
  const seek = (fraction: number) => {
    const v = el.current;
    if (!v || length === null) return;
    const t = fraction * length;
    v.currentTime = t;
    setNow(t);
  };
  const setVolume = (n: number) => {
    const next = Math.round(Math.max(0, Math.min(1, n)) * 100) / 100;
    setVolumeState(next);
    setMuted(next === 0);
    storeVolume(next);
  };
  const toggleFull = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void box.current?.requestFullscreen().catch(() => {});
  };
  const onKeys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== " " || e.ctrlKey || e.metaKey || e.altKey || !controls) return;
    // Space plays and pauses whatever in the player has the focus (a button would click itself too)
    e.preventDefault();
    e.stopPropagation();
    if (!e.repeat) toggle();
  };

  const at = length ? Math.max(0, Math.min(1, now / length)) : 0;
  return (
    <div
      ref={box}
      tabIndex={-1}
      onKeyDown={onKeys}
      // focused by a click on the video, for Space: the whole stage is not outlined for it
      style={{ outline: "none" }}
      className={cx("flex min-h-0 min-w-0 flex-col items-center gap-2", full && "justify-center bg-stage p-4", className)}
    >
      <video
        {...videoProps}
        key={asset}
        ref={el}
        src={fileUrl(asset)}
        poster={thumbUrl(asset)}
        preload="metadata"
        playsInline
        muted={silent}
        onClick={(e) => {
          onVideoClick?.(e);
          box.current?.focus({ preventScroll: true });
          // the second video of Compare follows the first: a click on it does nothing of its own
          if (controls || !silent) toggle();
        }}
        onLoadedMetadata={(e) => Number.isFinite(e.currentTarget.duration) && setLength(e.currentTarget.duration)}
        onDurationChange={(e) => Number.isFinite(e.currentTarget.duration) && setLength(e.currentTarget.duration)}
        onPlay={() => setOn(true)}
        onPause={(e) => {
          setOn(false);
          setNow(e.currentTarget.currentTime);
        }}
        onEnded={(e) => {
          setOn(false);
          setNow(e.currentTarget.currentTime);
        }}
        // moved from elsewhere (Trim, Compare, a saved frame): the strip follows
        onSeeked={(e) => setNow(e.currentTarget.currentTime)}
        className={cx("min-h-0 max-w-full cursor-pointer rounded-lg", full ? "max-h-full grow" : "", videoClassName)}
      />
      {(controls || barRoom) && (
        <div aria-hidden={!controls || undefined} inert={!controls || undefined} className={cx("flex w-full min-w-0 shrink-0 items-center", !controls && "invisible", compact ? "gap-2.5" : "max-w-[640px] gap-3.5 rounded-card border border-line bg-raised px-3.5 py-2")}>
          <PlayButton on={on} onClick={toggle} />
          <SeekStrip at={at} now={now} span={length} bars={bars} playing={on} onSeek={seek} />
          <TimeReadout now={now} span={length} />
          {!silent && <VolumeControl volume={volume} muted={muted} onVolume={setVolume} onMuted={setMuted} />}
          {!compact && (
            <IconButton
              size={28}
              label={full ? "Leave full screen" : "Full screen"}
              onClick={(e) => {
                e.stopPropagation();
                toggleFull();
              }}
            >
              {full ? <Minimize size={15} /> : <Maximize size={15} />}
            </IconButton>
          )}
        </div>
      )}
    </div>
  );
}
