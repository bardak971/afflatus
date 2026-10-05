import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { Clock } from "./clock";
import type { PlayerHandle } from "./Player";
import type { TimeRange } from "./Track";

/**
 * The editor's keys: Space plays, Ctrl+Z and Ctrl+Shift+Z undo and redo, I and O mark the range, L loops it,
 * the arrows step a frame, Escape clears, Delete removes the selected clip. What changes often is read
 * through refs, so the listener is only put back when an action it calls changes.
 */
export function useEditorKeys({ clock, player, toggle, undo, canUndo, redo, canRedo, remove, rangeRef, setRange, totalRef, toggleLoopNow, frameRef, selectedNow, setSelected, setPicked }: {
  clock: Clock;
  player: RefObject<PlayerHandle | null>;
  /** Play or pause (the range when there is one). */
  toggle(): void;
  undo(): void;
  canUndo: boolean;
  redo(): void;
  canRedo: boolean;
  remove(clip: string): void;
  rangeRef: RefObject<TimeRange | null>;
  setRange: Dispatch<SetStateAction<TimeRange | null>>;
  /** How long the timeline is. */
  totalRef: RefObject<number>;
  toggleLoopNow: RefObject<() => void>;
  /** One frame of the clip under the playhead, in ms. */
  frameRef: RefObject<() => number>;
  selectedNow: RefObject<string | null>;
  setSelected: Dispatch<SetStateAction<string | null>>;
  setPicked: Dispatch<SetStateAction<Set<string>>>;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing = Boolean(el.closest("input, textarea, select, [contenteditable]"));
      if (e.code === "Space" && !typing && !el.closest("button, [role=listbox], [role=dialog]")) {
        e.preventDefault();
        toggle();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey && !typing && canUndo) {
        e.preventDefault();
        undo();
      }
      // Ctrl+Shift+Z or Ctrl+Y does again what Undo took back
      if ((e.ctrlKey || e.metaKey) && !typing && canRedo && ((e.key.toLowerCase() === "z" && e.shiftKey) || e.key.toLowerCase() === "y")) {
        e.preventDefault();
        redo();
      }
      const open = Boolean(document.querySelector("[role=dialog], [role=listbox], [role=menu]"));
      const plain = !typing && !e.ctrlKey && !e.metaKey && !e.altKey && !open;
      // I and O: In and Out at the playhead (one alone reaches to the end, or from the start)
      // I and O: In and Out at the playhead (one alone reaches to the end, or from the start); with Shift: go to In / Out
      if (plain && (e.key === "i" || e.key === "I")) {
        e.preventDefault();
        if (e.shiftKey) {
          if (rangeRef.current) player.current?.seek(rangeRef.current.inMs);
          return;
        }
        const at = clock.get();
        setRange((r) => (r ? { inMs: at, outMs: Math.max(at, r.outMs) } : { inMs: at, outMs: totalRef.current }));
        return;
      }
      if (plain && (e.key === "o" || e.key === "O")) {
        e.preventDefault();
        if (e.shiftKey) {
          if (rangeRef.current) player.current?.seek(rangeRef.current.outMs);
          return;
        }
        const at = clock.get();
        setRange((r) => (r ? { inMs: Math.min(at, r.inMs), outMs: at } : { inMs: 0, outMs: at }));
        return;
      }
      if (plain && (e.key === "l" || e.key === "L") && rangeRef.current) {
        e.preventDefault();
        toggleLoopNow.current();
        return;
      }
      if (e.key === "Escape" && !typing && !open) setPicked(new Set());
      if (e.key === "Escape" && !typing && !open && rangeRef.current) {
        e.preventDefault();
        setRange(null);
        return;
      }
      // Escape with a clip open and no range: back to the timeline's own panel
      if (e.key === "Escape" && !typing && !open && selectedNow.current) {
        e.preventDefault();
        setSelected(null);
        return;
      }
      // one frame back or forward (Shift: ten); , and . do the same
      const step = e.key === "ArrowLeft" || e.key === "," ? -1 : e.key === "ArrowRight" || e.key === "." ? 1 : 0;
      if (step && !typing && !e.ctrlKey && !e.metaKey && !e.altKey && !open && !el.closest("[role=listbox], [role=slider][aria-label=In], [role=slider][aria-label=Out]")) {
        e.preventDefault();
        const by = step * frameRef.current() * (e.shiftKey && e.key.startsWith("Arrow") ? 10 : 1);
        player.current?.seek(Math.max(0, Math.min(totalRef.current, clock.get() + by)));
        return;
      }
      // Delete takes the selected clip off the timeline; Undo brings it back
      if (e.key === "Delete" && !typing && selectedNow.current && !open) {
        e.preventDefault();
        remove(selectedNow.current);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, undo, canUndo, redo, canRedo, remove, clock]);
}
