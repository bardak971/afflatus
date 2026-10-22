import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { EDITOR_COLUMN, useEditorColumn } from "../store";
import { cx, PanelEdge } from "../ui";

/**
 * The editor's right column, whichever panel it holds (the Overview, a clip's inspector, the music): one width for
 * all three, so that the stage keeps its size from one to the other, dragged by its edge; and folded by hand to a
 * strip on the right, as the Media strip on the left. Both remembered (useEditorColumn).
 */

/** How wide the column is now. */
export const useColumnWidth = () => useEditorColumn((s) => s.width);

/** The column's left edge: dragged, it makes it wider or narrower (down to EDITOR_COLUMN.least); a double click puts it back. */
export function ColumnEdge() {
  const set = useEditorColumn((s) => s.set);
  return <PanelEdge side="left" size={{ get: () => useEditorColumn.getState().width, set, usual: EDITOR_COLUMN.usual }} />;
}

/** Folds the column to its strip. `words`: said beside the icon where the panel's head has the room. */
export function FoldButton({ words = false }: { words?: boolean }) {
  const fold = useEditorColumn((s) => s.fold);
  return (
    <button
      type="button"
      aria-label="Fold the column"
      data-tip="Fold: the column becomes a strip on the right and the stage gets its room. ◂ on the strip brings it back."
      onClick={() => fold(true)}
      className={cx("flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-lg text-xs font-semibold text-ink-2 hover:bg-hover hover:text-ink", words ? "border border-line-strong px-2" : "w-7")}
    >
      {words && "Fold"}
      <PanelRightClose size={15} />
    </button>
  );
}

/**
 * The column folded: a strip on the right with the way back, how many things need attention, and what the column
 * shows ("Clip 5", "Overview", "Music"). A click anywhere on it unfolds it.
 */
export function FoldedStrip({ label, attention }: { label: string; attention: number }) {
  const fold = useEditorColumn((s) => s.fold);
  return (
    <aside aria-label={`${label}, folded`} className="flex w-10 shrink-0 flex-col items-center border-l border-line bg-panel py-2">
      <button
        type="button"
        aria-label={`Unfold the column: ${label}${attention ? `, ${attention} need a look` : ""}`}
        data-tip={`Unfold: ${label}${attention ? ` · Needs a look · ${attention}` : ""}`}
        onClick={() => fold(false)}
        className="group flex w-full grow flex-col items-center gap-2.5 text-ink-2"
      >
        <span className="flex h-8 w-8 items-center justify-center rounded-lg group-hover:bg-hover group-hover:text-ink">
          <PanelRightOpen size={16} />
        </span>
        {attention > 0 && <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-attention-wash px-1.5 text-micro font-bold text-attention-ink">{attention}</span>}
        <span className="text-[10px] font-semibold tracking-wide whitespace-nowrap text-ink-3 uppercase [writing-mode:vertical-rl] group-hover:text-ink-2">{label}</span>
      </button>
    </aside>
  );
}
