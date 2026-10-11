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
