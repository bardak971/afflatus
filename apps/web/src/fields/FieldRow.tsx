import type { ReactNode } from "react";
import { useExplain } from "../store";
import { cx, Help } from "../ui";

/**
 * A compact setting on one row: its name on the left (with its ? or, while forms explain themselves, its
 * line under it), the control on the right. Numbers, switches and choices are drawn so; pictures, prompts and
 * lists of files keep their own stacked shape.
 */
export function FieldRow({ label, note, htmlFor, stack, children }: { label: string; note?: string; htmlFor?: string; /** The control always under its label: one that needs the row's whole width (a range of a clip with its figures under it). */ stack?: boolean; children: ReactNode }) {
  const explain = useExplain((st) => st.on);
  return (
    // in the timeline editor's column dragged narrow (its container, "column"), the control goes under its label: side
    // by side, a switch or a picker beside a 124 px label was cut
    <div className={cx("grid min-h-11 items-center gap-x-3 gap-y-1", stack ? "grid-cols-1 py-1" : "grid-cols-[124px_minmax(0,1fr)] @max-[21rem]/column:grid-cols-1 @max-[21rem]/column:py-1")}>
      <span className="flex min-w-0 items-center justify-between gap-1.5">
        {htmlFor ? <label htmlFor={htmlFor} className="truncate font-semibold">{label}</label> : <span className="truncate font-semibold">{label}</span>}
        {/* pinned to the column's right edge: the ?s of a card line up */}
        {note && !explain && <Help text={note} title={label} />}
      </span>
      <div className="flex min-w-0 flex-col gap-1.5">{children}</div>
      {explain && note && <span className="col-span-full text-xs text-ink-2">{note}</span>}
    </div>
  );
}
