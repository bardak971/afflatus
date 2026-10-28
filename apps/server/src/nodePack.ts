import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { envSaid } from "./config";
import { httpError } from "./errors";
import { isNetworkPath } from "./linked";
import { managerOf } from "./lock-api";
import type { Services } from "./services";
import { readSettings } from "./settings";
import { olderThan } from "./version";
import { zipOf } from "./zip";

/**
 * Afflatus's node pack for ComfyUI (comfy-nodes/afflatus-nodes in the repository: save/load a MiniMax H3
 * latent, and the MIT continuation nodes). When ComfyUI's folder is known (Settings → ComfyUI, same disk),
 * the pack is copied into its custom_nodes folder, and kept up to date when Afflatus starts or the folder
 * is set; ComfyUI loads it at its next start. Nothing is run: files are written, that is all.
 */

const NODE_PACK = "afflatus-nodes";
const exists = (p: string) => access(p).then(() => true, () => false);

/** Where the pack's source is: the repository's folder, or NODE_PACK_DIR. */
function nodePackSource(): string {
  return envSaid.nodePackDir()?.trim() || fileURLToPath(new URL("../../../comfy-nodes/afflatus-nodes", import.meta.url));
}

/** The pack's version, written once in its pyproject.toml: the pack reads it there too, and says it on GET /afflatus/version. */
async function nodePackVersion(): Promise<string | null> {
  const toml = await readFile(join(nodePackSource(), "pyproject.toml"), "utf-8").catch(() => "");
  return /^version\s*=\s*"([^"]+)"/m.exec(toml)?.[1] ?? null;
}

/** Copy the pack into `<comfyDir>/custom_nodes/afflatus-nodes/`; says whether anything was written. */
export async function installNodePack(comfyDir: string): Promise<{ written: boolean; changed: boolean; path: string }> {
  const dir = comfyDir.trim();
  const path = join(dir, "custom_nodes", NODE_PACK);
  // a network share is never reached for (see isNetworkPath): the pack is unpacked there by hand, from the zip
  if (!dir || isNetworkPath(dir) || !(await exists(join(dir, "custom_nodes")))) return { written: false, changed: false, path };
  const source = nodePackSource();
  if (!(await exists(source))) return { written: false, changed: false, path };
  await mkdir(path, { recursive: true });
  let changed = false;
  for (const name of await readdir(source)) {
    if (!/\.(py|md|toml)$|^LICENSE/.test(name)) continue;
    const body = await readFile(join(source, name));
    const had = await readFile(join(path, name)).catch(() => null);
    if (had && Buffer.compare(had, body) === 0) continue;
    await writeFile(join(path, name), body);
    changed = true;
  }
  return { written: true, changed, path };
}

export function registerNodePack(app: FastifyInstance, s: Services): void {
  /** The version the running ComfyUI said last time: when it changes, ComfyUI was restarted with another pack. */
  let saidBefore: string | null | undefined;
  /**
   * Whether the pack is in ComfyUI's folder, and whether the running ComfyUI has loaded it (else: restart it).
   * Loaded means the pack ComfyUI runs says this version or a newer one: an older one still loaded (written
   * since, ComfyUI not restarted) lacks the newest nodes, and the joins that need them quietly fall back to plain ones.
   */
  app.get("/api/comfy/node-pack", async () => {
    const { comfyDir: set } = await readSettings(s.db);
    // ComfyUI's folder on a network share is not looked at (see isNetworkPath): Afflatus does not write the pack there
    const comfyDir = isNetworkPath(set) ? "" : set;
    const path = comfyDir.trim() ? join(comfyDir.trim(), "custom_nodes", NODE_PACK) : "";
    const written = path ? await exists(join(path, "__init__.py")) : false;
    const comfy = await s.comfy();
    const [running, version] = await Promise.all([comfy.client.packVersion().catch(() => null), nodePackVersion()]);
    // the node list is kept for a while: a pack loaded since it was read brings nodes it does not have yet
    if (saidBefore !== undefined && running !== saidBefore) comfy.forgetCatalog();
    saidBefore = running;
    const loaded = running !== null && (!version || !olderThan(running, version));
    // whether this Afflatus can write it at all: ComfyUI's folder is known and is here
    const canWrite = Boolean(comfyDir.trim()) && (await exists(join(comfyDir.trim(), "custom_nodes")));
    // written and not loaded: whether Afflatus can restart ComfyUI to load it (ComfyUI-Manager's reboot, POST /api/comfy/restart)
    const manager = written && !loaded ? (await managerOf(comfy)) !== null : null;
    return { pack: NODE_PACK, path, written, loaded, canWrite, version, running, manager };
  });

  /** The pack as a zip, to unpack into ComfyUI's custom_nodes by hand when Afflatus cannot write there (ComfyUI on another machine). */
  app.get("/api/comfy/node-pack.zip", async (_req, reply) => {
    const source = nodePackSource();
    const entries = [];
    for (const name of (await readdir(source).catch(() => [] as string[])).sort()) {
      if (!/\.(py|md|toml)$|^LICENSE/.test(name)) continue;
      entries.push({ name: `${NODE_PACK}/${name}`, data: new Uint8Array(await readFile(join(source, name))) });
    }
    if (!entries.length) throw httpError("the node pack's files were not found beside this server", 404);
    return reply.header("Content-Type", "application/zip").header("Content-Disposition", `attachment; filename="${NODE_PACK}.zip"`).send(zipOf(entries));
  });
}
