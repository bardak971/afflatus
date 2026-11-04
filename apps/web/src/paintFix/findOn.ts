import { api } from "../api";
import type { Find } from "../stageLayer/useFindTools";

/** How often a find job is asked where it stands: it runs ahead of the renders, in a second or two. */
const POLL_MS = 300;

/**
 * The layer's find (click to mask C, the detectors D) over the server's find-mask routes, for one picture: the job queued,
 * then asked until it ends; its masks in the layer's shape. A failed or stopped job throws its reason, which the layer's
 * strip says.
 */
export function findOn(picture: string): Find {
  return async (req) => {
    const { job } = await api.findMask(picture, req);
    for (;;) {
      const at = await api.foundMasks(picture, job);
      if (at.status === "failed" || at.status === "cancelled") throw new Error(at.error ?? `The search was ${at.status}.`);
      if (at.status === "done") return at.masks.map((m) => ({ asset: m.asset.id, box: { x: m.box.x, y: m.box.y, w: m.box.width, h: m.box.height } }));
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  };
}
