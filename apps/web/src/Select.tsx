import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Search } from "lucide-react";
import { fuzzyFilter } from "@afflatus/core";
import { Keys } from "./Keys";
import { useLeave } from "./leave";
import { cx } from "./ui";

export interface Option {
  value: string;
  label: string;
  /** A few quiet words beside the label (the folder a file is in, what a choice does). */
  note?: string;
  /** A quiet second line under the label. */
  detail?: string;
  /** More words the search should find it by, that are not shown. */
  search?: string;
  /** The section it is listed under. Options of one section must follow each other. */
  group?: string;
  /** Shown greyed and never picked, its note saying why (a network volume another pod runs on). */
  disabled?: boolean;
  /** What shows on hover over the row, with its own head: more than its detail line holds. */
  tip?: string;
  tipHead?: string;
  /** One of the choices put forward (what a picture was made with, among everything it could be changed with): drawn so that it stands out. */
  marked?: boolean;
}

/** Shown at most at once: a longer list is narrowed by typing. */
const SHOWN = 150;

/**
 * The one dropdown of the app: a list that opens under its button, with a search bar that forgives
 * typos and letters left out. It is drawn over everything else, so it is never cut off by the panel it
 * sits in; it closes on a choice, on Escape and on a click anywhere else.
 */
export function Select({ value, options, onChange, label, placeholder = "Choose…", searchHint, id, size = "md", dashed, icon, className, footer }: {
  value: string;
  options: Option[];
  onChange(value: string): void;
  /** What is being chosen, for screen readers and as the search bar's hint. */
  label: string;
  placeholder?: string;
  /** What the search bar says it looks through, when that is more than names. */
  searchHint?: string;
  id?: string;
  size?: "md" | "sm";
  /** Drawn as an "add one" button rather than as a field holding a value. */
  dashed?: boolean;
  icon?: ReactNode;
  className?: string;
  /** Something under the list (a "new folder" row). It is given a function that closes the list. */
  footer?(close: () => void): ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<{ left: number; width: number; top?: number; bottom?: number; height: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  // it unfolds from the field; closed, it fades as a still copy while the field has the focus back at once
  const panelRef = useLeave("m-pop-out", panel);
  const list = useRef<HTMLDivElement>(null);
  // the highlight behind the active option: one box that glides from option to option when the mouse or an arrow key
  // moves it (glide set just then); opening, typing and anything else put it in place without travel
  const highlight = useRef<HTMLSpanElement>(null);
  const glide = useRef(false);
  // the search bar is the combobox: a screen reader follows the active option through aria-activedescendant
  const listId = useId();
  const optionId = (i: number) => `${listId}-${i}`;

  const selected = options.find((o) => o.value === value);
  // sections stay in their order while searching: the best matches of the first section, then of the next
  const found = useMemo(() => {
    const textOf = (o: Option) => `${o.label} ${o.note ?? ""} ${o.value} ${o.detail ?? ""} ${o.search ?? ""}`;
    const sections = [...new Set(options.map((o) => o.group))];
    return sections.flatMap((g) => fuzzyFilter(options.filter((o) => o.group === g), query, textOf));
  }, [options, query]);
  const shown = found.slice(0, SHOWN);

  const close = (refocus = true) => {
    setOpen(false);
    setQuery("");
    if (refocus) button.current?.focus();
  };

  // under the button when there is room, above it otherwise; as wide as the button, and never narrow
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const r = button.current?.getBoundingClientRect();
      if (!r) return;
      const width = Math.min(Math.max(r.width, 260), window.innerWidth - 16);
      const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
      const below = window.innerHeight - r.bottom - 12;
      const above = r.top - 12;
      // always whole on the screen, even when the button itself is partly out of it
      if (below >= 240 || below >= above) {
        const height = Math.max(200, Math.min(380, below));
        setPlace({ left, width, top: Math.max(8, Math.min(r.bottom + 4, window.innerHeight - height - 8)), height });
      } else {
        const height = Math.max(200, Math.min(380, above));
        setPlace({ left, width, bottom: Math.max(8, Math.min(window.innerHeight - r.top + 4, window.innerHeight - height - 8)), height });
      }
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !button.current?.contains(t)) close(false);
    };
    // the page moving under an open list would leave it hanging in the wrong place
    const scrolled = (e: Event) => {
      if (!panel.current?.contains(e.target as Node)) close(false);
    };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("scroll", scrolled, true);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("scroll", scrolled, true);
    };
  }, [open]);

  // opening starts on the current choice; typing starts again from the best match
  useEffect(() => {
    if (open) setActive(Math.max(0, query ? 0 : shown.findIndex((o) => o.value === value)));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the choice is taken as the list opens or the query changes, not as it is moved through
  }, [open, query]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);
  // after every render: options change height (a second line, a section's title), so the box follows the row itself
  useLayoutEffect(() => {
    const box = highlight.current;
    if (!box) return;
    const row = list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    box.toggleAttribute("data-glide", glide.current);
    glide.current = false;
    if (!row) {
      box.style.opacity = "0";
      return;
    }
    Object.assign(box.style, { opacity: "1", top: `${row.offsetTop}px`, height: `${row.offsetHeight}px`, left: `${row.offsetLeft}px`, width: `${row.offsetWidth}px` });
  });
  /** The active option moved by the mouse or a key: the highlight glides there. */
  const moveTo = (i: number) => {
    if (i === active) return;
    glide.current = true;
    setActive(i);
  };

  const pick = (o: Option) => {
    if (o.disabled) return;
    onChange(o.value);
    close();
  };

  return (
    <>
      <button
        ref={button}
        id={id}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${selected?.label ?? placeholder}`}
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={cx(
          "flex w-full min-w-0 items-center gap-2 text-left transition-colors",
          size === "md" ? "h-10 rounded-[10px] px-3" : "h-8 rounded-lg px-2.5 text-xs",
          dashed ? "border-[1.5px] border-dashed border-line-strong text-ink-2 hover:text-ink" : open ? "border border-accent bg-accent-wash text-ink" : "border border-line-strong bg-raised text-ink hover:border-ink-3",
          className,
        )}
      >
        {icon}
        <span className={cx("min-w-0 grow truncate", !dashed && selected && "font-semibold", !selected && !dashed && "text-ink-3")}>{selected?.label ?? placeholder}</span>
        {!dashed && <ChevronDown size={15} className={cx("shrink-0 transition-transform motion-reduce:transition-none", open ? "rotate-180 text-accent" : "text-ink-2")} />}
      </button>

      {open && place && createPortal(
        <div
          ref={panelRef}
          data-floating
          style={{ left: place.left, width: place.width, top: place.top, bottom: place.bottom, maxHeight: place.height, transformOrigin: place.top !== undefined ? "top" : "bottom" }}
          className="m-pop fixed z-[70] flex flex-col overflow-hidden rounded-[14px] border border-line-strong bg-panel shadow-2xl shadow-shade/60"
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-line px-3">
            <Search size={14} className="shrink-0 text-ink-3" />
            <input
              autoFocus
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={shown[active] ? optionId(active) : undefined}
              aria-label={`Search ${label}`}
              placeholder={searchHint ?? (options.length > 1 ? `Search ${options.length}` : "Search")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                // what is typed here is for the list alone: the screen behind must not react to it
                e.stopPropagation();
                if (e.key === "Escape") close();
                else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  moveTo(Math.max(0, Math.min(active + 1, shown.length - 1)));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  moveTo(Math.max(active - 1, 0));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  if (shown[active]) pick(shown[active]);
                }
              }}
              style={{ outline: "none" }}
              className="h-10 min-w-0 grow bg-transparent text-ink placeholder:text-ink-3"
            />
          </div>
          <div ref={list} id={listId} role="listbox" aria-label={label} className="relative flex min-h-0 grow flex-col overflow-y-auto p-1">
            <span ref={highlight} aria-hidden className="pointer-events-none absolute rounded-lg bg-hover motion-safe:data-[glide]:[transition:top_var(--t-pop)_var(--ease-snap),height_var(--t-pop)_var(--ease-snap)]" />
            {shown.map((o, i) => (
              <Fragment key={o.value}>
              {o.group && o.group !== shown[i - 1]?.group && <div className={cx("shrink-0 px-2 pt-2.5 pb-1 text-[11px] font-bold tracking-[0.08em] uppercase", o.marked ? "text-accent" : "text-ink-3")}>{o.group}</div>}
              <button
                type="button"
                id={optionId(i)}
                role="option"
                aria-selected={o.value === value}
                aria-disabled={o.disabled || undefined}
                tabIndex={-1}
                data-index={i}
                onClick={() => pick(o)}
                onPointerMove={() => moveTo(i)}
                data-tip={o.tip}
                data-tip-head={o.tip ? o.tipHead : undefined}
                className={cx(
                  // over the gliding highlight, which is the active option's background
                  "relative flex min-h-8 shrink-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left",
                  o.value === value ? "bg-accent-wash shadow-[inset_0_0_0_1px_var(--color-accent)]" : o.marked && i !== active && "bg-accent-wash",
                  o.value === value && i === active && "brightness-110",
                  o.marked && "mb-0.5",
                  o.disabled && "cursor-not-allowed opacity-50",
                )}
              >
                <span className="flex h-4 w-4 shrink-0 items-center justify-center text-accent">{o.value === value && <Check size={14} strokeWidth={3} />}</span>
                <span className="flex min-w-0 grow flex-col">
                  <span className={cx("break-words", o.marked && "font-medium")}>{o.label}</span>
                  {/* two lines at most: a LoRA's trigger words can run to a hundred tags, which made each row a page; all of it
                      in the tip, and the search still reads all of it */}
                  {o.detail && <span data-tip={o.detail.length > 90 ? o.detail : undefined} className="line-clamp-2 break-words text-xs text-ink-3">{o.detail}</span>}
                </span>
                {o.note && <span className="max-w-[45%] shrink-0 truncate text-xs text-ink-3">{o.note}</span>}
              </button>
              </Fragment>
            ))}
            {!shown.length && <span className="px-3 py-2.5 text-ink-2">{options.length ? "Nothing matches." : "There is nothing to choose from."}</span>}
            {found.length > shown.length && <span className="px-3 py-2 text-xs text-ink-3">{found.length - shown.length} more: type to narrow the list.</span>}
          </div>
          {footer && <div className="shrink-0 border-t border-line p-1.5">{footer(() => close())}</div>}
          <div aria-hidden className="flex shrink-0 items-center gap-3 border-t border-line px-3 py-1.5 text-[11px] text-ink-3">
            <span className="flex items-center gap-1"><Keys keys="↑" size="sm" /><Keys keys="↓" size="sm" /> move</span>
            <span className="flex items-center gap-1"><Keys keys="Enter" size="sm" /> pick</span>
            <span className="flex items-center gap-1"><Keys keys="Esc" size="sm" /> close</span>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
