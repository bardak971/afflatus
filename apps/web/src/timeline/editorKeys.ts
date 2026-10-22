import type { Dispatch, RefObject, SetStateAction } from "react";
import { stepFrames } from "../frameStep";
import type { Clock } from "./clock";
import type { PlayerHandle } from "./Player";
import type { TimeRange } from "./model";
import type { TrackKeys } from "./Track";

// The timeline editor's keys, by what they do: playing and moving about, editing the clips, and letting go of what is
// selected. No key is taken by two of them, so the order they are asked in (useEditorKeys) changes nothing.

/** Where a key press lands, worked out once for the three. */
export interface KeyPlace {
  el: HTMLElement;
  /** Writing in a field (a slider, a switch or a box to tick is not: the keys still drive the editor there). */
  typing: boolean;
  /** A dialog, a list or a menu open over the editor (the keyboard shortcuts) keeps the keys: nothing is undone behind it. */
  open: boolean;
  /** Escape belongs to what is open, and to a panel that takes it (the designer in the inspector closes on it). */
  held: boolean;
  /** Not in a field, without Ctrl, Alt or the meta key, nothing open. */
  plain: boolean;
  /** In the designer's box (Enter there sends the message). */
  designing: boolean;
}

/** What the keys act on: what changes at every render is read through refs, so the listener stays put. */
export interface KeyActions {
  clock: Clock;
  player: RefObject<PlayerHandle | null>;
  toggle(): void;
  undo(): void;
  canUndo: boolean;
  redo(): void;
  canRedo: boolean;
  remove(clip: string): void;
  move(clip: string, by: -1 | 1): void;
  removePicked(): boolean;
  rangeRef: RefObject<TimeRange | null>;
  setRange: Dispatch<SetStateAction<TimeRange | null>>;
  totalRef: RefObject<number>;
  toggleLoopNow: RefObject<() => void>;
  frameRef: RefObject<() => number>;
  selectedNow: RefObject<string | null>;
  musicOpenNow: RefObject<boolean>;
  closeMusicNow: RefObject<(() => void) | undefined>;
  removeOpenNow: RefObject<(() => boolean) | undefined>;
  /**
   * A removal is on its way, from the press that sent it (not the next render: a second press can come first) until the
   * timeline is read again without the clip. Delete waits for it.
   */
  removing: RefObject<boolean>;
  renderNow: RefObject<() => void>;
  jumpNow: RefObject<(by: -1 | 1) => void>;
  splitNow: RefObject<(only?: string | null) => void>;
  takeNow: RefObject<(by: -1 | 1) => void>;
  trackKeys: RefObject<TrackKeys | null>;
  /** I and O with the source on the stage: its In or Out at the playhead, not the range's; true when it took the key. */
  sourceMarkNow: RefObject<((which: "in" | "out") => boolean) | undefined>;
  setSelected: Dispatch<SetStateAction<string | null>>;
  setPicked: Dispatch<SetStateAction<Set<string>>>;
}

export function keyPlace(e: KeyboardEvent): KeyPlace {
  // a key sent to the window itself (not to an element) reads as sent to the page
  const el = e.target instanceof Element ? (e.target as HTMLElement) : document.body;
  const typing = Boolean(el.closest("textarea, select, [contenteditable]")) || (el instanceof HTMLInputElement && !["range", "checkbox", "radio", "button"].includes(el.type));
  const open = Boolean(document.querySelector("[role=dialog], [role=listbox], [role=menu]"));
  const held = open || Boolean(document.querySelector("[data-takes-escape]"));
  const designing = typing && Boolean(el.closest("[data-takes-escape]"));
  const plain = !typing && !e.ctrlKey && !e.metaKey && !e.altKey && !open;
  return { el, typing, open, held, plain, designing };
}

/**
 * Playing and moving about: Space plays, [ and ] go to the clip before and after, Home and End to the start and end, the
 * arrows (and , and .) step a frame, I and O mark the range and L loops it, - and = zoom the track, Shift+Z fits it.
 * True when the key was one of these.
 */
