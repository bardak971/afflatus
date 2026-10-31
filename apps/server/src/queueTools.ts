import { randomUUID } from "node:crypto";
import { ComfyCancelled, detect, waitForOutputs, type Measured, type OutputFile } from "@afflatus/comfy";
import { choicesOf, GraphBuilder, OWN_MODEL, TOOLS_FAMILY, type BuildContext, type Ref } from "@afflatus/core";
import { AUDIO_LOCK, FACE_REFINE_NODES, faceModelOf, faceRefined, faceRefineNeeds, faceRefineSkipped, pixelUpscale, RTX_NODES, saveVideo, sharpened, UPSCALE, upscaleNodes } from "@afflatus/recipes";
import type { Comfy } from "./comfy";
import { slowSoundOnto } from "./cut";
import { finishedName, nameOf } from "./autoName";
import { now, type Db, type Tables } from "./db";
import { extOf } from "./media";
import type { VideoFacts } from "./video";
import { folderForMade, timelineOfClip } from "./timelineFolder";
import { paceOn, recordTool, toolPace, toolPaces, type ToolPaces } from "./renders";
import type { CutOptions, ExportOptions, Timelines } from "./timelines";
import { CUT_JOB } from "./timelineModel";
import { Died, GPU_AT_WORK, readJson, SHUTDOWN, Stuck, type JobRow, type QueueCore, type Running } from "./queueModel";
import { rawFactsOf, resentFor, sentOnce, taken } from "./queueSubmit";
import { ANY_PACKS, asBuilt, inputsIn, optionsIn, packsSaid, ranWithoutSaid } from "./jobPacks";

/** The jobs that need no model of their own: a cut (a copy, a split, a slow-motion, a finish) and an export, done by ffmpeg, with ComfyUI only for RIFE and the upscale routes. */

type AssetRow = Tables["assets"];

/** The RIFE model this ComfyUI offers for frame interpolation, when it has one. */
export function rifeModelIn(catalog: Record<string, unknown>): string | null {
  const node = catalog["FrameInterpolationModelLoader"] as { input?: { required?: Record<string, unknown> } } | undefined;
  return pickRife(choicesOf(node?.input?.required?.model_name) ?? []);
}

/** The RIFE model among a machine's frame interpolation files: what a finish runs, and what a pod is said to have of it. */
export const pickRife = (files: readonly string[]): string | null => files.find((f) => /rife/i.test(f)) ?? files[0] ?? null;

/** A tool run as the record keeps it: what it is, what it makes (pixels × frames) and what its own record expected of it. */
/** `comfy`: the machine it ran on, once it is sent there, for what its GPU drew (power.ts). */
interface ToolNote { row: JobRow; recipe: string; model: string; timeKey: string; work: number | null; expectedMs: number | null; startedAt: number; measured: Measured | null; comfy?: Comfy }

/** Its usual pace × what it makes: what it should take on its machine, from its own record (null until it has run once). */
async function toolNote(core: QueueCore, row: JobRow, recipe: string, model: string, timeKey: string, work: number | null): Promise<ToolNote> {
  const machinePace = core.machineId ? (await core.paces().catch(() => new Map<string, number>())).get(core.machineId) ?? 1 : 1;
  const pace = work ? await toolPace(core.db, recipe, core.machineId, machinePace).catch(() => null) : null;
  return { row, recipe, model, timeKey, work, expectedMs: pace && work ? Math.round(pace * work) : null, startedAt: Date.now(), measured: null };
}

/** The route a finish runs on, as its record names it (`tool.finish.<route>`): H3's latent re-sample is a render; a clip it cannot re-sample takes SeedVR2. */
const finishRoute = (route: string | undefined) => (route === "rtx" ? "rtx" : route === "model" ? "model" : route === "face" ? "face" : "seedvr");

/**
 * What a finish should take, from its route's own past finishes: the usual pace × what it makes (the video `by` times its
 * size, its frames past a continuation's hidden run-up, which is enlarged plainly). The one place this is worked out: the
 * Finish dialog, the waiting list and the running finish read it. Null until the route has finished something here.
 * `paces` keeps each route's pace for a list of finishes. `on`: on that machine, from its own finishes, else every
 * machine's at its pace (renders.ts toolPace); left out, every machine's as they are.
 */
export async function finishForecast(
  db: QueueCore["db"], video: { width: number | null; height: number | null; durationMs: number | null; fps: number | null },
  o: Pick<CutOptions, "route" | "by" | "hiddenMs">, paces = new Map<string, Promise<ToolPaces | null>>(), on: { machine: string; pace: number } | null = null,
): Promise<number | null> {
  const by = o.by ?? 2;
  const frames = Math.round((Math.max(0, (video.durationMs ?? 0) - (o.hiddenMs ?? 0)) / 1000) * (video.fps ?? 24));
  const work = Math.round((video.width ?? 0) * by) * Math.round((video.height ?? 0) * by) * Math.max(1, frames);
  if (!work) return null;
  const tool = `tool.finish.${finishRoute(o.route)}`;
  if (!paces.has(tool)) paces.set(tool, toolPaces(db, tool).catch(() => null));
  const read = await paces.get(tool)!;
  const pace = read ? paceOn(read, on?.machine ?? null, on?.pace ?? 1) : null;
  return pace ? Math.round(pace * work) : null;
}

