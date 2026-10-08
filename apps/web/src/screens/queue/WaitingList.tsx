import { useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpToLine, X } from "lucide-react";
import type { Job } from "../../api";
import { ContextMenu, useMenu, type MenuItem } from "../../ContextMenu";
import { aboutMs, when } from "../../format";
import { cx } from "../../ui";
import { useModelName } from "./modelName";
import { dropped, moved } from "./order";

/** How many waiting jobs show before the rest fold into "and N more". */
export const SHOWN = 3;

/** What comes next, as compact numbered rows: dragged up and down, or moved and removed from its menu. The first few show; the rest unfold. */
export function WaitingList({ waiting, onOrder, onRemove }: { waiting: Job[]; onOrder(ids: string[]): void; onRemove(id: string): void }) {
  const [dragged, setDragged] = useState<string | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [all, setAll] = useState(false);
  const modelOf = useModelName();
  /** The right-click menu of a waiting job: what its drag and its X do. */
  const menu = useMenu<{ id: string; label: string; index: number }>();
  const ids = waiting.map((w) => w.id);
  const itemsOf = (j: { id: string; index: number }): MenuItem[] => [
    { label: "Move to the top", icon: <ArrowUpToLine size={14} />, disabled: j.index === 0, run: () => onOrder(moved(ids, j.id, 0)) },
    { label: "Move up", icon: <ArrowUp size={14} />, disabled: j.index === 0, run: () => onOrder(moved(ids, j.id, j.index - 1)) },
    { label: "Move down", icon: <ArrowDown size={14} />, disabled: j.index >= ids.length - 1, run: () => onOrder(moved(ids, j.id, j.index + 1)) },
    "—",
    { label: "Remove from the queue", icon: <X size={14} />, danger: true, run: () => onRemove(j.id) },
  ];
  /** The head of its menu: its name, its place in the line and its model. */
  const waitingHead = (j: { id: string; label: string; index: number }) => {
    const w = waiting.find((x) => x.id === j.id);
    return { title: j.label, sub: `Waiting · ${j.index + 1} of ${ids.length}${w ? ` · ${modelOf(w)}` : ""}` };
  };
  const drop = (index: number) => {
    if (!dragged) return;
    onOrder(dropped(ids, dragged, index));
    setDragged(null);
    setOver(null);
  };
  const shown = all ? waiting : waiting.slice(0, SHOWN);
  const more = waiting.length - shown.length;

  if (!waiting.length) return null;
  return (
    <div className="flex flex-col" onDragOver={(e) => dragged && e.preventDefault()} onDrop={() => over !== null && drop(over)}>
      {shown.map((w, i) => (
        <div
          key={w.id}
          onContextMenu={(e) => menu.open(e, { id: w.id, label: w.label, index: i })}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = "move";
            setDragged(w.id);
          }}
          onDragEnd={() => {
            setDragged(null);
            setOver(null);
          }}
          onDragOver={(e) => {
            if (!dragged) return;
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            setOver(e.clientY < r.top + r.height / 2 ? i : i + 1);
          }}
          data-tip={w.kind === "export" || w.kind === "cut" ? `${w.kind} · no GPU needed` : w.kind === "load" ? "loads the model, renders nothing" : `queued ${when(w.createdAt)}`}
          className={cx(
            "group flex cursor-grab items-center gap-3.5 rounded-[10px] border-y-2 border-transparent py-px pr-1 pl-3 text-[13px] hover:bg-hover",
            dragged === w.id && "opacity-50",
            dragged && over === i && "border-t-accent",
            dragged && over === i + 1 && i === shown.length - 1 && "border-b-accent",
          )}
        >
          <span className="w-[18px] shrink-0 font-mono text-ink-3">{i + 1}</span>
          <span className="min-w-0 grow truncate font-semibold">{w.label}</span>
          <span className="max-w-[40%] shrink-0 truncate text-ink-2">{w.kind === "load" ? `load · ${modelOf(w)}` : modelOf(w)}</span>
          <span className="w-[70px] shrink-0 text-right font-mono text-ink-2">{w.estimateMs ? `~${aboutMs(w.estimateMs).replace(/^about /, "")}` : "—"}</span>
          <button type="button" aria-label={`Remove ${w.label} from the queue`} data-tip="Remove from the queue" onClick={() => onRemove(w.id)} className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-3 opacity-0 group-hover:opacity-100 hover:bg-raised hover:text-ink focus-visible:opacity-100">
            <X size={14} />
          </button>
        </div>
      ))}
      <div className="flex items-center gap-1 px-3 pt-1 text-xs text-ink-3">
        {more > 0 && <button type="button" onClick={() => setAll(true)} className="underline-offset-2 hover:text-ink hover:underline">and {more} more</button>}
        {all && waiting.length > SHOWN && <button type="button" onClick={() => setAll(false)} className="underline-offset-2 hover:text-ink hover:underline">show the first {SHOWN} only</button>}
        {waiting.length > 1 && <span data-tip="Images go before videos unless you move them.">{more > 0 || (all && waiting.length > SHOWN) ? " · " : ""}drag a row to reorder</span>}
      </div>
      {menu.menu && <ContextMenu at={menu.menu.at} label={`Actions on ${menu.menu.subject.label}`} head={waitingHead(menu.menu.subject)} items={itemsOf(menu.menu.subject)} onClose={menu.close} />}
    </div>
  );
}
