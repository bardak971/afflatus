import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { Clock } from "./clock";
import type { PlayerHandle } from "./Player";
import type { TimeRange, TrackKeys } from "./Track";

/**
 * The editor's keys: Space plays, Ctrl+Z and Ctrl+Shift+Z undo and redo, I and O mark the range, L loops it,
 * the arrows step a frame (with Alt: move the selected clip one place), Escape clears, Delete removes the selected
 * clip, Ctrl+Enter renders it (a new take), [ and ] go to the clip before and after, Alt+[ and Alt+] play its take before and after,
 * S or Ctrl+B splits the clip under the playhead, Home and End go to the start and end, - and = zoom the track, Shift+Z fits it.
 * What changes often is read through refs, so the listener is only put back when an action it calls changes.
 */
export function useEditorKeys({ clock, player, toggle, undo, canUndo, redo, canRedo, remove, move, removePicked, rangeRef, setRange, totalRef, toggleLoopNow, frameRef, selectedNow, setSelected, setPicked, musicOpenNow, closeMusic, renderNow, jumpNow, splitNow, takeNow, trackKeys }: {
  clock: Clock;
  player: RefObject<PlayerHandle | null>;
  /** Play or pause (the range when there is one). */
  toggle(): void;
  undo(): void;
  /** Something to undo, and no undo or redo on its way (a key held down sends one at a time). */
  canUndo: boolean;
  redo(): void;
  canRedo: boolean;
  remove(clip: string): void;
  /** One place earlier (-1) or later (1). */
  move(clip: string, by: -1 | 1): void;
  /** Several clips are picked with Ctrl + click: Delete removes them all; true when it did. */
  removePicked(): boolean;
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
  /** The music's panel is open, and how to close it (Escape). */
  musicOpenNow?: RefObject<boolean>;
  closeMusic?(): void;
  /** Render the selected clip (a new take), as Generate does in the Studio's form: Ctrl+Enter, even from its prompt. */
  renderNow?: RefObject<() => void>;
  /** To the clip before (-1) or after (1), selecting it: [ and ]. */
  jumpNow?: RefObject<(by: -1 | 1) => void>;
  /** Split the clip under the playhead, at the playhead: S and Ctrl+B. */
  splitNow?: RefObject<() => void>;
  /** The selected clip plays its take before (-1) or after (1): Alt+[ and Alt+]. */
  takeNow?: RefObject<(by: -1 | 1) => void>;
  /** The track's zoom around the playhead and Fit all: - and =, Shift+Z. */
  trackKeys?: RefObject<TrackKeys | null>;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // a key sent to the window itself (not to an element) reads as sent to the page
      const el = e.target instanceof Element ? (e.target as HTMLElement) : document.body;
      // writing in a field (a slider, a switch or a box to tick is not: the keys still drive the editor there)
      const typing = Boolean(el.closest("textarea, select, [contenteditable]")) || (el instanceof HTMLInputElement && !["range", "checkbox", "radio", "button"].includes(el.type));
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
      // Escape belongs to what is open, and to a panel that takes it (the designer in the inspector closes on it)
      const held = open || Boolean(document.querySelector("[data-takes-escape]"));
      // not from the designer's box (Enter there sends the message), nor once something else took the key
      const designing = typing && Boolean(el.closest("[data-takes-escape]"));
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !e.repeat && !open && !designing && !e.defaultPrevented && renderNow) {
        e.preventDefault();
        renderNow.current();
      }
      const plain = !typing && !e.ctrlKey && !e.metaKey && !e.altKey && !open;
      if (plain && jumpNow && (e.key === "[" || e.key === "]")) {
        e.preventDefault();
        jumpNow.current(e.key === "[" ? -1 : 1);
      }
      // Alt+[ and Alt+]: the selected clip's take before or after (by the key's place too: Alt changes what some keyboards type there)
      const bracket = e.key === "[" || e.code === "BracketLeft" ? -1 : e.key === "]" || e.code === "BracketRight" ? 1 : 0;
      if (bracket && e.altKey && !e.ctrlKey && !e.metaKey && !typing && !held && takeNow) {
        e.preventDefault();
        if (!e.repeat) takeNow.current(bracket);
        return;
      }
      // S or Ctrl+B: split the clip under the playhead (not held down: one split a press)
      const split = (plain && !e.shiftKey && e.key.toLowerCase() === "s") || ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "b" && !typing && !open);
      if (split && !held && splitNow) {
        e.preventDefault();
        if (!e.repeat) splitNow.current();
        return;
      }
      // Home and End: the start and the end of the video (a slider keeps them for itself)
      if (plain && !held && (e.key === "Home" || e.key === "End") && !el.closest("input[type=range], [role=slider], [role=listbox]")) {
        e.preventDefault();
        player.current?.seek(e.key === "Home" ? 0 : totalRef.current);
        return;
      }
      // - and = zoom the track out and in around the playhead (+ as =, Shift on most keyboards); Shift+Z: the whole video
      if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey && !open && !held && trackKeys) {
        const zoom = e.key === "-" ? -1 : e.key === "=" || e.key === "+" ? 1 : 0;
        if (zoom) {
          e.preventDefault();
          trackKeys.current?.zoom(zoom);
          return;
        }
        if (e.shiftKey && e.key.toLowerCase() === "z") {
          e.preventDefault();
          trackKeys.current?.fit();
          return;
        }
      }
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
      if (e.key === "Escape" && !typing && !held) setPicked(new Set());
      if (e.key === "Escape" && !typing && !held && rangeRef.current) {
        e.preventDefault();
        setRange(null);
        return;
      }
      // Escape with a clip open and no range: back to the timeline's own panel
      if (e.key === "Escape" && !typing && !held && selectedNow.current) {
        e.preventDefault();
        setSelected(null);
        return;
      }
      // the same from the music's panel
      if (e.key === "Escape" && !typing && !held && musicOpenNow?.current) {
        e.preventDefault();
        closeMusic?.();
        return;
      }
      // Alt + an arrow: the selected clip one place earlier or later
      if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && e.altKey && !typing && !e.ctrlKey && !e.metaKey && !open && selectedNow.current) {
        e.preventDefault();
        move(selectedNow.current, e.key === "ArrowLeft" ? -1 : 1);
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
      // Delete takes the picked clips, else the selected clip, off the timeline; Undo brings them back one by one
      if (e.key === "Delete" && !typing && !open) {
        if (removePicked()) e.preventDefault();
        else if (selectedNow.current) {
          e.preventDefault();
          remove(selectedNow.current);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, undo, canUndo, redo, canRedo, remove, move, removePicked, clock]);
}
