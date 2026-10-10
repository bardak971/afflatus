/** The rows of a placeholder card: their label widths, as a few mapping rows draw. */
const ROWS = ["w-24", "w-20", "w-32", "w-24", "w-28", "w-20"];

/** One column of the editor while it comes: its step title, then a card of rows with the loading shine. */
function Column({ rows, className }: { rows: number; className?: string }) {
  return (
    <div className={className}>
      <div className="flex items-center gap-2 pb-1">
        <span className="m-skeleton h-[22px] w-[22px] rounded-full!" />
        <span className="m-skeleton h-4 w-40" />
      </div>
      <div className="overflow-hidden rounded-xl border border-line">
        {ROWS.slice(0, rows).map((w, i) => (
          <div key={i} className={`flex items-center gap-3 px-3 py-2.5 ${i > 0 ? "border-t border-line" : ""}`}>
            <span className={`m-skeleton h-3.5 ${w}`} />
            <span className="grow" />
            <span className="m-skeleton h-8 w-40" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The workflow editor before its workflow (or its code) has come: the header with its name and buttons, and the three
 * columns at their widths, in the kit's placeholders. The editor then lands in the same places: nothing jumps. Light on
 * purpose: it is also what the app shows while the editor's own code loads, so it imports nothing.
 */
export function WorkflowEditorSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading the workflow" className="flex min-h-0 grow flex-col">
      <div className="flex min-h-16 shrink-0 items-center gap-3 border-b border-line px-8 py-2.5">
        <span className="flex flex-col gap-1.5">
          <span className="m-skeleton h-5 w-40" />
          <span className="m-skeleton h-3 w-56" />
        </span>
        <span className="grow" />
        <span className="m-skeleton h-6 w-24 rounded-full!" />
        <span className="m-skeleton h-9 w-20" />
        <span className="m-skeleton h-9 w-32" />
      </div>
      <div className="grid min-h-0 grow grid-cols-[400px_minmax(0,1fr)_440px]">
        <Column rows={6} className="flex flex-col gap-2.5 border-r border-line p-5" />
        <Column rows={4} className="flex flex-col gap-2 border-r border-line p-5" />
        <Column rows={3} className="flex flex-col gap-3.5 bg-panel p-5" />
      </div>
    </div>
  );
}
