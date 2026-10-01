import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { compose, lookSchema, withMood } from "./entities";
import { assetView } from "./media";
import { UserError } from "./queue";
import type { Services } from "./services";
import { FROM_PREVIOUS } from "./timelines";

const timelinePatch = z.strictObject({
  name: z.string().max(200).optional(),
  /** The frame every clip is made to fit; null for both = the first clip rendered decides. */
  width: z.number().int().min(64).max(4096).nullable().optional(),
  height: z.number().int().min(64).max(4096).nullable().optional(),
  /** The sound under the whole video. `asset: null` removes it. */
  music: z
    .strictObject({
      asset: z.string().nullable().optional(),
      volume: z.number().min(0).max(100).optional(),
      fadeInMs: z.number().min(0).optional(),
      fadeOutMs: z.number().min(0).optional(),
      duck: z.boolean().optional(),
    })
    .optional(),
  /** Who is in the video and how it looks, for every clip that has no cast of its own. */
  look: lookSchema.nullable().optional(),
  /** The look and mood of the whole video, in words: added to what happens in every clip. */
  mood: z.string().max(2000).optional(),
});

const newClip = z.strictObject({
  /** The clip it goes after; null = first; left out = last. */
  after: z.string().nullable().optional(),
  /** A video or a picture from the library to start from. */
  asset: z.string().optional(),
  recipe: z.string().optional(),
  /** A picture: held on screen ("still", the usual), or the opening picture of a clip to render ("clip"). */
  as: z.enum(["still", "clip"]).optional(),
});

const clipPatch = z.strictObject({
  recipe: z.string().optional(),
  inputs: z.record(z.string(), z.unknown()).optional(),
  joined: z.enum(["continue", "cut"]).optional(),
  take: z.string().optional(),
  trimStartMs: z.number().min(0).optional(),
  trimEndMs: z.number().min(0).optional(),
  after: z.string().nullable().optional(),
  sound: z.enum(["own", "muted", "file"]).optional(),
  soundAsset: z.string().nullable().optional(),
  volume: z.number().min(0).max(100).optional(),
  fill: z.boolean().optional(),
  stillMs: z.number().min(0).optional(),
  animate: z.boolean().optional(),
  look: lookSchema.nullable().optional(),
  chat: z.array(z.unknown()).max(200).optional(),
});

const renderBody = z.strictObject({
  clips: z
    .array(z.strictObject({
      id: z.string(),
      /** The clip's whole form, as the composer would send it. */
      input: z.record(z.string(), z.unknown()),
      /** End where the next clip begins, when that clip carries on from this one. On unless said otherwise. */
      fit: z.boolean().optional(),
    }))
    .min(1)
    .max(100),
});

const exportBody = z.strictObject({
  /** Enlarge every frame at the end. Nothing is rendered again. */
  scale: z.union([z.literal(1), z.literal(1.5), z.literal(2)]).default(1),
  music: z.boolean().default(true),
  /** Smooth motion: 48 pictures a second, worked out from the pictures there are. Slow. */
  smooth: z.boolean().default(false),
});