export function playbackKey(e: KeyboardEvent, { el, typing, open, held, plain }: KeyPlace, a: KeyActions): boolean {
  if (e.code === "Space" && !typing && !el.closest("button, [role=listbox], [role=dialog]")) {
    e.preventDefault();
    a.toggle();
    return true;
  }
  if (plain && (e.key === "[" || e.key === "]")) {
    e.preventDefault();
    a.jumpNow.current(e.key === "[" ? -1 : 1);
    return true;
  }
  // Home and End: the start and the end of the video (a slider keeps them for itself)
  if (plain && !held && (e.key === "Home" || e.key === "End") && !el.closest("input[type=range], [role=slider], [role=listbox]")) {
    e.preventDefault();
    a.player.current?.seek(e.key === "Home" ? 0 : a.totalRef.current);
    return true;
  }
  // - and = zoom the track out and in around the playhead (+ as =, Shift on most keyboards); Shift+Z: the whole video
  if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey && !open && !held) {
    const zoom = e.key === "-" ? -1 : e.key === "=" || e.key === "+" ? 1 : 0;
    if (zoom) {
      e.preventDefault();
      a.trackKeys.current?.zoom(zoom);
      return true;
    }
    if (e.shiftKey && e.key.toLowerCase() === "z") {
      e.preventDefault();
      a.trackKeys.current?.fit();
      return true;
    }
  }
  // I and O: In and Out at the playhead (one alone reaches to the end, or from the start); with Shift: go to In / Out
  if (plain && (e.key === "i" || e.key === "I")) {
    e.preventDefault();
    if (e.shiftKey) {
      if (a.rangeRef.current) a.player.current?.seek(a.rangeRef.current.inMs);
      return true;
    }
    // held down, the key marks once: with the source on the stage each mark is a trim, sent again with every repeat
    // before the last one's change is back
    if (e.repeat) return true;
    if (a.sourceMarkNow.current?.("in")) return true;
    const at = a.clock.get();
    a.setRange((r) => (r ? { inMs: at, outMs: Math.max(at, r.outMs) } : { inMs: at, outMs: a.totalRef.current }));
    return true;
  }
  if (plain && (e.key === "o" || e.key === "O")) {
    e.preventDefault();
    if (e.shiftKey) {
      if (a.rangeRef.current) a.player.current?.seek(a.rangeRef.current.outMs);
      return true;
    }
    if (e.repeat) return true;
    if (a.sourceMarkNow.current?.("out")) return true;
    const at = a.clock.get();
    a.setRange((r) => (r ? { inMs: Math.min(at, r.inMs), outMs: at } : { inMs: 0, outMs: at }));
    return true;
  }
  if (plain && (e.key === "l" || e.key === "L") && a.rangeRef.current) {
    e.preventDefault();
    a.toggleLoopNow.current();
    return true;
  }
  // one frame back or forward (Shift: ten); , and . do the same
  const step = e.key === "ArrowLeft" || e.key === "," ? -1 : e.key === "ArrowRight" || e.key === "." ? 1 : 0;
  if (step && !typing && !e.ctrlKey && !e.metaKey && !e.altKey && !open && !el.closest("[role=listbox], [role=slider][aria-label=In], [role=slider][aria-label=Out]")) {
    e.preventDefault();
    const frames = step * (e.shiftKey && e.key.startsWith("Arrow") ? 10 : 1);
    const frameMs = a.frameRef.current();
    const now = a.clock.get();
    // by the index of the frame shown in the clip's own file, to the middle of the one wanted: a frame's length added
    // to the time landed on frame edges, where the browser often shows the frame before (steps repeated or skipped)
    const where = a.player.current?.where();
    const file = where ? where.assetMs - where.localMs + (now - where.clip.atMs) : null;
    const to = file === null ? now + frames * frameMs : now + stepFrames(file, frames, 1000 / frameMs, Number.POSITIVE_INFINITY) - file;
    a.player.current?.seek(Math.max(0, Math.min(a.totalRef.current, to)));
    return true;
  }
  return false;
}

