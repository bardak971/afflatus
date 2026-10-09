import { useState, type CSSProperties } from "react";
import { Link } from "wouter";
import { MoreHorizontal, Pencil, RotateCcw, Trash2 } from "lucide-react";
import type { HistoryJob } from "../../api";
import { ContextMenu, useMenu, type MenuItem } from "../../ContextMenu";
import { useRecipes } from "../../data";
import { fileLabel, when } from "../../format";
import { Button, cx } from "../../ui";
import { fixLink } from "./fixLink";
import { ROW, useJobActions } from "./jobActions";
import { useModelName } from "./modelName";
import { lighter, memoryThatRanOut, shorterStretch } from "./retry";

/** A failed job's thumbnail: hatched in the bad colour, nothing having come out. */
export const HATCHED: CSSProperties = {
  background: "repeating-linear-gradient(45deg, color-mix(in oklab, var(--color-warn) 28%, var(--color-panel)) 0 6px, var(--color-warn-wash) 6px 12px)",
};

/**
 * A job that failed: one row tinted in the bad colour, the error on one line, a Retry and a menu of the
 * other ways to run it again. A click on the row opens the whole error under it, with a link to the place
 * in the app that fixes it when the error names one. `quiet`: an older failure in the history's time order, a
 * render having worked since: not tinted, the error alone in the bad colour.
 */
export function FailedRow({ job, quiet = false }: { job: HistoryJob; quiet?: boolean }) {
  const [open, setOpen] = useState(false);
  const recipes = useRecipes();
  const modelOf = useModelName();
  const { again, dismiss, toDraft } = useJobActions();
  const recipe = recipes.data?.recipes.find((x) => x.id === job.recipe);
  const memory = memoryThatRanOut(job.error);
  const fix = memory ? lighter(recipe, job.input) : null;
  const stretch = memory ? shorterStretch(recipe, job.input) : null;
  const link = fixLink(job.error);
  const error = `${job.error ?? "Failed."}${memory === "ram" ? " Out of the machine's memory (RAM), not the card's: the work had fallen back to the processor." : memory === "vram" ? " Out of VRAM." : ""}`;
  /** Run it again (changed, or not), and take the failed one out of the list once it is queued. */
  const retry = (input?: Record<string, unknown>) => again.mutate({ id: job.id, input }, { onSuccess: () => dismiss.mutate(job.id) });
  const menu = useMenu<true>();
  const items: MenuItem[] = [
    { label: "Retry unchanged", icon: <RotateCcw size={14} />, disabled: again.isPending, run: () => retry() },
    ...(stretch ? [{ label: stretch.label, icon: <RotateCcw size={14} />, note: "less memory", disabled: again.isPending, run: () => retry(stretch.change) }] : []),
    ...(fix ? [{ label: fix.label, icon: <RotateCcw size={14} />, note: "less memory", disabled: again.isPending, run: () => retry(fix.change) }] : []),
    ...(job.draftId ? [{ label: "Open the draft in Studio", icon: <Pencil size={14} />, run: () => toDraft(job.draftId!) }] : []),
    "—",
    { label: "Dismiss", icon: <Trash2 size={14} />, danger: true, note: "out of the history", run: () => dismiss.mutate(job.id) },
  ];
  const toggle = () => setOpen(!open);

  return (
    <div className="flex flex-col gap-1">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-label={`${job.label}: failed. ${open ? "Hide" : "Show"} the whole error`}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
          e.preventDefault();
          toggle();
        }}
        onContextMenu={(e) => menu.open(e, true)}
        data-tip={job.prompt || undefined}
        className={cx(ROW, "cursor-pointer rounded-xl py-2 focus-visible:outline-2 focus-visible:outline-warn", quiet ? "py-1.5 hover:bg-hover" : "bg-warn-wash inset-ring inset-ring-warn/30 hover:inset-ring-warn/55")}
      >
        <span className={cx("h-9 w-16 rounded-[7px]", quiet && "opacity-40")} style={HATCHED} />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className={cx("truncate text-[13.5px]", quiet ? "font-semibold text-ink-2" : "font-bold")}>{job.label}</span>
          <span className="truncate text-xs text-warn-ink">{error}</span>
        </span>
        <span className="truncate text-[12.5px] text-ink-2" data-tip={job.model ? fileLabel(job.model) : undefined}>{modelOf(job)}</span>
        <span className="flex justify-end gap-1">
          <Button size="sm" disabled={again.isPending} onClick={(e) => { e.stopPropagation(); retry(); }} data-tip="The same job again, unchanged">Retry</Button>
          <button
            type="button"
            aria-label={`More actions on ${job.label}`}
            aria-haspopup="menu"
            onClick={(e) => { e.stopPropagation(); menu.open(e, true); }}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink"
          >
            <MoreHorizontal size={16} />
          </button>
        </span>
        <span className="text-right text-xs text-ink-2">{job.finishedAt ? when(job.finishedAt) : ""}</span>
      </div>
      {open && (
        <div className="mr-3 mb-1 ml-[90px] flex flex-col gap-2 rounded-[10px] bg-raised px-3 py-2.5 text-[12.5px] leading-normal">
          <span className="whitespace-pre-wrap select-text">{error}</span>
          {job.prompt && <span className="truncate text-xs text-ink-2" data-tip={job.prompt}>{job.prompt}</span>}
          <div className="flex flex-wrap items-center gap-1.5">
            {link && <Link href={link.href} className="mr-2 font-semibold text-accent hover:underline">{link.label}</Link>}
            {stretch && <Button size="sm" tone="danger" disabled={again.isPending} data-tip="The latent upscale re-samples the clip in stretches of frames; shorter stretches need less memory." onClick={() => retry(stretch.change)}>{stretch.label}</Button>}
            {fix && <Button size="sm" tone={stretch ? undefined : "danger"} disabled={again.isPending} onClick={() => retry(fix.change)}>{fix.label}</Button>}
            {job.draftId && <Button size="sm" onClick={() => toDraft(job.draftId!)}>Open the draft</Button>}
            <Button size="sm" tone="quiet" onClick={() => dismiss.mutate(job.id)}>Dismiss</Button>
          </div>
        </div>
      )}
      {menu.menu && <ContextMenu at={menu.menu.at} label={`Actions on ${job.label}`} head={{ title: job.label, sub: `Failed · ${modelOf(job)}` }} items={items} onClose={menu.close} />}
    </div>
  );
}
