import type { HistoryPage } from "../../api";

/**
 * The history as loaded, with its first page read again worked in: the jobs that are new go in front of the first page,
 * the ones it already holds take their fresh state where they are, and the counts are the fresh ones. The pages after
 * it are kept as they are: the next page is asked from where the list now ends, which is where it was plus the new
 * jobs, so nothing is skipped or read twice. Null when the fresh page holds nothing already loaded (more ended than a
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
