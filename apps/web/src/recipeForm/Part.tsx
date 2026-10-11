import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { InputSpec } from "@afflatus/core";
import { withNote } from "../fieldNotes";
import { cx, Help } from "../ui";
import { motionAllowed, motionEase, motionMs } from "../useFlip";

/**
 * Which parts of a form are open. Kept for every form and every visit: a part folded once stays
 * folded, so the form shows what is being worked on and one line for the rest. `now` is the part
 * last opened by the strip, which opens at once: the strip scrolls to it, and a part still growing
 * at the foot of the form would leave the scroll short of it. Not kept.
 */
export const useParts = create<{ open: Record<string, boolean>; now: string | null; set(id: string, open: boolean, now?: boolean): void }>()(
  persist(
    (set) => ({ open: {}, now: null, set: (id, open, now) => set((s) => ({ open: { ...s.open, [id]: open }, now: now ? id : null })) }),
    { name: "afflatus.form.parts", partialize: (s) => ({ open: s.open }) },
  ),
);

// the aim is a file of its own: the actions that set it are loaded with the app, the form that takes it is not
export { useFormAim } from "./formAim";

/**
 * The Create panel draws its prompt as a card like the other parts, with the Designer and Snippets in its
 * head (given to it with the helpers); a timeline clip's Inspector keeps the prompt bare.
 */
export const CardPrompt = createContext(false);

/**
 * Whether the form is being searched. The search opens and folds many parts at once, as each keystroke changes what
 * matches: they then change at once, without the fold's motion (a dozen bodies growing together reads as the page
 * lurching, and the matches are what is looked for).
 */
export const FormSearching = createContext(false);

/** How long a part takes to fold: quicker than it opens, as what closes is no longer looked at. */
const FOLD_MS = 90;

/**
 * The chevron of a fold: it turns with the body, at the body's pace (open in --t-panel, folded in FOLD_MS), and at
 * once while the form is searched or under "reduce motion".
 */
const chevronMotion = (open: boolean, searching: boolean) =>
  searching ? "transition-none" : cx("transition-transform motion-reduce:transition-none", open ? "duration-(--t-panel) ease-(--ease-snap)" : "duration-[90ms] ease-in");

/**
 * What a fold holds, under its head. Opened, its height grows from nothing to the content's in --t-panel as the
 * content fades in; folded, it shrinks away in FOLD_MS and only then leaves the page (its settings are not kept
 * drawn while folded, as before). The height goes by the grid's rows, 0fr to 1fr, so nothing is measured; the
 * content is clipped only while it moves, so that a focus ring at its edge is not cut the rest of the time. A head
 * clicked again mid-move turns it back at once; a folding body takes no clicks. A part opened or folded by the
 * search or the strip, or under "reduce motion", changes at once.
 */
function FoldBody({ open, now, className, children }: { open: boolean; /** Opened by the strip: at once. */ now?: boolean; className: string; children: ReactNode }) {
  const searching = useContext(FormSearching);
  // what it was at the last drawing: the move is decided when `open` changes, during the drawing itself, so that a
  // folding body is still there to fold in the very drawing that closes it
  const [was, setWas] = useState({ open, searching });
  const [play, setPlay] = useState<{ kind: "open" | "fold" } | null>(null);
  if (was.open !== open || was.searching !== searching) {
    setWas({ open, searching });
    // the drawing that ends a search folds its parts at once too, not only those drawn while it was typed
    if (was.open !== open) setPlay(!searching && !was.searching && !(open && now) && motionAllowed() ? { kind: open ? "open" : "fold" } : null);
  }
  const body = useRef<HTMLDivElement>(null);
  const clip = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = body.current;
    if (!play) return;
    if (!el || typeof el.animate !== "function") {
      setPlay(null);
      return;
    }
    const opening = play.kind === "open";
    // the cleanup puts back the element changed here, whatever the ref holds by then
    const box = clip.current;
    if (box) box.style.overflow = "hidden";
    const run = opening
      ? el.animate([{ gridTemplateRows: "0fr", opacity: 0 }, { gridTemplateRows: "1fr", opacity: 1 }], { duration: motionMs("--t-panel", 140), easing: motionEase() })
      // the content is gone a little before the height: what is left of it is not seen squeezed
      : el.animate([{ gridTemplateRows: "1fr", opacity: 1 }, { opacity: 0, offset: 0.78 }, { gridTemplateRows: "0fr", opacity: 0 }], { duration: FOLD_MS, easing: "ease-in", fill: "forwards" });
    run.onfinish = () => setPlay(null);
    return () => {
      run.onfinish = null;
      run.cancel();
      if (box) box.style.overflow = "";
    };
  }, [play]);
  if (!open && play?.kind !== "fold") return null;
  return (
    // one column no wider than the card: a wide child (a table, a row of chips) is cut or wraps inside it, never
    // widening the card and the whole column with it
    <div ref={body} className="grid grid-cols-[minmax(0,1fr)] grid-rows-[1fr]" inert={!open}>
      <div ref={clip} className="min-h-0">
        <div className={className}>{children}</div>
      </div>
    </div>
  );
}

/** The name of a part: small, bold, upper case, quiet. */
export const PartHead = ({ children }: { children: ReactNode }) => (
  <span className="truncate text-[11px] font-bold tracking-[0.08em] text-ink-3 uppercase">{children}</span>
);

