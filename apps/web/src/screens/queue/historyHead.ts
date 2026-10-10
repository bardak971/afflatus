import type { HistoryPage } from "../../api";

/**
 * The history as loaded, with its first page read again worked in: the jobs that are new go in front of the first page,
 * the ones it already holds take their fresh state where they are, and the counts are the fresh ones. The pages after
 * it are kept as they are: the next page is asked after the job the list ends on (its cursor), which the new jobs do
 * not move, so nothing is skipped or read twice. Null when the fresh page holds nothing already loaded (more ended than a
 * page holds, or the list is another one now): then only reading every page again says what the list is.
 */
export function withFreshHead(pages: HistoryPage[], head: HistoryPage): HistoryPage[] | null {
  const first = pages[0];
  if (!first) return [head];
  const fresh = new Map(head.items.map((j) => [j.id, j]));
  const loaded = new Set(pages.flatMap((p) => p.items.map((j) => j.id)));
  const added = head.items.filter((j) => !loaded.has(j.id));
  if (head.items.length && added.length === head.items.length) return null;
  const update = (p: HistoryPage) => (p.items.some((j) => fresh.has(j.id) && fresh.get(j.id) !== j) ? { ...p, items: p.items.map((j) => fresh.get(j.id) ?? j) } : p);
  const kept = pages.map(update);
  return [{ ...kept[0]!, items: [...added, ...kept[0]!.items], counts: head.counts }, ...kept.slice(1)];
}

/**
 * The history as loaded, without the jobs dismissed from it, its counts lowered by as many: what the server now says,
 * without reading every loaded page again. The pages keep their cursors (a page asked after a job that is gone still
 * starts where it did), and a page none of them was on is the same object (its rows are not drawn again).
 */
export function withoutJobs(pages: HistoryPage[], ids: readonly string[]): HistoryPage[] {
  const gone = new Set(ids);
  const dropped = pages.flatMap((p) => p.items.filter((j) => gone.has(j.id)));
  if (!dropped.length) return pages;
  const less = (counts: HistoryPage["counts"]) => {
    const out = { ...counts };
    for (const j of dropped) if (j.status === "done" || j.status === "failed" || j.status === "cancelled") out[j.status] = Math.max(0, out[j.status] - 1);
    return out;
  };
  // the counts the list says are the first page's (as readHistoryHead keeps them)
  return pages.map((p, i) => (i === 0 ? { ...p, items: p.items.filter((j) => !gone.has(j.id)), counts: less(p.counts) } : p.items.some((j) => gone.has(j.id)) ? { ...p, items: p.items.filter((j) => !gone.has(j.id)) } : p));
}
