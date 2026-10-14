import { useRef, type ReactNode } from "react";
import type { RankedGpu } from "@afflatus/core";
import type { HuntAsk } from "./api";
import { usd } from "./format";
import { firstPick, giveUpOptions, MODES, minutesSaid, renderSaid } from "./huntSaid";
import { Select } from "./Select";
import { Checkbox, cx, ErrorNote, Help, NumberBox, Segmented } from "./ui";

const WHY_MODE = "What the hunt deploys first, among the GPUs ticked that fit these renders and are within your price. Best value: the lowest cost a render (its time on that GPU times its price an hour). Fastest: the shortest render. Cheapest an hour: the lowest price an hour. A render's time comes from your own renders on that GPU; a guess from a GPU you rendered on until you have some.";
const WHY_TABLE = "Ticked: the hunt may deploy it. Fits these renders: no file of the renders waiting is larger than its memory, nor ran out of memory on it before. Now: RunPod's stock where the pod would go. The first GPU in this order that is free is deployed, once.";
const WHY_HOLD = "Hold: the home machines are paused (a render under way finishes first) so that every render waiting goes to the GPU found; they go on when its pod stops, or when the hunt ends without one. Keep rendering: they go on, and the GPU found takes its share.";

const HOLDS: Array<{ value: HuntAsk["hold"]; label: string; note: string }> = [
  { value: "rest", label: "Hold the renders for it: this PC rests", note: "Your renders wait, this PC takes none. When the pod is up, they all go there; this PC goes on once the pod stops." },
  { value: "keep", label: "Keep rendering here", note: "This PC goes on; the pod joins when found and takes its share." },
];
const STOCK_DOT = { free: "bg-good", "a few free": "bg-accent", "none free": "bg-line-strong" } as const;
const COLS = "grid-cols-[28px_minmax(0,1fr)_72px_150px_150px_92px]";

/**
 * The Deploy dialog's hunt, when the GPU wanted is not free: what it ranks by and up to what price, RunPod's GPUs ranked
 * for the renders waiting (a tick leaves one out), what the home machines do meanwhile and when it gives up. The dialog
 * keeps its other choices (image, disk, when done, models): the hunt deploys with them.
 */