/**
 * How a tool's run that did not finish is put on record: stopped by the user, cancelled; ended by its ComfyUI's death or as
 * stuck, a failure, as a render's is (Queue › Costs said a slow motion a pod's crash ended "cancelled").
 */
export const toolEnd = (signal: AbortSignal): "failed" | "cancelled" => (signal.aborted && !(signal.reason instanceof Died || signal.reason instanceof Stuck) ? "cancelled" : "failed");

/** Put a tool's run on the record (never lets a failure here reach the job). */
async function noteTool(core: QueueCore, note: ToolNote, status: "done" | "failed" | "cancelled", made: { id: string; width: number | null; height: number | null; duration_ms: number | null } | null) {
  const end = Date.now();
  const energy = note.comfy?.home ? note.comfy.power.energy(note.startedAt, end) : null;
  await recordTool(core.db, { id: note.row.id, created_at: note.row.created_at, startedAt: note.startedAt }, note, note.measured, status, end - note.startedAt,
    { assetId: made?.id ?? null, width: made?.width ?? null, height: made?.height ?? null, durationMs: made?.duration_ms ?? null }, note.work, note.expectedMs, core.machineId, energy).catch(() => {});
}

/**
 * A tool's graph sent to ComfyUI and followed like a render's: the status strip then says which step runs (SeedVR2 restore,
 * frame interpolation, encoding) and how far it is, where it said "Queued on ComfyUI" and "working…" all along.
 * Its prompt id is saved on the job before it is sent, as a render's is (Resume.unsent): the job run again after a restart
 * follows the prompt ComfyUI still has (running, waiting or done) instead of running the finish on the GPU a second time.
 */
/**
 * A family's files for a tool, as the setup page finds them by name: from the scan kept of that ComfyUI, a folder listed only
 * for a slot it has nothing for (a finish listed a folder per slot, one after the other, while the GPU waited). Taken from
 * the scan only when it is the file the slot's patterns name in ComfyUI's own list, as a listing would give it: never a
 * .gguf (another pack's list) nor one found by its weights.
 */
async function toolSlots(core: QueueCore, comfy: Comfy, family: string, which: (slot: { id: string }) => boolean): Promise<Record<string, string>> {
  // the scan as kept, never one made for this: a whole scan lists every folder
  const kept = (await comfy.scanKept()?.catch(() => null))?.families.find((f) => f.id === family)?.slots ?? [];
  const slots: Record<string, string> = {};
  await Promise.all((core.registry.family(family)?.slots ?? []).filter(which).map(async (slot) => {
    const auto = kept.find((s) => s.id === slot.id && s.folder === slot.folder)?.auto;
    const hit = auto && !/\.gguf$/i.test(auto) && detect([auto], slot.detect) ? auto : detect(await comfy.client.models(slot.folder).catch(() => [] as string[]), slot.detect);
    if (hit) slots[slot.id] = hit;
  }));
  return slots;
}

async function followed(core: QueueCore, comfy: Comfy, run: Running, row: Pick<JobRow, "id" | "resume">, g: GraphBuilder, outNode: string, loads: string[] = [], note?: ToolNote, resend: Array<() => Promise<string>> = []) {
  const signal = run.abort.signal;
  const sent = readJson<{ promptId?: unknown }>(row.resume, {}).promptId;
  const again = typeof sent === "string" && (await taken(comfy, sent).catch(() => false)) ? sent : null;
  // its models alone in the GPU's memory: a render's model left loaded (H3 is 12 GB) made SeedVR2 spill into system memory and
  // crawl (a 6-minute clip past 20 minutes at a quarter of the card's power, 2026-10-08). Freed when something else is loaded,
  // as a render does; the render after this is told the tool's files were last, so it frees them in turn. Not under its
  // own prompt, followed again: ComfyUI may be running it
  const wanted = `tool|${[...loads].sort().join("|")}`;
  if (!again && core.lastLoads !== wanted) {
    await comfy.client.free().catch(() => {});
    await core.loaded(wanted, null);
  }
  const keep = (promptId: string) => core.db.updateTable("jobs").set({ resume: JSON.stringify({ promptId }), updated_at: now() }).where("id", "=", row.id).execute();
  let promptId = again;
  if (!promptId) {
    const chosen = randomUUID();
    await keep(chosen);
    // a ComfyUI from before prompt ids could be chosen gives one of its own: that one is kept and followed
    // a file taken as there already (sentOnce) that ComfyUI no longer has: sent again, and the prompt goes once more
    promptId = await comfy.client.submit(g.graph, { promptId: chosen, outputs: [outNode] }).catch(async (err: unknown) => {
      if (!(await resentFor(err, resend, signal))) throw err;
      return comfy.client.submit(g.graph, { promptId: chosen, outputs: [outNode] });
    });
    if (promptId !== chosen) await keep(promptId);
  }
  run.promptId = promptId;
  // what it should take, for the "spilling" warning while it runs
  if (note) {
    note.startedAt = Date.now();
    run.expectedMs = note.expectedMs;
    run.startedAt = note.startedAt;
  }
  comfy.monitor.ensure();
  comfy.monitor.track({ promptId, totalSteps: 1, phases: g.phases });
  // its GPU's power read on its progress, as a render's is (queue.ts)
  if (note) note.comfy = comfy;
  // moved by what ComfyUI says of it and by its GPU at work, as a render is: on a rented pod, one that hangs is stuck past
  // its limit (queue.ts quietFor), not billed up to the whole wait
  run.startedAt ??= Date.now();
  run.movedAt = Date.now();
  comfy.monitor.onSystem = (load) => {
    void comfy.readPower();
    if (load.gpus.some((g) => g.load !== undefined)) run.loadAt = Date.now();
    if (load.gpus.some((g) => (g.load ?? 0) >= GPU_AT_WORK)) run.movedAt = Date.now();
  };
  comfy.monitor.onChange = () => {
    void comfy.readPower();
    run.movedAt = Date.now();
    core.events.emit("progress");
  };
  try {
    return await awaitPrompt(comfy, promptId, outNode, signal, core.opts.wait);
  } catch (err) {
    if (note) {
      note.measured = comfy.monitor.measured(promptId);
      await noteTool(core, note, toolEnd(signal), null);
    }
    throw err;
  } finally {
    if (note && !note.measured) note.measured = comfy.monitor.measured(promptId);
    comfy.monitor.untrack(promptId);
  }
}

