import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { toEditor } from "@afflatus/workflows";
import { fromRender, markPng } from "./aiMark";
import { fromName, nameOf, shownNames, soundName } from "./autoName";
import { registerAssetSearch, withShownName } from "./assetSearch";
import { registerAssetsBin } from "./assetsBin";
import { registerAssetUpload } from "./assetUpload";
import { openInComfy } from "./comfyOpen";
import { loginKeyOf } from "./comfyLogins";
import { tagMatches } from "./compress";
import { markedVideoFile, silentOf, soundOf } from "./cut";
import { newId, now, type Tables } from "./db";
import { httpError, notFound } from "./errors";
import type { LibraryChange } from "./events";
import { isLinked } from "./linked";
import { assetView, extOf, newAssetRow } from "./media";
import { castOf, madeIn } from "./provenance";
import type { Services } from "./services";
import { makeThumb, mirrorPicture, readPicture, SMALL_EDGE, smallThumbKey, thumbKey } from "./thumbs";
import { sourceOf } from "./storage";
import { ffmpegPool } from "./pool";
import { firstFrame, inVideoFile, probeVideo, tools } from "./video";

/**
 * The library: its items listed and searched (assetSearch.ts), uploaded (assetUpload.ts), kept or binned
 * (assetsBin.ts); here each one with its file, its thumbnail and how it was made, renamed, and opened in ComfyUI.
 */

/** An item by its id (a 404 when there is none), and an item of Afflatus's own storage moved into the linked folder it sits in: for the library's route modules. */
function assetLookup(s: Services) {
  const asset = async (id: string) => {
    const a = await s.db.selectFrom("assets").selectAll().where("id", "=", id).executeTakeFirst();
    if (!a) throw notFound("this item");
    return a;
  };

  /**
   * An item made here from another one (a mirrored picture, a video's sound, the video without it): its file stored,
   * kept, in the same folder as its source, the source remembered, and the open pages told. What it is (kind, name,
   * size, length) is the caller's. Its file is its bytes, or a file on the disk here (`path`, what ffmpeg wrote), copied.
   */
  const addBeside = async (
    from: Pick<Tables["assets"], "id" | "folder_id">,
    file: ({ bytes: Uint8Array } | { path: string }) & { ext: string; thumb: Uint8Array | null },
    made: Pick<Parameters<typeof newAssetRow>[0], "kind" | "origin" | "name" | "mime" | "width" | "height" | "duration_ms" | "fps" | "has_sound">,
  ) => {
    const id = newId();
    const key = `assets/${id.slice(0, 2)}/${id}.${file.ext}`;
    if ("path" in file) await s.storage.putFile(key, file.path);
    else await s.storage.put(key, file.bytes);
    const bytes = "path" in file ? (await stat(file.path)).size : file.bytes.length;
    if (file.thumb) await s.storage.put(thumbKey(id), file.thumb);
    const at = now();
    await s.db
      .insertInto("assets")
      .values(newAssetRow({
        ...made, id, file_key: key, thumb_key: file.thumb ? thumbKey(id) : null, bytes,
        folder_id: from.folder_id, generation_id: null, source_id: from.id, kept_at: at, created_at: at,
      }))
      .execute();
    s.queue.events.emit("library", { change: "added", items: [id], folders: [from.folder_id] } satisfies LibraryChange);
    return assetView(await asset(id));
  };

  /** An item of Afflatus's own storage that sits in a linked folder becomes a file of that folder's directory. */
  const fileInLinked = async (id: string) => {
    const a = await asset(id);
    if (!a.folder_id || isLinked(a.file_key) || a.deleted_at) return;
    const folder = await s.db.selectFrom("folders").selectAll().where("id", "=", a.folder_id).executeTakeFirst();
    if (folder?.path) await s.linked.into(a, folder);
  };
  return { asset, fileInLinked, addBeside };
}
export type AssetLookup = ReturnType<typeof assetLookup>;

/** How long an item no thumbnail could be made of is not tried again, and how many such items are remembered. */
const UNMADE_MS = 10 * 60_000;
const UNMADE_KEPT = 1000;

/** How far back an edited copy's sources are followed for the render it comes from (a mirror of a frame of a cut of a render is four). */
const ANCESTRY = 5;

