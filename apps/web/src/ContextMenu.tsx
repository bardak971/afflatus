import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Kbd } from "./Keys";
import { cx } from "./ui";

/** One line of a menu, or a rule between groups. Every item mirrors a button that exists elsewhere: a menu is never the only way. */
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
      run(): void;
    }
  | "—";

export interface MenuAt {
  x: number;
  y: number;
}

/**
 * A right-click menu, at the pointer: it stays inside the window, closes on a click elsewhere, Escape,
 * a scroll or a resize; the arrow keys walk it, Enter runs. While it is open the screen's own keys are
 * off (Keys.plainKey sees the [role=menu]).
 */
export function ContextMenu({ at, items, label, onClose }: { at: MenuAt; items: MenuItem[]; label: string; onClose(): void }) {
  const self = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<MenuAt>(at);
  const [active, setActive] = useState(-1);
  const runnable = items.map((it, i) => (it !== "—" && !it.disabled ? i : -1)).filter((i) => i >= 0);

  // placed inside the window once its size is known
  useEffect(() => {
    const el = self.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.max(4, Math.min(at.x, window.innerWidth - r.width - 4)),
      y: Math.max(4, Math.min(at.y, window.innerHeight - r.height - 4)),
    });
  }, [at, items.length]);

  useEffect(() => {
    const down = (e: PointerEvent) => { if (!self.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); return; }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        if (!runnable.length) return;
        const k = runnable.indexOf(active);
        const next = e.key === "ArrowDown" ? runnable[(k + 1) % runnable.length]! : runnable[(k - 1 + runnable.length) % runnable.length]!;
        setActive(next);
      }
      if (e.key === "Enter" && active >= 0) {
        e.preventDefault();
        e.stopPropagation();
        const it = items[active];
        if (it && it !== "—" && !it.disabled) { onClose(); it.run(); }
      }
    };
    const away = () => onClose();
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("scroll", away, true);
    window.addEventListener("resize", away);
    window.addEventListener("blur", away);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", away, true);
      window.removeEventListener("resize", away);
      window.removeEventListener("blur", away);
    };
  }, [onClose, items, active, runnable]);

  return createPortal(
    <div
      ref={self}
      role="menu"
      aria-label={label}
      className="fixed z-[90] flex min-w-[220px] max-w-[320px] flex-col rounded-xl border border-line-strong bg-panel py-1 shadow-2xl shadow-shade/60"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) =>
        it === "—" ? (
          <div key={`rule-${i}`} className="my-1 border-t border-line" />
        ) : (
          <button
            key={it.label}
            type="button"
            role="menuitem"
            disabled={it.disabled}
            onMouseEnter={() => setActive(i)}
            onClick={() => { onClose(); it.run(); }}
            className={cx(
              "flex items-center gap-2.5 px-3 py-1.5 text-left text-sm disabled:opacity-40",
              i === active && !it.disabled && "bg-hover",
              it.danger ? "text-warn-ink" : "text-ink",
            )}
          >
            <span className="flex w-4 shrink-0 items-center justify-center text-ink-2">{it.icon}</span>
            <span className="min-w-0 grow truncate">{it.label}{it.note && <span className="ml-1.5 text-xs text-ink-3">{it.note}</span>}</span>
            {it.key && <span className="flex shrink-0 gap-1">{it.key.split("  ").map((k) => <Kbd key={k}>{k}</Kbd>)}</span>}
          </button>
        ),
      )}
    </div>,
    document.body,
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
