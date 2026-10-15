import type { OutputFile, waitForOutputs } from "@afflatus/comfy";
import type { ClipValue, InputSpec, Recipe, ReferenceValue } from "@afflatus/core";
import { draftNames, labelNames, passName, promptOf } from "./autoName";
import type { Comfy } from "./comfy";
import { frameAt, repairJoinAudio, type Measure } from "./cut";
import { newId, now, OWNER, type Db, type Tables } from "./db";
import { latentDriftOf } from "./latentStats";
import { measureLanded, precomputeOf } from "./precompute";
import { extOf, mimeOfFile, newAssetRow, pngSize } from "./media";
import { makeThumb, thumbKey } from "./thumbs";
import { ffmpegPool } from "./pool";
import { sourceOf, type Storage } from "./storage";
import { readVideo, videoFacts, type VideoFacts } from "./video";
import { readJson, type JobRow, type QueueCore, type Resume } from "./queueModel";

/** What a finished render leaves behind: its files in storage, its rows in the library, and the record of how it was made. */

type Outputs = Awaited<ReturnType<typeof waitForOutputs>>;
type AssetRow = ReturnType<typeof newAssetRow>;

/** The frame count written in the metadata of a latent saved by the Afflatus node pack (a safetensors file: 8 bytes of header length, then the header). */
function latentFramesOf(bytes: Uint8Array): number {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = Number(view.getBigUint64(0, true));
    if (n <= 0 || n > 1_000_000 || 8 + n > bytes.byteLength) return 0;
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + n))) as { __metadata__?: Record<string, string> };
    const frames = Number(header.__metadata__?.frames ?? 0);
    return Number.isFinite(frames) && frames > 0 ? Math.round(frames) : 0;
  } catch {
    return 0;
  }
}

/**
 * Back from a finished (upscaled) take to the take it was finished from, at most four steps, until `stop` says
 * this one will do. The asset itself when it was not finished from another.
 */
async function walkFinished(db: Db, asset: Tables["assets"], stop: (a: Tables["assets"]) => boolean): Promise<Tables["assets"]> {
  let current = asset;
  for (let i = 0; i < 4 && !stop(current); i++) {
    const take = await db.selectFrom("takes").select("finished_from").where("asset_id", "=", current.id).where("finished_from", "is not", null).executeTakeFirst();
    if (!take?.finished_from) break;
    const draft = await db.selectFrom("takes").innerJoin("assets", "assets.id", "takes.asset_id").selectAll("assets").where("takes.id", "=", take.finished_from).executeTakeFirst();
    if (!draft) break;
    current = draft as unknown as Tables["assets"];
  }
  return current;
}

/**
 * The asset that was rendered, for one that is a finished (upscaled) version of it on a timeline: the
 * latent and the model's own frames belong to the render, and a join takes them from there. The asset
 * itself when it holds them, or was not finished from another.
 */
export const renderedOf = (db: Db, asset: Tables["assets"]) => walkFinished(db, asset, (a) => Boolean(a.latent_key || a.raw_key));

/**
 * The draft a finished take was made from, however it was finished: what a finish's own re-render (H3's latent re-sample)
 * is guided by, as the draft was, so that it makes the draft's motion again. The asset itself when it is no finish.
 */
export const draftOf = (db: Db, asset: Tables["assets"]) => walkFinished(db, asset, () => false);

/**
 * Download the results, file them in the library, and record how they were made. What is measured of a video (its look,
 * the step where a continuation's run-up ends, the drift of its latent) is not waited for: it reads the stored file once the
 * rows are written, while the machine takes its next job, and is patched into the generation when it is ready (`measuring`
 * resolves with the milliseconds it took; see measuredFirst for what waits for it).
 */
