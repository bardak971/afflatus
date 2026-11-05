import { api } from "../api";
import type { Find } from "../stageLayer/useFindTools";

/** How often a find job is asked where it stands: it runs ahead of the renders, in a second or two. */
const POLL_MS = 300;

/**
 * How long a find is waited for at most: the first may fetch SAM 3 on a pod, which takes minutes; past it the queue is
 * paused or ComfyUI is down, and asking three times a second for nothing is only load.
 */
const FIND_DEADLINE_MS = 10 * 60_000;

/** What a find given up says: the layer drops an answer nobody waits for, and says any other. */
const given = (why: string) => Object.assign(new Error(why), { name: "AbortError" });

/**
 * The layer's find (click to mask C, the detectors D) over the server's find-mask routes, for one picture: the job queued,
 * then asked until it ends; its masks in the layer's shape. A failed or stopped job throws its reason, which the layer's
 * strip says. One given up (`signal`: a newer click, the tool put down, Paint and fix closed) or past its deadline is
 * cancelled as well: a SAM job nobody waits for would still run on the GPU (a rented one is billed), ahead of the renders.
 */
export function findOn(picture: string, deadline = FIND_DEADLINE_MS): Find {
  return async (req, signal) => {
    const { job } = await api.findMask(picture, req);
    const cancel = () => void api.cancel(job).catch(() => {});
    const until = Date.now() + deadline;
    try {
      for (;;) {
        if (signal?.aborted) throw given("The search was given up.");
        if (Date.now() > until) throw new Error("The search took too long: the queue may be paused, or ComfyUI not answering.");
        const at = await api.foundMasks(picture, job, { signal });
        if (at.status === "failed" || at.status === "cancelled") throw new Error(at.error ?? `The search was ${at.status}.`);
        if (at.status === "done") return at.masks.map((m) => ({ asset: m.asset.id, box: { x: m.box.x, y: m.box.y, w: m.box.width, h: m.box.height } }));
        await new Promise<void>((done) => {
          const t = setTimeout(done, POLL_MS);
          signal?.addEventListener("abort", () => (clearTimeout(t), done()), { once: true });
        });
      }
    } catch (err) {
      // still waiting when it was given up: the job goes too (one that ended has nothing left to cancel)
      if (signal?.aborted || Date.now() > until) cancel();
      throw err;
    }
  };
}
