import { baseModels, mainModel, modelOf, timeKey, checkGraph, choicesOf, modelFileName, parseInput, pickChoice, RANDOM_SEED, relocateFiles, warmGraph, WARM_SINK, type BuiltGraph, type ClipValue, type InputSpec, type MediaFacts, type Recipe, type ReferenceValue } from "@afflatus/core";
import { forecast, workOf, type Forecast } from "./forecast";
import type { Comfy } from "./comfy";
import { cutFrames, referenceClip, soundPart } from "./cut";
import { extOf } from "./media";
import { usualParts } from "./renders";
import { maskBox, readPicture } from "./thumbs";
import { readVideo } from "./video";
import type { JobRow, QueueCore, Resume } from "./queueModel";
import { draftOf, renderedOf } from "./queueStore";

/** A job on its way to ComfyUI: its form settled, its files uploaded, its graph built and checked, the prompt queued. */

/** A form's values with something in every text that must be written: to load its models, what the text says does not matter. */
export function withTexts(recipe: Recipe<any>, raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const input = { ...(raw as Record<string, unknown>) };
  for (const spec of recipe.inputs as InputSpec[]) {
    if (spec.type === "prompt" && !spec.optional && !String(input[spec.id] ?? "").trim()) input[spec.id] = "a";
  }
  return input;
}

/** A file choice left on its default, when this ComfyUI does not have that file: the best one it has. */
export function settled(recipe: Recipe<any>, input: Record<string, unknown>, catalog: Awaited<ReturnType<Comfy["catalog"]>>): Record<string, unknown> {
  const chosen: Record<string, unknown> = { ...input };
  for (const spec of recipe.inputs as InputSpec[]) {
    if (spec.type !== "choice" || Array.isArray(spec.options)) continue;
    const def = catalog[spec.options.node];
    const offered = choicesOf(def?.input.required?.[spec.options.input] ?? def?.input.optional?.[spec.options.input]) ?? [];
    const all = [...(spec.extra ?? []), ...offered];
    if (all.length && !all.includes(String(chosen[spec.id])) && chosen[spec.id] === spec.default) chosen[spec.id] = pickChoice(spec, all);
  }
  return chosen;
}

const randomSeed = () => Math.floor(Math.random() * 2 ** 32);