export async function store(
  core: QueueCore, comfy: Comfy, recipe: Recipe<any>, input: Record<string, unknown>, resume: Resume,
  outputs: Outputs,
  row: Pick<JobRow, "id" | "draft_id" | "folder_id" | "look" | "asked"> & { clip_id?: string | null; label?: string | null },
): Promise<{ id: string; measuring: Promise<number> | null }> {
  const { db, storage } = core;
  const files = collectOutputs(resume, outputs);
  if (!files.length) throw new Error("ComfyUI finished but returned no output");
  const sides = sideFiles(resume, outputs);
  const faces = faceFigures(resume, outputs);
  const face = faces?.face ?? null;
  const generationId = newId();
  const at = now();
  // with the cast it was sent with: what is made from it later (a video of this picture) can take it over
  const resolved: Record<string, unknown> = { seed: resume.seed, loads: resume.loads, ...(resume.overlap ? { overlap: resume.overlap } : {}), ...(resume.mirror?.length ? { mirror: resume.mirror } : {}), ...(row.look ? { look: JSON.parse(row.look) } : {}), ...(face !== null ? { face } : {}), ...(faces?.copies ? { faceCopies: faces.copies } : {}) };
  // the folder that was open when it was sent, when it is still there. Being in a folder does not keep a result:
  // it still goes to the bin after a day unless it is kept
  const folder = row.folder_id ? (await db.selectFrom("folders").select("id").where("id", "=", row.folder_id).executeTakeFirst())?.id ?? null : null;
  // every file comes down from ComfyUI and goes into storage first, with what is read off it; the rows are
  // then written together, so that a failure halfway leaves no generation without its files or the other way round.
  // What was put in storage before a failure is taken out again: no file is left that no row names
  const written: string[] = [];
  // the background measure waits while the result comes down, is filed and measured: the GPU's work is never held up by it
  const filed = precomputeOf(db)?.hold();
  let measuring: Promise<number> | null = null;
  try {
    const rows: AssetRow[] = [];
    // the last video's measure is the generation's, as it always was
    let measure: { asset: string; work: () => Promise<Measure | null> } | null = null;
    for (const { file, kind } of files) {
      const one = await fileOne(core, comfy, recipe, input, resume, { file, kind }, sides, written);
      if (one.measure) measure = { asset: one.row.id, work: one.measure };
      rows.push(newAssetRow({ ...one.row, folder_id: folder, generation_id: generationId, created_at: at }));
    }
    // what a draft made is named after it, numbered on; a timeline clip's take is named once it is placed (autoName.ts)
    const prompts = recipe.inputs.filter((s) => s.type === "prompt" && !s.optional).map((s) => s.id);
    if (row.draft_id && !row.clip_id) {
      const names = await draftNames(db, row.draft_id, rows.length, { prompt: promptOf(input, prompts), recipe: recipe.title });
      names?.forEach((name, i) => (rows[i]!.name ||= name));
    } else if (!row.draft_id && !row.clip_id) {
      // a pass of a named picture (sent with it as its source): named after the picture and the pass
      const sourceSpec = recipe.inputs.find((s) => s.type === "image" && s.role === "source");
      const sourceId = sourceSpec ? input[sourceSpec.id] : undefined;
      const source = typeof sourceId === "string" ? (await db.selectFrom("assets").select("name").where("id", "=", sourceId).executeTakeFirst())?.name?.trim() : "";
      if (source) rows.forEach((r, i) => (r.name ||= passName(source, recipe.title, rows.length > 1 ? i + 1 : undefined)));
      // sent from no draft (by the API, a batch): named after the label it was given, numbered on; a label that is only
      // the recipe's title says nothing, so the first words of its prompt are used then (as for a draft with no title)
      else {
        const names = await labelNames(db, row.label, rows.length, recipe, promptOf(input, prompts));
        names.forEach((name, i) => (rows[i]!.name ||= name));
      }
    }
    await writeRows(db, { id: generationId, recipe, input, resolved, genMs: Date.now() - resume.startedAt, at }, row, sourcesOf(recipe, input, resume), rows);
    // the rows are there: the measure goes on from here, and lets the background measure go once it is done
    if (measure) measuring = measureLater(core, generationId, measure.asset, measure.work, faceFigures(resume, outputs), filed);
  } catch (err) {
    for (const key of written) await storage.delete(key).catch(() => {});
    throw err;
  } finally {
    if (!measuring) filed?.();
  }
  return { id: generationId, measuring };
}

