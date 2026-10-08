import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { Kbd } from "./Keys";
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

/** Something open over the dialog that keeps its own keys: a dropdown's list, a menu, a popover. */
const OVER = "[role=listbox], [role=menu], [data-floating]";

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
      // Escape closes what is open over the dialog first: its list closes, the dialog stays with what it holds
      if (e.key === "Escape" && !document.querySelector(OVER)) {
        e.preventDefault();
        e.stopPropagation();
        closeNow.current();
        return;
      }
      // Tab stays inside the dialog (a dropdown or a menu open over it keeps its own keys)
      if (e.key === "Tab" && !document.querySelector(OVER)) {
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
      className={cx("fixed inset-0 flex items-center justify-center bg-ground/85 p-8 motion-safe:animate-[peek-fade_100ms_ease-out]", z)}
      onPointerDown={(e) => { downOnBackdrop.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (e.target === e.currentTarget && downOnBackdrop.current) closeNow.current(); }}
    >
      <div ref={panel} tabIndex={-1} className={cx("outline-none", className ?? DIALOG)}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** The usual card of a dialog: a head (DialogHead), what it holds, a foot (DialogFoot). Wider ones change max-w only. */
export const DIALOG = "flex w-full max-w-md flex-col gap-3.5 rounded-[18px] border border-line-strong bg-panel p-5 shadow-2xl shadow-shade/60 motion-safe:animate-[peek-rise_120ms_ease-out]";

/**
 * The head of a dialog: an icon in its wash (warn for a question about something that cannot be undone), the
 * title, a dim line under it (what it is about), and the way out with its key.
 */
export function DialogHead({ icon, title, sub, tone = "accent", onClose }: { icon?: ReactNode; title: string; sub?: ReactNode; tone?: "accent" | "warn"; onClose?(): void }) {
  return (
    <div className="flex items-center gap-2.5">
      {icon && <span className={cx("flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[9px]", tone === "warn" ? "bg-warn-wash text-warn-ink" : "bg-accent-wash text-accent")}>{icon}</span>}
      <span className="flex min-w-0 grow flex-col gap-px">
        <h2 className="m-0 truncate text-base font-bold">{title}</h2>
        {sub && <span className="truncate text-xs text-ink-3">{sub}</span>}
      </span>
      {onClose && (
        <>
          <Kbd>Esc</Kbd>
          <button type="button" aria-label="Close" data-tip="Close" data-tip-keys="Esc" onClick={onClose} className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink">
            <X size={15} />
          </button>
        </>
      )}
    </div>
  );
}

/** The foot of a dialog: a dim line of facts on the left, its buttons on the right (the quiet one first, the one that goes ahead last). */
export function DialogFoot({ info, children }: { info?: ReactNode; children: ReactNode }) {
  return (
    <div className="-mx-5 -mb-5 mt-1 flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3.5">
      {info && <span className="mr-auto min-w-0 truncate text-xs text-ink-3">{info}</span>}
      {children}
    </div>
  );
}
