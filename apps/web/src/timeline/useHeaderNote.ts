import { useCallback, useEffect, useState } from "react";

/** A line in the header, and what more there is to it (behind its "?"); `undo`: an Undo beside it, for what it says was done. */
export type HeaderNote = { text: string; more?: string; undo?: boolean };

/**
 * What the timeline editor's header says: a note that goes after a few seconds (longer with more to read behind its "?"),
 * and whether the pointer rests on it, which keeps it (and an error) while it is read.
 */
export function useHeaderNote() {
  const [note, setSaid] = useState<HeaderNote | null>(null);
  const setNote = useCallback((text: string | null, more?: string) => setSaid(text === null ? null : { text, more }), []);
  /** The pointer rests on what the header says: it stays while it is read. */
  const [held, setHeld] = useState(false);
  // a note goes after a few seconds (longer with more to read behind its "?"), an error after a while: not while the pointer is on it
  useEffect(() => {
    if (!note || held) return;
    const timer = setTimeout(() => setSaid(null), note.more ? 12_000 : 4000);
    return () => clearTimeout(timer);
  }, [note, held]);
  return { note, setSaid, setNote, held, setHeld };
}

/** The latest error, as the header shows it: gone after ten seconds, not while the pointer rests on it (`held`). */
export function useErrorShown(error: Error | null, held: boolean): Error | null {
  const [errorGone, setErrorGone] = useState<Error | null>(null);
  useEffect(() => {
    if (!error || held) return;
    const timer = setTimeout(() => setErrorGone(error), 10_000);
    return () => clearTimeout(timer);
  }, [error, held]);
  return error && error !== errorGone ? error : null;
}
