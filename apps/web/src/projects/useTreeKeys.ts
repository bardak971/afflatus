import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import { step, type Row } from "./tree";
import type { useItemMenu } from "./useItemMenu";
import type { useTreeActions } from "./useTreeActions";

/** Something open over the panel that keeps its own keys and clicks: a menu, a dialog. */
const OVER = "[role=menu], [role=dialog][aria-modal=true]";

type Renaming = { key: string; name: string } | null;

/**
 * The Projects panel's keys, on the window while it is open (so that they come before the page's): ↑ ↓ walk, ← → fold or go
 * up, Enter opens, Space picks, F2 renames, S keeps an item, Del deletes, the menu key opens the row's menu, typing searches,
 * Escape closes (or first ends what is under way). The keys are on the tree once it opens, and again back from the Viewer.
 */
export function useTreeKeys({ panel, list, search, anchor, opened, hidden, rows, byKey, hereKey, focused, setFocused, setKeyed, picked, clearPicks, pickedItems, renaming, setRenaming, clearAsk, setClearAsk, text, setText, toggle, click, startRename, remove, openRowMenu, itemMenu, actions, onClose }: {
  panel: RefObject<HTMLDivElement | null>;
  list: RefObject<HTMLDivElement | null>;
  search: RefObject<HTMLInputElement | null>;
  /** The button the panel was opened from: the keys go back to it when Escape closes the panel. */
  anchor: RefObject<HTMLElement | null>;
  /** The panel is placed (its list drawn). */
  opened: boolean;
  /** Kept but not shown, while the Viewer is over it. */
  hidden?: boolean;
  rows: Row[];
  byKey: Map<string, Row>;
  /** The row lit (the project worked in, or the library's place): the keys start there. */
  hereKey: string;
  focused: string | null;
  setFocused: Dispatch<SetStateAction<string | null>>;
  /** The focused row's ring shows once the keys moved it. */
  setKeyed(keyed: boolean): void;
  picked: Map<string, Row>;
  clearPicks(): void;
  pickedItems(): Row[];
  renaming: Renaming;
  setRenaming(v: Renaming): void;
  clearAsk: string | null;
  setClearAsk(key: string | null): void;
  /** What is typed in the search box. */
  text: string;
  setText: Dispatch<SetStateAction<string>>;
  toggle(r: Row): void;
  click(r: Row, e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): void;
  startRename(r: Row): void;
  remove(rs: Row[]): void;
  openRowMenu(r: Row, e: { preventDefault(): void; clientX: number; clientY: number; currentTarget?: EventTarget | null }): void;
  itemMenu: ReturnType<typeof useItemMenu>;
  actions: ReturnType<typeof useTreeActions>;
  onClose(): void;
}) {
  // the keys: ↑ ↓ walk, ← → fold or go up, Enter opens, F2 renames, Del deletes, typing searches, Escape closes
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e) => {
    if (document.querySelector(OVER)) return;
    const el = panel.current;
    if (!el) return;
    const stop = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    const active = document.activeElement;
    if (e.key === "Escape") {
      stop();
      if (renaming) setRenaming(null);
      else if (clearAsk) setClearAsk(null);
      else if (active === search.current && text) setText("");
      else if (picked.size) clearPicks();
      else {
        onClose();
        anchor.current?.focus({ preventScroll: true });
      }
      return;
    }
    if (!el.contains(active) || renaming) return;
    // a Clear asked in place: its two buttons take Enter, not the tree
    if (clearAsk && active instanceof HTMLButtonElement && active.closest("[data-asking]")) return;
    if (active === search.current) {
      // typed into the box, not a jump to the next search box of the page
      if (e.key === "/") e.stopPropagation();
      if (e.key === "ArrowDown" || e.key === "Enter") {
        stop();
        list.current?.focus({ preventScroll: true });
        setKeyed(true);
        setFocused((f) => f ?? rows.find((r) => r.match)?.key ?? rows[0]?.key ?? null);
      }
      return;
    }
    if (e.altKey) return;
    const r = focused ? byKey.get(focused) : undefined;
    if (e.ctrlKey || e.metaKey) {
      if (e.key.toLowerCase() === "f") {
        stop();
        search.current?.focus();
      }
      return;
    }
    if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) setKeyed(true);
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp":
        stop();
        setFocused(step(rows, focused, e.key === "ArrowDown" ? 1 : -1));
        return;
      case "ArrowRight":
        stop();
        if (r?.foldable && !r.open) toggle(r);
        else if (r?.open) setFocused(step(rows, r.key, 1));
        return;
      case "ArrowLeft":
        stop();
        if (r?.open) toggle(r);
        else if (r?.parent) setFocused(r.parent);
        return;
      case "Home":
      case "End":
        stop();
        setFocused((e.key === "Home" ? rows[0] : rows.at(-1))?.key ?? null);
        return;
      case "Enter":
        stop();
        if (r) click(r, { ctrlKey: false, metaKey: false, shiftKey: e.shiftKey });
        return;
      case " ":
        stop();
        if (r) click(r, { ctrlKey: true, metaKey: false, shiftKey: false });
        return;
      case "F2":
        stop();
        if (r?.kind === "item" && r.asset) void itemMenu.renameIt(r.asset);
        else if (r) startRename(r);
        return;
      case "s":
      case "S":
        // an item kept or let go, as in the library
        if (r?.kind !== "item" || !r.asset || e.shiftKey) break;
        stop();
        itemMenu.keep(picked.has(r.key) && pickedItems().length > 1 ? pickedItems().map((x) => x.id!) : [r.asset.id], !r.asset.kept);
        return;
      case "Delete":
      case "Backspace":
        stop();
        // items go to the bin as in the library (asked only for files of the disk); the rest asks first
        if (picked.size && [...picked.values()].every((x) => x.kind === "item")) void actions.bin([...picked.values()]).then(clearPicks);
        else if (!picked.size && r?.kind === "item") void actions.bin([r]);
        else if (picked.size) remove([...picked.values()]);
        else if (r?.kind === "project") void actions.removeProject(r);
        else if (r) remove([r]);
        return;
      case "ContextMenu":
      case "F10":
        if (e.key === "F10" && !e.shiftKey) return;
        stop();
        if (r) {
          const rowEl = list.current?.querySelector(`[data-key="${CSS.escape(r.key)}"]`) ?? null;
          openRowMenu(r, { preventDefault() {}, clientX: 0, clientY: 0, currentTarget: rowEl });
        }
        return;
      default:
        // "?" is the keyboard shortcuts everywhere, the tree included: this listener runs first and stops the key, so it asks for them itself
        if (e.key === "?") {
          stop();
          window.dispatchEvent(new Event("afflatus:keys"));
          return;
        }
        // a letter typed on the tree starts a search with it ("/" only goes to the box)
        if (e.key.length === 1) {
          stop();
          if (e.key !== "/" && e.key !== " ") setText((t) => t + e.key);
          search.current?.focus();
        }
    }
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  }, []);
  // opened: the keys are on the tree, on the row worked in
  useEffect(() => {
    list.current?.focus({ preventScroll: true });
  }, [opened]); // eslint-disable-line react-hooks/exhaustive-deps
  // back from the Viewer: the keys are on the tree again
  useEffect(() => {
    if (!hidden) list.current?.focus({ preventScroll: true });
  }, [hidden]);
  useEffect(() => {
    if (!focused && rows.length && hereKey) setFocused(hereKey);
  }, [rows.length]); // eslint-disable-line react-hooks/exhaustive-deps
}
