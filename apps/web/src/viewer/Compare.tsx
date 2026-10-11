import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { ChevronsLeftRight } from "lucide-react";
import { fileUrl, type Asset } from "../api";
import { Keys } from "../Keys";
import { useKeysHere } from "../keys/here";
import { useFamilyName } from "../data";
import { Button, cx } from "../ui";
import { AudioPlayer } from "../AudioPlayer";
import { VideoPlayer } from "../VideoPlayer";

/** Keeps the second video in step with the first: play, pause, seeks and the rate follow it; a drift past a frame or two is corrected. */
function useInStep(master: RefObject<HTMLVideoElement | null>, other: RefObject<HTMLVideoElement | null>, key: string) {
  useEffect(() => {
    const m = master.current;
    const o = other.current;
    if (!m || !o) return;
    const follow = () => {
      if (Math.abs(o.currentTime - m.currentTime) > 0.06) o.currentTime = m.currentTime;
    };
    const onPlay = () => {
      follow();
      void o.play().catch(() => {});
    };
    const onPause = () => {
      o.pause();
      follow();
    };
    const onRate = () => {
      o.playbackRate = m.playbackRate;
    };
    m.addEventListener("play", onPlay);
    m.addEventListener("pause", onPause);
    m.addEventListener("seeked", follow);
    m.addEventListener("timeupdate", follow);
    m.addEventListener("ratechange", onRate);
    return () => {
      m.removeEventListener("play", onPlay);
      m.removeEventListener("pause", onPause);
      m.removeEventListener("seeked", follow);
      m.removeEventListener("timeupdate", follow);
      m.removeEventListener("ratechange", onRate);
    };
  }, [master, other, key]);
}

/**
 * The wipe's line on the two pictures: dragged anywhere on them (a press moves it there), or by its round
 * handle with the keyboard: ←/→ a step, Shift ten, Home/End the edges. Its arrows are not the viewer's.
 */
function Wipe({ pinned, other, at, onAt, said }: { pinned: Asset; other: Asset; at: number; onAt(at: number): void; said(a: Asset): string }) {
  const box = useRef<HTMLDivElement>(null);
  // the room it has, measured, and the box the pinned picture fits in it at its own shape: both pictures are drawn in that box.
  // Sized from the window's height instead, it ran under the buttons below the stage, and the second picture, fitted to a box
  // cut shorter than the first, came out narrower than it
  const area = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    const measure = () => setRoom({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  const [natural, setNatural] = useState<number | null>(null);
  const shape = pinned.width && pinned.height ? pinned.width / pinned.height : natural ?? 1;
  const fit = room && room.w > 0 && room.h > 0 ? (room.w / room.h > shape ? { w: room.h * shape, h: room.h } : { w: room.w, h: room.w / shape }) : null;
  const [dragging, setDragging] = useState(false);
  const clamp = (v: number) => Math.max(0, Math.min(100, v));
  const toPointer = (clientX: number) => {
    const r = box.current?.getBoundingClientRect();
    if (r && r.width > 0) onAt(clamp(Math.round(((clientX - r.left) / r.width) * 1000) / 10));
  };
  const label = "absolute bottom-2.5 max-w-[45%] truncate rounded-md bg-black/60 px-1.5 py-0.5 font-mono text-[11px] text-white";
  return (
    <div ref={area} className="absolute inset-0 flex items-center justify-center">
    {/* the two pictures in one box: the second drawn over the first and cut at the line */}
    <div
      ref={box}
      style={fit ? { width: fit.w, height: fit.h } : { visibility: "hidden" }}
      className={cx("relative touch-none overflow-hidden rounded-lg select-none", dragging ? "cursor-grabbing" : "cursor-ew-resize")}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragging(true);
        toPointer(e.clientX);
      }}
      onPointerMove={(e) => dragging && toPointer(e.clientX)}
      onPointerUp={() => setDragging(false)}
      onPointerCancel={() => setDragging(false)}
    >
      <img src={fileUrl(pinned.id)} alt="" draggable={false} onLoad={(e) => setNatural(e.currentTarget.naturalWidth / (e.currentTarget.naturalHeight || 1))} className="absolute inset-0 h-full w-full object-contain" />
      <img src={fileUrl(other.id)} alt="" draggable={false} className="absolute inset-0 h-full w-full object-contain" style={{ clipPath: `inset(0 0 0 ${at}%)` }} />
      <div className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-white shadow-[0_0_6px_rgba(0,0,0,.5)]" style={{ left: `${at}%` }} />
      <div
        role="slider"
        tabIndex={0}
        aria-label="Wipe: where the second picture takes over"
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(at)}
        aria-valuetext={`${Math.round(at)} %`}
        data-tip="Drag the wipe (← →)"
        onKeyDown={(e) => {
          const step = e.shiftKey ? 10 : 1;
          const next = e.key === "ArrowLeft" ? at - step : e.key === "ArrowRight" ? at + step : e.key === "Home" ? 0 : e.key === "End" ? 100 : null;
          if (next === null) return;
          // the viewer's own arrows (another item) wait while the handle has the keys
          e.preventDefault();
          onAt(clamp(Math.round(next)));
        }}
        className="absolute top-1/2 flex h-9 w-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white text-[#151515] shadow-[0_2px_10px_rgba(0,0,0,.5)] outline-offset-2 focus-visible:outline-2 focus-visible:outline-accent"
        style={{ left: `${at}%` }}
      >
        <ChevronsLeftRight size={16} aria-hidden />
      </div>
      <span className={cx(label, "left-2.5")}>Pinned{said(pinned)}</span>
      <span className={cx(label, "right-2.5")}>This one{said(other)}</span>
    </div>
    </div>
  );
}

