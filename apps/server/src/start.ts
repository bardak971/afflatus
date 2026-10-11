import { existsSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { buildApp, VERSION } from "./app";
import type { Config } from "./config";
import { migrate, openDb, type DbKind } from "./db";
import type { QueueOptions } from "./queue";
import { createServices, type Services } from "./services";
import { readSettings } from "./settings";
import { installNodePack } from "./nodePack";
import { LocalStorage } from "./storage";
import { preflight } from "./preflight";

/** The built web app, when there is one (`pnpm build`). In development Vite serves it instead. */
export function webDir(): string | undefined {
  const dir = fileURLToPath(new URL("../../web/dist", import.meta.url));
  return existsSync(join(dir, "index.html")) ? dir : undefined;
}

/** The port is taken: by another Afflatus (perhaps on this same data folder), or by a program of the user's. */
export class PortTakenError extends Error {
  constructor(readonly host: string, readonly port: number) {
    super(`Port ${port} is already in use on ${host}: another Afflatus, or another program. Start this one on another port, for example PORT=8730 (PowerShell: $env:PORT=8730; cmd: set PORT=8730), or stop the other first.`);
    this.name = "PortTakenError";
  }
}

/** The data folder cannot be written: the start stops with its fix, where opening the database there threw a bare stack. */
export class DataFolderError extends Error {
  constructor(detail: string, fix: string) {
    super(`Afflatus cannot start: the data folder cannot be written (${detail}). ${fix}`);
    this.name = "DataFolderError";
  }
}

export interface StartOptions {
  /** The built web app's folder; none in development (and in the tests). */
  webDir?: string;
  /** The queue's timings; the tests shorten them. */
  queueOptions?: QueueOptions;
  /** Where the start's lines go: the console, unless a test keeps them. */
  log?: Pick<Console, "log" | "warn">;
}

export interface Started {
  app: FastifyInstance;
  services: Services;
  kind: DbKind;
  /** The server and the services stopped: the port is free again once this resolves. */
  close(): Promise<void>;
}

/** The port taken before anything else is done, let go only for the server to listen on it at once. */
const holdPort = (config: Config) =>
  new Promise<Server>((resolve, reject) => {
    // a connection made while the port is only held (a browser tab reconnecting, a health check) is dropped at once: the
    // held server never answers, and its close below would wait for such a connection to end, so the start would hang
    const held = createServer((socket) => socket.destroy());
    held.once("error", (err: NodeJS.ErrnoException) => reject(err.code === "EADDRINUSE" ? new PortTakenError(config.host, config.port) : err));
    held.listen({ host: config.host, port: config.port, exclusive: true }, () => resolve(held));
  });

/**
 * The server started: the port held, the data folder checked, the database migrated, the services made and the app
 * listening, with the queue taking jobs. Nothing here ends the process: a port taken throws a PortTakenError and a data
 * folder that cannot be written a DataFolderError, which the caller (index.ts) says and exits on.
 */
export async function start(config: Config, opts: StartOptions = {}): Promise<Started> {
  const log = opts.log ?? console;
  // a second Afflatus started on the same data folder by mistake stops here, before it migrates the database, sweeps the
  // library or removes the first one's partial downloads (downloads.ts restore): the first one has the port
  const held = await holdPort(config);
  let services: Services | undefined;
  let app: FastifyInstance | undefined;
  try {
    // what this computer has of what Afflatus needs: said once here, kept for the health route and Settings → About. First:
    // a data folder that cannot be written stops the start with its fix
    const checked = await preflight.run(config.dataDir);
    const data = checked.checks.find((c) => c.id === "data");
    if (data && !data.ok) throw new DataFolderError(data.detail, data.fix);
    const { db, kind } = openDb(config);
    const applied = await migrate(db);
    if (applied.length) log.log(`[db] migrated: ${applied.join(", ")}`);
    services = await createServices(db, kind, new LocalStorage(join(config.dataDir, "files")), opts.queueOptions, { dataDir: config.dataDir });
    app = buildApp(services, { webDir: opts.webDir, backup: { dataDir: config.dataDir, filesDir: join(config.dataDir, "files") } });
    // the node pack kept up to date in ComfyUI's folder, when it is known
    {
      const { comfyDir } = await readSettings(db);
      if (comfyDir.trim()) {
        const put = await installNodePack(comfyDir).catch((err: Error) => (log.warn(`[node-pack] not written: ${err.message}`), null));
        if (put?.changed) log.log(`[node-pack] written to ${put.path}: restart ComfyUI to load it`);
      }
    }
    // the queue's state is read before the first request comes in: a job asked for at once must find a queue paused before the
    // restart paused. It starts taking jobs once this process has the port (another Afflatus on it may be running them)
    await services.queue.load();
    await new Promise((resolve) => held.close(resolve));
    try {
      await app.listen({ host: config.host, port: config.port });
    } catch (err) {
      // the one failure a person meets at start: the port is taken (another Afflatus, or a server of their own)
      if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") throw new PortTakenError(config.host, config.port);
      throw err;
    }
    log.log(`Afflatus ${VERSION} on http://${config.host}:${config.port} (${kind})`);
    await services.queue.start();
    const ready = { app, services };
    return {
      app, services, kind,
      async close() {
        await ready.app.close();
        await ready.services.close();
      },
    };
  } catch (err) {
    // a start that stops half way leaves nothing behind: the port free again, the database closed
    held.close();
    await app?.close().catch(() => {});
    await services?.close().catch(() => {});
    throw err;
  }
}