/** A cut job's options; null for a row whose inputs cannot be read. */
export const cutOptionsOf = (row: Pick<JobRow, "inputs">): CutOptions | null => readJson<CutOptions | null>(row.inputs, null);

/**
 * Whether a take was interpolated: its render's own frames, kept beside it (raw_key), run at half its rate or less. A finish
 * of it upscales those frames and runs RIFE again after, so it needs a RIFE model where it runs.
 */
export const interpolatedFrom = (video: Pick<AssetRow, "fps">, rawFacts: { width?: number; fps?: number } | null): boolean =>
  Boolean(rawFacts?.width && rawFacts.fps) && (video.fps ?? 24) > rawFacts!.fps! * 1.5;

/**
 * The model files a finish or a RIFE slow-motion loads, from its settings and its take, before it runs: what a rented pod is
 * sent for it, and only for it (jobFiles.ts). `upscaleModel` "": whichever upscale model the machine has. Null for a cut that
 * loads none, or a take not in the library.
 */
export interface ToolNeeds {
  rife: boolean;
  seedvr: boolean;
  upscaleModel: string | null;
  /** SeedVR2's model picked for the finish (card #159), in place of the family's. */
  seedvrModel?: string;
  /** The node classes it cannot run without; `anyNode`: one of these at least (RTX VSR: NVIDIA's pack or DaSiWa's). */
  nodes: string[];
  anyNode?: string[];
  /**
   * Face refine's files (a Finish › Face refine of a take that keeps no latent): the family it is had from, its slots, and the
   * H3 model picked in place of its fused turbo's slot (card #192).
   */
  face?: { family: string; slots: string[]; model?: string };
}

/** Something a tool job did less well than asked, said on the job as a render's is (queue.ts warn). */
async function warnJob(db: Db, id: string, text: string): Promise<void> {
  console.warn(`[queue] job ${id}: ${text}`);
  const had = (await db.selectFrom("jobs").select("warning").where("id", "=", id).executeTakeFirst())?.warning;
  if (had?.includes(text)) return;
  await db.updateTable("jobs").set({ warning: had ? `${had} ${text}` : text, updated_at: now() }).where("id", "=", id).execute();
}

/** The nodes RIFE runs on, a slow-motion's and an interpolated take's finish's. */
const RIFE_NODES = ["FrameInterpolationModelLoader", "FrameInterpolate"];
/** What a RIFE slow-motion runs on: its video in, RIFE, its video out. */
const SLOW_NODES = ["LoadVideo", "GetVideoComponents", ...RIFE_NODES, "VHS_VideoCombine"];
export async function toolNeeds(core: Pick<QueueCore, "db" | "storage">, row: Pick<JobRow, "recipe_id" | "inputs">): Promise<ToolNeeds | null> {
  if (!usesGpu(row)) return null;
  const opts = cutOptionsOf(row)!;
  if (opts.action === "slow") return { rife: true, seedvr: false, upscaleModel: null, nodes: SLOW_NODES };
  const video = await core.db.selectFrom("assets").select(["fps", "mime", "raw_key", "has_sound"]).where("id", "=", opts.asset).executeTakeFirst();
  if (!video) return null;
  const route = opts.route ?? "seedvr";
  const rife = interpolatedFrom(video, await rawFactsOfTake(core, video));
  // Face refine (runFaceFinish): its own pack's nodes, offered for install where they lack as a render's are, the audio lock
  // that holds the take's sound, and its family's files. It fell to SeedVR2's nodes, and asked for neither its pack nor its files
  if (route === "face") {
    return {
      rife, seedvr: false, upscaleModel: null, nodes: ["LoadVideo", "GetVideoComponents", ...FACE_REFINE_NODES, ...(video.has_sound ? [AUDIO_LOCK] : []), ...(rife ? RIFE_NODES : [])],
      ...(opts.family ? { face: { family: opts.family, slots: faceRefineNeeds({ faceRefine: true, ...faceModelAsked(opts) }, { own: true, picture: Boolean(opts.picture) }), ...(pickedFace(opts) ? { model: pickedFace(opts) } : {}) } } : {}),
    };
  }
  const upscale = route === "rtx" ? UPSCALE.rtx : route === "model" ? UPSCALE.model : UPSCALE.seedvr;
  return {
    rife, seedvr: route === "seedvr", upscaleModel: route === "model" ? opts.upscaleModel || "" : null, ...(route === "seedvr" && opts.seedvrModel ? { seedvrModel: opts.seedvrModel } : {}),
    nodes: ["LoadVideo", "GetVideoComponents", ...upscaleNodes({ upscale }), ...(rife ? RIFE_NODES : [])], ...(route === "rtx" ? { anyNode: RTX_NODES } : {}),
  };
}

