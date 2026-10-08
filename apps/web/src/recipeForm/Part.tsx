import type { ReactNode } from "react";
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
 * One part of a form. Folded, it is one line that says what it holds, so it need not be opened to be
 * checked; open, its fields are under that line. A part that needs something from the user (a picture
 * that is not chosen yet) is open whatever was remembered.
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
    <section data-part={id} className={cx("scroll-mt-12 rounded-[10px] border", open ? "border-line-strong" : "border-line bg-raised")}>
      <div className={cx("flex items-center", Boolean(head) && "pr-3")}>
        <button type="button" aria-expanded={open} onClick={() => set(id, !open)} className="flex min-w-0 grow items-center gap-2.5 px-3 py-2 text-left">
          <span className="flex min-w-0 grow flex-col gap-0.5">
            <span className="text-[11px] font-bold tracking-[0.08em] text-ink-2 uppercase">{title}</span>
            <span className={cx("truncate", open ? "text-xs text-ink-2" : "font-semibold")}>{summary}</span>
            {warn && <span className="truncate text-xs text-warn-ink">{warn}</span>}
          </span>
          <ChevronDown size={15} className={cx("shrink-0 text-ink-2 transition-transform", open && "rotate-180")} />
        </button>
        {help && <span className="pr-3"><Help text={help} /></span>}
        {head}
      </div>
      {open && <div className="flex flex-col gap-3.5 px-3 pt-1 pb-3">{children}</div>}
    </section>
  );
}

/** A second text of a form (the negative prompt, the sounds of a clip): a line that says what it holds, opening to the text itself. */
export function TextFold({ spec, value, children }: { spec: Extract<InputSpec, { type: "prompt" }>; value: string; children: ReactNode }) {
  const id = `text:${spec.id}`;
  const open = useParts((s) => s.open[id] ?? false);
  const set = useParts((s) => s.set);
  if (open) {
    return (
      <div className="flex flex-col gap-1">
        {children}
        <button type="button" onClick={() => set(id, false)} className="self-end rounded-md px-1 text-xs text-ink-2 hover:text-ink hover:underline">Collapse</button>
      </div>
    );
  }
  return (
    <button type="button" aria-expanded={false} onClick={() => set(id, true)} className="flex h-8 items-center gap-2 rounded-lg px-1 text-left text-xs text-ink-2 hover:text-ink">
      <span className="shrink-0 font-semibold">{spec.label}</span>
      <span className="min-w-0 grow truncate">{value.trim() || "empty"}</span>
      <ChevronDown size={14} className="shrink-0" />
    </button>
  );
}

/** A heading inside a part, with what the settings under it are about. */
export const Heading = ({ title, note }: { title: string; note: string }) => (
  <div className="flex items-baseline gap-2 border-b border-line pb-1">
    <span className="shrink-0 whitespace-nowrap text-[11px] font-bold tracking-[0.08em] text-ink-2 uppercase">{title}</span>
    <span className="truncate text-xs text-ink-3">{note}</span>
  </div>
);
