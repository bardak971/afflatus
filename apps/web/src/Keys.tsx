import { Fragment, useEffect, type ReactNode } from "react";
import { capText, onMac, parseKeys, type KeyHit } from "./keys/grammar";

/** Drawn for a Mac (Ctrl as ⌘, Alt as ⌥) or for the rest. */
export const MAC = onMac();

const CAP = {
  // the sheet, the tips: a keycap on a panel
  md: "h-5 min-w-5 rounded-key border-line-strong bg-ground px-[5px] text-meta text-ink shadow-[inset_0_-1px_0_var(--color-line)]",
  // menus and buttons: the colour of what it sits in, so it reads on a primary button as on a menu
  sm: "h-4 min-w-4 rounded-key border-current/30 bg-current/[0.06] px-1 text-micro text-current",
};

/**
 * Keys as keycaps, written with the one grammar of `keys/grammar.ts`: "Ctrl+Shift+Z | Ctrl+Y" draws two chords with
 * an "or" between them, "← →" a pair side by side, "Ctrl+click" a mouse move as text, "{a|b|c}" code. `hits`: the
 * caps to light (a search's match), each by its way and chord.
 */
export function Keys({ keys, size = "md", hits, className }: { keys: string; size?: "md" | "sm"; hits?: readonly KeyHit[]; className?: string }) {
  const parsed = parseKeys(keys);
  const box = `inline-flex shrink-0 items-center ${className ?? ""}`;
  if (!parsed) return <span className={`${box} font-mono text-meta text-ink-2`}>{keys}</span>;
  if ("code" in parsed) return <code className={`${box} font-mono text-meta text-accent`}>{parsed.code}</code>;
  const lit = (way: number, chord: number, k: string) => Boolean(hits?.some((h) => h.way === way && h.chord === chord && h.key === k));
  return (
    <span className={box}>
      {parsed.ways.map((way, i) => (
        <Fragment key={i}>
          {i > 0 && <span className={size === "md" ? "mx-[5px] text-meta text-ink-3" : "mx-1 text-micro opacity-60"}>or</span>}
          {way.mouse ? (
            // a mouse move is words, not caps: "Ctrl + click"
            <span className={size === "md" ? "text-xs whitespace-nowrap text-ink-2" : "text-meta whitespace-nowrap opacity-75"}>{way.pair[0]!.map((k) => capText(k, MAC)).join(" + ")}</span>
          ) : (
            <span className={size === "md" ? "inline-flex items-center gap-1" : "inline-flex items-center gap-[3px]"}>
              {way.pair.map((chord, j) => (
                <kbd key={j} className="inline-flex items-center gap-0.5">
                  {chord.map((k, n) => (
                    <kbd key={n} className={`inline-flex items-center justify-center border font-mono leading-none font-normal ${CAP[size]} ${lit(i, j, k) ? "border-accent! text-accent!" : ""}`}>{capText(k, MAC)}</kbd>
                  ))}
                </kbd>
              ))}
            </span>
          )}
        </Fragment>
      ))}
    </span>
  );
}

/** A key, as it is drawn next to what it does: the small `<Keys>` (a menu, a button). */
export function Kbd({ children }: { children: ReactNode }) {
  return typeof children === "string" ? <Keys keys={children} size="sm" /> : <kbd className={`inline-flex items-center justify-center border font-mono leading-none ${CAP.sm}`}>{children}</kbd>;
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
      // only "/" and ":" are this one's: any other key goes on at once (the open modals were looked for at every key typed)
      if (e.key !== "/" && e.key !== ":") return;
      // A modal open (a question, the Deploy dialog) keeps the keys: only a search box inside the topmost one is reached,
      // never one behind it, where the focus would go out of sight of the dialog (as Dialog.tsx's dialogOver says).
      const top = [...document.querySelectorAll("[role=dialog][aria-modal=true]")].at(-1);
      const shown = (el: Element) => el.getClientRects().length > 0 && (!top || top.contains(el));
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
