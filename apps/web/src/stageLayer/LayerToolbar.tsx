import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cx } from "../cx";
import { Kbd } from "../Keys";
import { isTool, type LayerTool, type ToolbarItem } from "./tools";

/**
 * The layer's tools down the Stage's left edge, the same bar in every use of the layer: what it holds changes with the job
 * (the mask's brush and fills, the outpaint frame, the boxes). Icons only (owner's pick on mock-0.10-paint-look): each says its
 * name and key in its tip, under small group captions (Mask, Box, Frame, View); the tools after a "box" group are drawn in
 * the box's blue, so a box never reads as paint. One that acts at once (invert) does so, the others become the one the
 * pointer draws with. `named`: the tool in hand keeps its name and key beside the bar, in a column of its own so that it
 * never lies over the picture. On a Stage too short for the tools in one column (1280 × 800 with the form open, the versions
 * strip shown), they go two by two; shorter still, the bar scrolls, its bottom faded with an arrow while there is more, and
 * the name is shown only while its tool is in sight (it lay on the versions strip, card #332).
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
  const tool = items.find((t): t is LayerTool => isTool(t) && !t.act && t.id === active) ?? null;
  // two columns while one does not fit; `oneHigh`: the one column's height then, to go back to it once there is the room
  const [layout, setLayout] = useState<{ two: boolean; oneHigh: number }>({ two: false, oneHigh: 0 });
  const [more, setMore] = useState(false);
  const tools = items.map((t) => (isTool(t) ? t.id : t.group)).join(" ");
  const toolsWere = useRef(tools);
  // where the tool in hand sits in the bar, scrolled or not: the name beside it follows, and goes while it is out of sight
  const place = () => {
    const b = bar.current;
    const on = b?.querySelector<HTMLElement>("[data-tool][aria-pressed=true]");
    const top = b && on ? on.offsetTop - b.scrollTop : null;
    setFlagAt(b && on && top !== null && top >= 0 && top + on.offsetHeight <= b.clientHeight + 1 ? top + on.offsetHeight / 2 : null);
    setMore(Boolean(b && b.scrollHeight - b.scrollTop - b.clientHeight > 4));
  };
  const fit = () => {
    const b = bar.current;
    const room = b?.parentElement?.parentElement?.clientHeight ?? 0;
    if (!b || !room) return;
    // other tools (a Frame group come or gone): measured again from one column
    if (toolsWere.current !== tools) {
      toolsWere.current = tools;
      if (layout.two) return setLayout({ two: false, oneHigh: 0 });
    }
    if (!layout.two && b.scrollHeight > b.clientHeight + 1) setLayout({ two: true, oneHigh: b.scrollHeight });
    else if (layout.two && room >= layout.oneHigh) setLayout({ two: false, oneHigh: 0 });
  };
  useLayoutEffect(() => {
    if (!named) return;
    fit();
    place();
  });
  // the Stage's height changes with the window, the versions strip and the bar under the picture: fitted again each time
  const fitNow = useRef(fit);
  fitNow.current = () => {
    fit();
    place();
  };
  useEffect(() => {
    const room = bar.current?.parentElement?.parentElement;
    if (!named || !room) return;
    const watch = new ResizeObserver(() => fitNow.current());
    watch.observe(room);
    return () => watch.disconnect();
  }, [named]);
  const two = named && layout.two;
  let tone: "box" | undefined;
  const list = (
    <div
      ref={bar}
      role="toolbar"
      aria-orientation="vertical"
      aria-label="Tools"
      onScroll={named ? place : undefined}
      className={cx(
        // named, it is in a column of its own (its arrow under it): as high as there is room, its tools scrolling inside
        "relative gap-0.5 rounded-card border border-line bg-panel/90 p-[5px] shadow-pop backdrop-blur-md",
        named ? "min-h-0" : "shrink-0",
        two ? "grid w-[82px] grid-cols-2 content-start justify-items-center" : "flex w-[46px] flex-col items-center",
        className,
      )}
    >
      {items.map((t, i) => {
        if (!isTool(t)) {
          tone = t.tone;
          return (
            // design: a group's caption inside the 46 px bar, under the type scale's smallest so "Frame" fits its width
            <span key={`group-${t.group}`} data-tool-group className={cx("col-span-2 w-full text-center text-[8.5px] leading-none font-bold tracking-label text-ink-3 uppercase", i === 0 ? "pt-0.5 pb-0.5" : two ? "pt-1 pb-0.5" : "pt-2 pb-0.5")}>
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
      <div className="relative flex max-h-full min-h-0 shrink-0 flex-col">
        {list}
        {more && (
          <button
            type="button"
            aria-label="More tools below: go down"
            data-tip="More tools below"
            onClick={() => bar.current?.scrollBy({ top: bar.current.clientHeight * 0.8, behavior: "smooth" })}
            style={{ background: "linear-gradient(to top, var(--color-panel) 40%, transparent)" }}
            className="absolute inset-x-px bottom-px flex h-9 items-end justify-center rounded-b-card pb-0.5 text-ink-2 hover:text-ink"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
          </button>
        )}
      </div>
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
