import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, Search, X } from "lucide-react";
import { ContextMenu, useMenu } from "../ContextMenu";
import { useFit } from "../useFit";
import { cx, pillBox, placePill, sameBox, type PillBox } from "../ui";
import { scrollInside } from "../scrollInside";

/**
 * The strip at the top of a form: its parts in the order they are touched, the one in view marked;
 * a click opens a part and scrolls to it. Beside them, a search over the form's settings (typing
 * leaves only the settings that match). A part's id can be a chapter's id from an imported workflow:
 * it is escaped before it goes in a selector.
 */
export function Strip({ parts, open, query, setQuery, found }: {
  parts: Array<{ id: string; label: string }>;
  open(id: string): void;
  query: string;
  setQuery(q: string): void;
  /** How many settings match what is typed. */
  found: number;
}) {
  const [current, setCurrent] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const self = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => { if (searching) box.current?.focus(); }, [searching]);
  const stop = () => { setQuery(""); setSearching(false); };
  // a part clicked in the strip stays the current one until the user scrolls on their own: it may not
  // reach the top of the view (the form's end is near), and the strip must still say what was asked for
  const pinned = useRef(false);
  // the listeners are bound again when the parts change, not on every keystroke (the array is new each render)
  const partIds = parts.map((p) => p.id).join("|");
  // one line, always: the parts that do not fit go under a "+N" at the end (a form of many sections, a narrow column)
  const fold = useFit(self, Math.max(0, parts.length - 1), partIds);
  const shown = parts.slice(0, parts.length - fold);
  const hidden = parts.slice(parts.length - fold);
  const more = useMenu<true>();
  const goTo = (id: string) => {
    open(id);
    pinned.current = true;
    setCurrent(id);
    requestAnimationFrame(() => scrollInside(document.querySelector(`[data-part="${CSS.escape(id)}"]`)));
  };
  // how far above its place the strip sticks: the scroller's top padding, so that it sits against the box's top edge
  // when stuck (a sticky row stops at the padding's edge, and what is scrolled past would show in that gap above it)
  const [lift, setLift] = useState(0);
  // the part in view is lit by one pill that stretches from the part before to the new one, as a Segmented's does:
  // a click or the scroll moves it. Until it is placed (before the first paint) the part is lit by its own background
  const pill = useRef<HTMLSpanElement>(null);
  const at = useRef<PillBox | null>(null);
  const [placed, setPlaced] = useState(false);
  const ON = ":scope > [data-on]";
  useLayoutEffect(() => {
    if (!self.current || !pill.current) return;
    const to = searching ? null : pillBox(self.current, ON);
    placePill(pill.current, at.current, to, true);
    at.current = to;
    setPlaced(true);
  }, [current, searching, fold]);
  // the strip changes width (the panel dragged wider, a font loading): the pill follows at once, without travel
  useLayoutEffect(() => {
    const s = self.current;
    if (!s) return;
    const watch = new ResizeObserver(() => {
      const to = searching ? null : pillBox(s, ON);
      if (!pill.current || sameBox(to, at.current)) return;
      placePill(pill.current, at.current, to, false);
      at.current = to;
    });
    watch.observe(s);
    return () => watch.disconnect();
  }, [searching]);
  // and behind it the colour of the box it scrolls in (a panel, a kit editor): what is scrolled past stays hidden
  // in its rounded corners too
  const [backing, setBacking] = useState<string | undefined>(undefined);
  useEffect(() => {
    // the nearest thing that scrolls: the form's parts scroll inside it
    let root = self.current?.parentElement ?? null;
    while (root && !/auto|scroll/.test(getComputedStyle(root).overflowY)) root = root.parentElement;
    if (!root) return;
    const paint = () => {
      setLift(parseFloat(getComputedStyle(root).paddingTop) || 0);
      for (let el: HTMLElement | null = root; el; el = el.parentElement) {
        const colour = getComputedStyle(el).backgroundColor;
        if (colour && colour !== "transparent" && !/rgba\(.*,\s*0\)$/.test(colour)) { setBacking(colour); break; }
      }
    };
    paint();
    // another theme picked while the form is open: the backing takes the box's new colour
    const themed = new MutationObserver(paint);
    themed.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const ids = partIds.split("|").filter(Boolean);
    // looked up each time: a part can be mounted again (another chapter, the search) without the ids changing
    const find = () => ids.map((id) => root.querySelector<HTMLElement>(`[data-part="${CSS.escape(id)}"]`)).filter((e): e is HTMLElement => e !== null);
    const watch = new ResizeObserver(() => tell());
    // the current part is the one a reading line crosses, a third of the way down what is visible under the strip
    const tell = () => {
      const elements = find();
      // a part opened or closed changes the heights without a scroll: they are watched, and told again
      for (const el of elements) watch.observe(el);
      if (pinned.current) return;
      const box = root.getBoundingClientRect();
      const line = Math.max(box.top, self.current?.getBoundingClientRect().bottom ?? box.top);
      const seenOf = (r: DOMRect) => Math.max(0, Math.min(r.bottom, box.bottom) - Math.max(r.top, line));
      // scrolled to the end: a short last part can never reach the top, so it is the one being read, but only when
      // it is in view and the part before it is not still mostly there (a folded one-line Output under a Sampling
      // that fills the view is not what is read). A form too short to scroll is at its start, not its end.
      const last = elements[elements.length - 1];
      const before = elements[elements.length - 2];
      if (last && root.scrollHeight > root.clientHeight + 2 && root.scrollTop + root.clientHeight >= root.scrollHeight - 2) {
        const lastSeen = seenOf(last.getBoundingClientRect()) > 0;
        const b = before?.getBoundingClientRect();
        const mostly = b ? seenOf(b) >= 0.5 * Math.min(b.height, box.bottom - line) : false;
        if (lastSeen && !mostly) {
          setCurrent(last.dataset.part ?? null);
          return;
        }
      }
      // at the very top the first part is the one read, however short it is (a folded Model above an open Prompt)
      if (root.scrollTop <= 2) {
        setCurrent(elements[0]?.dataset.part ?? null);
        return;
      }
      // a reading line a third of the way down what is visible: the part it crosses is the one being read (the tail
      // of a prompt peeking under the strip is not; nor a Sampling just starting at the foot)
      const reading = line + (box.bottom - line) / 3;
      let best: string | null = null;
      let most = 0;
      for (const el of elements) {
        const r = el.getBoundingClientRect();
        if (r.top <= reading && r.bottom > reading) { best = el.dataset.part ?? null; break; }
        // between two parts (in a gap): the one most in view
        const seen = seenOf(r);
        if (seen > most) { most = seen; best = el.dataset.part ?? null; }
      }
      setCurrent(best ?? elements[0]?.dataset.part ?? null);
    };
    const unpin = () => { pinned.current = false; tell(); };
    watch.observe(root);
    tell();
    root.addEventListener("scroll", tell, { passive: true });
    root.addEventListener("wheel", unpin, { passive: true });
    root.addEventListener("touchmove", unpin, { passive: true });
    return () => {
      watch.disconnect();
      themed.disconnect();
      root.removeEventListener("scroll", tell);
      root.removeEventListener("wheel", unpin);
      root.removeEventListener("touchmove", unpin);
    };
  }, [partIds]);
  return (
    // the sticky row is a square backing in the box's own colour with the rounded, opaque strip in it: once stuck
    // against the box's top edge, nothing scrolled past shows through the strip, above it or in its corners
    <div style={{ top: -lift, backgroundColor: backing }} className="sticky z-10 shrink-0">
      <div ref={self} className="relative flex items-center gap-x-0.5 overflow-x-hidden rounded-lg border border-line bg-raised px-1 py-1 shadow-md shadow-shade/20">
        <span
          ref={pill}
          aria-hidden
          className="pointer-events-none absolute rounded bg-line-strong motion-safe:data-[travel]:[transition:left_var(--t-travel)_var(--ease-snap)_var(--edge-l),right_var(--t-travel)_var(--ease-snap)_var(--edge-r),top_var(--t-travel)_var(--ease-snap)]"
        />
        {searching ? (
          <label className="flex h-7 min-w-0 grow items-center gap-1.5 rounded-full border border-line bg-panel px-2 text-xs focus-within:border-accent">
            <Search size={13} className="shrink-0 text-ink-2" />
            <input
              ref={box}
              data-search="form"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              // what is typed here is for the form alone: the screen's keys must not react to it
              onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") { e.preventDefault(); stop(); } }}
              placeholder="Find a setting (steps, cfg, shift, crf, tile…)"
              aria-label="Find a setting"
              className="min-w-0 grow bg-transparent placeholder:text-ink-3"
            />
            {query.trim() && <span className="shrink-0 text-ink-3">{found}</span>}
            <button type="button" aria-label="Stop searching" onClick={stop} className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-ink-2 hover:bg-hover hover:text-ink"><X size={13} /></button>
          </label>
        ) : (
          <>
            {shown.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => goTo(p.id)}
                data-on={current === p.id ? "" : undefined}
                className={cx("relative shrink-0 rounded px-1.5 py-1 text-[11px] font-semibold whitespace-nowrap transition-colors", current === p.id ? cx("text-ink-strong", !placed && "bg-line-strong") : "text-ink-2 hover:bg-hover hover:text-ink")}
              >
                {p.label}
              </button>
            ))}
            {hidden.length > 0 && (
              <button
                type="button"
                aria-haspopup="menu"
                aria-label={`${hidden.length} more part${hidden.length === 1 ? "" : "s"}`}
                data-tip={hidden.map((p) => p.label).join(", ")}
                onClick={(e) => more.open(e, true)}
                data-on={hidden.some((p) => p.id === current) ? "" : undefined}
                className={cx("relative flex shrink-0 items-center gap-0.5 rounded px-1.5 py-1 text-[11px] font-semibold whitespace-nowrap transition-colors", hidden.some((p) => p.id === current) ? cx("text-ink-strong", !placed && "bg-line-strong") : "text-ink-2 hover:bg-hover hover:text-ink")}
              >
                {hidden.find((p) => p.id === current)?.label ?? `+${hidden.length}`}
                <ChevronDown size={11} />
              </button>
            )}
            {more.menu && <ContextMenu at={more.menu.at} label="More parts of the form" items={hidden.map((p) => ({ label: p.label, note: p.id === current ? "in view" : undefined, run: () => goTo(p.id) }))} onClose={more.close} />}
          </>
        )}
        <span className="grow" />
        {!searching && (
          <button
            type="button"
            data-search-opener
            onClick={() => setSearching(true)}
            aria-label="Find a setting"
            data-tip="Find a setting by its name"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-ink-2 hover:bg-hover hover:text-ink"
          >
            <Search size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
