import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { RANDOM_SEED, hiddenRunUp, movedSeed, resamplesLatent, typedSeed } from "@afflatus/core";
import { nameOf } from "./autoName";
import { VERSION } from "./config";
import { CutError, musicTrack } from "./cut";
import { httpError } from "./errors";
import { compose, lookSchema, withMood } from "./entities";
import { askedOf } from "./jobs-api";
import { assetView } from "./media";
import { rifeModelIn } from "./queue";
import { inARow } from "./forecast";
import { finishForecast } from "./queueTools";
import { rootFolderOf } from "./projects";
import { inUse } from "./sweep";
import { folderOfTimeline } from "./timelineFolder";
import { fcp7Xml, otioJson, projectPlan, projectReadme } from "./timelineProject";
import { ZipStream } from "./zipStream";
import type { Services } from "./services";
import { clockOf, FROM_PREVIOUS, type CutOptions, type Timelines } from "./timelines";

/** What PATCH /api/timelines/:id takes (the web's TimelinePatch is held to it in test/apiTypes.test.ts). */
export const timelinePatch = z.strictObject({
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
      duckDb: z.number().min(3).max(30).optional(),
      /** Where in the song it plays from, and the clip it starts with (null: the first). */
      fromMs: z.number().min(0).optional(),
      startClip: z.string().nullable().optional(),
    })
    .optional(),
  /** Who is in the video and how it looks, for every clip that has no cast of its own. */
  look: lookSchema.nullable().optional(),
  /** The look and mood of the whole video, in words: added to what happens in every clip. */
  mood: z.string().max(2000).optional(),
  /** The project it belongs to (null: the Inbox), and the folder its renders land in (null: the project's root). */
  project: z.string().nullable().optional(),
  folder: z.string().nullable().optional(),
});

const newClip = z.strictObject({
  /** The clip it goes after; null = first; left out = last. */
  after: z.string().nullable().optional(),
  /** A video or a picture from the library to start from. */
  asset: z.string().optional(),
  recipe: z.string().optional(),
  /** A picture: held on screen ("still", the usual), or the opening picture of a clip to render ("clip"). */
  as: z.enum(["still", "clip"]).optional(),
  /** The clip it goes after first stops being seen at this moment of its video (as its take's startMs and endMs say), in the same step. */
  stopAtMs: z.number().min(0).optional(),
});

/** What PATCH /api/clips/:id takes (the web's ClipPatch is held to it in test/apiTypes.test.ts). */
export const clipPatch = z.strictObject({
  recipe: z.string().optional(),
  inputs: z.record(z.string(), z.unknown()).optional(),
  joined: z.enum(["continue", "cut"]).optional(),
  take: z.string().optional(),
  trimStartMs: z.number().min(0).optional(),
  trimEndMs: z.number().min(0).optional(),
  /** Trimmed to what is to be seen, in its video's own time: worked out into trims by the server (see trimsOf). */
  shownFromMs: z.number().min(0).optional(),
  shownToMs: z.number().min(0).optional(),
  after: z.string().nullable().optional(),
  sound: z.enum(["own", "muted", "file"]).optional(),
  soundAsset: z.string().nullable().optional(),
  volume: z.number().min(0).max(100).optional(),
  fill: z.boolean().optional(),
  fitNext: z.boolean().optional(),
  /** Its pinned pictures flipped left to right at render time (Mirror), by input id: true flips one, false turns it back. */
  pinMirror: z.record(z.string().max(64), z.boolean()).refine((m) => Object.keys(m).length <= 8, "at most 8 pinned frames").optional(),
  stillMs: z.number().min(0).optional(),
  animate: z.boolean().optional(),
  look: lookSchema.nullable().optional(),
  chat: z.array(z.unknown()).max(200).optional(),
  designer: z.strictObject({ llm: z.string().max(40).optional(), instruction: z.string().max(40).optional() }).nullable().optional(),
  /** What it asks of the music under it; null = as the rest of the video. */
  music: z
    .strictObject({
      volume: z.number().min(0).max(150).optional(),
      duck: z.enum(["off", "strong"]).optional(),
      fadeIn: z.boolean().optional(),
      fadeOut: z.boolean().optional(),
      muted: z.boolean().optional(),
    })
    .nullable()
    .optional(),
});