export function registerTimelines(app: FastifyInstance, s: Services): void {
  const t = s.timelines;

  app.get("/api/timelines", async () => t.list());
  app.post("/api/timelines", async (req) => t.create(z.strictObject({ name: z.string().max(200).optional() }).parse(req.body ?? {}).name));
  app.get<{ Params: { id: string } }>("/api/timelines/:id", async (req) => t.view(req.params.id));
  app.patch<{ Params: { id: string } }>("/api/timelines/:id", async (req) => t.edit(req.params.id, timelinePatch.parse(req.body)));
  app.delete<{ Params: { id: string } }>("/api/timelines/:id", async (req) => {
    await t.remove(req.params.id);
    return { ok: true };
  });
  /** Take the last change to the timeline back. Answers with what was undone, in a few words. */
  app.post<{ Params: { id: string } }>("/api/timelines/:id/undo", async (req) => ({ undone: await t.undo(req.params.id) }));

  app.post<{ Params: { id: string } }>("/api/timelines/:id/clips", async (req) => {
    const clip = await t.addClip(req.params.id, newClip.parse(req.body ?? {}));
    return { clip, timeline: await t.view(req.params.id) };
  });
  app.patch<{ Params: { id: string } }>("/api/clips/:id", async (req) => {
    await t.editClip(req.params.id, clipPatch.parse(req.body));
    return { ok: true };
  });
  app.delete<{ Params: { id: string } }>("/api/clips/:id", async (req) => {
    await t.removeClip(req.params.id);
    return { ok: true };
  });
  app.delete<{ Params: { id: string } }>("/api/takes/:id", async (req) => {
    await t.removeTake(req.params.id);
    return { ok: true };
  });

  /**
   * Render clips of a timeline, in the order they play. A clip that carries on from the one before it
   * waits for that one when it is being rendered too: it picks up from the take that comes out.
   */
  app.post<{ Params: { id: string } }>("/api/timelines/:id/render", async (req) => {
    const body = renderBody.parse(req.body);
    const view = await t.view(req.params.id);
    const wanted = new Map(body.clips.map((c) => [c.id, c]));
    const ids: string[] = [];
    /** The job a clip's next take will come out of: one queued here, or one that was already on its way. */
    const pending = new Map<string, string>();
    for (const c of view.clips) if (c.job) pending.set(c.id, c.job.id);
    for (const [i, clip] of view.clips.entries()) {
      const ask = wanted.get(clip.id);
      if (!ask) continue;
      const recipe = clip.recipe ? s.registry.recipe(clip.recipe) : undefined;
      if (!recipe) throw new UserError(clip.kind === "still" ? `Clip ${i + 1} is a picture: there is nothing to render.` : `Clip ${i + 1} is a video you added: there is nothing to render it with.`);
      // what a timeline fills in itself is not the form's to say
      const own = new Set(recipe.inputs.filter((x) => x.type !== "clip").map((x) => x.id));
      // the cast and the style: the clip's own, else the timeline's, worked into its form
      const typed = Object.fromEntries(Object.entries(ask.input).filter(([k]) => own.has(k)));
      const input = withMood(recipe, (await compose(s.db, recipe, typed, clip.look ?? view.look)).input, view.mood);
      const before = view.clips[i - 1];
      // a recipe that picks up from the last frame of the clip before: that frame is its opening picture, taken when the job starts
      const opening = recipe.inputs.find((x) => x.type === "image" && x.role === "start");
      if (opening && !input[opening.id] && before && clip.joined === "continue" && (recipe.traits?.continues === "frame" || before.kind === "still")) input[opening.id] = FROM_PREVIOUS;
      const next = view.clips[i + 1];
      const id = await s.queue.enqueue(recipe.id, input, {
        label: `${view.name} · clip ${i + 1}`,
        dependsOn: before && clip.joined === "continue" ? pending.get(before.id) : undefined,
        // a clip rendered together with the one after it has nothing to fit: that one is made to follow it
        clip: { id: clip.id, fit: ask.fit ?? !(next && wanted.has(next.id)) },
      });
      pending.set(clip.id, id);
      ids.push(id);
    }
    if (!ids.length) throw new UserError("None of these clips are on this timeline.");
    s.queue.events.emit("timeline");
    return { ids };
  });

  /**
   * A scene written as several clips (by the designer): one new clip for each, at the end, each flowing
   * on from the one before, with its text in its form. Nothing is rendered.
   */
  app.post<{ Params: { id: string } }>("/api/timelines/:id/plan", async (req) => {
    const b = z.strictObject({ recipe: z.string().min(1), clips: z.array(z.record(z.string(), z.string())).min(1).max(12) }).parse(req.body);
    if (!s.registry.recipe(b.recipe)) throw new UserError(`there is no recipe called ${b.recipe}`);
    const made: string[] = [];
    for (const text of b.clips) {
      const id = await t.addClip(req.params.id, { recipe: b.recipe });
      const now = (await t.view(req.params.id)).clips.find((c) => c.id === id)!;
      await t.editClip(id, { inputs: { ...now.inputs, ...text } });
      made.push(id);
    }
    return { clips: made, timeline: await t.view(req.params.id) };
  });

  /** Export the timeline as one video. It runs in the queue, after the renders that are already waiting. */
  app.post<{ Params: { id: string } }>("/api/timelines/:id/export", async (req) => {
    const opts = exportBody.parse(req.body ?? {});
    const view = await t.view(req.params.id);
    if (!view.durationMs) throw new UserError("There is nothing to export yet: no clip of this timeline has a take.");
    if (view.exporting) return { id: view.exporting.id };
    return { id: await s.queue.enqueueExport({ timeline: view.id, scale: opts.scale, music: opts.music, smooth: opts.smooth }, `${view.name} · export`) };
  });

  /** Frames of a video side by side in one picture: what a clip shows on the timeline. */
  app.get<{ Params: { id: string } }>("/api/assets/:id/strip", async (req, reply) =>
    reply.header("Content-Type", "image/jpeg").header("Cache-Control", "private, max-age=31536000, immutable").send(Buffer.from(await t.strip(req.params.id))),
  );

  /** One frame of a video, as a picture in the library: to open another clip on, or to keep. */
  app.post<{ Params: { id: string } }>("/api/assets/:id/frame", async (req) => {
    const { atMs } = z.strictObject({ atMs: z.number().min(0) }).parse(req.body);
    const video = await s.db.selectFrom("assets").selectAll().where("id", "=", req.params.id).executeTakeFirst();
    if (!video || video.kind !== "video") throw Object.assign(new Error("this video was not found"), { statusCode: 404 });
    return assetView(await t.frame(video, atMs));
  });
}