/** What a take's kept frames are (size, rate): queueSubmit's, read once per file in place by ffprobe alone (card #119, U3). */
function rawFactsOfTake(core: Pick<QueueCore, "storage">, video: Pick<AssetRow, "raw_key" | "mime">): Promise<VideoFacts | null> {
  return video.raw_key ? rawFactsOf(core.storage, video.raw_key, video.mime) : Promise.resolve(null);
}

/** Whether a tool job runs on ComfyUI's GPU (a finish, a RIFE slow-motion): it waits for ComfyUI and for the end of a pause, as a render does. */
export function usesGpu(row: Pick<JobRow, "recipe_id" | "inputs">): boolean {
  if (row.recipe_id !== CUT_JOB) return false;
  const opts = cutOptionsOf(row);
  return opts?.action === "finish" || (opts?.action === "slow" && opts.engine === "rife");
}

/** Why a finish cut queued behind a Face refine (`fromJob`) cannot run: said by it, and by the queue when that job fails first. */
export const FACE_REFINE_NOT_ENDED = "the Face refine it was to finish did not end: nothing to finish";

/** A cut: ffmpeg on the computer Afflatus runs on, like an export; a finish and a RIFE slow-motion through ComfyUI. */
export function runCut(core: QueueCore, row: JobRow): Promise<void> {
  return core.runTool(row, async (run) => {
    const opts = cutOptionsOf(row);
    if (!opts) throw new Error("this job's settings cannot be read");
    const clips = core.clips;
    if (!clips) throw new Error("timelines are not available");
    // after a job of the same clip (Face refine first): that job's video, which did not exist when this one was queued
    const made = opts.fromJob ? await core.db.selectFrom("jobs").select(["generation_id", "status"]).where("id", "=", opts.fromJob).executeTakeFirst() : null;
    if (opts.fromJob && (!made?.generation_id || made.status !== "done")) throw new Error(FACE_REFINE_NOT_ENDED);
    const assetId = made?.generation_id ? ((await core.db.selectFrom("assets").select("id").where("generation_id", "=", made.generation_id).where("kind", "=", "video").executeTakeFirst())?.id ?? opts.asset) : opts.asset;
    const video = await core.db.selectFrom("assets").selectAll().where("id", "=", assetId).executeTakeFirst();
    // a sound is cut too (copy, split, remove)
    if (!video || (video.kind !== "video" && !(video.kind === "audio" && (opts.action === "copy" || opts.action === "split" || opts.action === "remove")))) throw new Error("that video is no longer in your library");
    // what it makes lands in the folder of the timeline it is made in: its clip's, the one named, else see folderForMade
    const folder = await folderForMade(core.db, video, (await timelineOfClip(core.db, opts.clip)) ?? opts.timeline);
    if (opts.action === "finish" && opts.route === "face") await runFaceFinish(core, row, run, clips, video, opts, folder);
    else if (opts.action === "finish") await runFinish(core, row, run, clips, video, opts, folder);
    else if (opts.action === "slow" && opts.engine === "rife") await runSlowRife(core, row, run, clips, video, opts, folder);
    else if (opts.action === "slow") await runSlowFfmpeg(core, row, run, clips, video, opts, folder);
    else await clips.range.cutRange(video, opts.startMs, opts.endMs, opts.action, { crf: opts.crf, even: opts.even, signal: run.abort.signal, folder });
  });
}

