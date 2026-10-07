import type { FastifyInstance } from "fastify";
import { open as openFile, readFile } from "node:fs/promises";
import { z } from "zod";
import { describeRecipe, fuzzyFilter } from "@afflatus/core";
import { toEditor } from "@afflatus/workflows";
import { openInComfy } from "./comfyOpen";
import { probeMediaFile, soundOf } from "./cut";
import { newId, now } from "./db";
import type { Tables } from "./db";
import { httpError, notFound } from "./errors";
import { isLinked } from "./linked";
import { assetView, extOf, looksLikePicture, newAssetRow, resetCountdown } from "./media";
import { folderIdsOf, rootFolderOf } from "./projects";
import { castOf, madeIn } from "./provenance";
import type { Services } from "./services";
import { makeThumb, readPicture, thumbKey } from "./thumbs";
import { isUpload } from "./uploadBody";
import { firstFrame, readVideo } from "./video";

/** The library: its items listed and searched, each one with its file and its thumbnail, kept or binned, uploaded, and opened in ComfyUI. */

const listQuery = z.object({
  kind: z.enum(["image", "video", "audio"]).optional(),
  bin: z.string().optional(),
  /** A folder id, or "none" for what is in no folder. */
  folder: z.string().optional(),
  /** A project id: what is in its folders; "none": the Inbox (in no folder, or in a folder of no project). */
  project: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(60),
  /** The `next` value of the previous page. */
  after: z.string().optional(),
  /** Words to find, in the name or in what was written to make it. Forgiving: typos and letters left out. */
  q: z.string().max(200).optional(),
  /** Only what was made with this model family. */
  family: z.string().optional(),
  /** Only what was kept. */
  kept: z.string().optional(),
  /** Only what was made with this model file (a checkpoint, a diffusion model), or with this LoRA. */
  model: z.string().max(500).optional(),
  lora: z.string().max(500).optional(),
  /** Only what this draft made. */
  draft: z.string().max(64).optional(),
  /** Only what was made since this moment (ISO). */
  since: z.string().max(40).optional(),
});

/** How many items a search looks through at most: the most recent ones. */
const SEARCHED = 4000;

/** What is kept but not shown in the library: a painted mask, a picture uploaded for the Prompt kit. */
const NOT_IN_LIBRARY = ["mask", "kit"] as const;

