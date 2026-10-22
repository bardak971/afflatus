import { useState, type CSSProperties } from "react";
import { Link } from "wouter";
import { ChevronsDownUp, ChevronsUpDown, FileText, MoreHorizontal, Pencil, RotateCcw, Trash2, Wrench } from "lucide-react";
import type { HistoryJob } from "../../api";
import { ContextMenu, useMenu, type MenuItem } from "../../ContextMenu";
import { useRecipes } from "../../data";
import { when } from "../../format";
import { Button, buttonClass, Chip, cx } from "../../ui";
import { useQueueBulk } from "./bulk";
import { readableError } from "./failures";
import { fixLink } from "./fixLink";
import { MODEL_CELL, ROW, TOOK_CELL, useJobActions } from "./jobActions";
import { modelTip, useModelName } from "./modelName";
import { lighter, memoryThatRanOut, shorterStretch } from "./retry";

/** A failed job's thumbnail: hatched in the bad colour, nothing having come out. */
const HATCHED: CSSProperties = {
  background: "repeating-linear-gradient(45deg, color-mix(in oklab, var(--color-warn) 28%, var(--color-panel)) 0 6px, var(--color-warn-wash) 6px 12px)",
};

/** A way to fix a failure: a place in the app (a link), or the same jobs again with a change. */
type Fix = { label: string; tip?: string; href?: string; run?(): void };

/**
 * A job that failed, or several that failed the same way (foldFailures: same error, workflow and model, folded
 * into one row with a "×3 · same error" chip): one row tinted in the bad colour, the error said in one readable
 * sentence, and its fix as the first button: the missing file to get, the setting to open, a lighter retry. A
 * second fix, when there is one, as a plain button. Retrying unchanged is in the ··· menu, where it says it fails
 * again when the error would not change by itself; with no known fix, Retry is the button. A click on the row
 * opens the whole ComfyUI text under it. `quiet`: an older failure in the history's time order, a render having
 * worked since: not tinted, the error alone in the bad colour.
 */
