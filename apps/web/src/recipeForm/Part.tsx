import { createContext, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { InputSpec } from "@afflatus/core";
import { cx, Help } from "../ui";

/**
 * Which parts of a form are open. Kept for every form and every visit: a part folded once stays
 * folded, so the form shows what is being worked on and one line for the rest.
 */
export const useParts = create<{ open: Record<string, boolean>; set(id: string, open: boolean): void }>()(
  persist((set) => ({ open: {}, set: (id, open) => set((s) => ({ open: { ...s.open, [id]: open } })) }), { name: "afflatus.form.parts" }),
);

/**
 * The Create panel draws its prompt as a card like the other parts, with the Designer and Snippets in its
 * head (given to it with the helpers); a timeline clip's Inspector keeps the prompt bare.
 */
export const CardPrompt = createContext(false);

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
  /** What the part is for, behind a ? beside the fold. */
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
  return (
    <section data-part={id} className={cx("scroll-mt-12 rounded-xl border transition-colors", open ? "border-line-strong bg-panel" : "border-line bg-raised hover:border-line-strong")}>
      <div className={cx("flex items-center", Boolean(head) && "pr-3")}>
        <button type="button" aria-expanded={open} onClick={() => set(id, !open)} className="flex min-w-0 grow items-center gap-2.5 px-3 py-2.5 text-left">
          <span className="flex min-w-0 grow flex-col gap-0.5">
            <PartHead>{title}</PartHead>
            <span className="truncate font-semibold">{summary}</span>
            {warn && <span className="truncate text-xs text-warn-ink">{warn}</span>}
          </span>
          <ChevronDown size={15} className={cx("shrink-0 text-ink-2 transition-transform motion-reduce:transition-none", open && "rotate-180")} />
        </button>
        {help && <span className="pr-3"><Help text={help} /></span>}
        {head}
      </div>
      {open && <div className="flex flex-col gap-2 border-t border-line px-3 pt-2 pb-3">{children}</div>}
    </section>
  );
}

/** A second text of a form (the negative prompt, the sounds of a clip): a row that says what it holds, opening to the text itself under it. */
export function TextFold({ spec, value, children }: { spec: Extract<InputSpec, { type: "prompt" }>; value: string; children: ReactNode }) {
  const id = `text:${spec.id}`;
  const open = useParts((s) => s.open[id] ?? false);
  const set = useParts((s) => s.set);
  const said = value.trim().replace(/\s+/g, " ");
  return (
    <div data-part={id} className="flex flex-col">
      <button type="button" aria-expanded={open} onClick={() => set(id, !open)} className="grid h-9 w-full grid-cols-[104px_minmax(0,1fr)_14px] items-center gap-2 px-3 text-left">
        <span className="truncate text-xs font-semibold text-ink-2">{spec.label}</span>
        <span className={cx("truncate text-xs", said ? "text-ink" : "text-ink-3")}>{said || "empty"}</span>
        <ChevronDown size={14} className={cx("text-ink-3 transition-transform motion-reduce:transition-none", open && "rotate-180")} />
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
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
