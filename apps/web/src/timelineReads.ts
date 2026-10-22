import { hashKey, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { isUnder, queryKeys } from "./queryKeys";

/**
 * The timelines read again after a change, at most once for each change. A timeline's whole view is large (507 KB at 150
 * clips, ~15 ms for the server to build), and every edit used to read it twice: the edit's own read back, and the read of
 * the "timeline" event the server sends within the edit, which cancelled the first (the server built both all the same).
 * A clip's render that ended read it twice too: the "timeline" event, and the job's end seen in the queue.
 *
 * So a read that was sent after the change was heard of stands for it: the server built its answer after the change. Each
 * timeline query's last read is written down as it is sent (`readSent`, from its queryFn), and the reads of the events wait
 * a moment (WAIT_MS) and are gathered: an edit's own read back, sent meanwhile, then stands for its event, and a job's end
 * and its event make one read.
 */

/** When the latest read of each timeline query (a timeline, a list of them) was sent, by its key's hash (performance.now()). */
const sent = new Map<string, number>();

/** A read of a timeline query is sent now (its queryFn). */
export function readSent(key: QueryKey, at = performance.now()): void {
  sent.set(hashKey(key), at);
}

/** How long a change's read waits for another to stand for it, and how often the timelines are read again at most. */
export const WAIT_MS = 300;
export const EVERY_MS = 1000;

/**
 * What hears the changes: each call says a timeline may have changed (`tree`: the Projects panel's tree too, its clips and
 * sizes). The timeline queries are read again once, WAIT_MS after the first change of a run (and EVERY_MS after the last
 * read at least), but for those whose read was sent after the last change heard.
 */
export function timelineReader(client: QueryClient, now: () => number = () => performance.now()): { (o?: { tree?: boolean }): void; cancel(): void } {
  let since = -Infinity;
  let tree = false;
  let last = -Infinity;
  let wait: ReturnType<typeof setTimeout> | null = null;
  const run = () => {
    wait = null;
    last = now();
    const at = since;
    const withTree = tree;
    since = -Infinity;
    tree = false;
    void client.invalidateQueries({ predicate: (q) => isUnder(q.queryKey, queryKeys.timelines.all()) && !((sent.get(q.queryHash) ?? -Infinity) >= at), refetchType: "active" });
    if (withTree) void client.invalidateQueries({ queryKey: queryKeys.projects.trees(), refetchType: "active" });
  };
  const heard = (o: { tree?: boolean } = {}) => {
    since = now();
    tree ||= Boolean(o.tree);
    wait ??= setTimeout(run, Math.max(WAIT_MS, EVERY_MS - (now() - last)));
  };
  heard.cancel = () => {
    if (wait) clearTimeout(wait);
    wait = null;
  };
  return heard;
}
