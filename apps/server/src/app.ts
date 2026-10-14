import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ZodError } from "zod";
import { VERSION } from "./config";
import { registerAssets } from "./assets-api";
import { registerBackup, type BackupPlaces } from "./backup";
import { registerCommandBar } from "./commandIndex";
import { registerCompression, registerEtags } from "./compress";
import { registerDesigner } from "./designer-api";
import { registerDrafts } from "./drafts";
import { registerEntities } from "./entities";
import { httpError } from "./errors";
import { registerEvents } from "./events";
import { registerFolders } from "./folders";
import { registerForecasts } from "./forecasts-api";
import { allowedHosts, ANY_HOST, crossSite, crossSiteRead, hostAllowed, marked, SAFETY_HEADERS, UPLOAD_TYPE } from "./hostCheck";
import { registerHistory } from "./history-api";
import { registerHunt } from "./hunt";
import { registerJobs } from "./jobs-api";
import { registerLookup } from "./lookup-api";
import { registerMeasures } from "./measures-api";
import { registerMetrics } from "./metrics";
import { registerModelInfo } from "./modelInfo";
import { registerModelPages } from "./modelPages";
import { registerModelSettings } from "./modelSettings";
import { registerModelUpdates } from "./modelUpdates";
import { registerBrowse } from "./browse";
import { registerNodePack } from "./nodePack";
import { registerNotify } from "./notify";
import { registerModelSets } from "./modelSets";
import { registerPresetFiles } from "./presetFiles";
import { registerProjects } from "./projects";
import { registerRenders } from "./renders-api";
import type { Services } from "./services";
import { registerSetup } from "./setup-api";
import { registerLock } from "./lock-api";
import { registerRented } from "./rented-api";
import { registerTags } from "./tags";
import { registerTimelines } from "./timelines-api";
import { isUpload, uploadBody } from "./uploadBody";
import { registerUpdates } from "./updates-api";
import type { AfflatusUpdates } from "./updates";
import { registerUsage } from "./usage";
import { registerWorkflows } from "./workflows";

/** The release this is: set by the build (AFFLATUS_VERSION, from the git tag); "dev" when run from the sources. */
export { VERSION };