const renderBody = z.strictObject({
  clips: z
    .array(z.strictObject({
      id: z.string(),
      /** The clip's whole form, as the composer would send it. */
      input: z.record(z.string(), z.unknown()),
      /** How many takes at once: the first with the form's seed, the others with a fresh one each (or the next ones up or down, with a seed mode). */
      takes: z.number().int().min(1).max(4).optional(),
      /** A typed seed that moves: each take after the first takes the next seed up or down (the form's "+1" / "−1"). */
      seedMode: z.enum(["up", "down"]).optional(),
      /** End where the next clip begins, when that clip carries on from this one. Left out: the clip's own choice (fitNext). */
      fit: z.boolean().optional(),
    }))
    .min(1)
    .max(100),
});

/** What the timeline for a video editor is asked with: the music (on unless "0"), and a range from In to Out. */
const projectQuery = z.strictObject({
  music: z.enum(["0", "1"]).optional(),
  in: z.coerce.number().min(0).optional(),
  out: z.coerce.number().min(0).optional(),
});

const exportBody = z.strictObject({
  /** Enlarge every frame at the end. Nothing is rendered again. */
  scale: z.union([z.literal(1), z.literal(1.5), z.literal(2)]).default(1),
  /** "largest": at the size of the largest take (the finished ones). */
  fit: z.enum(["timeline", "largest"]).default("timeline"),
  music: z.boolean().default(true),
  /** Smooth motion: 48 pictures a second, worked out from the pictures there are. Slow. */
  smooth: z.boolean().default(false),
  /** Only this part of the timeline (In and Out, on its clock). The music is left out. */
  range: z.object({ inMs: z.number().min(0), outMs: z.number().min(0) }).optional(),
  /** Crossfade a clip that extends the one before over the frames they share. */
  blend: z.boolean().default(true),
  /** Nudge each clip's brightness and tint to the clip before at the join. */
  match: z.boolean().default(true),
  /** A copy for the web, under this many megabytes (10: what GitHub plays inline on a free account; 25: chats and posts). */
  webMb: z.union([z.literal(10), z.literal(25)]).optional(),
});

/** How the clips are finished: the route, how much larger, its settings; `redo` finishes again the clips finished already. */
const finishBody = z.strictObject({
  route: z.enum(["seedvr", "latent", "rtx", "model"]), factor: z.number().min(1).max(4), colour: z.enum(["lab", "wavelet", "adain", "none"]).optional(), upscaleModel: z.string().max(200).optional(), seedvrFrames: z.number().int().min(0).max(49).optional(),
  sharpen: z.number().min(0).max(1).optional(), latentDenoise: z.number().min(0.05).max(0.6).optional(), latentSteps: z.number().int().min(1).max(6).optional(), redo: z.boolean().default(false), clips: z.array(z.string()).optional(),
});

/** How a slow-motion job makes its frames: RIFE on the GPU when this ComfyUI is up and has it, else ffmpeg on the processor. */
async function slowEngine(s: Services): Promise<"rife" | "ffmpeg"> {
  try {
    const comfy = await s.comfy();
    const catalog = await comfy.catalog();
    const nodes = ["LoadVideo", "GetVideoComponents", "FrameInterpolationModelLoader", "FrameInterpolate", "VHS_VideoCombine"];
    return nodes.every((n) => n in catalog) && rifeModelIn(catalog as Record<string, unknown>) ? "rife" : "ffmpeg";
  } catch {
    return "ffmpeg";
  }
}

