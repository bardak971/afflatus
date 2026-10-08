import { useEffect, type ReactNode } from "react";

/** A key, as it is drawn next to what it does. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-current px-1 font-sans text-[10px] leading-4 font-semibold opacity-60">{children}</kbd>;
}

/** The key was pressed in a box being typed in. */
export const typing = (e: KeyboardEvent) => {
  const el = e.target as Partial<HTMLElement> | null;
  return typeof el?.closest === "function" && Boolean(el.closest("input, textarea, select, [contenteditable]"));
};

/**
 * A key press meant for the app, not for a box being typed in, a list that is open, or a dialog on top
 * of what the keys belong to. Keys held with Ctrl, Alt or the command key are the browser's.
 */
export function plainKey(e: KeyboardEvent, opts: { over?: string } = {}): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  if (typing(e)) return false;
  // an open dropdown, or a dialog over the one the keys are for
  if (document.querySelector("[role=listbox], [role=menu]")) return false;
  if (opts.over && document.querySelector(opts.over)) return false;
  return true;
}

/**
 * "/" (or ":") from anywhere: the search bar nearest the mouse; pressed inside a search bar, the next one.
 * Mounted once, by the app.
 */
export function useSearchKey(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const shown = (el: Element) => el.getClientRects().length > 0;
      // "/" pressed inside a search box goes on to the next search box on screen (the shelf's, the form's, the view's), round and round
      const active = document.activeElement;
      if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey && active instanceof HTMLInputElement && active.matches("input[data-search]")) {
        const all = [...document.querySelectorAll<HTMLElement>("input[data-search], button[data-search-opener]")].filter(shown);
        const next = all[(all.indexOf(active) + 1) % all.length];
        if (next && next !== active) {
          e.preventDefault();
          if (next instanceof HTMLInputElement) {
            next.focus();
            next.select();
          } else next.click();
        }
        return;
      }
      // "/" goes to the search bar nearest the mouse: the panel under it that has one (a form's own, behind its
      // magnifier; the shelf's; the view's bar); with nothing under the mouse, a form on screen wins, else the view's bar.
      // On AZERTY "/" shares its key with ":": that key works with or without Shift.
      if ((e.key === "/" || e.key === ":") && plainKey(e)) {
        const form = [...document.querySelectorAll<HTMLElement>("input[data-search=form], button[data-search-opener]")].filter(shown)[0];
        const bars = [...document.querySelectorAll<HTMLInputElement>("input[data-search]:not([data-search=form])")].filter(shown);
        const hovered = [...document.querySelectorAll<HTMLElement>(":hover")].at(-1);
        let near: HTMLElement | undefined;
        for (let el: HTMLElement | null = hovered ?? null; el && !near; el = el.parentElement) {
          const inside = [...el.querySelectorAll<HTMLElement>("input[data-search], button[data-search-opener]")].filter(shown);
          if (inside.length) near = inside.find((x) => x.matches("input[data-search=form], button[data-search-opener]")) ?? inside[0];
        }
        const target = near ?? form ?? bars[bars.length - 1];
        if (target) {
          e.preventDefault();
          if (target instanceof HTMLInputElement) {
            target.focus();
            target.select();
          } else {
            target.click();
          }
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
