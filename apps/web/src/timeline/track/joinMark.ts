import { cutsAtJoin } from "@afflatus/core";
import type { Clip } from "../../api";

/**
 * What the circle between two clips shows: a join that no longer holds (stale), a seamless join whose take cut to another
 * shot where its run-up ends (cuts: card #161, Timeline 17's circle said seamless over a cut), a seamless join that holds
 * (fresh) or is still to render (planned), or a plain cut.
 */
export type JoinMark = "stale" | "cuts" | "fresh" | "planned" | "cut";

export function joinMarkOf(c: Pick<Clip, "join" | "take">, carries: boolean): JoinMark {
  if (c.join === "stale") return "stale";
  if (!carries) return "cut";
  if (c.join !== "fresh") return "planned";
  return cutsAtJoin(c.take?.measure) ? "cuts" : "fresh";
}