export function registerTimelines(app: FastifyInstance, s: Services): void {
  const t = s.timelines;

  app.get("/api/timelines", async (req) => t.list(z.object({ project: z.string().optional() }).parse(req.query).project));
  app.post("/api/timelines", async (req) => {
    const body = z.strictObject({ name: z.string().max(200).optional(), project: z.string().nullable().optional() }).parse(req.body ?? {});
    // its renders land in the project's root folder unless another is chosen later
    return t.create(body.name, body.project ?? null, await rootFolderOf(s.db, body.project));
  });
  app.get<{ Params: { id: string } }>("/api/timelines/:id", async (req) => t.view(req.params.id));
  /** The music ducked under speech: its gain along the timeline (duck.ts), for the player; null when there is no music or it is not ducked. */
  app.get<{ Params: { id: string } }>("/api/timelines/:id/duck", async (req) => ({ curve: await t.duck(req.params.id) }));
  app.patch<{ Params: { id: string } }>("/api/timelines/:id", async (req) => t.edit(req.params.id, timelinePatch.parse(req.body)));
  app.delete<{ Params: { id: string } }>("/api/timelines/:id", async (req) => {
    await t.remove(req.params.id);
    return { ok: true };
  });
  /** Take the last change to the timeline back. Answers with what was undone, in a few words. */
  app.post<{ Params: { id: string } }>("/api/timelines/:id/undo", async (req) => ({ undone: await t.history.undo(req.params.id) }));
  app.post<{ Params: { id: string } }>("/api/timelines/:id/redo", async (req) => ({ redone: await t.history.redo(req.params.id) }));
  /** A copy of the clip right after it. */
  app.post<{ Params: { id: string } }>("/api/clips/:id/duplicate", async (req) => {
    const clip = await t.range.duplicateClip(req.params.id);
    s.queue.events.emit("timeline");
    return { clip };
  });

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
  /** The takes no clip plays and nothing else needs go, their videos to the bin (Timelines.binUnusedTakes). */
  app.post<{ Params: { id: string } }>("/api/timelines/:id/unused-takes/bin", async (req) => t.binUnusedTakes(req.params.id));

  /**
   * Render clips of a timeline, in the order they play. A clip that carries on from the one before it
   * waits for that one when it is being rendered too: it picks up from the take that comes out.
   */
  app.post<{ Params: { id: string } }>("/api/timelines/:id/render", async (req) => {
    const ids = await renderClips(s, req.params.id, renderBody.parse(req.body).clips);
    s.queue.events.emit("timeline");
    return { ids };
  });

  /**
   * A scene written as several clips (by the designer): one new clip for each, at the end, each flowing
   * on from the one before, with its text in its form. Nothing is rendered.
   */
  app.post<{ Params: { id: string } }>("/api/timelines/:id/plan", async (req) => {
    const b = z.strictObject({ recipe: z.string().min(1), clips: z.array(z.record(z.string(), z.string())).min(1).max(12) }).parse(req.body);
    // one step to undo, however many clips
    const made = await t.planner.planClips(req.params.id, b.recipe, b.clips);
    return { clips: made, timeline: await t.view(req.params.id) };
  });

  /** Export the timeline as one video. It runs in the queue, after the renders that are already waiting. */
  app.post<{ Params: { id: string } }>("/api/timelines/:id/export", async (req) => {
    const opts = exportBody.parse(req.body ?? {});
    // looked at and queued one request at a time: two tabs asking at once get the one export
    return t.history.oneAtATime(`export:${req.params.id}`, async () => {
      const view = await t.view(req.params.id);
      if (!view.durationMs) throw httpError("There is nothing to export yet: no clip of this timeline has a take.");
      if (view.exporting) return { id: view.exporting.id };
      return { id: await s.queue.enqueueExport({ timeline: view.id, scale: opts.scale, music: opts.music, smooth: opts.smooth, range: opts.range, blend: opts.blend, match: opts.match, fit: opts.fit, webMb: opts.webMb }, `${view.name} · ${opts.webMb ? "web copy" : "export"}`) };
    });
  });

  /**
   * The timeline for a video editor, as a download: a zip of its clips' files, the music as heard, and the project files
   * DaVinci Resolve, Premiere Pro and Kdenlive rebuild it from (timelineProject.ts). Nothing is rendered again: the files
   * are copied as they are, the music alone is mixed. Streamed, never held whole in memory.
   */
  app.get<{ Params: { id: string } }>("/api/timelines/:id/project.zip", async (req, reply) => {
    const q = projectQuery.parse(req.query);
    const range = q.in !== undefined && q.out !== undefined ? { inMs: q.in, outMs: q.out } : undefined;
    // what can be said before the download starts is said as an error (nothing to export, an empty range): after, only a stopped download
    // at the finished size: the takes as they are, a draft enlarged to it by the editor (the video export's Finished size)
    const layout = await t.exporter.layout(req.params.id, { music: q.music !== "0", range, fit: "largest" }).catch((err: Error) => {
      throw err instanceof CutError ? httpError(err.message) : err;
    });
    const plan = projectPlan(layout.t.name, { ...layout, music: Boolean(layout.music) });
    const music = layout.music ? await musicTrack(layout.music, layout.totalMs) : null;
    const zip = new ZipStream();
    const name = `${layout.t.name.replace(/[^\w .-]+/g, "_").trim() || "timeline"}${range ? " range" : ""} for an editor.zip`;
    reply.header("Content-Type", "application/zip").header("Content-Disposition", `attachment; filename="${name}"`).header("Cache-Control", "no-store");
    void (async () => {
      try {
        const text = async (path: string, body: string) => {
          const bytes = Buffer.from(body, "utf8");
          await zip.add(path, Readable.from([bytes]), new Date(), bytes.length);
        };
        await text("README.txt", projectReadme(plan, VERSION));
        await text("project.xml", fcp7Xml(plan));
        await text("project.otio", otioJson(plan));
        // each file once, however often it plays
        const files = new Map<string, string>();
        for (const i of plan.items) {
          files.set(i.file, i.key);
          if (i.soundFile) files.set(i.soundFile.file, i.soundFile.key);
        }
        for (const [path, key] of files) {
          if (req.raw.destroyed) break;
          const f = await s.storage.open(key);
          await zip.add(path, f.stream, new Date(), f.size);
        }
        if (music) await zip.add("media/music.wav", Readable.from([Buffer.from(music)]), new Date(), music.length);
        await zip.finish();
      } catch (err) {
        // the browser going away is the usual way out and no news; anything else is said, since the user only sees a download that stopped
        if (!req.raw.destroyed) console.warn(`[project] given up: ${(err as Error).message}`);
        zip.abort(err as Error);
      }
    })();
    return reply.send(zip.out);
  });

  /**
   * Finish: every clip's selected take brought to its final quality by an upscale route, as a new take
   * marked as the finished version of the draft (which stays in the list). SeedVR2, RTX and a pixel
   * model run on the take's video in a job each; H3's latent re-sample re-samples the draft's own kept
   * latent larger, its join decoded as one piece with the clip before's. Clips finished already are skipped unless `redo`.
   */
  app.post<{ Params: { id: string } }>("/api/timelines/:id/finish", async (req) => {
    const b = finishBody.parse(req.body);
    // looked at and queued one request at a time, as an export is: two quick Finish clicks queued two finishes of each clip
    const done = await t.history.oneAtATime(`finish:${req.params.id}`, () => finishClips(s, req.params.id, b));
    s.queue.events.emit("timeline");
    return done;
  });

  /** What Finish with these settings would take in all (finishForecast, queue.forecast for a latent re-sample); null when a job of it has no learned figure yet. */
  app.post<{ Params: { id: string } }>("/api/timelines/:id/finish/forecast", async (req) => ({ ms: await finishEstimate(s, req.params.id, finishBody.parse(req.body)) }));

  /** One clip becomes two at a moment of its take (the video's own time, as the take's startMs and endMs say): the first plays up to it, the second from it. */
  app.post<{ Params: { id: string } }>("/api/clips/:id/split", async (req) => {
    const { atMs } = z.strictObject({ atMs: z.number().min(0) }).parse(req.body);
    const clip = await t.range.splitClip(req.params.id, atMs);
    s.queue.events.emit("timeline");
    return { clip };
  });

  /**
   * The range between In and Out, on the timeline's clock. "split": the clips under In and Out each become
   * two there. "remove": what plays between them goes, the clips after close the gap. "regenerate": it is
   * replaced by a new clip to render, pinned to the frame before In and the frame at Out (In = Out on a
   * cut: a clip between the two); the clip comes back selected, not rendered. "loop": a new clip after Out
   * that returns to the frame at In, so the range plays round. "copy": that part of the timeline as one
   * video in the library, through the export queue.
   */
  app.post<{ Params: { id: string } }>("/api/timelines/:id/range", async (req) => {
    const body = z.strictObject({ inMs: z.number().min(0), outMs: z.number().min(0), action: z.enum(["split", "remove", "regenerate", "loop", "copy", "slow"]), scale: z.number().min(1).max(2).optional(), factor: z.union([z.literal(2), z.literal(4)]).optional() }).parse(req.body);
    const id = req.params.id;
    if (body.action === "slow") {
      // the parts become clips of their own; each slowed video arrives as the take of its clip
      const factor = body.factor ?? 2;
      const parts = await t.range.slowRangeOf(id, body.inMs, body.outMs, factor);
      const engine = await slowEngine(s);
      const view = await t.view(id);
      const jobs: string[] = [];
      for (const made of parts) {
        const index = view.clips.findIndex((c) => c.id === made.clip);
        jobs.push(await s.queue.enqueueCut({ asset: made.asset.id, startMs: made.startMs, endMs: made.endMs, action: "slow", factor, engine, clip: made.clip }, `${view.name} · clip ${index + 1} · slow ×${factor}`));
      }
      s.queue.events.emit("timeline");
      return { clips: parts.map((p) => p.clip), jobs, engine };
    }
    if (body.action === "split") await t.range.splitRange(id, body.inMs, body.outMs);
    else if (body.action === "remove") await t.range.removeRange(id, body.inMs, body.outMs);
    else if (body.action === "regenerate") {
      const made = await t.range.regenerateRange(id, body.inMs, body.outMs);
      s.queue.events.emit("timeline");
      return made;
    } else if (body.action === "loop") {
      const made = await t.range.loopRange(id, body.inMs, body.outMs);
      s.queue.events.emit("timeline");
      return made;
    } else {
      const view = await t.view(id);
      return { job: await s.queue.enqueueExport({ timeline: id, scale: body.scale ?? 1, music: false, range: { inMs: body.inMs, outMs: body.outMs } }, `${view.name} · copy ${clockOf(body.inMs)}–${clockOf(body.outMs)}`) };
    }
    s.queue.events.emit("timeline");
    return { ok: true as const };
  });

  /** Frames of a video side by side in one picture: what a clip shows on the timeline. */
  app.get<{ Params: { id: string }; Querystring: { frames?: string; height?: string; from?: string; to?: string; v?: string } }>("/api/assets/:id/strip", async (req, reply) => {
    const q = z.object({ frames: z.coerce.number().int().min(2).max(120).optional(), height: z.coerce.number().int().min(24).max(240).optional(), from: z.coerce.number().min(0).optional(), to: z.coerce.number().min(0).optional(), v: z.string().max(80).optional() }).parse(req.query);
    return cached(req, reply).header("Content-Type", "image/jpeg").send(Buffer.from(await t.media.strip(req.params.id, { frames: q.frames, height: q.height, fromMs: q.from, toMs: q.to })));
  });

  /** How smoothly each take of a clip meets its neighbours (×1 = like the clip's own motion): for picking among takes. */
  app.get<{ Params: { id: string } }>("/api/clips/:id/joins", async (req) => ({ items: await t.media.joins(req.params.id) }));
  /** The colour nudge each clip gets in the player, the export's matching made visible: toward the clip before at the join, within a few steps of 255. */
  app.get<{ Params: { id: string } }>("/api/timelines/:id/match", async (req) => ({ items: await t.media.matches(req.params.id) }));

  /** How much moves along a video, ten samples a second: the curve under the ruler, and the quiet moments In and Out snap to. */
  app.get<{ Params: { id: string } }>("/api/assets/:id/motion", async (req, reply) => {
    return cached(req, reply).send(await t.media.motion(req.params.id));
  });

  /** Where a video cuts between shots (ffmpeg's scene change), as moments: marks on the trim bar, "Extract every scene". */
  app.get<{ Params: { id: string } }>("/api/assets/:id/scenes", async (req, reply) => {
    return cached(req, reply).send(await t.media.scenes(req.params.id));
  });

  /** One small picture of a moment: what a hover over the trim bar shows. */
  app.get<{ Params: { id: string }; Querystring: { at?: string } }>("/api/assets/:id/peek", async (req, reply) => {
    const q = z.object({ at: z.coerce.number().min(0), h: z.coerce.number().int().min(48).max(480).optional() }).parse(req.query);
    return cached(req, reply).header("Content-Type", "image/jpeg").send(Buffer.from(await t.media.peek(req.params.id, q.at, q.h)));
  });

  /**
   * A range of a video kept as new videos: copied, split out, or removed (see Timelines.cutRange). Done
   * in the queue, by ffmpeg; the job's label says what it does.
   */
  app.post<{ Params: { id: string } }>("/api/assets/:id/range", async (req) => {
    // `timeline`: the timeline it is cut in, whose folder the new videos land in (see folderForMade)
    const body = z.strictObject({ startMs: z.number().min(0), endMs: z.number().min(0), action: z.enum(["copy", "split", "remove", "slow"]), crf: z.number().int().min(0).max(40).optional(), factor: z.union([z.literal(2), z.literal(4)]).optional(), timeline: z.string().optional() }).parse(req.body);
    const video = await s.db.selectFrom("assets").selectAll().where("id", "=", req.params.id).executeTakeFirst();
    if (!video || video.kind !== "video") throw httpError("this video was not found", 404);
    if (body.endMs - body.startMs < 20) throw httpError("That range is too short: pick at least one frame.");
    if (body.action !== "slow" && video.duration_ms && body.startMs <= 0 && body.endMs >= video.duration_ms - 2) throw httpError("That is the whole video: there is nothing to cut.");
    // split and remove take the source to the bin: not one that something still uses (see inUse), which the sweep would erase
    if (body.action === "split" || body.action === "remove") {
      const what = (await inUse(s.db)).get(video.id);
      if (what) throw httpError(`This video is still used by ${what}: ${body.action === "split" ? "a split" : "a remove"} takes it to the bin. Use Copy to library instead, or take it out of there first.`, 409);
    }
    // the job says what it is on by the name the video goes by (a nameless take: its timeline, clip and take)
    const name = (await nameOf(s.db, video)) || "video";
    if (body.action === "slow") {
      const factor = body.factor ?? 2;
      const engine = await slowEngine(s);
      return { id: await s.queue.enqueueCut({ asset: video.id, startMs: body.startMs, endMs: body.endMs, action: "slow", factor, engine, crf: body.crf, timeline: body.timeline }, `${name} · slow ×${factor} ${clockOf(body.startMs)}–${clockOf(body.endMs)}`), engine };
    }
    const said = body.action === "copy" ? `${name} · ${clockOf(body.startMs)}–${clockOf(body.endMs)} → library` : body.action === "split" ? `${name} · split at ${clockOf(body.startMs)} and ${clockOf(body.endMs)}` : `${name} · remove ${clockOf(body.startMs)}–${clockOf(body.endMs)}`;
    return { id: await s.queue.enqueueCut({ asset: video.id, startMs: body.startMs, endMs: body.endMs, action: body.action, crf: body.crf, timeline: body.timeline }, said) };
  });

  /** One frame of a video, as a picture in the library: to open another clip on, or to keep. `timeline`: the one it is saved from (its folder, see folderForMade). */
  app.post<{ Params: { id: string } }>("/api/assets/:id/frame", async (req) => {
    const { atMs, timeline } = z.strictObject({ atMs: z.number().min(0), timeline: z.string().optional() }).parse(req.body);
    const video = await s.db.selectFrom("assets").selectAll().where("id", "=", req.params.id).executeTakeFirst();
    if (!video || video.kind !== "video") throw httpError("this video was not found", 404);
    return assetView(await t.media.frame(video, atMs, false, timeline));
  });
}