/** Check the graph against this ComfyUI, free its memory if another model is coming, and queue the prompt. */
export async function submit(core: QueueCore, comfy: Comfy, recipe: Recipe<any>, raw: Record<string, unknown>, row: JobRow): Promise<Resume> {
  const { db, storage } = core;
  const catalog = await comfy.catalog();
  // a timeline clip: what it joins onto is settled now, when the clips around it have their takes
  const plan = row.clip_id && core.clips ? await core.clips.plan(row.clip_id, recipe, raw, Boolean(row.clip_fit), row.finished_from) : null;
  const input = plan ? (parseInput(recipe, plan.input) as Record<string, unknown>) : raw;
  const chosen = settled(recipe, input, catalog);
  const missing = recipe.nodes(input).filter((n: string) => !(n in catalog));
  if (missing.length) throw new Error(`ComfyUI is missing custom nodes this needs: ${missing.join(", ")}`);
  const slotFiles = await slots(core, comfy, recipe);

  // pictures, videos and sounds the recipe takes are uploaded to ComfyUI's temp folder under fresh names
  const uploads: Record<string, string> = {};
  const media: Record<string, MediaFacts> = {};
  for (const spec of recipe.inputs) {
    const value = input[spec.id];
    if (spec.type === "image") {
      if (typeof value !== "string") continue;
      const asset = await db.selectFrom("assets").select(["file_key", "mime", "width", "height"]).where("id", "=", value).executeTakeFirst();
      if (!asset) throw new Error(`the ${spec.label.toLowerCase()} is no longer in your library`);
      const bytes = await storage.get(asset.file_key);
      uploads[spec.id] = await comfy.client.upload(bytes, extOf(asset.mime));
      const size = asset.width && asset.height ? { width: asset.width, height: asset.height } : await readPicture(bytes);
      media[spec.id] = { width: size?.width ?? 0, height: size?.height ?? 0 };
      if (spec.role === "mask") {
        // only the part that was painted is redone: where it is comes from the mask itself
        const painted = await maskBox(bytes);
        if (painted && !painted.box) throw new Error("The mask is empty. Paint over the part to inpaint.");
        if (painted?.box) media[spec.id] = { width: painted.width, height: painted.height, box: painted.box };
      }
    } else if (spec.type === "clip" && value && spec.whole) {
      // an imported workflow's own loader reads the video: the whole file goes up as it is
      const { asset: assetId } = value as ClipValue;
      const asset = await db.selectFrom("assets").selectAll().where("id", "=", assetId).executeTakeFirst();
      if (!asset || asset.kind !== "video") throw new Error(`the ${spec.role === "previous" ? "previous" : "next"} clip is no longer in your library`);
      const bytes = await storage.get(asset.file_key);
      uploads[spec.id] = await comfy.client.upload(bytes, extOf(asset.mime));
      const facts = asset.width && asset.height ? { width: asset.width, height: asset.height, hasSound: Boolean(asset.has_sound) } : (await readVideo(bytes, extOf(asset.mime)).catch(() => null))?.facts;
      media[spec.id] = { width: facts?.width ?? 0, height: facts?.height ?? 0, hasSound: facts?.hasSound ?? false };
    } else if (spec.type === "clip" && value) {
      // of the clip it joins onto, the recipe gets a few frames with their sound, cut at the chosen moment
      const { asset: assetId, at } = value as ClipValue;
      const shown = await db.selectFrom("assets").selectAll().where("id", "=", assetId).executeTakeFirst();
      if (!shown || shown.kind !== "video") throw new Error(`the ${spec.role === "previous" ? "previous" : "next"} clip is no longer in your library`);
      // a finished (upscaled) take is a copy of a render: the render's own latent and frames are what a join takes. A finish by
      // H3's latent re-sample is conditioned on the drafts, as the draft it re-samples was
      const asset = row.finished_from ? await draftOf(db, shown) : await renderedOf(db, shown);
      // the model's own frames when they were kept (before an upscale or interpolation changed them): a
      // continuation guided by frames of its own kind joins without the step a changed frame leaves
      const rawBytes = asset.raw_key ? await storage.get(asset.raw_key).catch(() => null) : null;
      const rawRead = rawBytes ? await readVideo(rawBytes, extOf(asset.mime)).catch(() => null) : null;
      const bytes = rawRead?.facts ? rawBytes! : await storage.get(asset.file_key);
      const facts = rawRead?.facts
        ? rawRead.facts
        : asset.duration_ms && asset.width && asset.height
          ? { durationMs: asset.duration_ms, width: asset.width, height: asset.height, hasSound: Boolean(asset.has_sound) }
          : (await readVideo(bytes, extOf(asset.mime))).facts;
      if (!facts) throw new Error("Joining clips needs ffmpeg, which was not found on the machine Afflatus runs on. Install ffmpeg, or set FFMPEG and FFPROBE.");
      // the form may say how many frames the join takes first; shorter counts stay as fallbacks for a short clip
      const wanted = spec.framesFrom ? Number(input[spec.framesFrom]) : NaN;
      const counts = Number.isFinite(wanted) && wanted > 0 ? [wanted, ...spec.frames.filter((c) => c < wanted)] : spec.frames;
      const cut = await cutFrames(bytes, extOf(asset.mime), facts, { counts, fps: spec.fps, side: spec.role === "previous" ? "before" : "after", at });
      uploads[spec.id] = await comfy.client.upload(cut.bytes, "mp4");
      media[spec.id] = { width: facts.width, height: facts.height, frames: cut.frames, fps: spec.fps, hasSound: facts.hasSound };
      // the clip's own latent, when it was kept: a recipe that can join in the latent (the Afflatus node pack)
      // takes it instead of the frames above. The clip before is continued from its end, as its latent holds
      // it; the clip after is landed on where its playing part starts, a moment on the latent's frame grid
      if (asset.latent_key && asset.latent_frames) {
        const atFrames = at === undefined ? 0 : Math.round((at / 1000) * spec.fps);
        const whole = spec.role === "previous" && (at === undefined || at >= (facts.durationMs ?? 0) - 40);
        // handed over before its end, on a frame of the latent's grid: continued from there, its latent cut to it (Afflatus's pack 0.5.0)
        const cutAt = spec.role === "previous" && !whole && atFrames % 17 === 5 && atFrames >= Math.max(...counts) && atFrames <= asset.latent_frames && "AfflatusTrimH3Latent" in catalog ? atFrames : 0;
        // the clip after: landed on where one of its 17-frame chunks begins (its tokens keep their time spans there, see H3_LANDING)
        const fits = spec.role === "previous" ? whole || cutAt > 0 : atFrames % 17 === 0 && atFrames + Math.min(...counts) <= asset.latent_frames;
        const saved = fits ? await storage.get(asset.latent_key).catch(() => null) : null;
        if (saved) {
          uploads[`${spec.id}.latent`] = await comfy.client.upload(saved, "safetensors");
          media[spec.id] = { ...media[spec.id]!, latentFrames: cutAt || asset.latent_frames, ...(cutAt ? { latentCut: cutAt } : {}), ...(spec.role === "next" ? { latentAt: atFrames } : {}) };
          // a finish after a clip finished by the same latent re-sample: that clip's re-sampled latent, for decoding the join as one piece with it
          const fine = row.finished_from && spec.role === "previous" && shown.fine_latent_key && shown.width && shown.height ? await storage.get(shown.fine_latent_key).catch(() => null) : null;
          if (fine) {
            uploads[`${spec.id}.fine`] = await comfy.client.upload(fine, "safetensors");
            media[spec.id] = { ...media[spec.id]!, fine: { width: shown.width!, height: shown.height! } };
          }
        }
      }
    } else if (spec.type === "references" && Array.isArray(value)) {
      // each reference picture goes up under "<input>.<n>", in the order they were given
      for (const [i, ref] of (value as ReferenceValue[]).entries()) {
        const asset = await db.selectFrom("assets").select(["file_key", "mime", "width", "height", "kind"]).where("id", "=", ref.asset).executeTakeFirst();
        if (spec.media === "video") {
          // a reference video: its first three seconds, small, with its sound when it has one
          if (!asset || asset.kind !== "video") throw new Error("a reference video is no longer in your library");
          const clip = await referenceClip(await storage.get(asset.file_key), extOf(asset.mime), { seconds: 3, fps: 24, short: 384 });
          uploads[`${spec.id}.${i}`] = await comfy.client.upload(clip.bytes, "mp4");
          media[`${spec.id}.${i}`] = { width: clip.width, height: clip.height, frames: clip.frames, fps: 24, hasSound: clip.hasSound };
          continue;
        }
        if (!asset || asset.kind !== "image") throw new Error("a reference image is no longer in your library");
        const bytes = await storage.get(asset.file_key);
        uploads[`${spec.id}.${i}`] = await comfy.client.upload(bytes, extOf(asset.mime));
        media[`${spec.id}.${i}`] = { width: asset.width ?? 0, height: asset.height ?? 0 };
      }
    } else if (spec.type === "audio" && typeof value === "string") {
      // a sound, or a video whose sound is used: ComfyUI's loader reads the sound track of either
      const asset = await db.selectFrom("assets").select(["file_key", "mime", "kind", "has_sound", "duration_ms"]).where("id", "=", value).executeTakeFirst();
      if (!asset || (asset.kind !== "audio" && !(asset.kind === "video" && asset.has_sound))) throw new Error(`the ${spec.label.toLowerCase()} is no longer in your library`);
      const whole = await storage.get(asset.file_key);
      if (spec.window) {
        // only the chosen part of it is handed over: a few clean seconds carry a voice better than a long take
        // (a sound ffmpeg cannot cut, or no ffmpeg at all: the whole of it is used, as before there was a part to set)
        const part = await soundPart(whole, extOf(asset.mime), { start: Number(input[spec.window.start] ?? 0), seconds: Number(input[spec.window.seconds] ?? 8), durationMs: asset.duration_ms }).catch((err) => {
          console.warn(`[queue] the part of the ${spec.label.toLowerCase()} could not be cut, the whole sound is used: ${(err as Error).message}`);
          return null;
        });
        uploads[spec.id] = part ? await comfy.client.upload(part, "wav") : await comfy.client.upload(whole, extOf(asset.mime));
      } else uploads[spec.id] = await comfy.client.upload(whole, extOf(asset.mime));
    }
  }

  // a finish by the latent re-sample: the draft's own sampled latent, re-sampled as it is (rendered again, the frames would differ)
  if (row.finished_from && input.upscale === "Latent: re-sampled") {
    const draft = await db.selectFrom("takes").innerJoin("assets", "assets.id", "takes.asset_id").select(["assets.latent_key as latent_key"]).where("takes.id", "=", row.finished_from).executeTakeFirst();
    const saved = draft?.latent_key ? await storage.get(draft.latent_key).catch(() => null) : null;
    if (!saved) throw new Error("This draft's latent was not kept, so H3 cannot re-sample it: finish it with SeedVR2, RTX or a model.");
    uploads["self.latent"] = await comfy.client.upload(saved, "safetensors");
  }

  for (const spec of recipe.inputs) {
    // a part painted on one picture cannot be put on another one
    if (spec.type !== "image" || spec.role !== "mask" || !spec.of) continue;
    const mask = media[spec.id];
    const picture = media[spec.of];
    if (mask && picture?.width && (mask.width !== picture.width || mask.height !== picture.height)) throw new Error("The mask was painted on another image. Paint it again on this one.");
  }

  const seed = typeof input.seed === "number" && input.seed !== RANDOM_SEED ? input.seed : randomSeed();
  const built = recipe.build(chosen, { seed, slots: slotFiles, uploads, media, canvas: plan?.canvas, has: (cls) => cls in catalog });
  // a model kept in another sub-folder than the one the graph names is used from where it is
  relocateFiles(built.graph, catalog);
  const problems = checkGraph(built, catalog, { files: true, uploaded: Object.values(uploads) });
  if (problems.length) {
    const fix = recipe.id.startsWith("workflow.") ? " To fix it: Workflows, then Edit on this workflow." : "";
    throw new Error(`this cannot run on your ComfyUI: ${problems.slice(0, 3).join("; ")}.${fix}`);
  }

  // Another base model is coming: ComfyUI's memory is cleared for it. A graph with no base model of
  // its own (an upscale, a background removal) changes nothing: what is loaded stays, and stays noted.
  const base = baseModels(built);
  const cold = base.length > 0 && !holding(core, base);
  if (base.length) {
    if (cold) await comfy.client.free().catch(() => {});
    await core.loaded(base.join("|"), mainModel(built));
  }
  const timing: Resume["timing"] = {
    model: mainModel(built) ?? "", modelFile: modelOf(recipe.inputs, chosen) ?? (mainModel(built) ?? "").split(" + ")[0]!.toLowerCase(),
    timeKey: timeKey(recipe.inputs, chosen), cold, expectedMs: core.expected(await core.usual(), recipe, chosen, cold),
    expect: await usualParts(db, recipe, chosen).catch(() => ({})),
    // what it samples per step, kept with its figures: the next form like it is forecast from them
    work: workOf(built).pixels * workOf(built).frames,
  };

  comfy.monitor.ensure();
  await comfy.monitor.ready();
  if (row.warm) {
    const warm = warmGraph(built);
    if (!warm) throw new Error("this loads no model: there is nothing to preload");
    if (!(WARM_SINK in catalog)) throw new Error(`ComfyUI is missing the ${WARM_SINK} node, which preloading a model needs. Update ComfyUI.`);
    const promptId = await comfy.client.submit(warm.graph, { preview: "latent2rgb" });
    return { promptId, seed, outputs: [], totalSteps: 1, phases: warm.phases, passes: warm.pass ? [warm.pass] : [], clientId: comfy.client.clientId, loads: built.loads, startedAt: Date.now() };
  }
  const promptId = await comfy.client.submit(built.graph, { preview: "latent2rgb" });
  return {
    promptId, seed, outputs: built.outputs, totalSteps: built.totalSteps, phases: built.phases, passes: built.passes,
    clientId: comfy.client.clientId, loads: built.loads, startedAt: Date.now(), timing,
    // the nodes' titles, for naming what a preview node shows on the way
    titles: Object.fromEntries(Object.entries(built.graph).flatMap(([id, n]) => { const t = (n as { _meta?: { title?: unknown } })._meta?.title; return typeof t === "string" ? [[id, t]] : []; })),
    ...(plan ? { input, links: plan.links, sources: plan.sources } : {}),
    ...(built.overlap ? { overlap: built.overlap } : {}),
  };
}

