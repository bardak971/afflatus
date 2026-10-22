import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight } from "lucide-react";
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
      /** A setting turned on or off: its tick stands where the icon would. Left out, the item is a plain action. */
      checked?: boolean;
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
 * Where a menu opens: at the pointer, or, opened from the keyboard, under the top of the element it was opened on.
 * The keyboard's opening is told by its event: no button pressed (Chrome's menu key and Shift + F10, which put the
 * pointer over the element, not at 0, 0), or the pointer at 0, 0 (where other browsers leave it).
 */
export function menuAt(e: { clientX: number; clientY: number; button?: number }, el: { getBoundingClientRect(): { left: number; top: number; width: number; height: number } } | null): MenuAt {
  const keyed = e.button === -1 || (e.clientX === 0 && e.clientY === 0);
  if (!keyed || !el) return { x: e.clientX, y: e.clientY };
  const r = el.getBoundingClientRect();
  return { x: r.left + Math.min(16, r.width / 2), y: r.top + Math.min(r.height, 28), keyed: true };
}

/** What a key does in a menu panel, worked out apart from the page so that it can be tested. */
export type MenuStep = { do: "close" } | { do: "back" } | { do: "move"; to: number } | { do: "sub" } | { do: "choose" } | null;

/**
 * The keys of a menu panel, as the command bar's list has them: the arrows walk the items that can run (round), Home and
 * End go to the first and the last, Enter and Space run the active one (Space toggles a ticked item, as a check box
 * does), → opens its submenu, ← and Escape close a submenu, Escape and Tab close the menu.
 */
export function menuStep(key: string, runnable: number[], active: number, inSub: boolean): MenuStep {
  if (key === "Escape") return { do: inSub ? "back" : "close" };
  if (key === "ArrowLeft" && inSub) return { do: "back" };
  if (key === "Tab") return { do: "close" };
  if (key === "ArrowDown" || key === "ArrowUp" || key === "Home" || key === "End") {
    if (!runnable.length) return { do: "move", to: active };
    const k = runnable.indexOf(active);
    const n = runnable.length;
    const to = key === "Home" ? 0 : key === "End" ? n - 1 : key === "ArrowDown" ? (k + 1) % n : (k - 1 + n) % n;
    return { do: "move", to: runnable[to]! };
  }
  if (active < 0) return null;
  if (key === "ArrowRight") return { do: "sub" };
  if (key === "Enter" || key === " ") return { do: "choose" };
  return null;
}

/**
 * Whether the menu takes the keys pressed with the focus on `focused`. Not while the focus is in a modal that is not the
 * menu (the command bar opened over it, a dialog): the arrows and Enter are that modal's then, never a hidden menu's.
 */
export function menuHearsKeys(focused: Element | null): boolean {
  if (!focused?.closest) return true;
  return Boolean(focused.closest("[data-context-menu]")) || !focused.closest('[role="dialog"][aria-modal="true"]');
}

/**
 * The element the open menu was opened from (what had the focus then). A modal that opens over the menu and asks
 * where the focus was (the command bar) is told this one: the menu is gone by the time the modal closes.
 */
let opener: HTMLElement | null = null;
export function focusBehindMenu(el: Element | null): HTMLElement | null {
  if (el?.closest?.("[data-context-menu]")) return opener?.isConnected ? opener : null;
  return el instanceof HTMLElement ? el : null;
}

/**
 * A right-click menu, at the pointer: it stays inside the window, closes on a click elsewhere, Escape,
 * a scroll, a resize or the focus going elsewhere (the command bar, a dialog); the arrow keys walk it, Enter
 * or Space runs, → opens a submenu and ← closes it. It takes the focus while it is open, so that a screen
 * reader follows the active item, and gives it back to where it was. While it is open the screen's own keys
 * are off (Keys.plainKey sees the [role=menu]).
 */
