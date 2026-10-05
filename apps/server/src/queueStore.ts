import type { OutputFile, waitForOutputs } from "@afflatus/comfy";
import type { ClipValue, InputSpec, Recipe, ReferenceValue } from "@afflatus/core";
import type { Comfy } from "./comfy";
import { frameAt, lookOf, repairJoinAudio, type Measure } from "./cut";
import { newId, now, OWNER, type Db, type Tables } from "./db";
import { latentDriftOf } from "./latentStats";
import { extOf, mimeOfFile, newAssetRow, pngSize } from "./media";
import { makeThumb, thumbKey } from "./thumbs";
import { readVideo } from "./video";
import type { JobRow, QueueCore, Resume } from "./queueModel";

/** What a finished render leaves behind: its files in storage, its rows in the library, and the record of how it was made. */

/** The frame count written in the metadata of a latent saved by the Afflatus node pack (a safetensors file: 8 bytes of header length, then the header). */
export function latentFramesOf(bytes: Uint8Array): number {
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
 * The asset that was rendered, for one that is a finished (upscaled) version of it on a timeline: the
 * latent and the model's own frames belong to the render, and a join takes them from there. The asset
 * itself when it holds them, or was not finished from another.
 */
export async function renderedOf(db: Db, asset: Tables["assets"]): Promise<Tables["assets"]> {
  let current = asset;
  for (let i = 0; i < 4 && !current.latent_key && !current.raw_key; i++) {
    const take = await db.selectFrom("takes").select("finished_from").where("asset_id", "=", current.id).where("finished_from", "is not", null).executeTakeFirst();
    if (!take?.finished_from) break;
    const draft = await db.selectFrom("takes").innerJoin("assets", "assets.id", "takes.asset_id").selectAll("assets").where("takes.id", "=", take.finished_from).executeTakeFirst();
    if (!draft) break;
    current = draft as unknown as Tables["assets"];
  }
  return current;
}

/** Download the results, file them in the library, and record how they were made. */
export async function store(
  core: QueueCore, comfy: Comfy, recipe: Recipe<any>, input: Record<string, unknown>, resume: Resume,
  outputs: Awaited<ReturnType<typeof waitForOutputs>>,
  row: Pick<JobRow, "id" | "draft_id" | "folder_id" | "look">,
): Promise<string> {
  const { db, storage } = core;
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
  if (!files.length) throw new Error("ComfyUI finished but returned no output");
  // the model's own frames, saved beside a result whose frames were changed after it: for the clips that carry on
  let raw: OutputFile | null = null;
  // the clip's own latent (MiniMax H3 with the Afflatus node pack): for the clips that continue it
  let latent: OutputFile | null = null;
  for (const out of resume.outputs) {
    const o = outputs[out.node] as { gifs?: OutputFile[]; images?: OutputFile[]; latents?: OutputFile[] } | undefined;
    if (out.role === "raw") raw = [...(o?.gifs ?? []), ...(o?.images ?? [])].find((f) => mimeOfFile(f.filename).startsWith("video/")) ?? null;
    if (out.role === "latent") latent = o?.latents?.[0] ?? null;
  }

  const generationId = newId();
  const at = now();
  const genMs = Date.now() - resume.startedAt;
  // with the cast it was sent with: what is made from it later (a video of this picture) can take it over
  const resolved: Record<string, unknown> = { seed: resume.seed, loads: resume.loads, ...(resume.overlap ? { overlap: resume.overlap } : {}), ...(row.look ? { look: JSON.parse(row.look) } : {}) };
  // the folder that was open when it was sent, when it is still there. Being in a folder does not keep a result:
  // it still goes to the bin after a day unless it is kept
  const folder = row.folder_id ? (await db.selectFrom("folders").select("id").where("id", "=", row.folder_id).executeTakeFirst())?.id ?? null : null;
  // what it was made from: its pictures, the clips it joins onto, and what a timeline handed it
  const sources = [...(resume.sources ?? [])];
  for (const spec of recipe.inputs) {
    const value = input[spec.id];
    if (spec.type === "image" && typeof value === "string") sources.push({ asset: value, role: spec.role });
    if (spec.type === "clip" && value) sources.push({ asset: (value as ClipValue).asset, role: spec.role });
    if (spec.type === "references" && Array.isArray(value)) for (const ref of value as ReferenceValue[]) sources.push({ asset: ref.asset, role: ref.role });
    if (spec.type === "audio" && typeof value === "string") sources.push({ asset: value, role: spec.role });
  }
  // every file comes down from ComfyUI and goes into storage first, with what is read off it; the rows are
  // then written together, so that a failure halfway leaves no generation without its files or the other way round
  const rows: Array<ReturnType<typeof newAssetRow>> = [];
  for (const { file, kind } of files) {
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
    await storage.put(key, bytes);
    // a video is read for its size, its length and a frame to show (when ffmpeg is installed)
    const video = kind === "video" ? await readVideo(bytes, extOf(mime)) : null;
    const size = kind === "image" ? pngSize(bytes) : video?.facts ?? null;
    // how the clip's own part looks (mean luma, sharpness), kept with the render: a run of clips that flow on
    // can then be checked for sliding darker or softer clip after clip (see lookOf)
    let measure: Measure | null = null;
    if (video?.facts) measure = await lookOf(bytes, extOf(mime), resume.overlap?.headMs ?? 0).catch(() => null);
    // a clip that opens on the end of another one is shown by its own first frame, not by the other's
    const own = video?.frame && resume.overlap?.headMs ? await frameAt(bytes, extOf(mime), resume.overlap.headMs).catch(() => null) : null;
    // a small version for the library grid; without one the grid falls back to the picture itself
    const thumb = kind === "image" ? await makeThumb(bytes) : video?.frame ? await makeThumb(own ?? video.frame) : null;
    if (thumb) await storage.put(thumbKey(id), thumb);
    let rawKey: string | null = null;
    if (kind === "video" && raw) {
      rawKey = `assets/${id.slice(0, 2)}/${id}.raw.${extOf(mimeOfFile(raw.filename))}`;
      await storage.put(rawKey, await comfy.client.view(raw));
      raw = null;
    }
    let latentKey: string | null = null;
    let latentFrames: number | null = null;
    if (kind === "video" && latent) {
      const bytes = await comfy.client.view(latent);
      latentFrames = latentFramesOf(bytes);
      if (latentFrames) {
        latentKey = `assets/${id.slice(0, 2)}/${id}.latent.safetensors`;
        await storage.put(latentKey, bytes);
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
        const drift = beforeBytes ? latentDriftOf(bytes, beforeBytes, Math.round((overlap.headMs / 1000) * (prevSpec?.fps ?? 24))) : null;
        if (drift) measure.drift = drift;
      }
      latent = null;
    }
    if (measure) resolved.measure = measure;
    rows.push(newAssetRow({
      id, kind, origin: "generated", name: "", file_key: key, thumb_key: thumb ? thumbKey(id) : null, mime, bytes: bytes.length, raw_key: rawKey, latent_key: latentKey, latent_frames: latentFrames,
      width: size?.width ?? null, height: size?.height ?? null,
      duration_ms: video?.facts?.durationMs ?? null, fps: video?.facts?.fps ?? null, has_sound: video?.facts?.hasSound ? 1 : 0,
      folder_id: folder, generation_id: generationId, source_id: null, source_range: null, linked_path: null, kept_at: null, countdown_from: null, created_at: at,
    }));
  }
  await db.transaction().execute(async (tx) => {
    await tx
      .insertInto("generations")
      .values({
        id: generationId, owner_id: OWNER, recipe_id: recipe.id, recipe_version: recipe.version, family: recipe.family,
        inputs: JSON.stringify(input), resolved: JSON.stringify(resolved), gen_ms: genMs, draft_id: row.draft_id, created_at: at,
      })
      .execute();
    // the job names its generation from here on: found running again after a crash, it is not filed twice
    await tx.updateTable("jobs").set({ generation_id: generationId, updated_at: now() }).where("id", "=", row.id).execute();
    for (const s of sources) {
      await tx
        .insertInto("generation_inputs")
        .values({ generation_id: generationId, asset_id: s.asset, role: s.role })
        .onConflict((oc) => oc.columns(["generation_id", "asset_id", "role"]).doNothing())
        .execute();
    }
    for (const r of rows) await tx.insertInto("assets").values(r).execute();
  });
  return generationId;
}
