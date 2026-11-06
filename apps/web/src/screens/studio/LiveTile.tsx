import { Square } from "lucide-react";
import type { RunningJob } from "../../api";
import { phaseLabel } from "../../format";
import { LivePreview } from "../../LivePreview";
import { useStop } from "../../ModelLoad";
import { Bar, cx } from "../../ui";

export function LiveTile({ job, onClick, on, title, fill, compact }: {
  job: RunningJob;
  onClick?(): void;
  on?: boolean;
  title?: string;
  /** It fills the box it is put in (a place in the library's justified rows); else it is a 3:4 card. */
  fill?: boolean;
  /** A small tile (the versions strip's 64 px): the stop smaller in its corner, what it does under it, so neither covers the other. */
  compact?: boolean;
}) {
  const stop = useStop();
  return (
    <div data-stage className={cx("relative overflow-hidden rounded-xl border bg-stage", fill ? "h-full" : "aspect-[3/4]", on ? "border-2 border-accent" : "border-line-strong")}>
      <button type="button" onClick={onClick} disabled={!onClick} aria-label={title ?? "Running job"} data-tip={title} className={cx("absolute inset-0 flex flex-col items-center gap-2", compact ? "justify-end" : "justify-center")}>
        <LivePreview job={job} className="absolute inset-0 h-full w-full object-cover opacity-80" />
        <div className={cx("relative flex w-full flex-col items-center bg-ground/60 text-center", compact ? "gap-1 px-1 py-1" : "gap-1.5 px-2 py-2")}>
          <div className={cx("font-semibold", compact ? "text-micro" : "text-xs")}>{phaseLabel(job.phase)}</div>
          <div className="w-4/5"><Bar value={job.progress * 100} steps={job.steps} loading={!job.progress} /></div>
        </div>
      </button>
      <button
        type="button"
        aria-label="Stop this render"
        data-tip="Stop this render. Nothing is saved."
        disabled={stop.isPending}
        onClick={() => stop.mutate([job.id])}
        className={cx("absolute flex items-center justify-center border border-line-strong bg-ground/80 text-ink hover:border-warn hover:text-warn", compact ? "top-0.5 right-0.5 h-5 w-5 rounded-md" : "top-1.5 right-1.5 h-7 w-7 rounded-lg")}
      >
        <Square size={compact ? 8 : 11} fill="currentColor" />
      </button>
    </div>
  );
}
