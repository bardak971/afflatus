import { previewUrl, type RunningJob } from "./api";

/**
 * The latest preview of the job that is rendering: a picture, or (a video model with the animated
 * preview on) a short clip of what is forming, which plays. Each step brings a new one.
 */
export function LivePreview({ job, className, sound }: {
  job: Pick<RunningJob, "id" | "previewSeq" | "previewMime">;
  className?: string;
  /** With its sound and the player's controls, where there is room to watch it. */
  sound?: boolean;
}) {
  if (job.previewSeq <= 0) return null;
  const src = previewUrl(job.id, job.previewSeq);
  // a new clip each step: the key starts the player again from its first frame
  if (job.previewMime?.startsWith("video/")) return <video key={job.previewSeq} src={src} autoPlay loop muted={!sound} playsInline controls={sound} className={className} />;
  return <img src={src} alt="" className={className} />;
}