/** The measures still being made, by the asset they are of: a job that joins onto that asset waits for its own (measuredFirst). */
const pending = new Map<string, Promise<void>>();

/**
 * Measure a filed video off its stored file, in the server's ffmpeg pool, and patch the figures into its generation (its own
 * column for the timelines, and `resolved`, which the asset API hands out whole). A failure only leaves the take without
 * figures, as a video ffmpeg could not read always did. Resolves with how long it took.
 */
function measureLater(
  { db, storage }: QueueCore, generationId: string, asset: string, work: () => Promise<Measure | null>,
  faces: { face: number; low: number | null } | null, done: (() => void) | undefined,
): Promise<number> {
  const t0 = performance.now();
  // the file is not taken away while ffmpeg reads it (a take thrown away at once)
  const release = storage.hold?.();
  const measured: Promise<void> = ffmpegPool(work)
    .then(async (measure) => {
      if (!measure) return;
      // a clip's face along it goes with its look: the timeline compares it as it does the brightness
      const full = faces ? { ...measure, face: faces.face, ...(faces.low !== null ? { faceLow: faces.low } : {}) } : measure;
      const g = await db.selectFrom("generations").select("resolved").where("id", "=", generationId).executeTakeFirst();
      if (!g) return;
      const resolved = { ...readJson<Record<string, unknown>>(g.resolved, {}), measure: full };
      await db.updateTable("generations").set({ measure: JSON.stringify(full), resolved: JSON.stringify(resolved) }).where("id", "=", generationId).execute();
    })
    .catch((err: Error) => console.warn(`[queue] a take was not measured: ${err.message}`))
    .finally(() => {
      if (pending.get(asset) === measured) pending.delete(asset);
      done?.();
      void release?.();
    });
  pending.set(asset, measured);
  return measured.then(() => performance.now() - t0);
}

/**
 * Wait until what is measured of these assets is done, at most `capMs`: a continuation sends its prompt once the take it
 * joins onto has its figures, so that the two land in order, while its own files go up meanwhile. Nothing to wait for
 * with any other asset.
 */
export async function measuredFirst(assets: Iterable<string>, capMs = 60_000): Promise<void> {
  const waits = [...new Set(assets)].flatMap((a) => (pending.has(a) ? [pending.get(a)!] : []));
  if (!waits.length) return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([Promise.all(waits), new Promise((go) => (timer = setTimeout(go, capMs)))]);
  clearTimeout(timer);
}

/** The measures under way (the queue's idle waits for them: tests, shutdown). */
export const measuresUnderWay = (): Promise<void>[] => [...pending.values()];

/**
 * The Face Match node's figures: the median over the frames read (a picture: its one), and the lowest; Face At's also how many
 * copies of the person it found away from the place they were put (a picture with them pasted in beside the one kept).
 */
function faceFigures(resume: Resume, outputs: Outputs): { face: number; low: number | null; copies: number } | null {
  for (const out of resume.outputs) {
    if (out.role !== "score") continue;
    const said = (outputs[out.node] as { afflatus_face?: Array<{ face?: number | null; low?: number | null; copies?: number }> } | undefined)?.afflatus_face?.[0];
    if (typeof said?.face === "number" && Number.isFinite(said.face)) return { face: said.face, low: typeof said.low === "number" ? said.low : null, copies: typeof said.copies === "number" ? said.copies : 0 };
  }
  return null;
}

