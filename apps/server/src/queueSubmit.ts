import { createHash, randomUUID } from "node:crypto";
import { openAsBlob } from "node:fs";
import { baseModels, checkGraph, choicesOf, FRAME_SLACK_MS, isChunkStart, mainModel, missingNodesSaid, modelFileName, modelName, modelOf, onGrid, parseInput, pickChoice, RANDOM_SEED, relocateFiles, timeKey, WARM_SINK, warmGraph, type BuiltGraph, type ClipValue, type InputSpec, type MediaFacts, type Recipe, type ReferenceValue } from "@afflatus/core";
import { ComfyCancelled, ComfyError, ComfyUnreachable } from "@afflatus/comfy";
import { chunksOf, forecast, fromRates, workOf, type Forecast } from "./forecast";
import type { Comfy } from "./comfy";
import { cutFrames, frameAt, partOf, rangeKeep, referenceClip, soundPart } from "./cut";
import type { Db, Tables } from "./db";
import { extOf } from "./media";
import { usualParts } from "./renders";
import { sourceOf, type Storage } from "./storage";
import { addPart, timedPart } from "./serverMetrics";
import { maskBox, mirrorPicture, readPicture } from "./thumbs";
import { ffmpegPool } from "./pool";
import { readVideo, videoFacts } from "./video";
import { readJson, type JobRow, type QueueCore, type Resume } from "./queueModel";
import { draftOf, measuredFirst, renderedOf } from "./queueStore";

/** A job on its way to ComfyUI: its form settled, its files uploaded, its graph built and checked, the prompt queued. */

/** What a picture a form needs and does not have yet is held by, on a job that only loads its models. */
export const NO_PICTURE = "afflatus:no-picture";

/**
 * A form's values with something in every text that must be written, and in every picture it needs and has not
 * got yet (a mask not painted): to load its models, neither matters. A load without its pictures loads the model
 * files alone (see `submit`), so that Load works on a form that is still being filled in.
 */
export function withTexts(recipe: Recipe<any>, raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const input = { ...(raw as Record<string, unknown>) };
  for (const spec of recipe.inputs as InputSpec[]) {
    if (spec.type === "prompt" && !spec.optional && !String(input[spec.id] ?? "").trim()) input[spec.id] = "a";
    if (spec.type === "image" && !spec.optional && (typeof input[spec.id] !== "string" || !input[spec.id])) input[spec.id] = NO_PICTURE;
  }
  return input;
}