export function buildApp(s: Services, opts: { webDir?: string; /** Where the data is, for the backup; without it there is no backup. */ backup?: BackupPlaces; /** Afflatus's own updates (start.ts); without them the routes are not there. */ updates?: AfflatusUpdates } = {}): FastifyInstance {
  // a workflow with many nodes is a large body
  const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 });
  // the API's JSON tagged for a 304 when unchanged, then it and the web app's files compressed for a browser that takes
  // it (compress.ts): first, so that every route has them, the tag before the compression, so that it is of the bytes as made
  registerEtags(app);
  registerCompression(app);

  // only the server's own names are answered to (hostCheck.ts): a page from elsewhere cannot drive the API by pointing a name of its own at this machine
  const hosts = allowedHosts();
  app.addHook("onRequest", async (req, reply) => {
    // on the raw answer, so that a stream written by hand (the event stream) carries them too
    for (const [name, value] of Object.entries(SAFETY_HEADERS)) reply.raw.setHeader(name, value);
    const reads = req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS";
    // a read from another site's page is refused too (hostCheck.ts crossSiteRead): it cannot see the answer, but it can make the server work
    if ((req.method === "GET" || req.method === "HEAD") && crossSiteRead(req.headers, req.url.split("?")[0] ?? "")) {
      return reply.status(403).send({ error: "Afflatus answers another site's page only with a link followed or an asset's picture, video or sound." });
    }
    // nor can a page elsewhere change anything here through the browser of someone who has Afflatus open (a no-cors POST needs no preflight)
    if (!reads && crossSite(req.headers, hosts)) return reply.status(403).send({ error: "Afflatus takes changes only from its own page, not from another site's." });
    if (!hostAllowed(req.headers.host, hosts) && !(req.method === "GET" && ANY_HOST.has(req.url.split("?")[0] ?? ""))) {
      return reply.status(403).send({ error: `Afflatus does not answer to the name "${req.headers.host}". Open it as localhost or by the address it listens on, or name this one in ALLOWED_HOSTS.` });
    }
    // and a change must say it is not a plain form's (hostCheck.ts marked): a body-less POST from elsewhere needs no preflight either
    if (!reads && !marked(req.headers)) return reply.status(403).send({ error: "Afflatus takes changes only as JSON, a file, or with the header \"X-Afflatus: 1\" (a script: add it to the request)." });
  });

  /** Files from the computer are sent as the request body itself: written to a temporary file as they arrive, never held in memory. */
  const UPLOAD_LIMIT = 512 * 1024 * 1024;
  app.addContentTypeParser(UPLOAD_TYPE, (_req, payload, done) => {
    void (async () => {
      const dir = await mkdtemp(join(tmpdir(), "afflatus-upload-"));
      const path = join(dir, "body.bin");
      let bytes = 0;
      try {
        const limit = new Transform({
          transform(chunk: Buffer, _enc, next) {
            bytes += chunk.length;
            next(bytes > UPLOAD_LIMIT ? httpError(`This file is larger than ${UPLOAD_LIMIT / 1024 / 1024} MB, the most Afflatus takes in one upload.`, 413) : null, chunk);
          },
        });
        await pipeline(payload, limit, createWriteStream(path));
        done(null, uploadBody({ path, dir, bytes }));
      } catch (err) {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
        done(err as Error);
      }
    })();
  });
  // the temporary file goes with the answer, or with a request that was broken off before its end
  const dropUpload = async (req: { body: unknown }) => {
    if (isUpload(req.body)) await rm(req.body.dir, { recursive: true, force: true }).catch(() => {});
  };
  app.addHook("onResponse", dropUpload);
  app.addHook("onRequestAbort", dropUpload);

  // the built web app, served by the same process: one thing to start, one port
  if (opts.webDir) {
    // one route for the whole folder, read at each request: a bundle rebuilt while the server runs is served as it
    // is now (with a route per file, taken at start, a new bundle's files were "not found" until a restart)
    void app.register(fastifyStatic, {
      root: opts.webDir, wildcard: true,
      // the bundle's files carry a hash in their name: kept for good. The page itself is asked for again each time, so a new build is seen on the next load
      setHeaders: (res, path) => void res.header("Cache-Control", path.replaceAll("\\", "/").includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache"),
    });
    app.setNotFoundHandler((req, reply) => {
      const path = req.url.split("?")[0] ?? "";
      // a file that is not there (a bundle from before a rebuild, still named by an open tab) is a 404, never the page:
      // a browser given a page where it asked for a script refuses it, and the error it shows says nothing about why
      const file = /\.[a-z0-9]{2,8}$/i.test(path);
      if (req.method === "GET" && !path.startsWith("/api/") && !file) return reply.header("Cache-Control", "no-cache").sendFile("index.html");
      return reply.status(404).send({ error: file ? "there is no such file: if the page just loaded, reload it, it may name a bundle from before a rebuild" : "there is nothing at this address" });
    });
  }

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });
    }
    // an error raised with a status was written to be read; anything else is a bug, logged and not shown
    const status = (err as { statusCode?: number }).statusCode;
    // which request: a bug's stack alone does not say which screen or action met it
    if (!status) console.error(`[http] ${req.method} ${req.url} failed:`, err);
    return reply.status(status ?? 500).send({ error: status ? (err as Error).message : "something went wrong on the server" });
  });

  registerSetup(app, s, VERSION);
  registerLock(app, s);
  registerRented(app, s);
  registerHunt(app, s);
  registerNotify(app, s.notify);
  registerDrafts(app, s);
  registerModelSettings(app, s);
  registerPresetFiles(app, s);
  registerModelSets(app, s);
  registerNodePack(app, s);
  registerModelInfo(app, s);
  registerModelPages(app, s);
  registerModelUpdates(app, s, s.updates);
  registerBrowse(app, s);
  registerBackup(app, s, opts.backup);
  registerFolders(app, s);
  registerProjects(app, s);
  registerCommandBar(app, s);
  registerForecasts(app, s);
  registerWorkflows(app, s);
  registerTimelines(app, s);
  registerMeasures(app, s);
  registerUsage(app, s);
  registerRenders(app, s);
  registerMetrics(app, s);
  registerEntities(app, s);
  registerDesigner(app, s);
  registerTags(app);
  registerEvents(app, s, VERSION);
  registerLookup(app, s);
  registerJobs(app, s);
  registerHistory(app, s);
  registerAssets(app, s);
  if (opts.updates) registerUpdates(app, opts.updates);

  return app;
}