/** The files the result nodes handed back, each with the kind the recipe asked of it. */
function collectOutputs(resume: Resume, outputs: Outputs): Array<{ file: OutputFile; kind: "image" | "video" | "audio" }> {
  const files: Array<{ file: OutputFile; kind: "image" | "video" | "audio" }> = [];
  for (const out of resume.outputs) {
    if (out.role !== "result") continue;
    const o = outputs[out.node];
    const returned = [...(o?.images ?? []), ...(o?.gifs ?? []), ...(o?.audio ?? [])];
    // a node can hand back more than its result (a video and a picture of its last frame): what is of the
    // kind that was asked for is the result. When nothing is (an animated picture standing for a video),
    // everything it returned is taken as that kind.
    const ofKind = returned.filter((file) => mimeOfFile(file.filename).startsWith(`${out.kind}/`));
    for (const file of ofKind.length ? ofKind : returned) files.push({ file, kind: out.kind });
  }
  return files;
}

/**
 * What is saved beside a video result, for the first video only: the model's own frames (before its frames were changed),
 * its latent (MiniMax H3 with the Afflatus node pack), and a latent re-sample's own result (a finish), for the finish of the clip after.
 */
interface Sides {
  raw: OutputFile | null;
  latent: OutputFile | null;
  fine: OutputFile | null;
}
function sideFiles(resume: Resume, outputs: Outputs): Sides {
  const sides: Sides = { raw: null, latent: null, fine: null };
  for (const out of resume.outputs) {
    const o = outputs[out.node] as { gifs?: OutputFile[]; images?: OutputFile[]; latents?: OutputFile[] } | undefined;
    if (out.role === "raw") sides.raw = [...(o?.gifs ?? []), ...(o?.images ?? [])].find((f) => mimeOfFile(f.filename).startsWith("video/")) ?? null;
    if (out.role === "latent") sides.latent = o?.latents?.[0] ?? null;
    if (out.role === "fine") sides.fine = o?.latents?.[0] ?? null;
  }
  return sides;
}

/** One result into storage, with its thumbnail and its side files; `written` gathers every key put. What is measured of a video is handed back to run later. */
async function fileOne(
  { db, storage }: QueueCore, comfy: Comfy, recipe: Recipe<any>, input: Record<string, unknown>, resume: Resume,
  { file, kind }: { file: OutputFile; kind: "image" | "video" | "audio" }, sides: Sides, written: string[],
): Promise<{ row: Omit<Parameters<typeof newAssetRow>[0], "folder_id" | "generation_id" | "created_at">; measure: (() => Promise<Measure | null>) | null }> {
  const put = async (key: string, bytes: Uint8Array) => {
    written.push(key);
    await storage.put(key, bytes);
  };
  // what is saved beside a video result goes with the first video only
  const side = kind === "video" ? { ...sides } : { raw: null, latent: null, fine: null };
  if (kind === "video") Object.assign(sides, { raw: null, latent: null, fine: null });
  // the result and what is saved beside it come down at once: one after the other, a pod's GPU waited for each
  const [main, rawBytes, latentBytes, fineBytes] = await Promise.all([
    comfy.client.view(file),
    side.raw ? comfy.client.view(side.raw) : null,
    side.latent ? comfy.client.view(side.latent) : null,
    side.fine ? comfy.client.view(side.fine) : null,
  ]);
  let bytes = main;
  const mime = mimeOfFile(file.filename);
  const ext = extOf(mime);
  const headMs = resume.overlap?.headMs ?? 0;
  // a clip continued in the latent: the sound's hole at the hand-over is closed (see repairJoinAudio)
  if (kind === "video" && resume.overlap?.latent && headMs > 0) {
    bytes = await repairJoinAudio(bytes, ext, headMs).catch((err: Error) => {
      console.warn(`[queue] the join's sound was not repaired: ${err.message}`);
      return bytes;
    });
  }
  const id = newId();
  const key = `assets/${id.slice(0, 2)}/${id}.${ext}`;
  const rawKey = rawBytes && side.raw ? `assets/${id.slice(0, 2)}/${id}.raw.${extOf(mimeOfFile(side.raw.filename))}` : null;
  const latentFrames = latentBytes ? latentFramesOf(latentBytes) : null;
  const latentKey = latentBytes && latentFrames ? `assets/${id.slice(0, 2)}/${id}.latent.safetensors` : null;
  const fineKey = fineBytes ? `assets/${id.slice(0, 2)}/${id}.fine.safetensors` : null;
  await Promise.all([
    put(key, bytes),
    rawKey ? put(rawKey, rawBytes!) : null,
    latentKey ? put(latentKey, latentBytes!) : null,
    fineKey ? put(fineKey, fineBytes!) : null,
  ]);
  // a video is read for its size, its length and a frame to show (when ffmpeg is installed), from where it is stored;
  // a clip that opens on the end of another one is shown by its own first frame, not by the other's
  const video = kind === "video" ? await readStored(storage, key, bytes, ext, headMs) : null;
  const size = kind === "image" ? pngSize(bytes) : video?.facts ?? null;
  // a small version for the library grid; without one the grid falls back to the picture itself
  const thumb = kind === "image" ? await makeThumb(bytes) : video?.frame ? await makeThumb(video.frame) : null;
  if (thumb) await put(thumbKey(id), thumb);
  return {
    measure: video?.facts ? () => measureStored({ db, storage }, recipe, input, resume, { id, key, ext, latentKey, latentFrames, facts: video.facts! }) : null,
    row: {
      id, kind, origin: "generated", name: "", file_key: key, thumb_key: thumb ? thumbKey(id) : null, mime, bytes: bytes.length, raw_key: rawKey, latent_key: latentKey, latent_frames: latentFrames, fine_latent_key: fineKey,
      width: size?.width ?? null, height: size?.height ?? null,
      duration_ms: video?.facts?.durationMs ?? null, fps: video?.facts?.fps ?? null, has_sound: video?.facts?.hasSound ? 1 : 0,
      source_id: null, source_range: null, linked_path: null, kept_at: null, countdown_from: null,
    },
  };
}

