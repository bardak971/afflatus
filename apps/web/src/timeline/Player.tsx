import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Film } from "lucide-react";
import { fileUrl, type Clip, type RunningJob, type Take, type Timeline } from "../api";
import { phaseLabel } from "../format";
import { LivePreview } from "../LivePreview";
import { cx } from "../ui";

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
}>(function Player({ clips, music, frame, playing, onPlaying, onTime, preview, live, onStop }, ref) {
  const seq = useMemo(() => clips.filter((c) => c.lengthMs > 0 && (c.take || c.still)), [clips]);
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
    (index: number, local: number) => {
      const c = seq[index];
      if (!c) return;
      pos.current = { key: keyOf(c), local, at: performance.now() };
      setCur(index);
      const el = c.take ? els.current.get(c.take.id) : undefined;
      if (el) el.currentTime = (startOf(c) + local) / 1000;
      if (clipSound.current) clipSound.current.currentTime = local / 1000;
      tuneMusic(c.atMs + local, true);
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
    el.muted = now.sound !== "own";
    el.volume = Math.max(0, Math.min(1, now.volume / 100));
  }, [now?.take, now?.sound, now?.volume, nowKey]);
  useEffect(() => {
    if (clipSound.current) clipSound.current.volume = Math.max(0, Math.min(1, (now?.volume ?? 100) / 100));
  }, [now?.volume, nowKey]);

  useEffect(() => {
    for (const [id, el] of els.current) if (id !== now?.take?.id || !playing) el.pause();
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
      if (local >= c.lengthMs - 8 || el?.ended) {
        if (seq[at + 1]) place(at + 1, 0);
        else {
          pos.current = { key: keyOf(c), local: c.lengthMs, at: t };
          onTime(c.atMs + c.lengthMs);
          onPlaying(false);
        }
        return false;
      }
      if (local >= 0) {
        pos.current = { key: keyOf(c), local, at: t };
        tuneMusic(c.atMs + local);
        // the screen around the video does not need every frame's time
        if (t - said.current > 66) {
          said.current = t;
          onTime(c.atMs + local);
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
          {[now, next].map((c) =>
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
                className={cx("absolute inset-0 h-full w-full", c.fill ? "object-cover" : "object-contain", c === now ? "opacity-100" : "pointer-events-none opacity-0")}
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
            : <span className="text-ink-2">Clip {live.clip} is rendering. What is forming shows here from its first step.</span>}
          <span className="absolute top-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full bg-ground/85 py-1 pr-1 pl-3 text-xs font-semibold whitespace-nowrap">
            Clip {live.clip} · {phaseLabel(live.job.phase)}{live.job.steps ? ` · step ${live.job.step} of ${live.job.steps}` : ""}
            {onStop && <button type="button" onClick={() => onStop(live.job.id)} title="Stop this render. Nothing is added; the clip keeps the takes it has." className="rounded-full border border-line-strong px-2.5 py-0.5 hover:bg-hover">Stop</button>}
          </span>
        </div>
      )}
    </div>
  );
});
