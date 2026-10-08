import { create } from "zustand";
import { persist } from "zustand/middleware";
import { previewUrl, stageUrl, type RunningJob } from "./api";
import { VolumeControl } from "./mediaControls";
import { cx } from "./ui";

/**
 * The sound of a live preview, on its own (not the player's): every render starts silent, its first steps are
 * noise. Turned on, it stays on for that render's steps (each brings a new clip); the next render starts silent
 * again. How loud is kept, for good.
 */
const useLiveSound = create<{ volume: number; heardJob: string | null; set(volume: number): void; hear(job: string | null): void }>()(
  persist(
    (set) => ({ volume: 1, heardJob: null, set: (volume) => set({ volume }), hear: (heardJob) => set({ heardJob }) }),
    // a new name: the old one kept "unmuted" for every render after
    { name: "afflatus.live-sound.2", partialize: (s) => ({ volume: s.volume }) },
  ),
);

/**
 * The latest preview of the job that is rendering: a picture, or (a video model with the animated
 * preview on) a short clip of what is forming, which plays. Each step brings a new one.
 *
 * It comes small: at the latent's size (an eighth of the picture, a thirty-second for LTX) unless a tiny
 * VAE decodes it. Whoever shows it gives it a size to fill; it is never left at its own few pixels.
 */
/**
 * What the workflow showed on the way, as its Preview nodes put pictures out (the first pass, the picture
 * before the detailer…): small, oldest first, under the live preview. Each is as temporary as the live
 * preview itself; the result is what the library gets. Nothing when the workflow has no preview node.
 */
export function StageStrip({ job, className }: { job: Pick<RunningJob, "id" | "stages">; className?: string }) {
  const stages = job.stages ?? [];
  if (stages.length < 1) return null;
  return (
    <div className={className ?? "flex gap-2 overflow-x-auto"}>
      {stages.map((st) => (
        <figure key={st.n} className="m-0 flex shrink-0 flex-col gap-1">
          <img src={stageUrl(job.id, st.n)} alt="" className="h-16 w-auto rounded-md bg-raised object-contain" />
          <figcaption className="max-w-24 truncate text-[11px] text-ink-2" data-tip={st.title ?? st.node}>{st.title ?? `#${st.node}`}{st.count > 1 ? ` · ${st.count}` : ""}</figcaption>
        </figure>
      ))}
    </div>
  );
}

export function LivePreview({ job, className, sound, volume }: {
  job: Pick<RunningJob, "id" | "previewSeq" | "previewMime">;
  className?: string;
  /** With its sound and a volume over it, where there is room to watch it; a click pauses or plays it. */
  sound?: boolean;
  /**
   * Its loudness set by the screen it is shown on (0 to 1, 0 = muted), as the timeline's own volume slider: then
   * that screen's controls are the ones, and a click pauses or plays it.
   */
  volume?: number;
}) {
  const live = useLiveSound();
  const heard = { volume: live.volume, muted: live.heardJob !== job.id };
  if (job.previewSeq <= 0) return null;
  const src = previewUrl(job.id, job.previewSeq);
  const ruled = sound && volume !== undefined;
  if (job.previewMime?.startsWith("video/")) {
    // where there is room to watch it with its sound: the app's volume over it, in place of the browser's controls
    const own = sound && !ruled;
    const video = (
      <video
        // a new clip each step: the key starts the player again from its first frame
        key={job.previewSeq}
        // the new player takes the sound as it was left on the one before it (or as the screen it is on says)
        ref={(el) => {
          if (!el || !sound) return;
          el.muted = ruled ? volume === 0 : heard.muted;
          el.volume = ruled ? Math.max(0, Math.min(1, volume)) : heard.volume;
        }}
        src={src}
        autoPlay
        loop
        muted={!sound || (ruled ? volume === 0 : heard.muted)}
        playsInline
        // full screen pauses and plays it by this mark
        data-live={sound ? "" : undefined}
        onClick={sound ? (e) => void (e.currentTarget.paused ? e.currentTarget.play().catch(() => {}) : e.currentTarget.pause()) : undefined}
        className={own ? "h-full w-auto max-w-full rounded-[inherit] object-contain" : className}
      />
    );
    if (!own) return video;
    return (
      <div className={cx("relative inline-flex justify-center", className)}>
        {video}
        <div className="absolute bottom-2 right-2 rounded-lg border border-line bg-panel px-1.5 py-0.5">
          <VolumeControl
            volume={heard.volume}
            muted={heard.muted}
            onVolume={(v) => {
              live.set(v);
              live.hear(v === 0 ? null : job.id);
            }}
            onMuted={(m) => live.hear(m ? null : job.id)}
          />
        </div>
      </div>
    );
  }
  return <img src={src} alt="" className={className} />;
}
