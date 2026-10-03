import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp, VERSION } from "./app";
import { loadConfig } from "./config";
import { migrate, openDb } from "./db";
import { createServices } from "./services";
import { LocalStorage } from "./storage";

/** The built web app, when there is one (`pnpm build`). In development Vite serves it instead. */
export function webDir(): string | undefined {
  const dir = fileURLToPath(new URL("../../web/dist", import.meta.url));
  return existsSync(join(dir, "index.html")) ? dir : undefined;
}

const config = loadConfig();
const { db, kind } = openDb(config);
const applied = await migrate(db);
if (applied.length) console.log(`[db] migrated: ${applied.join(", ")}`);

const services = await createServices(db, kind, new LocalStorage(join(config.dataDir, "files")));
const app = buildApp(services, { webDir: webDir() });
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
