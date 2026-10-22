import type { ReactNode } from "react";
import { cx } from "../../ui";

/** A small mark at the start of a row: the family a preset is for, an icon for a style. */
export function Mark({ children, title }: { children: ReactNode; title?: string }) {
  return <span data-tip={title} className="flex h-6 min-w-6 shrink-0 items-center justify-center rounded bg-raised px-1.5 text-micro font-bold tracking-wide text-ink-2 uppercase">{children}</span>;
}
/** One item of the list: a mark, its name, a line under it, and what must be seen at a glance on the right. */
export function Row({ active, onClick, onMenu, mark, title, summary, badges }: { active: boolean; onClick(): void; onMenu?(e: React.MouseEvent): void; mark: ReactNode; title: string; summary?: string; badges?: ReactNode }) {
  return (
    <button type="button" onClick={onClick} onContextMenu={onMenu} aria-current={active ? "true" : undefined} className={cx("flex w-full items-center gap-3 rounded-control border px-2 py-2 text-left", active ? "border-accent/45 bg-accent-wash" : "border-transparent hover:bg-hover")}>
      {mark}
      <span className="flex min-w-0 grow flex-col gap-0.5">
        <span className="truncate text-sm font-semibold">{title}</span>
        {(summary || badges) && (
          <span className="flex items-center gap-2">
            {summary && <span className="min-w-0 truncate text-xs text-ink-2">{summary}</span>}
            {badges && <span className="ml-auto flex shrink-0 items-center gap-1">{badges}</span>}
          </span>
        )}
      </span>
    </button>
  );
}
