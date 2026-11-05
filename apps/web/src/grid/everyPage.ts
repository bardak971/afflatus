import { useEffect, useRef } from "react";
import { useSayFailed, type FailedWhere } from "../sayFailed";

/** How many times a page that failed is asked for again, the first after `PAGE_WAIT_MS`, each next after twice the last. */
const PAGE_TRIES = 3;
const PAGE_WAIT_MS = 2_000;

/** What useEveryPage reads of an infinite query. */
interface Pages {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isFetchNextPageError: boolean;
  error: unknown;
  /** When the last failure was: one failure after another leaves the flags above as they were. */
  errorUpdatedAt: number;
  fetchNextPage(): Promise<unknown>;
}

/**
 * Every page of an infinite query read, one after the other (the grid board's items, card #299). A page that failed is
 * asked for again a few times, each after a longer wait, then said once with `title`: asked again at once, a board over a
 * server that is down asked without end, a failed page leaving `hasNextPage` true (card #325). A page read since starts
 * the count again. `waitMs`: the first wait, for the tests.
 */
export function useEveryPage(list: Pages, where: FailedWhere, title: string, waitMs = PAGE_WAIT_MS): void {
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, errorUpdatedAt, fetchNextPage } = list;
  const tries = useRef(0);
  const sayFailed = useSayFailed(where);
  // read when it is said, not a reason to start the wait again: the board draws again at every queue event
  const failed = useRef(() => {});
  failed.current = () => sayFailed(title)(list.error);
  useEffect(() => {
    if (!hasNextPage || isFetchingNextPage) return;
    if (!isFetchNextPageError) {
      tries.current = 0;
      void fetchNextPage();
      return;
    }
    if (tries.current === PAGE_TRIES) {
      tries.current++;
      failed.current();
    }
    if (tries.current > PAGE_TRIES) return;
    const wait = setTimeout(() => {
      tries.current++;
      void fetchNextPage();
    }, waitMs * 2 ** tries.current);
    return () => clearTimeout(wait);
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, errorUpdatedAt, fetchNextPage, waitMs]);
}
