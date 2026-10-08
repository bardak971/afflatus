import { useEffect, useRef, useState, type RefObject } from "react";
import { Minimize, Pause, Play, Volume2, VolumeX } from "lucide-react";
import { clock as clockText } from "../format";
import { cx } from "../ui";
import { useClock, type Clock } from "./clock";

/** What the editor's own transport does, handed to the player for when it fills the screen. */
export interface ScreenControls {
  clock: Clock;
  total: number;
  playing: boolean;
  volume: number;
  muted: boolean;
  onToggle(): void;
  /** Go to a moment of the timeline, as its playhead does. */
  onSeek(ms: number): void;
  onVolume(volume: number): void;
  onMute(): void;
}

/**
 * The transport over the picture while the player fills the screen: play and pause, where it is, the
 * sound and the way out. It shows while the mouse moves and fades after a moment of stillness. With a
 * clip rendering on screen, play and pause are those of what is forming (its looping preview).
 */
export function FullscreenBar({ box, c, live }: { box: RefObject<HTMLDivElement | null>; c: ScreenControls; /** A clip rendering on screen: its preview, a video that loops or a picture that has nothing to play. */ live: "video" | "picture" | null }) {
  const [full, setFull] = useState(false);
  const [shown, setShown] = useState(true);
  const [livePaused, setLivePaused] = useState(false);
  const idle = useRef<number | undefined>(undefined);
  const now = useClock(c.clock);

  useEffect(() => {
    const on = () => setFull(document.fullscreenElement === box.current);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, [box]);

  // shown on a move, put away after two seconds of stillness (never while the pointer is on the bar)
  useEffect(() => {
    const el = box.current;
    if (!el || !full) return;
    const wake = () => {
      setShown(true);
      window.clearTimeout(idle.current);
      idle.current = window.setTimeout(() => setShown(false), 2000);
    };
    wake();
    el.addEventListener("pointermove", wake);
    return () => {
      el.removeEventListener("pointermove", wake);
      window.clearTimeout(idle.current);
    };
  }, [box, full]);

  // the preview that is forming: followed, as it is a new player at each step
  const preview = () => box.current?.querySelector<HTMLVideoElement>("video[data-live]") ?? null;
  useEffect(() => {
    if (!live) return;
    const t = window.setInterval(() => setLivePaused(Boolean(preview()?.paused)), 300);
    return () => window.clearInterval(t);
  }, [live]);

  if (!full) return null;
  const paused = live ? livePaused : !c.playing;
  const toggle = () => {
    if (!live) return c.onToggle();
    const v = preview();
    if (v) void (v.paused ? v.play().catch(() => {}) : v.pause());
    setLivePaused(!v?.paused);
  };
  const quiet = c.muted || c.volume === 0;
  const button = "flex h-9 w-9 items-center justify-center rounded-lg text-white/85 hover:bg-white/15 hover:text-white";
  return (
    <div
      onPointerEnter={() => window.clearTimeout(idle.current)}
      className={cx(
        "absolute inset-x-0 bottom-0 z-20 flex items-center gap-2 bg-gradient-to-t from-black/80 to-transparent px-4 pt-8 pb-3 transition-opacity duration-300",
        shown ? "opacity-100" : "pointer-events-none opacity-0",
      )}
    >
      {live !== "picture" && <button type="button" aria-label={paused ? "Play" : "Pause"} data-tip={paused ? "Play (Space)" : "Pause (Space)"} onClick={toggle} className={button}>
        {paused ? <Play size={18} /> : <Pause size={18} />}
      </button>}
      {!live && <span className="font-mono text-sm text-white/85 tabular-nums">{clockText(now, { decimals: 1 })} / {clockText(c.total, { decimals: 1 })}</span>}
      {!live && c.total > 0 ? (
        <input
          type="range"
          min={0}
          max={c.total}
          step={10}
          value={Math.min(now, c.total)}
          aria-label="Where it plays"
          data-tip="Drag to go to a moment"
          onChange={(e) => c.onSeek(Number(e.target.value))}
          className="mx-2 min-w-0 grow cursor-pointer accent-accent"
        />
      ) : (
        <span className="grow" />
      )}
      <button type="button" aria-label={quiet ? "Unmute" : "Mute"} data-tip={quiet ? "Unmute" : "Mute"} onClick={c.onMute} className={button}>
        {quiet ? <VolumeX size={17} /> : <Volume2 size={17} />}
      </button>
      <input type="range" min={0} max={1} step={0.01} value={c.muted ? 0 : c.volume} aria-label="Volume" data-tip={`Volume ${Math.round((c.muted ? 0 : c.volume) * 100)} %`} onChange={(e) => c.onVolume(Number(e.target.value))} className="w-28 cursor-pointer accent-accent" />
      <button type="button" aria-label="Leave full screen" data-tip="Leave full screen (Esc)" onClick={() => void document.exitFullscreen().catch(() => {})} className={button}>
        <Minimize size={17} />
      </button>
    </div>
  );
}