/**
 * One part of a form, as a card. Folded, it is its name over one bold line that says what it holds, so it
 * need not be opened to be checked; open, one line under its head and its settings under that. A part that
 * needs something from the user (a picture that is not chosen yet) is open whatever was remembered.
 */
export function Part({ id, title, help, summary, warn, needs, head, children, startOpen }: {
  id: string;
  title: string;
  /** What the part is for, behind a ? right after its name. */
  help?: string;
  /** What it holds, in a few words. */
  summary: ReactNode;
  /** A word about something in it that is heavy or wrong, shown while it is folded too. */
  warn?: string;
  needs?: boolean;
  /** Open until the person folds it (the Takes of a timeline clip): what is looked at first. */
  startOpen?: boolean;
  /** A control in the header, beside the fold (a chapter's own switch). */
  head?: ReactNode;
  children: ReactNode;
}) {
  const kept = useParts((s) => s.open[id] ?? Boolean(startOpen));
  const set = useParts((s) => s.set);
  const open = kept || Boolean(needs);
  const searching = useContext(FormSearching);
  const now = useParts((s) => s.now === id);
  return (
    <section data-part={id} className={cx("scroll-mt-12 rounded-xl border shadow-card transition-colors", open ? "border-line-strong bg-panel" : "border-line bg-raised hover:border-line-strong")}>
      {/* the whole head folds and unfolds it; its name is the button (the keys reach it), and its ? sits right after the
          name, as every ? of a form does: in the button it could not be (a button in a button), and beside the fold it
          read as the chevron's. A click on the ? or on the head's own control (a chapter's switch) stays theirs */}
      <div onClick={() => set(id, !open)} className={cx("flex cursor-pointer items-center gap-2.5 px-3 py-2.5", Boolean(head) && "pr-3")}>
        <span className="flex min-w-0 grow flex-col gap-0.5 text-left">
          <span className="flex min-w-0 items-center gap-1.5">
            <button type="button" aria-expanded={open} aria-label={`${title}: ${open ? "fold" : "unfold"}`} className="min-w-0 text-left"><PartHead>{title}</PartHead></button>
            {help && <span onClick={(e) => e.stopPropagation()}><Help text={help} title={title} /></span>}
          </span>
          <span className="truncate font-semibold">{summary}</span>
          {warn && <span className="truncate text-xs text-warn-ink">{warn}</span>}
        </span>
        <ChevronDown size={15} className={cx("shrink-0 text-ink-2", chevronMotion(open, searching), open && "rotate-180")} />
        {head && <span onClick={(e) => e.stopPropagation()}>{head}</span>}
      </div>
      <FoldBody open={open} now={now} className="flex flex-col gap-2 border-t border-line px-3 pt-2 pb-3">{children}</FoldBody>
    </section>
  );
}

/** A second text of a form (the negative prompt, the sounds of a clip): a row that says what it holds, opening to the text itself under it. */
export function TextFold({ spec, value, children }: { spec: Extract<InputSpec, { type: "prompt" }>; value: string; children: ReactNode }) {
  const id = `text:${spec.id}`;
  const open = useParts((s) => s.open[id] ?? false);
  const set = useParts((s) => s.set);
  const searching = useContext(FormSearching);
  const said = value.trim().replace(/\s+/g, " ");
  const note = withNote(spec).note;
  // the row is its name: the text box under it, open, has no label of its own (only for screen readers). The name and
  // its ? first, as every row of a form has them (FieldRow), then what it holds: the ? cannot sit in the row's button
  // (a button in a button), and after the chevron it read as the value's
  const toggle = () => set(id, !open);
  return (
    <div data-part={id} className="flex flex-col">
      <div className="grid h-9 grid-cols-[124px_minmax(0,1fr)] items-center gap-2 px-3">
        <span className="flex min-w-0 items-center gap-1.5">
          <button type="button" aria-expanded={open} onClick={toggle} className="truncate text-left text-xs font-semibold text-ink-2 hover:text-ink">{spec.label}</button>
          {note && <Help text={note} title={spec.label} />}
        </span>
        <button type="button" aria-expanded={open} aria-label={`${spec.label}: ${open ? "fold" : said || "empty"}`} onClick={toggle} className="flex h-full min-w-0 items-center gap-2 text-left">
          {/* folded, what it holds; open, the box says it */}
          <span className={cx("min-w-0 grow truncate text-xs", said ? "text-ink" : "text-ink-3")}>{open ? "" : said || "empty"}</span>
          <ChevronDown size={14} className={cx("shrink-0 text-ink-3", chevronMotion(open, searching), open && "rotate-180")} />
        </button>
      </div>
      <FoldBody open={open} className="px-3 pb-3">{children}</FoldBody>
    </div>
  );
}

/** A heading inside a part, with what the settings under it are about. */
export const Heading = ({ title, note }: { title: string; note: string }) => (
  <div className="flex items-baseline gap-2 border-b border-line pb-1">
    <span className="shrink-0 whitespace-nowrap text-[11px] font-bold tracking-[0.08em] text-ink-2 uppercase">{title}</span>
    <span className="truncate text-xs text-ink-3">{note}</span>
  </div>
);
