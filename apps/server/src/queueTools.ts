import { detect, type Measured, type OutputFile } from "@afflatus/comfy";
import { GraphBuilder, type BuildContext, type Ref } from "@afflatus/core";
import { pixelUpscale, saveVideo, UPSCALE } from "@afflatus/recipes";
import type { Comfy } from "./comfy";
import { slowSoundOnto } from "./cut";
import { extOf } from "./media";
import { readVideo } from "./video";
import { recordTool, toolPace } from "./renders";
import type { CutOptions, ExportOptions } from "./timelines";
import type { JobRow, QueueCore } from "./queueModel";

/** The jobs that need no model of their own: a cut (a copy, a split, a slow-motion, a finish) and an export, done by ffmpeg, with ComfyUI only for RIFE and the upscale routes. */

/** The RIFE model this ComfyUI offers for frame interpolation, when it has one. */
export function rifeModelIn(catalog: Record<string, unknown>): string | null {
  const node = catalog["FrameInterpolationModelLoader"] as { input?: { required?: Record<string, unknown[]> } } | undefined;
  const spec = node?.input?.required?.model_name;
  // older nodes list the choices in the type position; newer ones say "COMBO" and list them under options
  const second = spec?.[1] as { options?: unknown[] } | undefined;
  const options = Array.isArray(spec?.[0]) ? spec![0] : spec?.[0] === "COMBO" && Array.isArray(second?.options) ? second!.options : null;
  if (!Array.isArray(options)) return null;
  const files = options.filter((o): o is string => typeof o === "string");
  return files.find((f) => /rife/i.test(f)) ?? files[0] ?? null;
}

/** A cut: ffmpeg on the computer Afflatus runs on, like an export. */
/**
 * A tool's graph sent to ComfyUI and followed like a render's: the status strip then says which step runs (SeedVR2 restore,
 * frame interpolation, encoding) and how far it is, where it said "Queued on ComfyUI" and "working…" all along.
 */
/** A tool run as the record keeps it: what it is, what it makes (pixels × frames) and what its own record expected of it. */
interface ToolNote { row: JobRow; recipe: string; model: string; timeKey: string; work: number | null; expectedMs: number | null; startedAt: number; measured: Measured | null }

/** Its usual pace × what it makes: what it should take, from its own record (null until it has run once). */
async function toolNote(core: QueueCore, row: JobRow, recipe: string, model: string, timeKey: string, work: number | null): Promise<ToolNote> {
  const pace = work ? await toolPace(core.db, recipe).catch(() => null) : null;
  return { row, recipe, model, timeKey, work, expectedMs: pace && work ? Math.round(pace * work) : null, startedAt: Date.now(), measured: null };
}

/** Put a tool's run on the record (never lets a failure here reach the job). */
async function noteTool(core: QueueCore, note: ToolNote, status: "done" | "failed" | "cancelled", made: { id: string; width: number | null; height: number | null; duration_ms: number | null } | null) {
  await recordTool(core.db, { id: note.row.id, created_at: note.row.created_at, startedAt: note.startedAt }, note, note.measured, status, Date.now() - note.startedAt,
    { assetId: made?.id ?? null, width: made?.width ?? null, height: made?.height ?? null, durationMs: made?.duration_ms ?? null }, note.work, note.expectedMs).catch(() => {});
}

