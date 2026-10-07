import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Film } from "lucide-react";
import { api, fileUrl, type Clip, type RunningJob, type Take, type Timeline } from "../api";
import { phaseLabel } from "../format";
import { LivePreview } from "../LivePreview";
import { cx } from "../ui";

/** How long before a clip ends the clip after starts running hidden, so that it takes over with frames ready and in step. */
const PREROLL_MS = 600;
/** How early the cut to the clip after is made: a video frame at 48 a second plus the animation frame the check may be late by. */
const CUT_EARLY_MS = 24;

export interface PlayerHandle {
  /** Go to a moment of what plays. */
  seek(ms: number): void;
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
  onStop?(job: string): void;
  /** The timeline, for the colour matching at the joins (the export's, shown here too). */
  timeline?: string;
}>(function Player({ clips, music, frame, playing, onPlaying, onTime, preview, live, onStop, timeline }, ref) {
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
    if (c.joined !== "continue") return 0;
    // at a take-over point inside the shared frames both sides show the same moments, but each re-rendered them: the
    // fade runs over those moments, before the take-over point, as the export does (a pixel join has no take-over point)
    const shared = c.take.headMs - c.take.trimStartMs - c.take.leadMs;
    const x = Math.min(170, shared, c.lengthMs - 40, from.lengthMs - 40);
    return x >= 80 ? x : 0;
  };
  /** The next clip is fading in, over this many ms. */
  const [fading, setFading] = useState(0);
  const fadeOn = useRef(false);
  /** The fade of the clip after has begun (from then on it is not moved: a jump would show). */
  const fadedIn = useRef(false);
  /**
   * The sound hands over later than the picture at a take-over point: the clip before keeps sounding, hidden,
   * for the lead while the clip on screen stays muted; then they swap. The model leaves a hole in its sound
   * where its own frames begin, and the clip before's real sound covers it.
   */
  const handing = useRef<{ id: string; until: number } | null>(null);
  const [held, setHeld] = useState<Clip | null>(null);
  const endHand = useCallback(() => {
    const h = handing.current;
    if (!h) return;
    handing.current = null;
    els.current.get(h.id)?.pause();
    setHeld(null);
  }, []);

  /** The music follows the playhead: at the same moment, as loud as its fades say. */
  const tuneMusic = useCallback(
    (global: number, force = false) => {
      const el = musicEl.current;
      if (!el || !music) return;
      const length = music.asset.durationMs || total;
      const heard = Math.min(total, length);
      const fadeIn = music.fadeInMs ? Math.min(1, global / music.fadeInMs) : 1;
      const fadeOut = music.fadeOutMs ? Math.min(1, Math.max(0, heard - global) / music.fadeOutMs) : 1;
      el.volume = Math.max(0, Math.min(1, (music.volume / 100) * fadeIn * fadeOut));
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
      endHand();
      setFading(0);
      setCur(index);
      const el = c.take ? els.current.get(c.take.id) : undefined;
      if (el) el.playbackRate = 1;
      // a seek on a video already there (it was started early, see step) would stall it for a frame
      // (handing over to the clip after as it plays: it runs where it should within a few frames; only a stray one is moved)
      if (el && Math.abs(el.currentTime * 1000 - (startOf(c) + local)) > (onward ? 120 : 40)) el.currentTime = (startOf(c) + local) / 1000;
      if (clipSound.current) clipSound.current.currentTime = local / 1000;
      // the music goes on as it plays when the clips hand over; a jump is only for a seek
      tuneMusic(c.atMs + local, !onward);
      onTime(c.atMs + local);
    },
    [seq, onTime, tuneMusic, endHand],
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
      where() {
        const c = seq[at];
        if (!c) return null;
        const local = pos.current.key === keyOf(c) ? pos.current.local : 0;
        return { clip: c, localMs: local, assetMs: startOf(c) + local };
      },
    }),
    [seq, at, place],
  );

  // what is heard of the clip on screen
  const nowKey = now ? keyOf(now) : "";
  useEffect(() => {
    if (!now?.take) return;
    const el = els.current.get(now.take.id);
    if (!el) return;
    // muted while the clip before still sounds under it (see handing)
    el.muted = now.sound !== "own" || Boolean(handing.current);
    el.volume = Math.max(0, Math.min(1, now.volume / 100));
  }, [now?.take, now?.sound, now?.volume, nowKey, held]);
  useEffect(() => {
    if (clipSound.current) clipSound.current.volume = Math.max(0, Math.min(1, (now?.volume ?? 100) / 100));
  }, [now?.volume, nowKey]);

  useEffect(() => {
    if (!playing) endHand();
    for (const [id, el] of els.current) if ((id !== now?.take?.id && id !== handing.current?.id) || !playing) el.pause();
    if (!playing) {
      clipSound.current?.pause();
      musicEl.current?.pause();
      return;
    }
    pos.current.at = performance.now();
    if (now?.take) void els.current.get(now.take.id)?.play().catch(() => onPlaying(false));
    void clipSound.current?.play().catch(() => {});
    if (music && now && now.atMs + pos.current.local < (music.asset.durationMs || total) - 30) void musicEl.current?.play().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, nowKey, onPlaying, Boolean(music), endHand]);

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
      const due = local >= c.lengthMs - CUT_EARLY_MS && (behind <= 12 || local >= c.lengthMs + 100);
      if (due || el?.ended) {
        if (seq[at + 1]) {
          const lead = seq[at + 1]!.take?.leadMs ?? 0;
          // the picture takes over now; the sound of this clip runs on for the lead, hidden, before the next is heard
          const hand = lead > 0 && c.take && c.sound === "own" && el && !el.ended ? { id: c.take.id, until: t + lead } : null;
          // it takes over where this one got to: the playhead runs on without a step
          place(at + 1, Math.max(0, local - c.lengthMs), true);
          if (hand) {
            handing.current = hand;
            setHeld(c);
          }
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
      if (nextEl && !fadeOn.current && remaining <= PREROLL_MS) {
        fadeOn.current = true;
        nextEl.muted = true;
        // a clip that starts at its very first frame waits there, paused on it, until it is due
        nextEl.currentTime = Math.max(0, expected) / 1000;
        if (expected >= 0) void nextEl.play().catch(() => {});
      }
      if (nextEl && fadeOn.current) {
        // one that waited on its first frame starts when it is due
        if (nextEl.paused && expected >= 0 && remaining > 30) void nextEl.play().catch(() => {});
        else if (!nextEl.paused && expected >= 0) {
          // kept in step while it runs (a video starts with some delay): by its speed, not by seeks, which stall a playing
          // video and left it 70 to 85 ms behind at every take-over (measured), the playhead held until it caught up
          const off = expected - nextEl.currentTime * 1000;
          if (Math.abs(off) > 250 && remaining > 120) nextEl.currentTime = expected / 1000;
          else {
            // in a few steps, set only when the step changes: a speed changed every frame stalls the decoder
            const rate = off > 40 ? 1.25 : off > 12 ? 1.1 : off < -40 ? 0.8 : off < -12 ? 0.9 : 1;
            if (nextEl.playbackRate !== rate) nextEl.playbackRate = rate;
          }
        }
      }
      // over its last frames, a clip that fades in over this one shows, over the moments they share
      if (nextEl && blend && !fadedIn.current && remaining <= blend) {
        fadedIn.current = true;
        setFading(Math.max(40, remaining));
      }
      // the sound hands over: the clip before falls silent, this one is heard
      if (handing.current && t >= handing.current.until) {
        endHand();
        if (el) el.muted = c.sound !== "own";
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
                {[now, next].flatMap((c) => {
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
          {[held && held !== now && held !== next ? held : undefined, now, next].map((c) =>
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
                    e.currentTarget.volume = Math.max(0, Math.min(1, c.volume / 100));
                  }
                }}
                onTimeUpdate={() => c === now && step.current()}
                onEnded={() => c === now && step.current()}
                onClick={() => onPlaying(!playing)}
                style={{ ...(c !== now && fading ? { transition: `opacity ${fading}ms linear` } : {}), ...(nudges.has(c.id) ? { filter: `url(#nudge-${c.id})` } : {}) }}
                className={cx("absolute inset-0 h-full w-full", c.fill ? "object-cover" : "object-contain", c === now ? "opacity-100" : fading ? "pointer-events-none opacity-100" : "pointer-events-none opacity-0")}
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
                className="absolute inset-0 h-full w-full bg-black object-contain"
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