/**
 * The jobs that render clips of a timeline, queued in the order the clips play: each with its own form worked through the
 * cast and the mood, a clip that carries on from one being rendered too waiting for that one. Their ids.
 */
async function renderClips(s: Services, timeline: string, clips: z.infer<typeof renderBody>["clips"]): Promise<string[]> {
  const view = await s.timelines.view(timeline);
  const wanted = new Map(clips.map((c) => [c.id, c]));
  const ids: string[] = [];
  /** The job a clip's next take will come out of: one queued here, or one that was already on its way. */
  const pending = new Map<string, string>();
  for (const c of view.clips) if (c.job) pending.set(c.id, c.job.id);
  for (const [i, clip] of view.clips.entries()) {
    const ask = wanted.get(clip.id);
    if (!ask) continue;
    const recipe = clip.recipe ? s.registry.recipe(clip.recipe) : undefined;
    if (!recipe) throw httpError(clip.kind === "still" ? `Clip ${i + 1} is a still image: there is nothing to render.` : `Clip ${i + 1} is an imported video: there is no model to render it with.`);
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
    const count = ask.takes ?? 1;
    const seed = typedSeed(input.seed);
    for (let k = 0; k < count; k++) {
      const each = k === 0 ? input : ask.seedMode && seed !== null ? { ...input, seed: movedSeed(seed, ask.seedMode, k) } : { ...input, seed: RANDOM_SEED };
      const id = await s.queue.enqueue(recipe.id, each, {
        label: `${view.name} · clip ${i + 1}${count > 1 ? ` · take ${k + 1} of ${count}` : ""}`,
        dependsOn: before && clip.joined === "continue" ? pending.get(before.id) : undefined,
        // a clip rendered together with the one after it has nothing to fit: that one is made to follow it
        // with its Mirror as it is now: a flip changed while it waits is for the next render
        clip: { id: clip.id, fit: ask.fit ?? (clip.fitNext && !(next && wanted.has(next.id))), mirror: clip.pinMirror },
        look: clip.look ?? view.look,
        // what was typed before the cast was worked in: what a tool opened from the take carries
        asked: askedOf(typed, input),
        // the render lands in the timeline's folder: its own, else its project's root
        folder: (await folderOfTimeline(s.db, { folder_id: view.folderId, project_id: view.projectId })) ?? undefined,
      });
      pending.set(clip.id, id);
      ids.push(id);
    }
  }
  if (!ids.length) throw httpError("None of these clips are on this timeline.");
  return ids;
}