async function followed(core: QueueCore, comfy: Comfy, run: { promptId?: string; expectedMs?: number | null; startedAt?: number }, g: GraphBuilder, outNode: string, signal: AbortSignal, loads: string[] = [], note?: ToolNote) {
  // its models alone in the GPU's memory: a render's model left loaded (H3 is 12 GB) made SeedVR2 spill into system memory and
  // crawl (a 6-minute clip past 20 minutes at a quarter of the card's power, 2026-10-08). Freed when something else is loaded,
  // as a render does; the render after this is told the tool's files were last, so it frees them in turn
  const wanted = `tool|${[...loads].sort().join("|")}`;
  if (core.lastLoads !== wanted) {
    await comfy.client.free().catch(() => {});
    await core.loaded(wanted, null);
  }
  const promptId = await comfy.client.submit(g.graph);
  run.promptId = promptId;
  // what it should take, for the "spilling" warning while it runs
  if (note) {
    note.startedAt = Date.now();
    run.expectedMs = note.expectedMs;
    run.startedAt = note.startedAt;
  }
  comfy.monitor.ensure();
  comfy.monitor.track({ promptId, totalSteps: 1, phases: g.phases });
  comfy.monitor.onChange = () => core.events.emit("progress");
  try {
    return await awaitPrompt(comfy, promptId, outNode, signal);
  } catch (err) {
    if (note) {
      note.measured = comfy.monitor.measured(promptId);
      await noteTool(core, note, signal.aborted ? "cancelled" : "failed", null);
    }
    throw err;
  } finally {
    if (note && !note.measured) note.measured = comfy.monitor.measured(promptId);
    comfy.monitor.untrack(promptId);
  }
}

