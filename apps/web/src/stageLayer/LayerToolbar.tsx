import { cx } from "../cx";
import { IconButton } from "../ui";
import type { ToolbarItem } from "./tools";

/**
 * The layer's tools down the Stage's left edge, the same bar in every use of the layer: what it holds changes with the job
 * (the mask's brush and fills, the outpaint frame, later the regions' boxes). Each says its key in its tip; one that acts
 * at once (invert) does so, the others become the one the pointer draws with.
 */
export function LayerToolbar({ items, active, onPick, className }: { items: readonly ToolbarItem[]; active: string | null; onPick(id: string): void; className?: string }) {
  return (
    <div role="toolbar" aria-orientation="vertical" aria-label="Tools" className={cx("flex w-11 shrink-0 flex-col items-center gap-1 rounded-xl border border-line bg-panel p-1", className)}>
      {items.map((t, i) =>
        t === "rule" ? (
          <hr key={`rule-${i}`} className="my-0.5 w-6 border-line" />
        ) : (
          <IconButton
            key={t.id}
            size={36}
            label={t.label}
            tip={t.disabled ?? t.tip ?? t.label}
            keys={t.key}
            pressed={!t.act && t.id === active}
            disabled={Boolean(t.disabled)}
            onClick={() => (t.act ? t.act() : onPick(t.id))}
          >
            <t.icon size={17} />
          </IconButton>
        ),
      )}
    </div>
  );
}
