import { api } from "../api";

/** How many of a moment's requests are under way together. */
const AT_ONCE = 3;

/**
 * Many asks for one kind of thing, sent as few requests: what is asked for in the same moment (a timeline's clips, as
 * the editor opens) goes together, `most` at a time, AT_ONCE requests under way: not one per clip (the player's reads
 * of the videos need connections too), and not one after the other either, which left the server's ffmpeg pool half
 * idle. Each ask still gets its own answer, so a query per item keeps its cache, and what is asked for alone (one clip's
 * facts) is a request of one. An item the answer has no value for fails on its own; a request that fails fails its items.
 */
export function batched<T>(send: (ids: string[]) => Promise<Record<string, T | null>>, most = 8): (id: string) => Promise<T> {
  type Waiter = { ok(v: T): void; no(e: Error): void };
  let waiting = new Map<string, Waiter[]>();
  let soon = false;
  const sendPart = async (part: string[], asked: Map<string, Waiter[]>) => {
    try {
      const got = await send(part);
      for (const id of part) {
        const v = got[id];
        for (const w of asked.get(id)!) {
          if (v === null || v === undefined) w.no(new Error("This could not be measured."));
          else w.ok(v);
        }
      }
    } catch (err) {
      for (const id of part) for (const w of asked.get(id)!) w.no(err as Error);
    }
  };
  const flush = async () => {
    soon = false;
    const asked = waiting;
    waiting = new Map();
    const ids = [...asked.keys()];
    const parts: string[][] = [];
    for (let i = 0; i < ids.length; i += most) parts.push(ids.slice(i, i + most));
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(AT_ONCE, parts.length) }, async () => {
      while (next < parts.length) await sendPart(parts[next++]!, asked);
    }));
  };
  return (id) =>
    new Promise<T>((ok, no) => {
      const list = waiting.get(id) ?? [];
      list.push({ ok, no });
      waiting.set(id, list);
      // what is asked for while this task runs goes with it: the queries of one draw are started in one task
      if (!soon) {
        soon = true;
        setTimeout(() => void flush(), 0);
      }
    });
}

/** The motion and loudness of a video or a sound (api.motion), asked for with the others of the same moment. */
export const motionOf = batched((ids) => api.motions(ids).then((r) => r.items));
/** How smoothly each take of a clip meets its neighbours (api.joins), asked for with the others of the same moment. */
export const joinsOf = batched((ids) => api.joinsOf(ids).then((r) => r.items));
