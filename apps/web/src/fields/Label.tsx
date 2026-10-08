import { useExplain } from "../store";
import { Help } from "../ui";

/** The look of a text or number box of a form. */
export const field = "w-full rounded-lg border border-line bg-raised px-3 text-ink placeholder:text-ink-3";

/** A field's name, with its explanation (a line, or a ? on hover) and, apart from that, what must always be seen beside it ("0 of 6", "set by the start image"). */
export function Label({ htmlFor, children, note, aside }: { htmlFor?: string; children: string; note?: string; aside?: string }) {
  const explain = useExplain((s) => s.on);
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="flex min-w-0 items-center gap-1.5">
        {/* a field drawn as a group of buttons has no one control to point at: its name is a plain word, the group says it itself */}
        {htmlFor ? <label htmlFor={htmlFor} className="shrink-0 text-xs font-semibold">{children}</label> : <span className="shrink-0 text-xs font-semibold">{children}</span>}
        {note && !explain && <Help text={note} />}
      </span>
      {(aside || (note && explain)) && <span className="min-w-0 text-right text-xs text-ink-2">{aside ?? note}</span>}
    </div>
  );
}