/**
 * A stored video's facts and the frame it is shown by (at `atMs`), read where it is on the disk: no copy of it is written for
 * ffprobe and ffmpeg, and the two run at once. A storage with no disk here (a bucket) has it read from its bytes, as before.
 */
async function readStored(storage: Storage, key: string, bytes: Uint8Array, ext: string, atMs: number): Promise<{ facts: VideoFacts | null; frame: Uint8Array | null }> {
  const path = storage.localPath?.(key);
  if (!path) {
    const read = await readVideo(bytes, ext);
    return { facts: read.facts, frame: atMs > 0 && read.frame ? await frameAt(bytes, ext, atMs).catch(() => read.frame) : read.frame };
  }
  const [facts, frame] = await Promise.all([videoFacts(path), frameAt(path, ext, atMs).catch(() => null)]);
  // the moment could not be read (a clip shorter than its run-up): its very first frame, as a video is shown otherwise
  return { facts, frame: frame ?? (atMs > 0 ? await frameAt(path, ext, 0).catch(() => null) : null) };
}

/**
 * What is read off a filed video, from its stored file: how the clip's own part looks (mean luma, sharpness), kept with the
 * render, so that a run of clips that flow on can be checked for sliding darker or softer clip after clip (see lookOf); for a
 * continuation, the step where its run-up ends; for a join made in the latent, how far its run-up drifted. Null when it could not be read.
 */