export function ContextMenu({ at, items, label, head, onClose }: { at: MenuAt; items: MenuItem[]; label: string; head?: MenuHead; onClose(): void }) {
  // read at the first drawing, before the menu takes the focus
  const [from] = useState(() => (document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null));
  useEffect(() => {
    opener = from;
    return () => {
      if (opener === from) opener = null;
      // the focus goes back where it was, unless something else took it meanwhile (a dialog an item opened)
      const now = document.activeElement;
      if (from?.isConnected && (!now || now === document.body || now.closest("[data-context-menu]"))) from.focus({ preventScroll: true });
    };
  }, [from]);
  useEffect(() => {
    const outside = (e: Event) => !(e.target as Element | null)?.closest?.("[data-context-menu]");
    const down = (e: PointerEvent) => { if (outside(e)) onClose(); };
    const away = () => onClose();
    const scrolled = (e: Event) => { if (outside(e)) onClose(); };
    // the command bar or a dialog opened over the menu takes the focus: the menu goes, and its keys with it
    const moved = (e: FocusEvent) => { if (outside(e)) onClose(); };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("scroll", scrolled, true);
    window.addEventListener("focusin", moved, true);
    window.addEventListener("resize", away);
    window.addEventListener("blur", away);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("focusin", moved, true);
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
  const ids = useId();
  const rowId = (i: number) => `${ids}-${i}`;
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

  // the innermost panel has the focus (a submenu once open, its parent again once it closes): its active item is
  // announced through aria-activedescendant
  useEffect(() => {
    if (!sub) self.current?.focus({ preventScroll: true });
  }, [sub]);

  // only the innermost panel takes the keys: a parent with a submenu open leaves them to it
  useEffect(() => {
    if (sub) return;
    const key = (e: KeyboardEvent) => {
      if (!menuHearsKeys(document.activeElement)) return;
      const step = menuStep(e.key, runnable, active, Boolean(onBack));
      if (!step) return;
      e.preventDefault();
      e.stopPropagation();
      if (step.do === "close") onClose();
      else if (step.do === "back") onBack?.();
      else if (step.do === "move") setActive(step.to);
      else if (step.do === "sub") openSub(active, true);
      else choose(active);
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
        tabIndex={-1}
        aria-activedescendant={active >= 0 && !sub ? rowId(active) : undefined}
        data-context-menu
        // a menu opened from inside a popover (the folder panel) is part of it: pressing an item does not close the popover first
        data-floating=""
        className="fixed z-[90] flex outline-none max-h-[calc(100vh-8px)] min-w-[230px] max-w-[340px] flex-col overflow-y-auto overscroll-contain rounded-[14px] border border-line-strong bg-panel p-1.5 shadow-2xl shadow-shade/60 motion-safe:animate-tip-in"
        // it grows out of where it was asked for (the click, or the row a submenu opens from), which is not its corner once
        // it was pushed back inside the window or flipped to the left
        style={{ left: pos.x, top: pos.y, transformOrigin: `${Math.max(0, at.x - pos.x)}px ${Math.max(0, at.y - pos.y)}px` }}
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
              id={rowId(i)}
              ref={(el) => { rows.current[i] = el; }}
              type="button"
              tabIndex={-1}
              role={it.checked !== undefined ? "menuitemcheckbox" : "menuitem"}
              aria-checked={it.checked}
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
              <span className={cx("flex w-4 shrink-0 items-center justify-center", it.danger ? "text-warn-ink" : it.checked ? "text-accent" : "text-ink-2")}>{it.checked !== undefined ? it.checked && <Check size={14} /> : it.icon}</span>
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
  const open = (e: { preventDefault(): void; clientX: number; clientY: number; button?: number; currentTarget?: EventTarget | null }, subject: T) => {
    e.preventDefault();
    setMenu({ at: menuAt(e, e.currentTarget instanceof Element ? e.currentTarget : null), subject });
  };
  return { menu, open, close: () => setMenu(null) };
}