/** The whole video up to ComfyUI, the upscale route run on its frames (the sound passed through), the result back as a video. */
async function runFinish(core: QueueCore, row: JobRow, run: Running, clips: Timelines, video: AssetRow, opts: CutOptions, folder: string | null): Promise<void> {
  const made = (await madeBefore(core, row)) ?? (await makeOnce(core, row, async () => {
    const comfy = await core.comfy();
    const catalog = await comfy.catalog();
    // SeedVR2's two files, found by name as the setup page finds them
    const slots = await toolSlots(core, comfy, TOOLS_FAMILY, (x) => x.id === "seedvr" || x.id === "seedvrVae");
    const route = opts.route === "rtx" ? UPSCALE.rtx : opts.route === "model" ? UPSCALE.model : UPSCALE.seedvr;
    let upscaleModel = opts.upscaleModel || "";
    if (route === UPSCALE.model && !upscaleModel) {
      upscaleModel = (await comfy.client.models("upscale_models").catch(() => [] as string[]))[0] ?? "";
      if (!upscaleModel) throw new Error("No upscale model in ComfyUI's models/upscale_models folder: put one there (2xNomosUni_span_multijpg, RealESRGAN_x2plus), or finish with SeedVR2.");
    }
    run.gpu = true;
    // from the model's own frames whenever they were kept (the raw side file of a take its render interpolated or enlarged): an
    // upscale of what the model made, not of an upscale, and for an interpolated take half the frames, RIFE run again after.
    // The factor is on the draft's own size: ×2 is twice what plays, whichever file the frames come from
    const raw = video.raw_key ? await core.storage.get(video.raw_key).catch(() => null) : null;
    const rawFacts = raw ? await rawFactsOfTake(core, video) : null;
    const fromRaw = Boolean(raw && rawFacts?.width && rawFacts.fps);
    const doubled = fromRaw && interpolatedFrom(video, rawFacts);
    const rife = doubled ? rifeModelIn(catalog) : null;
    if (doubled && !rife) throw new Error("This take was interpolated, and ComfyUI has no RIFE model left to interpolate the finished frames again (models/frame_interpolation).");
    const source = fromRaw ? { width: rawFacts!.width, height: rawFacts!.height } : { width: video.width ?? 0, height: video.height ?? 0 };
    const by = (opts.by ?? 2) * (fromRaw && video.width ? video.width / source.width : 1);
    // under its content's name, once to each ComfyUI, as a render's files: a take enlarged again is not sent again
    const resend: Array<() => Promise<string>> = [];
    const file = await sentOnce(comfy, fromRaw ? raw! : await core.storage.get(video.file_key), extOf(video.mime), (bytes, ext, o) => comfy.client.upload(bytes, ext, o), resend);
    const g = new GraphBuilder();
    const parts = g.add("GetVideoComponents", { video: g.out("LoadVideo", { file }) });
    // RTX VSR done without where its pack is not there (not installable, or Run without): an upscale model instead, said on the job
    const options = asBuilt(catalog, (await core.packFacts?.().catch(() => null)) ?? ANY_PACKS, packsSaid(row));
    // the card's memory: SeedVR2's window is the widest it holds
    const vram = await comfy.vram?.();
    const ctx: BuildContext = { seed: Math.floor(Math.random() * 2 ** 31), slots, uploads: {}, media: {}, has: (n: string) => n in catalog, options: optionsIn(catalog), inputs: inputsIn(catalog), wants: options.wants, ...(vram ? { vram } : {}) };
    // a continuation's hidden run-up (hiddenRunUp) is not restored: its frames are enlarged plainly to the restored size and
    // put back in front, so that the file keeps every frame, its length and its joins' timing. Counted on the source's own frames
    const sourceFps = fromRaw ? rawFacts!.fps : video.fps ?? 24;
    const skip = Math.max(0, Math.floor(((opts.hiddenMs ?? 0) * sourceFps) / 1000));
    const frames: Ref = [parts, 0];
    const restore: Ref = skip ? g.out("ImageFromBatch", { image: frames, batch_index: skip, length: 4096 }) : frames;
    const done = pixelUpscale(g, restore, { upscale: route, upscaleBy: by, upscaleModel, upscaleColour: opts.colour, seedvrFrames: opts.seedvrFrames ?? 0, ...(opts.seedvrModel ? { seedvrModel: opts.seedvrModel } : {}) }, source, ctx);
    for (const { w, why } of options.without) await warnJob(core.db, row.id, ranWithoutSaid(w, why));
    let restored: Ref = done.images;
    if (skip) {
      g.phase("upscaling");
      const size = g.add("GetImageSize", { image: done.images });
      const plain = g.out("ImageScale", { image: g.out("ImageFromBatch", { image: frames, batch_index: 0, length: skip }), upscale_method: "lanczos", width: [size, 0], height: [size, 1], crop: "disabled" });
      restored = g.out("ImageBatch", { image1: plain, image2: done.images });
    }
    if (rife) g.phase("interpolating");
    const smooth: Ref = rife ? g.out("FrameInterpolate", { interp_model: g.out("FrameInterpolationModelLoader", { model_name: rife }), images: restored, multiplier: 2 }) : restored;
    // RCAS on the final frames, as a form's finish does it (finishFrames): nothing at 0 or without KJNodes
    const images = sharpened(g, ctx, smooth, { upscale: route, upscaleSharpen: opts.sharpen ?? 0 });
    g.phase("encoding");
    const outNode = saveVideo(g, ctx, { images, ...(video.has_sound ? { audio: [parts, 1] as Ref } : {}), fps: video.fps ?? 24, crf: 16 });
    // on the record as a tool of its own: the route, the factor, what it makes (the frames past the hidden run-up are what the route restores)
    const outFrames = Math.round((Math.max(0, (video.duration_ms ?? 0) - (opts.hiddenMs ?? 0)) / 1000) * (video.fps ?? 24));
    const routeKey = finishRoute(opts.route);
    const note = await toolNote(core, row, `tool.finish.${routeKey}`, routeKey === "seedvr" ? opts.seedvrModel ?? slots.seedvr ?? "SeedVR2" : routeKey === "model" ? upscaleModel : "RTX VSR",
      `route=${routeKey};by=${opts.by ?? 2};frames=${opts.seedvrFrames ?? 0}`, Math.round(source.width * by) * Math.round(source.height * by) * Math.max(1, outFrames));
    const output = await followed(core, comfy, run, row, g, outNode, [...done.loads, ...(rife ? [`frame_interpolation/${rife}`] : [])], note, resend);
    const bytes = await comfy.client.view(output);
    // named after the take it finishes ("Big Air · Clip 2 · take 5 · finished ×2"), worked out from its clip when that video has no name
    const kept = await onDraftGrid(core, video, await clips.range.keepCut(video, bytes, finishedName(await nameOf(core.db, video), by), 0, video.duration_ms ?? 0, folder));
    await noteTool(core, note, "done", kept);
    return kept;
  }));
  if (opts.clip) await place(core, clips, opts.clip, made, "the finished take", opts.finishedFrom ?? null);
}