/** One job of a finish, as it would be queued: a latent re-sample (a render), or a cut on the draft's video with what that video is. */
type FinishJob =
  | { kind: "render"; recipe: string; input: Record<string, unknown>; opts: Parameters<Services["queue"]["enqueue"]>[2] }
  | { kind: "cut"; cut: CutOptions; label: string; video: { width: number | null; height: number | null; durationMs: number | null; fps: number | null } };

/** The jobs that finish a timeline's clips (see the finish route), one each, and the clips skipped with why. */
async function finishClips(s: Services, timeline: string, b: z.infer<typeof finishBody>): Promise<{ jobs: string[]; skipped: Array<{ clip: number; why: string }> }> {
  const { plan, skipped } = await finishPlan(s, timeline, b);
  const jobs: string[] = [];
  for (const j of plan) jobs.push(j.kind === "render" ? await s.queue.enqueue(j.recipe, j.input, j.opts) : await s.queue.enqueueCut(j.cut, j.label));
  return { jobs, skipped };
}

/** What finishing with these settings would take in all, as the waiting list will say it job by job; null when one of them has nothing learned yet. */
async function finishEstimate(s: Services, timeline: string, b: z.infer<typeof finishBody>): Promise<number | null> {
  const { plan } = await finishPlan(s, timeline, b);
  if (!plan.length) return null;
  const paces = new Map<string, Promise<number | null>>();
  const parts: Array<{ ms: number; loadMs: number; model: string }> = [];
  for (const j of plan) {
    // a render is forecast as its job will be built (on its draft, with what its clip joins onto); a finish on the GPU frees the model for the render after it
    const got = j.kind === "render" ? await s.queue.forecast(j.recipe, j.input, { finishedFrom: j.opts?.finishedFrom, clip: j.opts?.clip }).catch(() => null) : null;
    const one = j.kind === "render" ? got?.forecast.ms ?? null : await finishForecast(s.db, j.video, j.cut, paces);
    if (!one) return null;
    parts.push({ ms: one, loadMs: got?.forecast.loadMs ?? 0, model: got?.model ?? "" });
  }
  // the model loads once for a run of renders with it, as the waiting list counts it: not once a clip
  return inARow(parts);
}

