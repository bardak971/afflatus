import { Square } from "lucide-react";
import type { RunningJob } from "../../api";
import { phaseLabel } from "../../format";
import { LivePreview } from "../../LivePreview";
import { useStop } from "../../ModelLoad";
import { Bar, cx } from "../../ui";

export function LiveTile({ job, onClick, on, title, fill }: {
  job: RunningJob;
  onClick?(): void;
  on?: boolean;
  title?: string;
  /** It fills the box it is put in (a place in the library's justified rows); else it is a 3:4 card. */
  fill?: boolean;
}) {
  const stop = useStop();
  return (
    <div data-stage className={cx("relative overflow-hidden rounded-xl border bg-stage", fill ? "h-full" : "aspect-[3/4]", on ? "border-2 border-accent" : "border-line-strong")}>
      <button type="button" onClick={onClick} disabled={!onClick} aria-label={title ?? "Running job"} data-tip={title} className="absolute inset-0 flex flex-col items-center justify-center gap-2">
        <LivePreview job={job} className="absolute inset-0 h-full w-full object-cover opacity-80" />
        <div className="relative flex w-full flex-col items-center gap-1.5 bg-ground/60 px-2 py-2 text-center">
          <div className="text-xs font-semibold">{phaseLabel(job.phase)}</div>
          <div className="w-4/5"><Bar value={job.progress * 100} steps={job.steps} loading={!job.progress} /></div>
        </div>
      </button>
      <button
        type="button"
        aria-label="Cancel this render"
        data-tip="Cancel this render. Nothing is saved."
        disabled={stop.isPending}
        onClick={() => stop.mutate([job.id])}
        className="absolute top-1.5 right-1.5 flex h-7 w-7 items-center justify-center rounded-lg border border-line-strong bg-ground/80 text-ink hover:border-warn hover:text-warn"
      >
        <Square size={11} fill="currentColor" />
      </button>
    </div>
  );
}
