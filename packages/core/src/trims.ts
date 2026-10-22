// The rule a trimmed-in end follows, here rather than in the server alone: the track's lanes draw where an end will come
// to rest while it is dragged (it resists there instead of jumping on release), from the same function the server cuts with.

/**
 * A clip's part as a trim reads it, in ms of the source or the recording: where its part starts (`from`), where its own
 * frames start (`start`: past the run-up of a window that carries on), where it ends. `whole`: rendered, or in the queue:
 * never shortened. `busy`: in the queue, so never set aside either.
 */
export type TrimPart = { id: string; from: number; start: number; end: number; whole: boolean; busy?: boolean };

/**
 * Where an end trimmed in comes to rest, and what it sets aside and shortens: the rule a source's windows and a recording's
 * Lip sync clips share (trimSource, trimRecording). A clip past the end is set aside; an empty one the end falls in is
 * shortened to it, or set aside when what is left is under `leastMs` (the end back to where the clip kept before ends); a
 * whole one is never shortened: the end snaps to the nearer of its ends, and one in the queue (that cannot be set aside) to
 * its end, as a rendered one the end falls in the second half of: refused instead, a drag a little into a window that
 * renders failed where the same drag into a rendered one went through. One the end falls on the start of (within a
 * rounding) is one the end is before: set aside, so refused. The first clip is never set aside: the stretch
 * would hold none, and a recording's band would leave the track with no edge left to trim it back by. It keeps its length
 * when whole, else at least `leastMs` (an end asked shorter than a clip can be stops there).
 */
export function trimIn(parts: TrimPart[], asked: number, leastMs: number): { toMs: number; away: string[]; shortened: Array<{ id: string; ms: number }> } {
  let toMs = asked;
  const away: string[] = [];
  const shortened: Array<{ id: string; ms: number }> = [];
  // where the last clip kept ends: the end never comes back before it (a window's run-up starts inside the one before)
  let keptEnd = 0;
  for (const [k, p] of parts.entries()) {
    if (p.end <= toMs) keptEnd = p.end;
    else if (k === 0) {
      if (p.whole) toMs = Math.round(p.end);
      else {
        toMs = Math.round(Math.min(p.end, Math.max(toMs, p.from + leastMs)));
        if (toMs < p.end) shortened.push({ id: p.id, ms: toMs - p.from });
      }
      keptEnd = toMs;
    } else if (p.start >= toMs) away.push(p.id);
    else if (p.whole) {
      if ((p.busy && toMs - p.start > 50) || toMs - p.start >= (p.end - p.start) / 2) { toMs = Math.round(p.end); keptEnd = p.end; }
      else { away.push(p.id); toMs = Math.round(Math.max(p.start, keptEnd)); }
    } else if (toMs - p.from >= leastMs) {
      shortened.push({ id: p.id, ms: toMs - p.from });
      keptEnd = toMs;
    } else { away.push(p.id); toMs = Math.round(Math.max(p.start, keptEnd)); }
  }
  return { toMs, away, shortened };
}

