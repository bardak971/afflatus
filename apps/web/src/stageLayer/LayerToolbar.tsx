import { useLayoutEffect, useRef, useState } from "react";
import { cx } from "../cx";
import { Kbd } from "../Keys";
import { isTool, type ToolbarItem } from "./tools";

/**
 * The layer's tools down the Stage's left edge, the same bar in every use of the layer: what it holds changes with the job
 * (the mask's brush and fills, the outpaint frame, the boxes). Icons only (owner's pick on mock-0.10-paint-look): each says its
 * name and key in its tip, under small group captions (Mask, Box, Frame, View); the tools after a "box" group are drawn in
 * the box's blue, so a box never reads as paint. One that acts at once (invert) does so, the others become the one the
 * pointer draws with. `named`: the tool in hand keeps its name and key beside the bar, in a column of its own so that it
 * never lies over the picture; the bar itself scrolls on a short Stage, the name following its tool.
 */
export function LayerToolbar({ items, active, onPick, className, named }: {
  items: readonly ToolbarItem[];
  active: string | null;
  onPick(id: string): void;
  className?: string;
  named?: boolean;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const [flagAt, setFlagAt] = useState<number | null>(null);
  const current = items.find((t) => isTool(t) && !t.act && t.id === active);
  const tool = current && isTool(current) ? current : null;
  // where the tool in hand sits in the bar, scrolled or not: the name beside it follows
  const place = () => {
    const b = bar.current;
    const on = b?.querySelector<HTMLElement>("[data-tool][aria-pressed=true]");
    setFlagAt(b && on ? on.offsetTop - b.scrollTop + on.offsetHeight / 2 : null);
  };
  useLayoutEffect(() => {
    if (named) place();
  });
  let tone: "box" | undefined;
  const list = (
    <div
      ref={bar}
      role="toolbar"
      aria-orientation="vertical"
      aria-label="Tools"
      onScroll={named ? place : undefined}
      className={cx("relative flex w-[46px] shrink-0 flex-col items-center gap-0.5 rounded-card border border-line bg-panel/90 p-[5px] shadow-pop backdrop-blur-md", className)}
    >
      {items.map((t, i) => {
        if (t === "rule") return <hr key={`rule-${i}`} className="my-0.5 w-6 border-line" />;
        if (!isTool(t)) {
          tone = t.tone;
          return (
            // design: a group's caption inside the 46 px bar, under the type scale's smallest so "Frame" fits its width
            <span key={`group-${t.group}`} data-tool-group className={cx("w-full text-center text-[8.5px] leading-none font-bold tracking-label text-ink-3 uppercase", i === 0 ? "pt-0.5 pb-0.5" : "pt-2 pb-0.5")}>
              {t.group}
            </span>
          );
        }
        const on = !t.act && t.id === active;
        return (
          <button
            key={t.id}
            type="button"
            data-tool={t.id}
            data-soft-focus
            aria-label={t.label}
            aria-pressed={on}
            data-tip={t.disabled ?? t.tip ?? t.label}
            data-tip-keys={t.key}
            disabled={Boolean(t.disabled)}
            onClick={() => (t.act ? t.act() : onPick(t.id))}
            className={cx(
              "grid size-[34px] shrink-0 place-items-center rounded-lg transition-[color,background-color,transform] motion-safe:active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40",
              on ? "bg-raised text-ink-strong shadow-[inset_0_0_0_1px_var(--color-line-strong)]" : "text-ink-2 hover:bg-hover hover:text-ink disabled:hover:bg-transparent",
            )}
          >
            <t.icon size={16} className={cx(on && (tone === "box" ? "text-picture" : "text-accent"))} />
          </button>
        );
      })}
    </div>
  );
  if (!named) return list;
  return (
    <div className="relative flex h-full min-h-0 shrink-0 items-start">
      {list}
      {/* the name's own column: so wide whatever the tool, so the picture never moves when another is picked */}
      <div aria-hidden className="relative h-full w-32 shrink-0">
        {tool && flagAt !== null && (
          <span data-tool-flag className="absolute left-3 flex max-w-[calc(100%-12px)] -translate-y-1/2 items-center gap-1.5 text-xs font-semibold whitespace-nowrap text-ink-2" style={{ top: flagAt }}>
            <span className="truncate">{tool.label}</span>
            <Kbd>{tool.key}</Kbd>
          </span>
        )}
      </div>
    </div>
  );
}
