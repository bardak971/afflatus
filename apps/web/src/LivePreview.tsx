import { create } from "zustand";
import { persist } from "zustand/middleware";
import { previewUrl, stageUrl, type RunningJob } from "./api";

/**
 * Whether the sound of a live preview is on, and how loud: each step brings a new clip, and the choice
 * made on one of them holds for the ones after it (and for the next render).
 */
const useLiveSound = create<{ muted: boolean; volume: number; set(muted: boolean, volume: number): void }>()(
  persist((set) => ({ muted: false, volume: 1, set: (muted, volume) => set({ muted, volume }) }), { name: "afflatus.live-sound" }),
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
          <figcaption className="max-w-24 truncate text-[11px] text-ink-2" title={st.title ?? st.node}>{st.title ?? `#${st.node}`}{st.count > 1 ? ` · ${st.count}` : ""}</figcaption>
        </figure>
      ))}
    </div>
  );
}

export function LivePreview({ job, className, sound }: {
  job: Pick<RunningJob, "id" | "previewSeq" | "previewMime">;
  className?: string;
  /** With its sound and the player's controls, where there is room to watch it. */
  sound?: boolean;
}) {
  const heard = useLiveSound();
  if (job.previewSeq <= 0) return null;
  const src = previewUrl(job.id, job.previewSeq);
  if (job.previewMime?.startsWith("video/")) {
    return (
      <video
        // a new clip each step: the key starts the player again from its first frame
        key={job.previewSeq}
        // the new player takes the sound as it was left on the one before it
        ref={(el) => {
          if (!el || !sound) return;
          el.muted = heard.muted;
          el.volume = heard.volume;
        }}
        src={src}
        autoPlay
        loop
        muted={!sound || heard.muted}
        playsInline
        controls={sound}
        onVolumeChange={(e) => {
          const el = e.currentTarget;
          if (sound && (el.muted !== heard.muted || el.volume !== heard.volume)) heard.set(el.muted, el.volume);
        }}
        className={className}
      />
    );
  }
  return <img src={src} alt="" className={className} />;
}