export function FailedRow({ jobs, quiet = false }: { jobs: HistoryJob[]; quiet?: boolean }) {
  const job = jobs[0]!;
  const n = jobs.length;
  const [open, setOpen] = useState(false);
  /** A folded row's jobs shown one by one under it. */
  const [split, setSplit] = useState(false);
  const recipes = useRecipes();
  const modelOf = useModelName();
  const bulk = useQueueBulk();
  const { again, dismiss, toDraft } = useJobActions();
  const recipe = recipes.data?.recipes.find((x) => x.id === job.recipe);
  const memory = memoryThatRanOut(job.error);
  const said = readableError(job.error, memory);
  const stretch = memory ? shorterStretch(recipe, job.input) : null;
  const fix = memory ? lighter(recipe, job.input) : null;
  const link = said.missing ? { href: "/settings/models", label: "Get the file" } : fixLink(job.error);
  const error = `${job.error ?? "Failed."}${memory === "ram" ? " Out of the machine's memory (RAM), not the card's: the work had fallen back to the processor." : memory === "vram" ? " Out of VRAM." : ""}`;
  const ids = jobs.map((j) => j.id);
  /**
   * Every job of the row again, each changed by `change` (worked out from its own input), and each failed one taken
   * out of the list once it is queued. Unchanged and several: one request, oldest first.
   */
  const retry = (change?: (j: HistoryJob) => Record<string, unknown> | undefined) => {
    if (!change && n > 1) return void bulk.retryAllFailed(ids);
    for (const j of jobs) again.mutate({ id: j.id, input: change?.(j) }, { onSuccess: () => dismiss.mutate(j.id) });
  };
  const fixes: Fix[] = [
    ...(link ? [{ label: link.label, href: link.href, tip: said.missing ? `Settings › Models: fetch ${said.missing.file} into ComfyUI, or see which folder it goes in` : undefined }] : []),
    ...(stretch ? [{ label: stretch.label, tip: "The latent upscale re-samples the clip in stretches of frames; shorter stretches need less memory.", run: () => retry((j) => shorterStretch(recipe, j.input)?.change) }] : []),
    ...(fix ? [{ label: fix.label, tip: "One step lighter: less memory", run: () => retry((j) => lighter(recipe, j.input)?.change) }] : []),
    ...(said.missing && job.draftId ? [{ label: "Pick another model", tip: "Open its draft, to pick a model that is there", run: () => toDraft(job.draftId!) }] : []),
  ];
  const [first, second, ...more] = fixes;
  // an unchanged retry of a missing file, or of what a setting has to fix, fails the same way until that is done
  const until = said.missing ? "fails again until the file is there" : link ? "fails again until it is fixed" : undefined;
  const menu = useMenu<true>();
  const items: MenuItem[] = [
    ...(first ? [{ label: n > 1 ? `Retry all ${n} unchanged` : "Retry unchanged", icon: <RotateCcw size={14} />, note: until, disabled: again.isPending, run: () => retry() }] : []),
    ...more.map((f) => ({ label: f.label, icon: <Wrench size={14} />, note: f.tip, disabled: again.isPending, run: f.run })),
    ...(job.draftId && !(said.missing && fixes.length) ? [{ label: "Open its draft", icon: <Pencil size={14} />, run: () => toDraft(job.draftId!) }] : []),
    { label: open ? "Hide the whole error" : "Show the whole error", icon: <FileText size={14} />, run: () => setOpen(!open) },
    ...(n > 1 ? [{ label: split ? `Fold the ${n} jobs` : `Show the ${n} jobs`, icon: split ? <ChevronsDownUp size={14} /> : <ChevronsUpDown size={14} />, run: () => setSplit(!split) }] : []),
    "—",
    { label: n > 1 ? `Dismiss all ${n}` : "Dismiss", icon: <Trash2 size={14} />, danger: true, note: "out of the history", run: () => (n > 1 ? void bulk.dismissAllFailed({ ids }) : dismiss.mutate(job.id)) },
  ];
  const toggle = () => setOpen(!open);
  const button = (f: Fix, tone: "primary" | "plain") =>
    f.href ? (
      <Link key={f.label} href={f.href} data-tip={f.tip} onClick={(e) => e.stopPropagation()} className={buttonClass({ tone, size: "sm" })}>{f.label}</Link>
    ) : (
      <Button key={f.label} size="sm" tone={tone} disabled={again.isPending} data-tip={f.tip} onClick={(e) => { e.stopPropagation(); f.run?.(); }}>{f.label}</Button>
    );

  return (
    <div className="flex flex-col gap-1">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-label={`${job.label}: failed${n > 1 ? ` ${n} times` : ""}. ${open ? "Hide" : "Show"} the whole error`}
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
        {/* the fixes sit in the name's column, after it: they need more room than the "took" column has */}
        <span className="flex min-w-0 items-center gap-2">
          <span className="flex min-w-0 grow flex-col gap-0.5">
            <span className="flex min-w-0 items-center gap-2">
              <span className={cx("truncate text-[13.5px]", quiet ? "font-semibold text-ink-2" : "font-bold")}>{job.label}</span>
              {n > 1 && <Chip tone="warn" className="h-5 px-2 text-[11px]" tip={`${n} jobs failed with the same error; ··· shows them`}>×{n} · same error</Chip>}
            </span>
            <span className="truncate text-xs text-warn-ink">{said.text}</span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            {first ? button(first, "primary") : <Button size="sm" tone="primary" disabled={again.isPending} onClick={(e) => { e.stopPropagation(); retry(); }} data-tip={n > 1 ? "The same jobs again, unchanged, oldest first" : "The same job again, unchanged"}>{n > 1 ? `Retry all ${n}` : "Retry"}</Button>}
            {second && button(second, "plain")}
          </span>
        </span>
        <span className={cx("truncate text-[12.5px] text-ink-2", MODEL_CELL)} data-tip={modelTip(modelOf(job), job.model)}>{modelOf(job)}</span>
        {/* nothing came out: no time to say, a dash as a finished row with none has */}
        <span className={cx("text-right font-mono text-xs text-ink-3", TOOK_CELL)}>—</span>
        <span className="text-right text-xs text-ink-2">{job.finishedAt ? when(job.finishedAt) : ""}</span>
        {/* in a column of its own, at the row's end: under Took it read as a figure of the row */}
        <span className="flex justify-end">
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
      </div>
      {open && (
        <div className="mr-3 mb-1 ml-[90px] flex flex-col gap-2 rounded-[10px] bg-raised px-3 py-2.5 text-[12.5px] leading-normal">
          <span className="whitespace-pre-wrap select-text">{error}</span>
          {/* where in ComfyUI's code it failed, as it sent it: what its own log no longer has once it rolls over */}
          {job.trace && <pre className="max-h-60 overflow-auto rounded-md bg-panel px-2 py-1.5 font-mono text-[11px] leading-snug whitespace-pre-wrap text-ink-2 select-text">{job.trace}</pre>}
          {job.prompt && <span className="truncate text-xs text-ink-2" data-tip={job.prompt}>{job.prompt}</span>}
        </div>
      )}
      {split && n > 1 && (
        <div className="ml-3 flex flex-col gap-1 border-l-2 border-warn/30 pl-1">
          {jobs.map((j) => <FailedRow key={j.id} jobs={[j]} quiet />)}
        </div>
      )}
      {menu.menu && <ContextMenu at={menu.menu.at} label={`Actions on ${job.label}`} head={{ title: n > 1 ? `${job.label} ×${n}` : job.label, sub: `Failed · ${modelOf(job)}` }} items={items} onClose={menu.close} />}
    </div>
  );
}
