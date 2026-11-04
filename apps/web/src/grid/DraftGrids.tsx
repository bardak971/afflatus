import { useQuery } from "@tanstack/react-query";
import { Grid3x3 } from "lucide-react";
import { api } from "../api";
import { when } from "../format";
import { queryKeys } from "../queryKeys";
import { cx } from "../ui";
import { useGridBoard } from "./boardLayout";

/** How many of a draft's grids its column lists: the latest ones; older grids' cells stay in the column as pictures. */
const SHOWN = 3;

/**
 * A draft's X/Y/Z grids in its column, each as one item (the mock's "Grid · Steps × coat"): a click shows its board on the
 * Stage, a second goes back to the results. The cells stay in the column below as the pictures they are.
 */
export function DraftGrids({ draft, open }: { draft: string; open: string | undefined }) {
  const grids = useQuery({ queryKey: queryKeys.grids.ofDraft(draft), queryFn: ({ signal }) => api.grids(draft, { signal }), staleTime: 30_000 }).data?.items ?? [];
  const board = useGridBoard();
  if (!grids.length) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {grids.slice(0, SHOWN).map((g) => {
        const on = open === g.id;
        return (
          <button
            key={g.id}
            type="button"
            data-draft-grid={g.id}
            aria-pressed={on}
            onClick={() => (on ? board.close(draft) : board.show(draft, g.id))}
            data-tip={on ? "Back to the results" : "Show this grid's board on the Stage"}
            className={cx("flex min-w-0 items-center gap-2 rounded-xl border p-2 text-left outline-none focus-visible:border-accent", on ? "border-accent bg-accent-wash" : "border-line-strong hover:bg-hover")}
          >
            <Grid3x3 size={16} className={cx("shrink-0", on ? "text-accent" : "text-ink-2")} />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-body font-bold">Grid · {g.axes.slice(0, 2).join(" × ")}</span>
              <span className="truncate text-meta text-ink-2">{g.count} · {when(g.createdAt)}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
