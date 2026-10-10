import { useState } from "react";
import { ArrowDownToLine, ArrowUpToLine, Layers, Trash2, X } from "lucide-react";
import type { Job, RunningJob } from "../../api";
import { ContextMenu, useMenu, type MenuItem } from "../../ContextMenu";
import { aboutMs, when } from "../../format";
import { Button, Chip, cx, SectionTitle } from "../../ui";
import { useQueueBulk } from "./bulk";
import { useModelName } from "./modelName";
import { betterPlace, dropped, groupingSaves, loadsAt, modelSwitches, moved } from "./order";

/** How many waiting jobs show before the rest fold into "and N more". */
const SHOWN = 3;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * What the waiting jobs come to, over them: how many, about how long in all (with what the running job has left),
 * the model switches on the way with a "Group by model" when grouping saves loads, and "Cancel all waiting…".
 */
function WaitingHead({ waiting, running }: { waiting: Job[]; running: RunningJob | null }) {
  const bulk = useQueueBulk();
  const [busy, setBusy] = useState(false);
  const ms = waiting.reduce((sum, w) => sum + (w.estimateMs ?? 0), 0) + (running?.eta ?? 0) * 1000;
  const switches = modelSwitches(waiting, running);
  const saves = groupingSaves(waiting, running);
  const run = (work: () => Promise<unknown>) => {
    setBusy(true);
    void work().finally(() => setBusy(false));
  };
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 pt-1.5 pb-1 pl-3">
      <SectionTitle>Next · {waiting.length}</SectionTitle>
      {ms > 0 && <span className="text-xs text-ink-2">{aboutMs(ms)} in all</span>}
      {switches > 0 && <Chip tone="warn" tip="Each switch loads another model first">{plural(switches, "model switch", "model switches")}</Chip>}
      {saves > 0 && (
        <Button size="sm" className="h-7" disabled={busy} data-tip={`Same model together, the loaded one first: saves ${plural(saves, "load")}`} onClick={() => run(bulk.groupQueueByModel)}>
          Group by model
        </Button>
      )}
      <span className="grow" />
      <Button size="sm" className="h-7" disabled={busy} onClick={() => run(() => bulk.cancelAllWaiting({ ids: waiting.map((w) => w.id) }))}>Cancel all waiting…</Button>
    </div>
  );
}

/** What comes next, as compact numbered rows: dragged up and down, or moved and removed from its menu. The first few show; the rest unfold. */
export function WaitingList({ waiting, running, onOrder, onRemove }: { waiting: Job[]; running: RunningJob | null; onOrder(ids: string[]): void; onRemove(id: string): void }) {
  const [dragged, setDragged] = useState<string | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [all, setAll] = useState(false);
  const modelOf = useModelName();
  const bulk = useQueueBulk();
  /** The right-click menu of a waiting job: run it next, move it where it saves model loads, group the line, cancel it or all. */
  const menu = useMenu<{ id: string; label: string; index: number }>();
  const ids = waiting.map((w) => w.id);
  const saves = groupingSaves(waiting, running);
  /** The model each row loads first (the running job counts as the one before the first): one chip per switch the head counts. */
  const loads = loadsAt(waiting, running);
  const itemsOf = (j: { id: string; index: number }): MenuItem[] => {
    const place = betterPlace(waiting, j.id, running);
    return [
      { label: "Run next", icon: <ArrowUpToLine size={14} />, disabled: j.index === 0, run: () => onOrder(moved(ids, j.id, 0)) },
      ...(place ? [{ label: `Move after the ${modelOf(place.after).split(" · ")[0]} jobs`, icon: <ArrowDownToLine size={14} />, note: `saves ${plural(place.saves, "load")}`, run: () => onOrder(moved(ids, j.id, place.to)) }] : []),
      { label: "Group by model", icon: <Layers size={14} />, note: saves ? `saves ${plural(saves, "load")}` : undefined, disabled: !saves, run: () => void bulk.groupQueueByModel() },
      "—",
      { label: "Cancel this one", key: "Del", icon: <X size={14} />, danger: true, run: () => onRemove(j.id) },
      { label: "Cancel all waiting…", icon: <Trash2 size={14} />, danger: true, run: () => void bulk.cancelAllWaiting({ ids }) },
    ];
  };
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
      <WaitingHead waiting={waiting} running={running} />
      {shown.map((w, i) => (
        <div
          key={w.id}
          tabIndex={0}
          onContextMenu={(e) => menu.open(e, { id: w.id, label: w.label, index: i })}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget || e.key !== "Delete") return;
            e.preventDefault();
            onRemove(w.id);
          }}
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
            "group flex cursor-grab items-center gap-3.5 rounded-[10px] border-y-2 border-transparent py-px pr-1 pl-3 text-[13px] hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent",
            dragged === w.id && "opacity-50",
            dragged && over === i && "border-t-accent",
            dragged && over === i + 1 && i === shown.length - 1 && "border-b-accent",
          )}
        >
          <span className="w-[18px] shrink-0 font-mono text-ink-3">{i + 1}</span>
          <span className="min-w-0 grow truncate font-semibold">{w.label}</span>
          <span className="max-w-[40%] shrink-0 truncate text-ink-2">{w.kind === "load" ? `load · ${modelOf(w)}` : modelOf(w)}</span>
          {loads[i] && <Chip tone="warn" tip={`ComfyUI loads ${modelOf(w)} before this one`}>loads {modelOf(w).split(" · ")[0]}</Chip>}
          <span className="w-[70px] shrink-0 text-right font-mono text-ink-2">{w.estimateMs ? `~${aboutMs(w.estimateMs).replace(/^about /, "")}` : "—"}</span>
          <button type="button" aria-label={`Cancel ${w.label}`} data-tip="Cancel this one (Del)" onClick={() => onRemove(w.id)} className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-3 opacity-0 group-hover:opacity-100 hover:bg-raised hover:text-ink focus-visible:opacity-100">
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
