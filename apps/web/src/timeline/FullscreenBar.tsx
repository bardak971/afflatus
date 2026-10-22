import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { Minimize, Pause, Play, Repeat, SkipBack, SkipForward, Volume2, VolumeX } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { fileUrl, type Clip, type Timeline } from "../api";
import { clock as clockText } from "../format";
import { Keys } from "../Keys";
import { cx } from "../ui";
import { Slider } from "../Slider";
import { useClock, type Clock } from "./clock";
import { fitFrame, frameUrl, placeCard } from "./track/peek";
import { PeekEmpty, PeekFrame, preload } from "./track/PeekCard";
import { queryKeys } from "../queryKeys";

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
  /** To the clip before or after, selecting it as the editor's buttons and [ ] do; left out, the bar only seeks. */
  onJump?(by: -1 | 1): void;
  /** A range is marked: whether it loops, and the switch (L). */
  loop?: { on: boolean; toggle(): void };
}

/** How long the controls stay up without a move while it plays. */
const HIDE_AFTER_MS = 2500;
/** How long the pointer is over the bar before the frame card shows; and how often it asks for another frame. */
const SHOW_AFTER_MS = 120;
const FRAME_EVERY_MS = 60;
/** The frame card: what it holds, without its padding (6 px each side). */
const CARD = { w: 188, h: 140, outer: 200 };

/** A clip of the bar: where it sits in the timeline, and its number on the track. */
interface Part {
  clip: Clip;
  n: number;
}

/** The clip at a moment of the timeline (the last one past its end). */
const partAt = (parts: Part[], ms: number) => {
  const i = parts.findIndex((p) => ms < p.clip.atMs + p.clip.lengthMs);
  return i < 0 ? parts.length - 1 : i;
};

/**
 * The transport over the picture while the player fills the screen: the timeline's name and the clip on screen
 * at the top, the keys that work here, and at the bottom the bar cut into the clips, play and pause, the
 * clips before and after, where it is, the sound and the way out. While it plays it all fades after a moment
 * of stillness (the pointer with it), and comes back on a move or a key. With a clip rendering on screen, play
 * and pause are those of what is forming (its looping preview).
 */