/** A file choice left on its default, when this ComfyUI does not have that file: the best one it has. */
function settled(recipe: Recipe<any>, input: Record<string, unknown>, catalog: Awaited<ReturnType<Comfy["catalog"]>>): Record<string, unknown> {
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

/** What the files of a form become on their way up: the names ComfyUI has them under, what is known of each, and what was sent otherwise than asked. */
interface Sent {
  uploads: Record<string, string>;
  media: Record<string, MediaFacts>;
  warnings: string[];
}
/** What each uploader works with. `recipe`: the one the job runs; `finishedFrom`: the take a finish job finishes */
interface Up {
  recipe: Recipe<any>;
  db: Db;
  storage: Storage;
  comfy: Comfy;
  input: Record<string, unknown>;
  catalog: Awaited<ReturnType<Comfy["catalog"]>>;
  finishedFrom: string | null;
  /** The pictures flipped left to right on their way up (a timeline clip's Mirror), by input id. */
  mirror: readonly string[];
  sent: Sent;
  /** Stop pressed while the job gets ready: what is being cut or sent is dropped, and nothing more goes to ComfyUI. */
  signal?: AbortSignal;
  /** A file into ComfyUI (ComfyClient.upload), dropped at a Stop: its bytes, or a stored file streamed from the disk (`sendable`). */
  upload(bytes: Uint8Array | Blob, ext: string, opts?: { into?: "input"; name?: string }): Promise<string>;
  /** A picture into ComfyUI under a name its content gives, sent to that machine once (see `submit`). */
  picture(bytes: Uint8Array, ext: string, opts?: { into?: "input" }): Promise<string>;
}

/**
 * How long a picture sent under its content's name is taken to be still in ComfyUI: its input folder is cleaned of what
 * Afflatus left there a day ago (cleanComfy), and its temp folder empties when it starts again (Comfy.uploaded is forgotten then).
 */
const PICTURE_KEPT_MS = 6 * 60 * 60_000;

/** A stored file as it goes up to ComfyUI: streamed from where it is on the disk, else its bytes (a bucket). */
async function sendable(storage: Storage, key: string): Promise<Uint8Array | Blob> {
  const path = storage.localPath?.(key);
  return path ? openAsBlob(path) : storage.get(key);
}

/** Stopped by hand (or the process shutting down) while the job got ready: it goes no further. */
function going(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ComfyCancelled();
}

/**
 * Check the graph against this ComfyUI, free its memory if another model is coming, and queue the prompt. `hold`
 * saves what is needed to follow it, under the prompt id it is sent with, before it is sent (see Resume.unsent).
 * `signal`: the job's Stop. Pressed while its files go up, it ends here (ComfyCancelled), before ComfyUI is told to
 * free its memory or given the prompt: a Stop checked only once the prompt was sent unloaded the next job's model.
 */
export async function submit(core: QueueCore, comfy: Comfy, recipe: Recipe<any>, raw: Record<string, unknown>, row: JobRow, hold: (r: Resume) => Promise<void> = async () => {}, signal?: AbortSignal): Promise<Resume> {
  const { db, storage } = core;
  const catalog = await timedPart("scan", () => comfy.catalog());
  // a timeline clip: what it joins onto is settled now, when the clips around it have their takes
  const plan = row.clip_id && core.clips ? await core.clips.plan(row.clip_id, recipe, raw, Boolean(row.clip_fit), row.finished_from, false, readJson<string[]>(row.clip_mirror, [])) : null;
  const input = plan ? (parseInput(recipe, plan.input) as Record<string, unknown>) : raw;
  const chosen = settled(recipe, input, catalog);
  const missing = recipe.nodes(input).filter((n: string) => !(n in catalog));
  if (missing.length) throw new Error(missingNodesSaid(missing));
  const slotFiles = await timedPart("scan", () => slots(core, comfy, recipe));

  // pictures, videos and sounds the recipe takes are uploaded to ComfyUI's temp folder under fresh names. They go up at
  // once: the time any of them is on its way is /metrics' "uploads"
  let sending = 0;
  let onTheWay = 0;
  let since = 0;
  const upload: Up["upload"] = async (bytes, ext, opts = {}) => {
    going(signal);
    if (onTheWay++ === 0) since = performance.now();
    try {
      // an upload cut short by the Stop says so, not that ComfyUI stopped answering
      return await comfy.client.upload(bytes, ext, { ...opts, signal }).catch((err: unknown) => {
        going(signal);
        throw err;
      });
    } finally {
      if (--onTheWay === 0) {
        sending += performance.now() - since;
        addPart("uploads", performance.now() - since);
      }
    }
  };
  // a picture goes up under a name its content gives, once to each machine: the same picture in every window of a motion
  // transfer (55 % of what a window sent) went up again each time, while the pod's GPU waited. Sent again under the same
  // name when ComfyUI turns out not to have it any more (see below)
  const again: Array<() => Promise<string>> = [];
  const picture: Up["picture"] = (bytes, ext, opts = {}) => {
    const name = `afflatus_${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}.${ext}`;
    const key = `${opts.into ?? "temp"}/${name}`;
    const send = () => upload(bytes, ext, { ...opts, name });
    const kept = comfy.uploaded.get(key);
    if (kept && Date.now() - kept.at < PICTURE_KEPT_MS) {
      again.push(send);
      return kept.name.catch(send);
    }
    const sent = send();
    comfy.uploaded.set(key, { at: Date.now(), name: sent });
    sent.catch(() => {
      if (comfy.uploaded.get(key)?.name === sent) comfy.uploaded.delete(key);
    });
    return sent;
  };
  const up: Up = { recipe, db, storage, comfy, input, catalog, finishedFrom: row.finished_from, mirror: plan?.mirror ?? [], sent: { uploads: {}, media: {}, warnings: [] }, signal, upload, picture };
  // what the media cost beside sending them (cutting a clip's frames, reading a picture): /metrics' "cuts"
  const media0 = performance.now();
  // every input's files are made and sent at once; what each says is kept in the form's order, and of the inputs that
  // fail, the first in that order is the one said
  const specs = (recipe.inputs as InputSpec[]).filter((spec) => {
    const value = input[spec.id];
    return (spec.type === "image" && typeof value === "string" && value !== NO_PICTURE) || (spec.type === "clip" && Boolean(value)) || (spec.type === "references" && Array.isArray(value)) || (spec.type === "audio" && typeof value === "string");
  });
  const told = specs.map(() => [] as string[]);
  const done = await Promise.allSettled(specs.map((spec, i) => {
    const value = input[spec.id];
    const own: Up = { ...up, sent: { ...up.sent, warnings: told[i]! } };
    if (spec.type === "image") return uploadImage(own, spec, value as string);
    if (spec.type === "clip" && spec.whole) return uploadWholeClip(own, spec, value as ClipValue);
    if (spec.type === "clip") return uploadJoinClip(own, spec, value as ClipValue);
    if (spec.type === "references") return uploadReferences(own, spec, value as ReferenceValue[]);
    return uploadSound(own, spec, value as string);
  }));
  const failed = done.find((d): d is PromiseRejectedResult => d.status === "rejected");
  if (failed) throw failed.reason;
  up.sent.warnings.push(...told.flat());
  // a form handed nothing (a text to picture) has no media to prepare: no figure, rather than a zero among the others
  if (Object.keys(up.sent.uploads).length) addPart("cuts", Math.max(0, performance.now() - media0 - sending));
  // a finish that needs the draft's own sampled latent (H3's latent re-sample, which samples it again as it is): the recipe says so
  if (row.finished_from && recipe.finishing?.(input)?.latent === "own") {
    const draft = await db.selectFrom("takes").innerJoin("assets", "assets.id", "takes.asset_id").select(["assets.latent_key as latent_key"]).where("takes.id", "=", row.finished_from).executeTakeFirst();
    const saved = draft?.latent_key ? await sendable(storage, draft.latent_key).catch(() => null) : null;
    if (!saved) throw new Error(`This draft's latent was not kept, so ${core.registry.family(recipe.family)?.name ?? recipe.family} cannot re-sample it: finish it with SeedVR2, RTX or a model.`);
    up.sent.uploads["self.latent"] = await upload(saved, "safetensors");
  }
  const { uploads, media, warnings } = up.sent;
  checkMasks(recipe, media);

  const seed = typeof input.seed === "number" && input.seed !== RANDOM_SEED ? input.seed : randomSeed();
  // a load asked before the form has its pictures: the models are loaded, without the step that would need them
  const bare = Boolean(row.warm) && (recipe.inputs as InputSpec[]).some((s) => s.type === "image" && input[s.id] === NO_PICTURE);
  const whole = recipe.build(chosen, { seed, slots: slotFiles, uploads, media, canvas: plan?.canvas, has: (cls) => cls in catalog });
  const loaders = bare ? warmGraph({ ...whole, passes: [] }) : null;
  if (bare && !loaders) throw new Error("this loads no model: there is nothing to preload");
  const built: BuiltGraph = loaders ? { ...whole, graph: loaders.graph, phases: loaders.phases, passes: [], outputs: [] } : whole;
  // a model kept in another sub-folder than the one the graph names is used from where it is
  relocateFiles(built.graph, catalog);
  const imported = Boolean(recipe.imported);
  const problems = checkGraph(built, catalog, { files: true, uploaded: Object.values(uploads), looseInputs: imported });
  if (problems.length) {
    const fix = imported ? " To fix it: Workflows, then Edit on this workflow." : "";
    throw new Error(`this cannot run on your ComfyUI: ${problems.slice(0, 3).join("; ")}.${fix}`);
  }

  // Another main model is coming: ComfyUI's memory is cleared for it (see coldOf). A graph with no base model of
  // its own (an upscale, a background removal) changes nothing: what is loaded stays, and stays noted.
  const base = baseModels(built);
  const cold = coldOf(core.lastLoads, built);
  // a continuation sends its prompt once the take it joins onto has its figures (queueStore.measuredFirst): its own files
  // went up meanwhile
  await measuredFirst(joinedOnto(recipe, input));
  going(signal);
  if (cold) {
    await timedPart("free", () => comfy.client.free().catch(() => {}));
    await core.loaded(null);
  }
  const timing = await timingOf(core, recipe, chosen, built, cold);

  // what Afflatus left in ComfyUI's input and output folders a day ago or more goes (best effort, at most hourly): with
  // any job, so a picture sent to the DaSiWa Director does not wait there for the next Director job
  cleanComfy(comfy);

  comfy.monitor.ensure();
  await comfy.monitor.ready();
  const prompt = await promptOf(comfy, built, Boolean(row.warm), loaders);
  const resume: Resume = row.warm
    ? { ...prompt.resume, seed, outputs: [], loads: built.loads, startedAt: Date.now() }
    : {
      ...prompt.resume, seed, outputs: built.outputs, loads: built.loads, startedAt: Date.now(), timing,
      // the nodes' titles, for naming what a preview node shows on the way
      titles: Object.fromEntries(Object.entries(built.graph).flatMap(([id, n]) => { const t = (n as { _meta?: { title?: unknown } })._meta?.title; return typeof t === "string" ? [[id, t]] : []; })),
      ...(plan ? { input, links: plan.links, sources: plan.sources, ...(plan.mirror.length ? { mirror: plan.mirror } : {}) } : {}),
      ...(built.overlap ? { overlap: built.overlap } : {}),
      ...(warnings.length ? { warnings } : {}),
    };
  going(signal);
  await hold({ ...resume, unsent: true });
  // a ComfyUI from before prompt ids could be chosen gives one of its own: that one is followed
  // its result nodes: a prompt ComfyUI takes with one of them (or what feeds it) invalid is refused with why (ComfyClient.submit)
  const results = resume.outputs.filter((o) => o.role === "result").map((o) => o.node);
  going(signal);
  const asked = { preview: "latent2rgb" as const, promptId: resume.promptId, outputs: results };
  resume.promptId = await comfy.client.submit(prompt.graph, asked).catch(async (err: unknown) => {
    // a picture this machine had from an earlier job is no longer there (ComfyUI started again unseen, its input folder
    // cleaned): sent again under the same name, the graph stays the same, and the prompt goes once more
    if (!(err instanceof ComfyError) || !again.length || !/afflatus_[0-9a-f]{32}/.test(err.message)) throw err;
    going(signal);
    await Promise.all(again.map((send) => send()));
    return comfy.client.submit(prompt.graph, asked);
  });
  // noted once ComfyUI took it: a prompt it refused loads nothing, and the next job must not think otherwise
  if (base.length) await core.loaded(base.join("|"), mainModel(built));
  return resume;
}

/**
 * When ComfyUI was last asked to drop what Afflatus left in it, by client: at most once an hour. ComfyUI clears its temp
 * folder itself, not its input folder (the Director's pictures) nor its output folder (videos from its own SaveVideo).
 */
const comfyCleaned = new WeakMap<object, number>();
function cleanComfy(comfy: Comfy): void {
  const last = comfyCleaned.get(comfy.client) ?? 0;
  if (Date.now() - last < 60 * 60_000) return;
  comfyCleaned.set(comfy.client, Date.now());
  void comfy.client.cleanInput(24);
  void comfy.client.cleanOutput(24);
}

/**
 * Whether ComfyUI has this prompt: running or waiting, or done (in its history). The queue is asked first: a prompt goes
 * from the queue to the history and never back, so one that finishes between the two questions is found in the history.
 * Asked the other way round, a prompt that finished in between was in neither answer, and was sent a second time.
 */
export async function taken(comfy: Comfy, promptId: string): Promise<boolean> {
  if ((await comfy.client.queuePosition(promptId)) !== "absent") return true;
  return Boolean(await comfy.client.history(promptId));
}

/** A picture the recipe takes; a mask says where it was painted, which is all that is redone. */
async function uploadImage(up: Up, spec: InputSpec, value: string): Promise<void> {
  const { db, storage, sent } = up;
  const asset = await db.selectFrom("assets").select(["file_key", "mime", "width", "height", "kind"]).where("id", "=", value).executeTakeFirst();
  if (!asset) throw new Error(`the ${spec.label.toLowerCase()} is no longer in your library`);
  if (asset.kind !== "image") throw new Error(`the ${spec.label.toLowerCase()} is not a picture`);
  const bytes = await storage.get(asset.file_key);
  const intoInput = spec.type === "image" && spec.folder === "input";
  // a pinned frame mirrored at render time is flipped on its way up, as a PNG of the same size: the library's file stays as it is
  const flipped = up.mirror.includes(spec.id) ? await mirrorPicture(bytes, "horizontal") : null;
  if (up.mirror.includes(spec.id) && !flipped) throw new Error(`the ${spec.label.toLowerCase()} could not be mirrored: sharp could not read it`);
  sent.uploads[spec.id] = flipped ? await up.picture(flipped, "png", intoInput ? { into: "input" } : {}) : await up.picture(bytes, extOf(asset.mime), intoInput ? { into: "input" } : {});
  const size = asset.width && asset.height ? { width: asset.width, height: asset.height } : await readPicture(bytes);
  sent.media[spec.id] = { width: size?.width ?? 0, height: size?.height ?? 0 };
  if (spec.type === "image" && spec.role === "mask") {
    // only the part that was painted is redone: where it is comes from the mask itself
    const painted = await maskBox(bytes);
    if (painted && !painted.box) throw new Error("The mask is empty. Paint over the part to inpaint.");
    if (painted?.box) sent.media[spec.id] = { width: painted.width, height: painted.height, box: painted.box };
  }
}

/**
 * A video an imported workflow's own loader reads: the file goes up as it is, or, when a moment was chosen
 * (carry on from there, arrive there), the part up to that moment or from it.
 */
async function uploadWholeClip(up: Up, spec: InputSpec, value: ClipValue): Promise<void> {
  const { db, storage, upload, signal, sent } = up;
  if (spec.type !== "clip") return;
  const { asset: assetId, at } = value;
  const asset = await db.selectFrom("assets").selectAll().where("id", "=", assetId).executeTakeFirst();
  if (!asset || asset.kind !== "video") throw new Error(`the ${spec.label.toLowerCase()} is no longer in your library`);
  // read where it is stored: a 5-minute source held whole in memory for each window cost ~750 MB
  const source = await sourceOf(storage, asset.file_key);
  const facts = await factsOf(asset, source, spec.label);
  const length = facts.durationMs;
  // a source video's part (a swap): cut there and re-timed to the recipe's speed, at its own size, with its sound
  if (spec.role === "source" && spec.window) {
    const window = windowOf(spec, up.input, facts);
    // cut while the window before it rendered, when it was (cutAhead)
    const part = await (takeAhead(asset.file_key, window) ?? referenceClip(source, extOf(asset.mime), window));
    sent.uploads[spec.id] = await upload(part.bytes, "mp4");
    sent.media[spec.id] = { width: part.width, height: part.height, hasSound: part.hasSound, frames: part.frames, fps: spec.fps, seconds: window.seconds };
    return;
  }
  // a source video is worked on whole: only a clip carried on from or arrived at has a moment
  const cut = spec.role !== "source" && at !== undefined && length > 0 && (spec.role === "previous" ? at < length - FRAME_SLACK_MS : at > FRAME_SLACK_MS);
  const keep: [number, number] = spec.role === "previous" ? [0, at ?? length] : [at ?? 0, length];
  sent.uploads[spec.id] = cut
    ? await upload(await rangeKeep(source, extOf(asset.mime), { durationMs: length, hasSound: facts.hasSound }, [keep], { signal }), "mp4")
    : await upload(await sendable(storage, asset.file_key), extOf(asset.mime));
  sent.media[spec.id] = { width: facts.width, height: facts.height, hasSound: facts.hasSound };
}

/** A video's facts as its row has them, else read off its file; refused with why when it cannot be read. */
async function factsOf(asset: Pick<Tables["assets"], "width" | "height" | "duration_ms" | "has_sound" | "mime">, source: string | Uint8Array, label: string): Promise<{ width: number; height: number; durationMs: number; hasSound: boolean }> {
  if (asset.width && asset.height && asset.duration_ms) return { width: asset.width, height: asset.height, durationMs: asset.duration_ms, hasSound: Boolean(asset.has_sound) };
  const read = typeof source === "string" ? { facts: await videoFacts(source), why: undefined } : await readVideo(source, extOf(asset.mime));
  // a video that could not be read is refused with why: sent whole at 0×0, the workflow would fail on it with less to go on
  if (!read.facts) throw new Error(`The ${label.toLowerCase()} could not be read: ${read.why ?? "ffprobe gave nothing."}`);
  return read.facts;
}

/** The part of a source a window takes, as its form says it, within the source: where it starts, how long, at the recipe's speed and the source's size. */
function windowOf(spec: InputSpec & { type: "clip" }, input: Record<string, unknown>, facts: { width: number; height: number; durationMs: number }) {
  const total = facts.durationMs / 1000;
  const start = Math.max(0, Math.min(Number(input[spec.window!.start] ?? 0), Math.max(0, total - 0.5)));
  const seconds = Math.max(0.2, Math.min(Number(input[spec.window!.seconds] ?? total), total - start));
  return { start, seconds, fps: spec.fps, short: Math.min(facts.width, facts.height) };
}

type Part = Awaited<ReturnType<typeof referenceClip>>;
/** The parts of a source cut ahead for the window after the one rendering (cutAhead), by file and window; a few, for a few minutes. */
const ahead = new Map<string, { at: number; part: Promise<Part> }>();
const AHEAD_MS = 10 * 60_000;
const aheadKey = (fileKey: string, w: ReturnType<typeof windowOf>) => `${fileKey}|${w.start}|${w.seconds}|${w.fps}|${w.short}`;

/** The part cut ahead for this window, taken (it is used once); undefined when none was, or it failed. */
function takeAhead(fileKey: string, w: ReturnType<typeof windowOf>): Promise<Part> | undefined {
  const key = aheadKey(fileKey, w);
  const kept = ahead.get(key);
  ahead.delete(key);
  if (!kept || Date.now() - kept.at > AHEAD_MS) return undefined;
  return kept.part;
}

/**
 * While a job renders, the driving part of the windows that carry on from it is cut (a motion transfer of a long source,
 * window after window): the next window then only sends it, and its machine's GPU does not wait for ffmpeg. Best effort, in
 * the ffmpeg pool: a part that comes out otherwise than the job asks at its start is not used, and is cut again then.
 */
export async function cutAhead(core: QueueCore, row: Pick<JobRow, "id">): Promise<void> {
  const next = await core.db.selectFrom("jobs").select(["recipe_id", "inputs"]).where("depends_on", "=", row.id).where("status", "=", "queued").execute();
  for (const job of next) {
    const recipe = core.registry.recipe(job.recipe_id);
    const spec = recipe?.inputs.find((s) => s.type === "clip" && s.role === "source" && s.whole && s.window) as (InputSpec & { type: "clip" }) | undefined;
    if (!recipe || !spec) continue;
    const input = readJson<Record<string, unknown>>(job.inputs, {});
    const value = input[spec.id] as ClipValue | undefined;
    if (!value?.asset) continue;
    const asset = await core.db.selectFrom("assets").selectAll().where("id", "=", value.asset).executeTakeFirst();
    if (!asset || asset.kind !== "video" || !asset.width || !asset.height || !asset.duration_ms) continue;
    const window = windowOf(spec, input, { width: asset.width, height: asset.height, durationMs: asset.duration_ms });
    const key = aheadKey(asset.file_key, window);
    if (ahead.has(key)) continue;
    for (const [k, v] of ahead) if (Date.now() - v.at > AHEAD_MS || ahead.size >= 4) ahead.delete(k);
    const part = ffmpegPool(async () => referenceClip(await sourceOf(core.storage, asset.file_key), extOf(asset.mime), window));
    // a part that could not be cut is cut again by its own job, which says why
    part.catch(() => ahead.get(key)?.part === part && ahead.delete(key));
    ahead.set(key, { at: Date.now(), part });
  }
}

/** The clips a form joins onto (a continuation's clip before, a clip after): its prompt waits for their figures (queueStore.measuredFirst). */
function joinedOnto(recipe: Recipe<any>, input: Record<string, unknown>): string[] {
  return (recipe.inputs as InputSpec[]).flatMap((spec) => {
    const value = input[spec.id] as ClipValue | undefined;
    return spec.type === "clip" && !spec.whole && value?.asset ? [value.asset] : [];
  });
}

/** Of the clip a clip joins onto, a few frames with their sound, cut at the chosen moment; and its latent, when it can be joined in it. */
async function uploadJoinClip(up: Up, spec: InputSpec, value: ClipValue): Promise<void> {
  if (spec.type !== "clip") return;
  const { db, storage, upload, input, signal, sent } = up;
  const { asset: assetId, at } = value;
  const shown = await db.selectFrom("assets").selectAll().where("id", "=", assetId).executeTakeFirst();
  if (!shown || shown.kind !== "video") throw new Error(`the ${spec.role === "previous" ? "previous" : "next"} clip is no longer in your library`);
  // a finished (upscaled) take is a copy of a render: the render's own latent and frames are what a join takes. A finish by
  // H3's latent re-sample is conditioned on the drafts, as the draft it re-samples was
  const asset = up.finishedFrom ? await draftOf(db, shown) : await renderedOf(db, shown);
  // the model's own frames when they were kept (before an upscale or interpolation changed them): a
  // continuation guided by frames of its own kind joins without the step a changed frame leaves
  const rawBytes = asset.raw_key ? await storage.get(asset.raw_key).catch(() => null) : null;
  const rawRead = rawBytes ? await readVideo(rawBytes, extOf(asset.mime)).catch(() => null) : null;
  if (asset.raw_key && !rawRead?.facts) sent.warnings.push(`The model's own frames of the ${spec.role === "previous" ? "clip before" : "clip after"} were not found: the join took its finished frames.`);
  const bytes = rawRead?.facts ? rawBytes! : await storage.get(asset.file_key);
  const read = rawRead?.facts || (asset.duration_ms && asset.width && asset.height) ? null : await readVideo(bytes, extOf(asset.mime));
  const facts = rawRead?.facts
    ? rawRead.facts
    : read
      ? read.facts
      : { durationMs: asset.duration_ms!, width: asset.width!, height: asset.height!, hasSound: Boolean(asset.has_sound) };
  // said as what went wrong: ffmpeg missing, out of time, or this file refused are three different fixes
  if (!facts) throw new Error(`The ${spec.role === "previous" ? "clip before" : "clip after"} could not be read for the join: ${read?.why ?? "ffprobe gave nothing."}`);
  // the form may say how many frames the join takes first; shorter counts stay as fallbacks for a short clip
  const wanted = spec.framesFrom ? Number(input[spec.framesFrom]) : NaN;
  const counts = Number.isFinite(wanted) && wanted > 0 ? [wanted, ...spec.frames.filter((c) => c < wanted)] : spec.frames;
  const cut = await cutFrames(bytes, extOf(asset.mime), facts, { counts, fps: spec.fps, side: spec.role === "previous" ? "before" : "after", at, signal });
  sent.media[spec.id] = { width: facts.width, height: facts.height, frames: cut.frames, fps: spec.fps, hasSound: facts.hasSound };
  // the frames, the last frame as it was finished and the latent go up at once
  const [frames] = await Promise.all([
    upload(cut.bytes, "mp4"),
    spec.look && spec.role === "previous" ? uploadLook(up, spec, asset, rawRead?.facts ? null : bytes, at) : null,
    finishLatent(up, spec, asset, shown, { at, counts, durationMs: facts.durationMs ?? 0 }),
  ]);
  sent.uploads[spec.id] = frames;
}

/**
 * The clip before's last frame as it was filed, under "<input>.look": half a frame of the model's before where it stops. Not
 * read, it is said, and the recipe matches as it does without one (Motion transfer: to its own driving video).
 */
async function uploadLook(up: Up, spec: InputSpec & { type: "clip" }, asset: Pick<Tables["assets"], "file_key" | "mime" | "duration_ms">, finished: Uint8Array | null, at: number | undefined): Promise<void> {
  const { storage, upload, signal, sent } = up;
  try {
    going(signal);
    const bytes = finished ?? (await storage.get(asset.file_key));
    const end = at ?? asset.duration_ms ?? 0;
    const frame = await frameAt(bytes, extOf(asset.mime), Math.max(0, end - 500 / spec.fps), asset.duration_ms ?? undefined);
    sent.uploads[`${spec.id}.look`] = await upload(frame, "png");
  } catch (err) {
    going(signal);
    sent.warnings.push(`The last frame of the clip before, as it was finished, could not be read (${(err as Error).message}): this clip was matched to its own driving video.`);
  }
}

/**
 * The clip's own latent, when it was kept: a recipe that can join in the latent (the Afflatus node pack)
 * takes it instead of the frames. The clip before is continued from its end, as its latent holds it; the
 * clip after is landed on where its playing part starts, a moment on the latent's frame grid. A latent that
 * fits but cannot be read makes the join one on frames, which the job says.
 */
async function finishLatent(
  { recipe, storage, upload, catalog, finishedFrom, sent }: Up, spec: InputSpec & { type: "clip" },
  asset: Pick<Tables["assets"], "latent_key" | "latent_frames">, shown: Pick<Tables["assets"], "fine_latent_key" | "width" | "height">,
  cut: { at: number | undefined; counts: number[]; durationMs: number },
): Promise<void> {
  if (!asset.latent_key || !asset.latent_frames) return;
  const { at, counts } = cut;
  const atFrames = at === undefined ? 0 : Math.round((at / 1000) * spec.fps);
  const whole = spec.role === "previous" && (at === undefined || at >= cut.durationMs - FRAME_SLACK_MS);
  // handed over before its end, on a frame of the latent's grid: continued from there, its latent cut to it (Afflatus's pack 0.5.0)
  // (the recipe names the node that cuts it, traits.latentTrim, and its grid, traits.frameGrid)
  const { frameGrid: grid, latentTrim: trim } = recipe.traits ?? {};
  const cutAt = spec.role === "previous" && !whole && grid && trim && onGrid(atFrames, grid) && atFrames >= Math.max(...counts) && atFrames <= asset.latent_frames && trim in catalog ? atFrames : 0;
  // the clip after: landed on where one of its latent's chunks begins (its tokens keep their time spans there, see H3_LANDING)
  const fits = spec.role === "previous" ? whole || cutAt > 0 : Boolean(grid) && isChunkStart(atFrames, grid!) && atFrames + Math.min(...counts) <= asset.latent_frames;
  if (!fits) return;
  const saved = await sendable(storage, asset.latent_key).catch(() => null);
  if (!saved) {
    sent.warnings.push(`The latent of the ${spec.role === "previous" ? "clip before" : "clip after"} was not found: the join was made on frames instead.`);
    return;
  }
  sent.uploads[`${spec.id}.latent`] = await upload(saved, "safetensors");
  sent.media[spec.id] = { ...sent.media[spec.id]!, latentFrames: cutAt || asset.latent_frames, ...(cutAt ? { latentCut: cutAt } : {}), ...(spec.role === "next" ? { latentAt: atFrames } : {}) };
  // a finish after a clip finished by the same latent re-sample: that clip's re-sampled latent, for decoding the join as one piece with it
  const wantsFine = Boolean(finishedFrom && spec.role === "previous" && shown.fine_latent_key && shown.width && shown.height);
  const fine = wantsFine ? await sendable(storage, shown.fine_latent_key!).catch(() => null) : null;
  // said on the job like the other fallbacks: the join is then decoded on its own, and may show where the two meet
  if (wantsFine && !fine) sent.warnings.push("The re-sampled latent of the clip before was not found: the join was not decoded as one piece with it.");
  if (fine) {
    sent.uploads[`${spec.id}.fine`] = await upload(fine, "safetensors");
    sent.media[spec.id] = { ...sent.media[spec.id]!, fine: { width: shown.width!, height: shown.height! } };
  }
}

/** Each reference picture (or video: its first three seconds, small, with its sound) goes up under "<input>.<n>", in the order they were given. */
async function uploadReferences({ db, storage, upload, picture, signal, sent }: Up, spec: InputSpec, refs: ReferenceValue[]): Promise<void> {
  if (spec.type !== "references") return;
  const ids = [...new Set(refs.map((r) => r.asset))];
  const rows = ids.length ? await db.selectFrom("assets").select(["id", "file_key", "mime", "width", "height", "kind"]).where("id", "in", ids).execute() : [];
  const found = new Map(rows.map((r) => [r.id, r]));
  // each one's own kind is checked before anything goes up
  for (const ref of refs) {
    const asset = found.get(ref.asset);
    if (spec.media === "video" && (!asset || asset.kind !== "video")) throw new Error("a reference video is no longer in your library");
    if (spec.media !== "video" && (!asset || asset.kind !== "image")) throw new Error("a reference image is no longer in your library");
  }
  await Promise.all(refs.map(async (ref, i) => {
    const asset = found.get(ref.asset)!;
    if (spec.media === "video") {
      going(signal);
      const clip = await referenceClip(await sourceOf(storage, asset.file_key), extOf(asset.mime), { seconds: 3, fps: 24, short: 384 });
      sent.uploads[`${spec.id}.${i}`] = await upload(clip.bytes, "mp4");
      sent.media[`${spec.id}.${i}`] = { width: clip.width, height: clip.height, frames: clip.frames, fps: 24, hasSound: clip.hasSound };
      return;
    }
    sent.uploads[`${spec.id}.${i}`] = await picture(await storage.get(asset.file_key), extOf(asset.mime));
    sent.media[`${spec.id}.${i}`] = { width: asset.width ?? 0, height: asset.height ?? 0 };
  }));
}

/** A sound, or a video whose sound is used (ComfyUI's loader reads the sound track of either): the chosen part of it, when the recipe has one. */
async function uploadSound({ db, storage, upload, input, signal, sent }: Up, spec: InputSpec, value: string): Promise<void> {
  if (spec.type !== "audio") return;
  const asset = await db.selectFrom("assets").select(["file_key", "mime", "kind", "has_sound", "duration_ms"]).where("id", "=", value).executeTakeFirst();
  if (!asset || (asset.kind !== "audio" && !(asset.kind === "video" && asset.has_sound))) throw new Error(`the ${spec.label.toLowerCase()} is no longer in your library`);
  if (!spec.window) {
    sent.uploads[spec.id] = await upload(await sendable(storage, asset.file_key), extOf(asset.mime));
    return;
  }
  const whole = await sourceOf(storage, asset.file_key);
  // only the chosen part of it is handed over: a few clean seconds carry a voice better than a long take
  // (a sound ffmpeg cannot cut, or no ffmpeg at all: the whole of it is used, as before there was a part to set)
  going(signal);
  const asked = { start: Number(input[spec.window.start] ?? 0), seconds: Number(input[spec.window.seconds] ?? 8) };
  const even = Boolean(spec.window.even && input[spec.window.even]);
  const after = spec.window.after ?? 0;
  const part = await soundPart(whole, extOf(asset.mime), { ...asked, durationMs: asset.duration_ms, even, after }).catch((err) => {
    sent.warnings.push(`The part of the ${spec.label.toLowerCase()} could not be cut (${(err as Error).message}): the whole sound was used.`);
    return null;
  });
  sent.uploads[spec.id] = part ? await upload(part, "wav") : await upload(await sendable(storage, asset.file_key), extOf(asset.mime));
  // how long the part really is (a sound that ends before the part asked for gives less): a recipe that follows it, a lip sync, is made that long
  const seconds = part ? partOf(asked.start, asked.seconds, asset.duration_ms ? asset.duration_ms / 1000 : null).seconds : asset.duration_ms ? asset.duration_ms / 1000 : undefined;
  if (seconds) sent.media[spec.id] = { width: 0, height: 0, seconds, ...(part && after ? { after } : {}) };
}

/** A part painted on one picture cannot be put on another one. */
function checkMasks(recipe: Recipe<any>, media: Record<string, MediaFacts>): void {
  for (const spec of recipe.inputs as InputSpec[]) {
    if (spec.type !== "image" || spec.role !== "mask" || !spec.of) continue;
    const mask = media[spec.id];
    const picture = media[spec.of];
    if (mask && picture?.width && (mask.width !== picture.width || mask.height !== picture.height)) throw new Error("The mask was painted on another image. Paint it again on this one.");
  }
}

/** For the record of render times: what a render is filed under, whether its model had to load, and what was expected of it on the machine it runs on. */
async function timingOf(core: QueueCore, recipe: Recipe<any>, chosen: Record<string, unknown>, built: BuiltGraph, cold: boolean): Promise<Resume["timing"]> {
  const work = workOf(built);
  return {
    model: mainModel(built) ?? "", modelFile: modelFileOf(recipe, chosen, built),
    timeKey: timeKey(recipe.inputs, chosen), cold, expectedMs: ((await forecastFrom(core, recipe, chosen, built, cold, { machine: core.machineId, paces: await core.paces() })) ?? fromRates((await core.usual()).rates, recipe, chosen))?.ms ?? null,
    expect: await usualParts(core.db, recipe, chosen).catch(() => ({})),
    // what it samples per step, kept with its figures: the next form like it is forecast from them
    work: work.pixels * work.frames,
  };
}

/** The prompt to send ComfyUI, under an id chosen here: the graph, or for a preload only the part that loads its models. */
async function promptOf(comfy: Comfy, built: BuiltGraph, warm: boolean, cut: ReturnType<typeof warmGraph> = null): Promise<{ graph: BuiltGraph["graph"]; resume: Pick<Resume, "promptId" | "totalSteps" | "phases" | "passes" | "clientId"> }> {
  const promptId = randomUUID();
  if (warm) {
    const catalog = await comfy.catalog();
    // `cut`: the loaders alone, made already (a load without the form's pictures)
    const graph = cut ?? warmGraph(built);
    if (!graph) throw new Error("this loads no model: there is nothing to preload");
    if (!(WARM_SINK in catalog)) throw new Error(`ComfyUI is missing the ${WARM_SINK} node, which preloading a model needs. Update ComfyUI.`);
    return { graph: graph.graph, resume: { promptId, totalSteps: 1, phases: graph.phases, passes: graph.pass ? [graph.pass] : [], clientId: comfy.client.clientId } };
  }
  return { graph: built.graph, resume: { promptId, totalSteps: built.totalSteps, phases: built.phases, passes: built.passes, clientId: comfy.client.clientId } };
}

/** The files a family's recipes need, as this ComfyUI has them. */
async function slots(core: QueueCore, comfy: Comfy, recipe: Recipe<any>): Promise<Record<string, string>> {
  const slots: Record<string, string> = {};
  const scan = await comfy.scan();
  // not reached: no file can be told missing, and the job waits for ComfyUI as a lost one does (a swap's retry once said its
  // LoRA was missing while ComfyUI had stopped answering on 127.0.0.1, 2026-10-13)
  if (!scan.comfy.online) throw new ComfyUnreachable(`ComfyUI did not answer at ${comfy.client.baseUrl}`);
  const scanned = scan.families.find((f) => f.id === recipe.family);
  for (const s of scanned?.slots ?? []) {
    if (s.file) slots[s.id] = s.file;
    else if (!s.optional) throw new Error(`a model file ${core.registry.family(recipe.family)?.name ?? recipe.family} needs was not found. ${s.hint}`);
  }
  return slots;
}

/**
 * Whether a graph's model has to be loaded, against what ComfyUI was last asked to load (`lastLoads`): its main model (the
 * checkpoint or diffusion model) is not among them. A change of text encoder or VAE alone is not: ComfyUI loads it beside
 * the model it keeps, making room itself if it must, while a /free threw the main model out too, read again from the disk
 * (two minutes for a checkpoint on a hard disk). A graph whose main model cannot be told counts every base model, as
 * before; one with no base model loads nothing.
 */
export function coldOf(lastLoads: string | null, built: Pick<BuiltGraph, "graph" | "outputs">): boolean {
  const base = baseModels(built);
  if (!base.length) return false;
  if (lastLoads === null) return true;
  const held = new Set(lastLoads.split("|").map(modelName));
  const main = mainModel(built);
  const wanted = main ? main.split(" + ").map((m) => m.toLowerCase()) : base.map(modelName);
  return !wanted.every((m) => held.has(m));
}

/** Every one of these base models is among the ones the last job loaded. */
function holding(core: QueueCore, base: string[]): boolean {
  if (core.lastLoads === null) return false;
  const held = new Set(core.lastLoads.split("|").map(modelFileName));
  return base.every((f) => held.has(f));
}

/**
 * The graph a form (or a past render: its inputs and its seed) gives, built without uploading anything:
 * the files a render would send are stood in for by `names` (the file's own name, to be read in the
 * graph), else by a placeholder, with the facts a render would send of them (a picture's size, a clip's
 * size and the frames a join takes of it): what the graph samples is the one the render will. `finishedFrom`:
 * the job finishes a draft, and a recipe that re-samples the draft's own latent is built from it; `canvas`: a
 * timeline's frame. Null when the form is not complete enough to build.
 */
export async function builtOf(core: QueueCore, recipeId: string, rawInput: unknown, opts: { seed?: number; names?: Record<string, string>; finishedFrom?: string | null; canvas?: { width: number; height: number } } = {}): Promise<BuiltGraph | null> {
  const recipe = core.registry.recipe(recipeId);
  if (!recipe) return null;
  const input = parseInput(recipe, withTexts(recipe, rawInput)) as Record<string, unknown>;
  const comfy = await core.comfy();
  const catalog = await comfy.catalog();
  const uploads: Record<string, string> = {};
  const media: Record<string, MediaFacts> = {};
  const standIn = (key: string, asset: string, facts: MediaFacts | null) => {
    uploads[key] = opts.names?.[asset] ?? "stand-in";
    media[key] = facts ?? { width: 1024, height: 1024 };
  };
  for (const spec of recipe.inputs as InputSpec[]) {
    const value = input[spec.id];
    if ((spec.type === "image" || spec.type === "audio") && typeof value === "string") standIn(spec.id, value, spec.type === "image" ? await pictureFacts(core.db, value) : null);
    else if (spec.type === "clip" && value && typeof value === "object") standIn(spec.id, (value as ClipValue).asset, await clipFacts(core, spec, value as ClipValue, input, opts.finishedFrom ?? null));
    else if (spec.type === "references" && Array.isArray(value)) {
      for (const [i, v] of value.entries()) {
        const asset = typeof v === "string" ? v : String((v as { asset?: string })?.asset ?? "");
        standIn(`${spec.id}.${i}`, asset, spec.media === "video" ? await referenceFacts(core.db, asset) : await pictureFacts(core.db, asset));
      }
    }
  }
  // a finish that re-samples the draft's own latent is built on it, as submit builds it: else it is built as the draft and its finish both
  if (opts.finishedFrom && recipe.finishing?.(input)?.latent === "own") uploads["self.latent"] = "stand-in";
  const built = recipe.build(settled(recipe, input, catalog), { seed: opts.seed ?? 1, slots: await slots(core, comfy, recipe), uploads, media, canvas: opts.canvas, has: (cls: string) => cls in catalog });
  relocateFiles(built.graph, catalog);
  return built;
}

/** A library picture's size, as uploadImage sends it; null when it is not known (the stand-in's square is used). */
async function pictureFacts(db: Db, id: string): Promise<MediaFacts | null> {
  const a = (await sizesOf(db, id)).get(id);
  return a?.width && a.height ? { width: a.width, height: a.height } : null;
}

/**
 * The pictures' sizes asked in one turn, read in one statement: the queue's forecasts build every waiting form at once, warm
 * and cold, and each asked for its picture on its own (34 statements for 120 jobs).
 */
const sizeBatches = new WeakMap<Db, { ids: Set<string>; read: Promise<Map<string, { width: number | null; height: number | null }>> }>();
function sizesOf(db: Db, id: string) {
  let batch = sizeBatches.get(db);
  if (!batch) {
    const ids = new Set<string>();
    const read = new Promise((go) => setImmediate(go)).then(async () => {
      // what is asked from now on goes in the next one
      sizeBatches.delete(db);
      const all = [...ids];
      const rows = [];
      for (let i = 0; i < all.length; i += 500) rows.push(...(await db.selectFrom("assets").select(["id", "width", "height"]).where("id", "in", all.slice(i, i + 500)).execute()));
      return new Map(rows.map((r) => [r.id, r]));
    });
    batch = { ids, read };
    sizeBatches.set(db, batch);
  }
  batch.ids.add(id);
  return batch.read;
}

/** A reference video as uploadReferences sends it: its first three seconds at 24 frames a second, 384 pixels on its short side. */
async function referenceFacts(db: Db, id: string): Promise<MediaFacts | null> {
  const a = await db.selectFrom("assets").select(["width", "height", "duration_ms", "has_sound"]).where("id", "=", id).executeTakeFirst();
  if (!a?.width || !a.height) return null;
  const k = 384 / Math.min(a.width, a.height);
  const frames = Math.max(1, Math.min(72, Math.floor(((a.duration_ms ?? 3000) / 1000) * 24)));
  return { width: Math.round((a.width * k) / 2) * 2, height: Math.round((a.height * k) / 2) * 2, frames, fps: 24, hasSound: Boolean(a.has_sound) };
}

/** The size of a render's own frames (kept beside an upscaled take), read once per file: a file kept under a key never changes. */
const rawSizes = new Map<string, Promise<{ width: number; height: number } | null>>();

/**
 * A clip as uploadWholeClip or uploadJoinClip sends it, without cutting or uploading anything: its size (the render's own
 * frames when they were kept), and for a join the frames it would be handed (the first count it is long enough for).
 */
async function clipFacts(core: QueueCore, spec: InputSpec & { type: "clip" }, value: ClipValue, input: Record<string, unknown>, finishedFrom: string | null): Promise<MediaFacts | null> {
  const { db, storage } = core;
  const shown = await db.selectFrom("assets").selectAll().where("id", "=", value.asset).executeTakeFirst();
  if (!shown || shown.kind !== "video" || !shown.width || !shown.height) return null;
  if (spec.whole) return { width: shown.width, height: shown.height, hasSound: Boolean(shown.has_sound) };
  const asset = finishedFrom ? await draftOf(db, shown) : await renderedOf(db, shown);
  const key = asset.raw_key;
  if (key && !rawSizes.has(key)) {
    rawSizes.set(key, storage.get(key).then((bytes) => readVideo(bytes, extOf(asset.mime))).then((r) => (r.facts ? { width: r.facts.width, height: r.facts.height } : null), () => null));
  }
  const size = (key ? await rawSizes.get(key)! : null) ?? (asset.width && asset.height ? { width: asset.width, height: asset.height } : { width: shown.width, height: shown.height });
  const length = asset.duration_ms ?? shown.duration_ms ?? 0;
  const room = spec.role === "previous" ? (value.at ?? length) : length - (value.at ?? 0);
  const wanted = spec.framesFrom ? Number(input[spec.framesFrom]) : NaN;
  const counts = Number.isFinite(wanted) && wanted > 0 ? [wanted, ...spec.frames.filter((c) => c < wanted)] : spec.frames;
  const frames = counts.find((c) => c <= Math.floor((room / 1000) * spec.fps)) ?? counts[counts.length - 1]!;
  return { ...size, frames, fps: spec.fps, hasSound: Boolean(asset.has_sound) };
}

/**
 * What a form will take: its sampled work against its model's past renders (forecast.ts), else, for a form that
 * cannot be placed (a tool with no steps, a model never measured, ComfyUI away so nothing is built), what its
 * recipe's renders usually took. The one figure every place says: the form's Output line, the Generate button, the
 * command bar, the editor, the queue's rows and the running job's time left. Null for a form not complete enough
 * to read, or one like nothing rendered here yet. `cold` says whether its model has to load (the queue knows it
 * for a job further down the line); left out, it is whether its base models are the ones ComfyUI holds now. A job
 * that finishes a draft (`finishedFrom`) is built on it; a timeline clip's (`clip`) with what it joins onto as far as
 * it is known now, as submit will build it: the frames it shares with its neighbours are sampled too. `machine`: on that
 * machine (its own renders, else the others' at its pace: forecast.ts onMachine); left out, every machine's renders as they
 * are. `machines`: each one's forecast too (`on`), from the one graph built. `loads`: what each machine was last asked to
 * load (its lane's lastLoads), so that with `cold` left out each is told whether it holds the model itself: judged by the
 * first machine's, a machine holding another model was told it warm.
 */
export async function forecastOf(
  core: QueueCore, recipeId: string, rawInput: unknown,
  opts: { cold?: boolean; finishedFrom?: string | null; clip?: { id: string; fit: boolean } | null; machine?: string | null; machines?: readonly string[]; loads?: (machine: string) => string | null } = {},
): Promise<{ forecast: Forecast; shape: { pixels: number; frames: number }; model: string; on?: Record<string, Forecast> } | null> {
  const recipe = core.registry.recipe(recipeId);
  if (!recipe) return null;
  let chosen: Record<string, unknown>;
  try {
    chosen = parseInput(recipe, withTexts(recipe, rawInput)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const plan = opts.clip && core.clips ? await core.clips.plan(opts.clip.id, recipe, chosen, opts.clip.fit, opts.finishedFrom ?? null, true).catch(() => null) : null;
  if (plan) chosen = parseInput(recipe, withTexts(recipe, plan.input)) as Record<string, unknown>;
  const built = await builtOf(core, recipeId, plan ? plan.input : rawInput, { finishedFrom: opts.finishedFrom ?? null, canvas: plan?.canvas }).catch(() => null);
  // its settings as submit files them: a file left on its default that this ComfyUI does not have is its best one (the time key)
  if (built) chosen = settled(recipe, chosen, await (await core.comfy()).catalog());
  const shape = built ? workOf(built) : null;
  const model = built ? modelFileOf(recipe, chosen, built) : (modelOf(recipe.inputs, chosen) ?? "");
  const paces = opts.machine || opts.machines?.length ? await core.paces() : undefined;
  const coldOn = (machine: string | null) => opts.cold ?? (machine !== null && opts.loads ? coldOf(opts.loads(machine), built!) : null);
  const at = (machine: string | null) => (built && shape?.pixels ? forecastFrom(core, recipe, chosen, built, coldOn(machine), { machine, paces }) : Promise.resolve(null));
  const f = await at(opts.machine ?? null);
  if (f) {
    const on = opts.machines?.length ? Object.fromEntries((await Promise.all(opts.machines.map(async (m) => [m, await at(m)] as const))).flatMap(([m, g]) => (g ? [[m, g]] : []))) : undefined;
    return { forecast: f, shape: shape!, model, ...(on ? { on } : {}) };
  }
  const fallback = fromRates((await core.usual()).rates, recipe, chosen);
  return fallback ? { forecast: fallback, shape: { pixels: shape?.pixels ?? 0, frames: shape?.frames ?? 1 }, model } : null;
}

/** The model file a render is recorded under (render_stats.model_file). */
const modelFileOf = (recipe: Recipe<any>, chosen: Record<string, unknown>, built: BuiltGraph) => modelOf(recipe.inputs, chosen) ?? (mainModel(built) ?? "").split(" + ")[0]!.toLowerCase();

/** The forecast of a built graph from its model's past renders; `cold` null: whether its base models are not the ones held now. */
async function forecastFrom(
  core: QueueCore, recipe: Recipe<any>, chosen: Record<string, unknown>, built: BuiltGraph, cold: boolean | null, where: { machine: string | null; paces?: ReadonlyMap<string, number> },
): Promise<Forecast | null> {
  const shape = workOf(built);
  if (!shape.pixels) return null;
  return forecast(core.db, modelFileOf(recipe, chosen, built), shape.pixels * shape.frames, shape.steps, cold ?? coldOf(core.lastLoads, built), {
    recipeId: recipe.id, timeKey: timeKey(recipe.inputs, chosen), family: recipe.family, fps: (id) => core.registry.recipe(id)?.traits?.fps,
    samples: Object.values(built.phases).includes("sampling"), chunks: chunksOf(built, shape.pixels), rows: (file) => core.statRows(file), ...where,
  });
}

/**
 * Whether the base models a form would use are the ones ComfyUI was last asked to load. Null when it
 * cannot be told (the form is not complete enough to build its graph, ComfyUI is away). It is what
 * this app last asked for: a ComfyUI that was restarted since, or used from elsewhere, is not seen.
 */
export async function isLoaded(core: QueueCore, recipeId: string, rawInput: unknown): Promise<boolean | null> {
  try {
    const built = await builtOf(core, recipeId, rawInput);
    // loaded when its main model is: a VAE or text encoder of its own is loaded beside it without a wait worth saying
    if (built && baseModels(built).length) return !coldOf(core.lastLoads, built);
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