export function runCut(core: QueueCore, row: JobRow): Promise<void> {
  return core.runTool(row, async (run) => {
    const abort = run.abort;
    const opts = JSON.parse(row.inputs) as CutOptions;
    const clips = core.clips;
    if (!clips) throw new Error("timelines are not available");
    const video = await core.db.selectFrom("assets").selectAll().where("id", "=", opts.asset).executeTakeFirst();
    if (!video || video.kind !== "video") throw new Error("that video is no longer in your library");
    if (opts.action === "finish") {
      // the whole video up to ComfyUI, the route run on its frames (the sound passed through), the result back as a video
      const comfy = await core.comfy();
      const catalog = await comfy.catalog();
      // SeedVR2's two files, found by name as the setup page finds them (the full scan is not needed for that)
      const slots: Record<string, string> = {};
      for (const slot of (core.registry.family("tools")?.slots ?? []).filter((x) => x.id === "seedvr" || x.id === "seedvrVae")) {
        const hit = detect(await comfy.client.models(slot.folder).catch(() => [] as string[]), slot.detect);
        if (hit) slots[slot.id] = hit;
      }
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
      const rawFacts = raw ? (await readVideo(raw, extOf(video.mime)).catch(() => null))?.facts ?? null : null;
      const fromRaw = Boolean(raw && rawFacts?.width && rawFacts.fps);
      const doubled = fromRaw && (video.fps ?? 24) > rawFacts!.fps * 1.5;
      const rife = doubled ? rifeModelIn(catalog) : null;
      if (doubled && !rife) throw new Error("This take was interpolated, and ComfyUI has no RIFE model left to interpolate the finished frames again (models/frame_interpolation).");
      const source = fromRaw ? { width: rawFacts!.width, height: rawFacts!.height } : { width: video.width ?? 0, height: video.height ?? 0 };
      const by = (opts.by ?? 2) * (fromRaw && video.width ? video.width / source.width : 1);
      const file = await comfy.client.upload(fromRaw ? raw! : await core.storage.get(video.file_key), extOf(video.mime));
      const g = new GraphBuilder();
      const parts = g.add("GetVideoComponents", { video: g.out("LoadVideo", { file }) });
      const ctx: BuildContext = { seed: Math.floor(Math.random() * 2 ** 31), slots, uploads: {}, media: {}, has: (n: string) => n in catalog };
      // a continuation's hidden run-up (hiddenRunUp) is not restored: its frames are enlarged plainly to the restored size and
      // put back in front, so that the file keeps every frame, its length and its joins' timing. Counted on the source's own frames
      const sourceFps = fromRaw ? rawFacts!.fps : video.fps ?? 24;
      const skip = Math.max(0, Math.floor(((opts.hiddenMs ?? 0) * sourceFps) / 1000));
      const frames: Ref = [parts, 0];
      const restore: Ref = skip ? g.out("ImageFromBatch", { image: frames, batch_index: skip, length: 4096 }) : frames;
      const done = pixelUpscale(g, restore, { upscale: route, upscaleBy: by, upscaleModel, upscaleColour: opts.colour, seedvrFrames: opts.seedvrFrames ?? 0 }, source, ctx);
      let restored: Ref = done.images;
      if (skip) {
        g.phase("upscaling");
        const size = g.add("GetImageSize", { image: done.images });
        const plain = g.out("ImageScale", { image: g.out("ImageFromBatch", { image: frames, batch_index: 0, length: skip }), upscale_method: "lanczos", width: [size, 0], height: [size, 1], crop: "disabled" });
        restored = g.out("ImageBatch", { image1: plain, image2: done.images });
      }
      if (rife) g.phase("interpolating");
      const images: Ref = rife ? g.out("FrameInterpolate", { interp_model: g.out("FrameInterpolationModelLoader", { model_name: rife }), images: restored, multiplier: 2 }) : restored;
      g.phase("encoding");
      const outNode = saveVideo(g, ctx, { images, ...(video.has_sound ? { audio: [parts, 1] as Ref } : {}), fps: video.fps ?? 24, crf: 16 });
      // on the record as a tool of its own: the route, the factor, what it makes
      // what the route restores: the frames past the hidden run-up
      const outFrames = Math.round((Math.max(0, (video.duration_ms ?? 0) - (opts.hiddenMs ?? 0)) / 1000) * (video.fps ?? 24));
      const routeKey = opts.route === "rtx" ? "rtx" : opts.route === "model" ? "model" : "seedvr";
      const note = await toolNote(core, row, `tool.finish.${routeKey}`, routeKey === "seedvr" ? slots.seedvr ?? "SeedVR2" : routeKey === "model" ? upscaleModel : "RTX VSR",
        `route=${routeKey};by=${opts.by ?? 2};frames=${opts.seedvrFrames ?? 0}`, Math.round(source.width * by) * Math.round(source.height * by) * Math.max(1, outFrames));
      const output = await followed(core, comfy, run, g, outNode, abort.signal, [...done.loads, ...(rife ? [`frame_interpolation/${rife}`] : [])], note);
      const bytes = await comfy.client.view(output);
      let made = await clips.keepCut(video, bytes, clips.finishName(video, opts.route ?? "seedvr", by), 0, video.duration_ms ?? 0);
      // the draft's frames, enlarged: its length on the model's frame grid is the draft's (lengthOnGrid), or an interpolated
      // finish plays one frame short and a seamless join skips it. The latent itself stays the draft's (renderedOf)
      if (video.latent_frames && Math.abs((made.duration_ms ?? 0) - (video.duration_ms ?? 0)) <= 42) {
        made = await core.db.updateTable("assets").set({ latent_frames: video.latent_frames }).where("id", "=", made.id).returningAll().executeTakeFirstOrThrow();
      }
      await noteTool(core, note, "done", made);
      if (opts.clip) {
        await clips.takeFrom(opts.clip, made, "the finished take", opts.finishedFrom ?? null);
        core.events.emit("timeline");
      }
    } else if (opts.action === "slow") {
      const factor = opts.factor ?? 2;
      let made;
      if (opts.engine === "rife") {
        // RIFE on the GPU: the range goes up to ComfyUI, a small graph interpolates it, the video comes back
        const comfy = await core.comfy();
        const catalog = await comfy.catalog();
        const rife = rifeModelIn(catalog);
        const missing = ["LoadVideo", "GetVideoComponents", "FrameInterpolationModelLoader", "FrameInterpolate", "VHS_VideoCombine"].filter((n) => !(n in catalog));
        if (missing.length || !rife) throw new Error(`ComfyUI has no RIFE frame interpolation to run this on${missing.length ? ` (missing nodes: ${missing.join(", ")})` : " (no model in models/frame_interpolation)"}`);
        run.gpu = true;
        const part = await clips.rangeSlice(video, opts.startMs, opts.endMs);
        const file = await comfy.client.upload(part.bytes, "mp4");
        const g = new GraphBuilder();
        const parts = g.add("GetVideoComponents", { video: g.out("LoadVideo", { file }) });
        g.phase("interpolating");
        const images = g.out("FrameInterpolate", { interp_model: g.out("FrameInterpolationModelLoader", { model_name: rife }), images: [parts, 0], multiplier: factor });
        g.phase("encoding");
        const outNode = g.add("VHS_VideoCombine", { images, frame_rate: part.fps, loop_count: 0, filename_prefix: "Afflatus/slow", format: "video/h264-mp4", pingpong: false, save_output: false, pix_fmt: "yuv420p", crf: 16, save_metadata: false, trim_to_audio: false });
        const note = await toolNote(core, row, "tool.slow", rife, `factor=${factor}`, (video.width ?? 0) * (video.height ?? 0) * Math.max(1, Math.round(((opts.endMs - opts.startMs) / 1000) * part.fps * factor)) || null);
        const output = await followed(core, comfy, run, g, outNode, abort.signal, [`frame_interpolation/${rife}`], note);
        const silent = await comfy.client.view(output);
        // RIFE hands the picture back without sound: the range's own sound goes on it, slowed to match
        const bytes = await slowSoundOnto(silent, part.bytes, factor);
        made = await clips.keepCut(video, bytes, clips.slowName(video, opts.startMs, opts.endMs, factor), opts.startMs, opts.endMs);
        await noteTool(core, note, "done", made);
      } else made = await clips.slowRange(video, opts.startMs, opts.endMs, factor, { crf: opts.crf, signal: abort.signal });
      if (opts.clip) {
        await clips.takeFrom(opts.clip, made);
        core.events.emit("timeline");
      }
    } else await clips.cutRange(video, opts.startMs, opts.endMs, opts.action, { crf: opts.crf, signal: abort.signal });
  });
}

