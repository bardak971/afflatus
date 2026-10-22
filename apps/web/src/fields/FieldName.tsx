import { createContext, useContext } from "react";
import { Pin } from "lucide-react";
import { cx } from "../ui";

/**
 * What a model form says after a setting's name about its pin (Pinned fields, RecipeForm): on the Pinned card, where the
 * setting lives ("· Sampling") or why it is not shown now ("· Hires fix is off"), in grey; in its own section, a small pin
 * when it is pinned. Given by the form around each of its settings; a row drawn outside a model form (a dialog's) has none.
 */
export const FieldNameNote = createContext<{ from?: string; pinned?: boolean } | null>(null);

/**
 * The attribute that marks a setting's name, what a right-click on it opens the form's menu from (Pin to the top, Unpin,
 * Reset). The name of a row is plain text, not something the keys reach: from the keyboard the menu key or Shift + F10 on the
 * setting's control opens the same menu.
 */
export const FIELD_NAME = { "data-field-name": "" } as const;

/** The note after a setting's name, when the form gives one. `spaced`: the name's row spaces its pieces itself (Label's). */
export function FieldNameExtra({ spaced }: { spaced?: boolean }) {
  const note = useContext(FieldNameNote);
  if (!note) return null;
  return (
    <>
      {note.from && <span className={cx("text-xs font-medium whitespace-nowrap text-ink-3", !spaced && "ml-1.5")}>· {note.from}</span>}
      {note.pinned && <Pin size={11} aria-label="Pinned" role="img" className={cx("inline-block shrink-0 align-middle text-accent", !spaced && "ml-1.5")} />}
    </>
  );
}
