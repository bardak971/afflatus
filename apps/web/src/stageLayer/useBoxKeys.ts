import { useEffect, useRef, type RefObject } from "react";
import { dialogOver, OVER } from "../Dialog";
import { typing } from "../Keys";

/**
 * Del and Esc on the boxes drawn on the Stage's layer (the regions, Edit in box's boxes): Del removes the box picked, Esc
 * lets it go, and with none picked `onLeave` (when given) leaves the picture. Not while typing, nor under a dialog opened
 * over the layer (`root`), nor while a list or a popover is open over the Stage, whose Esc is its own: it dropped the box or
 * left the picture. `capture`: heard before the viewer's own keys (Paint and fix, drawn inside the viewer); `off`: Del
 * removes nothing (the boxes are shown greyed, on a model that takes none).
 */
export function useBoxKeys({ selected, remove, select, onLeave, root, capture = false, off = false }: {
  selected: string | null;
  remove(id: string): void;
  select(id: string | null): void;
  onLeave?(): void;
  root: RefObject<HTMLElement | null>;
  capture?: boolean;
  off?: boolean;
}) {
  const now = useRef({ selected, remove, select, onLeave, off });
  now.current = { selected, remove, select, onLeave, off };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || typing(e) || e.ctrlKey || e.metaKey || e.altKey || dialogOver(root.current) || document.querySelector(OVER)) return;
      const n = now.current;
      if ((e.key === "Delete" || e.key === "Backspace") && n.selected && !n.off) {
        e.preventDefault();
        n.remove(n.selected);
        n.select(null);
      } else if (e.key === "Escape" && (n.selected || n.onLeave)) {
        e.preventDefault();
        if (n.selected) n.select(null);
        else n.onLeave?.();
      }
    };
    window.addEventListener("keydown", onKey, capture);
    return () => window.removeEventListener("keydown", onKey, capture);
  }, [root, capture]);
}
