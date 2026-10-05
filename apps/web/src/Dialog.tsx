import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cx } from "./ui";

/**
 * The one modal shell of the app: over everything, closed by Escape, by its Close button or by a click
 * on the backdrop. It takes the focus when it opens (what it holds that is focusable first, or what
 * asked for it with autoFocus), keeps Tab inside, and gives the focus back to where it was when it
 * closes. Dialogs stack: Escape closes the innermost one only. While one is open, the screens' own keys
 * are off (they look for the [role=dialog]).
 */

/** The dialogs open now, the innermost last. */
const stack: symbol[] = [];

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({ label, onClose, children, className, z = "z-40" }: {
  label: string;
  onClose(): void;
  children: ReactNode;
  /** The panel's classes, in place of the usual card (a width, a padding, a shape). */
  className?: string;
  /** How high it sits: a dialog opened over another needs a higher z. */
  z?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const me = useRef(Symbol("dialog"));
  const closeNow = useRef(onClose);
  closeNow.current = onClose;
  // a press that started inside the panel and ends on the backdrop (a slider dragged out) is not a click on the backdrop
  const downOnBackdrop = useRef(false);

  useEffect(() => {
    const id = me.current;
    stack.push(id);
    const el = panel.current;
    const from = document.activeElement as HTMLElement | null;
    if (el && !el.contains(document.activeElement)) (el.querySelector<HTMLElement>(FOCUSABLE) ?? el).focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (stack.at(-1) !== id || !el) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeNow.current();
        return;
      }
      // Tab stays inside the dialog (a dropdown or a menu open over it keeps its own keys)
      if (e.key === "Tab" && !document.querySelector("[role=listbox], [role=menu]")) {
        const all = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null || x === document.activeElement);
        if (!all.length) {
          e.preventDefault();
          return;
        }
        const first = all[0]!;
        const last = all[all.length - 1]!;
        const at = document.activeElement as HTMLElement | null;
        if (e.shiftKey && (at === first || !el.contains(at))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (at === last || !el.contains(at))) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      stack.splice(stack.indexOf(id), 1);
      // the focus goes back where it was, when that is still on the page
      if (from && document.contains(from)) from.focus({ preventScroll: true });
    };
  }, []);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={label}
      className={cx("fixed inset-0 flex items-center justify-center bg-ground/85 p-8", z)}
      onPointerDown={(e) => { downOnBackdrop.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (e.target === e.currentTarget && downOnBackdrop.current) closeNow.current(); }}
    >
      <div ref={panel} tabIndex={-1} className={cx("outline-none", className ?? "flex w-full max-w-md flex-col gap-3.5 rounded-2xl border border-line-strong bg-panel p-5")}>
        {children}
      </div>
    </div>,
    document.body,
  );
}