/** A generation as the detail of an item shows it. */
const generationView = (g: Tables["generations"]) =>
  ({ id: g.id, recipe: g.recipe_id, family: g.family, inputs: JSON.parse(g.inputs) as Record<string, unknown>, resolved: JSON.parse(g.resolved) as { seed?: number; loads?: string[]; overlap?: { headMs: number; tailMs: number } }, tookMs: g.gen_ms, ...(g.asked ? { asked: JSON.parse(g.asked) as Record<string, unknown> } : {}) });

/**
 * The render an item without one of its own was taken from: a mirrored copy, a frame or a cut is followed back through
 * its sources to the nearest item that was rendered. A pass on the copy (a face detailer, an upscale) carries that
 * render's model and prompt; without it the job would go out on whatever the server falls back to.
 */
async function ancestorRender(s: Services, a: Tables["assets"]): Promise<ReturnType<typeof generationView> | null> {
  if (a.generation_id) return null;
  const seen = new Set([a.id]);
  let id = a.source_id;
  for (let step = 0; id && !seen.has(id) && step < ANCESTRY; step++) {
    seen.add(id);
    const from = await s.db.selectFrom("assets").select(["generation_id", "source_id"]).where("id", "=", id).executeTakeFirst();
    if (!from) return null;
    if (from.generation_id) {
      const g = await s.db.selectFrom("generations").selectAll().where("id", "=", from.generation_id).executeTakeFirst();
      return g ? generationView(g) : null;
    }
    id = from.source_id;
  }
  return null;
}

/** One item as GET /api/assets/:id answers it: its view, with how it was made, what it was made from and what was made from it (the web's AssetDetail, held against it in test/apiTypes.test.ts). */
export async function assetDetail(s: Services, a: Tables["assets"]) {
  const g = a.generation_id ? await s.db.selectFrom("generations").selectAll().where("id", "=", a.generation_id).executeTakeFirst() : undefined;
  // what it was made from (the pictures given to the recipe), and what was made from it
  const sources = g
    ? await s.db.selectFrom("generation_inputs").innerJoin("assets", "assets.id", "generation_inputs.asset_id").selectAll("assets").select("generation_inputs.role").where("generation_inputs.generation_id", "=", g.id).execute()
    : [];
  const usedIn = await s.db
    .selectFrom("generation_inputs").innerJoin("assets", "assets.generation_id", "generation_inputs.generation_id").selectAll("assets")
    .where("generation_inputs.asset_id", "=", a.id).where("assets.deleted_at", "is", null)
    .orderBy("assets.created_at", "desc").limit(24).execute();
  // which timeline clip it, and what was made from it, is a take of: the viewer leads there
  const placed = await s.timelines.clipOf([a.id, ...usedIn.map((u) => u.id)]);
  // what came before and after it, by the names they go by when they were given none
  const shown = await shownNames(s.db, [...sources.map(({ role: _, ...row }) => row), ...usedIn], (id) => s.registry.recipe(id)?.title);
  const named = <T extends { id: string }>(v: T) => (shown.has(v.id) ? { ...v, shownName: shown.get(v.id) } : v);
  return {
    ...assetView(a),
    ...(await withShownName(s, a)),
    clipOf: placed.get(a.id) ?? null,
    // who was in it, as far back as it is known: what is made from it next can start with the same people
    look: castOf(await madeIn(s, a.id)),
    generation: g ? generationView(g) : null,
    ancestor: await ancestorRender(s, a),
    sources: sources.map(({ role, ...row }) => ({ role, asset: named(assetView(row)) })),
    usedIn: usedIn.map((u) => named({ ...assetView(u), clipOf: placed.get(u.id) ?? null })),
    // a frame or a cut: the video it was taken from, and the range when it is one
    source: await (async () => {
      if (!a.source_id) return null;
      const from = await s.db.selectFrom("assets").selectAll().where("id", "=", a.source_id).executeTakeFirst();
      if (!from) return null;
      // a part that is not there reads as NaN, which the check below turns away as it does a part that is not a number
      const [startMs = NaN, endMs = NaN] = (a.source_range ?? "").split("-").map(Number);
      return { asset: assetView(from), range: a.source_range && Number.isFinite(startMs) && Number.isFinite(endMs) ? { startMs, endMs } : null };
    })(),
  };
}