/** The files a family's recipes need, as this ComfyUI has them. */
export async function slots(core: QueueCore, comfy: Comfy, recipe: Recipe<any>): Promise<Record<string, string>> {
  const slots: Record<string, string> = {};
  const scanned = (await comfy.scan()).families.find((f) => f.id === recipe.family);
  for (const s of scanned?.slots ?? []) {
    if (s.file) slots[s.id] = s.file;
    else if (!s.optional) throw new Error(`a model file ${core.registry.family(recipe.family)?.name ?? recipe.family} needs was not found. ${s.hint}`);
  }
  return slots;
}

/** Every one of these base models is among the ones the last job loaded. */
export function holding(core: QueueCore, base: string[]): boolean {
  if (core.lastLoads === null) return false;
  const held = new Set(core.lastLoads.split("|").map(modelFileName));
  return base.every((f) => held.has(f));
}

/**
 * The graph a form (or a past render: its inputs and its seed) gives, built without uploading anything:
 * the files a render would send are stood in for by `names` (the file's own name, to be read in the
 * graph), else by a placeholder. Null when the form is not complete enough to build.
 */
export async function builtOf(core: QueueCore, recipeId: string, rawInput: unknown, opts: { seed?: number; names?: Record<string, string> } = {}): Promise<BuiltGraph | null> {
  const recipe = core.registry.recipe(recipeId);
  if (!recipe) return null;
  const input = parseInput(recipe, withTexts(recipe, rawInput)) as Record<string, unknown>;
  const comfy = await core.comfy();
  const catalog = await comfy.catalog();
  const uploads: Record<string, string> = {};
  const media: Record<string, MediaFacts> = {};
  const standIn = (key: string, asset: string) => {
    uploads[key] = opts.names?.[asset] ?? "stand-in";
    media[key] = { width: 1024, height: 1024 };
  };
  for (const spec of recipe.inputs as InputSpec[]) {
    const value = input[spec.id];
    if ((spec.type === "image" || spec.type === "audio" || spec.type === "clip") && typeof value === "string") standIn(spec.id, value);
    else if (spec.type === "references" && Array.isArray(value)) value.forEach((v, i) => standIn(`${spec.id}.${i}`, typeof v === "string" ? v : String((v as { asset?: string })?.asset ?? "")));
  }
  const built = recipe.build(settled(recipe, input, catalog), { seed: opts.seed ?? 1, slots: await slots(core, comfy, recipe), uploads, media, has: (cls: string) => cls in catalog });
  relocateFiles(built.graph, catalog);
  return built;
}