/**
 * Two items side by side: the one pinned, and the one the arrow keys move through. Videos play in step
 * from the pinned one's controls; two pictures can also be laid over each other with a wipe.
 */
export function Compare({ pinned, other, onSwap, onClose, keys }: {
  pinned: Asset;
  other: Asset;
  onSwap(): void;
  onClose(): void;
  /** Filled here for the viewer's keys: W lays the pictures over each other (or side by side again), Shift+X swaps them. */
  keys?: RefObject<{ wipe(): void; swap(): void } | null>;
}) {
  const left = useRef<HTMLVideoElement>(null);
  const right = useRef<HTMLVideoElement>(null);
  // pictures laid over each other: where the second one takes over, in percent of the width; null = side by side
  const [wipe, setWipe] = useState<number | null>(null);
  useInStep(left, right, `${pinned.id}:${other.id}`);
  // the keys sheet's "Here now": comparing is the viewer's (its arrows change the other one)
  useKeysHere("viewer", true, { kind: other.kind });
  const pictures = pinned.kind === "image" && other.kind === "image";
  const toggleWipe = () => setWipe((w) => (w === null ? 50 : null));
  if (keys) keys.current = { wipe: () => pictures && toggleWipe(), swap: onSwap };
  // two models compared (one draft tried on each): each side says which made it
  const familyName = useFamilyName();
  const models = Boolean(pinned.family && other.family && pinned.family !== other.family);
  const said = (a: Asset) => `${models ? ` · ${familyName(a.family!)}` : ""}${a.name ? ` · ${a.name}` : ""}`;
  const pane = (a: Asset, ref: RefObject<HTMLVideoElement | null>, label: string) => (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col items-center gap-1.5">
      <span className="max-w-full truncate text-xs text-ink-3">{label}{said(a)}</span>
      {/* each one in the middle of its half, whatever its shape and kind: a picture beside a video lines up with it */}
      <div className="flex min-h-0 w-full grow items-center justify-center">
      {a.kind === "video" ? (
        // the pinned one has the controls and the sound; the other follows it, silent
        <VideoPlayer asset={a.id} sound={a.hasSound} video={ref} controls={ref === left} barRoom muted={ref === right} className="h-full w-full justify-center" />
      ) : a.kind === "image" ? (
        <img key={a.id} src={fileUrl(a.id)} alt="" className="min-h-0 max-h-full max-w-full rounded-lg object-contain" />
      ) : (
        <AudioPlayer key={a.id} asset={a.id} className="w-full max-w-[520px]" />
      )}
      </div>
    </div>
  );
  return (
    <div className="flex min-h-0 min-w-0 grow flex-col gap-2 p-4" onClick={(e) => e.stopPropagation()}>
      {wipe === null || !pictures ? (
        <div className="flex min-h-0 grow items-stretch justify-center gap-3">
          {pane(pinned, left, "Pinned")}
          {pane(other, right, "This one")}
        </div>
      ) : (
        <div className="relative min-h-0 grow">
          <Wipe pinned={pinned} other={other} at={wipe} onAt={setWipe} said={said} />
        </div>
      )}
      <div className="flex shrink-0 flex-wrap items-center justify-center gap-2">
        {pictures && <Button size="sm" tone={wipe !== null ? "primary" : "plain"} aria-pressed={wipe !== null} data-tip="The two pictures over each other, the second cut at a line you move" onClick={toggleWipe}>Wipe <Keys keys="W" size="sm" /></Button>}
        <Button size="sm" data-tip="The pinned one becomes the one you move through, and the other way round" onClick={onSwap}>Swap <Keys keys="Shift+X" size="sm" /></Button>
        <span className="flex items-center gap-1 text-xs text-ink-3"><Keys keys="← →" size="sm" /> another one on the right{wipe !== null && pictures ? " · drag the line on the picture" : ""}</span>
        <Button size="sm" onClick={onClose}>Done <Keys keys="X" size="sm" /></Button>
      </div>
    </div>
  );
}
