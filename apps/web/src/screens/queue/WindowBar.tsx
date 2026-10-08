import { Kbd } from "../../Keys";
import { Button, cx } from "../../ui";
import { PRESETS, toLocalInput, typedWindow, type View } from "./useTimesView";

/**
 * Which window of time is looked at: a preset, ending now; or two moments typed (Enter looks at them); or twice
 * the window around its middle. A window dragged on a chart shows here as its two moments.
 */
export function WindowBar({ view, shown, typed, onTyped, onPreset, onZoom }: {
  view: View;
  /** The window the figures cover now. */
  shown: { from: number; to: number };
  typed: { from: string; to: string } | null;
  onTyped(typed: { from: string; to: string }): void;
  onPreset(label: string): void;
  onZoom(from: number, to: number): void;
}) {
  const bounds = typed ?? { from: toLocalInput(shown.from), to: toLocalInput(shown.to) };
  const asked = typedWindow(typed);
  const spanMs = shown.to - shown.from;
  return (
    <>
      <div role="radiogroup" aria-label="Window" className="flex overflow-hidden rounded-lg border border-line-strong">
        {PRESETS.map((p) => (
          <button key={p.label} type="button" role="radio" aria-checked={view.preset === p.label} onClick={() => onPreset(p.label)} className={cx("h-8 px-2.5 text-xs font-semibold", view.preset === p.label ? "bg-accent text-accent-ink" : "text-ink-2 hover:bg-hover hover:text-ink")}>{p.label}</button>
        ))}
      </div>
      <div className="flex items-center gap-1.5 text-xs">
        {(["from", "to"] as const).map((end, i) => (
          <span key={end} className="contents">
            {i === 1 && <span className="text-ink-3">→</span>}
            <input
              aria-label={end === "from" ? "From" : "To"}
              value={bounds[end]}
              spellCheck={false}
              placeholder="YYYY-MM-DD HH:MM"
              onChange={(e) => onTyped({ ...bounds, [end]: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter" && asked) onZoom(asked.from, asked.to);
              }}
              data-tip={typed && !asked ? "Two moments as YYYY-MM-DD HH:MM, the end after the start" : "A moment as YYYY-MM-DD HH:MM"}
              className={cx("h-8 w-[136px] rounded-lg border bg-raised px-2 font-mono text-xs text-ink outline-none focus:border-accent", typed && !asked ? "border-warn" : "border-line")}
            />
          </span>
        ))}
        {typed && asked && <span className="flex items-center gap-1 text-ink-3"><Kbd>Enter</Kbd> to look</span>}
        <Button size="sm" data-tip="Twice the window, around the same middle" onClick={() => { const mid = (shown.from + shown.to) / 2; onZoom(mid - spanMs, Math.min(Date.now(), mid + spanMs)); }}>Wider</Button>
      </div>
    </>
  );
}
