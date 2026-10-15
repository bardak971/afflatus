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
import { readVideo } from "./video";
import type { JobRow, QueueCore, Resume } from "./queueModel";
import { addPart } from "./serverMetrics";

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

/** Download the results, file them in the library, and record how they were made. */
export async function store(
  core: QueueCore, comfy: Comfy, recipe: Recipe<any>, input: Record<string, unknown>, resume: Resume,
  outputs: Outputs,
  row: Pick<JobRow, "id" | "draft_id" | "folder_id" | "look" | "asked"> & { clip_id?: string | null; label?: string | null },
): Promise<string> {
  const { db, storage } = core;
  const files = collectOutputs(resume, outputs);
  if (!files.length) throw new Error("ComfyUI finished but returned no output");
  const sides = sideFiles(resume, outputs);
  const face = faceOf(resume, outputs);
  const generationId = newId();
  const at = now();
  // with the cast it was sent with: what is made from it later (a video of this picture) can take it over
  const resolved: Record<string, unknown> = { seed: resume.seed, loads: resume.loads, ...(resume.overlap ? { overlap: resume.overlap } : {}), ...(resume.mirror?.length ? { mirror: resume.mirror } : {}), ...(row.look ? { look: JSON.parse(row.look) } : {}), ...(face !== null ? { face } : {}) };
  // the folder that was open when it was sent, when it is still there. Being in a folder does not keep a result:
  // it still goes to the bin after a day unless it is kept
  const folder = row.folder_id ? (await db.selectFrom("folders").select("id").where("id", "=", row.folder_id).executeTakeFirst())?.id ?? null : null;
  // every file comes down from ComfyUI and goes into storage first, with what is read off it; the rows are
  // then written together, so that a failure halfway leaves no generation without its files or the other way round.
  // What was put in storage before a failure is taken out again: no file is left that no row names
  const written: string[] = [];
  // the background measure waits while the result comes down and is filed: the GPU's work is never held up by it
  const filed = precomputeOf(db)?.hold();
  try {
    const rows: AssetRow[] = [];
    for (const { file, kind } of files) {
      const filed = await fileOne(core, comfy, recipe, input, resume, { file, kind }, sides, written);
      // in its own column for the timelines, and in resolved as before (the asset API hands resolved out whole)
      // a clip's face along it goes with its look: the timeline compares it as it does the brightness
      const faces = faceFigures(resume, outputs);
      if (filed.measure) resolved.measure = faces ? { ...filed.measure, face: faces.face, ...(faces.low !== null ? { faceLow: faces.low } : {}) } : filed.measure;
      rows.push(newAssetRow({ ...filed.row, folder_id: folder, generation_id: generationId, created_at: at }));
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
  } catch (err) {
    for (const key of written) await storage.delete(key).catch(() => {});
    throw err;
  } finally {
    filed?.();
  }
  return generationId;
}

/** How much the face in the result is the person of the photos it was made with (a Face Match node's figure), or null. */
function faceOf(resume: Resume, outputs: Outputs): number | null {
  return faceFigures(resume, outputs)?.face ?? null;
}
/** The Face Match node's figures: the median over the frames read (a picture: its one), and the lowest. */
function faceFigures(resume: Resume, outputs: Outputs): { face: number; low: number | null } | null {
  for (const out of resume.outputs) {
    if (out.role !== "score") continue;
    const said = (outputs[out.node] as { afflatus_face?: Array<{ face?: number | null; low?: number | null }> } | undefined)?.afflatus_face?.[0];
    if (typeof said?.face === "number" && Number.isFinite(said.face)) return { face: said.face, low: typeof said.low === "number" ? said.low : null };
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

/** One result into storage, with its thumbnail, its side files and what is read off it; `written` gathers every key put. */
async function fileOne(
  { db, storage }: QueueCore, comfy: Comfy, recipe: Recipe<any>, input: Record<string, unknown>, resume: Resume,
  { file, kind }: { file: OutputFile; kind: "image" | "video" | "audio" }, sides: Sides, written: string[],
): Promise<{ row: Omit<Parameters<typeof newAssetRow>[0], "folder_id" | "generation_id" | "created_at">; measure: Measure | null }> {
  const put = async (key: string, bytes: Uint8Array) => {
    written.push(key);
    await storage.put(key, bytes);
  };
  let bytes = await comfy.client.view(file);
  const mime = mimeOfFile(file.filename);
  // a clip continued in the latent: the sound's hole at the hand-over is closed (see repairJoinAudio)
  if (kind === "video" && resume.overlap?.latent && resume.overlap.headMs > 0) {
    bytes = await repairJoinAudio(bytes, extOf(mime), resume.overlap.headMs).catch((err: Error) => {
      console.warn(`[queue] the join's sound was not repaired: ${err.message}`);
      return bytes;
    });
  }
  const id = newId();
  const key = `assets/${id.slice(0, 2)}/${id}.${extOf(mime)}`;
  await put(key, bytes);
  // what reading and measuring the result costs while its machine waits: /metrics' "measuring"
  const measuring = performance.now();
  // a video is read for its size, its length and a frame to show (when ffmpeg is installed)
  const video = kind === "video" ? await readVideo(bytes, extOf(mime)) : null;
  const size = kind === "image" ? pngSize(bytes) : video?.facts ?? null;
  // how the clip's own part looks (mean luma, sharpness), kept with the render: a run of clips that flow on
  // can then be checked for sliding darker or softer clip after clip (see lookOf). Its motion, strip and frame
  // means are kept from the same decode, for the timeline editor (measureLanded)
  let measure: Measure | null = null;
  if (video?.facts) measure = await measureLanded(put, id, bytes, extOf(mime), video.facts, resume.overlap?.headMs ?? 0).catch(() => null);
  // a clip that opens on the end of another one is shown by its own first frame, not by the other's
  const own = video?.frame && resume.overlap?.headMs ? await frameAt(bytes, extOf(mime), resume.overlap.headMs).catch(() => null) : null;
  addPart("measuring", performance.now() - measuring);
  // a small version for the library grid; without one the grid falls back to the picture itself
  const thumb = kind === "image" ? await makeThumb(bytes) : video?.frame ? await makeThumb(own ?? video.frame) : null;
  if (thumb) await put(thumbKey(id), thumb);
  let rawKey: string | null = null;
  if (kind === "video" && sides.raw) {
    rawKey = `assets/${id.slice(0, 2)}/${id}.raw.${extOf(mimeOfFile(sides.raw.filename))}`;
    await put(rawKey, await comfy.client.view(sides.raw));
    sides.raw = null;
  }
  let latentKey: string | null = null;
  let latentFrames: number | null = null;
  if (kind === "video" && sides.latent) {
    const latentBytes = await comfy.client.view(sides.latent);
    latentFrames = latentFramesOf(latentBytes);
    if (latentFrames) {
      latentKey = `assets/${id.slice(0, 2)}/${id}.latent.safetensors`;
      await put(latentKey, latentBytes);
    }
    // a join made in the latent: how wide its regenerated run-up came out against the tail it was guided
    // by, read from the two latents (the clip before's is the one its join took)
    const overlap = resume.overlap;
    const prevSpec = recipe.inputs.find((s) => s.type === "clip" && s.role === "previous") as (InputSpec & { fps?: number }) | undefined;
    const prevValue = prevSpec ? (input[prevSpec.id] as ClipValue | undefined) : undefined;
    if (measure && overlap?.latent && overlap.headMs > 0 && latentFrames && prevValue?.asset) {
      const shown = await db.selectFrom("assets").selectAll().where("id", "=", prevValue.asset).executeTakeFirst();
      const before = shown ? await renderedOf(db, shown) : null;
      const beforeBytes = before?.latent_key ? await storage.get(before.latent_key).catch(() => null) : null;
      const drift = beforeBytes ? latentDriftOf(latentBytes, beforeBytes, Math.round((overlap.headMs / 1000) * (prevSpec?.fps ?? 24))) : null;
      if (drift) measure.drift = drift;
    }
    sides.latent = null;
  }
  let fineKey: string | null = null;
  if (kind === "video" && sides.fine) {
    fineKey = `assets/${id.slice(0, 2)}/${id}.fine.safetensors`;
    await put(fineKey, await comfy.client.view(sides.fine));
    sides.fine = null;
  }
  return {
    measure,
    row: {
      id, kind, origin: "generated", name: "", file_key: key, thumb_key: thumb ? thumbKey(id) : null, mime, bytes: bytes.length, raw_key: rawKey, latent_key: latentKey, latent_frames: latentFrames, fine_latent_key: fineKey,
      width: size?.width ?? null, height: size?.height ?? null,
      duration_ms: video?.facts?.durationMs ?? null, fps: video?.facts?.fps ?? null, has_sound: video?.facts?.hasSound ? 1 : 0,
      source_id: null, source_range: null, linked_path: null, kept_at: null, countdown_from: null,
    },
  };
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
