import type { RemovedPart } from "../api";

/**
 * The rendered clips among the parts removed from a recording or the source (card #75) that its clips made anew over
 * `fromMs` to `toMs` (a re-cut, a moved In, made anew) leave behind (card #114). The server keeps removed every part that
 * stretch holds whole with something of it after (timelineRemoved.ts aroundRemoved, the same rule); the others go with
 * their takes: one before the new In, or past the last clip (kept with a clip a trim set aside). Counted in the editor's
 * Change or Keep ask with the takes on the track.
 */
export function droppedRemovedTakes(parts: RemovedPart[] | undefined, fromMs: number, toMs: number): number {
  return (parts ?? []).filter((p) => !(p.fromMs >= fromMs - 20 && p.toMs < toMs - 50)).reduce((n, p) => n + p.takes, 0);
}
