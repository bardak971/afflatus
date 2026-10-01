import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { z, ZodError } from "zod";
import { describeRecipe, fuzzyFilter, parseInput } from "@studai/core";
import { readEmbedded, stemOf } from "./embedded";
import { newId, now, OWNER } from "./db";
import { registerDesigner } from "./designer";
import { registerDrafts } from "./drafts";
import { compose, lookSchema, registerEntities } from "./entities";
import { registerFolders } from "./folders";
import { registerModelInfo } from "./modelInfo";
import { registerModelSettings } from "./modelSettings";
import type { Services } from "./services";
import { publicSettings, readSettings, writeSettings } from "./settings";
import { assetView, extOf } from "./media";
import { registerTimelines } from "./timelines-api";
import { makeThumb, readPicture, thumbKey } from "./thumbs";
import { probeMedia, soundOf } from "./cut";
import { rates } from "./estimates";
import { registerUsage } from "./usage";
import { readVideo } from "./video";
import { registerWorkflows } from "./workflows";

export const VERSION = "0.0.1";

const notFound = (what: string) => Object.assign(new Error(`${what} was not found`), { statusCode: 404 });

const jobBody = z.strictObject({
  recipe: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  label: z.string().max(200).optional(),
  /** "Make 4 pictures": the same job this many times. Each draws its own seed when the seed is random. */
  count: z.number().int().min(1).max(8).default(1),
  /** Who is in it and how it looks: worked into the form before it is queued. */
  look: lookSchema.optional(),
});

