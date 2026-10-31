import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { CUT_WINDOW_MOST, OWN_MODEL, RANDOM_SEED, TRANSITION_KINDS, TRANSITION_MS, hiddenRunUp, movedSeed, resamplesLatent, typedSeed, type InputSpec, type Recipe, type ReferenceValue } from "@afflatus/core";
import { fromRender, markPng } from "./aiMark";
import { nameOf } from "./autoName";
import { VERSION } from "./config";
import { CutError, markedVideoFile } from "./cut";
import { musicTrack } from "./exportJoin";
import { now } from "./db";
import { httpError } from "./errors";
import { compose, lookSchema, withMood } from "./entities";
import { askedOf } from "./jobs-api";
import { assetView, extOf } from "./media";
import { sourceOf } from "./storage";
import { rifeModelIn } from "./queue";
import { CUT_JOB } from "./timelineModel";
import { rootFolderOf } from "./projects";
import { inUse } from "./sweep";
import { folderOfTimeline } from "./timelineFolder";
import { fcp7Xml, otioJson, projectPlan, projectReadme } from "./timelineProject";
import { ownInputIds } from "./timelinePlan";
import { sourcePatch } from "./timelineSource";
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
  /** Its source lane (a long video made into clips window by window): a new video, changes to the one there, or null to take it away. */
  source: sourcePatch.optional(),
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
  /** The cut's transition into it; null = a plain cut. Given to a clip that extends, it makes the join a cut. */
  transition: z.strictObject({ kind: z.enum(TRANSITION_KINDS), ms: z.number().min(TRANSITION_MS.least).max(TRANSITION_MS.most), sound: z.enum(["on", "fade"]) }).nullable().optional(),
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
  /** The take whose settings the patch puts back (Use this take's settings). */
  settingsOf: z.string().optional(),
  stillMs: z.number().min(0).optional(),
  animate: z.boolean().optional(),
  look: lookSchema.nullable().optional(),
  chat: z.array(z.unknown()).max(200).optional(),
  designer: z.strictObject({ llm: z.string().max(40).optional(), instruction: z.string().max(40).optional() }).nullable().optional(),
  /** Of a clip made from the source: how its settings go with the other clips' (see ClipPatch.share). */
  share: z.enum(["apart", "inLine", "toAll"]).optional(),
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

export const renderBody = z.strictObject({
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
  /** The machine they render on (a Machine's id), each job pinned there; left out, whichever would end each first (New take's machine slice). */
  machine: z.string().min(1).max(40).optional(),
});

/** What the timeline for a video editor is asked with: the music (on unless "0"), and a range from In to Out. */
const projectQuery = z.strictObject({
  music: z.enum(["0", "1"]).optional(),
  in: z.coerce.number().min(0).optional(),
  out: z.coerce.number().min(0).optional(),
});