/**
 * Editing the clips: Ctrl+Z and Ctrl+Shift+Z (or Ctrl+Y) undo and redo, Ctrl+Enter renders the selected clip (a new
 * take), Alt+[ and Alt+] play its take before and after, S or Ctrl+B splits the clip under the playhead, Alt and an arrow
 * move the selected clip one place, Delete removes the picked clips or the selected one. True when the key was one of these.
 */
export function editKey(e: KeyboardEvent, { typing, open, held, plain, designing }: KeyPlace, a: KeyActions): boolean {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey && !typing && !open && a.canUndo) {
    e.preventDefault();
    a.undo();
    return true;
  }
  // Ctrl+Shift+Z or Ctrl+Y does again what Undo took back
  if ((e.ctrlKey || e.metaKey) && !typing && !open && a.canRedo && ((e.key.toLowerCase() === "z" && e.shiftKey) || e.key.toLowerCase() === "y")) {
    e.preventDefault();
    a.redo();
    return true;
  }
  // not from the designer's box, nor once something else took the key
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !e.repeat && !open && !designing && !e.defaultPrevented) {
    e.preventDefault();
    a.renderNow.current();
    return true;
  }
  // Alt+[ and Alt+]: the selected clip's take before or after (by the key's place too: Alt changes what some keyboards type there)
  const bracket = e.key === "[" || e.code === "BracketLeft" ? -1 : e.key === "]" || e.code === "BracketRight" ? 1 : 0;
  if (bracket && e.altKey && !e.ctrlKey && !e.metaKey && !typing && !held) {
    e.preventDefault();
    if (!e.repeat) a.takeNow.current(bracket);
    return true;
  }
  // S or Ctrl+B: split the clip under the playhead (not held down: one split a press)
  const split = (plain && !e.shiftKey && e.key.toLowerCase() === "s") || ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "b" && !typing && !open);
  if (split && !held) {
    e.preventDefault();
    if (!e.repeat) a.splitNow.current();
    return true;
  }
  // Alt + an arrow: the selected clip one place earlier or later
  if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && e.altKey && !typing && !e.ctrlKey && !e.metaKey && !open && a.selectedNow.current) {
    e.preventDefault();
    a.move(a.selectedNow.current, e.key === "ArrowLeft" ? -1 : 1);
    return true;
  }
  // Delete takes the picked clips, else the selected clip, off the timeline; Undo brings them back one by one. With
  // neither, the source lane open in the column goes, with the clips it made (one step for Undo)
  if (e.key === "Delete" && !typing && !open) {
    // held down, or pressed again before the last removal is back: one removal (the next was sent for a clip already
    // gone, and answered 404 in the header)
    if (e.repeat || a.removing.current) {
      e.preventDefault();
      return true;
    }
    if (a.removePicked()) {
      e.preventDefault();
      a.removing.current = true;
    } else if (a.selectedNow.current) {
      e.preventDefault();
      a.removing.current = true;
      a.remove(a.selectedNow.current);
    } else if (a.removeOpenNow.current?.()) e.preventDefault();
    return true;
  }
  return false;
}

/** Escape lets go, one thing a press: the picked clips with the range, else the range, else the clip open, else the music's panel. */
export function selectionKey(e: KeyboardEvent, { typing, held }: KeyPlace, a: KeyActions): boolean {
  if (e.key !== "Escape" || typing || held) return false;
  a.setPicked(new Set());
  if (a.rangeRef.current) {
    e.preventDefault();
    a.setRange(null);
    return true;
  }
  // with a clip open and no range: back to the timeline's own panel
  if (a.selectedNow.current) {
    e.preventDefault();
    a.setSelected(null);
    return true;
  }
  // the same from the music's panel
  if (a.musicOpenNow.current) {
    e.preventDefault();
    a.closeMusicNow.current?.();
  }
  return true;
}
