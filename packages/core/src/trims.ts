// The rule a trimmed-in end follows, here rather than in the server alone: the track's lanes draw where an end will come
// to rest while it is dragged (it resists there instead of jumping on release), from the same function the server cuts with.
// Beside it, the server's rule for an end trimmed out (trimOut) and what a source's windows cut again keep (ownsOf).

import type { Recipe } from "./recipe";

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


/** A window a cut again drops, as ownsOf reads it: its part, its own frames' start, its form and what it keeps its own. */
type DroppedWindow = { from: number; start: number; to: number; recipe?: Recipe<any>; own: Record<string, unknown> };

/**
 * What each window a cut again makes takes of the windows it drops (makeFromSource `again`), in ms. One that lies where a
 * dropped one lay (within half a frame, `slack`) keeps all it kept its own, and when it carries on, the form it was given
 * (a window that opens a shot is the source's form: made again with Swap character after Motion transfer, the opening is
 * a swap). Else it takes what the dropped window whose own frames hold its middle kept its own, not its form (a form given
 * where the motion drifted is not the user's for a window lying elsewhere). A dropped window none of them took gives the
 * text it kept its own to the nearest new window, before or after what that one has, as they lie in time: by middles
 * alone, a window between two middles lost its prompt, its swap's too.
 */
export function ownsOf(windows: Array<{ start: number; seconds: number; opens?: boolean }>, dropped: DroppedWindow[], slack: number): Array<{ own: Record<string, unknown>; form?: Recipe<any> }> {
  const mid = (w: { start: number; seconds: number }) => (w.start + w.seconds / 2) * 1000;
  const took = windows.map((w) => {
    const same = dropped.findIndex((o) => Math.abs(o.from - w.start * 1000) <= slack && Math.abs(o.to - (w.start + w.seconds) * 1000) <= slack);
    if (same >= 0) return { at: same, same: true };
    return { at: dropped.findIndex((o) => mid(w) >= o.start && mid(w) < o.to), same: false };
  });
  const out = took.map(({ at, same }, k) => ({ own: at >= 0 ? { ...dropped[at]!.own } : {}, ...(same && !windows[k]!.opens ? { form: dropped[at]!.recipe } : {}) }));
  for (const [j, o] of dropped.entries()) {
    if (!windows.length || took.some((x) => x.at === j)) continue;
    const typed = Object.entries(o.own).filter(([, v]) => typeof v === "string" && v.trim());
    if (!typed.length) continue;
    const at = (o.from + o.to) / 2;
    const near = windows.reduce((best, w, k) => (Math.abs(mid(w) - at) < Math.abs(mid(windows[best]!) - at) ? k : best), 0);
    const own = out[near]!.own;
    for (const [k, v] of typed) {
      const has = typeof own[k] === "string" ? (own[k] as string).trim() : "";
      own[k] = !has || has.includes(v as string) ? (has || v) : at < mid(windows[near]!) ? `${v} ${has}` : `${has} ${v}`;
    }
  }
  return out;
}

/**
 * The clip a trim out starts from, in ms: where its part starts and ends; `free`: empty and not in the queue, so it may be
 * made longer; `reach`: the end it may be made longer to (where it ended before a trim shortened it), if any.
 */
type GrowFrom = { start: number; end: number; free: boolean; reach?: number };

/**
 * What an end trimmed out does: the rule a source's windows and a recording's Lip sync clips share (trimSource,
 * trimRecording), as trimIn is for an end brought in. The last clip, empty and shortened by a trim in, is made longer first,
 * as far as its `reach` and the stretch go. Then the clips set aside come back in order while each starts where the one
 * before it ends and the stretch holds it whole: one it does not hold yet stops there, it and those after it kept aside
 * (`keep`), and nothing is added past them. One that does not meet the clip before is kept aside while the last clip can
 * still reach it (empty and shortened, its length not given back yet, or in the queue with no take yet: a few seconds more
 * of stretch bring them together). Else it never will, as one of another model (`fits` false) never comes back: when it or
 * one after it has a take (`taken`), the end stops there too and every one of them stays aside (a rendered window
 * shortened by a trim in, its render landed, is never made longer under its take; Undo, or its take removed, brings them
 * back), and only when none has one do they go (`keep` false) and new clips are made past the last one. Dropped, the
 * shortened window's render landing lost every rendered window set aside, on the next drag out, with nothing said. Twice
 * this rule was written out twice, and the two drifted: a gap that only waited for a longer stretch dropped every window
 * set aside, a rendered clip under new parts went with its take, and a window in the queue was given its length back under
 * its render. A clip set aside with a part removed before it (`cut`) comes back past the gap the part leaves. `more`: new
 * clips may be added from `end` to the stretch's end; with `leastMs`, never one shorter than a clip can be, whichever way
 * the clips set aside ended: the empty last clip takes what is left when it holds it (`mostMs`), else the end rests where
 * the clips end (recordingParts folds a short last part alike).
 */
export function trimOut(last: GrowFrom | undefined, rows: Array<{ start: number; end: number; fits: boolean; taken?: boolean; cut?: boolean }>, asked: number, o: { fromMs: number; leastMs?: number; mostMs?: number }): { lastEnd?: number; back: number; end: number; keep: boolean; more: boolean } {
  let end = last ? last.end : o.fromMs;
  let lastEnd: number | undefined;
  // any length a trim in took off given back (within a rounding too: a window left a frame short stays so for good)
  if (last?.free && last.reach !== undefined && last.reach > end + 0.5) {
    lastEnd = Math.round(Math.min(last.reach, asked));
    end = lastEnd;
  }
  let back = 0;
  let keep = true;
  for (const [k, row] of rows.entries()) {
    // the clip after a part removed from the middle (`cut`, timelineRemoved.ts) starts past it on purpose: it meets the one
    // before it across the part, which stays removed
    const meets = row.fits && (!last || Math.abs(row.start - end) <= 50 || Boolean(row.cut && row.start > end));
    if (!meets) {
      const waits = row.fits && back === 0 && last?.reach !== undefined && Math.abs(row.start - last.reach) <= 50;
      if (waits || rows.slice(k).some((r) => r.taken)) return { lastEnd, back, end, keep: true, more: false };
      keep = false;
      break;
    }
    if (row.end > asked + 50) return { lastEnd, back, end, keep: true, more: false };
    end = row.end;
    back++;
  }
  if (o.leastMs !== undefined && asked > end + 50 && asked - end < o.leastMs) {
    if (!back && last?.free && o.mostMs !== undefined && asked - last.start <= o.mostMs) {
      lastEnd = Math.round(asked);
      end = lastEnd;
    }
    return { lastEnd, back, end, keep, more: false };
  }
  return { lastEnd, back, end, keep, more: true };
}
