import { existsSync } from "node:fs";
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
const { db, kind } = openDb(config);
const applied = await migrate(db);
if (applied.length) console.log(`[db] migrated: ${applied.join(", ")}`);

// what this computer has of what Afflatus needs: said once here, kept for the health route and Settings → About
await preflight.run(config.dataDir);
const services = await createServices(db, kind, new LocalStorage(join(config.dataDir, "files")));
const app = buildApp(services, { webDir: webDir() });
// the node pack kept up to date in ComfyUI's folder, when it is known
{
  const { comfyDir } = await readSettings(db);
  if (comfyDir.trim()) {
    const put = await installNodePack(comfyDir).catch((err: Error) => (console.warn(`[node-pack] not written: ${err.message}`), null));
    if (put?.changed) console.log(`[node-pack] written to ${put.path}: restart ComfyUI to load it`);
  }
}
await app.listen({ host: config.host, port: config.port });
console.log(`Afflatus ${VERSION} on http://${config.host}:${config.port} (${kind})`);
await services.queue.start();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await app.close();
    await services.close();
    process.exit(0);
  });
}
