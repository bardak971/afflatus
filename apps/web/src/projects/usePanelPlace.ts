import { useEffect, useLayoutEffect, useState, type RefObject } from "react";

/**
 * Where the Projects panel sits and when it goes: beside the rail, level with its button (`anchor`), inside the window (one
 * project's tree: under its breadcrumb); a click elsewhere closes it; a dialog opened from it that sits lower than it makes
 * it step aside (`covered`).
 */
export function usePanelPlace({ panel, anchor, scoped, onClose }: {
  panel: RefObject<HTMLDivElement | null>;
  anchor: RefObject<HTMLElement | null>;
  scoped: boolean;
  onClose(): void;
}) {
  // where it sits: beside the rail, level with its button, inside the window; one project's tree under its breadcrumb
  const [place, setPlace] = useState<{ left: number; top: number; width: number; maxHeight: number; arrow: number } | null>(null);
  useLayoutEffect(() => {
    const at = () => {
      const r = anchor.current?.getBoundingClientRect();
      if (!r) return;
      if (scoped) {
        const width = Math.max(320, Math.min(640, window.innerWidth - 16));
        const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
        const top = r.bottom + 6;
        setPlace({ left, top, width, maxHeight: Math.min(window.innerHeight * 0.75, window.innerHeight - top - 8), arrow: 0 });
        return;
      }
      const rail = anchor.current?.closest("nav")?.getBoundingClientRect().right ?? r.right;
      const left = rail + 8;
      const top = Math.max(8, r.top - 12);
      // wide screens: up to 1100 px, so long names keep more of themselves; never past 80 % of the window
      setPlace({ left, top, width: Math.max(320, Math.min(1100, Math.round(window.innerWidth * 0.8), window.innerWidth - left - 8)), maxHeight: Math.min(window.innerHeight * 0.8, window.innerHeight - top - 8), arrow: r.top + r.height / 2 - top });
    };
    at();
    window.addEventListener("resize", at);
    return () => window.removeEventListener("resize", at);
  }, [anchor, scoped]);
  // a click elsewhere closes it; not one on its button, a menu opened from it, or a question asked over it
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      const t = e.target as Element;
      if (panel.current?.contains(t) || anchor.current?.contains(t) || t.closest?.("[data-floating], [role=dialog][aria-modal=true]")) return;
      onClose();
    };
    window.addEventListener("pointerdown", outside, true);
    return () => window.removeEventListener("pointerdown", outside, true);
  }, [panel, anchor, onClose]);

  // a dialog opened from it that sits lower than it (Add to a timeline, the Viewer's): the panel steps aside until it closes
  const [covered, setCovered] = useState(false);
  useEffect(() => {
    const look = () => setCovered([...document.querySelectorAll<HTMLElement>("body > [role=dialog][aria-modal=true]")].some((d) => (Number.parseInt(getComputedStyle(d).zIndex, 10) || 0) < 66));
    look();
    const watch = new MutationObserver(look);
    watch.observe(document.body, { childList: true });
    return () => watch.disconnect();
  }, []);
  return { place, covered };
}