/**
 * Whether the base models a form would use are the ones ComfyUI was last asked to load. Null when it
 * cannot be told (the form is not complete enough to build its graph, ComfyUI is away). It is what
 * this app last asked for: a ComfyUI that was restarted since, or used from elsewhere, is not seen.
 */
/**
 * What this model's past renders say a form will take: its sampled work against theirs. Null for a form not
 * complete enough to build, one whose model has no measured render yet, or one that samples nothing.
 */
export async function forecastOf(core: QueueCore, recipeId: string, rawInput: unknown): Promise<{ forecast: Forecast; shape: { pixels: number; frames: number } } | null> {
  const recipe = core.registry.recipe(recipeId);
  if (!recipe) return null;
  let built: BuiltGraph | null;
  let chosen: Record<string, unknown>;
  try {
    chosen = parseInput(recipe, withTexts(recipe, rawInput)) as Record<string, unknown>;
    built = await builtOf(core, recipeId, rawInput);
  } catch {
    return null;
  }
  if (!built) return null;
  const shape = workOf(built);
  if (!shape.pixels) return null;
  const modelFile = modelOf(recipe.inputs, chosen) ?? (mainModel(built) ?? "").split(" + ")[0]!.toLowerCase();
  const base = baseModels(built);
  const f = await forecast(core.db, modelFile, shape.pixels * shape.frames, shape.steps, base.length > 0 && !holding(core, base));
  return f ? { forecast: f, shape } : null;
}

export async function isLoaded(core: QueueCore, recipeId: string, rawInput: unknown): Promise<boolean | null> {
  try {
    const built = await builtOf(core, recipeId, rawInput);
    if (built) {
      const base = baseModels(built);
      if (base.length) return holding(core, base);
    }
  } catch {
    // the form could not be built: read below
  }
  // a form not complete enough to build (a variation with no picture yet): the model files it has chosen say
  // on their own when the loaded one is NOT theirs, which is what the strip must not hide behind a green icon
  const recipe = core.registry.recipe(recipeId);
  const input = rawInput && typeof rawInput === "object" ? (rawInput as Record<string, unknown>) : {};
  const chosen = (recipe?.inputs ?? []).filter((i) => i.type === "model" && typeof input[i.id] === "string" && input[i.id]).map((i) => modelFileName(input[i.id] as string));
  return chosen.length && core.lastLoads !== null && !holding(core, chosen) ? false : null;
}