/**
 * A finish of a draft's own frames on the draft's frame grid: its length on the model's grid is the draft's (lengthOnGrid),
 * or an interpolated finish plays one frame short and a seamless join skips it; and a continuation from it hands over on
 * that grid (finishLatent). The latent itself stays the draft's (renderedOf). Every finish of the frames keeps it, the Face
 * refine's too (card #119, B7), when the lengths match within a frame.
 */
async function onDraftGrid(core: QueueCore, video: AssetRow, kept: AssetRow): Promise<AssetRow> {
  if (!video.latent_frames || Math.abs((kept.duration_ms ?? 0) - (video.duration_ms ?? 0)) > 42) return kept;
  return core.db.updateTable("assets").set({ latent_frames: video.latent_frames, latent_clock: video.latent_clock }).where("id", "=", kept.id).returningAll().executeTakeFirstOrThrow();
}

/**
 * Finish › Face refine on a take whose model keeps no latent (SCAIL-2 at 24 fps): H3's Face refine on the take's own frames,
 * its sound held, as its render would have run it. The frames as the take plays them, unless they were interpolated (RIFE ×2):
 * then the model's own, interpolated again after. The same frames and length as the take.
 */
async function runFaceFinish(core: QueueCore, row: JobRow, run: Running, clips: Timelines, video: AssetRow, opts: CutOptions, folder: string | null): Promise<void> {
  const made = (await madeBefore(core, row)) ?? (await makeOnce(core, row, async () => {
    const comfy = await core.comfy();
    const catalog = await comfy.catalog();
    // the family's Face refine files (H3's, offered with it), found by name as the setup page finds them
    const slots = opts.family ? await toolSlots(core, comfy, opts.family, (x) => x.id.startsWith("face")) : {};
    run.gpu = true;
    const raw = video.raw_key ? await core.storage.get(video.raw_key).catch(() => null) : null;
    const rawFacts = raw ? await rawFactsOfTake(core, video) : null;
    const doubled = Boolean(raw && rawFacts?.fps) && interpolatedFrom(video, rawFacts);
    const rife = doubled ? rifeModelIn(catalog) : null;
    if (doubled && !rife) throw new Error("This take was interpolated, and ComfyUI has no RIFE model left to interpolate the refined frames again (models/frame_interpolation).");
    const taken = await core.storage.get(video.file_key);
    const picture = opts.picture ? await core.db.selectFrom("assets").select(["file_key", "mime"]).where("id", "=", opts.picture).executeTakeFirst() : undefined;
    // the frames, the photo and the take's own sound go up at once, each once to each ComfyUI under its content's name:
    // a timeline's takes are finished with the same photo, and each sent it again while the pod's GPU waited
    const resend: Array<() => Promise<string>> = [];
    const upload = (bytes: Uint8Array, ext: string) => sentOnce(comfy, bytes, ext, (b, e, o) => comfy.client.upload(b, e, o), resend);
    const [framesFile, pictureFile, soundFile] = await Promise.all([
      upload(doubled ? raw! : taken, extOf(video.mime)),
      picture ? core.storage.get(picture.file_key).then((bytes) => upload(bytes, extOf(picture.mime))) : undefined,
      // the model's own frames have no sound of their own: it is the take's, loaded beside them
      video.has_sound && doubled ? upload(taken, extOf(video.mime)) : undefined,
    ]);
    const g = new GraphBuilder();
    const parts = g.add("GetVideoComponents", { video: g.out("LoadVideo", { file: framesFile }) });
    const sound: Ref | undefined = !video.has_sound ? undefined
      : soundFile ? [g.add("GetVideoComponents", { video: g.out("LoadVideo", { file: soundFile }) }), 1] : [parts, 1];
    const fps = doubled ? rawFacts!.fps : video.fps ?? 24;
    const frames = Math.round(((doubled ? rawFacts!.durationMs : video.duration_ms ?? 0) / 1000) * fps);
    const options = asBuilt(catalog, (await core.packFacts?.().catch(() => null)) ?? ANY_PACKS, packsSaid(row));
    const ctx: BuildContext = { seed: Math.floor(Math.random() * 2 ** 31), slots, uploads: {}, media: {}, has: (n: string) => n in catalog, options: optionsIn(catalog), inputs: inputsIn(catalog), wants: options.wants };
    // the H3 model picked in Finish (card #192: it was left out, the pass ran on the fused turbo whatever was picked), its
    // steps by that model (4 on a turbo, more on a full model) as an H3 clip's pass takes them; none picked, the fused turbo at 4
    const values = { faceRefine: true, faceRefineDenoise: opts.faceDenoise ?? 0.35, faceRefineSteps: pickedFace(opts) ? 0 : 4, ...faceModelAsked(opts), references: [], subject: "", quick: true };
    const why = faceRefineSkipped(values, ctx, { picture: pictureFile, own: true, audio: Boolean(sound) });
    if (why) throw new Error(why);
    const faces = faceRefined(g, ctx, values, [parts, 0], { audio: sound, picture: pictureFile, frames });
    if (!faces.pass) throw new Error("Not face-refined: its node pack (comfyui-h3-facerefine) or Afflatus's audio lock is not on this ComfyUI.");
    for (const { w, why: without } of options.without) await warnJob(core.db, row.id, ranWithoutSaid(w, without));
    if (faces.said) await warnJob(core.db, row.id, faces.said);
    const ranOn = faceModelOf(values, slots);
    if (opts.faceModel === OWN_MODEL) await warnJob(core.db, row.id, ownModelSaid(ranOn.file));
    let images = faces.images;
    if (rife) {
      // RIFE's 2n − 1 frames and the last one again: as long as the take
      g.phase("interpolating");
      const smooth = g.out("FrameInterpolate", { interp_model: g.out("FrameInterpolationModelLoader", { model_name: rife }), images, multiplier: 2 });
      images = g.out("ImageBatch", { image1: smooth, image2: g.out("ImageFromBatch", { image: smooth, batch_index: -1, length: 1 }) });
    }
    g.phase("encoding");
    const outNode = saveVideo(g, ctx, { images, ...(sound ? { audio: sound } : {}), fps: video.fps ?? 24, crf: 16 });
    const note = await toolNote(core, row, "tool.finish.face", ranOn.file ?? "Face refine", `route=face;denoise=${values.faceRefineDenoise}`, (video.width ?? 0) * (video.height ?? 0) * Math.max(1, frames));
    const output = await followed(core, comfy, run, row, g, outNode, [...faces.loads, ...(rife ? [`frame_interpolation/${rife}`] : [])], note, resend);
    const bytes = await comfy.client.view(output);
    const kept = await onDraftGrid(core, video, await clips.range.keepCut(video, bytes, `${await nameOf(core.db, video)} · face refined`, 0, video.duration_ms ?? 0, folder));
    await noteTool(core, note, "done", kept);
    return kept;
  }));
  if (opts.clip) await place(core, clips, opts.clip, made, "the finished take", opts.finishedFrom ?? null);
}

