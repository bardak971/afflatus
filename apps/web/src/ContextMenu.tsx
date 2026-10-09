import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronRight } from "lucide-react";
import { thumbUrl } from "./api";
import { Keys } from "./Keys";
import { useLeave } from "./leave";
import { cx } from "./ui";

/**
 * One line of a menu, or a rule between groups. Every item mirrors a button or a drag that exists
 * elsewhere: a menu is never the only way. An item with `items` opens a submenu instead of running.
 */
export type MenuItem =
  | {
      label: string;
      /** The key that does the same, in the keys grammar ("S", "Del", "Ctrl+Enter", "S | Ctrl+B"). */
      key?: string;
      icon?: ReactNode;
      /** A few quiet words after the label. */
      note?: string;
      danger?: boolean;
      disabled?: boolean;
      run?(): void;
      /** A submenu: opened on hover, → or Enter; ← or Escape closes it. */
      items?: MenuItem[];
    }
  | "—";

/** What a menu is about, at its top: a name, a dim line, and the picture of an item when it has one. */
export interface MenuHead {
  title: string;
  sub?: ReactNode;
  /** An item of the library: its thumbnail. */
  thumb?: string;
}

interface MenuAt {
  x: number;
  y: number;
  /** Opened from the keyboard (the menu key, Shift + F10, Enter on a button): its first item is active at once. */
  keyed?: boolean;
}

/**
 * Where a menu opens: at the pointer, or, opened from the keyboard (which leaves the pointer at 0, 0), under
 * the top of the element it was opened on.
 */
export function menuAt(e: { clientX: number; clientY: number }, el: { getBoundingClientRect(): { left: number; top: number; width: number; height: number } } | null): MenuAt {
  if ((e.clientX !== 0 || e.clientY !== 0) || !el) return { x: e.clientX, y: e.clientY };
  const r = el.getBoundingClientRect();
  return { x: r.left + Math.min(16, r.width / 2), y: r.top + Math.min(r.height, 28), keyed: true };
}

/**
 * A right-click menu, at the pointer: it stays inside the window, closes on a click elsewhere, Escape,
 * a scroll or a resize; the arrow keys walk it, Enter runs, → opens a submenu and ← closes it. While it
 * is open the screen's own keys are off (Keys.plainKey sees the [role=menu]).
 */
export function ContextMenu({ at, items, label, head, onClose }: { at: MenuAt; items: MenuItem[]; label: string; head?: MenuHead; onClose(): void }) {
  useEffect(() => {
    const down = (e: PointerEvent) => { if (!(e.target as Element | null)?.closest?.("[data-context-menu]")) onClose(); };
    const away = () => onClose();
    const scrolled = (e: Event) => { if (!(e.target as Element | null)?.closest?.("[data-context-menu]")) onClose(); };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("scroll", scrolled, true);
    window.addEventListener("resize", away);
    window.addEventListener("blur", away);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("resize", away);
      window.removeEventListener("blur", away);
    };
  }, [onClose]);
  return createPortal(<Panel at={at} items={items} label={label} head={head} onClose={onClose} keyed={Boolean(at.keyed)} />, document.body);
}

