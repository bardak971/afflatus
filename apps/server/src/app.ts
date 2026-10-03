import { castOf, madeIn } from "./provenance";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { z, ZodError } from "zod";
import { describeRecipe, fuzzyFilter, parseInput } from "@afflatus/core";
import { civitaiVersion, findOnCivitai } from "./civitai";
import { findOnHuggingFace } from "./huggingface";
import { readEmbedded } from "./embedded";
import { resolveLink } from "./fromLink";
import { fill, targetsFor } from "./fromPicture";
import { newId, now, OWNER } from "./db";
import { registerDesigner } from "./designer";
import { registerDrafts } from "./drafts";
import { compose, lookSchema, registerEntities } from "./entities";
import { registerFolders } from "./folders";
import { isLinked } from "./linked";
import { registerModelInfo } from "./modelInfo";
import { registerModelPages } from "./modelPages";
import { registerModelSettings } from "./modelSettings";
import type { Services } from "./services";
import { publicSettings, readSettings, writeSettings } from "./settings";
import { assetView, extOf } from "./media";
import { registerTags } from "./tags";
import { registerTimelines } from "./timelines-api";
import { makeThumb, readPicture, thumbKey } from "./thumbs";
import { probeMedia, soundOf } from "./cut";
import { rates } from "./estimates";
import { registerUsage } from "./usage";
import { registerRenders } from "./renders-api";
import { registerMetrics } from "./metrics";
import { openInComfy } from "./comfyOpen";
import { toEditor } from "@afflatus/workflows";
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
  /** The draft it is sent from, and the folder that is open: its results are filed there. */
  draft: z.string().max(64).optional(),
  folder: z.string().max(64).optional(),
});
/** A form as it stands, to load its models ahead or to ask whether they are loaded. */
const warmBody = z.strictObject({ recipe: z.string().min(1), input: z.record(z.string(), z.unknown()), look: lookSchema.optional() });

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
  registerModelPages(app, s);
  registerFolders(app, s);
  registerWorkflows(app, s);
  registerTimelines(app, s);
  registerUsage(app, s);
  registerRenders(app, s);
  registerMetrics(app, s);
  registerEntities(app, s);
  registerDesigner(app, s);
  registerTags(app);

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
   * turned this on in Settings; the file name is all that is sent.
   */
  app.get<{ Querystring: { file?: string; folder?: string; hints?: string } }>("/api/civitai/find", async (req) => {
    const settings = await readSettings(s.db);
    if (!settings.civitaiLookups) throw Object.assign(new Error("Civitai lookups are turned off. Turn them on in Settings."), { statusCode: 400 });
    const file = String(req.query.file ?? "").split(/[\\/]/).pop() ?? "";
    if (!file.replace(/\.(safetensors|ckpt|pt|pth|bin|gguf|sft|onnx)$/i, "")) throw Object.assign(new Error("no filename given"), { statusCode: 400 });
    // Hugging Face is asked for the file itself, by its exact name; Civitai for models whose names are close
    const hints = String(req.query.hints ?? "").split("|").map((h) => h.trim()).filter(Boolean).slice(0, 3);
    const [exact, civitai] = await Promise.all([
      findOnHuggingFace(file, hints).catch(() => ({ items: [], answered: false })),
      findOnCivitai(file, req.query.folder ? String(req.query.folder) : null, settings.civitaiKey).catch((err: Error) => err),
    ]);
    if (civitai instanceof Error && !exact.answered) throw civitai;
    const found = civitai instanceof Error ? { items: [], asked: [] as string[], silent: ["civitai.com"] } : civitai;
    const answer = { ...found, exact: exact.items, asked: [...(exact.answered ? ["huggingface.co"] : []), ...found.asked] };
    // a model already on this ComfyUI under the name Civitai gives it is no download: it only has to be picked, or moved
    const client = (await s.comfy()).client;
    const folders = await client.folders().catch(() => [] as string[]);
    const lists = await Promise.all(folders.map(async (folder) => ({ folder, files: await client.models(folder).catch(() => [] as string[]) })));
    // the folder the loader looks in first: a file that is there too is simply picked
    lists.sort((x, y) => Number(y.folder === req.query.folder) - Number(x.folder === req.query.folder));
    const base = (f: string) => (f.split(/[\\/]/).pop() ?? f).toLowerCase();
    for (const item of found.items) {
      if (!item.file) continue;
      for (const l of lists) {
        const here = l.files.find((f) => base(f) === item.file.toLowerCase());
        if (here) {
          item.have = { folder: l.folder, file: here };
          break;
        }
      }
    }
    return answer;
  });

  /**
   * What a file from the computer says about how it was made: settings worked into a form (the one
   * that uses the model it was made with, or the one asked for with ?recipe=), and the workflow it carries.
   * The file is read and forgotten: nothing is stored.
   */
  const embeddedIn = async (bytes: Uint8Array, wanted: string | undefined) => {
    const found = await readEmbedded(bytes);
    if (!found.settings) return { settings: null, workflow: found.workflow, why: found.why ?? null };
    const scan = await (await s.comfy()).scan().catch(() => null);
    const optionsOf = (id: string) => scan?.recipes.find((r) => r.id === id)?.options ?? {};
    // which form: the one asked for, else the one that uses the model the picture was made with
    const targets = targetsFor(found.settings, s.registry.recipes(), optionsOf);
    const recipe = s.registry.recipe(targets.find((t) => t.id === wanted)?.id ?? targets[0]?.id ?? "sdxl.text-to-picture");
    if (!recipe) throw Object.assign(new Error("no model takes these generation parameters"), { statusCode: 400 });
    return { settings: { ...fill(found.settings, recipe, optionsOf(recipe.id), Boolean(scan?.comfy.online)), targets }, workflow: found.workflow, why: null };
  };
  app.post<{ Querystring: { recipe?: string } }>("/api/embedded", { bodyLimit: UPLOAD_LIMIT }, async (req) => {
    const bytes = Buffer.isBuffer(req.body) ? new Uint8Array(req.body) : null;
    if (!bytes) throw Object.assign(new Error("send the file itself"), { statusCode: 400 });
    return embeddedIn(bytes, req.query.recipe);
  });
  /** The same for a picture or a video already in the library: what its file carries. */
  app.get<{ Params: { id: string }; Querystring: { recipe?: string } }>("/api/assets/:id/embedded", async (req) => {
    const a = await s.db.selectFrom("assets").select(["file_key"]).where("id", "=", req.params.id).executeTakeFirst();
    if (!a) throw notFound("that item");
    return embeddedIn(await s.storage.get(a.file_key), req.query.recipe);
  });

  /** Model files being fetched into ComfyUI, whether that is turned on, and whether this ComfyUI can do it. */
  app.get("/api/downloads", async () => {
    const settings = await readSettings(s.db);
    return { on: settings.downloadModels, items: s.downloads.list(), manager: settings.downloadModels ? await s.downloads.manager(await s.comfy()) : { found: false } };
  });

  /**
   * Fetch a missing model file into ComfyUI: from Civitai (a version found by "Find it on Civitai"),
   * or from the address the workflow's author gave. ComfyUI-Manager does the saving; Afflatus passes the
   * bytes through. Only when the user turned this on in Settings.
   */
  app.post("/api/downloads", async (req) => {
    const b = z.strictObject({
      // left empty for a Civitai version: the file keeps the name Civitai gives it
      file: z.string().max(400).default(""), folder: z.string().min(1).max(120),
      civitai: z.number().int().positive().optional(), url: z.string().url().max(2000).optional(),
      // of a Civitai version with several files: the one to fetch, by the name Civitai gives it
      pick: z.string().max(400).optional(),
      // the page it comes from, kept for the file: its name then leads there
      page: z.strictObject({ url: z.string().url().max(2000), title: z.string().max(300) }).optional(),
    }).parse(req.body);
    const settings = await readSettings(s.db);
    if (!settings.downloadModels) throw Object.assign(new Error("Downloading into ComfyUI is turned off. Turn it on in Settings."), { statusCode: 400 });
    if (!b.civitai === !b.url) throw Object.assign(new Error("a source is needed: a Civitai version or a URL"), { statusCode: 400 });
    const comfy = await s.comfy();
    // the address ComfyUI will fetch from: the one this page was opened at, unless one is set
    const self = process.env.PUBLIC_URL?.trim() || `${req.protocol}://${req.headers.host}`;
    const local = (host: string) => /^(localhost|127\.|\[::1\]|::1)/.test(host);
    if (!process.env.PUBLIC_URL && local(new URL(self).hostname) && !local(new URL(comfy.url).hostname)) {
      throw Object.assign(new Error("ComfyUI runs on another machine and cannot reach Afflatus at this URL. Open Afflatus by its network URL, or set PUBLIC_URL to it."), { statusCode: 400 });
    }
    const name = b.file.split(/[\\/]/).pop()!;
    const keepPage = async (saved: string) => {
      if (!b.page || !/^[\w-]{1,64}$/.test(b.folder)) return;
      const key = { folder: b.folder, name: (saved.split(/[\\/]/).pop() ?? saved).toLowerCase() };
      await s.db.insertInto("model_pages").values({ ...key, url: b.page.url, title: b.page.title, found_at: new Date().toISOString() })
        .onConflict((oc) => oc.columns(["folder", "name"]).doUpdateSet({ url: b.page!.url, title: b.page!.title })).execute();
    };
    if (b.url) {
      if (!name) throw Object.assign(new Error("no filename given"), { statusCode: 400 });
      if (!/^https:\/\//.test(b.url) && !process.env.CIVITAI_URL) throw Object.assign(new Error("only https URLs are downloaded"), { statusCode: 400 });
      const started = await s.downloads.start(comfy, self, { file: b.file, folder: b.folder, title: name, source: b.url });
      await keepPage(started.file);
      return started;
    }
    const found = await civitaiVersion(b.civitai!, b.pick ?? name, settings.civitaiKey);
    if (!found?.file.downloadUrl) throw Object.assign(new Error("Civitai lists no file to download for that version."), { statusCode: 404 });
    if (b.pick && found.file.name?.toLowerCase() !== b.pick.toLowerCase()) throw Object.assign(new Error(`That version has no file called ${b.pick}.`), { statusCode: 404 });
    const saveAs = b.file || (found.file.name ?? "model.safetensors").replace(/[\\/:*?"<>|]/g, "_");
    await keepPage(saveAs);
    return s.downloads.start(comfy, self, {
      file: saveAs, folder: b.folder, title: found.title || name,
      source: found.file.downloadUrl, headers: settings.civitaiKey ? { Authorization: `Bearer ${settings.civitaiKey}` } : undefined,
      total: Math.round((found.file.sizeKB ?? 0) * 1024),
    });
  });

  /**
   * What a link leads to (a model's page on Civitai, a file on Hugging Face): its files and sizes, the
   * folder it most likely belongs in, ComfyUI's folders to choose from, and whether ComfyUI has it already.
   */
  app.post("/api/downloads/resolve", async (req) => {
    const { link } = z.strictObject({ link: z.string().min(8).max(2000) }).parse(req.body);
    const settings = await readSettings(s.db);
    if (!settings.downloadModels) throw Object.assign(new Error("Downloading into ComfyUI is turned off. Turn it on in Settings."), { statusCode: 400 });
    const found = await resolveLink(link, settings.civitaiKey);
    const client = (await s.comfy()).client;
    const folders = await client.folders().catch(() => [] as string[]);
    const lists = await Promise.all(folders.map(async (folder) => ({ folder, files: await client.models(folder).catch(() => [] as string[]) })));
    const base = (f: string) => (f.split(/[\\/]/).pop() ?? f).toLowerCase();
    const have = Object.fromEntries(found.files.flatMap((f) => {
      const where = lists.find((l) => l.files.some((x) => base(x) === f.name.toLowerCase()));
      return where ? [[f.name, where.folder]] : [];
    }));
    return { ...found, folders: folders.sort(), have };
  });

  /** Stop a download that is under way (nothing is left behind), or take a finished one off the list. */
  app.delete<{ Params: { id: string } }>("/api/downloads/:id", async (req) => {
    const stopped = s.downloads.stop(req.params.id);
    if (stopped === false) throw notFound("that download");
    if (stopped === "late") throw Object.assign(new Error("Download complete: ComfyUI is saving the file now."), { statusCode: 409 });
    return { ok: true };
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


  // ---------------------------------------------------------------- queue

  app.post("/api/jobs", async (req) => {
    const body = jobBody.parse(req.body);
    const recipe = s.registry.recipe(body.recipe);
    const input = recipe && body.look ? (await compose(s.db, recipe, body.input, body.look)).input : body.input;
    const ids: string[] = [];
    for (let i = 0; i < body.count; i++) ids.push(await s.queue.enqueue(body.recipe, input, { label: body.label, draft: body.draft, folder: body.folder, look: body.look }));
    return { ids };
  });

  /**
   * Load the models a form would render with, ahead of the render: a job in the queue like any other,
   * that makes nothing. Asked for while the prompt is still being written.
   */
  // the cast is worked in as for a render: a person with reference pictures can call for another model
  const withCast = async (body: z.infer<typeof warmBody>) => {
    const recipe = s.registry.recipe(body.recipe);
    return recipe && body.look ? (await compose(s.db, recipe, body.input, body.look).catch(() => null))?.input ?? body.input : body.input;
  };
  app.post("/api/jobs/warm", async (req) => {
    const body = warmBody.parse(req.body);
    return { id: await s.queue.enqueue(body.recipe, await withCast(body), { label: `Load the model: ${s.registry.recipe(body.recipe)?.title ?? body.recipe}`, warm: true }) };
  });

  /** Whether the models a form would render with are the ones ComfyUI was last asked to load. */
  app.post("/api/comfy/loaded", async (req) => {
    const body = warmBody.parse(req.body);
    return { loaded: await s.queue.isLoaded(body.recipe, await withCast(body)) };
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

  /** Unload ComfyUI's models now: the GPU's memory is wanted for something else. */
  app.post("/api/comfy/free", async () => {
    await s.queue.freeMemory();
    return { ok: true };
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
    if (!(await s.queue.cancel(req.params.id))) throw notFound("a job to cancel");
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
    /** Only what was made with this model file (a checkpoint, a diffusion model), or with this LoRA. */
    model: z.string().max(500).optional(),
    lora: z.string().max(500).optional(),
    /** Only what this draft made. */
    draft: z.string().max(64).optional(),
  });

  /** The model files and the LoRAs a generation was made with. */
  const madeWith = (g: { recipe_id: string; inputs: string; resolved: string }) => {
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

  /** The model files and the LoRAs things in the library were made with, the most used first, for the filters. */
  app.get("/api/assets/models", async () => {
    const rows = await s.db
      .selectFrom("generations").innerJoin("assets", "assets.generation_id", "generations.id")
      .select(["generations.id", "generations.recipe_id", "generations.inputs", "generations.resolved"])
      .where("assets.deleted_at", "is", null).where("assets.origin", "!=", "mask")
      .execute();
    const models = new Map<string, number>();
    const loras = new Map<string, number>();
    const with_ = new Map<string, ReturnType<typeof madeWith>>();
    for (const g of rows) {
      // one generation can have made several things: each counts
      const w = with_.get(g.id) ?? madeWith(g);
      with_.set(g.id, w);
      for (const f of w.models) models.set(f, (models.get(f) ?? 0) + 1);
      for (const f of w.loras) loras.set(f, (loras.get(f) ?? 0) + 1);
    }
    const sorted = (m: Map<string, number>) => [...m.entries()].map(([file, count]) => ({ file, count })).sort((a, b) => b.count - a.count || a.file.localeCompare(b.file));
    return { models: sorted(models), loras: sorted(loras) };
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
  app.post<{ Querystring: { name?: string; as?: string; folder?: string } }>("/api/assets", { bodyLimit: UPLOAD_LIMIT }, async (req) => {
    const bytes = Buffer.isBuffer(req.body) ? new Uint8Array(req.body) : null;
    // what the file is comes from its bytes, not from what the browser says it is
    const picture = bytes && (await readPicture(bytes));
    const media = bytes && !picture ? await probeMedia(bytes) : null;
    if (!bytes || (!picture && !media)) {
      throw Object.assign(new Error("This file is not an image, a video or an audio file Afflatus can read. Images: PNG, JPEG, WebP. Video and audio are read with ffmpeg, which has to be installed where Afflatus runs."), { statusCode: 400 });
    }
    // the part of a picture painted over to redo it: kept, but it is not something to look at in the library
    const mask = req.query.as === "mask";
    if (mask && !picture) throw Object.assign(new Error("the mask has to be an image"), { statusCode: 400 });
    const id = newId();
    const mime = picture?.mime ?? media!.mime;
    const key = `assets/${id.slice(0, 2)}/${id}.${extOf(mime)}`;
    await s.storage.put(key, bytes);
    const video = media?.kind === "video" ? await readVideo(bytes, extOf(mime)) : null;
    const thumb = picture ? await makeThumb(bytes) : video?.frame ? await makeThumb(video.frame) : null;
    if (thumb) await s.storage.put(thumbKey(id), thumb);
    const at = now();
    // a whole folder brought in from the computer: each file goes straight into the folder made for it
    const into = req.query.folder && !mask ? (await s.db.selectFrom("folders").select("id").where("id", "=", req.query.folder).executeTakeFirst())?.id ?? null : null;
    await s.db
      .insertInto("assets")
      .values({
        id, owner_id: OWNER, kind: picture ? "image" : media!.kind, origin: mask ? "mask" : "uploaded", name: String(req.query.name ?? "").slice(0, 200), file_key: key,
        thumb_key: thumb ? thumbKey(id) : null, mime, bytes: bytes.length, width: picture?.width ?? video?.facts?.width ?? null, height: picture?.height ?? video?.facts?.height ?? null,
        duration_ms: media?.durationMs ?? null, fps: video?.facts?.fps ?? null, has_sound: media?.kind === "audio" || video?.facts?.hasSound ? 1 : 0,
        folder_id: into, generation_id: null, kept_at: at, deleted_at: null, linked_path: null, created_at: at,
      })
      .execute();
    // into a linked folder: it is a file of that directory at once
    if (into) await fileInLinked(id);
    if (!mask) s.queue.events.emit("library");
    return assetView(await asset(id));
  });

  /**
   * Show how a result was made in ComfyUI's editor: its graph built again from its generation parameters
   * and its seed (nothing is uploaded: the images and sounds it used are named in the graph by their own
   * names, for the eye; ComfyUI will not have them), then written where ComfyUI opens it (comfyOpen.ts).
   */
  app.post<{ Params: { id: string } }>("/api/assets/:id/open", async (req) => {
    const a = await asset(req.params.id);
    const g = a.generation_id ? await s.db.selectFrom("generations").select(["recipe_id", "inputs", "resolved"]).where("id", "=", a.generation_id).executeTakeFirst() : undefined;
    if (!g) throw Object.assign(new Error("this file was not generated by afflatus: there is no graph to show"), { statusCode: 400 });
    if (!s.registry.recipe(g.recipe_id)) throw Object.assign(new Error("the model this was generated with is no longer here"), { statusCode: 400 });
    const used = await s.db.selectFrom("generation_inputs").innerJoin("assets", "assets.id", "generation_inputs.asset_id").select(["assets.id", "assets.name", "assets.mime"]).where("generation_inputs.generation_id", "=", a.generation_id!).execute();
    const names = Object.fromEntries(used.map((u) => [u.id, /\.[a-z0-9]+$/i.test(u.name) ? u.name : `${u.name}.${extOf(u.mime)}`]));
    const resolved = JSON.parse(g.resolved) as { seed?: number };
    const built = await s.queue.builtOf(g.recipe_id, JSON.parse(g.inputs), { seed: resolved.seed, names });
    if (!built) throw Object.assign(new Error("the graph of this result could not be built again"), { statusCode: 400 });
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
    if (video.kind !== "video" || !video.has_sound) throw Object.assign(new Error("This video has no audio to extract."), { statusCode: 400 });
    const bytes = await soundOf(await s.storage.get(video.file_key), extOf(video.mime));
    const id = newId();
    const key = `assets/${id.slice(0, 2)}/${id}.m4a`;
    await s.storage.put(key, bytes);
    const at = now();
    await s.db
      .insertInto("assets")
      .values({
        id, owner_id: OWNER, kind: "audio", origin: "imported", name: video.name ? `${video.name}, audio` : "Audio extracted from a video", file_key: key, thumb_key: null,
        mime: "audio/mp4", bytes: bytes.length, width: null, height: null, duration_ms: video.duration_ms, fps: null, has_sound: 1,
        folder_id: video.folder_id, generation_id: null, source_id: video.id, kept_at: at, deleted_at: null, created_at: at,
      })
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
    s.queue.events.emit("library");
    return { changed: Number(done.numUpdatedRows) + special };
  });

  app.post<{ Params: { id: string } }>("/api/assets/:id/restore", async (req) => {
    const a = await asset(req.params.id);
    // a file that was taken out of a linked folder goes back into its directory
    if (a.linked_path) await s.linked.restore(a);
    else await s.db.updateTable("assets").set({ deleted_at: null }).where("id", "=", req.params.id).execute();
    s.queue.events.emit("library");
    return assetView(await asset(req.params.id));
  });

  return app;
}