/** The H3 model a Finish › Face refine of a take's frames picked: a file, not the clip's own (which is not H3's here). */
const pickedFace = (opts: Pick<CutOptions, "faceModel">): string | undefined => (opts.faceModel && opts.faceModel !== OWN_MODEL ? opts.faceModel : undefined);
const faceModelAsked = (opts: Pick<CutOptions, "faceModel">): { faceRefineModel?: string } => (opts.faceModel ? { faceRefineModel: opts.faceModel } : {});

/**
 * Why a take's frames are redrawn on the fused turbo when the clip's own model was asked for: the model it was made with
 * (SCAIL-2's, LTX 2.5's) is not H3's, and only H3 redraws a face here.
 */
export const ownModelSaid = (file: string | undefined): string =>
  `Face refine ran on ${file ? `${file.split(/[\\/]/).pop()}, ` : ""}the fused turbo of Settings › Models: this clip's own model is not H3's.`;

/** RIFE on the GPU: the range goes up to ComfyUI, a small graph interpolates it, the video comes back with the range's own sound slowed to match. */
async function runSlowRife(core: QueueCore, row: JobRow, run: Running, clips: Timelines, video: AssetRow, opts: CutOptions, folder: string | null): Promise<void> {
  const factor = opts.factor ?? 2;
  const made = (await madeBefore(core, row)) ?? (await makeOnce(core, row, async () => {
    const comfy = await core.comfy();
    const catalog = await comfy.catalog();
    const rife = rifeModelIn(catalog);
    const missing = SLOW_NODES.filter((n) => !(n in catalog));
    if (missing.length || !rife) throw new Error(`ComfyUI has no RIFE frame interpolation to run this on${missing.length ? ` (missing nodes: ${missing.join(", ")})` : " (no model in models/frame_interpolation)"}`);
    run.gpu = true;
    const part = await clips.range.rangeSlice(video, opts.startMs, opts.endMs);
    const resend: Array<() => Promise<string>> = [];
    const file = await sentOnce(comfy, part.bytes, "mp4", (bytes, ext, o) => comfy.client.upload(bytes, ext, o), resend);
    const g = new GraphBuilder();
    const parts = g.add("GetVideoComponents", { video: g.out("LoadVideo", { file }) });
    g.phase("interpolating");
    const images = g.out("FrameInterpolate", { interp_model: g.out("FrameInterpolationModelLoader", { model_name: rife }), images: [parts, 0], multiplier: factor });
    g.phase("encoding");
    const outNode = g.add("VHS_VideoCombine", { images, frame_rate: part.fps, loop_count: 0, filename_prefix: "Afflatus/slow", format: "video/h264-mp4", pingpong: false, save_output: false, pix_fmt: "yuv420p", crf: 16, save_metadata: false, trim_to_audio: false });
    const note = await toolNote(core, row, "tool.slow", rife, `factor=${factor}`, (video.width ?? 0) * (video.height ?? 0) * Math.max(1, Math.round(((opts.endMs - opts.startMs) / 1000) * part.fps * factor)) || null);
    const silent = await comfy.client.view(await followed(core, comfy, run, row, g, outNode, [`frame_interpolation/${rife}`], note, resend));
    // RIFE hands the picture back without sound: the range's own sound goes on it, slowed to match
    const bytes = await slowSoundOnto(silent, part.bytes, factor);
    const kept = await clips.range.keepCut(video, bytes, await clips.range.slowName(video, opts.startMs, opts.endMs, factor), opts.startMs, opts.endMs, folder);
    await noteTool(core, note, "done", kept);
    return kept;
  }));
  if (opts.clip) await place(core, clips, opts.clip, made);
}