/** The jobs a finish would queue, in order, and the clips skipped with why: nothing is queued here. */
async function finishPlan(s: Services, timeline: string, b: z.infer<typeof finishBody>): Promise<{ plan: FinishJob[]; skipped: Array<{ clip: number; why: string }> }> {
  const t = s.timelines;
  const view = await t.view(timeline);
  const plan: FinishJob[] = [];
  const skipped: Array<{ clip: number; why: string }> = [];
  const folder = (await folderOfTimeline(s.db, { folder_id: view.folderId, project_id: view.projectId })) ?? undefined;
  for (const [i, clip] of view.clips.entries()) {
    if (b.clips && !b.clips.includes(clip.id)) continue;
    const take = clip.take;
    if (clip.kind !== "video" || !take) { skipped.push({ clip: i + 1, why: clip.kind === "still" ? "a still" : "no take yet" }); continue; }
    if (clip.job) { skipped.push({ clip: i + 1, why: "a render or a finish is on its way" }); continue; }
    if (take.finishedFrom && !b.redo) { skipped.push({ clip: i + 1, why: "finished already" }); continue; }
    // a redo starts from the draft again, never from a finished take (an upscale of an upscale)
    const draft = (take.finishedFrom ? clip.takes.find((x) => x.id === take.finishedFrom) : undefined) ?? take;
    const from = draft.id;
    const label = `${view.name} · clip ${i + 1} · finish`;
    if (b.route === "latent" && resamplesLatent(clip.recipe ? s.registry.recipe(clip.recipe) : undefined)) {
      const gen = await t.generationOf(draft.asset.id);
      if (!gen) { skipped.push({ clip: i + 1, why: "not rendered here: no seed to repeat" }); continue; }
      const why = notRenderedAgain(view.clips, i, gen.inputs);
      if (why) { skipped.push({ clip: i + 1, why }); continue; }
      const kept = await s.db.selectFrom("assets").select("latent_key").where("id", "=", draft.asset.id).executeTakeFirst();
      if (!kept?.latent_key) { skipped.push({ clip: i + 1, why: "its latent was not kept (rendered before Afflatus kept them, or without its node pack): finish it with SeedVR2, RTX or a model" }); continue; }
      plan.push({ kind: "render", recipe: gen.recipe, input: { ...gen.inputs, seed: gen.seed, upscale: "Latent: re-sampled", upscaleBy: b.factor, upscaleDenoise: b.latentDenoise ?? 0.15, upscaleSteps: b.latentSteps ?? 2 }, opts: {
        // the pictures its draft flipped are flipped again: the finish re-samples the draft, made from them as they were sent
        label, clip: { id: clip.id, fit: false, mirror: gen.mirror }, look: clip.look ?? view.look, folder, finishedFrom: from,
      } });
      continue;
    }
    const route = b.route === "latent" ? "seedvr" : b.route;
    const a = draft.asset;
    plan.push({ kind: "cut", label, video: { width: a.width ?? null, height: a.height ?? null, durationMs: a.durationMs ?? null, fps: a.fps ?? null },
      cut: { asset: a.id, startMs: 0, endMs: a.durationMs ?? 0, action: "finish", route, by: b.factor, colour: b.colour, upscaleModel: b.upscaleModel, seedvrFrames: b.seedvrFrames, sharpen: b.sharpen, hiddenMs: hiddenRunUp(draft.headMs), clip: clip.id, finishedFrom: from } });
  }
  return { plan, skipped };
}