export function registerAssets(app: FastifyInstance, s: Services): void {
  const lookup = assetLookup(s);
  const { asset, addBeside } = lookup;
  registerAssetSearch(app, s);
  registerAssetUpload(app, s, lookup);
  registerAssetsBin(app, s, lookup);

  /** A new name for a picture, a video or a sound: what the library shows and searches by. The file on the disk keeps its own. */
  app.patch<{ Params: { id: string } }>("/api/assets/:id", async (req) => {
    const { name } = z.strictObject({ name: z.string().trim().max(200) }).parse(req.body ?? {});
    await asset(req.params.id);
    await s.db.updateTable("assets").set({ name }).where("id", "=", req.params.id).execute();
    s.queue.events.emit("library", { items: [req.params.id], change: "fields", name } satisfies LibraryChange);
    return assetView(await asset(req.params.id));
  });

  /**
   * A picture mirrored, left and right or top and bottom: a new picture beside it in the same folder, kept, its source
   * remembered. No GPU: done here with the image library. A keyframe that faces the wrong way for the clip before is
   * the usual reason (the rider travelling right to left when the shot before goes left to right).
   */
  app.post<{ Params: { id: string } }>("/api/assets/:id/mirror", async (req) => {
    const { axis } = z.strictObject({ axis: z.enum(["horizontal", "vertical"]) }).parse(req.body ?? {});
    const a = await asset(req.params.id);
    if (a.kind !== "image") throw httpError("only a picture can be mirrored");
    const bytes = await mirrorPicture(await s.storage.get(a.file_key), axis);
    if (!bytes) throw httpError("this picture could not be mirrored: it could not be read, or the image library did not load on this machine");
    // its size read from what was made: a picture taken sideways was turned upright first
    const size = await readPicture(bytes);
    const source = await nameOf(s.db, a);
    return addBeside(a, { bytes, ext: "png", thumb: await makeThumb(bytes) }, {
      kind: "image", origin: "edited", name: source ? fromName(source, ", mirrored") : "", mime: "image/png",
      width: size?.width ?? a.width, height: size?.height ?? a.height, duration_ms: null, fps: null, has_sound: 0,
    });
  });

  /**
   * Show how a result was made in ComfyUI's editor: its graph built again from its generation parameters
   * and its seed (nothing is uploaded: the images and sounds it used are named in the graph by their own
   * names, for the eye; ComfyUI will not have them), then written where ComfyUI opens it (comfyOpen.ts).
   */
  app.post<{ Params: { id: string } }>("/api/assets/:id/open", async (req) => {
    const a = await asset(req.params.id);
    const g = a.generation_id ? await s.db.selectFrom("generations").select(["recipe_id", "inputs", "resolved"]).where("id", "=", a.generation_id).executeTakeFirst() : undefined;
    if (!g) throw httpError("this file was not generated by afflatus: there is no graph to show");
    if (!s.registry.recipe(g.recipe_id)) throw httpError("the model this was generated with is no longer here");
    const used = await s.db.selectFrom("generation_inputs").innerJoin("assets", "assets.id", "generation_inputs.asset_id").select(["assets.id", "assets.name", "assets.mime"]).where("generation_inputs.generation_id", "=", a.generation_id!).execute();
    const names = Object.fromEntries(used.map((u) => [u.id, /\.[a-z0-9]+$/i.test(u.name) ? u.name : `${u.name}.${extOf(u.mime)}`]));
    const resolved = JSON.parse(g.resolved) as { seed?: number };
    const built = await s.queue.builtOf(g.recipe_id, JSON.parse(g.inputs), { seed: resolved.seed, names });
    if (!built) throw httpError("the graph of this result could not be built again");
    const file = toEditor(built.graph, await (await s.comfy()).catalog());
    return openInComfy(s, loginKeyOf(req.access), `render-${a.id.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 24)}`, `Render ${a.name.trim() || a.id.slice(0, 8)}`, file);
  });

  /** One item, with how it was made. */
  app.get<{ Params: { id: string } }>("/api/assets/:id", async (req) => assetDetail(s, await asset(req.params.id)));

  /**
   * How a file may be kept by the browser. Afflatus's own files never change under their id: kept for good. A file of a
   * linked folder can be changed on the disk (retouched in another program) and keep its id: asked again each time, with
   * a tag of its version, which answers 304 with nothing when it is the same. True: the browser has it already.
   */
  const cachedAs = (reply: FastifyReply, ifNoneMatch: string | undefined, version: string | null): boolean => {
    if (!version) {
      reply.header("Cache-Control", "private, max-age=31536000, immutable");
      return false;
    }
    const tag = `"${version}"`;
    reply.header("Cache-Control", "private, no-cache").header("ETag", tag);
    return tagMatches(ifNoneMatch, tag);
  };

  app.get<{ Params: { id: string }; Querystring: { download?: string } }>("/api/assets/:id/file", async (req, reply) => {
    const a = await asset(req.params.id);
    // saved to the user's disk (not played here): a render goes out marked as made by a model (aiMark.ts), whole
    if (req.query.download === "1" && (a.mime === "image/png" || a.kind === "video") && (await fromRender(s.db, a))) {
      reply.header("Content-Type", a.mime).header("Cache-Control", "no-store");
      if (a.kind === "video") {
        // streamed from the marked copy on the disk, removed once sent (or the download stopped): never whole in memory
        const marked = await markedVideoFile(await sourceOf(s.storage, a.file_key), extOf(a.mime));
        const stream = createReadStream(marked.file);
        stream.on("close", () => void marked.done());
        return reply.header("Content-Length", marked.size).send(stream);
      }
      const marked = markPng(await s.storage.get(a.file_key));
      return reply.header("Content-Length", marked.length).send(Buffer.from(marked.buffer, marked.byteOffset, marked.byteLength));
    }
    const size = await s.storage.size(a.file_key);
    reply.header("Content-Type", a.mime).header("Accept-Ranges", "bytes");
    if (cachedAs(reply, req.headers["if-none-match"], (await s.storage.version?.(a.file_key)) ?? null)) return reply.status(304).send();
    // videos are played with range requests
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    if (m && (m[1] || m[2])) {
      const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
      const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start > end || start >= size) return reply.status(416).header("Content-Range", `bytes */${size}`).send();
      const { stream } = await s.storage.open(a.file_key, { start, end });
      return reply.status(206).header("Content-Range", `bytes ${start}-${end}/${size}`).header("Content-Length", end - start + 1).send(stream);
    }
    return reply.header("Content-Length", size).send((await s.storage.open(a.file_key)).stream);
  });

  /**
   * A small version for grids. Made when the picture was stored; older pictures get theirs on first request. With `w` of
   * 256 or less (a tile that small on a screen of one pixel per point: the web's srcset), the 256 px one, made from the
   * 512 one on its first ask and kept beside it.
   */
  /** An item's thumbnail made, its key; null when none could be (a video ffmpeg cannot read, or ffmpeg not installed). */
  const makeThumbOf = async (a: Tables["assets"]): Promise<string | null> => {
    // a video is read where it lies on the disk when it does: never the whole of it into memory for its first frame
    const source = a.kind === "video" ? await sourceOf(s.storage, a.file_key) : await s.storage.get(a.file_key);
    // of a video: its first frame, among the other ffmpeg runs made for a request (ahead of them: a tile waits on it). A
    // video stored before Afflatus read videos, or a linked one, gets its size and length now too; the others are not probed
    const read = async (file: string) => ({ facts: a.duration_ms === null ? (await probeVideo(file)).facts : null, frame: await firstFrame(file) });
    const video = a.kind !== "video" ? null : await ffmpegPool(() => (typeof source === "string" ? read(source) : inVideoFile(source, extOf(a.mime), read)), { first: true });
    if (video?.facts) {
      const f = video.facts;
      await s.db.updateTable("assets").set({ width: f.width, height: f.height, duration_ms: f.durationMs, fps: f.fps, has_sound: f.hasSound ? 1 : 0 }).where("id", "=", a.id).execute();
      s.queue.events.emit("library", { items: [a.id], change: "fields" } satisfies LibraryChange);
    }
    const frame = video ? video.frame : typeof source === "string" ? null : source;
    const thumb = frame && (await makeThumb(frame));
    if (!thumb) return null;
    const key = thumbKey(a.id);
    await s.storage.put(key, thumb);
    await s.db.updateTable("assets").set({ thumb_key: key }).where("id", "=", a.id).execute();
    // made again because the file changed (a linked folder's, written again on the disk): the small one of the old picture goes
    await s.storage.delete(smallThumbKey(a.id)).catch(() => {});
    return key;
  };
  // the thumbnails being made, by item: the tiles that ask for one at once share its making. And the items of which none could
  // be made, by their version and the ffmpeg tried, with when: not tried again on every view of a grid, nor for good (ffmpeg
  // may be installed, or another chosen, as Get ffmpeg does)
  const making = new Map<string, Promise<string | null>>();
  const unmade = new Map<string, number>();
  const thumbOf = (a: Tables["assets"]): Promise<string | null> => {
    const version = `${a.id}:${a.bytes}:${a.created_at}:${tools.ffmpeg}:${tools.ffprobe}`;
    const failed = unmade.get(version);
    if (failed !== undefined && Date.now() - failed < UNMADE_MS) return Promise.resolve(null);
    const had = making.get(a.id);
    if (had) return had;
    const made = makeThumbOf(a)
      .then((key) => {
        if (key) unmade.delete(version);
        else {
          if (unmade.size >= UNMADE_KEPT) unmade.delete(unmade.keys().next().value!);
          unmade.set(version, Date.now());
        }
        return key;
      })
      .finally(() => making.delete(a.id));
    making.set(a.id, made);
    return made;
  };
  app.get<{ Params: { id: string }; Querystring: { w?: string } }>("/api/assets/:id/thumb", async (req, reply) => {
    const a = await asset(req.params.id);
    const small = Number(req.query.w) > 0 && Number(req.query.w) <= SMALL_EDGE;
    const key = a.thumb_key ?? (a.kind !== "audio" ? await thumbOf(a) : null);
    // no picture can stand for a sound, or for a video when ffmpeg is not installed
    if (!key && a.kind !== "image") throw notFound("a preview of this item");
    // of a linked file: the version its row last read off the disk, which a reading changes when the file changed (and drops
    // the thumbnail with it): the browser asks again rather than showing the old picture for a year
    if (cachedAs(reply, req.headers["if-none-match"], isLinked(a.file_key) ? `${a.bytes}-${a.created_at}` : null)) return reply.status(304).send();
    // no thumbnail could be made: the picture itself is still a correct answer
    if (!key) return reply.header("Content-Type", a.mime).send((await s.storage.open(a.file_key)).stream);
    if (small) {
      const kept = await s.storage.open(smallThumbKey(a.id)).catch(() => null);
      if (kept) return reply.header("Content-Type", "image/webp").send(kept.stream);
      const made = await makeThumb(await s.storage.get(key), SMALL_EDGE);
      if (made) {
        // two tiles asking at once both make it: the second write may meet the first being read (Windows), and it is the same picture
        await s.storage.put(smallThumbKey(a.id), made).catch(() => {});
        return reply.header("Content-Type", "image/webp").send(Buffer.from(made));
      }
    }
    return reply.header("Content-Type", "image/webp").send((await s.storage.open(key)).stream);
  });

  /** The sound of a video, as a sound of its own in the library (for a clip's sound, the music, a voice). */
  app.post<{ Params: { id: string } }>("/api/assets/:id/sound", async (req) => {
    const video = await asset(req.params.id);
    if (video.kind !== "video" || !video.has_sound) throw httpError("This video has no audio to extract.");
    // "Big Air · c2 · t5 · audio": after the name the video goes by (worked out from where it came from when it has none)
    const source = await nameOf(s.db, video);
    // read where it lies and stored from where ffmpeg wrote it: handed the whole video, a 2-minute 1080p one held 967 MB
    return soundOf(await sourceOf(s.storage, video.file_key), extOf(video.mime), video.duration_ms, (path) => addBeside(video, { path, ext: "m4a", thumb: null }, {
      kind: "audio", origin: "imported", name: source ? soundName(source) : "Audio extracted from a video", mime: "audio/mp4",
      width: null, height: null, duration_ms: video.duration_ms, fps: null, has_sound: 1,
    }));
  });

  /** A video without its sound: a new video beside it in the same folder, kept, its source untouched. */
  app.post<{ Params: { id: string } }>("/api/assets/:id/silent", async (req) => {
    const video = await asset(req.params.id);
    if (video.kind !== "video" || !video.has_sound) throw httpError("This video has no sound to remove.");
    const ext = extOf(video.mime);
    // the same frames: the source's thumbnail serves the copy too
    const thumb = video.thumb_key ? await s.storage.get(video.thumb_key).catch(() => null) : null;
    const source = await nameOf(s.db, video);
    // as the sound: read where it lies, stored from where ffmpeg wrote it
    return silentOf(await sourceOf(s.storage, video.file_key), ext, video.duration_ms, (path) => addBeside(video, { path, ext, thumb }, {
      kind: "video", origin: "edited", name: source ? fromName(source, ", no sound") : "Video without its sound", mime: video.mime,
      width: video.width, height: video.height, duration_ms: video.duration_ms, fps: video.fps, has_sound: 0,
    }));
  });
}