export function HuntSection({ ask, change, ranking, failed, pending, volume, warning }: {
  ask: HuntAsk;
  change(c: Partial<HuntAsk>): void;
  ranking: RankedGpu[] | null;
  failed: string | null;
  pending: boolean;
  /** The network volume the pod would use: the hunt looks in its data center only. */
  volume: { name: string; dataCenter: string } | null;
  /** The line over it: the GPU wanted not free, and a free one to deploy instead; nothing when changing a hunt. */
  warning: ReactNode;
}) {
  const pick = firstPick(ranking);
  // the rows keep their places while GPUs are ticked or RunPod's stock is read again: a row moving under the pointer as it
  // is unticked is a button moving. They are put in the ranking's order again when what it ranks by changes
  // (until a tick is clicked here, the order follows the ranking: the GPUs left out at first are set by the dialog)
  const order = useRef<{ by: string; ids: string[] }>({ by: "", ids: [] });
  const touched = useRef(false);
  const by = `${ask.mode}|${ask.ceiling}`;
  if (ranking && (!touched.current || order.current.by !== by ||order.current.ids.length !== ranking.length || ranking.some((g) => !order.current.ids.includes(g.id)))) {
    order.current = { by, ids: ranking.map((g) => g.id) };
  }
  const rows = ranking ? order.current.ids.map((id) => ranking.find((g) => g.id === id)!) : null;
  const leave = (id: string, on: boolean) => {
    // the order as it stands is kept from here
    touched.current = true;
    change({ leftOut: on ? ask.leftOut.filter((x) => x !== id) : [...ask.leftOut, id] });
  };
  return (
    <section className="flex flex-col gap-3">
      {warning}
      <div className="flex flex-wrap items-center gap-3">
        <span className="w-[110px] text-xs font-semibold text-ink-2">Hunt for</span>
        <Segmented<HuntAsk["mode"]> label="Hunt for" value={ask.mode} options={MODES.map(({ value, label }) => ({ value, label }))} onChange={(mode) => change({ mode })} />
        <Help text={WHY_MODE} />
        <span className="grow" />
        <span className="flex items-center gap-2 text-[13px] text-ink-2">
          Up to $
          <NumberBox label="Highest price an hour, USD" value={ask.ceiling} min={0.05} max={1000} step={0.01} onCommit={(ceiling) => change({ ceiling })} className="-ml-1" />
          an hour
        </span>
      </div>
      <span className="-mt-1.5 pl-[122px] text-xs text-ink-3">{MODES.find((m) => m.value === ask.mode)!.note}</span>

      {/* one height whatever the answer, as the stock list's: the dialog does not move under the pointer */}
      <div role="table" aria-label="GPUs the hunt may deploy, ranked" className="flex h-[300px] flex-col overflow-y-auto rounded-xl border border-line">
        <div role="row" className={cx("sticky top-0 z-10 grid items-center gap-2.5 border-b border-line bg-panel px-3 py-1.5 text-[11px] font-semibold text-ink-3", COLS)}>
          <span><Help text={WHY_TABLE} /></span>
          <span>GPU</span>
          <span className="text-right">An hour</span>
          <span className="text-right">A render</span>
          <span>Fits these renders</span>
          <span>Now</span>
        </div>
        {failed && <div className="p-3"><ErrorNote>{failed}</ErrorNote></div>}
        {!failed && !ranking && <span className="px-3 py-2.5 text-xs text-ink-3">{pending ? "Asking RunPod…" : "Nothing to rank yet."}</span>}
        {rows?.map((g) => (
          <div key={g.id} role="row" className={cx("grid items-center gap-2.5 border-b border-line/60 px-3 py-2 text-[13px] last:border-b-0", COLS, g.fit !== "yes" && "opacity-50", g === pick && "bg-accent-wash")}>
            <Checkbox checked={!ask.leftOut.includes(g.id)} onChange={(on) => leave(g.id, on)} label={`Hunt for ${g.name}`} />
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate font-semibold">{g.name}</span>
              {g.memory > 0 && <span className="shrink-0 rounded-md bg-raised px-1.5 font-mono text-[11px] text-ink-2">{g.memory} GB</span>}
              {g === pick && <span className="shrink-0 rounded-md bg-accent px-1.5 text-[11px] font-bold text-accent-ink">first pick</span>}
            </span>
            <span className="text-right font-mono text-xs">{usd(g.price)}</span>
            <span className="flex flex-col items-end">
              <span className={cx("text-xs", g.cost === null ? "text-ink-3" : "font-mono")}>{renderSaid(g)}</span>
              {g.cost !== null && <span className="text-[11px] text-ink-3">{g.timeSaid}</span>}
            </span>
            <span className={cx("text-xs", g.fit === "yes" ? "text-good" : "text-ink-2")}>{g.fits}</span>
            <span className="flex items-center gap-1.5 text-xs text-ink-2"><span className={cx("size-2 shrink-0 rounded-full", STOCK_DOT[g.stock])} />{g.stock}</span>
          </div>
        ))}
      </div>
      <span className="-mt-1.5 text-xs text-ink-3">
        {volume ? `On the volume “${volume.name}” in ${volume.dataCenter}: the hunt looks in that data center only. ` : ""}
        A render's time and cost come from your own renders on that GPU; a guess until you have some.
      </span>

      <div className="flex items-start gap-3">
        <span className="flex w-[110px] shrink-0 items-center gap-1.5 pt-2.5 text-xs font-semibold text-ink-2">While it hunts <Help text={WHY_HOLD} /></span>
        <div role="radiogroup" aria-label="While it hunts" className="flex grow flex-col gap-2">
          {HOLDS.map((h) => (
            <button
              key={h.value}
              type="button"
              role="radio"
              aria-checked={ask.hold === h.value}
              onClick={() => change({ hold: h.value })}
              className={cx("flex items-start gap-3 rounded-[10px] border px-3.5 py-2.5 text-left", ask.hold === h.value ? "border-accent bg-accent-wash" : "border-line bg-raised hover:bg-hover")}
            >
              <span aria-hidden className={cx("mt-0.5 size-3.5 shrink-0 rounded-full", ask.hold === h.value ? "border-4 border-accent" : "border-[1.5px] border-(--control-edge)")} />
              <span className="flex flex-col gap-0.5">
                <span className="text-[13px] font-semibold text-ink">{h.label}</span>
                <span className="text-xs text-ink-2">{h.note}</span>
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <span className="w-[110px] shrink-0 text-xs font-semibold text-ink-2">Give up after</span>
        <span className="w-[120px]">
          <Select size="sm" label="Give up after" value={String(ask.giveUpMinutes)} onChange={(v) => change({ giveUpMinutes: Number(v) })} options={giveUpOptions(ask.giveUpMinutes).map((n) => ({ value: String(n), label: minutesSaid(n) }))} />
        </span>
        <span className="text-xs text-ink-3">from its start; then this PC goes on, and you are told</span>
      </div>
    </section>
  );
}
