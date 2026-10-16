import { ApiError } from "./api";
import { useBanners, type Banner } from "./store";

/** Where a failed action is said to be done, for its banner's way back: the library unless told. */
export interface FailedWhere {
  id?: string;
  href?: string;
  go?: string;
  /** A 409 (the server naming what still uses the thing) is titled "Still in use". */
  inUse?: boolean;
  /** The banner takes the place of the last one of its `id` rather than adding one more (a failure that can repeat, as each edit of a draft). */
  once?: boolean;
}

/** The banner of a failed action: its title, the error's own words, the way to where it is done. */
export function failedBanner({ id = "failed", href = "/", go = "Open the library", inUse = false, once = false }: FailedWhere, title: string, err: unknown, at = Date.now()): Banner {
  return {
    id: once ? id : `${id}:${at}`,
    tone: "bad",
    title: inUse && err instanceof ApiError && err.status === 409 ? "Still in use" : title,
    text: err instanceof Error ? err.message : String(err),
    href,
    go,
  };
}

/**
 * A banner for an action that failed (failedBanner). A file of its own, light: the menus, the command bar, the Queue
 * and the Projects panel use it.
 */
export function useSayFailed(where: FailedWhere = {}) {
  const say = useBanners((b) => b.push);
  return (title: string) => (err: unknown) => say(failedBanner(where, title, err));
}

/**
 * The latest of a place's actions that failed, not the first of its list: an old error does not hide a newer one. `since`:
 * what was asked before it is not said (a viewer stepped on to another item, which an error of the one before is not about).
 * With when it was asked, `at`, for a place to weigh it against other actions of its own.
 */
export function latestFailure(actions: ReadonlyArray<{ error: Error | null; submittedAt: number }>, since = -1): { error: Error | null; at: number } {
  return actions
    .filter((x) => x.error && x.submittedAt >= since)
    .reduce<{ error: Error | null; at: number }>((last, x) => (x.submittedAt >= last.at ? { error: x.error, at: x.submittedAt } : last), { error: null, at: -1 });
}
