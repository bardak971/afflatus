/**
 * A clip removed from a recording's Lip sync clips or from a source's windows cuts its part out, as a ripple delete does in a
 * video editor (card #75, the owner's rule of 2026-10-24). Deleted, as it was before, the clip after kept its own part: the
 * song or the source's motion jumped over the removed stretch without a word, and the take after, rendered carrying on from
 * the removed clip, kept claiming a seamless join.
 * - The first clips of the run: as the In moved past them (they go; Undo brings them back).
 * - The last ones: as the Out brought in before them (set aside with the trims' clips, which the Out moved out brings back).
 * - A run of clips in the middle: set aside whole, with their takes, as a removed part kept with the clip after it (`before`),
 *   which becomes a cut. Undo brings it back, and so does the part's own Bring back.
 */

/** A clip set aside whole: its row and its takes' rows, as they were; `told`: one that never comes back, said so once. */
export type ParkedClip = { clip: Record<string, unknown>; takes: Array<Record<string, unknown>>; told?: true };

/**
 * A stretch cut out of the middle of a recording or a source: its clips set aside in order (`rows`), and the clip after it
 * (`before`) with its join as it was (`joined`) and, when the cut moved its part of a source (a window that carried on
 * starts later as a cut: windowRunUp), its form as it was (`inputs`, the row's JSON); `take`: the take it played then (one
 * rendered since was made as a cut, and keeps its join when the part comes back).
 */
export type RemovedPart = { before: string; rows: ParkedClip[]; joined: "cut" | "continue"; inputs?: string; take?: string | null };

/** What removing some of a run's clips does to it, the run in its order (each clip's part, in ms of the recording or source). */
export interface Removal {
  /** All of the run's clips go: the recording or source is taken off, as before. */
  whole: boolean;
  /** The first clips removed: they go, the In past them. */
  lead: string[];
  /** The last ones removed: set aside as the trims set aside, the Out before them. */
  tail: string[];
  /** Each run of clips removed between two that stay: set aside, kept with the clip after it (`before`). */
  middles: Array<{ ids: string[]; after: string; before: string }>;
}

/** Which of a run's clips (in order) removing `gone` takes off how. */
export function removalOf(run: string[], gone: ReadonlySet<string>): Removal {
  const kept = run.filter((id) => !gone.has(id));
  if (!kept.length) return { whole: true, lead: [], tail: [], middles: [] };
  const first = run.indexOf(kept[0]!);
  const last = run.indexOf(kept.at(-1)!);
  const middles: Removal["middles"] = [];
  let block: string[] = [];
  for (let k = first; k <= last; k++) {
    const id = run[k]!;
    if (gone.has(id)) {
      block.push(id);
      continue;
    }
    if (block.length) middles.push({ ids: block, after: run[k - 1 - block.length]!, before: id });
    block = [];
  }
  return { whole: false, lead: run.slice(0, first), tail: run.slice(last + 1), middles };
}

/**
 * The clip after a cut rendered since it was made one (`row`: that clip; `part`: the cut): its take was made as a cut, of
 * its part as it is now, so it keeps its join and form (as Bring back keeps them), and the part no longer lies end to end
 * with it.
 */
export const renderedSince = (row: ParkedClip, part: RemovedPart): boolean => (row.clip.take_id ?? null) !== (part.take ?? null);

/** A clip set aside back to the join and form it had before a cut made it the clip after one (`part`: that cut). */
export function asItWas(row: ParkedClip, part: RemovedPart): ParkedClip {
  return { ...row, clip: { ...row.clip, joined: part.joined, ...(part.inputs !== undefined ? { inputs: part.inputs } : {}) } };
}

/**
 * The removed parts of a run once `ids` (its clips, in order) are set aside or go: a part kept with one of them is taken out
 * of the list, and its clips put back among `rows` (those set aside now, in order), each just before the clip it was kept
 * with, that clip back as it was; so what is set aside lies end to end again, as a trim out brings it back (trimOut stops
 * at a clip that does not meet the one before). A part whose clip after was rendered since stays a removed part, kept with
 * that clip set aside: folded in, that clip would come back with a take made as a cut under the join and part it had before
 * (or, kept as a cut, stop the trim out at the gap before it). Brought back with it, the part is marked again, to bring back
 * on its own. `rows` is null when they go (the In moved past them): the parts go too.
 */
