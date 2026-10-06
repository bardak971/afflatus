import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronRight } from "lucide-react";
import { Kbd } from "./Keys";
import { cx } from "./ui";

/**
 * One line of a menu, or a rule between groups. Every item mirrors a button or a drag that exists
 * elsewhere: a menu is never the only way. An item with `items` opens a submenu instead of running.
 */
export type MenuItem =
  | {
      label: string;
      /** The key that does the same, as the Keys list writes it ("S", "Del", "Ctrl + Enter"). */
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

interface MenuAt {
  x: number;
  y: number;
}

/**
 * A right-click menu, at the pointer: it stays inside the window, closes on a click elsewhere, Escape,
 * a scroll or a resize; the arrow keys walk it, Enter runs, → opens a submenu and ← closes it. While it
 * is open the screen's own keys are off (Keys.plainKey sees the [role=menu]).
 */
export function ContextMenu({ at, items, label, onClose }: { at: MenuAt; items: MenuItem[]; label: string; onClose(): void }) {
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
  return createPortal(<Panel at={at} items={items} label={label} onClose={onClose} />, document.body);
}

/** One panel of a menu: the menu itself, or a submenu beside the item that opened it. */
function Panel({ at, flipX, items, label, onClose, onBack, keyed = true }: {
  at: MenuAt;
  /** Where to put it when it does not fit on the right: its right edge here (the parent's left edge). */
  flipX?: number;
  items: MenuItem[];
  label: string;
  onClose(): void;
  onBack?(): void;
  /** Opened from the keyboard: its first item is active at once. */
  keyed?: boolean;
}) {
  const self = useRef<HTMLDivElement>(null);
  const rows = useRef<Array<HTMLButtonElement | null>>([]);
  const [pos, setPos] = useState<MenuAt>(at);
  const runnable = items.map((it, i) => (it !== "—" && !it.disabled ? i : -1)).filter((i) => i >= 0);
  const [active, setActive] = useState(onBack && keyed ? (runnable[0] ?? -1) : -1);
  /** The submenu open from this panel: which item, and whether the keyboard opened it. */
  const [sub, setSub] = useState<{ index: number; keyed: boolean } | null>(null);

  // placed inside the window once its size is known; a submenu that does not fit on the right goes to the left
  useEffect(() => {
    const el = self.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = at.x + r.width > window.innerWidth - 4 && flipX !== undefined ? flipX - r.width : at.x;
    setPos({
      x: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)),
      y: Math.max(4, Math.min(at.y, window.innerHeight - r.height - 4)),
    });
  }, [at, flipX, items.length]);

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
        ref={self}
        role="menu"
        aria-label={label}
        data-context-menu
        className="fixed z-[90] flex min-w-[220px] max-w-[340px] flex-col rounded-xl border border-line-strong bg-panel py-1 shadow-2xl shadow-shade/60"
        style={{ left: pos.x, top: pos.y }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {items.map((it, i) =>
          it === "—" ? (
            <div key={`rule-${i}`} className="my-1 border-t border-line" />
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
                "flex items-center gap-2.5 px-3 py-1.5 text-left text-sm disabled:opacity-40",
                (i === active || sub?.index === i) && !it.disabled && "bg-hover",
                it.danger ? "text-warn-ink" : "text-ink",
              )}
            >
              <span className="flex w-4 shrink-0 items-center justify-center text-ink-2">{it.icon}</span>
              <span className="min-w-0 grow truncate">{it.label}{it.note && <span className="ml-1.5 text-xs text-ink-3">{it.note}</span>}</span>
              {it.key && <span className="flex shrink-0 gap-1">{it.key.split("  ").map((k) => <Kbd key={k}>{k}</Kbd>)}</span>}
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
  const open = (e: { preventDefault(): void; clientX: number; clientY: number }, subject: T) => {
    e.preventDefault();
    setMenu({ at: { x: e.clientX, y: e.clientY }, subject });
  };
  return { menu, open, close: () => setMenu(null) };
}
