import { existsSync } from "node:fs";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { connect, createServer, type Server } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { buildApp, VERSION } from "./app";
import { envSaid, type Config } from "./config";
import { migrate, openDb, type DbKind } from "./db";
import type { QueueOptions } from "./queue";
import { createServices, type Services } from "./services";
import { readSettings, seedNewInstall } from "./settings";
import { resetAccess } from "./access";
import { installNodePack } from "./nodePack";
import { LocalStorage } from "./storage";
import { preflight, runPreflight } from "./preflight";
import { AfflatusUpdates, RESTART_CODE } from "./updates";
import type { UpdatesOptions } from "./updatesModel";

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

/**
 * The library's database was migrated by a newer Afflatus (a migration this version does not have is marked done in
 * it): this version cannot open it. Said plainly, with the copy to put back, where the migrator said only "corrupted
 * migrations".
 */
export class NewerLibraryError extends DataFolderError {
  constructor(dataDir: string, migration: string, backup: string | null) {
    super("", "");
    this.message = `Afflatus cannot start: the library in ${dataDir} is from a newer Afflatus (its database has the change "${migration}", which ${VERSION} does not know). Start the newer version again${backup ? `, or, to stay on ${VERSION}, put the copy taken before the update in its place: with Afflatus stopped, copy ${backup} over ${join(dataDir, "afflatus.db")}` : ""}.`;
    this.name = "NewerLibraryError";
  }
}

/**
 * The exit codes of a start that stopped on something other than the version itself, which the bundle's launcher
 * (scripts/release/launch.mjs) never takes for a version that does not start: the port is taken, or the data folder
 * cannot be used.
 */
export const EXIT_PORT_TAKEN = 3;
export const EXIT_DATA_FOLDER = 4;

/** The migrator's word for a database that has a migration this code does not know: a newer version migrated it. */
const NEWER = /corrupted migrations: previously executed migration (\S+) is missing/;

/** The copy of the library to put back before a newer version's changes: the update's own, else the one taken before the migration. */
async function copyBeforeNewer(dataDir: string): Promise<string | null> {
  const newest = async (dir: string, pick: (name: string) => boolean) => {
    let best: { path: string; at: number } | null = null;
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (!pick(name)) continue;
      const at = await stat(join(dir, name)).then((s) => s.mtimeMs, () => 0);
      if (!best || at > best.at) best = { path: join(dir, name), at };
    }
    return best?.path ?? null;
  };
  return (await newest(join(dataDir, "backups"), (n) => /^before-.+\.db$/.test(n))) ?? (await newest(dataDir, (n) => n.startsWith("afflatus.db.pre-")));
}

export interface StartOptions {
  /** The built web app's folder; none in development (and in the tests). */
  webDir?: string;
  /** The queue's timings; the tests shorten them. */
  queueOptions?: QueueOptions;
  /** Where the start's lines go: the console, unless a test keeps them. */
  log?: Pick<Console, "log" | "warn">;
  /** How the process ends when an update asks for a restart (exit code 75): process.exit, unless a test keeps it. */
  exit?: (code: number) => void;
  /** The updates' stand-ins for the tests (a key, a bundle's root, timers off). */
  updates?: Omit<UpdatesOptions, "services" | "dataDir" | "restart">;
}