export function registerAssets(app: FastifyInstance, s: Services): void {
  /** The model files and the LoRAs a generation was made with. A generation never changes, so the answer is kept, for the most recent ones. */
  const MADE_WITH_KEPT = 20_000;
  const madeWithKept = new Map<string, { models: string[]; loras: string[] }>();
  const madeWith = (g: { id: string; recipe_id: string; inputs: string; resolved: string }) => {
    const kept = madeWithKept.get(g.id);
    if (kept) return kept;
    const w = madeWithOf(g);
    if (madeWithKept.size >= MADE_WITH_KEPT) madeWithKept.delete(madeWithKept.keys().next().value!);
    madeWithKept.set(g.id, w);
    return w;
  };
  const madeWithOf = (g: { recipe_id: string; inputs: string; resolved: string }) => {
    const inputs = JSON.parse(g.inputs) as Record<string, unknown>;
    const loads = ((JSON.parse(g.resolved) as { loads?: string[] }).loads ?? []);
    const loras = Object.values(inputs)
      .filter((v): v is Array<{ file: string; weight: number }> => Array.isArray(v) && v.every((x) => x && typeof x === "object" && typeof (x as { file?: unknown }).file === "string" && typeof (x as { weight?: unknown }).weight === "number"))
      .flat().filter((l) => l.weight !== 0).map((l) => l.file);
    const recipe = s.registry.recipe(g.recipe_id);
    const models = new Set(loads.filter((f) => /^(checkpoints|diffusion_models)\//.test(f)).map((f) => f.replace(/^[^/]+\//, "")));
    for (const spec of recipe?.inputs ?? []) if (spec.type === "model" && typeof inputs[spec.id] === "string") models.add(inputs[spec.id] as string);
    // an imported workflow names its model itself
    if (!models.size && recipe) for (const f of describeRecipe(recipe).models) models.add(f);
    return { models: [...models], loras: [...new Set(loras)] };
  };

  app.get("/api/assets", async (req) => {
    const q = listQuery.parse(req.query);
    let query = s.db.selectFrom("assets").selectAll().where("deleted_at", q.bin ? "is not" : "is", null).where("origin", "not in", NOT_IN_LIBRARY);
    if (q.kind) query = query.where("kind", "=", q.kind);
    if (q.folder === "none") query = query.where("folder_id", "is", null);
    else if (q.folder) query = query.where("folder_id", "=", q.folder);
    else if (q.project === "none") {
      const inbox = await folderIdsOf(s.db, "none");
      query = query.where((eb) => (inbox.length ? eb.or([eb("folder_id", "is", null), eb("folder_id", "in", inbox)]) : eb("folder_id", "is", null)));
    } else if (q.project) {
      const own = await folderIdsOf(s.db, q.project);
      query = own.length ? query.where("folder_id", "in", own) : query.where("folder_id", "=", "-");
    }
    if (q.kept) query = query.where("kept_at", "is not", null);
    if (q.since) query = query.where("created_at", ">=", q.since);
    if (q.family) query = query.where("generation_id", "in", s.db.selectFrom("generations").select("id").where("family", "=", q.family));
    if (q.draft) query = query.where("generation_id", "in", s.db.selectFrom("generations").select("id").where("draft_id", "=", q.draft));
    if (q.q?.trim() || q.model || q.lora) {
      // found by its name and by every text of the form it was made with; and by the files it was made with
      if (q.model || q.lora) query = query.where("generation_id", "is not", null);
      let rows = await query.orderBy("created_at", "desc").orderBy("id", "desc").limit(SEARCHED).execute();
      const made = rows.some((r) => r.generation_id)
        ? await s.db.selectFrom("generations").select(["id", "recipe_id", "inputs", "resolved"]).where("id", "in", [...new Set(rows.map((r) => r.generation_id).filter((x): x is string => Boolean(x)))]).execute()
        : [];
      if (q.model || q.lora) {
        const fits = new Set(made.filter((g) => {
          const w = madeWith(g);
          return (!q.model || w.models.includes(q.model)) && (!q.lora || w.loras.includes(q.lora));
        }).map((g) => g.id));
        rows = rows.filter((r) => r.generation_id && fits.has(r.generation_id));
      }
      const words = new Map(made.map((g) => [g.id, Object.values(JSON.parse(g.inputs) as Record<string, unknown>).filter((v): v is string => typeof v === "string").join(" ")]));
      const found = q.q?.trim() ? fuzzyFilter(rows, q.q, (a) => `${a.name} ${a.generation_id ? words.get(a.generation_id) ?? "" : ""}`) : rows;
      const from = Number(q.after) || 0;
      return { items: await placedViews(found.slice(from, from + q.limit)), next: from + q.limit < found.length ? String(from + q.limit) : null };
    }
    if (q.after) {
      const [at = "", id = ""] = q.after.split("|");
      query = query.where((eb) => eb.or([eb("created_at", "<", at), eb.and([eb("created_at", "=", at), eb("id", "<", id)])]));
    }
    const rows = await query.orderBy("created_at", "desc").orderBy("id", "desc").limit(q.limit + 1).execute();
    const page = rows.slice(0, q.limit);
    const tail = page.at(-1);
    return { items: await placedViews(page), next: rows.length > q.limit && tail ? `${tail.created_at}|${tail.id}` : null };
  });
  /** The listed items; a video that is a take of a timeline clip says which (`clipOf`). */
  async function placedViews(rows: Tables["assets"][]) {
    const videos = rows.filter((r) => r.kind === "video").map((r) => r.id);
    const placed = videos.length ? await s.timelines.clipOf(videos) : new Map();
    // what made it in Create: the draft of its generation, by name (for grouping the grid by draft)
    const gens = rows.map((r) => r.generation_id).filter((g): g is string => Boolean(g));
    const drafts = new Map<string, { id: string; name: string }>();
    if (gens.length) {
      const found = await s.db.selectFrom("generations").leftJoin("drafts", "drafts.id", "generations.draft_id")
        .select(["generations.id as gen", "generations.draft_id as draft", "drafts.name as name", "drafts.title as title"])
        .where("generations.id", "in", gens).where("generations.draft_id", "is not", null).execute();
      for (const g of found) if (g.draft) drafts.set(g.gen, { id: g.draft, name: g.name || g.title || "A draft" });
    }
    return rows.map((r) => ({ ...assetView(r), clipOf: placed.get(r.id) ?? null, draftOf: (r.generation_id && drafts.get(r.generation_id)) || null }));
  }

  /** The model families things in the library were made with, for the "Any model" filter. */
  app.get("/api/assets/families", async () => ({
    items: (
      await s.db.selectFrom("generations").innerJoin("assets", "assets.generation_id", "generations.id").select("generations.family").where("assets.deleted_at", "is", null).distinct().execute()
    ).map((r) => r.family),
  }));

  /**
   * The model files and the LoRAs things in the library were made with, the most used first, for the
   * filters. Worked out once and kept until the library changes: the filter opens often, the library less so.
   */
  const tallyModels = async () => {
    const rows = await s.db
      .selectFrom("generations").innerJoin("assets", "assets.generation_id", "generations.id")
      .select(["generations.id", "generations.recipe_id", "generations.inputs", "generations.resolved"])
      .where("assets.deleted_at", "is", null).where("assets.origin", "not in", NOT_IN_LIBRARY)
      .execute();
    const models = new Map<string, number>();
    const loras = new Map<string, number>();
    for (const g of rows) {
      // one generation can have made several things: each counts
      const w = madeWith(g);
      for (const f of w.models) models.set(f, (models.get(f) ?? 0) + 1);
      for (const f of w.loras) loras.set(f, (loras.get(f) ?? 0) + 1);
    }
    const sorted = (m: Map<string, number>) => [...m.entries()].map(([file, count]) => ({ file, count })).sort((a, b) => b.count - a.count || a.file.localeCompare(b.file));
    return { models: sorted(models), loras: sorted(loras) };
  };
  let modelTally: Promise<Awaited<ReturnType<typeof tallyModels>>> | null = null;
  s.queue.events.on("library", () => {
    modelTally = null;
  });
  app.get("/api/assets/models", async () => {
    if (!modelTally) {
      modelTally = tallyModels();
      modelTally.catch(() => {
        modelTally = null;
      });
    }
    return modelTally;
  });

  const asset = async (id: string) => {
    const a = await s.db.selectFrom("assets").selectAll().where("id", "=", id).executeTakeFirst();
    if (!a) throw notFound("this item");
    return a;
  };

  /** An item of Afflatus's own storage that sits in a linked folder becomes a file of that folder's directory. */
  const fileInLinked = async (id: string) => {
    const a = await asset(id);
    if (!a.folder_id || isLinked(a.file_key) || a.deleted_at) return;
    const folder = await s.db.selectFrom("folders").selectAll().where("id", "=", a.folder_id).executeTakeFirst();
    if (folder?.path) await s.linked.into(a, folder);
  };

  /**
   * A picture, a video or a sound from the user's computer, sent as the request body. It is theirs, so
   * it is kept from the start and never goes to the bin on its own.
   */
  app.post<{ Querystring: { name?: string; as?: string; folder?: string; project?: string } }>("/api/assets", async (req) => {
    const up = isUpload(req.body) ? req.body : null;
    const unreadable = () => httpError("This file is not an image, a video or an audio file Afflatus can read. Images: PNG, JPEG, WebP. Video and audio are read with ffmpeg, which has to be installed where Afflatus runs.");
    if (!up) throw unreadable();
    // what the file is comes from its bytes, not from what the browser says it is. A picture is read whole (its size and
    // its thumbnail come from its bytes); a video or a sound stays on the disk and is probed there, once
    const head = await openFile(up.path, "r").then(async (f) => {
      const b = new Uint8Array(12);
      const { bytesRead } = await f.read(b, 0, 12, 0).finally(() => f.close());
      return b.subarray(0, bytesRead);
    });
    const bytes = looksLikePicture(head) ? new Uint8Array(await readFile(up.path)) : null;
    const picture = bytes && (await readPicture(bytes));
    const media = picture ? null : await probeMediaFile(up.path);
    if (!picture && !media) throw unreadable();
    // the part of a picture painted over to redo it: kept, but it is not something to look at in the library. A picture
    // uploaded for a person or a place of the Prompt kit: kept with them, not in the library either
    const mask = req.query.as === "mask";
    const kit = req.query.as === "kit";
    if (kit && !picture) throw httpError("a picture of the Prompt kit has to be an image");
    if (mask && !picture) throw httpError("the mask has to be an image");
    const id = newId();
    const mime = picture?.mime ?? media!.mime;
    const key = `assets/${id.slice(0, 2)}/${id}.${extOf(mime)}`;
    if (picture && bytes) await s.storage.put(key, bytes);
    else await s.storage.putFile(key, up.path);
    const facts = media?.facts ?? null;
    const frame = media?.kind === "video" ? await firstFrame(up.path) : null;
    const thumb = picture && bytes ? await makeThumb(bytes) : frame ? await makeThumb(frame) : null;
    if (thumb) await s.storage.put(thumbKey(id), thumb);
    const at = now();
    // into the folder named (a whole folder brought in from the computer: the folder made for each file; a drop: the folder open), else the project's root
    const named = req.query.folder && !mask && !kit ? (await s.db.selectFrom("folders").select("id").where("id", "=", req.query.folder).executeTakeFirst())?.id ?? null : null;
    const into = named ?? (!mask && !kit && req.query.project ? await rootFolderOf(s.db, req.query.project) : null);
    await s.db
      .insertInto("assets")
      .values(newAssetRow({
        id, kind: picture ? "image" : media!.kind, origin: mask ? "mask" : kit ? "kit" : "uploaded", name: String(req.query.name ?? "").slice(0, 200), file_key: key,
        thumb_key: thumb ? thumbKey(id) : null, mime, bytes: up.bytes, width: picture?.width ?? facts?.width ?? null, height: picture?.height ?? facts?.height ?? null,
        duration_ms: media?.durationMs ?? null, fps: facts?.fps ?? null, has_sound: media?.kind === "audio" || facts?.hasSound ? 1 : 0,
        folder_id: into, generation_id: null, kept_at: at, linked_path: null, created_at: at,
      }))
      .execute();
    // into a linked folder: it is a file of that directory at once
    if (into) await fileInLinked(id);
    if (!mask && !kit) s.queue.events.emit("library");
    return assetView(await asset(id));
  });

  /** A new name for a picture, a video or a sound: what the library shows and searches by. The file on the disk keeps its own. */
  app.patch<{ Params: { id: string } }>("/api/assets/:id", async (req) => {
    const { name } = z.strictObject({ name: z.string().trim().max(200) }).parse(req.body ?? {});
    await asset(req.params.id);
    await s.db.updateTable("assets").set({ name }).where("id", "=", req.params.id).execute();
    s.queue.events.emit("library");
    return assetView(await asset(req.params.id));
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
    return openInComfy(s, `render-${a.id.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 24)}`, `Render ${a.name.trim() || a.id.slice(0, 8)}`, file);
  });

  /** One item, with how it was made. */
  app.get<{ Params: { id: string } }>("/api/assets/:id", async (req) => {
    const a = await asset(req.params.id);
    const g = a.generation_id ? await s.db.selectFrom("generations").selectAll().where("id", "=", a.generation_id).executeTakeFirst() : undefined;
    // what it was made from (the pictures given to the recipe), and what was made from it
    const sources = g
      ? await s.db.selectFrom("generation_inputs").innerJoin("assets", "assets.id", "generation_inputs.asset_id").selectAll("assets").select("generation_inputs.role").where("generation_inputs.generation_id", "=", g.id).execute()
      : [];
    const usedIn = await s.db
      .selectFrom("generation_inputs").innerJoin("assets", "assets.generation_id", "generation_inputs.generation_id").selectAll("assets")
      .where("generation_inputs.asset_id", "=", a.id).where("assets.deleted_at", "is", null)
      .orderBy("assets.created_at", "desc").limit(24).execute();
    return {
      ...assetView(a),
      // who was in it, as far back as it is known: what is made from it next can start with the same people
      look: castOf(await madeIn(s, a.id)),
      generation: g
        ? { id: g.id, recipe: g.recipe_id, family: g.family, inputs: JSON.parse(g.inputs), resolved: JSON.parse(g.resolved), tookMs: g.gen_ms }
        : null,
      sources: sources.map(({ role, ...row }) => ({ role, asset: assetView(row) })),
      usedIn: usedIn.map(assetView),
      // a frame or a cut: the video it was taken from, and the range when it is one
      source: await (async () => {
        if (!a.source_id) return null;
        const from = await s.db.selectFrom("assets").selectAll().where("id", "=", a.source_id).executeTakeFirst();
        if (!from) return null;
        const [startMs, endMs] = (a.source_range ?? "").split("-").map(Number);
        return { asset: assetView(from), range: a.source_range && Number.isFinite(startMs) && Number.isFinite(endMs) ? { startMs, endMs } : null };
      })(),
    };
  });

  app.get<{ Params: { id: string } }>("/api/assets/:id/file", async (req, reply) => {
    const a = await asset(req.params.id);
    const size = await s.storage.size(a.file_key);
    reply.header("Content-Type", a.mime).header("Accept-Ranges", "bytes").header("Cache-Control", "private, max-age=31536000, immutable");
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

  /** A small version for grids. Made when the picture was stored; older pictures get theirs on first request. */
  app.get<{ Params: { id: string } }>("/api/assets/:id/thumb", async (req, reply) => {
    const a = await asset(req.params.id);
    let key = a.thumb_key;
    if (!key && a.kind !== "audio") {
      const bytes = await s.storage.get(a.file_key);
      // of a video: its first frame. A video stored before Afflatus read videos gets its size and length now too.
      const video = a.kind === "video" ? await readVideo(bytes, extOf(a.mime)) : null;
      if (video?.facts && a.duration_ms === null) {
        const f = video.facts;
        await s.db.updateTable("assets").set({ width: f.width, height: f.height, duration_ms: f.durationMs, fps: f.fps, has_sound: f.hasSound ? 1 : 0 }).where("id", "=", a.id).execute();
        s.queue.events.emit("library");
      }
      const frame = video ? video.frame : bytes;
      const thumb = frame && (await makeThumb(frame));
      if (thumb) {
        key = thumbKey(a.id);
        await s.storage.put(key, thumb);
        await s.db.updateTable("assets").set({ thumb_key: key }).where("id", "=", a.id).execute();
      }
    }
    // no picture can stand for a sound, or for a video when ffmpeg is not installed
    if (!key && a.kind !== "image") throw notFound("a preview of this item");
    reply.header("Cache-Control", "private, max-age=31536000, immutable");
    // no thumbnail could be made: the picture itself is still a correct answer
    if (!key) return reply.header("Content-Type", a.mime).send((await s.storage.open(a.file_key)).stream);
    return reply.header("Content-Type", "image/webp").send((await s.storage.open(key)).stream);
  });

  /** The sound of a video, as a sound of its own in the library (for a clip's sound, the music, a voice). */
  app.post<{ Params: { id: string } }>("/api/assets/:id/sound", async (req) => {
    const video = await asset(req.params.id);
    if (video.kind !== "video" || !video.has_sound) throw httpError("This video has no audio to extract.");
    const bytes = await soundOf(await s.storage.get(video.file_key), extOf(video.mime));
    const id = newId();
    const key = `assets/${id.slice(0, 2)}/${id}.m4a`;
    await s.storage.put(key, bytes);
    const at = now();
    await s.db
      .insertInto("assets")
      .values(newAssetRow({
        id, kind: "audio", origin: "imported", name: video.name ? `${video.name}, audio` : "Audio extracted from a video", file_key: key, thumb_key: null,
        mime: "audio/mp4", bytes: bytes.length, width: null, height: null, duration_ms: video.duration_ms, fps: null, has_sound: 1,
        folder_id: video.folder_id, generation_id: null, source_id: video.id, kept_at: at, created_at: at,
      }))
      .execute();
    s.queue.events.emit("library");
    return assetView(await asset(id));
  });

  app.post<{ Params: { id: string } }>("/api/assets/:id/keep", async (req) => {
    const { kept } = z.strictObject({ kept: z.boolean() }).parse(req.body);
    const a = await asset(req.params.id);
    // a file of a linked folder is the user's own file: it is kept, whatever is asked
    if (isLinked(a.file_key)) return assetView(a);
    await s.db.updateTable("assets").set({ kept_at: kept ? now() : null }).where("id", "=", req.params.id).execute();
    // kept while it sits in a linked folder: it is written there as a file
    if (kept) await fileInLinked(a.id);
    // unkept: its day starts now, not the day it was made
    else await resetCountdown(s.db, [a.id]);
    return assetView(await asset(req.params.id));
  });

  /** To the bin. Nothing is erased here: the bin is emptied later. */
  app.delete<{ Params: { id: string } }>("/api/assets/:id", async (req) => {
    const a = await asset(req.params.id);
    // a file of a linked folder leaves its directory, and waits in the bin like the rest
    if (isLinked(a.file_key)) await s.linked.toBin(a);
    else await s.db.updateTable("assets").set({ deleted_at: now() }).where("id", "=", req.params.id).execute();
    s.queue.events.emit("library");
    return { ok: true };
  });

  /** The same for several items at once: kept or not, to the bin, or back from it. */
  app.post("/api/assets/bulk", async (req) => {
    const b = z.strictObject({ ids: z.array(z.string().min(1)).min(1).max(500), action: z.enum(["keep", "unkeep", "bin", "restore"]) }).parse(req.body);
    // the files of linked folders among them: to the bin and back they move on the disk; they are never "not kept"
    const rows = await s.db.selectFrom("assets").selectAll().where("id", "in", b.ids).where("origin", "!=", "mask").execute();
    const onDisk = rows.filter((a) => isLinked(a.file_key));
    const back = rows.filter((a) => a.linked_path && a.deleted_at);
    let special = 0;
    if (b.action === "bin") for (const a of onDisk) { await s.linked.toBin(a); special++; }
    if (b.action === "restore") for (const a of back) { await s.linked.restore(a); special++; }
    const handled = new Set([...(b.action === "bin" || b.action === "unkeep" || b.action === "keep" ? onDisk : []), ...(b.action === "restore" ? back : [])].map((a) => a.id));
    b.ids = b.ids.filter((id) => !handled.has(id));
    if (!b.ids.length) {
      s.queue.events.emit("library");
      return { changed: special };
    }
    const set = b.action === "keep" ? { kept_at: now() } : b.action === "unkeep" ? { kept_at: null } : b.action === "bin" ? { deleted_at: now() } : { deleted_at: null };
    let query = s.db.updateTable("assets").set(set).where("id", "in", b.ids).where("origin", "!=", "mask");
    // what is kept already keeps the day it was kept
    if (b.action === "keep") query = query.where("kept_at", "is", null);
    const done = await query.executeTakeFirst();
    if (b.action === "keep") for (const id of b.ids) await fileInLinked(id);
    // unkept, or back from the bin: the day before the bin starts now
    if (b.action === "unkeep" || b.action === "restore") await resetCountdown(s.db, b.ids);
    s.queue.events.emit("library");
    return { changed: Number(done.numUpdatedRows) + special };
  });

  app.post<{ Params: { id: string } }>("/api/assets/:id/restore", async (req) => {
    const a = await asset(req.params.id);
    // a file that was taken out of a linked folder goes back into its directory
    if (a.linked_path) await s.linked.restore(a);
    else await s.db.updateTable("assets").set({ deleted_at: null }).where("id", "=", req.params.id).execute();
    // back in the library unkept: its day starts now
    await resetCountdown(s.db, [a.id]);
    s.queue.events.emit("library");
    return assetView(await asset(req.params.id));
  });
}