/** One panel of a menu: the menu itself, or a submenu beside the item that opened it. */
function Panel({ at, flipX, items, label, head, onClose, onBack, keyed = true }: {
  at: MenuAt;
  /** Where to put it when it does not fit on the right: its right edge here (the parent's left edge). */
  flipX?: number;
  items: MenuItem[];
  label: string;
  head?: MenuHead;
  onClose(): void;
  onBack?(): void;
  /** Opened from the keyboard: its first item is active at once. */
  keyed?: boolean;
}) {
  const self = useRef<HTMLDivElement>(null);
  // closed (a choice, Escape, a click elsewhere, ← out of a submenu), it fades as a still copy: the menu and its keys go at once
  const selfRef = useLeave("m-pop-out", self);
  const rows = useRef<Array<HTMLButtonElement | null>>([]);
  const [pos, setPos] = useState<MenuAt>(at);
  const runnable = items.map((it, i) => (it !== "—" && !it.disabled ? i : -1)).filter((i) => i >= 0);
  const [active, setActive] = useState(keyed ? (runnable[0] ?? -1) : -1);
  /** The submenu open from this panel: which item, and whether the keyboard opened it. */
  const [sub, setSub] = useState<{ index: number; keyed: boolean } | null>(null);

  // placed inside the window once its size is known; a submenu that does not fit on the right goes to the left. The
  // size is the layout one (offsetWidth/Height): the opening animation scales the menu down, and a size read through
  // it is 4 % short, which let a tall menu (a clip's) run off the bottom of the window.
  useEffect(() => {
    const el = self.current;
    if (!el) return;
    const r = { width: el.offsetWidth, height: el.offsetHeight };
    const x = at.x + r.width > window.innerWidth - 4 && flipX !== undefined ? flipX - r.width : at.x;
    setPos({
      x: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)),
      y: Math.max(4, Math.min(at.y, window.innerHeight - r.height - 4)),
    });
  }, [at, flipX, items.length]);

  // a menu taller than the window scrolls: the row the keys move to stays in view
  useEffect(() => {
    if (active >= 0) rows.current[active]?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const openSub = (i: number, keyed: boolean) => {
    const it = items[i];
    if (it && it !== "—" && it.items?.length && !it.disabled) setSub({ index: i, keyed });
  };
  const choose = (i: number) => {
    const it = items[i];
    if (!it || it === "—" || it.disabled) return;
    if (it.items) return openSub(i, true);
    onClose();
    it.run?.();
  };

  // only the innermost panel takes the keys: a parent with a submenu open leaves them to it
  useEffect(() => {
    if (sub) return;
    const key = (e: KeyboardEvent) => {
      const stop = () => { e.preventDefault(); e.stopPropagation(); };
      if (e.key === "Escape") { stop(); if (onBack) onBack(); else onClose(); return; }
      if (e.key === "ArrowLeft" && onBack) { stop(); onBack(); return; }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        stop();
        if (!runnable.length) return;
        const k = runnable.indexOf(active);
        setActive(e.key === "ArrowDown" ? runnable[(k + 1) % runnable.length]! : runnable[(k - 1 + runnable.length) % runnable.length]!);
        return;
      }
      if (e.key === "ArrowRight" && active >= 0) { stop(); openSub(active, true); return; }
      if (e.key === "Enter" && active >= 0) { stop(); choose(active); }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  });

  const opened = sub ? items[sub.index] : undefined;
  const anchor = sub ? rows.current[sub.index]?.getBoundingClientRect() : undefined;
  return (
    <>
      <div
        ref={selfRef}
        role="menu"
        aria-label={label}
        data-context-menu
        // a menu opened from inside a popover (the folder panel) is part of it: pressing an item does not close the popover first
        data-floating=""
        className="fixed z-[90] flex max-h-[calc(100vh-8px)] min-w-[230px] max-w-[340px] flex-col overflow-y-auto overscroll-contain rounded-[14px] border border-line-strong bg-panel p-1.5 shadow-2xl shadow-shade/60 motion-safe:animate-[tip-in_100ms_ease-out]"
        style={{ left: pos.x, top: pos.y }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {head && (
          <div className="mb-1 flex items-center gap-2.5 border-b border-line px-2 pt-1 pb-2.5">
            {head.thumb && <img src={thumbUrl(head.thumb)} alt="" className="h-10 w-10 shrink-0 rounded-lg bg-raised object-cover" />}
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate font-bold">{head.title}</span>
              {head.sub && <span className="truncate text-xs text-ink-3">{head.sub}</span>}
            </span>
          </div>
        )}
        {items.map((it, i) =>
          it === "—" ? (
            <div key={`rule-${i}`} className="mx-2 my-1 border-t border-line" />
          ) : (
            <button
              // by place, not by label: two items may say the same thing (two projects of one name under "Move to")
              key={i}
              ref={(el) => { rows.current[i] = el; }}
              type="button"
              role="menuitem"
              aria-haspopup={it.items ? "menu" : undefined}
              aria-expanded={it.items ? sub?.index === i : undefined}
              disabled={it.disabled}
              onMouseEnter={() => {
                setActive(i);
                if (it.items) openSub(i, false);
                else setSub(null);
              }}
              onClick={() => choose(i)}
              className={cx(
                "flex h-8 shrink-0 items-center gap-2.5 rounded-lg px-2 text-left text-sm disabled:opacity-40",
                (i === active || sub?.index === i) && !it.disabled && (it.danger ? "bg-warn-wash" : "bg-accent-wash shadow-[inset_0_0_0_1px_var(--color-accent)]"),
                it.danger ? "text-warn-ink" : "text-ink",
              )}
            >
              <span className={cx("flex w-4 shrink-0 items-center justify-center", it.danger ? "text-warn-ink" : "text-ink-2")}>{it.icon}</span>
              <span className="min-w-0 grow truncate">{it.label}{it.note && <span className="ml-1.5 text-xs text-ink-3">{it.note}</span>}</span>
              {it.key && <Keys keys={it.key} size="sm" className="text-ink-2" />}
              {it.items && <ChevronRight size={14} className="shrink-0 text-ink-2" />}
            </button>
          ),
        )}
      </div>
      {sub && opened && opened !== "—" && opened.items && anchor && (
        <Panel
          key={sub.index}
          at={{ x: anchor.right - 2, y: anchor.top - 5 }}
          flipX={anchor.left + 2}
          items={opened.items}
          label={opened.label}
          onClose={onClose}
          onBack={() => { setSub(null); setActive(sub.index); }}
          keyed={sub.keyed}
        />
      )}
    </>
  );
}

/** The state of one menu: where it is and what it holds. `open` takes the right-click event. */
export function useMenu<T>() {
  const [menu, setMenu] = useState<{ at: MenuAt; subject: T } | null>(null);
  const open = (e: { preventDefault(): void; clientX: number; clientY: number; currentTarget?: EventTarget | null }, subject: T) => {
    e.preventDefault();
    setMenu({ at: menuAt(e, e.currentTarget instanceof Element ? e.currentTarget : null), subject });
  };
  return { menu, open, close: () => setMenu(null) };
}