export function FullscreenBar({ box, c, live, clips, timeline }: {
  box: RefObject<HTMLDivElement | null>;
  c: ScreenControls;
  /** A clip rendering on screen: its preview, a video that loops or a picture that has nothing to play. */
  live: "video" | "picture" | null;
  /** The timeline's clips, for the bar's parts and the clip on screen. */
  clips: Clip[];
  /** The timeline, for its name. */
  timeline?: string;
}) {
  const [full, setFull] = useState(false);
  const [shown, setShown] = useState(true);
  const [livePaused, setLivePaused] = useState(false);
  const idle = useRef<number | undefined>(undefined);
  /** The pointer is on the controls: they stay. */
  const hold = useRef(false);
  const running = useRef(false);
  const now = useClock(c.clock);
  // read from the editor's own copy (redrawn with the clock): entering full screen asks for nothing
  const name = useQueryClient().getQueryData<Timeline>(queryKeys.timelines.one(timeline))?.name;

  useEffect(() => {
    const on = () => setFull(document.fullscreenElement === box.current);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, [box]);

  const paused = live ? livePaused : !c.playing;
  running.current = full && !paused;
  /** Up again, and put away after a moment of stillness when it plays and the pointer is not on them. */
  const wake = () => {
    setShown(true);
    window.clearTimeout(idle.current);
    if (running.current && !hold.current) idle.current = window.setTimeout(() => setShown(false), HIDE_AFTER_MS);
  };
  const wakeRef = useRef(wake);
  wakeRef.current = wake;

  // shown on a move or a key; paused, never put away
  useEffect(() => {
    const el = box.current;
    if (!el || !full) return;
    const on = () => wakeRef.current();
    el.addEventListener("pointermove", on);
    window.addEventListener("keydown", on);
    return () => {
      el.removeEventListener("pointermove", on);
      window.removeEventListener("keydown", on);
      window.clearTimeout(idle.current);
    };
  }, [box, full]);
  useEffect(() => {
    if (full) wakeRef.current();
  }, [full, paused]);

  // the pointer goes with the controls
  const hidden = full && !shown;
  useEffect(() => {
    const el = box.current;
    if (!el || !hidden) return;
    el.style.cursor = "none";
    return () => void (el.style.cursor = "");
  }, [box, hidden]);

  // the preview that is forming: followed, as it is a new player at each step
  const preview = useCallback(() => box.current?.querySelector<HTMLVideoElement>("video[data-live]") ?? null, [box]);
  useEffect(() => {
    if (!live) return;
    const t = window.setInterval(() => setLivePaused(Boolean(preview()?.paused)), 300);
    return () => window.clearInterval(t);
  }, [live, preview]);

  if (!full) return null;
  const toggle = () => {
    if (!live) return c.onToggle();
    const v = preview();
    if (v) void (v.paused ? v.play().catch(() => {}) : v.pause());
    setLivePaused(!v?.paused);
  };
  const quiet = c.muted || c.volume === 0;
  const parts: Part[] = clips.flatMap((clip, i) => (clip.lengthMs > 0 ? [{ clip, n: i + 1 }] : []));
  const at = Math.min(now, c.total);
  const here = parts.length ? partAt(parts, at) : -1;
  const onScreen = parts[here];
  const takeNo = onScreen?.clip.take ? onScreen.clip.takes.findIndex((t) => t.id === onScreen.clip.take!.id) + 1 : 0;
  const tag = onScreen ? `Clip ${onScreen.n}${takeNo ? ` · take ${takeNo}` : onScreen.clip.kind === "still" && onScreen.clip.still ? " · still" : ""}` : null;
  // back: to the start of this clip, or of the one before when already there (as the editor's own buttons)
  const jump = (by: -1 | 1) => {
    if (c.onJump) return c.onJump(by);
    const p = by === 1 ? parts[here + 1] : at - (onScreen?.clip.atMs ?? 0) > 400 ? onScreen : parts[Math.max(0, here - 1)];
    if (p) c.onSeek(p.clip.atMs);
  };
  const seeks = !live && c.total > 0 && parts.length > 0;
  const button = "flex h-[34px] w-[34px] items-center justify-center rounded-control text-ink hover:bg-ink/15 disabled:opacity-40";
  const fade = cx("motion-safe:transition-opacity motion-safe:duration-300", shown ? "opacity-100" : "pointer-events-none opacity-0");
  const controls = {
    onPointerEnter: () => {
      hold.current = true;
      wake();
    },
    onPointerLeave: () => {
      hold.current = false;
      wake();
    },
  };

  return (
    <>
      {/* the top: the timeline and the clip on screen, the keys that work here */}
      <div aria-hidden={!shown} className={cx("pointer-events-none absolute inset-x-0 top-0 z-20 h-[120px] bg-gradient-to-b from-ground/75 to-transparent", fade)}>
        <div className="absolute top-[22px] left-7 flex min-w-0 items-center gap-2.5">
          {name && <span className="truncate text-base font-bold text-ink">{name}</span>}
          {!live && tag && <span className="flex h-[22px] shrink-0 items-center rounded-chip bg-accent/20 px-2 text-xs font-bold text-accent">{tag}</span>}
        </div>
        <div className="absolute top-[22px] right-7 flex gap-3.5 text-meta text-ink-2">
          <KeyHint keys="Space" does="play" />
          {seeks && <KeyHint keys="← →" does="frame" />}
          {seeks && c.onJump && <KeyHint keys="[ ]" does="clip" />}
          {c.loop && <KeyHint keys="L" does="loop" />}
          <KeyHint keys="Esc" does="leave" />
        </div>
      </div>
      {/* the bottom, deeper: the controls read over a bright frame */}
      <div className={cx("pointer-events-none absolute inset-x-0 bottom-0 z-20 h-[190px] bg-gradient-to-t from-ground/90 to-transparent", fade)}>
        <div {...controls} className={cx("absolute inset-x-7 bottom-[22px] flex flex-col gap-2.5", shown && "pointer-events-auto")}>
          {seeks && <ClipBar parts={parts} here={here} at={at} total={c.total} onSeek={c.onSeek} />}
          <div className="flex h-11 items-center gap-3">
            {seeks && <button type="button" aria-label="Previous clip" data-tip="Previous clip" onClick={() => jump(-1)} className={button}><SkipBack size={17} /></button>}
            {live !== "picture" && (
              <button type="button" aria-label={paused ? "Play" : "Pause"} data-tip={paused ? "Play (Space)" : "Pause (Space)"} onClick={toggle} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent text-accent-ink hover:brightness-110">
                {paused ? <Play size={18} className="ml-0.5" fill="currentColor" /> : <Pause size={18} fill="currentColor" />}
              </button>
            )}
            {seeks && <button type="button" aria-label="Next clip" data-tip="Next clip" disabled={here >= parts.length - 1} onClick={() => jump(1)} className={button}><SkipForward size={17} /></button>}
            {!live && (
              <span className="font-mono text-sm tabular-nums">
                <b className="font-medium text-ink">{clockText(at, { decimals: 1 })}</b> <span className="text-ink-3">/ {clockText(c.total, { decimals: 1 })}</span>
              </span>
            )}
            <span className="grow" />
            {c.loop && (
              <button type="button" aria-pressed={c.loop.on} data-tip={c.loop.on ? "Looping the range" : "Loop the range"} data-tip-keys="L" onClick={c.loop.toggle} className={cx("flex h-[30px] items-center gap-1.5 rounded-control px-2.5 text-xs font-semibold", c.loop.on ? "bg-accent/25 text-accent" : "bg-ink/10 text-ink hover:bg-ink/15")}>
                <Repeat size={14} /> Loop range
              </button>
            )}
            <span className="flex items-center gap-1">
              <button type="button" aria-label={quiet ? "Unmute" : "Mute"} data-tip={quiet ? "Unmute" : "Mute"} onClick={c.onMute} className={button}>
                {quiet ? <VolumeX size={17} /> : <Volume2 size={17} />}
              </button>
              <Slider box={false} min={0} max={1} step={0.01} value={c.muted ? 0 : c.volume} label="Volume" format={(v) => `Volume ${Math.round(v * 100)} %`} onChange={c.onVolume} className="w-[90px]" />
            </span>
            <button type="button" aria-label="Leave full screen" data-tip="Leave full screen (Esc)" onClick={() => void document.exitFullscreen().catch(() => {})} className={button}>
              <Minimize size={17} />
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

/** A key and what it does, for the top's legend. */
function KeyHint({ keys, does }: { keys: string; does: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <Keys keys={keys} size="sm" />
      {does}
    </span>
  );
}

/**
 * The bar, cut into the clips (as long as each plays), each named over it: the one on screen thicker, in the
 * accent, those before it filled. A click or a drag anywhere goes to that moment of the timeline; the arrows
 * move a second (Shift: five), Home and End go to the ends. Hovered, a card shows the frame there.
 */
function ClipBar({ parts, here, at, total, onSeek }: { parts: Part[]; here: number; at: number; total: number; onSeek(ms: number): void }) {
  const strip = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ x: number; ms: number } | null>(null);
  const peek = usePeek(hover ? parts[partAt(parts, hover.ms)] : undefined, hover?.ms ?? 0);

  /** The moment under the pointer: in the clip it is over (a gap between two counts as the nearer one's edge). */
  const msAt = (e: PointerEvent<HTMLElement>) => {
    const el = strip.current!;
    const x = e.clientX - el.getBoundingClientRect().left;
    const boxes = [...el.querySelectorAll<HTMLElement>("[data-part]")];
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i]!;
      const p = parts[i]!;
      const left = b.offsetLeft;
      const next = boxes[i + 1]?.offsetLeft ?? Infinity;
      if (x < next || i === boxes.length - 1) {
        const f = Math.max(0, Math.min(1, (x - left) / Math.max(1, b.offsetWidth)));
        return { x, ms: Math.max(0, Math.min(total, Math.round(p.clip.atMs + f * p.clip.lengthMs))) };
      }
    }
    return { x, ms: 0 };
  };
  const onKeys = (e: KeyboardEvent<HTMLDivElement>) => {
    const by = e.shiftKey ? 5000 : 1000;
    const next = e.key === "ArrowRight" || e.key === "ArrowUp" ? at + by : e.key === "ArrowLeft" || e.key === "ArrowDown" ? at - by : e.key === "Home" ? 0 : e.key === "End" ? total : null;
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    onSeek(Math.max(0, Math.min(total, next)));
  };

  const width = strip.current?.clientWidth ?? 0;
  const card = hover ? placeCard(hover.x, CARD.outer, 0, width) : null;
  return (
    <div
      ref={strip}
      role="slider"
      tabIndex={0}
      aria-label="Where it plays"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={Math.round(at)}
      aria-valuetext={clockText(at, { decimals: 1 })}
      onKeyDown={onKeys}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.focus();
        e.currentTarget.setPointerCapture(e.pointerId);
        setHover(null);
        onSeek(msAt(e).ms);
      }}
      onPointerMove={(e) => {
        // dragged: the picture itself shows the frame
        if (e.currentTarget.hasPointerCapture(e.pointerId)) return onSeek(msAt(e).ms);
        setHover(e.buttons ? null : msAt(e));
      }}
      onPointerLeave={() => setHover(null)}
      className="relative flex h-[26px] cursor-pointer touch-none items-end gap-[3px] pb-1 outline-none focus-visible:rounded focus-visible:ring-2 focus-visible:ring-accent"
    >
      {parts.map((p, i) => {
        const on = i === here;
        const fill = i < here ? 100 : on ? Math.max(0, Math.min(100, ((at - p.clip.atMs) / Math.max(1, p.clip.lengthMs)) * 100)) : 0;
        return (
          <span key={p.clip.id} data-part className={cx("relative min-w-1 rounded bg-ink/20", on ? "h-2" : "h-1.5")} style={{ flex: `${p.clip.lengthMs} 1 0` }}>
            <span aria-hidden className={cx("absolute inset-y-0 left-0 rounded", on ? "bg-accent" : "bg-accent/65")} style={{ width: `${fill}%` }} />
            <span aria-hidden className={cx("absolute bottom-3 left-0 max-w-full truncate text-meta font-bold", on ? "text-accent" : "text-ink-2")}>Clip {p.n}</span>
          </span>
        );
      })}
      {hover && card && peek.armed && (
        <div aria-hidden className="pointer-events-none absolute bottom-full mb-3 flex flex-col gap-[5px] rounded-xl border border-line-strong bg-panel p-1.5 text-ink shadow-[0_18px_48px_color-mix(in_oklab,var(--color-shade)_50%,transparent)]" style={{ left: card.left, width: CARD.outer }}>
          {peek.body}
          <span className="flex justify-between px-0.5 text-meta">
            <span className="font-bold">Clip {parts[partAt(parts, hover.ms)]?.n}</span>
            <span className="font-mono text-ink-2">{clockText(hover.ms, { decimals: 1 })}</span>
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * The frame card's picture for a moment of a clip, as the track's own card finds it: the take's frame (asked
 * for at most every FRAME_EVERY_MS, the last one kept up until the next is ready), the still, or a short card
 * for a clip not rendered yet. `armed` once the pointer has stayed a moment.
 */
function usePeek(part: Part | undefined, ms: number) {
  const [url, setUrl] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const clip = part?.clip;
  const take = clip?.take ?? null;
  const size = fitFrame(take?.asset.width ?? clip?.still?.width, take?.asset.height ?? clip?.still?.height, CARD);
  // short of the very end, where ffmpeg finds no picture (see pinCompare)
  const want = take && clip ? frameUrl(take.asset, Math.min(take.endMs - 60, take.startMs + Math.max(0, ms - clip.atMs)), size.h) : null;
  const latest = useRef(want);
  latest.current = want;
  const askedAt = useRef(0);
  const trail = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!part) return setArmed(false);
    const t = window.setTimeout(() => setArmed(true), SHOW_AFTER_MS);
    return () => window.clearTimeout(t);
  }, [Boolean(part)]); // eslint-disable-line react-hooks/exhaustive-deps -- only whether a part is shown starts the wait, not which

  useEffect(() => {
    if (!want) return;
    const ask = () => {
      trail.current = undefined;
      askedAt.current = performance.now();
      setUrl(latest.current);
      if (latest.current) preload(latest.current).catch(() => {});
    };
    if (performance.now() - askedAt.current >= FRAME_EVERY_MS) ask();
    else trail.current ??= window.setTimeout(ask, FRAME_EVERY_MS);
  }, [want]);
  useEffect(() => () => window.clearTimeout(trail.current), []);

  const body = !clip ? null : take ? (
    <PeekFrame url={url} w={size.w} h={size.h} className="mx-auto" />
  ) : clip.kind === "still" && clip.still ? (
    <PeekFrame url={fileUrl(clip.still.id)} w={size.w} h={size.h} className="mx-auto" />
  ) : (
    <PeekEmpty w={CARD.w}>{clip.job ? (clip.job.status === "running" ? "Rendering now" : "Queued") : clip.failed ? "The render failed" : "Not rendered yet"}</PeekEmpty>
  );
  return { armed, body };
}
