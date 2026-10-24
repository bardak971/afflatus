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

/** A clip set aside back to the join and form it had before a cut made it the clip after one (`part`: that cut). */
export function asItWas(row: ParkedClip, part: RemovedPart): ParkedClip {
  return { ...row, clip: { ...row.clip, joined: part.joined, ...(part.inputs !== undefined ? { inputs: part.inputs } : {}) } };
}

/**
 * The removed parts of a run once `ids` (its clips, in order) are set aside or go: a part kept with one of them is taken out
 * of the list, and its clips put back among `rows` (those set aside now, in order), each just before the clip it was kept
 * with, that clip back as it was; so what is set aside lies end to end again, as a trim out brings it back (trimOut stops
 * at a clip that does not meet the one before). `rows` is null when they go (the In moved past them): the parts go too.
 */
export function foldParts(parts: RemovedPart[], ids: string[], rows: ParkedClip[] | null): { parts: RemovedPart[]; rows: ParkedClip[] } {
  const going = new Set(ids);
  const folded = parts.filter((p) => going.has(p.before));
  const left = parts.filter((p) => !going.has(p.before));
  if (!rows) return { parts: left, rows: [] };
  const out: ParkedClip[] = [];
  for (const row of rows) {
    const part = folded.find((p) => p.before === row.clip.id);
    if (part) out.push(...part.rows, asItWas(row, part));
    else out.push(row);
  }
  return { parts: left, rows: out };
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
