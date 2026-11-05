import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { CUT_WINDOW_MOST, RANDOM_SEED, TRANSITION_KINDS, TRANSITION_MS, movedSeed, typedSeed } from "@afflatus/core";
import { nameOf } from "./autoName";
import { VERSION } from "./config";
import { CutError } from "./cut";
import { musicTrack } from "./exportJoin";
import { outgoingFile } from "./outgoing";
import { now } from "./db";
import { httpError } from "./errors";
import { compose, lookSchema, withMood } from "./entities";
import { spreadSaid } from "./timelineFace";
import { askedOf } from "./jobs-api";
import { assetView } from "./media";
import { rifeModelIn } from "./queue";
import { rootFolderOf } from "./projects";
import { inUse } from "./sweep";
import { folderOfTimeline } from "./timelineFolder";
import { fcp7Xml, otioJson, projectPlan, projectReadme } from "./timelineProject";
import { ownInputIds } from "./timelinePlan";
import { sourcePatch } from "./timelineSource";
import { finishBody, finishClips, finishEstimate, finishPlan } from "./timelineFinish";
import { ZipStream } from "./zipStream";
import type { Services } from "./services";
import { clockOf, FROM_PREVIOUS } from "./timelines";

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
export function sent<V extends { clips: Array<{ take: { id: string } | null; takes: Array<{ made: unknown }>; chat: unknown[] }> }>(view: V) {
  // what each take was made with and the clip's designer conversation are read for one clip when it is shown (GET
  // /api/clips/:id/made and /chat): with every read of the timeline they were 70 % of it (card #242, 234 KB of 336)
  return {
    ...view,
    clips: view.clips.map(({ chat: _chat, ...c }) => ({ ...c, take: c.take?.id ?? null, takes: c.takes.map(({ made: _made, ...x }) => x) })),
  };
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
  app.get<{ Params: { id: string } }>("/api/timelines/:id", async (req) => sent(await t.view(req.params.id, { made: false })));
  /** The music ducked under speech: its gain along the timeline (duck.ts), for the player; null when there is no music or it is not ducked. */
  app.get<{ Params: { id: string } }>("/api/timelines/:id/duck", async (req) => ({ curve: await t.duck(req.params.id) }));
  app.patch<{ Params: { id: string } }>("/api/timelines/:id", async (req) => sent(await t.edit(req.params.id, timelinePatch.parse(req.body))));
  /** Its source lane's stretch made into clips, window by window (timelineSource.ts): the new clips' ids, to be rendered by the editor. */
  // `again`: the source cut again into the clips it made, those rendered kept (TimelineSource.makeFromSource)
  app.post<{ Params: { id: string } }>("/api/timelines/:id/source/make", async (req) => ({ clips: await t.source.makeFromSource(req.params.id, z.strictObject({ again: z.boolean().optional() }).parse(req.body ?? {})) }));
  // the source's stretch trimmed after Make: its end in or out (windows set aside and brought back), its start moved (made anew)
  app.post<{ Params: { id: string } }>("/api/timelines/:id/source/trim", async (req) => t.source.trimSource(req.params.id, z.strictObject({ fromMs: z.number().min(0), toMs: z.number().min(0) }).parse(req.body)));
  // a recording's clips trimmed: its end in (clips go) or out (clips added at its pauses), its start moved (made anew)
  app.post<{ Params: { id: string } }>("/api/timelines/:id/recording/trim", async (req) => t.recording.trimRecording(req.params.id, z.strictObject({ asset: z.string().min(1), fromMs: z.number().min(0), toMs: z.number().min(0) }).parse(req.body)));
  // a recording's clips cut again at another length or window (its panel: TimelineRecording.cutRecording)
  app.post<{ Params: { id: string } }>("/api/timelines/:id/recording/cut", async (req) => t.recording.cutRecording(req.params.id, z.strictObject({ asset: z.string().min(1), seconds: z.number().min(1).max(60), window: z.number().min(0).max(CUT_WINDOW_MOST) }).parse(req.body)));
  // what a recording's clips share, given to all of them at once (its panel's Shared by its clips: TimelineRecording.recordingForm)
  app.post<{ Params: { id: string } }>("/api/timelines/:id/recording/form", async (req) => {
    const clips = await t.recording.recordingForm(req.params.id, z.strictObject({ asset: z.string().min(1), inputs: z.record(z.string(), z.unknown()) }).parse(req.body));
    return { ok: true, clips };
  });
  // the form a recording's new clips are made in, Lip sync or one it plays over (its panel's New clips: Timelines.recordingNewClips)
  app.post<{ Params: { id: string } }>("/api/timelines/:id/recording/new-clips", async (req) => {
    await t.recording.recordingNewClips(req.params.id, z.strictObject({ asset: z.string().min(1), recipe: z.string().min(1) }).parse(req.body));
    return { ok: true };
  });
  // a voice recording made into Lip sync clips cut at its pauses, in place of an empty clip or at the end (TimelineRecording.makeFromRecording)
  app.post<{ Params: { id: string } }>("/api/timelines/:id/recording", async (req) => ({ clips: await t.recording.makeFromRecording(req.params.id, z.strictObject({ asset: z.string().min(1), clip: z.string().optional(), seconds: z.number().min(1).max(60).optional() }).parse(req.body)) }));
  // the source given another windowed form: in place on the same grid (its windows and takes kept), else made anew (TimelineSource.sourceForm)
  app.post<{ Params: { id: string } }>("/api/timelines/:id/source/form", async (req) => t.source.sourceForm(req.params.id, z.strictObject({ recipe: z.string().min(1) }).parse(req.body).recipe));
  // one window of the source given another form of its grid, in place (TimelineSource.windowForm, card #42)
  app.post<{ Params: { id: string } }>("/api/timelines/:id/source/window", async (req) => {
    const { clip, recipe } = z.strictObject({ clip: z.string().min(1), recipe: z.string().min(1) }).parse(req.body);
    await t.source.windowForm(req.params.id, clip, recipe);
    return { ok: true };
  });
  /** The source split at a moment of it: the part before, from its stretch's start, a clip playing it as it is. */
  app.post<{ Params: { id: string } }>("/api/timelines/:id/source/split", async (req) => ({ clip: await t.source.splitSource(req.params.id, z.strictObject({ atMs: z.number().min(0) }).parse(req.body).atMs) }));
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
  /** What each H3 clip with a person's picture does with it (card #223): carried on by Face refine, or sampled with it. */
  app.get<{ Params: { id: string } }>("/api/timelines/:id/face", async (req) => ({ clips: await t.face.routes(req.params.id) }));
  /** Use this one on them too: a clip's changed person picture given to the clips after it that still have the old one. */
  app.post<{ Params: { id: string } }>("/api/clips/:id/face/spread", async (req) => {
    const done = await t.face.spread(req.params.id);
    return { ...done, said: spreadSaid(done) };
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
        // a render (or a frame, cut or edit of one) goes in marked as made by a model, a PNG as a Download gives it (outgoing.ts)
        const rows = await s.db.selectFrom("assets").select(["file_key", "kind", "mime", "origin", "source_id", "generation_id", "width", "height"]).where("file_key", "in", [...files.values()]).execute();
        const byKey = new Map(rows.map((r) => [r.file_key, r]));
        // the model hashes read once for the whole zip, not once a picture
        const reads = {};
        for (const [path, key] of files) {
          if (req.raw.destroyed) break;
          const a = byKey.get(key);
          const out = a ? await outgoingFile(s, a, reads) : null;
          const f = out ?? { ...(await s.storage.open(key)), done: async () => {} };
          try {
            await zip.add(path, f.stream, new Date(), f.size);
          } finally {
            // a video's marked copy, read as it goes in, then removed: one file in memory at a time held 800 MB
            await f.done();
          }
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

  /** What each take of a clip was made with, by take id (its Made; null for one rendered nowhere here): its take list's. */
  app.get<{ Params: { id: string } }>("/api/clips/:id/made", async (req) => ({ takes: await t.madeOfClip(req.params.id) }));
  /** A clip's conversation with the designer, read as the designer opens on it. */
  app.get<{ Params: { id: string } }>("/api/clips/:id/chat", async (req) => ({ chat: await t.chatOf(req.params.id) }));
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
 * Served to be kept by the browser for a year when the address names the file's version (`?v=`, which changes when a linked
 * file is written again), else checked again each time: what is worked out of a video is made again when its file changes.
 */
function cached(req: FastifyRequest, reply: FastifyReply): FastifyReply {
  const versioned = z.object({ v: z.string().optional() }).parse(req.query ?? {}).v !== undefined;
  return reply.header("Cache-Control", versioned ? "private, max-age=31536000, immutable" : "private, no-cache");
}
