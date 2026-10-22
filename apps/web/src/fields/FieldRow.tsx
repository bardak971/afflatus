import type { ReactNode } from "react";
import { useExplain } from "../store";
import { cx, Help } from "../ui";
import { FIELD_NAME, FieldNameExtra } from "./FieldName";

/**
 * A compact setting on one row: its name on the left (with its ? or, while forms explain themselves, its
 * line under it), the control on the right. Numbers, switches and choices are drawn so; pictures, prompts and
 * lists of files keep their own stacked shape.
 */
export function FieldRow({ label, note, htmlFor, stack, trail, children }: {
  label: string;
  note?: string;
  htmlFor?: string;
  /** The control always under its label: one that needs the row's whole width (a range of a clip with its figures under it). */
  stack?: boolean;
  /**
   * The control at the row's end, the name taking the rest: one of its own size (a switch, a few chips, a number box),
   * which needs no column. In the value column it left the name 124 px, and "Comfy Kitchen attention" went on two
   * lines beside an empty row. Sliders and pickers fill the value column, to the same right edge.
   */
  trail?: boolean;
  children: ReactNode;
}) {
  const explain = useExplain((st) => st.on);
  const cut = label.lastIndexOf(" ");
  const head = cut < 0 ? "" : label.slice(0, cut + 1);
  const last = label.slice(cut + 1);
  // the name may be in two pieces (the ? held to the last word): each is a label of the control, which reads them as one
  const name = (text: string) => (htmlFor ? <label htmlFor={htmlFor}>{text}</label> : text);
  return (
    // in the timeline editor's column dragged narrow (its container, "column"), the control goes under its label: side
    // by side, a switch or a picker beside a 124 px label was cut
    // at its end, a control too wide to leave the name 7rem goes under it, still at the end: SCAIL's three choices beside
    // "Who moves like whom" left the name four lines of one word
    <div className={cx("min-h-11 items-center gap-x-3 gap-y-1", trail && !stack ? "flex flex-wrap" : "grid", stack ? "grid-cols-1 py-1" : trail ? "" : "grid-cols-[124px_minmax(0,1fr)] @max-[21rem]/column:grid-cols-1 @max-[21rem]/column:py-1")}>
      {/* a long name goes on a second line rather than end in "…" (cut, "Turbo LoRA str…" said nothing). Its ? follows
          the last word, as on a stacked field (Label), held to it: beside a name that wraps, a ? of its own sat at the
          column's edge, where it read as the value's */}
      <span {...FIELD_NAME} className={cx("font-semibold [overflow-wrap:anywhere]", trail && !stack ? "min-w-28 grow basis-0" : "min-w-0")}>
        {head && name(head)}
        <span className="whitespace-nowrap">{name(last)}{note && !explain && <Help text={note} title={label} className="relative -top-[1.5px] ml-1.5 align-middle" />}</span>
        {/* in a model form: where a pinned copy lives, or the pin of one in its own section */}
        <FieldNameExtra />
      </span>
      <div className={cx("flex min-w-0 flex-col gap-1.5", trail && !stack && "ml-auto items-end")}>{children}</div>
      {explain && note && <span className="col-span-full basis-full text-xs text-ink-2">{note}</span>}
    </div>
  );
}
