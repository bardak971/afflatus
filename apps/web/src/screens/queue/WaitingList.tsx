import { useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpToLine, GripVertical, X } from "lucide-react";
import type { Job } from "../../api";
import { ContextMenu, useMenu, type MenuItem } from "../../ContextMenu";
import { aboutMs, when } from "../../format";
import { cx, SectionTitle } from "../../ui";
import { dropped, modelSwitches, moved } from "./order";

/** What comes next: dragged up and down, or moved and removed from its menu. */
export function WaitingList({ waiting, onOrder, onRemove }: { waiting: Job[]; onOrder(ids: string[]): void; onRemove(id: string): void }) {
  const [dragged, setDragged] = useState<string | null>(null);
  const [over, setOver] = useState<number | null>(null);
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
  const drop = (index: number) => {
    if (!dragged) return;
    onOrder(dropped(ids, dragged, index));
    setDragged(null);
    setOver(null);
  };
  const waitingMs = waiting.reduce((sum, w) => sum + (w.estimateMs ?? 0), 0);
  const switches = modelSwitches(waiting);

  return (
    <section className="flex flex-col gap-2" onDragOver={(e) => dragged && e.preventDefault()} onDrop={() => over !== null && drop(over)}>
      <div className="flex items-baseline justify-between gap-2">
        <SectionTitle>Next · {waiting.length}</SectionTitle>
        {waiting.length > 0 && (
          <span className="truncate text-xs text-ink-2">
            {waitingMs ? `${aboutMs(waitingMs)} in all` : ""}{switches ? ` · ${switches} model switch${switches > 1 ? "es" : ""}` : ""}
          </span>
        )}
      </div>
      {waiting.map((w, i) => (
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
          className={cx(
            "flex items-center gap-2 rounded-[10px] border border-line bg-panel py-2 pr-1.5 pl-1.5",
            dragged === w.id && "opacity-50",
            dragged && over === i && "border-t-accent",
            dragged && over === i + 1 && i === waiting.length - 1 && "border-b-accent",
          )}
        >
          <GripVertical size={15} className="shrink-0 cursor-grab text-ink-3" />
          <span className="min-w-0 grow">
            <span className="block truncate text-sm font-semibold">{w.label}</span>
            <span className="block text-xs text-ink-2">{w.kind === "export" || w.kind === "cut" ? `${w.kind} · no GPU needed` : w.kind === "load" ? "loads the model, renders nothing" : `queued ${when(w.createdAt)}`}</span>
          </span>
          {w.estimateMs ? <span className="shrink-0 text-xs text-ink-2">{aboutMs(w.estimateMs)}</span> : null}
          <button type="button" aria-label={`Remove ${w.label} from the queue`} onClick={() => onRemove(w.id)} className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 hover:bg-hover">
            <X size={15} />
          </button>
        </div>
      ))}
      {!waiting.length && <div className="rounded-xl border border-line px-3.5 py-3 text-sm text-ink-2">Nothing queued.</div>}
      {menu.menu && <ContextMenu at={menu.menu.at} label={`Actions on ${menu.menu.subject.label}`} items={itemsOf(menu.menu.subject)} onClose={menu.close} />}
      {waiting.length > 1 && <span className="text-xs text-ink-3">Drag to reorder. Images go before videos unless you move them.</span>}
    </section>
  );
}
