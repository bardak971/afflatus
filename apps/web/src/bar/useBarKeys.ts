import { useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { Item } from "./items";
import { useBar } from "./store";
import type { Action } from "./useActions";

/** The selected result's actions on show (Tab), filtered by what is typed in their place. */
export type Acting = { item: Item; text: string; sel: number };

/**
 * The bar's keys, on its input: the arrows and Page Up/Down walk the list (round), Escape steps back (the actions, then
 * what is typed, then the bar), Tab shows the selected result's actions or completes a command, Enter runs (Ctrl: the
 * second action), and Shift pressed and let go alone shows or hides the preview.
 */
export function useBarKeys({ acting, setActing, shownActions, count, at, setSel, typed, setTyped, current, actionsOf, choose, run, setDwell, close }: {
  acting: Acting | null;
  setActing(a: Acting | null): void;
  shownActions: Action[];
  /** How many results are listed. */
  count: number;
  at: number;
  setSel(i: number): void;
  typed: string;
  setTyped(typed: string): void;
  current: Item | null;
  actionsOf(it: Item): Action[];
  choose(it: Item | null, second?: boolean): void;
  run(it: Item, a: Action | undefined): void;
  /** The row whose preview is drawn: at once for the one whose actions are shown. */
  setDwell(it: Item | null): void;
  close(): void;
}) {
  // Shift pressed and let go alone shows or hides the preview (Shift + a letter is a capital, Shift + Tab goes back)
  const shiftAlone = useRef(false);
  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    const k = e.key;
    shiftAlone.current = k === "Shift" && !e.repeat;
    const n = acting ? shownActions.length : count;
    const move = (by: number) => {
      e.preventDefault();
      if (!n) return;
      if (acting) setActing({ ...acting, sel: (acting.sel + by + n) % n });
      else setSel((at + by + n) % n);
    };
    if (k === "ArrowDown") return move(1);
    if (k === "ArrowUp") return move(-1);
    if (k === "PageDown") return move(Math.min(8, n - 1 - (acting ? acting.sel : at)) || 0);
    if (k === "PageUp") return move(-Math.min(8, acting ? acting.sel : at));
    if (k === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (acting) return setActing(null);
      if (typed) {
        setTyped("");
        setSel(0);
        return;
      }
      return close();
    }
    if (k === "Tab") {
      e.preventDefault();
      if (acting) return setActing(null);
      if (current?.complete) return choose(current);
      if (current && actionsOf(current).length) {
        setDwell(current);
        setActing({ item: current, text: "", sel: 0 });
      }
      return;
    }
    if (k === "Enter") {
      e.preventDefault();
      if (e.nativeEvent.isComposing) return;
      if (acting) {
        const a = shownActions[acting.sel];
        if (a) {
          run(acting.item, a);
          if (a.stay) setActing(null);
        }
        return;
      }
      return choose(current, e.ctrlKey || e.metaKey);
    }
  };
  const onKeyUp = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Shift" && shiftAlone.current) useBar.getState().setPreview(!useBar.getState().preview);
    shiftAlone.current = false;
  };
  return { onKeyDown, onKeyUp };
}