/** Wait for a prompt queued outside the usual render path (a slow-motion job), and hand back the video it made. */
export async function awaitPrompt(comfy: Comfy, promptId: string, node: string, signal: AbortSignal): Promise<OutputFile> {
  const started = Date.now();
  for (;;) {
    if (signal.aborted) {
      await comfy.client.interrupt(promptId).catch(() => {});
      throw new Error("stopped by you");
    }
    const h = await comfy.client.history(promptId).catch(() => undefined);
    if (h?.status?.completed) {
      // VideoHelperSuite answers under "gifs"; ComfyUI's own SaveVideo under "images", with the video's name
      const video = (o: { gifs?: OutputFile[]; images?: OutputFile[] } | undefined) => o?.gifs?.[0] ?? o?.images?.find((f) => /\.(mp4|webm|mkv|mov)$/i.test(f.filename));
      const file = video(h.outputs?.[node]) ?? Object.values(h.outputs ?? {}).map(video).find(Boolean);
      if (!file) throw new Error("ComfyUI finished without a video");
      return file;
    }
    if (h?.status?.status_str === "error") {
      const said = h.status.messages?.find((m) => m[0] === "execution_error")?.[1] as { exception_message?: string } | undefined;
      throw new Error(said?.exception_message ? `ComfyUI: ${String(said.exception_message).slice(0, 300)}` : "ComfyUI could not run the frame interpolation");
    }
    if (Date.now() - started > 2 * 60 * 60_000) throw new Error("the frame interpolation did not finish in two hours");
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export function runExport(core: QueueCore, row: JobRow): Promise<void> {
  return core.runTool(row, async (run) => {
    const opts = JSON.parse(row.inputs) as ExportOptions;
    if (!core.clips) throw new Error("timelines are not available");
    await core.clips.export(opts.timeline, { scale: opts.scale, music: opts.music, smooth: opts.smooth, range: opts.range, blend: opts.blend, match: opts.match, fit: opts.fit, signal: run.abort.signal });
  });
}
