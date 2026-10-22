import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useLeave } from "./leave";
import { popFrom } from "./motion";
import { cx } from "./ui";

/**
 * A panel that opens next to what was clicked: under it when there is room, above it otherwise. It is
 * drawn over everything, so the column it belongs to does not cut it off and does not grow for it. It
 * closes on Escape, on a click anywhere else, and when the page behind it scrolls. It pops out of the side it opens
 * from and, taken away, fades for a moment as a still copy (leave.ts): every user gets both without doing anything.
 */
export function Popover({ anchor, onClose, label, width = 360, height = 420, beside, className, children }: {
  /** What it opens next to. */
  anchor: RefObject<HTMLElement | null>;
  onClose(): void;
  label: string;
  width?: number;
  /** About how tall it gets, to choose between under and above. */
  height?: number;
  /**
   * Opened beside this box around the anchor (a selector, e.g. the Create panel) rather than under the anchor: what it
   * changes (the prompt) stays in sight. Under the anchor when there is no room beside it.
   */
  beside?: string;
  className?: string;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const panelRef = useLeave("m-pop-out", panel);
  const [place, setPlace] = useState<{ left: number; top?: number; bottom?: number; maxHeight: number; origin: string } | null>(null);
  useLayoutEffect(() => {
    const r = anchor.current?.getBoundingClientRect();
    if (!r) return;
    const box = beside ? anchor.current?.closest(beside)?.getBoundingClientRect() : undefined;
    if (box && box.right + 8 + width <= window.innerWidth - 8) {
      const top = Math.max(8, Math.min(r.top, window.innerHeight - height - 8));
      // beside the box, it grows out of its left edge at the anchor's height
      setPlace({ left: box.right + 8, top, maxHeight: window.innerHeight - top - 8, origin: `left ${Math.max(0, r.top + r.height / 2 - top)}px` });
      return;
    }
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    // it grows from under (or over) the anchor's middle, which is not its own left edge once it is pushed in from the
    // window's right side
    const x = `${Math.max(0, Math.min(width, r.left + r.width / 2 - left))}px`;
    setPlace(below >= Math.min(height, 260) || below >= above ? { left, top: r.bottom + 4, maxHeight: Math.max(160, below), origin: `${x} top` } : { left, bottom: window.innerHeight - r.top + 4, maxHeight: Math.max(160, above), origin: `${x} bottom` });
  }, [anchor, width, height, beside]);
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      const t = e.target as Node;
      // a dropdown opened from inside it is drawn elsewhere on the page: it is part of it all the same
      if (panel.current?.contains(t) || anchor.current?.contains(t) || (t as Element).closest?.("[data-floating]")) return;
      onClose();
    };
    const scrolled = (e: Event) => !panel.current?.contains(e.target as Node) && !(e.target as Element).closest?.("[data-floating]") && onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("scroll", scrolled, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("keydown", key);
    };
  }, [anchor, onClose]);
  if (!place) return null;
  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={label}
      data-floating
      style={{ left: place.left, top: place.top, bottom: place.bottom, width, maxHeight: Math.min(place.maxHeight, window.innerHeight - 16), transformOrigin: place.origin, ...popFrom(place.top === undefined) }}
      className={cx("m-pop fixed z-[66] flex flex-col overflow-hidden rounded-[14px] border border-line-strong bg-panel text-sm shadow-2xl shadow-shade/60", className)}
    >
      {children}
    </div>,
    document.body,
  );
}
