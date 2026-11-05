import { z } from "zod";
import { OWN_MODEL, hiddenRunUp, resamplesLatent, type InputSpec, type Recipe, type ReferenceValue } from "@afflatus/core";
import { CUT_JOB } from "./timelineModel";
import { folderOfTimeline } from "./timelineFolder";
import type { Services } from "./services";
import { FROM_PREVIOUS, type CutOptions, type Timelines } from "./timelines";

/**
 * Finish's plan: the jobs that bring a timeline's clips to their final quality (an upscale route, H3's latent re-sample, a
 * Face refine), the clips it skips and why, and the key a redo compares a clip's finish on. The routes and MCP queue them.
 */

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
export async function finishEstimate(s: Services, timeline: string, b: z.infer<typeof finishBody>): Promise<number | null> {
  const { plan } = await finishPlan(s, timeline, b);
  if (!plan.length) return null;
  // a render is forecast as its job will be built (on its draft, with what its clip joins onto); a finish on the GPU frees the model for the render after it
  return (await s.queue.total(plan.flatMap((j) => (j.kind === "render" ? [{ recipe: j.recipe, input: j.input, finishedFrom: j.opts?.finishedFrom, clip: j.opts?.clip ? { id: j.opts.clip.id, fit: j.opts.clip.fit } : null }, ...(j.then ? [{ recipe: CUT_JOB, input: j.then.cut }] : [])] : [{ recipe: CUT_JOB, input: j.cut }])))).ms;
}

/** The jobs a finish would queue, in order, and the clips skipped with why: nothing is queued here. */
/**
 * Finish asked of a timeline, by its dialog or MCP's finish: looked at and queued one request at a time, as an export is (two
 * quick Finish clicks queued two finishes of each clip), the timeline told it changed. `check`: what the asker refuses or
 * says of the plan before anything is queued (MCP's money rules); what it gives comes back as `checked`.
 */
export async function finishTimeline<T = undefined>(
  s: Services, timeline: string, b: z.infer<typeof finishBody>,
  by: { mcpToken?: string; check?: (plan: FinishJob[], skipped: Array<{ clip: number; why: string }>) => Promise<T> } = {},
): Promise<{ jobs: string[]; skipped: Array<{ clip: number; why: string }>; clips: number; checked?: T }> {
  const out = await s.timelines.history.oneAtATime(`finish:${timeline}`, async () => {
    const { plan, skipped } = await finishPlan(s, timeline, b);
    const checked = by.check ? await by.check(plan, skipped) : undefined;
    const done = await finishClips(s, plan, skipped, by.mcpToken ? { mcpToken: by.mcpToken } : {});
    return { ...done, clips: plan.length, ...(checked !== undefined ? { checked } : {}) };
  });
  s.queue.events.emit("timeline");
  return out;
}

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
      // its steps carried as its model is: the form's typed ones (12 on a full model ran the full model's 10), unless Finish
      // picked another model, whose steps the form's were not typed for (0 is "by model")
      const faceSteps = !b.faceModel && typeof gen!.inputs.faceRefineSteps === "number" && gen!.inputs.faceRefineSteps > 0 ? gen!.inputs.faceRefineSteps : undefined;
      push({ kind: "cut", label, video: { width: a.width ?? null, height: a.height ?? null, durationMs: a.durationMs ?? null, fps: a.fps ?? null },
        cut: { asset: a.id, startMs: 0, endMs: a.durationMs ?? 0, action: "finish", route: "face", by: 1, faceDenoise: denoise, picture: towards, family: refining.family, ...(faceModel ? { faceModel } : {}), ...(faceSteps ? { faceSteps } : {}), clip: clip.id, finishedFrom: from } });
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
  if (c.route === "face") return JSON.stringify({ route: "face", fd: c.faceDenoise ?? 0.45, ...(c.faceModel ? { fm: c.faceModel } : {}), ...(c.faceSteps ? { fs: c.faceSteps } : {}) });
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
