import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { fileUrl, type Asset, type RemovedPart } from "../api";
import { clock } from "../format";
import type { PlayerHandle } from "./Player";

/**
 * The source lane in the stage: its video shown where the playhead stands on it (the track's own time; `atMs` is where the
 * video's start sits), played and scrubbed with the timeline's own transport, as a clip is. Before its start and past its end:
 * its first or last frame. A badge says where in the video it stands, and whether that is inside the stretch made into clips.
 * Picking (a swap's who is replaced): the stretch's first frame is shown and a click on it is the person; the person picked
 * is marked on that frame whenever it shows.
 */
export const SourceStage = forwardRef<PlayerHandle, {
  video: Asset;
  atMs: number;
  fromMs: number;
  toMs: number;
  /** The timeline's frame, the stage's shape. */
  frame: { width: number; height: number } | null;
  playing: boolean;
  onPlaying(playing: boolean): void;
  /** Where it stands, in the track's own time. */
  onTime(ms: number): void;
  /** Where the playhead stood when the stage turned to the source. */
  startAt: number;
  master?: number;
  /** A moment of the video to show while the source is dragged on its lane (its new start or end); null otherwise. */
  peekMs?: number | null;
  /** The person a swap replaces, clicked on the stretch's first frame (shares of the picture); marked there. */
  pick?: { x: number; y: number } | null;
  /** Waiting for that click: the first frame shown, a click on it is the person, Esc gives up. */
  picking?: boolean;
  onPick?(point: { x: number; y: number }): void;
  onPickEnd?(): void;
  /**
   * A video drawn over a part of the source, in step with it (a swap's Show the mask: the window's masks over its frames):
   * from `startMs` of the source, `lengthMs` long. Muted: the sound stays the source's.
   */
  overlay?: { src: string; startMs: number; lengthMs: number } | null;
  /** The stretches cut out of its middle by removing their windows (card #75): the clips jump over them, the badge says so. */
  removed?: RemovedPart[];
}>(function SourceStage({ video, atMs, fromMs, toMs, frame, playing, onPlaying, onTime, startAt, master = 1, peekMs = null, pick = null, picking = false, onPick, onPickEnd, overlay = null, removed = [] }, ref) {
  const el = useRef<HTMLVideoElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [local, setLocal] = useState(Math.max(0, startAt - atMs));
  const length = video.durationMs ?? toMs;
  const put = (trackMs: number) => {
    const v = el.current;
    const ms = Math.max(0, Math.min(length, trackMs - atMs));
    if (v) v.currentTime = ms / 1000;
    setLocal(ms);
    onTime(atMs + ms);
  };
  useImperativeHandle(ref, () => ({
    seek: put,
    fullscreen() {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
      else void box.current?.requestFullscreen().catch(() => {});
    },
    // a frame of the source is not a clip's: Save frame and Extend have nothing to act on here
    where: () => null,
  }));
  // dragged on its lane: the frame where it would start (or stop) shows as it moves, and stays once let go
  useEffect(() => {
    if (peekMs === null) return;
    const v = el.current;
    // the latest asked wins: a seek under way is taken over by the next one
    if (v) v.currentTime = peekMs / 1000;
    setLocal(peekMs);
  }, [peekMs]);
  // the video laid elsewhere under the track (its new start kept where the clips go): the playhead follows the frame shown
  const localNow = useRef(local);
  localNow.current = local;
  useEffect(() => {
    onTime(atMs + localNow.current);
  }, [atMs]); // eslint-disable-line react-hooks/exhaustive-deps -- when the source moves on the track
  // the playhead stands on the source from the start: where it was, or the stretch's start
  useEffect(() => {
    onTime(atMs + Math.max(0, Math.min(length, startAt - atMs)));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- once, as the stage turns to the source
  // played with the transport: the playhead follows it, said 15 times a second
  const played = useRef(false);
  useEffect(() => {
    const v = el.current;
    if (!v) return;
    if (!playing) {
      v.pause();
      // stopped between two moments said: the playhead on the frame it stopped on
      if (played.current) onTime(atMs + v.currentTime * 1000);
      played.current = false;
      return;
    }
    played.current = true;
    if (v.currentTime * 1000 >= length - 40) v.currentTime = 0;
    void v.play().catch(() => onPlaying(false));
    let id = 0;
    let said = -Infinity;
    const tick = (now: number) => {
      const ms = v.currentTime * 1000;
      setLocal(ms);
      // said to the editor 15 times a second, as the recording's stage does: the playhead, the readout and the panels redrew at
      // every frame
      if (now - said > 66 || v.ended) {
        said = now;
        onTime(atMs + ms);
      }
      if (v.ended) onPlaying(false);
      else id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [playing, atMs, length]); // eslint-disable-line react-hooks/exhaustive-deps -- the loop starts again only when what plays changes
  useEffect(() => {
    if (el.current) el.current.volume = Math.max(0, Math.min(1, master));
  }, [master]);
  // picking: the stretch's first frame, still, where the swap's first window starts; Esc gives up before the editor's own keys
  useEffect(() => {
    if (!picking) return;
    onPlaying(false);
    put(atMs + fromMs);
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onPickEnd?.();
    };
    window.addEventListener("keydown", esc, true);
    return () => window.removeEventListener("keydown", esc, true);
  }, [picking, fromMs]); // eslint-disable-line react-hooks/exhaustive-deps -- once as picking starts, again if the stretch's start moves

  // the overlay follows the source: played with it (put back when it drifts a few frames), or still on the same moment
  const ov = useRef<HTMLVideoElement>(null);
  const overlaid = Boolean(overlay && local >= overlay.startMs && local < overlay.startMs + overlay.lengthMs);
  useEffect(() => {
    const o = ov.current;
    if (!o || !overlay) return;
    const t = (local - overlay.startMs) / 1000;
    if (!overlaid) return void o.pause();
    if (playing) {
      if (o.paused) void o.play().catch(() => {});
      if (Math.abs(o.currentTime - t) > 0.12) o.currentTime = t;
    } else {
      o.pause();
      if (Math.abs(o.currentTime - t) > 0.02) o.currentTime = t;
    }
  }, [local, playing, overlaid, overlay?.src]); // eslint-disable-line react-hooks/exhaustive-deps -- the overlay's own times are read from it

  const [room, setRoom] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const b = box.current;
    if (!b) return;
    const read = () => setRoom({ w: b.clientWidth, h: b.clientHeight });
    read();
    const watch = new ResizeObserver(read);
    watch.observe(b);
    return () => watch.disconnect();
  }, []);
  const shape = frame ?? (video.width && video.height ? { width: video.width, height: video.height } : { width: 9, height: 16 });
  const ratio = shape.width / shape.height;
  const w = Math.min(room.w, room.h * ratio);
  const inside = local >= fromMs && local <= toMs;
  const cutOut = removed.find((r) => local >= r.fromMs && local < r.toMs);
  // the video's own picture within the frame (object-contain): the click and the mark are shares of it, not of the frame
  const vr = video.width && video.height ? video.width / video.height : ratio;
  const fh = ratio ? w / ratio : 0;
  const pw = vr >= ratio ? w : fh * vr;
  const ph = vr >= ratio ? w / vr : fh;
  const at = { left: (w - pw) / 2, top: (fh - ph) / 2 };
  const onFirst = Math.abs(local - fromMs) < 60;
  const clicked = (e: MouseEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - box.left - at.left) / pw;
    const y = (e.clientY - box.top - at.top) / ph;
    // outside the picture (its bars): nobody there
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    onPick?.({ x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 });
  };
  return (
    <div ref={box} data-stage className="relative flex min-h-0 grow items-center justify-center bg-stage">
      {/* design: the letterbox is black whatever the theme, as the video's own bars are */}
      <div className="relative overflow-hidden bg-black" style={{ width: w, height: fh }}>
        <video
          key={video.id}
          ref={el}
          src={fileUrl(video.id)}
          preload="auto"
          playsInline
          onLoadedMetadata={(e) => (e.currentTarget.currentTime = local / 1000)}
          onClick={() => onPlaying(!playing)}
          className="absolute inset-0 h-full w-full object-contain"
        />
        {overlay && (
          <video
            key={overlay.src}
            ref={ov}
            src={overlay.src}
            muted
            preload="auto"
            playsInline
            aria-label="The mask over the source"
            onClick={() => onPlaying(!playing)}
            className={overlaid ? "absolute inset-0 h-full w-full object-contain" : "hidden"}
          />
        )}
        {pick && onFirst && !picking && (
          <span
            className="pointer-events-none absolute flex -translate-x-1/2 -translate-y-1/2 items-center gap-1.5"
            style={{ left: at.left + pick.x * pw, top: at.top + pick.y * ph }}
          >
            <span className="flex size-6 items-center justify-center rounded-full bg-accent text-xs font-bold text-accent-ink ring-4 ring-accent/30">1</span>
            <span className="rounded-md bg-ground/85 px-1.5 py-0.5 text-xs font-semibold">Replaced</span>
          </span>
        )}
        {picking && <div aria-label="Click the person to replace" className="absolute inset-0 cursor-crosshair" onClick={clicked} />}
      </div>
      {picking ? (
        <span className="absolute top-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border border-accent bg-ground/90 px-3 py-1 text-xs whitespace-nowrap">
          <span className="font-semibold">Click the person to replace</span>
          <span className="text-ink-2">on the stretch's first frame, {clock(fromMs, { decimals: 1 })}</span>
          <kbd className="rounded border border-line px-1.5 font-mono text-meta text-ink-2">Esc</kbd>
        </span>
      ) : (
        <span className="absolute top-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full bg-ground/85 px-3 py-1 text-xs font-semibold whitespace-nowrap">
          Source · {clock(local, { decimals: 1 })} of {clock(length)}
          {cutOut ? (
            <span data-removed="" className="text-warn-ink">· cut out, {clock(cutOut.fromMs, { decimals: 1 })}–{clock(cutOut.toMs, { decimals: 1 })} set aside: the clips jump over it</span>
          ) : (
            <span className={inside ? "text-accent" : "text-ink-3"}>{inside ? "· in the stretch" : local < fromMs ? "· before the stretch" : "· past the stretch"}</span>
          )}
        </span>
      )}
    </div>
  );
});
