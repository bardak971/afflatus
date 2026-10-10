import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Services } from "./services";

/**
 * What the timeline editor measures for each of its clips, asked for many at once: the motion and loudness of each
 * take's video, and how smoothly each clip's takes meet their neighbours. One request per clip was forty and more on
 * opening a long timeline; over HTTP/1.1's six connections a slow one (a join measured by ffmpeg takes seconds) held
 * a socket the player's reads of the videos were waiting for. Each item is worked out here a few at a time, as the
 * routes for one would, and one that fails is null in the answer rather than failing the others.
 */

/** How many are measured side by side: a video's motion is one ffmpeg; a clip's joins run three takes at a time of their own. */
const MOTIONS_AT_ONCE = 4;
const JOINS_AT_ONCE = 2;
/** The most a request asks for: a timeline's clips, with room to spare. */
const MOST = 200;

const ids = z.strictObject({ ids: z.array(z.string().min(1).max(64)).max(MOST) });

/** `work` for each id, `most` at a time; what one throws is null, the others go on. */
export async function eachAtMost<R>(keys: string[], most: number, work: (id: string) => Promise<R>): Promise<Record<string, R | null>> {
  const out: Record<string, R | null> = {};
  const todo = [...new Set(keys)];
  let next = 0;
  const lane = async () => {
    while (next < todo.length) {
      const id = todo[next++]!;
      out[id] = await work(id).catch(() => null);
    }
  };
  await Promise.all(Array.from({ length: Math.min(most, todo.length) }, lane));
  return out;
}

export function registerMeasures(app: FastifyInstance, s: Services): void {
  const media = s.timelines.media;
  /** The motion and loudness of several videos or sounds, by id (null: not one, or not readable). */
  app.post("/api/measures/motion", async (req) => ({ items: await eachAtMost(ids.parse(req.body).ids, MOTIONS_AT_ONCE, (id) => media.motion(id)) }));
  /** How smoothly each take of several clips meets its neighbours, by clip (null: no such clip, or not measured). */
  app.post("/api/measures/joins", async (req) => ({ items: await eachAtMost(ids.parse(req.body).ids, JOINS_AT_ONCE, (id) => media.joins(id)) }));
}