export function foldParts(parts: RemovedPart[], ids: string[], rows: ParkedClip[] | null): { parts: RemovedPart[]; rows: ParkedClip[] } {
  const going = new Set(ids);
  if (!rows) return { parts: parts.filter((p) => !going.has(p.before)), rows: [] };
  const rowOf = (id: string) => rows.find((r) => r.clip.id === id);
  const folds = (p: RemovedPart) => going.has(p.before) && !renderedSince(rowOf(p.before) ?? { clip: { take_id: p.take ?? null }, takes: [] }, p);
  const folded = parts.filter(folds);
  const left = parts.filter((p) => !folds(p));
  const out: ParkedClip[] = [];
  for (const row of rows) {
    const part = folded.find((p) => p.before === row.clip.id);
    if (part) out.push(...part.rows, asItWas(row, part));
    else out.push(row);
  }
  return { parts: left, rows: out };
}

/**
 * A stretch made anew (a re-cut, a moved In, a source made anew: card #114) around the parts removed from it: the pieces
 * left between them, in order, each with the parts that lie just before it (`after`), for its first new clip to be the cut
 * each is kept with. A part removed stays removed with its takes; one a piece too short for a clip follows goes with the
 * next piece (the caller's). A part the stretch no longer holds whole (before the new In, or with nothing of it after it)
 * is `dropped`: its takes go with it, which the editor asks about first. `parts` with their span (removedView's).
 */
export function aroundRemoved(fromMs: number, toMs: number, parts: Array<{ part: RemovedPart; fromMs: number; toMs: number }>): { pieces: Array<{ fromMs: number; toMs: number; after: RemovedPart[] }>; dropped: RemovedPart[] } {
  const sorted = [...parts].sort((a, b) => a.fromMs - b.fromMs);
  const inside = (p: (typeof parts)[number]) => p.fromMs >= fromMs - 20 && p.toMs < toMs - 50;
  const pieces: Array<{ fromMs: number; toMs: number; after: RemovedPart[] }> = [];
  const dropped = sorted.filter((p) => !inside(p)).map((p) => p.part);
  let at = fromMs;
  let after: RemovedPart[] = [];
  for (const p of sorted.filter(inside)) {
    if (p.fromMs - at > 50) {
      pieces.push({ fromMs: at, toMs: p.fromMs, after });
      after = [];
    }
    after.push(p.part);
    at = Math.max(at, p.toMs);
  }
  pieces.push({ fromMs: at, toMs, after });
  return { pieces, dropped };
}

/**
 * The parts kept with the first clip of each piece a stretch was made anew in (aroundRemoved; `firsts`: that clip, null for
 * a piece that made none): its parts go with the next piece that made one, the clip after them; with none after, they are
 * dropped. Several before one clip are one part, in order. `rejoined`: the part as the new clip keeps it, its join as it
 * would be carrying on and that form (made a cut, Bring back gives it them back, as for the clip it replaces).
 */
export function keptAround(pieces: Array<{ after: RemovedPart[] }>, firsts: Array<string | null>, rejoined: (part: RemovedPart, before: string) => RemovedPart): { kept: RemovedPart[]; dropped: RemovedPart[] } {
  const kept: RemovedPart[] = [];
  let waiting: RemovedPart[] = [];
  for (const [k, piece] of pieces.entries()) {
    waiting = [...waiting, ...piece.after];
    const first = firsts[k];
    if (!first || !waiting.length) continue;
    const one: RemovedPart = { ...waiting.at(-1)!, rows: waiting.flatMap((p) => p.rows) };
    kept.push(rejoined(one, first));
    waiting = [];
  }
  return { kept, dropped: waiting };
}

/** Removed parts as the row keeps them: the readable ones. */
export function removedOf(raw: unknown): RemovedPart[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((p): p is RemovedPart => Boolean(p) && typeof p.before === "string" && Array.isArray(p.rows) && (p.joined === "cut" || p.joined === "continue"))
    .map((p) => ({ ...p, rows: p.rows.filter((r) => r && typeof r.clip === "object" && Array.isArray(r.takes)) }));
}

/**
 * What the editor is told of a removed part: the clip after it, the stretch set aside (ms of the recording or source, each
 * clip's own part as `spanOf` reads it: a window that carried on starts after the frames it carried), its clips and the
 * rendered among them.
 */
export function removedView(part: RemovedPart, spanOf: (row: ParkedClip) => { from: number; to: number }) {
  const spans = part.rows.map(spanOf);
  return { before: part.before, fromMs: Math.round(Math.min(...spans.map((s) => s.from))), toMs: Math.round(Math.max(...spans.map((s) => s.to))), clips: part.rows.length, takes: part.rows.filter((r) => r.clip.take_id).length };
}
