import { existsSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp, VERSION } from "./app";
import { loadConfig } from "./config";
import { migrate, openDb } from "./db";
import { createServices } from "./services";
import { readSettings } from "./settings";
import { installNodePack } from "./nodePack";
import { LocalStorage } from "./storage";
import { preflight } from "./preflight";

/** The built web app, when there is one (`pnpm build`). In development Vite serves it instead. */
export function webDir(): string | undefined {
  const dir = fileURLToPath(new URL("../../web/dist", import.meta.url));
  return existsSync(join(dir, "index.html")) ? dir : undefined;
}

const config = loadConfig();

/** Said when the port is taken: by another Afflatus (perhaps on this same data folder), or by a program of the user's. */
function portTaken(): never {
  console.error(`Port ${config.port} is already in use on ${config.host}: another Afflatus, or another program. Start this one on another port, for example PORT=8730 (PowerShell: $env:PORT=8730; cmd: set PORT=8730), or stop the other first.`);
  process.exit(1);
}

/** The port taken before anything else is done, let go only for the server to listen on it at once. */
const holdPort = () =>
  new Promise<Server>((resolve, reject) => {
    const held = createServer();
    held.once("error", (err: NodeJS.ErrnoException) => (err.code === "EADDRINUSE" ? portTaken() : reject(err)));
    held.listen({ host: config.host, port: config.port, exclusive: true }, () => resolve(held));
  });

// a second Afflatus started on the same data folder by mistake stops here, before it migrates the database, sweeps the
// library or removes the first one's partial downloads (downloads.ts restore): the first one has the port
const held = await holdPort();
// what this computer has of what Afflatus needs: said once here, kept for the health route and Settings → About. First:
// a data folder that cannot be written stops the start with its fix, where opening the database there threw a bare stack
const checked = await preflight.run(config.dataDir);
const data = checked.checks.find((c) => c.id === "data");
if (data && !data.ok) {
  console.error(`Afflatus cannot start: the data folder cannot be written (${data.detail}). ${data.fix}`);
  process.exit(1);
}
const { db, kind } = openDb(config);
const applied = await migrate(db);
if (applied.length) console.log(`[db] migrated: ${applied.join(", ")}`);
const services = await createServices(db, kind, new LocalStorage(join(config.dataDir, "files")), undefined, { dataDir: config.dataDir });
const app = buildApp(services, { webDir: webDir(), backup: { dataDir: config.dataDir, filesDir: join(config.dataDir, "files") } });
// the node pack kept up to date in ComfyUI's folder, when it is known
{
  const { comfyDir } = await readSettings(db);
  if (comfyDir.trim()) {
    const put = await installNodePack(comfyDir).catch((err: Error) => (console.warn(`[node-pack] not written: ${err.message}`), null));
    if (put?.changed) console.log(`[node-pack] written to ${put.path}: restart ComfyUI to load it`);
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
  if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") portTaken();
  throw err;
}
console.log(`Afflatus ${VERSION} on http://${config.host}:${config.port} (${kind})`);
await services.queue.start();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await app.close();
    await services.close();
    process.exit(0);
  });
}
