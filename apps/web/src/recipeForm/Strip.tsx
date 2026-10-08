import { useEffect, useRef, useState } from "react";
import { ChevronDown, Search, X } from "lucide-react";
import { ContextMenu, useMenu } from "../ContextMenu";
import { useFit } from "../useFit";
import { cx } from "../ui";

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
    requestAnimationFrame(() => document.querySelector(`[data-part="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };
  useEffect(() => {
    // the nearest thing that scrolls: the form's parts scroll inside it
    let root = self.current?.parentElement ?? null;
    while (root && !/auto|scroll/.test(getComputedStyle(root).overflowY)) root = root.parentElement;
    if (!root) return;
    const elements = partIds.split("|").filter(Boolean).map((id) => root.querySelector<HTMLElement>(`[data-part="${CSS.escape(id)}"]`)).filter((e): e is HTMLElement => e !== null);
    // the current part is the one under the strip when a real stretch of it is still in view (not the
    // tail of a folded line), else the one that fills most of the view
    const tell = () => {
      if (pinned.current) return;
      const box = root.getBoundingClientRect();
      const line = box.top + 56;
      let best: string | null = null;
      let most = 0;
      // scrolled to the end: the last part is the one being read, however short it is
      const last = elements[elements.length - 1];
      if (last && root.scrollTop + root.clientHeight >= root.scrollHeight - 2) {
        setCurrent(last.dataset.part ?? null);
        return;
      }
      for (const el of elements) {
        const r = el.getBoundingClientRect();
        if (r.top <= line + 1 && r.bottom > line + 120) { best = el.dataset.part ?? null; break; }
        const seen = Math.min(r.bottom, box.bottom) - Math.max(r.top, line);
        if (seen > most) { most = seen; best = el.dataset.part ?? null; }
      }
      setCurrent(best ?? elements[0]?.dataset.part ?? null);
    };
    const unpin = () => { pinned.current = false; tell(); };
    tell();
    root.addEventListener("scroll", tell, { passive: true });
    root.addEventListener("wheel", unpin, { passive: true });
    root.addEventListener("touchmove", unpin, { passive: true });
    return () => {
      root.removeEventListener("scroll", tell);
      root.removeEventListener("wheel", unpin);
      root.removeEventListener("touchmove", unpin);
    };
  }, [partIds]);
  return (
    <div ref={self} className="sticky top-0 z-10 flex shrink-0 items-center gap-x-0.5 overflow-x-hidden rounded-lg border border-line bg-raised/95 px-1 py-1 shadow-md shadow-shade/20 backdrop-blur">
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
              className={cx("shrink-0 rounded-full px-1.5 py-1 text-[11px] font-semibold whitespace-nowrap", current === p.id ? "bg-line-strong text-ink-strong" : "text-ink-2 hover:bg-hover hover:text-ink")}
            >
              {p.label}
            </button>
          ))}
          {hidden.length > 0 && (
            <button
              type="button"
              aria-haspopup="menu"
              aria-label={`${hidden.length} more part${hidden.length === 1 ? "" : "s"}`}
              title={hidden.map((p) => p.label).join(", ")}
              onClick={(e) => more.open(e, true)}
              className={cx("flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-1 text-[11px] font-semibold whitespace-nowrap", hidden.some((p) => p.id === current) ? "bg-line-strong text-ink-strong" : "text-ink-2 hover:bg-hover hover:text-ink")}
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
          title="Find a setting by its name"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-ink-2 hover:bg-hover hover:text-ink"
        >
          <Search size={14} />
        </button>
      )}
    </div>
  );
}
