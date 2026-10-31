import { ApiError } from "./api";
import { useBanners, type Banner } from "./store";

/**
 * Where a failed action is said to be done, for its banner's way there: always named (card #177: a banner left without
 * one offered "Open the library" for a download or ComfyUI that would not open). `href` and `go`, the place and its link's
 * words ("Open Settings › Models"); or `here`, when what it is about is on screen already, and the banner leads nowhere.
 */
export type FailedWhere = {
  id?: string;
  /** A 409 (the server naming what still uses the thing) is titled "Still in use". */
  inUse?: boolean;
  /** The banner takes the place of the last one of its `id` rather than adding one more (a failure that can repeat, as each edit of a draft). */
  once?: boolean;
} & ({ href: string; go: string; here?: never } | { here: true; href?: never; go?: never });

/** The banner of a failed action: its title, the error's own words, the way to where it is done. */
export function failedBanner(where: FailedWhere, title: string, err: unknown, at = Date.now()): Banner {
  const { id = "failed", inUse = false, once = false } = where;
  return {
    id: once ? id : `${id}:${at}`,
    tone: "bad",
    title: inUse && err instanceof ApiError && err.status === 409 ? "Still in use" : title,
    text: err instanceof Error ? err.message : String(err),
    ...(where.here ? {} : { href: where.href, go: where.go }),
  };
}

/**
 * A banner for an action that failed (failedBanner). A file of its own, light: the menus, the command bar, the Queue
 * and the Projects panel use it.
 */
export function useSayFailed(where: FailedWhere) {
  const say = useBanners((b) => b.push);
  return (title: string) => (err: unknown) => say(failedBanner(where, title, err));
}

/**
 * The latest of a place's actions that failed, not the first of its list: an old error does not hide a newer one. `since`:
 * what was asked before it is not said (a viewer stepped on to another item, which an error of the one before is not about).
 * With when it was asked, `at`, for a place to weigh it against other actions of its own; and, when the actions were given
 * as `[what, action]` pairs, what did not happen ("Frame not saved"), for <Failed what>.
 */
export function latestFailure(actions: ReadonlyArray<Failing | readonly [string, Failing]>, since = -1): { error: Error | null; at: number; what: string } {
  return actions
    .map((x) => (Array.isArray(x) ? { what: x[0] as string, ...(x[1] as Failing) } : { what: "Not done", ...(x as Failing) }))
    .filter((x) => x.error && x.submittedAt >= since)
    .reduce<{ error: Error | null; at: number; what: string }>((last, x) => (x.submittedAt >= last.at ? { error: x.error, at: x.submittedAt, what: x.what } : last), { error: null, at: -1, what: "" });
}
type Failing = { error: Error | null; submittedAt: number };

/**
 * The newest of a place's actions that failed, with what did not happen ("Not checked"), for <Failed what>: one error line
 * under several buttons names the one that failed rather than showing its words alone (card #177). The newest, as
 * latestFailure: "Bin idle takes" failed, then "Keep what is in the bin" failed, says the second, not the first's old error.
 * When (a mutation's `submittedAt`, a query's `errorUpdatedAt`); one with neither comes first, as its list has them.
 */
export function firstFailed(actions: ReadonlyArray<readonly [string, { isError: boolean; error: unknown; submittedAt?: number; errorUpdatedAt?: number }]>): { what: string; error: unknown } | undefined {
  const when = (x: { submittedAt?: number; errorUpdatedAt?: number }) => x.submittedAt ?? x.errorUpdatedAt ?? 0;
  const hit = actions.filter(([, x]) => x.isError).reduce<(typeof actions)[number] | undefined>((last, a) => (!last || when(a[1]) > when(last[1]) ? a : last), undefined);
  return hit && { what: hit[0], error: hit[1].error };
}