export function buildApp(s: Services, opts: { webDir?: string } = {}): FastifyInstance {
  // a workflow with many nodes is a large body
  const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 });
  /** Files from the computer are sent as the request body itself. */
  const UPLOAD_LIMIT = 512 * 1024 * 1024;
  app.addContentTypeParser(/^(image|video|audio)\/|^application\/octet-stream$/, { parseAs: "buffer", bodyLimit: UPLOAD_LIMIT }, (_req, body, done) => done(null, body));

  // the built web app, served by the same process: one thing to start, one port
  if (opts.webDir) {
    void app.register(fastifyStatic, { root: opts.webDir, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      // any other page address is the app's own routing: hand it the app
      if (req.method === "GET" && !req.url.startsWith("/api/")) return reply.sendFile("index.html");
      return reply.status(404).send({ error: "there is nothing at this address" });
    });
  }

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });
    }
    // an error raised with a status was written to be read; anything else is a bug, logged and not shown
    const status = (err as { statusCode?: number }).statusCode;
    if (!status) console.error(err);
    return reply.status(status ?? 500).send({ error: status ? (err as Error).message : "something went wrong on the server" });
  });

  app.get("/api/health", async () => ({ ok: true, version: VERSION, database: s.dbKind }));

  /** Everything the composer can make things with, and the form of each. */
  app.get("/api/recipes", async () => ({ families: s.registry.families(), recipes: s.registry.recipes().map(describeRecipe) }));

  app.get("/api/settings", async () => publicSettings(await readSettings(s.db)));
  app.put("/api/settings", async (req) => publicSettings(await writeSettings(s.db, req.body)));

  /** What ComfyUI can do: the setup page, and what the composer offers. Read-only on ComfyUI. */
  app.get<{ Querystring: { fresh?: string } }>("/api/setup", async (req) => (await s.comfy()).scan(Boolean(req.query.fresh)));

  /** The load of the machine ComfyUI runs on, for the monitor bar. */
  app.get("/api/system", async () => ({ load: await (await s.comfy()).load() }));

  registerDrafts(app, s);
  registerModelSettings(app, s);
  registerModelInfo(app, s);
  registerFolders(app, s);
  registerWorkflows(app, s);
  registerTimelines(app, s);
  registerUsage(app, s);
  registerEntities(app, s);
  registerDesigner(app, s);

  /** What is heavy for the card ComfyUI runs on, for one form: a word next to the choice that makes it so. */
  app.post("/api/advice", async (req) => {
    const b = z.strictObject({ recipe: z.string().min(1), input: z.record(z.string(), z.unknown()) }).parse(req.body);
    const recipe = s.registry.recipe(b.recipe);
    const scan = await (await s.comfy()).scan().catch(() => null);
    if (!recipe?.advice || !scan?.comfy.online || !scan.comfy.vramTotal) return { items: [] };
    try {
      // a form that is half filled in gets no advice rather than an error
      return { items: recipe.advice(parseInput(recipe, b.input), { vramGb: scan.comfy.vramTotal / 2 ** 30 }) };
    } catch {
      return { items: [] };
    }
  });

  /**
   * Where a missing model file can be had: asked of Civitai by the file's name. Only when the user
   * turned this on in Setup; the file name is all that is sent.
   */
  app.get<{ Querystring: { file?: string } }>("/api/civitai/find", async (req) => {
    const settings = await readSettings(s.db);
    if (!settings.civitaiLookups) throw Object.assign(new Error("Looking things up on Civitai is turned off. Turn it on in Setup."), { statusCode: 400 });
    const file = String(req.query.file ?? "").split(/[\\/]/).pop() ?? "";
    const stem = file.replace(/\.(safetensors|ckpt|pt|pth|bin|gguf|sft)$/i, "");
    if (!stem) throw Object.assign(new Error("which file?"), { statusCode: 400 });
    const base = (process.env.CIVITAI_URL ?? "https://civitai.com").replace(/\/+$/, "");
    let res: Response;
    try {
      res = await fetch(`${base}/api/v1/models?${new URLSearchParams({ query: stem.replace(/[_-]+/g, " "), limit: "6" })}`, {
        headers: settings.civitaiKey ? { Authorization: `Bearer ${settings.civitaiKey}` } : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw Object.assign(new Error(`Civitai did not answer: ${(err as Error).message}`), { statusCode: 502 });
    }
    if (!res.ok) throw Object.assign(new Error(`Civitai refused (${res.status}).`), { statusCode: 502 });
    const data = (await res.json().catch(() => ({}))) as { items?: Array<{ id: number; name: string; type?: string; modelVersions?: Array<{ id?: number; name?: string; baseModel?: string; trainedWords?: string[]; files?: Array<{ name?: string; sizeKB?: number }> }> }> };
    return {
      items: (data.items ?? []).map((m) => {
        const version = m.modelVersions?.find((v) => v.files?.some((f) => f.name?.toLowerCase() === file.toLowerCase())) ?? m.modelVersions?.[0];
        return {
          name: m.name, kind: m.type ?? "", url: `https://civitai.com/models/${m.id}`, version: version?.name ?? "", base: version?.baseModel ?? "",
          words: (version?.trainedWords ?? []).slice(0, 12),
          /** What a download of it would fetch: the version, and how large its file is. */
          versionId: version?.id ?? null,
          bytes: Math.round((((version?.files ?? []).find((f) => f.name?.toLowerCase() === file.toLowerCase()) ?? version?.files?.[0])?.sizeKB ?? 0) * 1024),
          /** One of its versions has a file of exactly this name. */
          exact: Boolean(m.modelVersions?.some((v) => v.files?.some((f) => f.name?.toLowerCase() === file.toLowerCase()))),
        };
      }).sort((a, b) => Number(b.exact) - Number(a.exact)),
    };
  });

  /**
   * What a file from the computer says about how it was made: settings worked into the SDXL form (the
   * model and the LoRAs looked up among this ComfyUI's files), and the workflow it carries when it has one.
   * The file is read and forgotten: nothing is stored.
   */
  app.post("/api/embedded", { bodyLimit: UPLOAD_LIMIT }, async (req) => {
    const bytes = Buffer.isBuffer(req.body) ? new Uint8Array(req.body) : null;
    if (!bytes) throw Object.assign(new Error("send the file itself"), { statusCode: 400 });
    const found = await readEmbedded(bytes);
    if (!found.settings) return { settings: null, workflow: found.workflow, why: found.why ?? null };
    const f = found.settings;
    const recipe = "sdxl.text-to-picture";
    const scan = await (await s.comfy()).scan().catch(() => null);
    const options = scan?.recipes.find((r) => r.id === recipe)?.options ?? {};
    const online = Boolean(scan?.comfy.online);
    /** The file of this ComfyUI that has that name, whatever folder it is in and however it is written. */
    const fileFor = (name: string | undefined, list: string[] | undefined) => {
      if (!name) return undefined;
      const want = stemOf(name).toLowerCase();
      return (list ?? []).find((o) => stemOf(o).toLowerCase() === want);
    };
    const notes = [...f.notes];
    const missing: Array<{ file: string; folder: string; civitai?: number }> = [];
    const clamp = (n: number | undefined, lo: number, hi: number) => (n === undefined ? undefined : Math.min(hi, Math.max(lo, n)));
    const checkpoint = fileFor(f.checkpoint, options.checkpoint);
    if (f.checkpoint && !checkpoint && online) missing.push({ file: `${f.checkpoint}.safetensors`, folder: "checkpoints", ...(f.checkpointCivitai ? { civitai: f.checkpointCivitai } : {}) });
    const loras = f.loras.map((l) => ({ ...l, file: fileFor(l.name, options.loras) }));
    for (const l of loras) if (!l.file && online) missing.push({ file: `${l.name}.safetensors`, folder: "loras", ...(l.civitai ? { civitai: l.civitai } : {}) });
    if (!online) notes.push("ComfyUI is not answering, so its model and LoRAs could not be looked up: the form keeps the ones it has.");
    const sampler = f.sampler && (!options.sampler?.length || options.sampler.includes(f.sampler)) ? f.sampler : undefined;
    const scheduler = f.scheduler && (!options.scheduler?.length || options.scheduler.includes(f.scheduler)) ? f.scheduler : undefined;
    if (f.sampler && !sampler) notes.push(`Its sampler (${f.sampler}) is not one ComfyUI has: the form keeps its own.`);
    const grid = (n: number | undefined) => (n ? Math.round(Math.min(2048, Math.max(256, n)) / 8) * 8 : undefined);
    const width = grid(f.width);
    const height = grid(f.height);
    const upscaler = f.hires ? fileFor(f.hires.upscaler, options.hiresUpscaler) ?? "latent" : undefined;
    const input: Record<string, unknown> = {
      prompt: f.prompt, negative: f.negative, quality: "",
      ...(checkpoint ? { checkpoint } : {}),
      loras: loras.filter((l) => l.file).slice(0, 8).map((l) => ({ file: l.file, weight: Math.min(4, Math.max(-4, l.weight)) })),
      ...(width && height ? { size: { width, height } } : {}),
      ...(f.steps ? { steps: clamp(Math.round(f.steps), 1, 100) } : {}),
      ...(f.cfg ? { cfg: clamp(f.cfg, 1, 20) } : {}),
      ...(sampler ? { sampler } : {}), ...(scheduler ? { scheduler } : {}),
      ...(f.clipSkip ? { clipSkip: clamp(f.clipSkip, 1, 4) } : {}),
      ...(f.seed !== undefined && f.seed >= 0 && f.seed < 2 ** 32 ? { seed: Math.floor(f.seed) } : {}),
      hires: Boolean(f.hires),
      ...(f.hires ? {
        hiresUpscaler: upscaler,
        ...(f.hires.scale ? { hiresScale: clamp(f.hires.scale, 1.1, 2) } : {}),
        ...(f.hires.denoise ? { hiresDenoise: clamp(f.hires.denoise, 0.05, 0.9) } : {}),
        ...(f.hires.steps ? { hiresSteps: clamp(Math.round(f.hires.steps), 1, 60) } : {}),
      } : {}),
    };
    return {
      settings: {
        recipe, input, source: f.source, notes, missing,
        /** What was read, to show before anything is done with it. */
        model: f.checkpoint ? { name: f.checkpoint, found: Boolean(checkpoint) } : null,
        loras: loras.map((l) => ({ name: l.name, weight: l.weight, found: Boolean(l.file) })),
      },
      workflow: found.workflow, why: null,
    };
  });

  /** Model files being fetched into ComfyUI, whether that is turned on, and whether this ComfyUI can do it. */
  app.get("/api/downloads", async () => {
    const settings = await readSettings(s.db);
    return { on: settings.downloadModels, items: s.downloads.list(), manager: settings.downloadModels ? await s.downloads.manager(await s.comfy()) : { found: false } };
  });

  /**
   * Fetch a missing model file into ComfyUI: from Civitai (a version found by "Find it on Civitai"),
   * or from the address the workflow's author gave. ComfyUI-Manager does the saving; studai passes the
   * bytes through. Only when the user turned this on in Setup.
   */
  app.post("/api/downloads", async (req) => {
    const b = z.strictObject({
      // left empty for a Civitai version: the file keeps the name Civitai gives it
      file: z.string().max(400).default(""), folder: z.string().min(1).max(120),
      civitai: z.number().int().positive().optional(), url: z.string().url().max(2000).optional(),
    }).parse(req.body);
    const settings = await readSettings(s.db);
    if (!settings.downloadModels) throw Object.assign(new Error("Downloading into ComfyUI is turned off. Turn it on in Setup."), { statusCode: 400 });
    if (!b.civitai === !b.url) throw Object.assign(new Error("say where from: a Civitai version or an address"), { statusCode: 400 });
    const comfy = await s.comfy();
    // the address ComfyUI will fetch from: the one this page was opened at, unless one is set
    const self = process.env.PUBLIC_URL?.trim() || `${req.protocol}://${req.headers.host}`;
    const local = (host: string) => /^(localhost|127\.|\[::1\]|::1)/.test(host);
    if (!process.env.PUBLIC_URL && local(new URL(self).hostname) && !local(new URL(comfy.url).hostname)) {
      throw Object.assign(new Error("ComfyUI runs on another machine and cannot reach studai at this address. Open studai by its network address, or set PUBLIC_URL to it."), { statusCode: 400 });
    }
    const name = b.file.split(/[\\/]/).pop()!;
    if (b.url) {
      if (!name) throw Object.assign(new Error("under which name?"), { statusCode: 400 });
      if (!/^https:\/\//.test(b.url) && !process.env.CIVITAI_URL) throw Object.assign(new Error("only https addresses are fetched"), { statusCode: 400 });
      return s.downloads.start(comfy, self, { file: b.file, folder: b.folder, title: name, source: b.url });
    }
    const base = (process.env.CIVITAI_URL ?? "https://civitai.com").replace(/\/+$/, "");
    const auth = settings.civitaiKey ? { Authorization: `Bearer ${settings.civitaiKey}` } : undefined;
    const res = await fetch(`${base}/api/v1/model-versions/${b.civitai}`, { headers: auth, signal: AbortSignal.timeout(20_000) }).catch((err) => {
      throw Object.assign(new Error(`Civitai did not answer: ${(err as Error).message}`), { statusCode: 502 });
    });
    if (!res.ok) throw Object.assign(new Error(`Civitai refused (${res.status}).`), { statusCode: 502 });
    const v = (await res.json()) as { name?: string; model?: { name?: string }; files?: Array<{ name?: string; sizeKB?: number; type?: string; primary?: boolean; downloadUrl?: string }> };
    const files = (v.files ?? []).filter((f) => f.downloadUrl && (f.type ?? "Model") === "Model");
    // the file of that very name when the version has it, else its main file, saved under the name that is missing
    const picked = files.find((f) => f.name?.toLowerCase() === name.toLowerCase()) ?? files.find((f) => f.primary) ?? files[0];
    if (!picked?.downloadUrl) throw Object.assign(new Error("Civitai lists no file to download for that version."), { statusCode: 404 });
    return s.downloads.start(comfy, self, {
      file: b.file || (picked.name ?? "model.safetensors").replace(/[\\/:*?"<>|]/g, "_"), folder: b.folder, title: [v.model?.name, v.name].filter(Boolean).join(" · ") || name,
      source: picked.downloadUrl, headers: auth, total: Math.round((picked.sizeKB ?? 0) * 1024),
    });
  });

  /** The one-time address ComfyUI-Manager fetches a file from. It works once, for the download it was made for. */
  app.get<{ Params: { id: string }; Querystring: { t?: string } }>("/api/downloads/fetch/:id", async (req, reply) => {
    const got = await s.downloads.serve(req.params.id, String(req.query.t ?? ""));
    if (!got) return reply.code(404).send({ error: "this address is no longer good" });
    if ("error" in got) return reply.code(502).send({ error: got.error });
    req.raw.on("close", () => {
      if (!reply.raw.writableEnded) s.downloads.dropped(req.params.id);
    });
    reply.header("Content-Type", "application/octet-stream");
    if (got.size) reply.header("Content-Length", got.size);
    return reply.send(got.stream);
  });

  /** How long things usually take on this machine, per recipe: for "about 2 min" on buttons. */
  app.get("/api/estimates", async () => ({ rates: await rates(s.db) }));

  // ---------------------------------------------------------------- queue

  app.post("/api/jobs", async (req) => {
    const body = jobBody.parse(req.body);
    const recipe = s.registry.recipe(body.recipe);
    const input = recipe && body.look ? (await compose(s.db, recipe, body.input, body.look)).input : body.input;
    const ids: string[] = [];
    for (let i = 0; i < body.count; i++) ids.push(await s.queue.enqueue(body.recipe, input, { label: body.label }));
    return { ids };
  });

  app.get("/api/queue", async () => s.queue.status());
  app.post("/api/queue/pause", async () => {
    await s.queue.setPaused(true);
    return s.queue.status();
  });
  app.post("/api/queue/resume", async () => {
    await s.queue.setPaused(false);
    return s.queue.status();
  });

  /** The waiting jobs, in the order they should run. */
  app.post("/api/queue/order", async (req) => {
    await s.queue.reorder(z.strictObject({ ids: z.array(z.string()).max(500) }).parse(req.body).ids);
    return s.queue.status();
  });
  /** A finished job again, with some of its inputs changed when `input` is given. */
  app.post<{ Params: { id: string } }>("/api/jobs/:id/retry", async (req) => {
    const body = z.strictObject({ input: z.record(z.string(), z.unknown()).optional() }).parse(req.body ?? {});
    return { id: await s.queue.again(req.params.id, body.input) };
  });
  app.delete<{ Params: { id: string } }>("/api/jobs/:id", async (req) => {
    if (!(await s.queue.dismiss(req.params.id))) throw notFound("a finished job");
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/cancel", async (req) => {
    if (!(await s.queue.cancel(req.params.id))) throw notFound("a job to stop");
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/api/jobs/:id/preview", async (req, reply) => {
    const p = await s.queue.preview(req.params.id);
    if (!p) throw notFound("a preview");
    return reply.header("Content-Type", p.mime).header("Cache-Control", "no-store").send(Buffer.from(p.bytes));
  });

  /** Live updates: "queue", "library" and "progress" say what to refetch; "system" carries the machine's load. */
  app.get("/api/events", (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    const send = (event: string, data: unknown = {}) => reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const onQueue = () => send("queue");
    const onLibrary = () => send("library");
    const onModels = () => send("models");
    const onTimeline = () => send("timeline");
    const onEntities = () => send("entities");
    const onDownloads = () => send("downloads");
    const onSetup = () => send("setup");
    // progress can arrive many times a second: pass on at most four
    let last = 0;
    const onProgress = () => {
      if (Date.now() - last < 250) return;
      last = Date.now();
      send("progress");
    };
    s.queue.events.on("queue", onQueue).on("library", onLibrary).on("progress", onProgress).on("models", onModels).on("timeline", onTimeline).on("entities", onEntities).on("downloads", onDownloads).on("setup", onSetup);
    const sendSystem = async () => send("system", { load: await (await s.comfy()).load().catch(() => null) });
    const system = setInterval(sendSystem, 2000);
    send("hello", { version: VERSION });
    // right away, so the monitor bar is there when a page opens rather than two seconds later
    void sendSystem();
    req.raw.on("close", () => {
      clearInterval(system);
      s.queue.events.off("queue", onQueue).off("library", onLibrary).off("progress", onProgress).off("models", onModels).off("timeline", onTimeline).off("entities", onEntities).off("downloads", onDownloads).off("setup", onSetup);
    });
  });

  // ---------------------------------------------------------------- library

  const listQuery = z.object({
    kind: z.enum(["image", "video", "audio"]).optional(),
    bin: z.string().optional(),
    /** A folder id, or "none" for what is in no folder. */
    folder: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(60),
    /** The `next` value of the previous page. */
    after: z.string().optional(),
    /** Words to find, in the name or in what was written to make it. Forgiving: typos and letters left out. */
    q: z.string().max(200).optional(),
    /** Only what was made with this model family. */
    family: z.string().optional(),
    /** Only what was kept. */
    kept: z.string().optional(),
  });

  /** How many items a search looks through at most: the most recent ones. */
  const SEARCHED = 4000;

  app.get("/api/assets", async (req) => {
    const q = listQuery.parse(req.query);
    let query = s.db.selectFrom("assets").selectAll().where("deleted_at", q.bin ? "is not" : "is", null).where("origin", "!=", "mask");
    if (q.kind) query = query.where("kind", "=", q.kind);
    if (q.folder === "none") query = query.where("folder_id", "is", null);
    else if (q.folder) query = query.where("folder_id", "=", q.folder);
    if (q.kept) query = query.where("kept_at", "is not", null);
    if (q.family) query = query.where("generation_id", "in", s.db.selectFrom("generations").select("id").where("family", "=", q.family));
    if (q.q?.trim()) {
      // found by its name and by every text of the form it was made with
      const rows = await query.orderBy("created_at", "desc").orderBy("id", "desc").limit(SEARCHED).execute();
      const made = rows.some((r) => r.generation_id)
        ? await s.db.selectFrom("generations").select(["id", "inputs"]).where("id", "in", rows.map((r) => r.generation_id).filter((x): x is string => Boolean(x))).execute()
        : [];
      const words = new Map(made.map((g) => [g.id, Object.values(JSON.parse(g.inputs) as Record<string, unknown>).filter((v): v is string => typeof v === "string").join(" ")]));
      const found = fuzzyFilter(rows, q.q, (a) => `${a.name} ${a.generation_id ? words.get(a.generation_id) ?? "" : ""}`);
      const from = Number(q.after) || 0;
      return { items: found.slice(from, from + q.limit).map(assetView), next: from + q.limit < found.length ? String(from + q.limit) : null };
    }
    if (q.after) {
      const [at = "", id = ""] = q.after.split("|");
      query = query.where((eb) => eb.or([eb("created_at", "<", at), eb.and([eb("created_at", "=", at), eb("id", "<", id)])]));
    }
    const rows = await query.orderBy("created_at", "desc").orderBy("id", "desc").limit(q.limit + 1).execute();
    const page = rows.slice(0, q.limit);
    const tail = page.at(-1);
    return { items: page.map(assetView), next: rows.length > q.limit && tail ? `${tail.created_at}|${tail.id}` : null };
  });

  /** The model families things in the library were made with, for the "Any model" filter. */
  app.get("/api/assets/families", async () => ({
    items: (
      await s.db.selectFrom("generations").innerJoin("assets", "assets.generation_id", "generations.id").select("generations.family").where("assets.deleted_at", "is", null).distinct().execute()
    ).map((r) => r.family),
  }));

  const asset = async (id: string) => {
    const a = await s.db.selectFrom("assets").selectAll().where("id", "=", id).executeTakeFirst();
    if (!a) throw notFound("this item");
    return a;
  };

  /**
   * A picture, a video or a sound from the user's computer, sent as the request body. It is theirs, so
   * it is kept from the start and never goes to the bin on its own.
   */
  app.post<{ Querystring: { name?: string; as?: string } }>("/api/assets", { bodyLimit: UPLOAD_LIMIT }, async (req) => {
    const bytes = Buffer.isBuffer(req.body) ? new Uint8Array(req.body) : null;
    // what the file is comes from its bytes, not from what the browser says it is
    const picture = bytes && (await readPicture(bytes));
    const media = bytes && !picture ? await probeMedia(bytes) : null;
    if (!bytes || (!picture && !media)) {
      throw Object.assign(new Error("This file is not a picture, a video or a sound studai can read. Pictures: PNG, JPEG, WebP. Videos and sounds are read with ffmpeg, which has to be installed where studai runs."), { statusCode: 400 });
    }
    // the part of a picture painted over to redo it: kept, but it is not something to look at in the library
    const mask = req.query.as === "mask";
    if (mask && !picture) throw Object.assign(new Error("the painted part has to be a picture"), { statusCode: 400 });
    const id = newId();
    const mime = picture?.mime ?? media!.mime;
    const key = `assets/${id.slice(0, 2)}/${id}.${extOf(mime)}`;
    await s.storage.put(key, bytes);
    const video = media?.kind === "video" ? await readVideo(bytes, extOf(mime)) : null;
    const thumb = picture ? await makeThumb(bytes) : video?.frame ? await makeThumb(video.frame) : null;
    if (thumb) await s.storage.put(thumbKey(id), thumb);
    const at = now();
    await s.db
      .insertInto("assets")
      .values({
        id, owner_id: OWNER, kind: picture ? "image" : media!.kind, origin: mask ? "mask" : "uploaded", name: String(req.query.name ?? "").slice(0, 200), file_key: key,
        thumb_key: thumb ? thumbKey(id) : null, mime, bytes: bytes.length, width: picture?.width ?? video?.facts?.width ?? null, height: picture?.height ?? video?.facts?.height ?? null,
        duration_ms: media?.durationMs ?? null, fps: video?.facts?.fps ?? null, has_sound: media?.kind === "audio" || video?.facts?.hasSound ? 1 : 0,
        folder_id: null, generation_id: null, kept_at: at, deleted_at: null, created_at: at,
      })
      .execute();
    if (!mask) s.queue.events.emit("library");
    return assetView(await asset(id));
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
      generation: g
        ? { id: g.id, recipe: g.recipe_id, family: g.family, inputs: JSON.parse(g.inputs), resolved: JSON.parse(g.resolved), tookMs: g.gen_ms }
        : null,
      sources: sources.map(({ role, ...row }) => ({ role, asset: assetView(row) })),
      usedIn: usedIn.map(assetView),
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
      // of a video: its first frame. A video stored before studai read videos gets its size and length now too.
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
    if (video.kind !== "video" || !video.has_sound) throw Object.assign(new Error("This has no sound to take."), { statusCode: 400 });
    const bytes = await soundOf(await s.storage.get(video.file_key), extOf(video.mime));
    const id = newId();
    const key = `assets/${id.slice(0, 2)}/${id}.m4a`;
    await s.storage.put(key, bytes);
    const at = now();
    await s.db
      .insertInto("assets")
      .values({
        id, owner_id: OWNER, kind: "audio", origin: "imported", name: video.name ? `${video.name}, its sound` : "The sound of a video", file_key: key, thumb_key: null,
        mime: "audio/mp4", bytes: bytes.length, width: null, height: null, duration_ms: video.duration_ms, fps: null, has_sound: 1,
        folder_id: video.folder_id, generation_id: null, kept_at: at, deleted_at: null, created_at: at,
      })
      .execute();
    s.queue.events.emit("library");
    return assetView(await asset(id));
  });

  app.post<{ Params: { id: string } }>("/api/assets/:id/keep", async (req) => {
    const { kept } = z.strictObject({ kept: z.boolean() }).parse(req.body);
    await asset(req.params.id);
    await s.db.updateTable("assets").set({ kept_at: kept ? now() : null }).where("id", "=", req.params.id).execute();
    return assetView(await asset(req.params.id));
  });

  /** To the bin. Nothing is erased here: the bin is emptied later. */
  app.delete<{ Params: { id: string } }>("/api/assets/:id", async (req) => {
    await asset(req.params.id);
    await s.db.updateTable("assets").set({ deleted_at: now() }).where("id", "=", req.params.id).execute();
    s.queue.events.emit("library");
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/assets/:id/restore", async (req) => {
    await asset(req.params.id);
    await s.db.updateTable("assets").set({ deleted_at: null }).where("id", "=", req.params.id).execute();
    s.queue.events.emit("library");
    return assetView(await asset(req.params.id));
  });

  return app;
}