/** The range slowed by ffmpeg on the computer Afflatus runs on. */
async function runSlowFfmpeg(core: QueueCore, row: JobRow, run: Running, clips: Timelines, video: AssetRow, opts: CutOptions, folder: string | null): Promise<void> {
  const made = (await madeBefore(core, row)) ?? (await makeOnce(core, row, () => clips.range.slowRange(video, opts.startMs, opts.endMs, opts.factor ?? 2, { crf: opts.crf, signal: run.abort.signal, folder })));
  if (opts.clip) await place(core, clips, opts.clip, made);
}

/**
 * The video a finish or a slow-motion job made before this process stopped: its id is kept on the job
 * (in `resume`) as soon as it is filed, so that a job run again after a restart is placed with it and
 * neither renders nor files it twice.
 */
async function madeBefore(core: QueueCore, row: Pick<JobRow, "resume">): Promise<AssetRow | null> {
  const id = readJson<{ made?: unknown }>(row.resume, {}).made;
  if (typeof id !== "string") return null;
  return (await core.db.selectFrom("assets").selectAll().where("id", "=", id).executeTakeFirst()) ?? null;
}

/** Make the job's video, and note on the job that it is made before anything else is done with it. */
async function makeOnce(core: QueueCore, row: Pick<JobRow, "id">, make: () => Promise<AssetRow>): Promise<AssetRow> {
  const made = await make();
  await core.db.updateTable("jobs").set({ resume: JSON.stringify({ made: made.id }), updated_at: now() }).where("id", "=", row.id).execute();
  return made;
}

/** The video as a take of its clip, once: a job run again after it was placed places nothing more. */
async function place(core: QueueCore, clips: Timelines, clipId: string, made: AssetRow, label?: string, finishedFrom: string | null = null): Promise<void> {
  const placed = await core.db.selectFrom("takes").select("id").where("clip_id", "=", clipId).where("asset_id", "=", made.id).executeTakeFirst();
  if (placed) return;
  await clips.takes.takeFrom(clipId, made, label, finishedFrom);
  core.events.emit("timeline");
}

/**
 * Wait for a prompt queued outside the usual render path (a finish, a slow-motion), and hand back the video
 * it made. Waited on as a render is (waitForOutputs): a prompt ComfyUI lost in a crash or a restart is told
 * apart from one still in its queue, and the job fails instead of holding the line for hours.
 */
export async function awaitPrompt(comfy: Comfy, promptId: string, node: string, signal: AbortSignal, wait: QueueCore["opts"]["wait"]): Promise<OutputFile> {
  let outputs;
  try {
    outputs = await waitForOutputs(comfy.client, promptId, { ...wait, signal, ended: comfy.monitor.ended(promptId) });
  } catch (err) {
    if (err instanceof ComfyCancelled || signal.aborted) {
      // shutting down leaves the prompt running in ComfyUI: the next start follows it by the id saved on the job (SHUTDOWN)
      if (signal.reason === SHUTDOWN) throw err;
      await comfy.client.interrupt(promptId).catch(() => {});
      throw new Error("stopped by you");
    }
    throw err;
  }
  // VideoHelperSuite answers under "gifs"; ComfyUI's own SaveVideo under "images", with the video's name
  const video = (o: { gifs?: OutputFile[]; images?: OutputFile[] } | undefined) => o?.gifs?.[0] ?? o?.images?.find((f) => /\.(mp4|webm|mkv|mov)$/i.test(f.filename));
  const file = video(outputs[node]) ?? Object.values(outputs).map(video).find(Boolean);
  if (!file) throw new Error("ComfyUI finished without a video");
  return file;
}

export function runExport(core: QueueCore, row: JobRow): Promise<void> {
  return core.runTool(row, async (run) => {
    const opts = readJson<ExportOptions | null>(row.inputs, null);
    if (!opts) throw new Error("this job's settings cannot be read");
    if (!core.clips) throw new Error("timelines are not available");
    await core.clips.exporter.export(opts.timeline, { scale: opts.scale, music: opts.music, smooth: opts.smooth, range: opts.range, blend: opts.blend, match: opts.match, fit: opts.fit, webMb: opts.webMb, signal: run.abort.signal });
  });
}