export interface Started {
  app: FastifyInstance;
  services: Services;
  kind: DbKind;
  /** Afflatus's own updates (updates.ts). */
  updates: AfflatusUpdates;
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
 * listening, with the queue taking jobs. Nothing here ends the process: a port taken throws a PortTakenError, and a data
 * folder that cannot be written or a library a newer version migrated a DataFolderError, which the caller (index.ts)
 * says and exits on.
 */
export async function start(config: Config, opts: StartOptions = {}): Promise<Started> {
  const log = opts.log ?? console;
  // a second Afflatus started on the same data folder by mistake stops here, before it migrates the database, sweeps the
  // library or removes the first one's partial downloads (downloads.ts restore): the first one has the port
  const held = await holdPort(config);
  let services: Services | undefined;
  let app: FastifyInstance | undefined;
  let updates: AfflatusUpdates | undefined;
  const closeAll = async () => {
    await updates?.stop();
    await app?.close();
    await services?.close();
  };
  // an update or Go back: everything closed (the database too, for a file to be swapped in `between`), then exit 75,
  // which the bundle's launcher reads as "start me again". What fails on the way is logged and the exit still comes:
  // the launcher then starts whichever version versions/current names
  let restarting = false;
  const restart = async (between?: () => Promise<void>) => {
    if (restarting) return;
    restarting = true;
    log.log("[updates] restarting");
    await closeAll().catch((err: Error) => log.warn(`[updates] closing before the restart: ${err.message}`));
    await between?.().catch((err: Error) => log.warn(`[updates] ${err.message}`));
    (opts.exit ?? ((code: number) => process.exit(code)))(RESTART_CODE);
  };
  try {
    // what this computer has of what Afflatus needs: said once here, kept for the health route and Settings → About. First:
    // a data folder that cannot be written stops the start with its fix
    const checked = await preflight.run(config.dataDir);
    const data = checked.checks.find((c) => c.id === "data");
    if (data && !data.ok) throw new DataFolderError(data.detail, data.fix);
    const { db, kind } = openDb(config);
    const applied = await migrate(db).catch(async (err: Error) => {
      const newer = NEWER.exec(err.message);
      if (!newer) throw err;
      await db.destroy().catch(() => {});
      throw new NewerLibraryError(config.dataDir, newer[1]!, kind === "sqlite" ? await copyBeforeNewer(config.dataDir) : null);
    });
    if (applied.length) log.log(`[db] migrated: ${applied.join(", ")}`);
    // a database made just now is a new install: it starts with no ComfyUI expected and the first launch to show
    if (applied.includes("0001_settings")) await seedNewInstall(db);
    // the way back in for an owner who lost the password and every way to a code: said loudly, never quietly
    if (envSaid.resetPassword()) {
      log.warn("[access] AFFLATUS_RESET_PASSWORD=1: removing the password and every session. Take the setting out once in.");
      await resetAccess(db, log);
    }
    services = await createServices(db, kind, new LocalStorage(join(config.dataDir, "files")), opts.queueOptions, { dataDir: config.dataDir });
    updates = new AfflatusUpdates({ services, dataDir: config.dataDir, restart, ...opts.updates });
    await updates.init();
    app = buildApp(services, { webDir: opts.webDir, backup: { dataDir: config.dataDir, filesDir: join(config.dataDir, "files") }, updates });
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
    // the bundle's launcher learns that this version started: without the file, a version that exits takes it back to the previous one
    const startedFile = envSaid.startedFile()?.trim();
    if (startedFile) {
      await mkdir(dirname(startedFile), { recursive: true }).then(() => writeFile(startedFile, new Date().toISOString()))
        .catch((err: Error) => log.warn(`[updates] the started marker was not written (${startedFile}): ${err.message}`));
    }
    // this version has started once: from now on, a start that fails is never a reason to fall back from it
    await updates.listening();
    return { app, services, kind, updates, close: closeAll };
  } catch (err) {
    // a start that stops half way leaves nothing behind: the port free again, the database closed
    held.close();
    await updates?.stop().catch(() => {});
    await app?.close().catch(() => {});
    await services?.close().catch(() => {});
    throw err;
  }
}

/**
 * `reset-password`: the password and every session removed from the data folder's library, with Afflatus stopped (the
 * running one keeps what it read until it restarts). Refused while something answers on Afflatus's port. 0 when done.
 */
export async function resetPasswordCommand(config: Config, log: Pick<Console, "log" | "warn"> = console): Promise<number> {
  const probe = EVERY.has(config.host) ? "127.0.0.1" : config.host;
  const running = await new Promise<boolean>((resolve) => {
    const socket = connect({ host: probe, port: config.port });
    socket.setTimeout(1500);
    socket.once("connect", () => (socket.destroy(), resolve(true)));
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => (socket.destroy(), resolve(false)));
  });
  if (running) {
    log.warn(`Afflatus is running on port ${config.port}: stop it first, then run reset-password again (or start it once with AFFLATUS_RESET_PASSWORD=1).`);
    return 1;
  }
  const { db } = openDb(config);
  try {
    await migrate(db);
    await resetAccess(db, log);
    log.log(`Done, in ${config.databaseUrl ? "the Postgres library" : config.dataDir}. Start Afflatus and set a new password in Settings › Interface › Access.`);
    return 0;
  } finally {
    await db.destroy();
  }
}

/** The addresses that mean "every address" to listen on: the command above asks loopback instead. */
const EVERY = new Set(["0.0.0.0", "::", "[::]", ""]);

/**
 * `--check`: what a new version is asked before an update switches to it (updates.ts): its code loads (this file is
 * reached through all of it), the Node it runs on is recent enough and the data folder can be written. Nothing is
 * started, no port taken, the database not opened. 0 when it can start, 1 when it cannot; a missing ffmpeg is said
 * and does not stop it, as it does not stop a start.
 */
export async function check(config: Config, log: Pick<Console, "log" | "warn"> = console): Promise<number> {
  const found = await runPreflight(config.dataDir);
  for (const c of found.checks) log[c.ok ? "log" : "warn"](`[check] ${c.label}: ${c.ok ? c.detail : `${c.detail}. ${c.fix}`}`);
  return found.checks.every((c) => c.ok || (c.id !== "node" && c.id !== "data")) ? 0 : 1;
}