export const exportBody = z.strictObject({
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

/** A finish's model file, never OWN_MODEL: only Face refine runs on the clip's own model. */
const notOwn = z.string().max(200).refine((v) => v !== OWN_MODEL, { message: `"${OWN_MODEL}" is Face refine's alone: the upscalers take a model file` });

/** How the clips are finished: the route, how much larger, its settings; `redo` finishes again the clips finished already. */
export const finishBody = z.strictObject({
  route: z.enum(["seedvr", "latent", "rtx", "model", "face"]), factor: z.number().min(1).max(4), colour: z.enum(["lab", "wavelet", "adain", "none"]).optional(), upscaleModel: notOwn.optional(), seedvrFrames: z.number().int().min(0).max(49).optional(),
  sharpen: z.number().min(0).max(1).optional(), latentNoise: z.number().min(0.05).max(0.95).optional(), latentSteps: z.number().int().min(1).max(6).optional(),
  faceDenoise: z.number().min(0.3).max(0.6).optional(), face: z.boolean().optional(),
  /**
   * The models a finish runs on (card #159), "" or none for each clip's own: Face refine's (a file, or OWN_MODEL: the clip's own
   * model) over what each clip's form says; H3's latent upscaler and SeedVR2's model over Settings › Models' files.
   */
  // (the clip's own model is Face refine's alone: an upscaler set to it named no file, and failed the job at its submit)
  faceModel: z.string().max(200).optional(), latentModel: notOwn.optional(), seedvrModel: notOwn.optional(),
  /** Redo the clips finished already: all of them (true), or only those finished with other settings ("changed"). */
  redo: z.union([z.boolean(), z.literal("changed")]).default(false), clips: z.array(z.string()).optional(),
  /** One take to finish (a take's Face pass), in place of the clip's playing one: finished from it, whatever plays. */
  take: z.string().optional(),
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

/**
 * A timeline's view as it is sent to the editor: each clip's playing take by its id, which the editor finds among the clip's
 * takes (web api.ts, withTakes). Sent whole beside them, every playing take went twice: 115 of 507 KB at 150 clips.
 */
export function sent<V extends { clips: Array<{ take: { id: string } | null }> }>(view: V) {
  return { ...view, clips: view.clips.map((c) => ({ ...c, take: c.take?.id ?? null })) };
}

/** What a range of a video or a sound is cut as (POST /api/assets/:id/range, MCP's cut_range). `timeline`: the timeline it is cut in, whose folder the new videos land in (see folderForMade). */
export const rangeBody = z.strictObject({ startMs: z.number().min(0), endMs: z.number().min(0), action: z.enum(["copy", "split", "remove", "slow"]), crf: z.number().int().min(0).max(40).optional(), factor: z.union([z.literal(2), z.literal(4)]).optional(), even: z.boolean().optional(), timeline: z.string().optional() });

/**
 * A range of a video kept as new videos: copied, split out, or removed (see Timelines.cutRange), or slowed. Done in the
 * queue, by ffmpeg (a slow motion by RIFE where ComfyUI has it); the job's label says what it does. A sound the same way
 * (not slowed), `even` evening out the loudness of what it makes. Split and remove take the source to the bin, as a bin
 * does: never one that something still uses. `by`: the MCP token whose call sent a slow motion (RIFE on the GPU: its limits
 * count it, and without Spend it stays off rented pods).
 */
export async function cutRange(s: Services, id: string, body: z.output<typeof rangeBody>, by: { mcpToken?: string | null } = {}): Promise<{ id: string; engine?: string }> {
  const video = await s.db.selectFrom("assets").selectAll().where("id", "=", id).executeTakeFirst();
  const sound = video?.kind === "audio";
  if (!video || (video.kind !== "video" && !sound)) throw httpError("this video was not found", 404);
  const what = sound ? "sound" : "video";
  if (sound && body.action === "slow") throw httpError("A sound is not slowed: copy, split or remove a range of it.");
  if (body.endMs - body.startMs < 20) throw httpError(`That range is too short: pick at least ${sound ? "a moment" : "one frame"}.`);
  if (body.action !== "slow" && video.duration_ms && body.startMs <= 0 && body.endMs >= video.duration_ms - 2) throw httpError(`That is the whole ${what}: there is nothing to cut.`);
  // split and remove take the source to the bin: not one that something still uses (see inUse), which the sweep would erase
  if (body.action === "split" || body.action === "remove") {
    const user = (await inUse(s.db)).get(video.id);
    if (user) throw httpError(`This ${what} is still used by ${user}: ${body.action === "split" ? "a split" : "a remove"} takes it to the bin. Use Copy to library instead, or take it out of there first.`, 409);
  }
  // the job says what it is on by the name the video goes by (a nameless take: its timeline, clip and take)
  const name = (await nameOf(s.db, video)) || what;
  if (body.action === "slow") {
    const factor = body.factor ?? 2;
    const engine = await slowEngine(s);
    return { id: await s.queue.enqueueCut({ asset: video.id, startMs: body.startMs, endMs: body.endMs, action: "slow", factor, engine, crf: body.crf, timeline: body.timeline }, `${name} · slow ×${factor} ${clockOf(body.startMs)}–${clockOf(body.endMs)}`, { mcpToken: by.mcpToken ?? null }), engine };
  }
  const said = body.action === "copy" ? `${name} · ${clockOf(body.startMs)}–${clockOf(body.endMs)} → library` : body.action === "split" ? `${name} · split at ${clockOf(body.startMs)} and ${clockOf(body.endMs)}` : `${name} · remove ${clockOf(body.startMs)}–${clockOf(body.endMs)}`;
  return { id: await s.queue.enqueueCut({ asset: video.id, startMs: body.startMs, endMs: body.endMs, action: body.action, crf: body.crf, ...(sound && body.even ? { even: true } : {}), timeline: body.timeline }, said) };
}

/** What POST /api/timelines/:id/range takes (MCP's timeline_range): In and Out on the timeline's clock, and what is done between them. */
export const timelineRangeBody = z.strictObject({ inMs: z.number().min(0), outMs: z.number().min(0), action: z.enum(["split", "remove", "regenerate", "loop", "copy", "slow"]), scale: z.number().min(1).max(2).optional(), factor: z.union([z.literal(2), z.literal(4)]).optional() });

/**
 * The range between In and Out acted on (POST /api/timelines/:id/range, MCP's timeline_range): split, removed, regenerated
 * or looped (the new clip answered, not rendered), copied to the library through the export queue, or slowed (its parts made
 * clips of their own, each slowed video arriving as the take of its clip). `by`: the MCP token whose call sent a slow motion
 * (RIFE on the GPU: its limits count it, and without Spend it stays off rented pods).
 */
export async function rangeAction(s: Services, id: string, body: z.output<typeof timelineRangeBody>, by: { mcpToken?: string | null } = {}) {
  const t = s.timelines;
  if (body.action === "slow") {
    // the parts become clips of their own; each slowed video arrives as the take of its clip
    const factor = body.factor ?? 2;
    const parts = await t.range.slowRangeOf(id, body.inMs, body.outMs, factor);
    const engine = await slowEngine(s);
    const view = await t.view(id);
    const jobs: string[] = [];
    for (const made of parts) {
      const index = view.clips.findIndex((c) => c.id === made.clip);
      jobs.push(await s.queue.enqueueCut({ asset: made.asset.id, startMs: made.startMs, endMs: made.endMs, action: "slow", factor, engine, clip: made.clip }, `${view.name} · clip ${index + 1} · slow ×${factor}`, { mcpToken: by.mcpToken ?? null }));
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
}

/**
 * A swap clip's Show the mask (the owner's mock, 2026-10-18; POST /api/clips/:id/mask-preview, MCP's mask_preview): its
 * window's tracking and masks alone, drawn over its frames, as a short video kept out of the library (a scratch file, gone
 * after a day). No take is made: the job is the clip's timeline's, not the clip's. `input` is its form as a render would
 * send it. `by`: the MCP token whose call sent it (a job on the GPU: its limits count it, without Spend it stays off rented pods).
 */
export async function maskPreview(s: Services, clipId: string, input: Record<string, unknown>, by: { mcpToken?: string | null } = {}): Promise<{ job: string }> {
  const row = await s.db.selectFrom("clips").select(["timeline_id", "recipe_id"]).where("id", "=", clipId).executeTakeFirst();
  if (!row) throw httpError("this clip was not found", 404);
  const recipe = row.recipe_id ? s.registry.recipe(row.recipe_id) : undefined;
  if (!recipe?.inputs.some((i) => i.id === "maskPreview")) throw httpError("Only a swap's clip has a mask to show.");
  const view = await s.timelines.view(row.timeline_id);
  const own = ownInputIds(recipe);
  const typed = Object.fromEntries(Object.entries(input).filter(([k]) => own.has(k)));
  const job = await s.queue.enqueue(recipe.id, { ...typed, maskPreview: true }, {
    label: `${view.name} · mask of clip ${view.clips.findIndex((c) => c.id === clipId) + 1}`,
    folder: (await folderOfTimeline(s.db, { folder_id: view.folderId, project_id: view.projectId })) ?? undefined,
    mcpToken: by.mcpToken ?? null,
  });
  return { job };
}

/** Where a Show the mask stands, and once done its video (GET /api/clips/:id/mask-preview/:job, MCP's mask_preview). */
export async function maskPreviewOf(s: Services, jobId: string) {
  const job = await s.db.selectFrom("jobs").select(["status", "error", "generation_id"]).where("id", "=", jobId).executeTakeFirst();
  if (!job) throw httpError("this mask was not found", 404);
  const asset = job.generation_id ? await s.db.selectFrom("assets").selectAll().where("generation_id", "=", job.generation_id).where("kind", "=", "video").executeTakeFirst() : undefined;
  return { status: job.status, error: job.error, video: asset ? assetView(asset) : null };
}

export function registerTimelines(app: FastifyInstance, s: Services): void {
  const t = s.timelines;

  app.get("/api/timelines", async (req) => t.list(z.object({ project: z.string().optional() }).parse(req.query).project));
  app.post("/api/timelines", async (req) => {
    const body = z.strictObject({ name: z.string().max(200).optional(), project: z.string().nullable().optional(), folder: z.string().nullable().optional() }).parse(req.body ?? {});
    // made inside a folder (the one open in the Studio): it lives and renders there, and that counts as chosen, so that a
    // picture dropped on it later does not move it. Else its renders land in the project's root folder until one is chosen
    if (body.folder) {
      const f = await s.db.selectFrom("folders").select(["id", "project_id"]).where("id", "=", body.folder).executeTakeFirst();
      if (!f) throw httpError("this folder was not found", 404);
      if ((f.project_id ?? null) !== (body.project ?? null)) throw httpError("that folder is not in this project", 400);
      return sent(await t.create(body.name, body.project ?? null, f.id, true));
    }
    return sent(await t.create(body.name, body.project ?? null, await rootFolderOf(s.db, body.project)));
  });
  app.get<{ Params: { id: string } }>("/api/timelines/:id", async (req) => sent(await t.view(req.params.id)));
  /** The music ducked under speech: its gain along the timeline (duck.ts), for the player; null when there is no music or it is not ducked. */
  app.get<{ Params: { id: string } }>("/api/timelines/:id/duck", async (req) => ({ curve: await t.duck(req.params.id) }));
  app.patch<{ Params: { id: string } }>("/api/timelines/:id", async (req) => sent(await t.edit(req.params.id, timelinePatch.parse(req.body))));
  /** Its source lane's stretch made into clips, window by window (timelineSource.ts): the new clips' ids, to be rendered by the editor. */
  // `again`: the source cut again into the clips it made, those rendered kept (Timelines.makeFromSource)
  app.post<{ Params: { id: string } }>("/api/timelines/:id/source/make", async (req) => ({ clips: await t.makeFromSource(req.params.id, z.strictObject({ again: z.boolean().optional() }).parse(req.body ?? {})) }));
  // the source's stretch trimmed after Make: its end in or out (windows set aside and brought back), its start moved (made anew)
  app.post<{ Params: { id: string } }>("/api/timelines/:id/source/trim", async (req) => t.trimSource(req.params.id, z.strictObject({ fromMs: z.number().min(0), toMs: z.number().min(0) }).parse(req.body)));
  // a recording's clips trimmed: its end in (clips go) or out (clips added at its pauses), its start moved (made anew)
  app.post<{ Params: { id: string } }>("/api/timelines/:id/recording/trim", async (req) => t.trimRecording(req.params.id, z.strictObject({ asset: z.string().min(1), fromMs: z.number().min(0), toMs: z.number().min(0) }).parse(req.body)));
  // a recording's clips cut again at another length or window (its panel: Timelines.cutRecording)
  app.post<{ Params: { id: string } }>("/api/timelines/:id/recording/cut", async (req) => t.cutRecording(req.params.id, z.strictObject({ asset: z.string().min(1), seconds: z.number().min(1).max(60), window: z.number().min(0).max(CUT_WINDOW_MOST) }).parse(req.body)));
  // what a recording's clips share, given to all of them at once (its panel's Shared by its clips: Timelines.recordingForm)
  app.post<{ Params: { id: string } }>("/api/timelines/:id/recording/form", async (req) => {
    const clips = await t.recordingForm(req.params.id, z.strictObject({ asset: z.string().min(1), inputs: z.record(z.string(), z.unknown()) }).parse(req.body));
    return { ok: true, clips };
  });
  // the form a recording's new clips are made in, Lip sync or one it plays over (its panel's New clips: Timelines.recordingNewClips)
  app.post<{ Params: { id: string } }>("/api/timelines/:id/recording/new-clips", async (req) => {
    await t.recordingNewClips(req.params.id, z.strictObject({ asset: z.string().min(1), recipe: z.string().min(1) }).parse(req.body));
    return { ok: true };
  });
  // a voice recording made into Lip sync clips cut at its pauses, in place of an empty clip or at the end (Timelines.makeFromRecording)
  app.post<{ Params: { id: string } }>("/api/timelines/:id/recording", async (req) => ({ clips: await t.makeFromRecording(req.params.id, z.strictObject({ asset: z.string().min(1), clip: z.string().optional(), seconds: z.number().min(1).max(60).optional() }).parse(req.body)) }));
  // the source given another windowed form: in place on the same grid (its windows and takes kept), else made anew (Timelines.sourceForm)
  app.post<{ Params: { id: string } }>("/api/timelines/:id/source/form", async (req) => t.sourceForm(req.params.id, z.strictObject({ recipe: z.string().min(1) }).parse(req.body).recipe));
  // one window of the source given another form of its grid, in place (Timelines.windowForm, card #42)
  app.post<{ Params: { id: string } }>("/api/timelines/:id/source/window", async (req) => {
    const { clip, recipe } = z.strictObject({ clip: z.string().min(1), recipe: z.string().min(1) }).parse(req.body);
    await t.windowForm(req.params.id, clip, recipe);
    return { ok: true };
  });
  /** The source split at a moment of it: the part before, from its stretch's start, a clip playing it as it is. */
  app.post<{ Params: { id: string } }>("/api/timelines/:id/source/split", async (req) => ({ clip: await t.splitSource(req.params.id, z.strictObject({ atMs: z.number().min(0) }).parse(req.body).atMs) }));
  app.delete<{ Params: { id: string } }>("/api/timelines/:id", async (req) => {
    await t.remove(req.params.id);
    return { ok: true };
  });
  /** A copy of the timeline beside it, its clips and takes with it (Timelines.duplicate): the copy as GET answers it. */
  app.post<{ Params: { id: string } }>("/api/timelines/:id/duplicate", async (req) => sent(await t.duplicate(req.params.id, z.strictObject({ name: z.string().trim().max(200).optional() }).parse(req.body ?? {}).name)));
  /**
   * Take the last change to the timeline back. Answers with what was undone, in a few words, and what to tell of the takes
   * rendered since that do not fit their clips at that step (`said`). Refused (409) over a clip in the queue.
   */
  // `step`: that step alone (an agent's change undone from its toast), refused when the timeline changed after it; `steps`:
  // those, in the order they were made (an agent's list of actions), taken back together, refused when they are not the last
  app.post<{ Params: { id: string } }>("/api/timelines/:id/undo", async (req) => {
    const { step, steps } = z.strictObject({ step: z.string().min(1).optional(), steps: z.array(z.string().min(1)).min(1).max(100).optional() }).parse(req.body ?? {});
    const { label, said } = await t.history.undo(req.params.id, steps ?? step);
    return { undone: label, ...(said ? { said } : {}) };
  });
  app.post<{ Params: { id: string } }>("/api/timelines/:id/redo", async (req) => {
    const { label, said } = await t.history.redo(req.params.id);
    return { redone: label, ...(said ? { said } : {}) };
  });
  /** A copy of the clip right after it. */
  /** A swap clip's Show the mask (maskPreview): a job of its timeline's, no take made. `input` is its form as a render would send it. */
  app.post<{ Params: { id: string } }>("/api/clips/:id/mask-preview", async (req) => maskPreview(s, req.params.id, z.strictObject({ input: z.record(z.string(), z.unknown()) }).parse(req.body).input));
  /** Where a Show the mask stands, and once done its video. */
  app.get<{ Params: { id: string; job: string } }>("/api/clips/:id/mask-preview/:job", async (req) => maskPreviewOf(s, req.params.job));

  app.post<{ Params: { id: string } }>("/api/clips/:id/duplicate", async (req) => {
    const clip = await t.range.duplicateClip(req.params.id);
    s.queue.events.emit("timeline");
    return { clip };
  });

  app.post<{ Params: { id: string } }>("/api/timelines/:id/clips", async (req) => {
    const clip = await t.addClip(req.params.id, newClip.parse(req.body ?? {}));
    return { clip, timeline: sent(await t.view(req.params.id)) };
  });
  app.patch<{ Params: { id: string } }>("/api/clips/:id", async (req) => {
    // the form as kept when the server worked out some of it (a voice's part): the editor shows that
    return { ok: true, ...(await t.editClip(req.params.id, clipPatch.parse(req.body))) };
  });
  app.delete<{ Params: { id: string } }>("/api/clips/:id", async (req) => {
    await t.removeClip(req.params.id);
    return { ok: true };
  });
  // several clips of a timeline removed in one step (those picked); a recording's or the source's cut their part out
  app.post<{ Params: { id: string } }>("/api/timelines/:id/clips/remove", async (req) => {
    const { ids } = z.strictObject({ ids: z.array(z.string().min(1)).min(1).max(1000) }).parse(req.body);
    await t.removeClips(req.params.id, ids);
    return { ok: true };
  });
  // a part cut out of the middle of a recording or the source by removing its clips brought back (Timelines.bringBack)
  app.post<{ Params: { id: string } }>("/api/timelines/:id/removed/back", async (req) => {
    await t.bringBack(req.params.id, z.strictObject({ before: z.string().min(1) }).parse(req.body).before);
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
    const body = renderBody.parse(req.body);
    // a job pinned to a machine there is not would wait for ever
    if (body.machine && !(await s.machines()).some((m) => m.machine.id === body.machine)) throw httpError("there is no ComfyUI with that id");
    const ids = await renderClips(s, req.params.id, body.clips, body.machine);
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
    return { clips: made, timeline: sent(await t.view(req.params.id)) };
  });

  /** Export the timeline as one video. It runs in the queue, after the renders that are already waiting. */
  app.post<{ Params: { id: string } }>("/api/timelines/:id/export", async (req) => exportTimeline(s, req.params.id, exportBody.parse(req.body ?? {})));

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
        // a render (or a frame, cut or edit of one) goes in marked as made by a model, its frames as they are (aiMark.ts)
        const rows = await s.db.selectFrom("assets").select(["file_key", "kind", "mime", "origin", "source_id"]).where("file_key", "in", [...files.values()]).execute();
        const byKey = new Map(rows.map((r) => [r.file_key, r]));
        for (const [path, key] of files) {
          if (req.raw.destroyed) break;
          const a = byKey.get(key);
          if (a && (a.kind === "video" || a.mime === "image/png") && (await fromRender(s.db, a))) {
            if (a.kind === "video") {
              // read from the marked copy on the disk as it goes into the zip, then removed: one file in memory at a time held 800 MB
              const marked = await markedVideoFile(await sourceOf(s.storage, key), extOf(a.mime));
              try {
                await zip.add(path, createReadStream(marked.file), new Date(), marked.size);
              } finally {
                await marked.done();
              }
              continue;
            }
            const marked = markPng(await s.storage.get(key));
            await zip.add(path, Readable.from([Buffer.from(marked.buffer, marked.byteOffset, marked.byteLength)]), new Date(), marked.length);
            continue;
          }
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
    const done = await t.history.oneAtATime(`finish:${req.params.id}`, async () => {
      const { plan, skipped } = await finishPlan(s, req.params.id, b);
      return finishClips(s, plan, skipped);
    });
    s.queue.events.emit("timeline");
    return done;
  });

  /** What Finish with these settings would take in all (finishEstimate: its jobs through the machines' lanes); null when a job of it has no learned figure yet. */
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
  app.post<{ Params: { id: string } }>("/api/timelines/:id/range", async (req) => rangeAction(s, req.params.id, timelineRangeBody.parse(req.body)));

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

  /** The pauses of a sound and the timed lines it carries (its lyrics), in seconds, read once and kept: where a recording is cut into Lip sync clips, marked on its stage. */
  app.get<{ Params: { id: string } }>("/api/assets/:id/pauses", async (req, reply) => {
    return cached(req, reply).send(await t.media.pauses(req.params.id));
  });

  /** Where a video cuts between shots (ffmpeg's scene change), as moments: marks on the trim bar, "Extract every scene". */
  app.get<{ Params: { id: string } }>("/api/assets/:id/scenes", async (req, reply) => {
    return cached(req, reply).send(await t.media.scenes(req.params.id));
  });

  /** A moment of a sound as WAV, six seconds at most: what the player plays the song under Lip sync clips from, a few seconds at a time (its clips' soundParts). */
  app.get<{ Params: { id: string }; Querystring: { from?: string; ms?: string } }>("/api/assets/:id/slice", async (req, reply) => {
    const q = z.object({ from: z.coerce.number().min(0), ms: z.coerce.number().min(1).max(6000) }).parse(req.query);
    return cached(req, reply).header("Content-Type", "audio/wav").send(Buffer.from(await t.media.slice(req.params.id, q.from, q.ms)));
  });

  /** One small picture of a moment: what a hover over the trim bar shows. */
  app.get<{ Params: { id: string }; Querystring: { at?: string } }>("/api/assets/:id/peek", async (req, reply) => {
    const q = z.object({ at: z.coerce.number().min(0), h: z.coerce.number().int().min(48).max(480).optional() }).parse(req.query);
    return cached(req, reply).header("Content-Type", "image/jpeg").send(Buffer.from(await t.media.peek(req.params.id, q.at, q.h)));
  });

  /** A range of a video or a sound kept as new ones: copied, split out, removed or slowed (cutRange). */
  app.post<{ Params: { id: string } }>("/api/assets/:id/range", async (req) => cutRange(s, req.params.id, rangeBody.parse(req.body)));

  /**
   * A box's working picture taken into the library, kept: the one picked of Make the picture's round, which a Motion transfer
   * then moves. Anything else is left as it is.
   */
  app.post<{ Params: { id: string } }>("/api/assets/:id/adopt", async (req) => {
    const done = await s.db.updateTable("assets").set({ origin: "generated", kept_at: now() }).where("id", "=", req.params.id).where("origin", "=", "scratch").executeTakeFirst();
    const row = await s.db.selectFrom("assets").selectAll().where("id", "=", req.params.id).executeTakeFirst();
    if (!row) throw httpError("this picture was not found", 404);
    if (Number(done.numUpdatedRows)) s.queue.events.emit("library", { change: "added", items: [row.id], folders: [row.folder_id] });
    return assetView(row);
  });

  /** One frame of a video, as a picture in the library: to open another clip on, or to keep. `timeline`: the one it is saved from (its folder, see folderForMade). */
  app.post<{ Params: { id: string } }>("/api/assets/:id/frame", async (req) => {
    // `once`: the same moment asked for again gives the same picture (a Reroll of Make the picture), not one more copy
    // `scratch`: a box's working picture, kept out of the library (Make the picture's frame)
    const { atMs, timeline, once, scratch } = z.strictObject({ atMs: z.number().min(0), timeline: z.string().optional(), once: z.boolean().optional(), scratch: z.boolean().optional() }).parse(req.body);
    const video = await s.db.selectFrom("assets").selectAll().where("id", "=", req.params.id).executeTakeFirst();
    if (!video || video.kind !== "video") throw httpError("this video was not found", 404);
    return assetView(await t.media.frame(video, atMs, once ?? false, timeline, scratch ?? false));
  });
}

/**
 * A timeline exported as one video (POST /api/timelines/:id/export, MCP's export): queued after the renders already waiting
 * (its own timeline's among them), looked at and queued one request at a time, so that two tabs asking at once get the one
 * export. Its job's id. `by`: the MCP token whose call queued it (its job then is that token's: cancelled by it, never by
 * another token).
 */
export function exportTimeline(s: Services, id: string, opts: z.output<typeof exportBody>, by: { mcpToken?: string } = {}): Promise<{ id: string }> {
  return s.timelines.history.oneAtATime(`export:${id}`, async () => {
    const view = await s.timelines.view(id);
    if (!view.durationMs) throw httpError("There is nothing to export yet: no clip of this timeline has a take.");
    if (view.exporting) return { id: view.exporting.id };
    return { id: await s.queue.enqueueExport({ timeline: view.id, scale: opts.scale, music: opts.music, smooth: opts.smooth, range: opts.range, blend: opts.blend, match: opts.match, fit: opts.fit, webMb: opts.webMb }, `${view.name} · ${opts.webMb ? "web copy" : "export"}`, by.mcpToken) };
  });
}

/**
 * The jobs that render clips of a timeline, queued in the order the clips play: each with its own form worked through the
 * cast and the mood, a clip that carries on from one being rendered too waiting for that one. Their ids. `by`: the MCP
 * token whose call sent them (its limits count them; without Spend they stay off rented pods).
 */
export async function renderClips(s: Services, timeline: string, clips: z.infer<typeof renderBody>["clips"], machine?: string, by: { mcpToken?: string } = {}): Promise<string[]> {
  const view = await s.timelines.view(timeline);
  const wanted = new Map(clips.map((c) => [c.id, c]));
  /** The job a clip's next take will come out of: one queued here, or one that was already on its way. */
  const pending = new Map<string, string>();
  for (const c of view.clips) if (c.job) pending.set(c.id, c.job.id);
  // all of the clips queued, or none: one whose files are a mix known to give black frames is refused as it is queued
  // (Queue.enqueue), named by its place, and the clips before it are not left rendering without it
  const ids = await s.queue.enqueueAll(async (queue) => {
    for (const [i, clip] of view.clips.entries()) {
      const ask = wanted.get(clip.id);
      if (!ask) continue;
      const recipe = clip.recipe ? s.registry.recipe(clip.recipe) : undefined;
      if (!recipe) throw httpError(clip.kind === "still" ? `Clip ${i + 1} is a still image: there is nothing to render.` : `Clip ${i + 1} is an imported video: there is no model to render it with.`);
      // what a timeline fills in itself is not the form's to say
      const own = ownInputIds(recipe);
      // the cast and the style: the clip's own, else the timeline's, worked into its form
      const typed = Object.fromEntries(Object.entries(ask.input).filter(([k]) => own.has(k)));
      const input = withMood(recipe, (await compose(s.db, recipe, typed, clip.look ?? view.look)).input, view.mood);
      const before = view.clips[i - 1];
      // a recipe that picks up from the last frame of the clip before: that frame is its opening picture, taken when the job starts
      const opening = recipe.inputs.find((x) => x.type === "image" && x.role === "start");
      if (opening && !input[opening.id] && before && clip.joined === "continue" && (recipe.traits?.continues === "frame" || before.kind === "still")) input[opening.id] = FROM_PREVIOUS;
      // a clip that carries on waits for the take of the clip before queued here, else as Again has it (Timelines.againAfter):
      // for one on its way, or refused with no take there and none coming, a latent landing opening on nothing (card #128).
      // Thrown inside enqueueAll, the whole batch is refused, named by the clip
      const waitFor = before && clip.joined === "continue" ? (pending.get(before.id) ?? (await s.timelines.againAfter(clip.id))) : undefined;
      const next = view.clips[i + 1];
      const count = ask.takes ?? 1;
      const seed = typedSeed(input.seed);
      for (let k = 0; k < count; k++) {
        const each = k === 0 ? input : ask.seedMode && seed !== null ? { ...input, seed: movedSeed(seed, ask.seedMode, k) } : { ...input, seed: RANDOM_SEED };
        const id = await queue.render(recipe.id, each, {
          label: `${view.name} · clip ${i + 1}${count > 1 ? ` · take ${k + 1} of ${count}` : ""}`,
          who: `Clip ${i + 1}`,
          dependsOn: waitFor,
          // a clip rendered together with the one after it has nothing to fit: that one is made to follow it
          // with its Mirror as it is now: a flip changed while it waits is for the next render
          clip: { id: clip.id, fit: ask.fit ?? (clip.fitNext && !(next && wanted.has(next.id))), mirror: clip.pinMirror },
          look: clip.look ?? view.look,
          // what was typed before the cast was worked in: what a tool opened from the take carries
          asked: askedOf(typed, input),
          // the render lands in the timeline's folder: its own, else its project's root
          folder: (await folderOfTimeline(s.db, { folder_id: view.folderId, project_id: view.projectId })) ?? undefined,
          machine: machine ?? null,
          mcpToken: by.mcpToken ?? null,
        });
        pending.set(clip.id, id);
      }
    }
  });
  if (!ids.length) throw httpError("None of these clips are on this timeline.");
  return ids;
}

/**
 * One job of a finish, as it would be queued: a latent re-sample (a render), or a cut on the draft's video with what that
 * video is. A render with `then`: a Face refine, and the cut that finishes its result after it (Face refine first).
 */
export type FinishJob =
  | { kind: "render"; recipe: string; input: Record<string, unknown>; opts: Parameters<Services["queue"]["enqueue"]>[2]; then?: { cut: CutOptions; label: string } }
  | { kind: "cut"; cut: CutOptions; label: string; video: { width: number | null; height: number | null; durationMs: number | null; fps: number | null } };

/**
 * The jobs that finish a timeline's clips (a finishPlan's, see the finish route), one each, and the clips skipped with why.
 * `by`: the MCP token whose call sent them, on each of its jobs (its limits count them; without Spend they stay off rented pods).
 */
export async function finishClips(s: Services, plan: FinishJob[], skipped: Array<{ clip: number; why: string }>, by: { mcpToken?: string } = {}): Promise<{ jobs: string[]; skipped: Array<{ clip: number; why: string }> }> {
  const mcpToken = by.mcpToken ?? null;
  // all of the finish queued, or none of it: a job refused part way leaves no half finish behind, and says why
  const jobs = await s.queue.enqueueAll(async (ask) => {
    for (const j of plan) {
      if (j.kind !== "render") {
        await ask.cut(j.cut, j.label, { mcpToken });
        continue;
      }
      const id = await ask.render(j.recipe, j.input, { ...j.opts, mcpToken });
      // the pixel route after the Face refine, on what it makes: queued behind it
      if (j.then) await ask.cut({ ...j.then.cut, fromJob: id }, j.then.label, { dependsOn: id, mcpToken });
    }
  });
  return { jobs, skipped };
}

/**
 * What finishing with these settings would take in all, as the queue would share its jobs between the machines (queue.total:
 * two free machines take about half the time one does, each at its own pace); null when one of them has nothing learned yet.
 */
async function finishEstimate(s: Services, timeline: string, b: z.infer<typeof finishBody>): Promise<number | null> {
  const { plan } = await finishPlan(s, timeline, b);
  if (!plan.length) return null;
  // a render is forecast as its job will be built (on its draft, with what its clip joins onto); a finish on the GPU frees the model for the render after it
  return (await s.queue.total(plan.flatMap((j) => (j.kind === "render" ? [{ recipe: j.recipe, input: j.input, finishedFrom: j.opts?.finishedFrom, clip: j.opts?.clip ? { id: j.opts.clip.id, fit: j.opts.clip.fit } : null }, ...(j.then ? [{ recipe: CUT_JOB, input: j.then.cut }] : [])] : [{ recipe: CUT_JOB, input: j.cut }])))).ms;
}

/** The jobs a finish would queue, in order, and the clips skipped with why: nothing is queued here. */
export async function finishPlan(s: Services, timeline: string, b: z.infer<typeof finishBody>): Promise<{ plan: FinishJob[]; skipped: Array<{ clip: number; why: string }> }> {
  const t = s.timelines;
  const view = await t.view(timeline);
  const plan: FinishJob[] = [];
  const skipped: Array<{ clip: number; why: string }> = [];
  const folder = (await folderOfTimeline(s.db, { folder_id: view.folderId, project_id: view.projectId })) ?? undefined;
  for (const [i, clip] of view.clips.entries()) {
    if (b.clips && !b.clips.includes(clip.id)) continue;
    // a take's own Face pass: that take, whatever plays; else the one that plays
    const take = (b.take ? clip.takes.find((x) => x.id === b.take) : undefined) ?? clip.take;
    if (clip.kind !== "video" || !take) { skipped.push({ clip: i + 1, why: clip.kind === "still" ? "a still" : "no take yet" }); continue; }
    if (clip.job) { skipped.push({ clip: i + 1, why: "a render or a finish is on its way" }); continue; }
    if (take.finishedFrom && !b.redo && !b.take) { skipped.push({ clip: i + 1, why: "finished already" }); continue; }
    // a redo starts from the draft again, never from a finished take (an upscale of an upscale)
    const draft = (take.finishedFrom ? clip.takes.find((x) => x.id === take.finishedFrom) : undefined) ?? take;
    const from = draft.id;
    // a redo of a clip finished with these very settings: left as it is (the mock's Finish: a second one redoes only what
    // changed). Compared on the job it would queue, read as the done one is (finishKeyOf): built from the dialog's settings
    // instead, a model whose finish takes its form's own settings (SCAIL-2's Face refine denoise) was redone every time
    const before = b.redo === "changed" && !b.take && take.finishedFrom ? await finishedWith(s, clip.id, draft.id) : null;
    const push = (job: FinishJob) => {
      if (before && before === finishKeyOf(job)) skipped.push({ clip: i + 1, why: "finished already with these settings" });
      else plan.push(job);
    };
    const label = `${view.name} · clip ${i + 1} · finish`;
    // Face refine: the draft's own latent decoded as it is (nothing sampled again) and its faces redrawn, the same length and
    // frames as the draft by construction; an H3 clip only, rendered here, its latent kept
    // A model whose form has no "only" input (SCAIL-2 at 24 fps, which keeps no latent; LTX 2.5, whose latent is not H3's)
    // has its take's own frames refined instead
    const refining = b.route === "face" && clip.recipe ? s.registry.recipe(clip.recipe) : undefined;
    if (refining && refinesFaces(refining) && !refinesKeptLatent(refining)) {
      const gen = await t.generationOf(draft.asset.id);
      const towards = gen ? refinedTowards(gen.inputs) : undefined;
      if (!towards) { skipped.push({ clip: i + 1, why: gen ? "no picture of the person to refine towards (a cast person, a reference picture or the picture it opens on)" : "not rendered here: no picture of the person to refine towards" }); continue; }
      const a = draft.asset;
      // interpolated ×2 with nothing of its own frames kept (LTX's temporal upscaler, or RIFE on a model that keeps no raw file):
      // the pass runs at H3's 24 a second, and would hold the sound to twice the frames
      if ((a.fps ?? 0) > 30 && !(await s.db.selectFrom("assets").select("raw_key").where("id", "=", a.id).executeTakeFirst())?.raw_key) {
        skipped.push({ clip: i + 1, why: "interpolated to twice the frames with none of its own kept: Face refine runs at 24 a second (render it without Interpolate ×2 to refine it)" });
        continue;
      }
      // a form with H3's Face refine takes the dialog's denoise as H3's clips do; one with a start of its own (0.35 on SCAIL) its
      // own: the form's, else that default
      const denoise = defaultDenoise(refining) === FACE_DENOISE ? b.faceDenoise ?? FACE_DENOISE : typeof gen!.inputs.faceRefineDenoise === "number" ? gen!.inputs.faceRefineDenoise : defaultDenoise(refining);
      // the dialog's model, else the form's (card #204: "as each clip's form" ran the fused turbo whatever the form had picked)
      const faceModel = b.faceModel || (typeof gen!.inputs.faceRefineModel === "string" ? gen!.inputs.faceRefineModel : undefined);
      push({ kind: "cut", label, video: { width: a.width ?? null, height: a.height ?? null, durationMs: a.durationMs ?? null, fps: a.fps ?? null },
        cut: { asset: a.id, startMs: 0, endMs: a.durationMs ?? 0, action: "finish", route: "face", by: 1, faceDenoise: denoise, picture: towards, family: refining.family, ...(faceModel ? { faceModel } : {}), clip: clip.id, finishedFrom: from } });
      continue;
    }
    if (b.route === "face") {
      const why = clip.recipe && refinesFaces(s.registry.recipe(clip.recipe)) ? await keptForFinish(s, view.clips, i, draft.asset.id) : "a model that offers no Face refine: H3's, SCAIL-2 at 24 fps and LTX 2.5 do";
      if (typeof why === "string") { skipped.push({ clip: i + 1, why }); continue; }
      push({ kind: "render", recipe: why.recipe, input: { ...asDrafted(why.inputs, draft.asset), seed: why.seed, upscale: "Off", faceRefine: true, faceRefineOnly: true, faceRefineDenoise: b.faceDenoise ?? 0.45, ...faceModelOver(b) }, opts: {
        label, clip: { id: clip.id, fit: false, mirror: why.mirror }, look: clip.look ?? view.look, folder, finishedFrom: from,
      } });
      continue;
    }
    if (b.route === "latent" && resamplesLatent(clip.recipe ? s.registry.recipe(clip.recipe) : undefined)) {
      const gen = await t.generationOf(draft.asset.id);
      if (!gen) { skipped.push({ clip: i + 1, why: "not rendered here: no seed to repeat" }); continue; }
      const why = notRenderedAgain(view.clips, i, gen.inputs, s.registry.recipe(gen.recipe));
      if (why) { skipped.push({ clip: i + 1, why }); continue; }
      const kept = await s.db.selectFrom("assets").select("latent_key").where("id", "=", draft.asset.id).executeTakeFirst();
      if (!kept?.latent_key) { skipped.push({ clip: i + 1, why: "its latent was not kept (rendered before Afflatus kept them, or without its node pack): finish it with SeedVR2, RTX or a model" }); continue; }
      // with Face refine asked for, on a model that offers it: its faces redrawn in the same job, after the re-sample
      const refine = b.face && refinesFaces(s.registry.recipe(gen.recipe)) ? { faceRefine: true, faceRefineDenoise: b.faceDenoise ?? 0.45, ...faceModelOver(b) } : {};
      // the latent upscaler picked, on a form that takes one (H3's; a workflow that re-samples its own latent has no such input)
      const upscaler = b.latentModel && s.registry.recipe(gen.recipe)?.inputs.some((x) => x.id === "upscaleLatentModel") ? { upscaleLatentModel: b.latentModel } : {};
      push({ kind: "render", recipe: gen.recipe, input: { ...asDrafted(gen.inputs, draft.asset), seed: gen.seed, upscale: "Latent: re-sampled", upscaleBy: b.factor, upscaleNoise: b.latentNoise ?? 0.35, upscaleSteps: b.latentSteps ?? 3, ...refine, ...upscaler }, opts: {
        // the pictures its draft flipped are flipped again: the finish re-samples the draft, made from them as they were sent
        label, clip: { id: clip.id, fit: false, mirror: gen.mirror }, look: clip.look ?? view.look, folder, finishedFrom: from,
      } });
      continue;
    }
    const route = b.route === "latent" ? "seedvr" : b.route;
    const a = draft.asset;
    const cut: CutOptions = { asset: a.id, startMs: 0, endMs: a.durationMs ?? 0, action: "finish", route, by: b.factor, colour: b.colour, upscaleModel: b.upscaleModel, seedvrFrames: b.seedvrFrames, ...(b.seedvrModel && route === "seedvr" ? { seedvrModel: b.seedvrModel } : {}), sharpen: b.sharpen, hiddenMs: hiddenRunUp(draft.headMs), clip: clip.id, finishedFrom: from };
    // Face refine first, on a model that offers it (the rethink's Finish): its render from the draft's kept latent, then this
    // route on what it makes, queued behind it; without a kept latent, this route alone, and said
    if (b.face && clip.recipe && refinesFaces(s.registry.recipe(clip.recipe))) {
      // only H3's kept latent is redrawn in a render of its own the upscale can follow: the others' faces are redrawn on the
      // take's own frames, a finish of its own (rendered again, an LTX clip would be a new video)
      const kept = refinesKeptLatent(s.registry.recipe(clip.recipe)) ? await keptForFinish(s, view.clips, i, draft.asset.id) : "its model redraws a take's own faces in a finish of their own: Face refine it alone";
      if (typeof kept !== "string") {
        push({ kind: "render", recipe: kept.recipe, input: { ...asDrafted(kept.inputs, draft.asset), seed: kept.seed, upscale: "Off", faceRefine: true, faceRefineOnly: true, faceRefineDenoise: b.faceDenoise ?? 0.45, ...faceModelOver(b) }, opts: {
          label: `${label} · Face refine`, clip: { id: clip.id, fit: false, mirror: kept.mirror }, look: clip.look ?? view.look, folder, finishedFrom: from,
        }, then: { cut: { ...cut, faceFirst: b.faceDenoise ?? 0.45, ...(b.faceModel ? { faceFirstModel: b.faceModel } : {}) }, label } });
        continue;
      }
      skipped.push({ clip: i + 1, why: `no Face refine (${kept}): finished with ${route === "rtx" ? "RTX VSR" : route === "model" ? "the pixel model" : "SeedVR2"} alone` });
    }
    push({ kind: "cut", label, video: { width: a.width ?? null, height: a.height ?? null, durationMs: a.durationMs ?? null, fps: a.fps ?? null }, cut });
  }
  return { plan, skipped };
}

/**
 * A draft's form as a finish renders it again: with RIFE as its video has it, not as its form says (a swap drafted before
 * its RIFE ×2 was wired has "on" in its form and 24 fps in its file; rendered again with it, the finish came out at 48 fps,
 * twice its frames, 2026-10-22). A finished take keeps its draft's frames.
 */
function asDrafted(inputs: Record<string, unknown>, draft: { fps: number | null }): Record<string, unknown> {
  return "smooth" in inputs && draft.fps ? { ...inputs, smooth: draft.fps > 30 } : inputs;
}

/** Face refine's model a finish asks for, over the clip's own form's: none when the dialog leaves each clip's (card #159). */
const faceModelOver = (b: { faceModel?: string }): { faceRefineModel?: string } => (b.faceModel ? { faceRefineModel: b.faceModel } : {});

/** A recipe whose form offers Face refine (the H3 forms): its clips can be finished that way. */
/** A Face refine form's own denoise to start on (SCAIL-2's 0.35; H3's 0.45). */
const defaultDenoise = (recipe: { inputs: InputSpec[] }): number => {
  const spec = recipe.inputs.find((input) => input.id === "faceRefineDenoise");
  return spec?.type === "number" && typeof spec.default === "number" ? spec.default : 0.35;
};

/**
 * What a finish of a clip is, as a key two finishes compare on, read off the job that makes its finished take: the cut's
 * settings (after a Face refine, that it came first and at which denoise), or the render's (a latent re-sample, a Face
 * refine). One reading for a job queued and a job done (finishedWith), so the two cannot drift.
 */
function cutKey(c: CutOptions): string {
  // (its model only when one was picked: the finishes made before card #192 keep their key)
  if (c.route === "face") return JSON.stringify({ route: "face", fd: c.faceDenoise ?? 0.45, ...(c.faceModel ? { fm: c.faceModel } : {}) });
  const route = c.route ?? "seedvr";
  // (a model picked counted only when there is one: the finishes made before it keep their key; the Face refine's before the
  // cut too, as renderKey counts it on a render, or a redo with another face model said every clip finished already)
  return JSON.stringify({ route, f: c.by, colour: route === "seedvr" ? c.colour ?? "lab" : null, frames: route === "seedvr" ? c.seedvrFrames ?? 0 : null, model: route === "model" ? c.upscaleModel ?? "" : null, sharpen: c.sharpen ?? 0, face: c.faceFirst ?? null, ...(c.seedvrModel ? { sm: c.seedvrModel } : {}), ...(c.faceFirst !== undefined && c.faceFirstModel ? { fm: c.faceFirstModel } : {}) });
}
function renderKey(i: Record<string, unknown>): string | null {
  const fm = i.faceRefineModel ? { fm: i.faceRefineModel } : {};
  if (i.faceRefineOnly) return JSON.stringify({ route: "face", fd: i.faceRefineDenoise ?? 0.45, ...fm });
  if (i.upscale !== "Latent: re-sampled") return null;
  // one made before card #141 ran BasicScheduler's denoise, another schedule: no finish asked for now is the same
  const d = typeof i.upscaleNoise === "number" ? i.upscaleNoise : `simple ${i.upscaleDenoise ?? 0.15}`;
  return JSON.stringify({ route: "latent", f: i.upscaleBy, d, s: i.upscaleSteps ?? (typeof d === "number" ? 3 : 2), face: i.faceRefine ? i.faceRefineDenoise ?? 0.45 : null, ...(i.faceRefine ? fm : {}), ...(i.upscaleLatentModel ? { lm: i.upscaleLatentModel } : {}) });
}
/** The key of a finish as it would be queued: a Face refine with a cut behind it is that cut's finish. */
const finishKeyOf = (job: FinishJob): string | null => (job.kind === "cut" ? cutKey(job.cut) : job.then ? cutKey(job.then.cut) : renderKey(job.input));

/**
 * The key of the finish that made a clip's finished take of `draft` (the last done for it), or null: none found, not read,
 * or the clip changed since that finish ended (split, trimmed, given another take: what it plays is no longer what was finished).
 */
async function finishedWith(s: Services, clip: string, draft: string): Promise<string | null> {
  const row = await s.db.selectFrom("clips").select("updated_at").where("id", "=", clip).executeTakeFirst();
  const done = await s.db.selectFrom("jobs").select(["recipe_id", "inputs", "finished_from", "finished_at"]).where("clip_id", "=", clip).where("status", "=", "done").orderBy("finished_at", "desc").limit(8).execute();
  const jobs = done.filter((j) => !row || !j.finished_at || j.finished_at >= row.updated_at);
  for (const j of jobs) {
    if (j.recipe_id === CUT_JOB) {
      const c = JSON.parse(j.inputs) as CutOptions;
      if (c.action !== "finish" || c.finishedFrom !== draft) continue;
      return cutKey(c);
    }
    if (j.finished_from !== draft) continue;
    const i = JSON.parse(j.inputs) as Record<string, unknown>;
    // the Face refine a pixel route was queued behind is not the finish: its cut is
    if (i.faceRefineOnly && jobs.some((k) => k.recipe_id === CUT_JOB && (JSON.parse(k.inputs) as CutOptions).finishedFrom === draft)) continue;
    const key = renderKey(i);
    if (key) return key;
  }
  return null;
}

/** A model whose takes can have their faces redrawn from a finish: it says so in its traits (H3's forms, SCAIL-2 at 24 fps, LTX 2.5). */
const refinesFaces = (recipe: { traits?: { faceRefine?: string } | null } | undefined): boolean => Boolean(recipe?.traits?.faceRefine);
/** One whose Face refine is a render from the draft's kept latent (H3's: its form has the internal "only"); the others redraw the take's frames. */
const refinesKeptLatent = (recipe: { inputs: InputSpec[] } | undefined): boolean => Boolean(recipe?.inputs.some((input) => input.id === "faceRefineOnly"));
/** H3's Face refine denoise, the Finish dialog's own. */
const FACE_DENOISE = 0.45;

/**
 * The picture a take's own frames are refined towards, as its render would have (facePicture): the cast's (a person
 * reference), else the recipe's Picture (SCAIL's and a Motion transfer's: the person it moves), else the picture the clip
 * opened on (not one that carried on from a clip). A place, clothing, object or style picture is no face to follow.
 */
function refinedTowards(inputs: Record<string, unknown>): string | undefined {
  const refs = Array.isArray(inputs.references) ? (inputs.references as ReferenceValue[]) : [];
  const ref = refs.find((r) => r.role === "person");
  if (ref?.asset) return ref.asset;
  if (typeof inputs.picture === "string") return inputs.picture;
  return typeof inputs.start === "string" && inputs.start !== FROM_PREVIOUS && !inputs.previous ? inputs.start : undefined;
}

/**
 * The draft's generation, for a finish made from its own kept latent (Face refine), or why there is none: rendered
 * elsewhere, a continuation no longer after the clip it carried on from, or its latent not kept.
 */
async function keptForFinish(s: Services, clips: Awaited<ReturnType<Timelines["view"]>>["clips"], i: number, asset: string): Promise<NonNullable<Awaited<ReturnType<Timelines["generationOf"]>>> | string> {
  const gen = await s.timelines.generationOf(asset);
  if (!gen) return "not rendered here: no seed to repeat";
  const why = notRenderedAgain(clips, i, gen.inputs, s.registry.recipe(gen.recipe));
  if (why) return why;
  const kept = await s.db.selectFrom("assets").select("latent_key").where("id", "=", asset).executeTakeFirst();
  return kept?.latent_key ? gen : "its latent was not kept (rendered before Afflatus kept them, or without its node pack)";
}

/**
 * Why the clip at `i` cannot be finished by rendering it again (H3's latent re-sample), or null: rendered again, it makes the
 * draft again only from the same start: a continuation still after the video it carried on from (or that video's finish), a
 * clip that was not one not made into one, nothing it landed on. Otherwise it would be a new video.
 */
function notRenderedAgain(clips: Awaited<ReturnType<Timelines["view"]>>["clips"], i: number, inputs: Record<string, unknown>, recipe: Recipe<any> | undefined): string | null {
  const clip = clips[i]!;
  // the clips it joined onto, by their role in its form (H3's previous and next)
  const joined = (role: "previous" | "next") => {
    const spec = recipe?.inputs.find((x) => x.type === "clip" && x.role === role);
    return spec ? inputs[spec.id] : undefined;
  };
  const prior = i > 0 ? clips[i - 1] : undefined;
  const priorAssets = prior?.take ? [prior.take.asset.id, prior.takes.find((x) => x.id === prior.take!.finishedFrom)?.asset.id] : [];
  const carried = (joined("previous") as { asset?: string } | undefined)?.asset;
  return carried && (clip.joined !== "continue" || !priorAssets.includes(carried))
    ? "it carried on from a video that is no longer the clip before it (rejoined, moved or restored): rendered again it would be a new video. Finish it with SeedVR2, RTX or a model"
    : !carried && clip.joined === "continue" && prior
      ? "it was not made as a continuation of the clip before: rendered again as one it would be a new video. Finish it with SeedVR2, RTX or a model"
      : joined("next")
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
