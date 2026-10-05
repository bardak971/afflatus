import { Square } from "lucide-react";
import type { RunningJob } from "../../api";
import { phaseLabel } from "../../format";
import { LivePreview } from "../../LivePreview";
import { useStop } from "../../ModelLoad";
import { Bar, cx } from "../../ui";

export function LiveTile({ job, onClick, on, title }: { job: RunningJob; onClick?(): void; on?: boolean; title?: string }) {
  const stop = useStop();
  return (
    <div data-stage className={cx("relative aspect-[3/4] overflow-hidden rounded-[10px] border bg-panel", on ? "border-2 border-accent" : "border-line-strong")}>
      <button type="button" onClick={onClick} disabled={!onClick} aria-label={title ?? "Running job"} title={title} className="absolute inset-0 flex flex-col items-center justify-center gap-2">
        <LivePreview job={job} className="absolute inset-0 h-full w-full object-cover opacity-80" />
        <div className="relative flex w-full flex-col items-center gap-1.5 bg-ground/60 px-2 py-2 text-center">
          <div className="text-xs font-semibold">{phaseLabel(job.phase)}</div>
          <div className="w-4/5"><Bar value={job.progress * 100} /></div>
        </div>
      </button>
      <button
        type="button"
        aria-label="Cancel this render"
        title="Cancel this render. Nothing is saved."
        disabled={stop.isPending}
        onClick={() => stop.mutate([job.id])}
        className="absolute top-1.5 right-1.5 flex h-7 w-7 items-center justify-center rounded-lg border border-line-strong bg-ground/80 text-ink hover:border-warn hover:text-warn"
      >
        <Square size={11} fill="currentColor" />
      </button>
    </div>
  );
}