async function measureStored(
  { db, storage }: Pick<QueueCore, "db" | "storage">, recipe: Recipe<any>, input: Record<string, unknown>, resume: Resume,
  stored: { id: string; key: string; ext: string; latentKey: string | null; latentFrames: number | null; facts: VideoFacts },
): Promise<Measure | null> {
  const source = await sourceOf(storage, stored.key);
  const headMs = resume.overlap?.headMs ?? 0;
  // the look, and for a continuation where its run-up ends, from one decode of the stored file; its motion, strip and frame
  // means are kept from the same decode, for the timeline editor (measureLanded)
  const measure = await measureLanded((key, bytes) => storage.put(key, bytes), stored.id, source, stored.ext, stored.facts, headMs).catch(() => null);
  if (!measure) return null;
  // a join made in the latent: how wide its regenerated run-up came out against the tail it was guided by, read from the
  // two latents (the clip before's is the one its join took)
  const overlap = resume.overlap;
  const prevSpec = recipe.inputs.find((s) => s.type === "clip" && s.role === "previous") as (InputSpec & { fps?: number }) | undefined;
  const prevValue = prevSpec ? (input[prevSpec.id] as ClipValue | undefined) : undefined;
  if (overlap?.latent && overlap.headMs > 0 && stored.latentKey && stored.latentFrames && prevValue?.asset) {
    const shown = await db.selectFrom("assets").selectAll().where("id", "=", prevValue.asset).executeTakeFirst();
    const before = shown ? await renderedOf(db, shown) : null;
    const beforeBytes = before?.latent_key ? await storage.get(before.latent_key).catch(() => null) : null;
    const latentBytes = beforeBytes ? await storage.get(stored.latentKey).catch(() => null) : null;
    const drift = beforeBytes && latentBytes ? latentDriftOf(latentBytes, beforeBytes, Math.round((overlap.headMs / 1000) * (prevSpec?.fps ?? 24))) : null;
    if (drift) measure.drift = drift;
  }
  return measure;
}

/** What a render was made from: its pictures, the clips it joins onto, its references and sounds, and what a timeline handed it. */
function sourcesOf(recipe: Recipe<any>, input: Record<string, unknown>, resume: Resume): Array<{ asset: string; role: string }> {
  const sources = [...(resume.sources ?? [])];
  for (const spec of recipe.inputs) {
    const value = input[spec.id];
    if (spec.type === "image" && typeof value === "string") sources.push({ asset: value, role: spec.role });
    if (spec.type === "clip" && value) sources.push({ asset: (value as ClipValue).asset, role: spec.role });
    if (spec.type === "references" && Array.isArray(value)) for (const ref of value as ReferenceValue[]) sources.push({ asset: ref.asset, role: ref.role });
    if (spec.type === "audio" && typeof value === "string") sources.push({ asset: value, role: spec.role });
  }
  return sources;
}

/** The generation, its lineage and its assets, in one transaction; the job names its generation from then on. */
async function writeRows(
  db: Db, g: { id: string; recipe: Recipe<any>; input: Record<string, unknown>; resolved: Record<string, unknown>; genMs: number; at: string },
  row: Pick<JobRow, "id" | "draft_id" | "asked">, sources: Array<{ asset: string; role: string }>, rows: AssetRow[],
): Promise<void> {
  await db.transaction().execute(async (tx) => {
    await tx
      .insertInto("generations")
      .values({
        id: g.id, owner_id: OWNER, recipe_id: g.recipe.id, recipe_version: g.recipe.version, family: g.recipe.family,
        inputs: JSON.stringify(g.input), resolved: JSON.stringify(g.resolved), measure: g.resolved.measure ? JSON.stringify(g.resolved.measure) : null, gen_ms: g.genMs, draft_id: row.draft_id, asked: row.asked ?? null, created_at: g.at,
      })
      .execute();
    // the job names its generation from here on: found running again after a crash, it is not filed twice
    await tx.updateTable("jobs").set({ generation_id: g.id, updated_at: now() }).where("id", "=", row.id).execute();
    // a source erased while the render ran (a neighbour video or an opening frame chosen at submit) is left out of the
    // lineage: its row is gone, and naming it would fail the whole result on its foreign key, GPU time and files with it
    const ids = [...new Set(sources.map((s) => s.asset))];
    const there = ids.length ? new Set((await tx.selectFrom("assets").select("id").where("id", "in", ids).execute()).map((a) => a.id)) : new Set<string>();
    for (const s of sources.filter((x) => there.has(x.asset))) {
      await tx
        .insertInto("generation_inputs")
        .values({ generation_id: g.id, asset_id: s.asset, role: s.role })
        .onConflict((oc) => oc.columns(["generation_id", "asset_id", "role"]).doNothing())
        .execute();
    }
    for (const r of rows) await tx.insertInto("assets").values(r).execute();
  });
}
