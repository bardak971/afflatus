import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Film } from "lucide-react";
import { api, fileUrl, type Clip, type RunningJob, type Take, type Timeline } from "../api";
import { phaseLabel } from "../format";
import { LivePreview } from "../LivePreview";
import { cx } from "../ui";

/** How long before a clip ends the clip after starts running hidden, so that it takes over with frames ready and in step. */
const PREROLL_MS = 800;
/** How early the cut to the clip after is made: a video frame at 48 a second plus the animation frame the check may be late by. */
const CUT_EARLY_MS = 24;

export interface PlayerHandle {
  /** Go to a moment of what plays. */
  seek(ms: number): void;
  /** The picture full screen, or back. */
  fullscreen(): void;
  /** The clip on screen and the moment of it that is shown (`assetMs`: in its video's own time). */
  where(): { clip: Clip; localMs: number; assetMs: number } | null;
}

/**
 * Plays the timeline: its clips one after the other, each from where it starts playing to where it
 * stops (the frames a clip shares with its neighbour are skipped), pictures held for their time, each
 * clip's sound as it is set, and the music under all of it. The next clip is loaded and waiting under
 * the one on screen, so that the change is not seen.
 */
export const Player = forwardRef<PlayerHandle, {
  clips: Clip[];
  music: Timeline["music"];
  /** The timeline's frame: clips of another shape are shown inside it, with bars or filling it. */
  frame: { width: number; height: number } | null;
  playing: boolean;
  onPlaying(playing: boolean): void;
  onTime(ms: number): void;
  /** A take being looked at before it is chosen. */
  preview: Take | null;
  /** The clip that is rendering, when what is forming is to be watched here, and which clip it is. */
  live?: { job: RunningJob; clip: number } | null;
  /** How loud it plays here, 0 to 1, over the timeline's own mix (the clips' and the music's volumes stay as set). */
  master?: number;
  /** The previewed take was clicked: it becomes the one that plays. */
  onPickPreview?(take: Take): void;
  onStop?(job: string): void;
  /** The timeline, for the colour matching at the joins (the export's, shown here too). */
  timeline?: string;
}>(function Player({ clips, music, frame, playing, onPlaying, onTime, preview, live, onStop, timeline, master = 1, onPickPreview }, ref) {
  const masterRef = useRef(master);
  masterRef.current = master;
  const seq = useMemo(() => clips.filter((c) => c.lengthMs > 0 && (c.take || c.still)), [clips]);
  // each clip's colour nudge toward the clip before at their join, as the export applies it: shown here as a colour matrix on the video
  const matches = useQuery({
    queryKey: ["match", timeline, clips.map((c) => `${c.take?.id ?? c.still?.id ?? "-"}:${c.take?.startMs ?? 0}:${c.take?.endMs ?? 0}`).join(",")],
    queryFn: () => api.matches(timeline!),
    enabled: Boolean(timeline) && clips.some((c) => c.take),
    staleTime: 5 * 60_000,
  });
  const nudges = useMemo(() => new Map((matches.data?.items ?? []).filter((m) => m.y || m.u || m.v).map((m) => [m.clip, m])), [matches.data]);
  /** The nudge as RGB offsets (0 to 1) for an SVG colour matrix: luma to all three, the chroma planes by BT.601. */
  const rgbOf = (m: { y: number; u: number; v: number }) => ({ r: (m.y + 1.402 * m.v) / 255, g: (m.y - 0.344 * m.u - 0.714 * m.v) / 255, b: (m.y + 1.772 * m.u) / 255 });
  const total = seq.reduce((sum, c) => sum + c.lengthMs, 0);
  const [cur, setCur] = useState(0);
  const els = useRef(new Map<string, HTMLVideoElement>());
  const clipSound = useRef<HTMLAudioElement>(null);
  const musicEl = useRef<HTMLAudioElement>(null);
  /** Where the clip on screen is, and when that was last worked out (a picture has no clock of its own). */
  const pos = useRef({ key: "", local: 0, at: 0 });
  const said = useRef(0);
  const at = Math.min(cur, Math.max(0, seq.length - 1));
  const now = seq[at];
  const next = seq[at + 1];
  /** The clip before stays on the page, hidden: a loop back to it (or a step back) finds its video ready, not loading. */
  const prior = at > 0 ? seq[at - 1] : undefined;
  const keyOf = (c: Clip) => c.take?.id ?? `still:${c.id}`;
  const startOf = (c: Clip) => c.take?.startMs ?? 0;
  /** How long the next clip fades in over the end of this one: a clip that extends the one before, over the frames they share (as the export does). */
  const blendOf = (c: Clip | undefined, from: Clip | undefined) => {
    if (!c?.take || !from) return 0;
    // landed on by the clip before: both show the same moments around the take-over point, inside that clip's guided tail
    if (c.take.landedMs) {
      const x = Math.min(170, c.take.landedMs, c.lengthMs - 40, from.lengthMs - 40);
      return x >= 80 ? x : 0;
    }
    return 0;
  };
  /**
   * A continuation dissolves in over the clip before, which holds its last frame, over 170 ms as the export does (DISSOLVE_MS:
   * longer doubled a moving subject).
   */
  const dissolveOf = (c: Clip | undefined, from: Clip | undefined) => {
    // decoded as one piece with the clip before: a plain cut is the whole chain decoded at once
    if (!c?.take || !from?.take || c.take.landedMs || c.joined !== "continue" || c.take.seamless) return 0;
    if (c.take.headMs - c.take.trimStartMs < 80) return 0;
    const x = Math.min(170, c.lengthMs - 40);
    return x >= 80 ? x : 0;
  };
  /** The clip before, held on its last frame under the one dissolving in. */
  const [frozen, setFrozen] = useState<Clip | null>(null);
  const thaw = useRef(0);
  /** The next clip is fading in, over this many ms. */
  const [fading, setFading] = useState(0);
  const fadeOn = useRef(false);
  /**
   * How late a video runs after it is told to play from a moment: it is started that much ahead. Learned at every join
   * (60 to 85 ms measured). Kept in step by its speed instead, it was in step at the take-over but its frames then came
   * unevenly (one display refresh, then five) for most of a second after it, at every join (2026-10-08).
   */
  const startLag = useRef(70);
  /** When the clip after was started, and whether it was checked once since. */
  const started = useRef({ at: 0, checked: false });
  /** The clip after has shown its first frame (it is on screen already): the take-over is now. */
  const handReady = useRef(false);
  /** The clip after is watched on its own frames for the take-over. */
  const armed = useRef(false);
  /** The fade of the clip after has begun (from then on it is not moved: a jump would show). */
  const fadedIn = useRef(false);

  /** The music follows the playhead: at the same moment, as loud as its fades say. */
  const tuneMusic = useCallback(
    (global: number, force = false) => {
      const el = musicEl.current;
      if (!el || !music) return;
      const length = music.asset.durationMs || total;
      const heard = Math.min(total, length);
      const fadeIn = music.fadeInMs ? Math.min(1, global / music.fadeInMs) : 1;
      const fadeOut = music.fadeOutMs ? Math.min(1, Math.max(0, heard - global) / music.fadeOutMs) : 1;
      el.volume = Math.max(0, Math.min(1, (music.volume / 100) * fadeIn * fadeOut * masterRef.current));
      if (global >= length - 30) return void el.pause();
      if (force || Math.abs(el.currentTime * 1000 - global) > 280) el.currentTime = global / 1000;
    },
    [music, total],
  );

  const place = useCallback(
    (index: number, local: number, onward = false) => {
      const c = seq[index];
      if (!c) return;
      pos.current = { key: keyOf(c), local, at: performance.now() };
      fadeOn.current = false;
      fadedIn.current = false;
      handReady.current = false;
      armed.current = false;
      // a seek ends a dissolve; the hand-over to the clip after starts one (see step)
      if (!onward) {
        window.clearTimeout(thaw.current);
        setFrozen(null);
      }
      setFading(0);
      setCur(index);
      const el = c.take ? els.current.get(c.take.id) : undefined;
      // (set only when it differs: even an unchanged speed set on a playing video can stall its picture)
      if (el && el.playbackRate !== 1) el.playbackRate = 1;
      // a seek on a video already there (it was started early, see step) would stall it for a frame
      // (handing over to the clip after as it plays: it runs where it should within a few frames; only a stray one is moved)
      if (el && Math.abs(el.currentTime * 1000 - (startOf(c) + local)) > (onward ? 120 : 40)) el.currentTime = (startOf(c) + local) / 1000;
      if (clipSound.current) clipSound.current.currentTime = local / 1000;
      // the music goes on as it plays when the clips hand over; a jump is only for a seek
      tuneMusic(c.atMs + local, !onward);
      onTime(c.atMs + local);
    },
    [seq, onTime, tuneMusic],
  );

  useImperativeHandle(
    ref,
    () => ({
      seek(ms) {
        let i = seq.findIndex((c) => ms < c.atMs + c.lengthMs);
        if (i < 0) i = seq.length - 1;
        const c = seq[i];
        if (c) place(i, Math.max(0, Math.min(c.lengthMs, ms - c.atMs)));
      },
      fullscreen() {
        // the picture alone: the stage with what plays on it
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
        else void box.current?.requestFullscreen().catch(() => {});
      },
      where() {
        const c = seq[at];
        if (!c) return null;
        const local = pos.current.key === keyOf(c) ? pos.current.local : 0;
        return { clip: c, localMs: local, assetMs: startOf(c) + local };
      },
    }),
    [seq, at, place],
  );

  // the clip on screen redrawn as the one that plays: the opacity set by hand at the take-over is the page's again
  useEffect(() => {
    for (const v of els.current.values()) if (v.style.opacity) v.style.opacity = "";
  }, [at]);

  // what is heard of the clip on screen
  const nowKey = now ? keyOf(now) : "";
  useEffect(() => {
    if (!now?.take) return;
    const el = els.current.get(now.take.id);
    if (!el) return;
    el.muted = now.sound !== "own";
    el.volume = Math.max(0, Math.min(1, (now.volume / 100) * master));
  }, [now?.take, now?.sound, now?.volume, nowKey, master]);
  useEffect(() => {
    if (clipSound.current) clipSound.current.volume = Math.max(0, Math.min(1, ((now?.volume ?? 100) / 100) * master));
    // the music too, at once (it is retuned as it plays)
    if (musicEl.current && music && !playing) musicEl.current.volume = Math.max(0, Math.min(1, (music.volume / 100) * master));
  }, [now?.volume, nowKey, master]);

  useEffect(() => {
    for (const [id, el] of els.current) if (id !== now?.take?.id || !playing) el.pause();
    if (!playing) {
      clipSound.current?.pause();
      musicEl.current?.pause();
      return;
    }
    pos.current.at = performance.now();
    if (now?.take) {
      const el = els.current.get(now.take.id);
      // a video just put on the page plays only once it knows where to start (its metadata sets the moment): started
      // before, it played from its first frame and the range's loop looked as if it went back to the clip's start
      const go = () => void el?.play().catch(() => onPlaying(false));
      if (el && el.readyState < 1) el.addEventListener("loadedmetadata", go, { once: true });
      else go();
    }
    void clipSound.current?.play().catch(() => {});
    if (music && now && now.atMs + pos.current.local < (music.asset.durationMs || total) - 30) void musicEl.current?.play().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, nowKey, onPlaying, Boolean(music)]);

  // looked at on every frame while it plays; the video's own clock also calls it, because a browser
  // stops drawing frames for a tab that is not in front while the video goes on playing
  const step = useRef<() => boolean>(() => false);
  useEffect(() => {
    if (!playing) return;
    let frameId = 0;
    step.current = () => {
      const c = seq[at];
      if (!c) return true;
      const el = c.take ? els.current.get(c.take.id) : undefined;
      if (c.take && !el) return true;
      const t = performance.now();
      const local = el ? el.currentTime * 1000 - startOf(c) : pos.current.local + (t - pos.current.at);
      // a frame early rather than late: late, the clip before shows the moment the clip after opens on, and it is seen twice.
      // When the clip after runs (it was started early), the change waits until it is at its start: a video a frame or two
      // behind would show a moment again; this one has real frames past its end (the ones they share) to show meanwhile
      const following = seq[at + 1];
      const followEl = following?.take ? els.current.get(following.take.id) : undefined;
      // how far it is behind the moment this one shows (they show the same moments around the change)
      const behind = followEl && !followEl.paused && fadeOn.current ? startOf(following!) + (local - c.lengthMs) - followEl.currentTime * 1000 : 0;
      // watched on its own frames (see arm): it takes over when it shows its first one, or late at the latest; else as before
      const watched = armed.current;
      const due = handReady.current || (watched ? local >= c.lengthMs + 100 : local >= c.lengthMs - CUT_EARLY_MS && (behind <= 12 || local >= c.lengthMs + 100));
      if (due || el?.ended) {
        if (seq[at + 1]) {
          // a continuation dissolves in: this clip stops on its last frame and stays under it meanwhile
          const following = seq[at + 1]!;
          const dissolve = dissolveOf(following, c);
          if (dissolve && el) {
            el.pause();
            window.clearTimeout(thaw.current);
            setFrozen(c);
            thaw.current = window.setTimeout(() => setFrozen(null), dissolve + 60);
            const nextVideo = following.take ? els.current.get(following.take.id) : undefined;
            nextVideo?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: dissolve, easing: "linear" });
          }
          // shown at once, before the page redraws: waiting for the redraw held this clip's last frame a frame or two longer (the
          // clip after then appeared ahead, a frame skipped). The page's own state takes over at its next redraw (see below)
          const nextShown = following.take ? els.current.get(following.take.id) : undefined;
          if (!dissolve && nextShown) nextShown.style.opacity = "1";
          // it takes over where this one got to: the playhead runs on without a step
          place(at + 1, Math.max(0, local - c.lengthMs), true);
        } else {
          pos.current = { key: keyOf(c), local: c.lengthMs, at: t };
          onTime(c.atMs + c.lengthMs);
          onPlaying(false);
        }
        return false;
      }
      // the clip after starts running a little early, hidden and muted, so that it has frames decoded and is in
      // step at the moment it takes over (a video started cold at the cut shows black for a frame, then rushes).
      // It runs exactly where it must be to arrive at its start when this clip ends: started ahead of that, the
      // take-over had to seek it back, which stalled the picture and held the playhead at every join
      const after = seq[at + 1];
      const blend = blendOf(after, c);
      const remaining = c.lengthMs - local;
      const nextEl = after?.take ? els.current.get(after.take.id) : undefined;
      const expected = after ? startOf(after) - remaining : 0;
      const lag = startLag.current;
      /**
       * The take-over on the clip after's own clock: the moment it puts its first frame on screen it is shown (in that very
       * frame), and the step below hands over. Decided on this clip's clock instead, the change waited for the next redraw
       * and this clip's last frame stayed up two refreshes too long, at every join (2026-10-08). Not for a fade or a dissolve.
       */
      const arm = (v: HTMLVideoElement, first: number) => {
        if (blend || dissolveOf(after, c) || !("requestVideoFrameCallback" in v)) return;
        armed.current = true;
        const watch = (_now: number, meta: { mediaTime: number }) => {
          if (!fadeOn.current || handReady.current) return;
          if (meta.mediaTime * 1000 >= first - 4) {
            v.style.opacity = "1";
            // heard from the same frame (it ran silent by its volume)
            if (after) v.volume = Math.max(0, Math.min(1, (after.volume / 100) * masterRef.current));
            handReady.current = true;
          } else v.requestVideoFrameCallback(watch);
        };
        v.requestVideoFrameCallback(watch);
      };
      if (nextEl && !fadeOn.current && remaining <= PREROLL_MS) {
        fadeOn.current = true;
        // silent by its volume, not muted: unmuted at the take-over, a playing video starts its sound and its picture stalled
        // there for two or three frames (its first frame stayed up ~45 ms, measured 2026-10-08); a volume change costs nothing
        nextEl.muted = after?.sound !== "own";
        nextEl.volume = 0;
        if (nextEl.playbackRate !== 1) nextEl.playbackRate = 1;
        // all but invisible, not invisible: a video at opacity 0 is not kept drawn, and shown it put its first frame up a display
        // refresh late at every join; at 0.4 % it is drawn and costs nothing to show (only this one: every hidden video drawn
        // made the frames come unevenly elsewhere). A fade or a dissolve brings it in itself
        if (!blend && !dissolveOf(after, c)) nextEl.style.opacity = "0.004";
        // started ahead by the delay it will lose; a clip that starts at its very first frame waits there, paused on it
        nextEl.currentTime = Math.max(0, expected + lag) / 1000;
        if (expected + lag >= 0) {
          void nextEl.play().catch(() => {});
          started.current = { at: t, checked: false };
          if (after) arm(nextEl, startOf(after));
        }
      }
      if (nextEl && fadeOn.current) {
        // one that waited on its first frame starts when it is due, as early as it will be late
        if (nextEl.paused && expected + lag >= 0 && remaining > 30) {
          void nextEl.play().catch(() => {});
          started.current = { at: t, checked: false };
          if (after) arm(nextEl, startOf(after));
        } else if (!nextEl.paused && !started.current.checked && t - started.current.at > 200 && expected >= 0) {
          // once, out of sight, when it has settled: how far off it runs teaches the next join, and a stray start is set right
          // with one seek here (never near the take-over, never by its speed)
          started.current.checked = true;
          const off = expected - nextEl.currentTime * 1000;
          startLag.current = Math.max(0, Math.min(200, lag + off * 0.7 + 4));
          if (Math.abs(off) > 20 && remaining > 300) nextEl.currentTime = (expected + startLag.current) / 1000;
        }
      }
      // over its last frames, a clip that fades in over this one shows, over the moments they share
      if (nextEl && blend && !fadedIn.current && remaining <= blend) {
        fadedIn.current = true;
        setFading(Math.max(40, remaining));
      }
      // the playhead runs on: a clip that took over a few ms behind its start shows its first frames meanwhile
      if (local > -400) {
        pos.current = { key: keyOf(c), local: Math.max(0, local), at: t };
        tuneMusic(c.atMs + Math.max(0, local));
        // the screen around the video does not need every frame's time
        if (t - said.current > 66) {
          said.current = t;
          onTime(c.atMs + Math.max(0, local));
        }
      }
      return true;
    };
    const tick = () => {
      if (step.current()) frameId = requestAnimationFrame(tick);
    };
    frameId = requestAnimationFrame(tick);
    // a picture has no video to keep time when the tab is not in front
    const slow = setInterval(() => step.current(), 250);
    return () => {
      cancelAnimationFrame(frameId);
      clearInterval(slow);
      step.current = () => false;
    };
  }, [playing, at, seq, place, onPlaying, onTime, tuneMusic]);

  // the screen: as large as fits, in the timeline's shape
  const box = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const read = () => setRoom({ w: el.clientWidth, h: el.clientHeight });
    read();
    const watch = new ResizeObserver(read);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  const shape = frame ?? (now?.take?.asset.width && now.take.asset.height ? { width: now.take.asset.width, height: now.take.asset.height } : now?.still?.width && now.still.height ? { width: now.still.width, height: now.still.height } : null);
  const ratio = shape ? shape.width / shape.height : 9 / 16;
  const w = Math.min(room.w, room.h * ratio);
  const h = ratio ? w / ratio : 0;

  return (
    <div ref={box} data-stage className="relative flex min-h-0 grow items-center justify-center bg-[#08090b]">
      {!now && !live && (
        <div className="flex flex-col items-center gap-2 text-ink-3">
          <Film size={28} />
          <span>The video plays here once a clip is rendered.</span>
        </div>
      )}
      {now && (
        <div className="relative overflow-hidden bg-black" style={{ width: w, height: h }}>
          {nudges.size > 0 && (
            <svg className="absolute h-0 w-0" aria-hidden="true">
              <defs>
                {[...new Set([now, next, frozen])].flatMap((c) => {
                  const m = c && nudges.get(c.id);
                  if (!m) return [];
                  const { r, g, b } = rgbOf(m);
                  return [
                    <filter key={c.id} id={`nudge-${c.id}`} colorInterpolationFilters="sRGB">
                      <feColorMatrix type="matrix" values={`1 0 0 0 ${r.toFixed(4)}  0 1 0 0 ${g.toFixed(4)}  0 0 1 0 ${b.toFixed(4)}  0 0 0 1 0`} />
                    </filter>,
                  ];
                })}
              </defs>
            </svg>
          )}
          {[frozen && frozen !== now && frozen !== next ? frozen : prior !== now && prior !== next ? prior : undefined, now, next].map((c) =>
            !c ? null : c.take ? (
              <video
                key={c.take.id}
                ref={(el) => {
                  if (el) els.current.set(c.take!.id, el);
                  else els.current.delete(c.take!.id);
                }}
                src={fileUrl(c.take.asset.id)}
                preload="auto"
                playsInline
                onLoadedMetadata={(e) => {
                  e.currentTarget.currentTime = (c.take!.startMs + (pos.current.key === c.take!.id ? pos.current.local : 0)) / 1000;
                  if (c === now) {
                    e.currentTarget.muted = c.sound !== "own";
                    e.currentTarget.volume = Math.max(0, Math.min(1, (c.volume / 100) * masterRef.current));
                  }
                }}
                onTimeUpdate={() => c === now && step.current()}
                onEnded={() => c === now && step.current()}
                onClick={() => onPlaying(!playing)}
                style={{ ...(c !== now && fading ? { transition: `opacity ${fading}ms linear` } : {}), ...(nudges.has(c.id) ? { filter: `url(#nudge-${c.id})` } : {}) }}
                className={cx("absolute inset-0 h-full w-full", c.fill ? "object-cover" : "object-contain", c === now ? "opacity-100" : fading || c === frozen ? "pointer-events-none opacity-100" : "pointer-events-none opacity-0")}
              />
            ) : (
              <img
                key={`still:${c.id}`}
                src={fileUrl(c.still!.id)}
                alt=""
                onClick={() => onPlaying(!playing)}
                className={cx("absolute inset-0 h-full w-full", c.fill ? "object-cover" : "object-contain", c === now ? "opacity-100" : "pointer-events-none opacity-0")}
              />
            ),
          )}
          {preview && (
            <>
              <video
                key={`preview:${preview.id}`}
                src={fileUrl(preview.asset.id)}
                autoPlay
                muted
                loop
                playsInline
                onLoadedMetadata={(e) => (e.currentTarget.currentTime = preview.startMs / 1000)}
                onClick={() => onPickPreview?.(preview)}
                className="absolute inset-0 h-full w-full cursor-pointer bg-black object-contain"
              />
              <span className="absolute top-3 left-1/2 -translate-x-1/2 rounded-full bg-ground/85 px-3 py-1 text-xs font-semibold whitespace-nowrap">Previewing this take. Click it to make it the one that plays.</span>
            </>
          )}
        </div>
      )}
      {now?.sound === "file" && now.soundAsset && <audio key={`${now.id}:${now.soundAsset.id}`} ref={clipSound} src={fileUrl(now.soundAsset.id)} preload="auto" onLoadedMetadata={(e) => (e.currentTarget.currentTime = (pos.current.key === nowKey ? pos.current.local : 0) / 1000)} />}
      {music && <audio key={music.asset.id} ref={musicEl} src={fileUrl(music.asset.id)} preload="auto" />}
      {/* the clip that is rendering, watched large: what is forming each step, with its sound. Playing the timeline puts it away */}
      {live && !playing && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#08090b]">
          {live.job.previewSeq > 0
            ? <LivePreview job={live.job} sound className="h-full w-full object-contain" />
            : <span className="text-ink-2">Clip {live.clip} is generating. The live preview shows here from its first step.</span>}
          <span className="absolute top-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full bg-ground/85 py-1 pr-1 pl-3 text-xs font-semibold whitespace-nowrap">
            Clip {live.clip} · {phaseLabel(live.job.phase)}{live.job.steps ? ` · step ${live.job.step} of ${live.job.steps}` : ""}
            {onStop && <button type="button" onClick={() => onStop(live.job.id)} title="Stop this render. Nothing is added; the clip keeps the takes it has." className="rounded-full border border-line-strong px-2.5 py-0.5 hover:bg-hover">Stop</button>}
          </span>
        </div>
      )}
    </div>
  );
});
