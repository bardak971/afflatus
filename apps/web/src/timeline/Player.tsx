import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Film } from "lucide-react";
import { api, fileUrl, type Clip, type RunningJob, type Take, type Timeline } from "../api";
import { phaseLabel } from "../format";
import { LivePreview } from "../LivePreview";
import { FullscreenBar, type ScreenControls } from "./FullscreenBar";
import { cx } from "../ui";
import { playSignature } from "./model";
import { useHandover } from "./useHandover";

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
  /** The editor's transport, shown over the picture while the player fills the screen. */
  screen?: ScreenControls;
}>(function Player({ clips, music, frame, playing, onPlaying, onTime, preview, live, onStop, timeline, master = 1, onPickPreview, screen }, ref) {
  const masterRef = useRef(master);
  masterRef.current = master;
  // the clips that play, kept while what plays of them is the same: a timeline read again (a render's progress, a form
  // saved) does not restart the frame loop below, which follows this list
  const signature = playSignature(clips);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const seq = useMemo(() => clips.filter((c) => c.lengthMs > 0 && (c.take || c.still)), [signature]);
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
  /** The clip before, held on its last frame under the one dissolving in. */
  const [frozen, setFrozen] = useState<Clip | null>(null);
  const thaw = useRef(0);
  /** The next clip is fading in, over this many ms. */
  const [fading, setFading] = useState(0);
  const fadeOn = useRef(false);
  /** The clip after has shown its first frame (it is on screen already): the take-over is now. */
  const handReady = useRef(false);
  /** The clip after is watched on its own frames for the take-over. */
  const armed = useRef(false);
  /** The fade of the clip after has begun (from then on it is not moved: a jump would show). */
  const fadedIn = useRef(false);

  // the music ducked under speech, the curve the export applies too (asked again when what plays or the music changes)
  const duck = useQuery({
    queryKey: ["duck", timeline, music?.asset.id, music?.duck, music?.duckDb, clips.map((c) => `${c.id}:${c.take?.id}:${c.atMs}:${c.lengthMs}:${c.volume}:${c.sound}`).join(",")],
    queryFn: () => api.duck(timeline!),
    enabled: Boolean(timeline && music?.duck),
  });
  const curve = music?.duck ? duck.data?.curve ?? null : null;

  /** The music follows the playhead: at the same moment, as loud as its fades say, and ducked under speech. */
  const tuneMusic = useCallback(
    (global: number, force = false) => {
      const el = musicEl.current;
      if (!el || !music) return;
      const length = music.asset.durationMs || total;
      const heard = Math.min(total, length);
      const fadeIn = music.fadeInMs ? Math.min(1, global / music.fadeInMs) : 1;
      const fadeOut = music.fadeOutMs ? Math.min(1, Math.max(0, heard - global) / music.fadeOutMs) : 1;
      const ducked = curve ? curve.gains[Math.min(curve.gains.length - 1, Math.max(0, Math.floor((global / 1000) * curve.rate)))] ?? 1 : 1;
      el.volume = Math.max(0, Math.min(1, (music.volume / 100) * fadeIn * fadeOut * ducked * masterRef.current));
      if (global >= length - 30) return void el.pause();
      if (force || Math.abs(el.currentTime * 1000 - global) > 280) el.currentTime = global / 1000;
    },
    [music, total, curve],
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

  // the frame loop while it plays, and the hand-over from one clip to the next (useHandover.ts)
  const step = useHandover({ seq, at, playing, els, pos, said, masterRef, fadeOn, fadedIn, handReady, armed, thaw, setFrozen, setFading, place, onPlaying, onTime, tuneMusic, keyOf, startOf });

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
            // its own sound, silent at first: not the timeline's volume, which is for playing the video
            ? <LivePreview job={live.job} sound className="h-full w-full object-contain" />
            : <span className="text-ink-2">Clip {live.clip} is generating. The live preview shows here from its first step.</span>}
          <span className="absolute top-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full bg-ground/85 py-1 pr-1 pl-3 text-xs font-semibold whitespace-nowrap">
            Clip {live.clip} · {phaseLabel(live.job.phase)}{live.job.steps ? ` · step ${live.job.step} of ${live.job.steps}` : ""}
            {onStop && <button type="button" onClick={() => onStop(live.job.id)} data-tip="Stop this render. Nothing is added; the clip keeps the takes it has." className="rounded-full border border-line-strong px-2.5 py-0.5 hover:bg-hover">Stop</button>}
          </span>
        </div>
      )}
      {screen && <FullscreenBar box={box} c={screen} clips={clips} timeline={timeline} live={live && !playing ? (live.job.previewMime?.startsWith("video/") ? "video" : "picture") : null} />}
    </div>
  );
});