/**
 * Why the clip at `i` cannot be finished by rendering it again (H3's latent re-sample), or null: rendered again, it makes the
 * draft again only from the same start: a continuation still after the video it carried on from (or that video's finish), a
 * clip that was not one not made into one, nothing it landed on. Otherwise it would be a new video.
 */
function notRenderedAgain(clips: Awaited<ReturnType<Timelines["view"]>>["clips"], i: number, inputs: Record<string, unknown>): string | null {
  const clip = clips[i]!;
  const prior = i > 0 ? clips[i - 1] : undefined;
  const priorAssets = prior?.take ? [prior.take.asset.id, prior.takes.find((x) => x.id === prior.take!.finishedFrom)?.asset.id] : [];
  const carried = (inputs.previous as { asset?: string } | undefined)?.asset;
  return carried && (clip.joined !== "continue" || !priorAssets.includes(carried))
    ? "it carried on from a video that is no longer the clip before it (rejoined, moved or restored): rendered again it would be a new video. Finish it with SeedVR2, RTX or a model"
    : !carried && clip.joined === "continue" && prior
      ? "it was not made as a continuation of the clip before: rendered again as one it would be a new video. Finish it with SeedVR2, RTX or a model"
      : inputs.next
        ? "it was made to land on the clip after: rendered again it would not land the same. Finish it with SeedVR2, RTX or a model"
        : null;
}

/**
 * Served to be kept by the browser for a year when the address names the file's version (`?v=`, which changes when a linked
 * file is written again), else checked again each time: what is worked out of a video is made again when its file changes.
 */
function cached(req: FastifyRequest, reply: FastifyReply): FastifyReply {
  const versioned = z.object({ v: z.string().optional() }).parse(req.query ?? {}).v !== undefined;
  return reply.header("Cache-Control", versioned ? "private, max-age=31536000, immutable" : "private, no-cache");
}
