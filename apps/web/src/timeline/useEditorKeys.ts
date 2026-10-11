import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { Clock } from "./clock";
import { editKey, keyPlace, playbackKey, selectionKey, type KeyActions } from "./editorKeys";
import type { PlayerHandle } from "./Player";
import type { TimeRange } from "./model";
import type { TrackKeys } from "./Track";

/**
 * The editor's keys: Space plays, Ctrl+Z and Ctrl+Shift+Z undo and redo, I and O mark the range, L loops it,
 * the arrows step a frame (with Alt: move the selected clip one place), Escape clears, Delete removes the selected
 * clip, Ctrl+Enter renders it (a new take), [ and ] go to the clip before and after, Alt+[ and Alt+] play its take before and after,
 * S or Ctrl+B splits the clip under the playhead, Home and End go to the start and end, - and = zoom the track, Shift+Z fits it.
 * What changes often is read through refs, so the listener is only put back when an action it calls changes. The editor
 * fills the refs it returns for the keys whose actions it holds (render, jump, split, take, the track's zoom). What each
 * key does is editorKeys.ts's, by concern.
 */
export function useEditorKeys({ clock, player, toggle, undo, canUndo, redo, canRedo, remove, move, removePicked, rangeRef, setRange, totalRef, toggleLoopNow, frameMs, selected, setSelected, setPicked, musicOpen, closeMusic }: {
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
  frameMs(): number;
  /** The clip selected (its panel open), if any. */
  selected: string | null;
  setSelected: Dispatch<SetStateAction<string | null>>;
  setPicked: Dispatch<SetStateAction<Set<string>>>;
  /** The music's panel is open, and how to close it (Escape). */
  musicOpen?: boolean;
  closeMusic?(): void;
}) {
  // what changes at every render, read by the listener through refs
  const frameRef = useRef(frameMs);
  frameRef.current = frameMs;
  const selectedNow = useRef<string | null>(null);
  selectedNow.current = selected;
  const musicOpenNow = useRef(false);
  musicOpenNow.current = Boolean(musicOpen);
  const closeMusicNow = useRef(closeMusic);
  closeMusicNow.current = closeMusic;
  // set by the editor once what they call exists (some of it only once the timeline is read)
  /** Render the selected clip (a new take), as Generate does in the Studio's form: Ctrl+Enter, even from its prompt. */
  const renderNow = useRef(() => {});
  /** To the clip before (-1) or after (1), selecting it: [ and ]. */
  const jumpNow = useRef<(by: -1 | 1) => void>(() => {});
  /** Split the clip under the playhead, at the playhead (S and Ctrl+B); with `only` (the bar), when it is that clip. */
  const splitNow = useRef<(only?: string | null) => void>(() => {});
  /** The selected clip plays its take before (-1) or after (1): Alt+[ and Alt+]. */
  const takeNow = useRef<(by: -1 | 1) => void>(() => {});
  /** The track's zoom around the playhead and Fit all: - and =, Shift+Z (filled by the track). */
  const trackKeys = useRef<TrackKeys | null>(null);
  useEffect(() => {
    const acts: KeyActions = {
      clock, player, toggle, undo, canUndo, redo, canRedo, remove, move, removePicked, rangeRef, setRange, totalRef, toggleLoopNow,
      frameRef, selectedNow, musicOpenNow, closeMusicNow, renderNow, jumpNow, splitNow, takeNow, trackKeys, setSelected, setPicked,
    };
    const onKey = (e: KeyboardEvent) => {
      const place = keyPlace(e);
      void (playbackKey(e, place, acts) || editKey(e, place, acts) || selectionKey(e, place, acts));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, undo, canUndo, redo, canRedo, remove, move, removePicked, clock, player, rangeRef, setRange, totalRef, toggleLoopNow, setSelected, setPicked]);
  return { selectedNow, renderNow, jumpNow, splitNow, takeNow, trackKeys };
}
